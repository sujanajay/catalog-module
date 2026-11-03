import { publishProduct } from "@catalog/core/catalog/pipeline/publish";
import { recordCostEvent } from "@catalog/core/cost-events";
import { deliveryUsd } from "../delivery-cost";
import type { HandleResult } from "../server";
import { enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";
export async function handlePublishTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if (typeof body.batchId!=="string" || typeof body.productId!=="string") return {httpStatus:400,outcome:"batchId and productId are required"};
  const batchId=body.batchId, productId=body.productId, started=+deps.now();
  // Ledger: one timed publish row per product (usd 0), written as soon as publishProduct returns, so a later
  // failure (progress refresh, finalize enqueue) cannot add a "failed" row beside it before the retry's own row.
  // recordCostEvent logs a failing write itself and never throws.
  try {
    const {batch,changed,...result} = await publishProduct(deps,batchId,productId);
    // M6-F1-R2: the publish delivery's wall time, priced like every other worker delivery.
    if(batch) { const ms=+deps.now()-started; await recordCostEvent(deps.db,{batchId,brandSlug:batch.brandSlug,isTest:batch.isTest,productId,stage:"publish",kind:"compute",engine:"worker",ms,billableMs:ms,usd:deliveryUsd(ms),outcome:"ok",at:deps.now()},deps.log); }
    if(result.outcome!=="not_locked") {
      // Spec 18 H4: a done batch is re-opened (one fresh links sheet) only by an operator's decision or a delivery
      // that changed this product's content (`changed`: not unchanged, not failed); a repeated, unchanged or failed
      // pipeline delivery queues no finalize for a done batch.
      await refreshBatchProgress(deps.db,batchId,deps.now()); await enqueueFinalize(deps,batchId,undefined,{reopen:typeof body.trigger==="string" || changed===true});
      // outcome: published, held, failed (some outputs did not publish) or not_found.
      deps.log("product published",{batchId,productId,outcome:result.outcome,durationMs:+deps.now()-started});
    }
    return {httpStatus:200,...result};
  }
  catch(error) { deps.log("publish failed",{severity:"WARNING",batchId,productId,durationMs:+deps.now()-started,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
}
