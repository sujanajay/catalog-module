import { cancelBatch } from "../../../../../../lib/catalog/batches";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/** Cancel (spec 14c F4 part 2): a draft, collecting or failed-before-Start batch becomes cancelled; a started one is 409. */
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => cancelBatch(await batchId(context))); }
