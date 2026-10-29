import { and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages, catalogUploads, spendDays } from "../db/schema";
import { utcDay } from "../spend";
import { assertTestPrefix, batchPrefix, productPrefix } from "./naming";
import * as storage from "../storage";
/** Test namespaces only. Object and DB scope are both checked before any deletion. */
export async function cleanupTestBatch(db:Db,deps:Pick<typeof storage,"deleteTestObjects"|"getBucketName"|"getPublicBucketName">,batchId:string,now?:Date):Promise<CleanupResult> {
  return cleanupTestBatches(db,deps,[batchId],now);
}
/** `kept`: batches whose row stays (hidden, failed) because they spent money this UTC day. */
export type CleanupResult = { objects:number; kept:string[] };
export const CLEANED_UP_ERROR = "This test batch was cleaned up. Only its spend rows are kept.";
/**
 * Include both passes of an overwrite test so their shared products are cleaned together.
 * A batch with spend on the current UTC day keeps its row and its spend_days rows, so
 * DAILY_SPEND_CAP_USD still counts that spend; everything else of the batch is removed and the
 * row is marked `options.cleanedUp` (hidden from the batch list). Run cleanup again on a later
 * day to remove the row and its spend history.
 */
export async function cleanupTestBatches(db:Db,deps:Pick<typeof storage,"deleteTestObjects"|"getBucketName"|"getPublicBucketName">,batchIds:string[],now:Date=new Date(),options:{onListed?:(gsPrefixUri:string,count:number)=>void}={}):Promise<CleanupResult> {
  const wanted=[...new Set(batchIds)];
  if(!wanted.length) return {objects:0,kept:[]};
  const batches=await db.select().from(catalogBatches).where(inArray(catalogBatches.id,wanted));
  if(batches.length!==wanted.length || batches.some(b=>!b.isTest)) throw new Error("Cleanup is allowed only for catalog-test/ batches.");
  const prefixes=batches.map(b=>batchPrefix(b.brandSlug,b.id,true)+"/");
  prefixes.forEach(assertTestPrefix);
  const pairs=await db.select().from(catalogBatchProducts).where(inArray(catalogBatchProducts.batchId,wanted));
  const ids=[...new Set(pairs.map(s=>s.productId))];
  const products=ids.length ? await db.select().from(catalogProducts).where(inArray(catalogProducts.id,ids)):[];
  // A product shared with another batch cannot be erased by cleaning up this batch.
  for(const p of products) {
    if(!p.isTest) throw new Error("Cleanup cannot touch a production product.");
    const [shared]=await db.select({id:catalogSourceImages.id}).from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,p.id),notInArray(catalogSourceImages.batchId,wanted)));
    if(shared) throw new Error("This test product is shared with another batch. Clean the test run together.");
    const [sharedPair]=await db.select().from(catalogBatchProducts).where(and(eq(catalogBatchProducts.productId,p.id),notInArray(catalogBatchProducts.batchId,wanted)));
    if(sharedPair) throw new Error("This test product is shared with another batch. Clean the test run together.");
    assertTestPrefix(productPrefix(p.brandSlug,p.pathKey,true));
  }
  let objects=0;
  // Spec 18 H4: `onListed` reports each prefix's listed count before its deletes start.
  const remove=(uri:string)=>options.onListed ? deps.deleteTestObjects(uri,{onListed:count=>options.onListed!(uri,count)}):deps.deleteTestObjects(uri);
  for(const prefix of prefixes) objects+=await remove(storage.toGsUri(deps.getBucketName(),prefix));
  for(const p of products) objects+=await remove(storage.toGsUri(deps.getPublicBucketName(),productPrefix(p.brandSlug,p.pathKey,true)));
  let kept:string[]=[];
  await db.transaction(async tx=> {
    const spentToday=await tx.selectDistinct({batchId:spendDays.batchId}).from(spendDays).where(and(inArray(spendDays.batchId,wanted),eq(spendDays.day,utcDay(now)),gt(spendDays.costUsd,0)));
    kept=spentToday.map(r=>r.batchId);
    const removed=wanted.filter(id=>!kept.includes(id));
    await tx.delete(catalogOutputs).where(inArray(catalogOutputs.batchId,wanted));
    await tx.delete(catalogSourceImages).where(inArray(catalogSourceImages.batchId,wanted));
    if(ids.length) await tx.delete(catalogProducts).where(inArray(catalogProducts.id,ids));
    if(kept.length) {
      // The row stays only to anchor today's spend_days rows (batch_id is NOT NULL, no cascade).
      await tx.delete(catalogBatchProducts).where(inArray(catalogBatchProducts.batchId,kept));
      await tx.delete(catalogChunks).where(inArray(catalogChunks.batchId,kept));
      await tx.delete(catalogUploads).where(inArray(catalogUploads.batchId,kept));
      await tx.update(catalogBatches).set({status:"failed",error:CLEANED_UP_ERROR,options:sql`${catalogBatches.options} || '{"cleanedUp":true}'::jsonb`,updatedAt:now}).where(inArray(catalogBatches.id,kept));
    }
    if(removed.length) {
      await tx.delete(spendDays).where(inArray(spendDays.batchId,removed));
      await tx.delete(catalogBatches).where(inArray(catalogBatches.id,removed));
    }
  });
  return {objects,kept};
}
