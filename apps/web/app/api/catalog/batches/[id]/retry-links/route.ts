import { retryLinks } from "../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/** "Try the failed links again" (spec 14b F5 part 1): re-fetches only the links that failed. Draft or failed before Start. */
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => retryLinks(await batchId(context))); }
