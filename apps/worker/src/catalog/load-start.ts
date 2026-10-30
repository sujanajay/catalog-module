// "Start processing" for the catalog-load driver (catalog-load.ts), as the web's start route does it
// (apps/web/lib/catalog/start.ts): lock the products, plan the chunks, pin the batch's enlargement route, queue the
// matte stage. Its own module so a test can run it (catalog-load.ts runs its main on import).
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogSourceImages } from "@catalog/core/db/schema";
import { lockProducts } from "@catalog/core/catalog/products";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { chunkImages, dispatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { startedBatchOptions } from "@catalog/core/catalog/pipeline/enlargement";
import { enqueueTask } from "@catalog/core/tasks";

export interface LoadStartDeps { enqueue?: typeof enqueueTask; env?: NodeJS.ProcessEnv }

export async function startLoadBatch(db: Db, batchId: string, deps: LoadStartDeps = {}): Promise<{ chunks: number; sources: number }> {
  const sources = await db.select({ id: catalogSourceImages.id, productId: catalogSourceImages.productId }).from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId));
  const productIds = (await db.select({ id: catalogBatchProducts.productId }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId))).map(p => p.id);
  const withPhotos = productIds.filter(id => sources.some(s => s.productId === id));
  const plans = planChunks(withPhotos.map(productId => ({ productId, sourceCount: sources.filter(s => s.productId === productId).length })), chunkImages());
  const chunks = await db.transaction(async tx => {
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)).for("update");
    if (!batch) throw new Error(`Batch ${batchId} not found.`);
    const locked = await lockProducts(tx as unknown as Db, batchId, productIds);
    if (!locked.ok) throw new Error(`${locked.busy.length} products are locked by another batch.`);
    const rows = [];
    for (const [index, plan] of plans.entries()) {
      const [chunk] = await tx.insert(catalogChunks).values({ batchId, index, stage: "matte", status: "queued", attempt: 0, productIds: plan.productIds, sourceImageIds: sources.filter(s => plan.productIds.includes(s.productId)).map(s => s.id) }).returning();
      rows.push(chunk!);
    }
    // Spec 18: pinned exactly as the web's Start pins it, so a load batch has the enlargement stage when the upscaler is on.
    await tx.update(catalogBatches).set({ status: "matting", startedAt: new Date(), updatedAt: new Date(), options: startedBatchOptions(batch.options, deps.env), counts: { ...batch.counts, products: productIds.length, sources: sources.length, outputs: sources.length * batch.channels.length } }).where(eq(catalogBatches.id, batchId));
    return rows;
  });
  // Spec 15 E5: the window queues the first chunks; each finished chunk queues the next.
  await dispatchChunks(db, deps.enqueue ?? enqueueTask, batchId);
  return { chunks: chunks.length, sources: sources.length };
}
