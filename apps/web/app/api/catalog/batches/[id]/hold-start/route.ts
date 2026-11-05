import { holdStart } from "../../../../../../lib/catalog/batches";
import { countTouch } from "../../../../../../lib/catalog/touches";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/**
 * M1-F2-R6 "Wait": the draft stops counting down and keeps its one Start button; a batch no longer a draft is 409. Each
 * Wait that stopped a countdown counts as an operator touch (M6-F3-R3; manager decision 2026-11-05, M1 D33).
 */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async () => {
    const id = await batchId(context);
    const result = await holdStart(id);
    await countTouch("hold_start", { batchId: id });
    return result;
  });
}
