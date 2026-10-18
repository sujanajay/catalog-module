import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogSourceImages, spendDays } from "../db/schema";
import { assertTestPrefix, batchPrefix, productPrefix } from "./naming";
import * as storage from "../storage";
/** Test namespaces only. Object and DB scope are both checked before any deletion. */
export async function cleanupTestBatch(db:Db,deps:Pick<typeof storage,"deleteTestObjects"|"getBucketName"|"getPublicBucketName">,batchId:string):Promise<{objects:number}> {
  return cleanupTestBatches(db,deps,[batchId]);
}
/** Include both passes of an overwrite test so their shared products are cleaned together. */
export async function cleanupTestBatches(db:Db,deps:Pick<typeof storage,"deleteTestObjects"|"getBucketName"|"getPublicBucketName">,batchIds:string[]):Promise<{objects:number}> {
  const wanted=[...new Set(batchIds)];
  if(!wanted.length) return {objects:0};
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
  for(const prefix of prefixes) objects+=await deps.deleteTestObjects(storage.toGsUri(deps.getBucketName(),prefix));
  for(const p of products) objects+=await deps.deleteTestObjects(storage.toGsUri(deps.getPublicBucketName(),productPrefix(p.brandSlug,p.pathKey,true)));
  await db.transaction(async tx=> {
    await tx.delete(catalogOutputs).where(inArray(catalogOutputs.batchId,wanted));
    await tx.delete(catalogSourceImages).where(inArray(catalogSourceImages.batchId,wanted));
    if(ids.length) await tx.delete(catalogProducts).where(inArray(catalogProducts.id,ids));
    await tx.delete(spendDays).where(inArray(spendDays.batchId,wanted));
    await tx.delete(catalogBatches).where(inArray(catalogBatches.id,wanted));
  });
  return {objects};
}
