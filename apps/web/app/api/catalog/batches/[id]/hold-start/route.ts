import { holdStart } from "../../../../../../lib/catalog/batches";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/** M1-F2-R6 "Wait": the draft stops counting down and keeps its one Start button; a batch no longer a draft is 409. */
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => holdStart(await batchId(context))); }
