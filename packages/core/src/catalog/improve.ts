// M1-S4 improvement task (docs/program/requirements/M1-intake.md M1-F3-R4, R5; decisions D11, D13). An auto-decide batch
// delivers the plain render of a photo the upscaler could not enlarge, flagged `provisional` (M1-S3, cause
// `not_enlarged`). Later, while the upscaler answers, the photo is enlarged again through the spec 18 "Try again" reset
// (decisions.ts resetPhotoEnlargement): the photo's outputs are re-made and published at the same public path with a
// new object generation, and the `provisional` flag clears because the new render carries no hold. Tries are bounded:
// IMPROVE_MAX_TRIES within IMPROVE_WINDOW_MS of the first delivery, the first after IMPROVE_FIRST_DELAY_MS, then at
// least IMPROVE_SPACING_MS apart. The tries live in catalog_improvements (migration 0019), not on the output, because
// every render rewrites the output's compliance record.
// Review 2026-11-04: a try runs only while the batch still owns the product's links (the product's last_batch_id names
// it; a later batch that published the product retires the candidate as `superseded`), and only on the batch's
// channels. A re-made slot that does not pass (held, dropped, failed, never judged) is put back as it was delivered
// (restoreUnpassedImprovements, called by the publish before it plans), so a failed try never downgrades a delivered
// link and the photo stays tracked.
import { and, eq, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogChunks, catalogEnlargements, catalogImprovements, catalogOutputs, catalogProducts, type CatalogImprovement } from "../db/schema";
import { laterPublisher, resetPhotoEnlargement, sendEnlargements } from "./decisions";
import { keepDeliveredOutputs } from "./improve-keep";
import { autoDecideOf } from "./auto-decide";
import type { enqueueTask } from "../tasks";
import type { ImprovementEndReason } from "./types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Output = typeof catalogOutputs.$inferSelect;

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
/** The same condition on `catalog_outputs AS o` (raw queries); catalog_outputs_provisional_plain_idx (0019) serves it. */
const provisionalPlainO = sql.raw(`o.flags @> '["provisional", "enlargement_failed"]'::jsonb AND o.is_live AND o.status = 'verified' AND o.decision IS NULL`);

/**
 * The photos whose provisional plain render is due a try at `now`: in a done auto-decide batch, first delivered between
 * IMPROVE_WINDOW_MS and IMPROVE_FIRST_DELAY_MS ago, with fewer than IMPROVE_MAX_TRIES tries, the last at least
 * IMPROVE_SPACING_MS ago, no try running and not ended, a failed enlargement a call can make, the product's links still
 * this batch's (last_batch_id) and the product free or locked to this batch. The photos looked at least recently come
 * first (a try that waits for the upscaler touches its row, so the same photos never keep the head of the LIMIT), then
 * by first delivery.
 */
export async function improvementCandidates(db: Db, now: Date, limit = IMPROVE_SWEEP_LIMIT): Promise<ImprovementCandidate[]> {
  const t = +now;
  const rows = await db.execute(sql`
    SELECT DISTINCT o.batch_id, o.product_id, o.source_image_id, coalesce(i.tries, 0) AS tries, i.updated_at AS touched_at, min(o.published_at) OVER (PARTITION BY o.batch_id, o.source_image_id) AS first_at
    FROM catalog_outputs AS o
    JOIN catalog_batches AS b ON b.id = o.batch_id
    JOIN catalog_products AS p ON p.id = o.product_id
    LEFT JOIN catalog_improvements AS i ON i.batch_id = o.batch_id AND i.source_image_id = o.source_image_id
    WHERE ${provisionalPlainO}
      AND b.status = 'done' AND b.options ? 'autoDecide'
      AND p.last_batch_id = o.batch_id AND (p.lock_batch_id IS NULL OR p.lock_batch_id = o.batch_id)
      AND o.published_at > ${new Date(t - IMPROVE_WINDOW_MS).toISOString()}::timestamptz
      AND o.published_at <= ${new Date(t - IMPROVE_FIRST_DELAY_MS).toISOString()}::timestamptz
      AND coalesce(i.tries, 0) < ${IMPROVE_MAX_TRIES}
      AND (i.last_tried_at IS NULL OR i.last_tried_at <= ${new Date(t - IMPROVE_SPACING_MS).toISOString()}::timestamptz)
      AND i.ended_at IS NULL AND i.previous IS NULL
      AND EXISTS (SELECT 1 FROM catalog_enlargements AS e WHERE e.batch_id = o.batch_id AND e.source_image_id = o.source_image_id
        AND e.wanted AND e.status = 'failed' AND e.route <> 'none')
    ORDER BY touched_at NULLS FIRST, first_at, o.source_image_id
    LIMIT ${limit}`);
  return rowsOf(rows).map(r => ({ batchId: String(r.batch_id), productId: String(r.product_id), sourceImageId: String(r.source_image_id), tries: Number(r.tries) }));
}

/**
 * What one improvement task did: `improving` (the photo is being re-made), or why it changed nothing. `superseded`: a
 * later batch published the product (the candidate is retired). `not_due`: outside the window or the spacing (a task
 * delivered late).
 */
export type ImproveOutcome = "improving" | "busy" | "nothing_to_improve" | "exhausted" | "superseded" | "not_due";

/**
 * One try for one photo: in one transaction, lock the product (another batch holding it: `busy`, nothing counted; a
 * later batch's links: `superseded`, retired), take the photo's live provisional plain outputs on the batch's channels,
 * re-check the window and the spacing, count the try (catalog_improvements), keep the outputs as delivered
 * (`previous`) and reset the photo for the upscaler (resetPhotoEnlargement: the outputs go `pending` without
 * `provisional` and `enlargement_failed`, a one-photo render chunk is parked on the queued rows). Then the rows' tasks
 * are sent. The caller probes the upscaler first and re-opens the batch's finalize, so the batch writes a new links
 * sheet and releases the product again.
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
    // P1 (review 2026-11-04): a later batch published this product, so this batch's outputs are no longer its links
    // (the same check as Use as is, Replace and Try again: decisions.ts laterPublisher).
    if (await laterPublisher(tx, product, input.batchId)) {
      await endImprovement(tx, { batchId: input.batchId, productId: first.productId, sourceImageId: input.sourceImageId }, "superseded", now);
      return { outcome: "superseded" as const };
    }
    const outputs = (await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, input.batchId), eq(catalogOutputs.sourceImageId, input.sourceImageId), provisionalPlain)).orderBy(catalogOutputs.id).for("update"))
      .filter(o => batch.channels.includes(o.channel));
    if (!outputs.length) return { outcome: "nothing_to_improve" as const };
    const [record] = await tx.insert(catalogImprovements).values({ batchId: input.batchId, productId: first.productId, sourceImageId: input.sourceImageId })
      .onConflictDoUpdate({ target: [catalogImprovements.batchId, catalogImprovements.sourceImageId], set: { updatedAt: now } }).returning();
    if (record!.endedAt || record!.previous) return { outcome: "nothing_to_improve" as const };
    if (record!.tries >= IMPROVE_MAX_TRIES) return { outcome: "exhausted" as const, tries: record!.tries };
    // A task delivered late (a backlog, a queue retry) keeps the window and the spacing exact.
    const firstAt = Math.min(...outputs.map(o => +(o.publishedAt ?? now)));
    if (+now - firstAt > IMPROVE_WINDOW_MS || +now - firstAt < IMPROVE_FIRST_DELAY_MS) return { outcome: "not_due" as const };
    if (record!.lastTriedAt && +now - +record!.lastTriedAt < IMPROVE_SPACING_MS) return { outcome: "not_due" as const };
    const tries = record!.tries + 1;
    // The outputs as delivered, kept until the publish has seen the re-made slots (restoreUnpassedImprovements).
    await keepDeliveredOutputs(tx, { batchId: input.batchId, productId: first.productId, sourceImageId: input.sourceImageId }, outputs.map(o => o.id), now);
    const reset = await resetPhotoEnlargement(tx, outputs[0]!, outputs, { now, actor: IMPROVE_ACTOR, dropFlags: ["provisional", "enlargement_failed"], details: { reason: "auto_decide", improvement: tries } });
    if (!reset) {
      await tx.update(catalogImprovements).set({ previous: null }).where(eq(catalogImprovements.id, record!.id));
      return { outcome: "nothing_to_improve" as const };
    }
    await tx.update(catalogImprovements).set({ tries, lastTriedAt: now, updatedAt: now }).where(eq(catalogImprovements.id, record!.id));
    return { outcome: "improving" as const, tries, reset };
  });
  if (result.outcome !== "improving") return result;
  await sendEnlargements(db, enqueue, { batchId: input.batchId, ...result.reset }, input.log);
  return { outcome: "improving", tries: result.tries, chunkId: result.reset.chunkId };
}

/** A re-made slot passed: judged (or sampled out) and not held, staged for the publish, or already published so. */
function passed(o: Output): boolean {
  if (o.flags.includes("provisional") || o.decision !== null) return false;
  if (o.status === "verified") return true;
  return o.status === "staged" && (o.qaScores !== null || o.flags.includes("qa_sampled_out"));
}

/**
 * P2-1 (review 2026-11-04), called by publishProduct of an auto-decide batch under the product lock before it plans:
 * for each photo of the product with a try running (`previous` kept) and no chunk holding the product open any more,
 * every re-made slot that did not pass (held and delivered or dropped by a rule, failed, never judged, never made) is
 * put back exactly as it was delivered (its public object was never overwritten: only a pass is copied), so a failed
 * try never downgrades a delivered link and the photo stays a candidate. The try then ends (`previous` cleared); when
 * the upscaler did enlarge the photo but its render did not pass, another try cannot help and the photo is retired
 * (`not_passed`). Returns the outputs put back.
 */
export async function restoreUnpassedImprovements(tx: Tx, batchId: string, productId: string, now: Date): Promise<number> {
  const running = await tx.select().from(catalogImprovements).where(and(eq(catalogImprovements.batchId, batchId), eq(catalogImprovements.productId, productId), isNotNull(catalogImprovements.previous)));
  if (!running.length) return 0;
  const [open] = await tx.select({ id: catalogChunks.id }).from(catalogChunks).where(and(eq(catalogChunks.batchId, batchId), sql`${catalogChunks.productIds} @> jsonb_build_array(${productId}::text)`, sql`${catalogChunks.status} NOT IN ('done', 'failed')`)).limit(1);
  if (open) return 0;
  const columns = Object.values(getTableColumns(catalogOutputs)).map(c => c.name).filter(name => !["id", "created_at", "updated_at"].includes(name));
  const assign = sql.raw(columns.map(name => `"${name}" = r."${name}"`).join(", "));
  let restored = 0;
  for (const record of running) {
    const kept = (record.previous ?? []).map(row => String(row.id));
    const current = kept.length ? await tx.select().from(catalogOutputs).where(inArray(catalogOutputs.id, kept)).for("update") : [];
    const back = current.filter(o => !passed(o)).map(o => o.id);
    if (back.length) {
      await tx.execute(sql`UPDATE catalog_outputs AS o SET ${assign}, updated_at = ${now.toISOString()}::timestamptz
        FROM jsonb_populate_recordset(NULL::catalog_outputs, (SELECT previous FROM catalog_improvements WHERE id = ${record.id})) AS r
        WHERE o.id = r.id AND ${inArray(sql`o.id`, back)}`);
      restored += back.length;
    }
    const [failed] = back.length ? await tx.select({ id: catalogEnlargements.id }).from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, batchId), eq(catalogEnlargements.sourceImageId, record.sourceImageId), eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.status, "failed"), sql`${catalogEnlargements.route} <> 'none'`)).limit(1) : [{ id: "" }];
    await tx.update(catalogImprovements).set({ previous: null, updatedAt: now, ...(back.length && !failed ? { endedAt: now, endReason: "not_passed" as const } : {}) }).where(eq(catalogImprovements.id, record.id));
  }
  return restored;
}

/** Retires a photo's candidate without an improvement (`superseded`, `not_passed`); the row is made when none exists. */
async function endImprovement(tx: Tx, key: { batchId: string; productId: string; sourceImageId: string }, reason: ImprovementEndReason, now: Date): Promise<void> {
  await tx.insert(catalogImprovements).values({ ...key, endedAt: now, endReason: reason })
    .onConflictDoUpdate({ target: [catalogImprovements.batchId, catalogImprovements.sourceImageId], set: { endedAt: sql`coalesce(${catalogImprovements.endedAt}, ${now.toISOString()}::timestamptz)`, endReason: sql`coalesce(${catalogImprovements.endReason}, ${reason})`, updatedAt: now } });
}

/**
 * P3-4: a photo whose try waits for the upscaler is touched (`updated_at`), so the sweep's next LIMIT starts with the
 * photos looked at least recently and one unavailable upscaler never starves the photos of a healthy one.
 */
export async function noteImprovementWait(db: Db, key: { batchId: string; productId: string; sourceImageId: string }, now: Date): Promise<void> {
  await db.insert(catalogImprovements).values(key).onConflictDoUpdate({ target: [catalogImprovements.batchId, catalogImprovements.sourceImageId], set: { updatedAt: now } });
}

/**
 * Records `improved_at` for each tried photo whose try is over (no `previous` kept), not ended, and whose live slots in
 * its batch are all published and none provisional (the "improved within 72 h" measure). A slot that is live but not
 * verified, or still provisional, is not improved (P2-1). Returns how many it marked.
 */
export async function markImproved(db: Db, now: Date): Promise<number> {
  const marked = await db.update(catalogImprovements).set({ improvedAt: now, updatedAt: now }).where(and(
    sql`${catalogImprovements.improvedAt} IS NULL AND ${catalogImprovements.tries} > 0 AND ${catalogImprovements.previous} IS NULL AND ${catalogImprovements.endedAt} IS NULL`,
    sql`EXISTS (SELECT 1 FROM catalog_outputs AS o WHERE o.batch_id = ${catalogImprovements.batchId} AND o.source_image_id = ${catalogImprovements.sourceImageId} AND o.is_live AND o.status = 'verified')`,
    sql`NOT EXISTS (SELECT 1 FROM catalog_outputs AS o WHERE o.batch_id = ${catalogImprovements.batchId} AND o.source_image_id = ${catalogImprovements.sourceImageId}
      AND (o.status IN ('pending', 'staged', 'needs_attention') OR (o.is_live AND (o.status <> 'verified' OR o.flags @> '["provisional"]'::jsonb))))`,
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
