// Spec 15 (release E): how chunk tasks are queued and recovered. One live task per chunk, named by its step
// (`chunkTaskId`); at most `window` chunks of one batch queued or running at once; a sweep that recovers only
// dead chunks (a lapsed lease, or a task lost for 30 minutes), plus spec 17 G4's re-send of a step whose task never
// started within 6 minutes. Shared by the web (Start) and the worker (chunk hand-off and finish, the sweep, the
// load tool).
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogChunks, catalogEnlargements } from "../../db/schema";
import { log as structuredLog, toSeverity } from "../../log";
import { chunkTaskId, DISPATCH_DEADLINE_SEC, type enqueueTask } from "../../tasks";
import { positiveIntEnv } from "../../concurrency";
import { enqueueEnlargements, ENLARGE_SEND_SLOW_MS, ENLARGE_SEND_WARN, ENLARGE_STALE_MS, ENLARGING_TASK, queuedEnlargementsOfChunk, releaseEnlargements, unparkSettledChunks } from "./enlargement";

/** A delivery starts no new photo after this much of its time (the request deadline is 900 s). */
export const CHUNK_TIME_BUDGET_MS = 480_000;
/** A running chunk's claim lasts this long unless its holder renews it. */
export const CHUNK_LEASE_MS = 120_000;
/** How often a running delivery renews its lease. */
export const CHUNK_HEARTBEAT_MS = 30_000;
/** A queued chunk whose task was queued this long ago and never ran is re-dispatched. */
export const CHUNK_QUEUED_STALE_MS = 30 * 60_000;
/**
 * Spec 17 G4: a step whose task has not started this long after it was queued is sent again, once per step.
 * Above the normal queue wait under load (2026-10-27 run: median 34 s, p95 275 s between a hand-off and the
 * next delivery's start), and short enough that a lost task's chunk still ends within 2 x the median chunk time.
 */
export const CHUNK_UNSTARTED_STALE_MS = 6 * 60_000;
/** `task_name` of a queued chunk whose step `redispatchUnstartedChunks` sent again: that step is not re-sent twice. */
export const REDISPATCHED_TASK = "redispatched";
/** Deliveries in a row that finish no photo before the chunk fails. */
export const CHUNK_MAX_STALLS = 3;
/** A chunk that is not parked for its photos' enlargements (spec 18, pipeline/enlargement.ts). */
export function notParked(): SQL {
  return or(isNull(catalogChunks.taskName), sql`${catalogChunks.taskName} <> ${ENLARGING_TASK}`)!;
}
/** Chunks of one batch queued or running at once: the queue's 6 slots plus 2, so a freed slot always finds a task. */
export const DEFAULT_CHUNK_WINDOW = 8;
/** The lease of a claim written before migration 0004 (no lease_until): the deadline plus a minute. */
export const LEGACY_LEASE_SEC = DISPATCH_DEADLINE_SEC + 60;
/** Batch statuses whose chunks are processed. */
export const PROCESSING_STATUSES = ["matting", "rendering", "qa"] as const;
export const CHUNK_STALLED_REASON = "Processing stopped: no photo finished in three tries in a row.";

type Enqueue = typeof enqueueTask;
type Log = (message: string, fields?: Record<string, unknown>) => void;
const defaultLog: Log = (message, fields = {}) => structuredLog(toSeverity(fields.severity) ?? "INFO", message, fields);


/** `CATALOG_CHUNK_TIME_BUDGET_MS` may lower the budget (proof runs only); unset or invalid keeps 480 s. */
export function chunkTimeBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(positiveIntEnv(env.CATALOG_CHUNK_TIME_BUDGET_MS, CHUNK_TIME_BUDGET_MS), CHUNK_TIME_BUDGET_MS);
}

/** `CATALOG_CHUNK_WINDOW`, default 8. */
/** `CATALOG_CHUNK_IMAGES`, the photos per chunk that Start and the load driver plan with (deploy.sh checks it). */
export const DEFAULT_CHUNK_IMAGES = 10;
export function chunkImages(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.CATALOG_CHUNK_IMAGES ?? DEFAULT_CHUNK_IMAGES);
}
export function chunkWindow(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.CATALOG_CHUNK_WINDOW, DEFAULT_CHUNK_WINDOW);
}

/** Spec 16: a Test Brand load batch's name starts with this (apps/worker/src/catalog-load.ts names it). */
export const LOAD_BATCH_NAME_PREFIX = "catalog-test load ";
/** Spec 16: a batch with at least this many products is bulk (`BULK_BATCH_PRODUCTS`). */
export const DEFAULT_BULK_BATCH_PRODUCTS = 100;
export interface BatchClassFields { isTest: boolean; name: string; counts: { products?: number } | null }

/**
 * Spec 16: a bulk batch (at least `BULK_BATCH_PRODUCTS` products, or a Test Brand load batch) sends its chunk and
 * publish tasks to the bulk queue when one is configured, and gets the bulk window. Every other batch is an
 * operator batch: the `catalog` queue and `CATALOG_CHUNK_WINDOW`.
 */
export function isBulkBatch(batch: BatchClassFields, env: NodeJS.ProcessEnv = process.env): boolean {
  const products = batch.counts?.products ?? 0;
  return products >= positiveIntEnv(env.BULK_BATCH_PRODUCTS, DEFAULT_BULK_BATCH_PRODUCTS) || (batch.isTest && batch.name.startsWith(LOAD_BATCH_NAME_PREFIX));
}

/** Spec 16: the per-batch cap of queued or running chunks; `CATALOG_BULK_WINDOW` for bulk (default the operator window). */
export function windowFor(bulk: boolean, env: NodeJS.ProcessEnv = process.env): number {
  return bulk ? positiveIntEnv(env.CATALOG_BULK_WINDOW, chunkWindow(env)) : chunkWindow(env);
}

const batchClassColumns = { isTest: catalogBatches.isTest, name: catalogBatches.name, counts: catalogBatches.counts };

/** True when the batch is bulk; false for a missing batch. */
export async function batchIsBulk(db: Db, batchId: string): Promise<boolean> {
  const [batch] = await db.select(batchClassColumns).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  return batch ? isBulkBatch(batch) : false;
}

/**
 * True when a running chunk's holder is dead at `now`. A claim from this code has lease_until after its
 * started_at; a claim written by code from before 0004 has none (or an old one), and keeps the old
 * 960-second lease from its started_at.
 */
export function leaseLapsed(now: Date): SQL {
  return sql`(CASE WHEN ${catalogChunks.leaseUntil} > ${catalogChunks.startedAt} THEN ${catalogChunks.leaseUntil}
    ELSE coalesce(${catalogChunks.startedAt}, ${catalogChunks.createdAt}) + make_interval(secs => ${LEGACY_LEASE_SEC}) END) < ${now}::timestamptz`;
}

export interface ChunkTaskRef { id: string; stage: string; step: number }

/** The task body of a chunk's current step; `extra` carries hand-off hints such as `fromProduct`. */
export function chunkTaskBody(chunk: ChunkTaskRef, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { chunkId: chunk.id, stage: chunk.stage, step: chunk.step, ...extra };
}

/** Queues the chunk's current step as its one task (a bulk batch's on the bulk queue, spec 16). */
export function enqueueChunk(enqueue: Enqueue, chunk: ChunkTaskRef, extra: Record<string, unknown> = {}, bulk = false): Promise<string> {
  return enqueue("/tasks/catalog/chunk", chunkTaskBody(chunk, extra), { taskId: chunkTaskId(chunk.id, chunk.stage, chunk.step), ...(bulk ? { bulk } : {}) });
}

/** `window` overrides the batch class's window (tests, the sweep's override). */
export interface DispatchOptions { window?: number; now?: Date; log?: Log }

/** Enqueues the chunk's current step; a failure is logged as WARNING `chunk dispatch failed` and returns false. */
export async function tryEnqueueChunk(enqueue: Enqueue, chunk: { id: string; batchId: string; stage: string; step: number }, log: Log, extra: Record<string, unknown> = {}, bulk = false): Promise<boolean> {
  try {
    await enqueueChunk(enqueue, chunk, extra, bulk);
    return true;
  } catch (error) {
    log("chunk dispatch failed", { severity: "WARNING", batchId: chunk.batchId, chunkId: chunk.id, stage: chunk.stage, step: chunk.step, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Tops up a batch's window: queues the next waiting chunks (in index order) until `window` chunks of the batch
 * are queued or running. Idempotent: with a full window it does nothing. The batch row lock makes two callers
 * at once (two chunks finishing together) take turns, so the window is never overfilled. A chunk whose enqueue
 * fails goes back to waiting, and the next call (at the latest the sweep, every 10 minutes) queues it.
 * Returns the number of chunks queued.
 */
export async function dispatchChunks(db: Db, enqueue: Enqueue, batchId: string, options: DispatchOptions = {}): Promise<number> {
  const now = options.now ?? new Date(), log = options.log ?? defaultLog;
  let bulk = false;
  const picked = await db.transaction(async (tx) => {
    const [batch] = await tx.select(batchClassColumns).from(catalogBatches).where(and(eq(catalogBatches.id, batchId), inArray(catalogBatches.status, PROCESSING_STATUSES))).for("update");
    if (!batch) return [];
    bulk = isBulkBatch(batch);
    const window = options.window ?? windowFor(bulk);
    // Spec 18 lifecycle 3.8: a parked chunk (dispatched_at set so older dispatches skip it) holds no slot.
    const [active] = await tx.select({ n: count() }).from(catalogChunks).where(and(eq(catalogChunks.batchId, batchId), isNotNull(catalogChunks.dispatchedAt), notInArray(catalogChunks.status, ["done", "failed"]), notParked()));
    const room = window - (active?.n ?? 0);
    if (room <= 0) return [];
    const waiting = await tx.select({ id: catalogChunks.id }).from(catalogChunks)
      .where(and(eq(catalogChunks.batchId, batchId), isNull(catalogChunks.dispatchedAt), eq(catalogChunks.status, "queued"), notParked()))
      .orderBy(asc(catalogChunks.index)).limit(room).for("update", { skipLocked: true });
    if (!waiting.length) return [];
    return tx.update(catalogChunks).set({ dispatchedAt: now }).where(inArray(catalogChunks.id, waiting.map((row) => row.id))).returning();
  });
  for (const chunk of picked) {
    if (!(await tryEnqueueChunk(enqueue, { ...chunk, batchId }, log, {}, bulk))) {
      await db.update(catalogChunks).set({ dispatchedAt: null }).where(and(eq(catalogChunks.id, chunk.id), eq(catalogChunks.status, "queued"), eq(catalogChunks.step, chunk.step)));
    }
  }
  return picked.length;
}

export interface RecoveryResult { lapsed: number; lost: number; unstarted: number; dispatched: number; /** Spec 18: enlarge tasks sent again for parked chunks. */ enlarge?: number }
/** Spec 18 lifecycle: `enlargementOff` is the worker's rollback switch (UPSCALE_MODEL=off): queued rows are released and parked chunks unparked. */
export interface RecoveryOptions extends DispatchOptions { enlargementOff?: boolean }

/**
 * The sweep's per-batch rules (also the Start resume path): a running chunk whose lease lapsed, or a queued chunk
 * whose task was queued more than 30 minutes ago, gets the next step and a new task (the old task, if it is only
 * slow, then answers "stale"); then the window is topped up. A live lease and a recently queued task are never
 * touched. Each rule is one guarded update, so a second run at the same time changes nothing. Spec 18 lifecycle 3.8:
 * the sweep runs this for every live batch with a queued or running chunk (done ones too: an operator retry or a
 * replacement), so no chunk of a live batch is ever without an owner; a parked chunk is never re-sent as a stage task
 * (the lost-task rule skips it), its rows are re-sent instead (resendStaleEnlargements). The window top-up serves
 * processing batches only (dispatchChunks).
 */
export async function recoverBatchChunks(db: Db, enqueue: Enqueue, batchId: string, options: RecoveryOptions = {}): Promise<RecoveryResult> {
  const now = options.now ?? new Date(), log = options.log ?? defaultLog, bulk = await batchIsBulk(db, batchId);
  const next = { step: sql`${catalogChunks.step} + 1`, stepKnown: true, dispatchedAt: now, taskName: null, leaseUntil: null };
  const lapsed = await db.update(catalogChunks).set({ ...next, status: "queued" })
    .where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.status, "running"), leaseLapsed(now))).returning();
  const lost = await db.update(catalogChunks).set(next)
    .where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.status, "queued"), notParked(), lt(catalogChunks.dispatchedAt, new Date(+now - CHUNK_QUEUED_STALE_MS)))).returning();
  for (const [chunks, reason] of [[lapsed, "lease_lapsed"], [lost, "task_lost"]] as const) {
    for (const chunk of chunks) {
      log("chunk recovered", { batchId, chunkId: chunk.id, stage: chunk.stage, step: chunk.step, reason });
      // A failed enqueue keeps the new step and dispatched_at, so the lost-task rule queues it again in 30 minutes.
      await tryEnqueueChunk(enqueue, { ...chunk, batchId }, log, {}, bulk);
    }
  }
  const unstarted = await redispatchUnstartedChunks(db, enqueue, batchId, { now, log });
  const enlarge = await resendStaleEnlargements(db, enqueue, batchId, { now, log, bulk, ...(options.enlargementOff ? { off: true } : {}) });
  const dispatched = await dispatchChunks(db, enqueue, batchId, options);
  return { lapsed: lapsed.length, lost: lost.length, unstarted, dispatched, enlarge };
}

/**
 * Spec 18 lifecycle 3.8, the recovery of parked chunks (recoverBatchChunks). A parked chunk with no wanted queued row
 * is unparked (the settle that should have done it is the only writer, so this is a safety net; on a batch that is not
 * processing it is enqueued directly). One whose progress_at is older than ENLARGE_STALE_MS (no enlarge delivery of the
 * batch refreshed it: the lane is quiet) has its wanted queued rows sent again with `sends + 1`, a new task id; after
 * ENLARGE_SEND_WARN sends of one row the pace drops to every ENLARGE_SEND_SLOW_MS and each re-send logs ERROR "enlargement
 * task cannot be delivered". The row is never failed for it (re-queue, never fail). `off` (the rollback switch)
 * releases the batch's queued rows first, so every parked chunk unparks to the plain path. Returns the tasks sent.
 */
export async function resendStaleEnlargements(db: Db, enqueue: Enqueue, batchId: string, options: Pick<DispatchOptions, "now" | "log"> & { bulk?: boolean; off?: boolean } = {}): Promise<number> {
  const now = options.now ?? new Date(), log = options.log ?? defaultLog, bulk = options.bulk ?? false;
  if (options.off) {
    const released = await releaseEnlargements(db, { batchId, onlyQueued: true, errorKind: "off" }, now);
    if (released.length) log("enlargement released", { batchId, rows: released.length, reason: "off" });
  }
  const unparked = await unparkSettledChunks(db, batchId, null, now);
  for (const chunk of unparked) {
    log("chunk recovered", { batchId, chunkId: chunk.id, reason: "enlargement_settled" });
    if (chunk.direct) await tryEnqueueChunk(enqueue, chunk, log, {}, bulk);
  }
  const parked = and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.status, "queued"), eq(catalogChunks.taskName, ENLARGING_TASK));
  const stale = await db.update(catalogChunks).set({ progressAt: now })
    .where(and(parked, or(isNull(catalogChunks.progressAt), lt(catalogChunks.progressAt, new Date(+now - ENLARGE_STALE_MS))))).returning();
  let sent = 0;
  for (const chunk of stale) {
    const rows = (await queuedEnlargementsOfChunk(db, chunk)).filter((row) => row.sends < ENLARGE_SEND_WARN || +row.updatedAt <= +now - ENLARGE_SEND_SLOW_MS);
    log("chunk recovered", { batchId, chunkId: chunk.id, stage: chunk.stage, step: chunk.step, reason: "enlargement_stale", rows: rows.length });
    for (const row of rows) {
      const [bumped] = await db.update(catalogEnlargements).set({ sends: sql`${catalogEnlargements.sends} + 1`, updatedAt: now })
        .where(and(eq(catalogEnlargements.id, row.id), eq(catalogEnlargements.sends, row.sends), eq(catalogEnlargements.status, "queued"), eq(catalogEnlargements.wanted, true))).returning();
      if (!bumped) continue;
      if (bumped.sends > ENLARGE_SEND_WARN) log("enlargement task cannot be delivered", { severity: "ERROR", batchId, chunkId: chunk.id, enlargementId: bumped.id, sourceImageId: bumped.sourceImageId, sends: bumped.sends });
      sent += await enqueueEnlargements(enqueue, [bumped], { log, chunkId: chunk.id, ...(bulk ? { bulk: true } : {}) });
    }
  }
  return sent;
}

/**
 * Spec 17 G4: a queued step whose task never started within `CHUNK_UNSTARTED_STALE_MS` (Cloud Tasks may drop a
 * created task after a run of 429s) gets the next step and a new task, once per step; the 30-minute rule covers the
 * rest. "Never started" means `started_at` is older than `dispatched_at`, so a step that ran and waits for its own
 * retry is left alone, and so is a row from before 0004 (its step-less tasks may adopt it). A second caller at the
 * same time matches nothing, and the old task, if it was only slow, answers "stale". Returns the number re-sent.
 */
export async function redispatchUnstartedChunks(db: Db, enqueue: Enqueue, batchId: string, options: Pick<DispatchOptions, "now" | "log"> = {}): Promise<number> {
  const now = options.now ?? new Date(), log = options.log ?? defaultLog;
  const resent = await db.update(catalogChunks)
    .set({ step: sql`${catalogChunks.step} + 1`, stepKnown: true, dispatchedAt: now, taskName: REDISPATCHED_TASK, leaseUntil: null })
    .where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.status, "queued"), isNull(catalogChunks.taskName), eq(catalogChunks.stepKnown, true),
      inArray(catalogChunks.batchId, db.select({ id: catalogBatches.id }).from(catalogBatches).where(and(eq(catalogBatches.id, batchId), inArray(catalogBatches.status, PROCESSING_STATUSES)))),
      lt(catalogChunks.dispatchedAt, new Date(+now - CHUNK_UNSTARTED_STALE_MS)),
      or(isNull(catalogChunks.startedAt), lt(catalogChunks.startedAt, catalogChunks.dispatchedAt))))
    .returning();
  if (!resent.length) return 0;
  const bulk = await batchIsBulk(db, batchId);
  for (const chunk of resent) {
    log("chunk recovered", { batchId, chunkId: chunk.id, stage: chunk.stage, step: chunk.step, reason: "task_not_started" });
    // A failed enqueue keeps the new step and the marker, so the 30-minute lost-task rule queues it again.
    await tryEnqueueChunk(enqueue, { ...chunk, batchId }, log, {}, bulk);
  }
  return resent.length;
}
