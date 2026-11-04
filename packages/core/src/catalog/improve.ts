// M1-S4 improvement task (docs/program/requirements/M1-intake.md M1-F3-R4, R5; decision D11). An auto-decide batch
// delivers the plain render of a photo the upscaler could not enlarge, flagged `provisional` (M1-S3, cause
// `not_enlarged`). Later, while the upscaler answers, the photo is enlarged again through the spec 18 "Try again" reset
// (decisions.ts resetPhotoEnlargement): the photo's outputs are re-made and published at the same public path with a
// new object generation, and the `provisional` flag clears because the new render carries no hold. Tries are bounded:
// IMPROVE_MAX_TRIES within IMPROVE_WINDOW_MS of the first delivery, the first after IMPROVE_FIRST_DELAY_MS, then at
// least IMPROVE_SPACING_MS apart. The tries live in catalog_improvements (migration 0019), not on the output, because
// every render rewrites the output's compliance record.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogImprovements, catalogOutputs, catalogProducts, type CatalogImprovement } from "../db/schema";
import { resetPhotoEnlargement, sendEnlargements } from "./decisions";
import { autoDecideOf } from "./auto-decide";
import type { enqueueTask } from "../tasks";

/** Tries per photo (M1-F3-R5 default 3). */
export const IMPROVE_MAX_TRIES = 3;
/** Tries start within this long after the first delivery (M1-F3-R5 default 72 hours). */
export const IMPROVE_WINDOW_MS = 72 * 60 * 60_000;
/** The first try waits this long after delivery, so a short upscaler outage is over first. */
export const IMPROVE_FIRST_DELAY_MS = 30 * 60_000;
/** Tries are at least this far apart, so 3 tries spread over the window instead of one bad hour. */
export const IMPROVE_SPACING_MS = 12 * 60 * 60_000;
/** Photos the sweep sends at most per run (every 10 minutes), so a large batch is improved in waves. */
export const IMPROVE_SWEEP_LIMIT = 100;
/** The actor recorded on an improvement's `enlargement_retried` event. */
export const IMPROVE_ACTOR = "auto-improve";

/** One photo the sweep may send an improvement task for. */
export interface ImprovementCandidate { batchId: string; productId: string; sourceImageId: string; tries: number }

/** A provisional plain render, live: the slot an improvement is for (outputs of auto-decide batches only). */
const provisionalPlain = sql`${catalogOutputs.flags} @> '["provisional", "enlargement_failed"]'::jsonb AND ${catalogOutputs.isLive} AND ${catalogOutputs.status} = 'verified' AND ${catalogOutputs.decision} IS NULL`;
/** The same condition on `catalog_outputs AS o` (raw queries). */
const provisionalPlainO = sql.raw(`o.flags @> '["provisional", "enlargement_failed"]'::jsonb AND o.is_live AND o.status = 'verified' AND o.decision IS NULL`);

/**
 * The photos whose provisional plain render is due a try at `now`: in a done auto-decide batch, first delivered between
 * IMPROVE_WINDOW_MS and IMPROVE_FIRST_DELAY_MS ago, with fewer than IMPROVE_MAX_TRIES tries, the last at least
 * IMPROVE_SPACING_MS ago, a failed enlargement a call can make, and the product free or locked to this batch.
 */
export async function improvementCandidates(db: Db, now: Date, limit = IMPROVE_SWEEP_LIMIT): Promise<ImprovementCandidate[]> {
  const t = +now;
  const rows = await db.execute(sql`
    SELECT DISTINCT o.batch_id, o.product_id, o.source_image_id, coalesce(i.tries, 0) AS tries, min(o.published_at) OVER (PARTITION BY o.batch_id, o.source_image_id) AS first_at
    FROM catalog_outputs AS o
    JOIN catalog_batches AS b ON b.id = o.batch_id
    JOIN catalog_products AS p ON p.id = o.product_id
    LEFT JOIN catalog_improvements AS i ON i.batch_id = o.batch_id AND i.source_image_id = o.source_image_id
    WHERE ${provisionalPlainO}
      AND b.status = 'done' AND b.options ? 'autoDecide'
      AND (p.lock_batch_id IS NULL OR p.lock_batch_id = o.batch_id)
      AND o.published_at > ${new Date(t - IMPROVE_WINDOW_MS).toISOString()}::timestamptz
      AND o.published_at <= ${new Date(t - IMPROVE_FIRST_DELAY_MS).toISOString()}::timestamptz
      AND coalesce(i.tries, 0) < ${IMPROVE_MAX_TRIES}
      AND (i.last_tried_at IS NULL OR i.last_tried_at <= ${new Date(t - IMPROVE_SPACING_MS).toISOString()}::timestamptz)
      AND EXISTS (SELECT 1 FROM catalog_enlargements AS e WHERE e.batch_id = o.batch_id AND e.source_image_id = o.source_image_id
        AND e.wanted AND e.status = 'failed' AND e.route <> 'none')
    ORDER BY first_at, o.source_image_id
    LIMIT ${limit}`);
  return rowsOf(rows).map(r => ({ batchId: String(r.batch_id), productId: String(r.product_id), sourceImageId: String(r.source_image_id), tries: Number(r.tries) }));
}

/** What one improvement task did: `improving` (the photo is being re-made), or why it changed nothing. */
export type ImproveOutcome = "improving" | "busy" | "nothing_to_improve" | "exhausted";

/**
 * One try for one photo: in one transaction, lock the product (another batch holding it: `busy`, nothing counted), take
 * the photo's live provisional plain outputs, count the try (catalog_improvements), and reset the photo for the
 * upscaler (resetPhotoEnlargement: the outputs go `pending` without `provisional` and `enlargement_failed`, a one-photo
 * render chunk is parked on the queued rows). Then the rows' tasks are sent. The caller probes the upscaler first and
 * re-opens the batch's finalize, so the batch writes a new links sheet and releases the product again.
 */
export async function improvePhoto(db: Db, enqueue: typeof enqueueTask, input: { batchId: string; sourceImageId: string; now: Date; log?: (message: string, fields?: Record<string, unknown>) => void }): Promise<{ outcome: ImproveOutcome; tries?: number; chunkId?: string }> {
  const { now } = input;
  const result = await db.transaction(async tx => {
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, input.batchId)).for("share");
    if (!batch || batch.status !== "done" || !autoDecideOf(batch.options)) return { outcome: "nothing_to_improve" as const };
    const [first] = await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, input.batchId), eq(catalogOutputs.sourceImageId, input.sourceImageId))).limit(1);
    if (!first) return { outcome: "nothing_to_improve" as const };
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, first.productId)).for("update");
    if (!product) return { outcome: "nothing_to_improve" as const };
    if (product.lockBatchId && product.lockBatchId !== input.batchId) return { outcome: "busy" as const };
    const outputs = await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, input.batchId), eq(catalogOutputs.sourceImageId, input.sourceImageId), provisionalPlain)).orderBy(catalogOutputs.id).for("update");
    if (!outputs.length) return { outcome: "nothing_to_improve" as const };
    const [record] = await tx.insert(catalogImprovements).values({ batchId: input.batchId, productId: first.productId, sourceImageId: input.sourceImageId })
      .onConflictDoUpdate({ target: [catalogImprovements.batchId, catalogImprovements.sourceImageId], set: { updatedAt: now } }).returning();
    if (record!.tries >= IMPROVE_MAX_TRIES) return { outcome: "exhausted" as const, tries: record!.tries };
    const tries = record!.tries + 1;
    const reset = await resetPhotoEnlargement(tx, outputs[0]!, outputs, { now, actor: IMPROVE_ACTOR, dropFlags: ["provisional", "enlargement_failed"], details: { reason: "auto_decide", improvement: tries } });
    if (!reset) return { outcome: "nothing_to_improve" as const };
    await tx.update(catalogImprovements).set({ tries, lastTriedAt: now, updatedAt: now }).where(eq(catalogImprovements.id, record!.id));
    return { outcome: "improving" as const, tries, reset };
  });
  if (result.outcome !== "improving") return result;
  await sendEnlargements(db, enqueue, { batchId: input.batchId, ...result.reset }, input.log);
  return { outcome: "improving", tries: result.tries, chunkId: result.reset.chunkId };
}

/**
 * Records `improved_at` for each tried photo whose slots in its batch are all settled and none is provisional any more
 * (the "improved within 72 h" measure). Returns how many it marked.
 */
export async function markImproved(db: Db, now: Date): Promise<number> {
  const marked = await db.update(catalogImprovements).set({ improvedAt: now, updatedAt: now }).where(and(
    sql`${catalogImprovements.improvedAt} IS NULL AND ${catalogImprovements.tries} > 0`,
    sql`EXISTS (SELECT 1 FROM catalog_outputs AS o WHERE o.batch_id = ${catalogImprovements.batchId} AND o.source_image_id = ${catalogImprovements.sourceImageId} AND o.is_live AND o.status = 'verified')`,
    sql`NOT EXISTS (SELECT 1 FROM catalog_outputs AS o WHERE o.batch_id = ${catalogImprovements.batchId} AND o.source_image_id = ${catalogImprovements.sourceImageId}
      AND (o.flags @> '["provisional"]'::jsonb OR o.status IN ('pending', 'staged', 'needs_attention')))`,
  )).returning({ id: catalogImprovements.id });
  return marked.length;
}

/** The improvement row of one photo in one batch, or null when none was tried. */
export async function improvementOf(db: Db, batchId: string, sourceImageId: string): Promise<CatalogImprovement | null> {
  const [row] = await db.select().from(catalogImprovements).where(and(eq(catalogImprovements.batchId, batchId), eq(catalogImprovements.sourceImageId, sourceImageId)));
  return row ?? null;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}
