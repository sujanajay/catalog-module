import { and, eq, ne } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, catalogUploads } from "@catalog/core/db/schema";
import { lockProducts } from "@catalog/core/catalog/products";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { buildPreview } from "@catalog/core/catalog/ingest/index";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { chunkImages, dispatchChunks, recoverBatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { log } from "@catalog/core/log";
import { db } from "../db";
import { badRequest, HttpError } from "../errors";
import { queryBatch } from "./batches";

/** Chunk rows per insert at Start (7 bind parameters per row, Postgres allows 65,535). */
const START_INSERT_ROWS = 1000;
const STALE_PREVIEW = "Files changed since the preview. Open step 4 again.";
export async function startBatch(id: string, value: unknown, _actor: string) {
  const previewAt = (value as { previewAt?: unknown })?.previewAt;
  if (typeof previewAt !== "string" || !Number.isFinite(Date.parse(previewAt))) throw badRequest(STALE_PREVIEW);
  const batch = await queryBatch(id);
  if (batch.status === "failed" && batch.counts.failReason?.startsWith("No photos were found")) throw badRequest(batch.counts.failReason);
  if (["matting", "rendering", "publishing"].includes(batch.status)) {
    // Spec 15 E4: a second press runs the sweep's rules for this batch (recover dead chunks, top up the window)
    // instead of queueing every queued chunk again.
    await recoverBatchChunks(db(), enqueueTask, id);
    return { id, status: batch.status };
  }
  if (batch.status !== "draft") throw new HttpError(409, "This batch has already started. Open its progress page.");
  if (!batch.channels.length) throw badRequest("Choose at least one marketplace before starting.");
  if (!batch.counts.previewReady || batch.updatedAt.getTime() > Date.parse(previewAt)) throw new HttpError(409, STALE_PREVIEW);
  const uploads = await db().select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
  if (uploads.some((u) => u.status === "pending" || u.status === "uploaded" || (typeof u.detected?.completedAt === "string" && Date.parse(u.detected.completedAt) > Date.parse(previewAt)))) throw new HttpError(409, STALE_PREVIEW);
  const sources = await db().select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, id));
  if (!sources.length) {
    const detail = uploads.map((u) => u.error).filter(Boolean).join(" ");
    const sentence = `No photos were found in what you uploaded.${detail ? ` ${detail}` : " Upload photos and start again."}`;
    await db().update(catalogBatches).set({ status: "failed", counts: { ...batch.counts, failReason: sentence }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
    // An operator upload with nothing usable: WARNING, so it sends no alert and stays out of Error Reporting.
    log("WARNING", "batch failed", { batchId: id, brandSlug: batch.brandSlug, reason: sentence, cause: "no_photos" });
    throw badRequest(sentence);
  }
  const preview = await buildPreview(db(), id, { storage });
  if (preview.overwrite.duplicates.length) {
    const pair = preview.overwrite.duplicates[0]!;
    throw new HttpError(409, `${pair.a} and ${pair.b} are the same product. Keep one.`);
  }
  const products = await db().select({ id: catalogProducts.id, identifier: catalogProducts.identifier }).from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, id));
  // Source ids by product, built once (a 7,000-product batch has about 28,000 photos).
  const sourceIds = new Map<string, string[]>();
  for (const s of sources) { const ids = sourceIds.get(s.productId); if (ids) ids.push(s.id); else sourceIds.set(s.productId, [s.id]); }
  const plans = planChunks(products.filter((p) => sourceIds.has(p.id)).map((p) => ({productId:p.id,identifier:p.identifier,sourceCount:sourceIds.get(p.id)!.length})), chunkImages());
  const chunks = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, id)).for("update");
    if (!current || current.status !== "draft" || !current.counts.previewReady || current.updatedAt.getTime() !== batch.updatedAt.getTime()) throw new HttpError(409, STALE_PREVIEW);
    const locked = await lockProducts(tx as unknown as ReturnType<typeof db>, id, products.map((p) => p.id));
    if (!locked.ok) {
      const first = locked.busy[0]!;
      throw new HttpError(409, `${first.identifier}${locked.busy.length > 1 ? ` and ${locked.busy.length-1} others are` : " is"} still being processed in batch ${first.batchName}. Wait for it to finish or remove them from this upload.`);
    }
    // Spec 16: chunk rows in a few big inserts, so a 7,000-product Start stays well inside the web request limit.
    // Slices of 1,000 rows keep each insert under Postgres's 65,535 bind parameters (7 per row).
    const values = plans.map((plan, index) => ({batchId:id,index,stage:"matte" as const,status:"queued" as const,attempt:0,productIds:plan.productIds,sourceImageIds:plan.productIds.flatMap((p)=>sourceIds.get(p) ?? [])}));
    const rows = [];
    for (let at = 0; at < values.length; at += START_INSERT_ROWS) rows.push(...await tx.insert(catalogChunks).values(values.slice(at, at + START_INSERT_ROWS)).returning());
    await tx.update(catalogBatches).set({status:"matting",startedAt:new Date(),updatedAt:new Date(),counts:{...current.counts,products:products.length,sources:sources.length,outputs:sources.length*batch.channels.length,newProducts:preview.overwrite.newProducts,existingProducts:preview.overwrite.existingProducts.length,shotsToRemove:preview.overwrite.existingProducts.reduce((n,p)=>n+p.shotsToRemove.length,0)}}).where(eq(catalogBatches.id,id));
    return rows;
  });
  // Spec 15 E5: only the batch's window of chunks is queued now; each finished chunk queues the next.
  await dispatchChunks(db(), enqueueTask, id);
  log("INFO", "batch started", { batchId: id, brandSlug: batch.brandSlug, products: products.length, sources: sources.length, outputs: sources.length * batch.channels.length, chunks: chunks.length, channels: batch.channels });
  return { id, status: "matting" };
}
