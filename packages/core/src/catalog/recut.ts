// M1 D42: cut delivered photos out again after the matte guard changed, so a bad image already delivered is replaced at the same
// public URL. A new batch cannot do it: the render key skips a live output whose source is unchanged and the stored matte
// is used again. recutPhotos resets the photos' outputs in the batch that owns them and queues one matte chunk for the
// product; the normal pipeline then cuts, renders, judges and publishes. The publish keeps the worker's rule: planPublish
// asserts the held product's prefix (assertWithinProduct) and the batch's channels, and writes only with ifGenerationMatch.
// The old object stays live until the new image is copied over it. A result left out, or held for a person, takes the old
// image down (planPublish `removes`), so a bad image does not stay online; except image 1, which stays until the person
// decides, because a listing with no first image is worse than the image it had. A full batch does the same to an older batch's
// image when it rejects the photo for what the image shows (M1 D45).
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogChunks, catalogImprovements, catalogOutputs, catalogProducts, catalogSourceImages } from "../db/schema";
import { autoDecideOf, autoDecideSnapshot, heldForPerson } from "./auto-decide";
import { awaitingStart } from "./improve";
import { lockProductChunks } from "./pipeline/enlargement";
import { recordEvent } from "./products";
import type { OutputFlag } from "./types";

type Output = typeof catalogOutputs.$inferSelect;
/** The actor on a re-cut's event. */
export const RECUT_ACTOR = "matte-recut";
/** The flags of the matte and of the judging the re-cut replaces. */
const RECUT_DROPS_FLAGS = new Set<OutputFlag>(["provisional", "auto_dropped", "leftover_background", "matte_passthrough", "fallback_matte", "halo", "product_removed", "text_or_watermark"]);
/**
 * What one re-cut did. `recutting`: a chunk is queued. `busy`: another batch holds the product, a draft is about to take it,
 * or work on it is still open in this batch (a chunk, a re-cut already sent, an improvement), so nothing is touched and a
 * second send changes nothing. `superseded`: a later batch published this product, so nothing is touched: a re-cut only works in
 * the product's last publisher, and never changes what a later batch delivered. `not_done`: the batch is still running or stopped. `nothing_to_recut`: no delivered or held slot, or a person decided it.
 */
export type RecutOutcome = "recutting" | "busy" | "superseded" | "not_done" | "nothing_to_recut";
export interface RecutResult { outcome: RecutOutcome; chunkId?: string; outputs?: number; /** Per photo, when the product was looked at. */ photos?: Record<string, RecutOutcome> }

/** A slot this batch delivered or holds back. A decision a person made stays as it is, and a slot never delivered has nothing to replace. */
const recuttable = (o: Output) => o.decision === null && (o.isLive || heldForPerson(o));

/** The marker the matte stage reads: this photo's stored matte is the one being replaced (chunk.ts). */
export function recutRequested(compliance: unknown): boolean {
  return (compliance as { recut?: unknown } | null | undefined)?.recut === true;
}

/** Photos of one product share one chunk: judged apart, triage on one would count the other's pending rows as not good. */
export async function recutPhotos(db: Db, input: { batchId: string; sourceImageIds: readonly string[]; now: Date }): Promise<RecutResult> {
  const { batchId, sourceImageIds, now } = input;
  if (!sourceImageIds.length) return { outcome: "nothing_to_recut" };
  return db.transaction(async tx => {
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)).for("update");
    if (!batch || batch.status !== "done" || !autoDecideOf(batch.options)) return { outcome: "not_done" as const };
    const sources = await tx.select().from(catalogSourceImages).where(and(inArray(catalogSourceImages.id, [...sourceImageIds]), eq(catalogSourceImages.batchId, batchId)));
    const productIds = [...new Set(sources.map(s => s.productId))];
    if (productIds.length !== 1 || sources.length !== new Set(sourceImageIds).size) return { outcome: "nothing_to_recut" as const };
    const productId = productIds[0]!;
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, productId)).for("update");
    if (!product) return { outcome: "nothing_to_recut" as const };
    if (product.lockBatchId && product.lockBatchId !== batchId) return { outcome: "busy" as const };
    // A later batch published this product: refused before anything is written, however often it is sent.
    if (product.lastBatchId && product.lastBatchId !== batchId) return { outcome: "superseded" as const, photos: Object.fromEntries(sources.map(s => [s.id, "superseded" as const])) };
    const [waiting] = rowsOf(await tx.execute(sql`SELECT ${awaitingStart(sql`${product.id}::uuid`)} AS w`));
    if (waiting?.w === true) return { outcome: "busy" as const };
    const [openChunk] = await tx.select({ id: catalogChunks.id }).from(catalogChunks).where(and(eq(catalogChunks.batchId, batchId), sql`${catalogChunks.productIds} @> jsonb_build_array(${productId}::text)`, notInArray(catalogChunks.status, ["done", "failed"]))).limit(1);
    const [running] = await tx.select({ id: catalogImprovements.sourceImageId }).from(catalogImprovements).where(and(eq(catalogImprovements.batchId, batchId), eq(catalogImprovements.productId, productId), isNotNull(catalogImprovements.previous))).limit(1);
    const rows = await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batchId), eq(catalogOutputs.productId, productId))).orderBy(catalogOutputs.id).for("update");
    if (openChunk || running || rows.some(o => o.status === "pending")) return { outcome: "busy" as const };
    // Who owns a link is read from the live rows: a photo this last publisher left unchanged is still live under an earlier batch.
    const elsewhere = await tx.select({ channel: catalogOutputs.channel, n: catalogOutputs.n }).from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true), sql`${catalogOutputs.batchId} <> ${batchId}`));
    const taken = (o: Output) => elsewhere.some(l => l.channel === o.channel && l.n === o.n);
    const photos: Record<string, RecutOutcome> = {}, outputs: Output[] = [];
    for (const source of sources) {
      const mine = rows.filter(o => o.sourceImageId === source.id && batch.channels.includes(o.channel));
      const owned = mine.filter(o => recuttable(o) && !taken(o));
      photos[source.id] = owned.length ? "recutting" : mine.some(taken) ? "superseded" : "nothing_to_recut";
      outputs.push(...owned);
    }
    if (!outputs.length) return { outcome: Object.values(photos).includes("superseded") ? "superseded" as const : "nothing_to_recut" as const, photos };
    await lockProductChunks(tx as unknown as Db, batchId, productId);
    for (const o of outputs) {
      await tx.update(catalogOutputs).set({ status: "pending", decision: null, decidedBy: null, decidedAt: null, qaScores: null, compliance: { ok: true, failures: [], recut: true } as unknown as Output["compliance"], flags: o.flags.filter(f => !RECUT_DROPS_FLAGS.has(f)), reason: null, error: null, stagingUri: null, bytes: null, contentVersionId: null, updatedAt: now }).where(eq(catalogOutputs.id, o.id));
    }
    const recut = sources.filter(s => photos[s.id] === "recutting");
    for (const source of recut) {
      await tx.update(catalogSourceImages).set({ matteUri: null, matteModel: null, matteMs: null, status: "prepared", flags: source.flags.filter(f => !RECUT_DROPS_FLAGS.has(f)) }).where(eq(catalogSourceImages.id, source.id));
      await recordEvent(tx, { productId, batchId, kind: "photo_recut", actor: RECUT_ACTOR, details: { n: source.n, channels: outputs.filter(o => o.sourceImageId === source.id).map(o => o.channel) } });
    }
    // A re-cut follows today's rules: this batch is finished, so its kept copy of the rules no longer protects a running batch.
    await tx.update(catalogBatches).set({ options: { ...batch.options, autoDecide: await autoDecideSnapshot(tx as unknown as Db) } }).where(eq(catalogBatches.id, batchId));
    await tx.update(catalogProducts).set({ lockBatchId: batchId, updatedAt: now }).where(eq(catalogProducts.id, productId));
    const [index] = await tx.select({ value: sql<number>`coalesce(max(${catalogChunks.index}), -1) + 1` }).from(catalogChunks).where(eq(catalogChunks.batchId, batchId));
    const [chunk] = await tx.insert(catalogChunks).values({ batchId, index: Number(index!.value), stage: "matte", productIds: [productId], sourceImageIds: recut.map(s => s.id), status: "queued", attempt: 0, dispatchedAt: now }).returning();
    return { outcome: "recutting" as const, chunkId: chunk!.id, outputs: outputs.length, photos };
  });
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}
