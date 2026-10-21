import { publishProduct } from "@catalog/core/catalog/pipeline/publish";
import type { HandleResult } from "../server";
import { enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";
export async function handlePublishTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if (typeof body.batchId!=="string" || typeof body.productId!=="string") return {httpStatus:400,outcome:"batchId and productId are required"};
  const started=+deps.now();
  try {
    const result = await publishProduct(deps,body.batchId,body.productId);
    if(result.outcome!=="not_locked") {
      await refreshBatchProgress(deps.db,body.batchId); await enqueueFinalize(deps,body.batchId);
      // outcome: published, held, failed (some outputs did not publish) or not_found.
      deps.log("product published",{batchId:body.batchId,productId:body.productId,outcome:result.outcome,durationMs:+deps.now()-started});
    }
    return {httpStatus:200,...result};
  }
  catch(error) { deps.log("publish failed",{severity:"WARNING",batchId:body.batchId,productId:body.productId,durationMs:+deps.now()-started,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
}
