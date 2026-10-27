import { reopenBatch } from "../../../../../../lib/catalog/batches";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/**
 * "Fix and continue" (spec 14c F8): a batch that failed before Start returns to draft with its inputs; a
 * started one is 409. The answer carries the reason it failed with (kept as `counts.fixReason`), which
 * step 1 shows above the inputs.
 */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async () => {
    const batch = await reopenBatch(await batchId(context));
    return { id: batch.id, status: batch.status, failReason: batch.counts.fixReason ?? null };
  });
}
