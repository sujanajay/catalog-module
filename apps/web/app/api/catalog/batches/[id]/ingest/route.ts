import { countTouch } from "../../../../../../lib/catalog/touches";
import { handOffIngest } from "../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/**
 * Continue (a draft's hand-off, also after Back or Check again while collecting) and "Try again" on a collecting batch
 * that stalled (RetryCollectButton). Only Try again on a stalled run is an operator touch (M6-F3-R3, review P2-3).
 */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async () => {
    const id = await batchId(context);
    const { answer, stalledRetry } = await handOffIngest(id);
    if (stalledRetry) await countTouch("retry_collect", { batchId: id });
    return answer;
  });
}
