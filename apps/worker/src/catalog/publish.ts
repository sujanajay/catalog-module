import { publishProduct } from "@catalog/core/catalog/pipeline/publish";
import { recordCostEvent } from "@catalog/core/cost-events";
import type { HandleResult } from "../server";
import { enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";
export async function handlePublishTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if (typeof body.batchId!=="string" || typeof body.productId!=="string") return {httpStatus:400,outcome:"batchId and productId are required"};
  const batchId=body.batchId, productId=body.productId, started=+deps.now();
  // Ledger: one timed publish row per product (usd 0), written as soon as publishProduct returns, so a later
  // failure (progress refresh, finalize enqueue) cannot add a "failed" row beside it before the retry's own row.
  // recordCostEvent logs a failing write itself and never throws.
  try {
    const {batch,...result} = await publishProduct(deps,batchId,productId);
    if(batch) await recordCostEvent(deps.db,{batchId,brandSlug:batch.brandSlug,isTest:batch.isTest,productId,stage:"publish",kind:"compute",engine:"worker",ms:+deps.now()-started,usd:0,outcome:"ok",at:deps.now()},deps.log);
    if(result.outcome!=="not_locked") {
      await refreshBatchProgress(deps.db,batchId); await enqueueFinalize(deps,batchId);
      // outcome: published, held, failed (some outputs did not publish) or not_found.
      deps.log("product published",{batchId,productId,outcome:result.outcome,durationMs:+deps.now()-started});
    }
    return {httpStatus:200,...result};
  }
  catch(error) { deps.log("publish failed",{severity:"WARNING",batchId,productId,durationMs:+deps.now()-started,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
}
