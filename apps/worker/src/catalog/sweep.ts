// Sweeper (`/tasks/catalog/sweep`, Cloud Scheduler `catalog-sweep`): a batch that made no progress
// for SWEEP_STALE_MS is marked failed and its product locks are released, and a draft nobody wrote to
// for DRAFT_EXPIRY_DAYS is cancelled as expired (spec 14d F12). Idempotent: a second run finds
// nothing, because the swept batches are no longer in an active status.
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchStatus } from "@catalog/core/catalog/types";
import type { Db } from "@catalog/core/db/client";
import type { HandleResult } from "../server";
import { catalogBatches } from "@catalog/core/db/schema";
import { enqueueTask } from "@catalog/core/tasks";
import { log } from "@catalog/core/log";
import { PROCESSING_STATUSES, recoverBatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { enqueueFinalize, finalizeEnqueueExpired } from "./deps";

/** No progress for this long fails the batch (2 hours, from the plan). */
export const SWEEP_STALE_MS = 2 * 60 * 60 * 1000;

/** Batch statuses that mean "work in flight". A `cancelled` batch is never swept (spec 14c F4 part 2). */
export const SWEEPABLE_STATUSES = ["ingesting", "matting", "rendering", "qa", "publishing"] as const satisfies readonly BatchStatus[];

export const SWEEP_ERROR = "No progress for 2 hours. Start the batch again.";

/** Days without a write after which the sweep cancels a draft (spec 14d F12; owner decision 2026-10-27). */
export const DEFAULT_DRAFT_EXPIRY_DAYS = 14;
const DAY_MS = 86_400_000;

/** DRAFT_EXPIRY_DAYS from the env: a whole number of days of at least 1, else the default. */
export function draftExpiryDaysFromEnv(env: NodeJS.ProcessEnv): number {
  const n = Number(env.DRAFT_EXPIRY_DAYS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_DRAFT_EXPIRY_DAYS;
}

/** Signature of `releaseLocks` in `@catalog/core/catalog/products` (spec 02 "Product identity helpers"). */
export type ReleaseLocks = (db: Db, batchId: string) => Promise<number>;

export interface SweepDeps {
  db: Db;
  releaseLocks: ReleaseLocks;
  now?: () => Date;
  enqueue?: typeof enqueueTask;
  /** The per-batch chunk window; absent reads CATALOG_CHUNK_WINDOW (default 8). */
  window?: number;
  /** Defaults to DEFAULT_DRAFT_EXPIRY_DAYS. */
  draftExpiryDays?: number;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Fail every active batch whose newest progress (its chunks' started_at / finished_at and its own
 * updated_at) is older than SWEEP_STALE_MS, release its product locks, and log one WARNING per batch.
 * The status change and the lock release commit together.
 */
export async function handleSweep(deps: SweepDeps, _body: Record<string, unknown>): Promise<HandleResult> {
  const now = deps.now?.() ?? new Date();
  // Draft housekeeping (spec 14d F12): a draft never started whose row nobody wrote to for the expiry days
  // (page reads never write it) is cancelled with options.expired; its objects stay where they are. It runs
  // first, so a recovery step below that throws never holds it up.
  const days = deps.draftExpiryDays ?? DEFAULT_DRAFT_EXPIRY_DAYS;
  const expired = await deps.db
    .update(catalogBatches)
    .set({
      status: "cancelled",
      options: sql`${catalogBatches.options} || jsonb_build_object('expired', jsonb_build_object('at', ${now.toISOString()}::text, 'days', ${days}::int))`,
      updatedAt: now,
    })
    .where(and(eq(catalogBatches.status, "draft"), isNull(catalogBatches.startedAt), lt(catalogBatches.updatedAt, new Date(now.getTime() - days * DAY_MS))))
    .returning({ id: catalogBatches.id });
  for (const e of expired) log("INFO", "draft expired", { batchId: e.id, days });

  // Recover a committed enqueue intent before the normal stale-batch failure check.
  const pending=await deps.db.select({id:catalogBatches.id}).from(catalogBatches).where(and(
    inArray(catalogBatches.status,[...SWEEPABLE_STATUSES,"done"]),
    or(
      and(sql`coalesce((${catalogBatches.counts}->>'finalizePending')::boolean,false)`,finalizeEnqueueExpired(+now)),
      sql`${catalogBatches.counts}->>'finalizeClaim' IS NOT NULL AND
        CASE WHEN coalesce(${catalogBatches.counts}->>'finalizeClaimUntil','') ~ '^[0-9]+$'
        THEN (${catalogBatches.counts}->>'finalizeClaimUntil')::numeric <= ${+now} ELSE true END`,
    ),
  ));
  for(const batch of pending) await enqueueFinalize({db:deps.db,enqueue:deps.enqueue ?? enqueueTask,now:()=>now},batch.id);
  // Spec 15 E4: recover only dead chunks (a lapsed lease, or a task lost for 30 minutes) and top up each
  // processing batch's window. A live lease and a recently queued task are never touched.
  const processing=await deps.db.select({id:catalogBatches.id}).from(catalogBatches).where(inArray(catalogBatches.status,PROCESSING_STATUSES));
  for(const batch of processing) await recoverBatchChunks(deps.db,deps.enqueue ?? enqueueTask,batch.id,{now,...(deps.window ? {window:deps.window}:{})});
  const cutoff = new Date(now.getTime() - SWEEP_STALE_MS).toISOString();
  const statuses = sql.join(
    SWEEPABLE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const swept = await deps.db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      -- counts.failReason is what the batch page shows under "Could not start" (pipeline/status.ts).
      UPDATE catalog_batches AS b
      SET status = 'failed', error = ${SWEEP_ERROR},
        counts = b.counts || jsonb_build_object('failReason', ${SWEEP_ERROR}::text), updated_at = now()
      WHERE b.status IN (${statuses})
        AND GREATEST(
          b.updated_at,
          (SELECT max(c.started_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id),
          (SELECT max(c.finished_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id)
        ) < ${cutoff}::timestamptz
      RETURNING b.id
    `);
    const released: { batchId: string; releasedProducts: number }[] = [];
    for (const row of rowsOf(result)) {
      const batchId = String(row.id);
      released.push({ batchId, releasedProducts: await deps.releaseLocks(tx, batchId) });
    }
    return released;
  });

  for (const s of swept) {
    log("WARNING", "batch swept: no progress for 2 hours", s);
    log("ERROR", "batch failed", { batchId: s.batchId, reason: SWEEP_ERROR, cause: "swept" });
  }

  return { httpStatus: 200, outcome: `swept:${swept.length}${expired.length ? `; expired:${expired.length}` : ""}` };
}
