// M1 D41: cut one photo out again after the matte guard changed, so a bad image already delivered is replaced at the same
// public URL. A new batch cannot do it: the render key skips a live output whose source is unchanged and the stored matte
// is used again. recutPhoto resets the photo's outputs in the batch that owns them and queues a one-photo matte chunk; the
// normal pipeline then cuts, renders, judges and publishes. The publish keeps the worker's rule: planPublish asserts the
// held product's prefix (assertWithinProduct) and the batch's channels, and writes only with ifGenerationMatch. The old
// object stays live until the new image is copied over it; a result held for a person, or left out, takes the old image
// down (planPublish `removes`), so the bad image never stays online.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "../db/schema";
import { autoDecideOf, autoDecideSnapshot, heldForPerson } from "./auto-decide";
import { laterPublisher } from "./decisions";
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
 * What one re-cut did. `recutting`: a one-photo chunk is queued. `busy`: another batch holds the product, or a draft is
 * about to take it. `superseded`: a later batch published this photo's place, so this batch no longer owns the link.
 * `not_done`: the batch is still running or stopped.
 */
export type RecutOutcome = "recutting" | "busy" | "superseded" | "not_done" | "nothing_to_recut";

/** A slot this batch delivered or holds back: a decision a person made and a slot never delivered stay as they are. */
const recuttable = (o: Output) => (o.decision === null || o.decision === "use_as_is") && (o.isLive || heldForPerson(o));

/** The marker the matte stage reads: this photo's stored matte is the one being replaced (chunk.ts). */
export function recutRequested(compliance: unknown): boolean {
  return (compliance as { recut?: unknown } | null | undefined)?.recut === true;
}

export async function recutPhoto(db: Db, input: { batchId: string; sourceImageId: string; now: Date }): Promise<{ outcome: RecutOutcome; chunkId?: string; outputs?: number }> {
  const { batchId, sourceImageId, now } = input;
  return db.transaction(async tx => {
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)).for("update");
    if (!batch || batch.status !== "done" || !autoDecideOf(batch.options)) return { outcome: "not_done" as const };
    const [source] = await tx.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.id, sourceImageId), eq(catalogSourceImages.batchId, batchId)));
    if (!source) return { outcome: "nothing_to_recut" as const };
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, source.productId)).for("update");
    if (!product) return { outcome: "nothing_to_recut" as const };
    if (product.lockBatchId && product.lockBatchId !== batchId) return { outcome: "busy" as const };
    const [waiting] = rowsOf(await tx.execute(sql`SELECT ${awaitingStart(sql`${product.id}::uuid`)} AS w`));
    if (waiting?.w === true) return { outcome: "busy" as const };
    if (await laterPublisher(tx, product, batchId, source.n)) return { outcome: "superseded" as const };
    // Only the slots this batch owns, only on its channels.
    const outputs = (await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batchId), eq(catalogOutputs.sourceImageId, sourceImageId))).orderBy(catalogOutputs.id).for("update"))
      .filter(o => batch.channels.includes(o.channel) && recuttable(o));
    if (!outputs.length) return { outcome: "nothing_to_recut" as const };
    await lockProductChunks(tx as unknown as Db, batchId, source.productId);
    for (const o of outputs) {
      await tx.update(catalogOutputs).set({ status: "pending", decision: null, decidedBy: null, decidedAt: null, qaScores: null, compliance: { ok: true, failures: [], recut: true } as unknown as Output["compliance"], flags: o.flags.filter(f => !RECUT_DROPS_FLAGS.has(f)), reason: null, error: null, stagingUri: null, bytes: null, contentVersionId: null, updatedAt: now }).where(eq(catalogOutputs.id, o.id));
    }
    await tx.update(catalogSourceImages).set({ matteUri: null, matteModel: null, matteMs: null, status: "prepared", flags: source.flags.filter(f => !RECUT_DROPS_FLAGS.has(f)) }).where(eq(catalogSourceImages.id, sourceImageId));
    // A re-cut follows today's rules: this batch is finished, so its kept copy of the rules no longer protects a running batch.
    await tx.update(catalogBatches).set({ options: { ...batch.options, autoDecide: await autoDecideSnapshot(tx as unknown as Db) } }).where(eq(catalogBatches.id, batchId));
    await tx.update(catalogProducts).set({ lockBatchId: batchId, updatedAt: now }).where(eq(catalogProducts.id, source.productId));
    const [index] = await tx.select({ value: sql<number>`coalesce(max(${catalogChunks.index}), -1) + 1` }).from(catalogChunks).where(eq(catalogChunks.batchId, batchId));
    const [chunk] = await tx.insert(catalogChunks).values({ batchId, index: Number(index!.value), stage: "matte", productIds: [source.productId], sourceImageIds: [sourceImageId], status: "queued", attempt: 0, dispatchedAt: now }).returning();
    await recordEvent(tx, { productId: source.productId, batchId, kind: "photo_recut", actor: RECUT_ACTOR, details: { n: source.n, channels: outputs.map(o => o.channel) } });
    return { outcome: "recutting" as const, chunkId: chunk!.id, outputs: outputs.length };
  });
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}
