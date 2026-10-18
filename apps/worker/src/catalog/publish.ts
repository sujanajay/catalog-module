import { publishProduct } from "@catalog/core/catalog/pipeline/publish";
import type { HandleResult } from "../server";
import { enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";
export async function handlePublishTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if (typeof body.batchId!=="string" || typeof body.productId!=="string") return {httpStatus:400,outcome:"batchId and productId are required"};
  try { const result = await publishProduct(deps,body.batchId,body.productId); if(result.outcome!=="not_locked") { await refreshBatchProgress(deps.db,body.batchId); await enqueueFinalize(deps,body.batchId); } return {httpStatus:200,...result}; }
  catch(error) { deps.log("publish failed",{batchId:body.batchId,productId:body.productId,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
}
