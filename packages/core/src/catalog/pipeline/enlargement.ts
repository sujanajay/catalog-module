// Spec 18 H3: the durable enlargement stage. A photo the render may enlarge past UPSCALE_MIN_SCALE gets its x2 image
// from its own Cloud Tasks task (/tasks/catalog/enlarge, the worker's catalog/enlarge.ts), queued at the matte stage;
// the chunk's render waits for every such photo of the chunk to be settled. Per photo (catalog_source_images, 0005):
//   not needed  x2_model null
//   queued      x2_model set (the upscaler id), x2_uri null, x2_attempts below ENLARGE_TASK_MAX_ATTEMPTS
//   done        x2_uri set (the stored x2 JPEG; the render primes it and never calls the service)
//   failed      x2_uri null, x2_attempts at ENLARGE_TASK_MAX_ATTEMPTS (x2_error says why); the render holds the outputs
// The gate: a chunk whose matte stage ends with a queued photo parks at the render stage (status queued, task_name
// ENLARGING_TASK, dispatched_at null): it holds no window slot and no task, and the dispatch rules skip it. The enlarge
// task that settles the chunk's last queued photo unparks it (task_name and dispatched_at null: an ordinary waiting
// chunk) in the same transaction as its photo write, then tops up the window. Both the park and the settle lock the
// chunk row first (the settle: every chunk of the batch holding the product, in id order), so one of them always sees
// the other's write: a chunk is never parked after its last photo settled, and never unparked while one is queued.
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogChunks, catalogSourceImages } from "../../db/schema";
import { ENLARGE_DISPATCH_DEADLINE_SEC, enlargeTaskId, type EnlargeTaskBody, type enqueueTask } from "../../tasks";

/** Attempts of one photo's enlargement before it is failed: the enlarge lanes' max-attempts (infra/lib/queues.sh). */
export const ENLARGE_TASK_MAX_ATTEMPTS = 8;
/**
 * A parked chunk whose batch's enlarge lane has been quiet this long has its queued photos' tasks sent again (next
 * round). Every enlarge delivery of the batch refreshes the progress_at of every parked chunk of the batch, not only
 * the chunks holding its product: tasks wait in the paced lane (ENLARGE_DISPATCHES_PER_SECOND), so a chunk's own photos
 * may not reach the worker for a long time while the lane works through earlier ones. While any task of the batch is
 * delivered, nothing is sent again; once none was for 60 minutes (one attempt, at most ENLARGE_DISPATCH_DEADLINE_SEC
 * = 30 minutes, plus the longest queue back-off, 300 s, is 35), the remaining tasks are taken as lost: the queue gave
 * up on them (its max-attempts also counts 429s answered before the app) or their enqueue failed.
 */
export const ENLARGE_STALE_MS = 60 * 60_000;
/**
 * How long a delivery's in-flight claim on a photo (x2_claimed_at) holds: the enlarge task's dispatch deadline, after
 * which Cloud Tasks has given up on that delivery and a new one may call the service.
 */
export const ENLARGE_CLAIM_MS = ENLARGE_DISPATCH_DEADLINE_SEC * 1000;
/** `task_name` of a chunk parked at the render stage until its photos' enlargements settle. */
export const ENLARGING_TASK = "enlarging";

type Tx = Pick<Db, "select" | "update" | "execute">;

/**
 * Spec 18: what Start records on the batch (options.enlargement) when the upscaler is on (`UPSCALE_MODEL` set and not
 * "off"): the batch is made with the enlargement stage, which scopes the enlarged_without_upscaler invariant. Null when
 * off; a batch from before the stage has none.
 */
export function enlargementOptionFromEnv(env: NodeJS.ProcessEnv = process.env): { model: string } | null {
  const model = env.UPSCALE_MODEL?.trim();
  return model && model !== "off" ? { model } : null;
}

/**
 * A photo queued for enlargement (not yet done or failed): the one definition of "queued", used in a select of
 * catalog_source_images and inside chunkHasQueuedEnlargement. photoEnlargementState is its TypeScript twin.
 */
export function photoEnlargementQueued(): SQL {
  return sql`${catalogSourceImages.x2Model} IS NOT NULL AND ${catalogSourceImages.x2Uri} IS NULL AND ${catalogSourceImages.x2Attempts} < ${ENLARGE_TASK_MAX_ATTEMPTS}`;
}

/** A photo whose enlargement failed (every attempt spent, no x2 image): photoEnlargementState's "failed". */
export function photoEnlargementFailed(): SQL {
  return sql`${catalogSourceImages.x2Model} IS NOT NULL AND ${catalogSourceImages.x2Uri} IS NULL AND ${catalogSourceImages.x2Attempts} >= ${ENLARGE_TASK_MAX_ATTEMPTS}`;
}

/**
 * The photos of the current catalog_chunks row (in an UPDATE or SELECT of catalog_chunks): its products' photos, or
 * only its own photo list when it has one.
 */
function photoOfCurrentChunk(): SQL {
  return sql`${catalogSourceImages.batchId} = "catalog_chunks"."batch_id"
    AND ${catalogSourceImages.productId}::text IN (SELECT jsonb_array_elements_text("catalog_chunks"."product_ids"))
    AND ("catalog_chunks"."source_image_ids" IS NULL OR jsonb_array_length("catalog_chunks"."source_image_ids") = 0 OR "catalog_chunks"."source_image_ids" @> jsonb_build_array(${catalogSourceImages.id}))`;
}

/** True for the current catalog_chunks row while one of its photos is queued for enlargement. */
export function chunkHasQueuedEnlargement(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${catalogSourceImages} WHERE ${photoOfCurrentChunk()} AND ${photoEnlargementQueued()})`;
}

export type PhotoEnlargementState = "not_needed" | "queued" | "done" | "failed";
export function photoEnlargementState(row: { x2Model: string | null; x2Uri: string | null; x2Attempts: number }): PhotoEnlargementState {
  if (row.x2Uri) return "done";
  if (!row.x2Model) return "not_needed";
  return row.x2Attempts >= ENLARGE_TASK_MAX_ATTEMPTS ? "failed" : "queued";
}

/** The photos of `chunk` (its products' photos, or only its own photo list) that match `where`. */
export async function photosOfChunk(db: Pick<Db, "select">, chunk: { batchId: string; productIds: string[]; sourceImageIds: string[] | null }, where: SQL): Promise<{ id: string; productId: string }[]> {
  if (!chunk.productIds.length) return [];
  return db.select({ id: catalogSourceImages.id, productId: catalogSourceImages.productId }).from(catalogSourceImages)
    .where(and(eq(catalogSourceImages.batchId, chunk.batchId), inArray(catalogSourceImages.productId, chunk.productIds), where,
      chunk.sourceImageIds?.length ? inArray(catalogSourceImages.id, chunk.sourceImageIds) : undefined));
}
/** The photos of `chunk` still queued for enlargement. */
export function queuedPhotosOfChunk(db: Pick<Db, "select">, chunk: { batchId: string; productIds: string[]; sourceImageIds: string[] | null }): Promise<{ id: string; productId: string }[]> {
  return photosOfChunk(db, chunk, photoEnlargementQueued());
}

/**
 * Sends one enlarge task per photo as `round` (enlargeTaskId: a name Cloud Tasks keeps once). A failed send is logged
 * and left to the parked chunk's recovery (resendStaleEnlargements). Returns the number sent.
 */
export async function enqueueEnlargements(enqueue: typeof enqueueTask, batchId: string, photos: { id: string; productId: string }[], round: number, options: { bulk?: boolean; log: (message: string, fields?: Record<string, unknown>) => void; chunkId?: string }): Promise<number> {
  let sent = 0;
  for (const photo of photos) {
    const body: EnlargeTaskBody = { batchId, productId: photo.productId, sourceImageId: photo.id, round };
    try { await enqueue("/tasks/catalog/enlarge", { ...body }, { taskId: enlargeTaskId(photo.id, round), ...(options.bulk ? { bulk: true } : {}) }); sent++; }
    catch (error) { options.log("enlarge dispatch failed", { severity: "WARNING", batchId, ...(options.chunkId ? { chunkId: options.chunkId } : {}), productId: photo.productId, sourceImageId: photo.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return sent;
}

/**
 * Locks every chunk of the batch that holds the product, in id order (the same lock the matte stage's park takes
 * first), so a photo write and a park never miss each other.
 */
export async function lockProductChunks(tx: Tx, batchId: string, productId: string): Promise<string[]> {
  const rows = await tx.select({ id: catalogChunks.id }).from(catalogChunks)
    .where(and(eq(catalogChunks.batchId, batchId), sql`${catalogChunks.productIds} @> jsonb_build_array(${productId}::text)`))
    .orderBy(asc(catalogChunks.id)).for("update");
  return rows.map((row) => row.id);
}

/**
 * Unparks the parked chunks in `scope` (chunk ids, or every chunk of a batch) that have no queued photo left: the one
 * unpark rule. The settle calls it under lockProductChunks after its photo write; the recovery sweep and the in-process
 * runner call it as a safety net. Returns the ids unparked (ordinary waiting chunks now, dispatched by the next
 * dispatchChunks).
 */
export async function unparkSettledChunks(tx: Tx, scope: string[] | { batchId: string }, now: Date): Promise<string[]> {
  if (Array.isArray(scope) && !scope.length) return [];
  const rows = await tx.update(catalogChunks).set({ taskName: null, dispatchedAt: null, progressAt: now })
    .where(and(Array.isArray(scope) ? inArray(catalogChunks.id, scope) : eq(catalogChunks.batchId, scope.batchId), eq(catalogChunks.status, "queued"), eq(catalogChunks.taskName, ENLARGING_TASK), sql`NOT ${chunkHasQueuedEnlargement()}`))
    .returning({ id: catalogChunks.id });
  return rows.map((row) => row.id);
}
