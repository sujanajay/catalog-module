// Sweeper (`/tasks/catalog/sweep`, Cloud Scheduler `catalog-sweep`): a batch that made no progress
// for SWEEP_STALE_MS is marked failed and its product locks are released, and a draft nobody wrote to
// for DRAFT_EXPIRY_DAYS is cancelled as expired (spec 14d F12). Idempotent: a second run finds
// nothing, because the swept batches are no longer in an active status.
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchStatus } from "@catalog/core/catalog/types";
import type { Db } from "@catalog/core/db/client";
import type { HandleResult } from "../server";
import { catalogBatches, catalogChunks, catalogUploads } from "@catalog/core/db/schema";
import { handOff, INGEST_ROUTE, ingestTaskId, uploadedPage } from "@catalog/core/catalog/ingest/hand-off";
import { enqueueTask } from "@catalog/core/tasks";
import { log, toSeverity } from "@catalog/core/log";
import { recoverBatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { ENLARGING_TASK } from "@catalog/core/catalog/pipeline/enlargement";
import { runInvariants, type InvariantResult } from "@catalog/core/catalog/invariants/run";
import { refreshOutcomes, syncIncidents } from "@catalog/core/catalog/reliability";
import { applyOutageDeadline, assessUpscalerOutages, syncOutageIncidents, type OutageProbe } from "@catalog/core/catalog/upscaler-health";
import { enqueueFinalize, finalizeEnqueueExpired, finalizePendingFlag } from "./deps";
import { enqueueImprovements } from "./improve";

/** No progress for this long fails the batch (2 hours, from the plan). */
export const SWEEP_STALE_MS = 2 * 60 * 60 * 1000;

/** Batch statuses that mean "work in flight". A `cancelled` batch is never swept (spec 14c F4 part 2). */
export const SWEEPABLE_STATUSES = ["ingesting", "matting", "rendering", "qa", "publishing"] as const satisfies readonly BatchStatus[];

export const SWEEP_ERROR = "No progress for 2 hours. Start the batch again.";

/**
 * M6-F2-R4 (M6-S4): a batch `ingesting` whose row has not moved for this long gets its intake re-sent (an ingest task
 * lost to a deploy or a queue give-up from before the queue retried without limit).
 */
export const INGEST_RESEND_MS = 30 * 60 * 1000;

/** The hand-off run of a re-send: one per INGEST_RESEND_MS window, so a sweep every 10 minutes sends it once. */
export const ingestResendRun = (now: Date) => `sweep-${Math.floor(+now / INGEST_RESEND_MS)}`;

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
  /** Spec 18 lifecycle F34: the worker's rollback switch (UPSCALE_MODEL=off): queued enlargements released, parked chunks unparked. */
  enlargementOff?: boolean;
  /**
   * M1-S4b: the worker's /health probe of the upscale services (workerEnlargeProbe). Absent (the upscaler switched
   * off, or a caller with no upscaler): no outage pass.
   */
  outageProbe?: OutageProbe;
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

  // Recover a committed enqueue intent before the normal stale-batch failure check. Spec 18 H4: a done batch
  // is recovered only while it carries a pending request (a re-open whose task was lost), never for a stale
  // claim or an old enqueue time alone, so a finished batch is not finalized again.
  const pending=await deps.db.select({id:catalogBatches.id}).from(catalogBatches).where(or(
    and(inArray(catalogBatches.status,[...SWEEPABLE_STATUSES,"done"]),finalizePendingFlag(),finalizeEnqueueExpired(+now)),
    and(inArray(catalogBatches.status,[...SWEEPABLE_STATUSES]),sql`${catalogBatches.counts}->>'finalizeClaim' IS NOT NULL AND
        CASE WHEN coalesce(${catalogBatches.counts}->>'finalizeClaimUntil','') ~ '^[0-9]+$'
        THEN (${catalogBatches.counts}->>'finalizeClaimUntil')::numeric <= ${+now} ELSE true END`),
  ));
  for(const batch of pending) await enqueueFinalize({db:deps.db,enqueue:deps.enqueue ?? enqueueTask,now:()=>now},batch.id);
  // M1-S4b (M1 D13): the upscaler outage pass, before the recovery below so the chunks the deadline unparks are picked
  // up by this sweep's window top-up. A failure here never stops the sweep.
  if (deps.outageProbe && !deps.enlargementOff) await outagePass(deps.db, deps.outageProbe, deps.enqueue ?? enqueueTask, now, deps.now ?? (() => new Date()));
  // Spec 15 E4: recover only dead chunks (a lapsed lease, or a task lost for 30 minutes) and top up each
  // processing batch's window. A live lease and a recently queued task are never touched. Spec 18 lifecycle 3.8:
  // every live batch (not failed or cancelled, done included: an operator retry or a replacement) with a queued or
  // running chunk is recovered, so no chunk of a live batch is ever without an owner; the window top-up stays
  // processing-only (dispatchChunks checks).
  const live=await deps.db.selectDistinct({id:catalogBatches.id}).from(catalogBatches).innerJoin(catalogChunks,eq(catalogChunks.batchId,catalogBatches.id))
    .where(and(sql`${catalogBatches.status} NOT IN ('failed','cancelled','draft')`,inArray(catalogChunks.status,["queued","running"])));
  for(const batch of live) await recoverBatchChunks(deps.db,deps.enqueue ?? enqueueTask,batch.id,{now,...(deps.window ? {window:deps.window}:{}),...(deps.enlargementOff ? {enlargementOff:true}:{})});
  // M6-F2-R4: re-send the intake of a batch that has been ingesting with no progress for INGEST_RESEND_MS. Its
  // `uploaded` uploads are handed on again under a new run (the same paged hand-off as the web's Continue; a new run
  // carries every item already read forward). When none is left to collect, one delivery of a collected upload is
  // sent, which takes the lapsed placing lease and groups and places again (as Try again does). A failure here never
  // stops the sweep.
  try { await resendStalledIngest(deps.db, deps.enqueue ?? enqueueTask, now); }
  catch (error) { log("ERROR", "ingest re-send failed", { error: error instanceof Error ? error.message : String(error) }); }
  // M1-S4 (M1-F3-R4): improvement tasks for the provisional plain renders due a try. A failure here never stops the sweep.
  try { await enqueueImprovements(deps.db, deps.enqueue ?? enqueueTask, now, deps.enlargementOff ? { enlargementOff: true } : {}); }
  catch (error) { log("ERROR", "improvement enqueue failed", { error: error instanceof Error ? error.message : String(error) }); }
  // Spec 17 3.1.3: the invariants, every sweep (10 minutes). A failed check run never stops the sweep.
  // Spec 17 3.1.3: the invariants never stop the sweep, but a failed run is an ERROR (the checks went blind).
  let invariants: InvariantResult[] | undefined;
  try { invariants = (await runInvariants(deps.db, log, now)).results; } catch (error) { log("ERROR", "invariants run failed", { error: error instanceof Error ? error.message : String(error) }); }
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
        -- Spec 18 lifecycle 3.8: a batch waiting on an enlargement (a parked chunk) is owned by the lifecycle, never swept.
        AND NOT EXISTS (SELECT 1 FROM catalog_chunks AS c WHERE c.batch_id = b.id AND c.status = 'queued' AND c.task_name = ${ENLARGING_TASK})
        AND GREATEST(
          b.updated_at,
          (SELECT max(c.started_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id),
          (SELECT max(c.finished_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id),
          (SELECT max(c.progress_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id)
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

  // M6-S6 (M6-F3): incidents (failed batches and chunks, ERROR invariants) and the outcomes of batches that ended
  // in the last 24 hours, after this run's own failures so they are counted. Neither ever stops the sweep.
  await recordReliability(deps.db, now, invariants);

  return { httpStatus: 200, outcome: `swept:${swept.length}${expired.length ? `; expired:${expired.length}` : ""}` };
}

/**
 * M1-S4b: probe the upscale services photos wait on and record the answers (assessUpscalerOutages), apply the outage
 * deadline to auto-decide batches (applyOutageDeadline) and keep the upscaler_outage incidents in step
 * (syncOutageIncidents). Each step is logged and never thrown.
 */
export async function outagePass(db: Db, probe: OutageProbe, enqueue: typeof enqueueTask, now: Date, clock: () => Date): Promise<void> {
  const say = (message: string, f: Record<string, unknown> = {}) => log(toSeverity(f.severity) ?? "INFO", message, f);
  let assessment;
  try { assessment = await assessUpscalerOutages(db, probe, clock, say); }
  catch (error) { log("ERROR", "upscaler outage pass failed", { step: "assess", error: error instanceof Error ? error.message : String(error) }); return; }
  try { await applyOutageDeadline(db, enqueue, assessment, now, say); }
  catch (error) { log("ERROR", "upscaler outage pass failed", { step: "deadline", error: error instanceof Error ? error.message : String(error) }); }
  try {
    const sync = await syncOutageIncidents(db, assessment, now);
    if (sync.opened || sync.resolved) log("INFO", "incidents", { event: "upscaler_outage", opened: sync.opened, resolved: sync.resolved });
  } catch (error) { log("ERROR", "upscaler outage pass failed", { step: "incidents", error: error instanceof Error ? error.message : String(error) }); }
}

/** M6-S6: the sweep's incident and outcome passes; a failure is logged as an ERROR and never thrown. */
export async function recordReliability(db: Db, now: Date, invariants?: InvariantResult[]): Promise<void> {
  try {
    const sync = await syncIncidents(db, now, invariants ? { invariants } : {});
    if (sync.errors.length) log("ERROR", "incident pass failed", { errors: sync.errors });
    if (sync.opened || sync.resolved) log("INFO", "incidents", { event: "incidents", opened: sync.opened, resolved: sync.resolved });
  } catch (error) { log("ERROR", "incident pass failed", { error: error instanceof Error ? error.message : String(error) }); }
  try { await refreshOutcomes(db, now); }
  catch (error) { log("ERROR", "batch outcome pass failed", { error: error instanceof Error ? error.message : String(error) }); }
}

/** M6-F2-R4: see handleSweep. Returns the batches whose intake was re-sent. */
export async function resendStalledIngest(db: Db, enqueue: typeof enqueueTask, now: Date): Promise<string[]> {
  const stalled = await db.select({ id: catalogBatches.id }).from(catalogBatches)
    .where(and(eq(catalogBatches.status, "ingesting"), lt(catalogBatches.updatedAt, new Date(+now - INGEST_RESEND_MS))));
  const run = ingestResendRun(now);
  for (const { id: batchId } of stalled) {
    // A new run starts this batch's failure counts at 0, as the web's hand-off does (M6-F2-R4).
    await db.update(catalogUploads).set({ ingestFailures: 0 }).where(and(eq(catalogUploads.batchId, batchId), gt(catalogUploads.ingestFailures, 0)));
    const page = await uploadedPage(db, batchId, null);
    if (page.ids.length) await handOff(enqueue, batchId, run, page);
    else {
      const [collected] = await db.select({ id: catalogUploads.id }).from(catalogUploads)
        .where(and(eq(catalogUploads.batchId, batchId), eq(catalogUploads.status, "collected"))).orderBy(catalogUploads.id).limit(1);
      if (!collected) continue;
      await enqueue(INGEST_ROUTE, { batchId, uploadId: collected.id, run }, { taskId: ingestTaskId(collected.id, run) });
    }
    log("WARNING", "ingest re-sent: no progress for 30 minutes", { batchId, run, uploads: page.ids.length || 1, more: page.more });
  }
  return stalled.map((b) => b.id);
}
