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

/** Attempts of one photo's enlargement before it is failed: the enlarge lanes' max-attempts (infra/lib/queues.sh). */
export const ENLARGE_TASK_MAX_ATTEMPTS = 8;
/**
 * A parked chunk that saw no enlargement attempt this long has its queued photos' tasks sent again (next round).
 * Each attempt refreshes the parked chunk's progress_at, and one attempt plus the longest queue back-off (300 s) is
 * under 20 minutes, so a photo whose task is still alive is never sent twice by this rule.
 */
export const ENLARGE_STALE_MS = 30 * 60_000;
/** `task_name` of a chunk parked at the render stage until its photos' enlargements settle. */
export const ENLARGING_TASK = "enlarging";

type Tx = Pick<Db, "select" | "update" | "execute">;

/** The photos of the current catalog_chunks row (in an UPDATE or SELECT of catalog_chunks) still queued for enlargement. */
export function chunkHasQueuedEnlargement(): SQL {
  return sql`EXISTS (SELECT 1 FROM catalog_source_images si WHERE si.batch_id = "catalog_chunks"."batch_id"
    AND si.product_id::text IN (SELECT jsonb_array_elements_text("catalog_chunks"."product_ids"))
    AND ("catalog_chunks"."source_image_ids" IS NULL OR jsonb_array_length("catalog_chunks"."source_image_ids") = 0 OR "catalog_chunks"."source_image_ids" @> jsonb_build_array(si.id))
    AND si.x2_model IS NOT NULL AND si.x2_uri IS NULL AND si.x2_attempts < ${ENLARGE_TASK_MAX_ATTEMPTS})`;
}

/** A photo queued for enlargement (not yet done or failed). */
export function photoEnlargementQueued(): SQL {
  return sql`${catalogSourceImages.x2Model} IS NOT NULL AND ${catalogSourceImages.x2Uri} IS NULL AND ${catalogSourceImages.x2Attempts} < ${ENLARGE_TASK_MAX_ATTEMPTS}`;
}

export type PhotoEnlargementState = "not_needed" | "queued" | "done" | "failed";
export function photoEnlargementState(row: { x2Model: string | null; x2Uri: string | null; x2Attempts: number }): PhotoEnlargementState {
  if (row.x2Uri) return "done";
  if (!row.x2Model) return "not_needed";
  return row.x2Attempts >= ENLARGE_TASK_MAX_ATTEMPTS ? "failed" : "queued";
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
 * Unparks the parked chunks among `chunkIds` that have no queued photo left; call under lockProductChunks, after the
 * photo write. Returns the ids unparked (ordinary waiting chunks now, dispatched by the next dispatchChunks).
 */
export async function unparkSettledChunks(tx: Tx, chunkIds: string[], now: Date): Promise<string[]> {
  if (!chunkIds.length) return [];
  const rows = await tx.update(catalogChunks).set({ taskName: null, dispatchedAt: null, progressAt: now })
    .where(and(inArray(catalogChunks.id, chunkIds), eq(catalogChunks.status, "queued"), eq(catalogChunks.taskName, ENLARGING_TASK), sql`NOT ${chunkHasQueuedEnlargement()}`))
    .returning({ id: catalogChunks.id });
  return rows.map((row) => row.id);
}
