// Sweeper (`/tasks/catalog/sweep`, Cloud Scheduler `catalog-sweep`): a batch that made no progress
// for SWEEP_STALE_MS is marked failed and its product locks are released. Idempotent: a second run
// finds nothing, because the swept batches are no longer in an active status.
import { and, inArray, or, sql } from "drizzle-orm";
import type { BatchStatus } from "@catalog/core/catalog/types";
import type { Db } from "@catalog/core/db/client";
import type { HandleResult } from "../server";
import { catalogBatches, catalogChunks } from "@catalog/core/db/schema";
import { enqueueTask } from "@catalog/core/tasks";
import { CATALOG_TASK_LEASE_MS, enqueueFinalize, finalizeEnqueueExpired } from "./deps";

/** No progress for this long fails the batch (2 hours, from the plan). */
export const SWEEP_STALE_MS = 2 * 60 * 60 * 1000;

/** Batch statuses that mean "work in flight". */
export const SWEEPABLE_STATUSES = ["ingesting", "matting", "rendering", "qa", "publishing"] as const satisfies readonly BatchStatus[];

export const SWEEP_ERROR = "No progress for 2 hours. Start the batch again.";

/** Signature of `releaseLocks` in `@catalog/core/catalog/products` (spec 02 "Product identity helpers"). */
export type ReleaseLocks = (db: Db, batchId: string) => Promise<number>;

export interface SweepDeps {
  db: Db;
  releaseLocks: ReleaseLocks;
  now?: () => Date;
  enqueue?: typeof enqueueTask;
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
  // A process can die before task retries can acquire its still-live lease. Requeue only expired work.
  // The enqueue lease is not processing progress: leave started_at unchanged for the stale check.
  const abandoned=await deps.db.update(catalogChunks).set({status:"queued",taskName:`recovery-${+now}`}).where(and(
    sql`${catalogChunks.status} IN ('queued','running')`,
    sql`CASE WHEN coalesce(${catalogChunks.taskName},'') ~ '^recovery-[0-9]+$'
      THEN substring(${catalogChunks.taskName} from 10)::numeric
      ELSE extract(epoch from coalesce(${catalogChunks.startedAt},${catalogChunks.createdAt}))*1000
      END < ${+now-CATALOG_TASK_LEASE_MS}`,
    sql`${catalogChunks.batchId} IN (SELECT id FROM catalog_batches WHERE status IN ('matting','rendering','qa'))`,
    sql`GREATEST(${catalogChunks.startedAt},${catalogChunks.finishedAt},
      (SELECT b.updated_at FROM catalog_batches b WHERE b.id=${catalogChunks.batchId}))
      >= ${new Date(+now-SWEEP_STALE_MS)}::timestamptz`,
  )).returning();
  for(const chunk of abandoned) await (deps.enqueue ?? enqueueTask)("/tasks/catalog/chunk",{chunkId:chunk.id},{taskId:`chunk-${chunk.id}-${chunk.stage}-recovery-${+now}`});
  const cutoff = new Date(now.getTime() - SWEEP_STALE_MS).toISOString();
  const statuses = sql.join(
    SWEEPABLE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const swept = await deps.db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE catalog_batches AS b
      SET status = 'failed', error = ${SWEEP_ERROR}, updated_at = now()
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
    console.warn(JSON.stringify({ severity: "WARNING", message: "batch swept: no progress for 2 hours", ...s }));
  }
  return { httpStatus: 200, outcome: `swept:${swept.length}` };
}
