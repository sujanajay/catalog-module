import { previewBatch } from "../../../../../../lib/catalog/preview";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
export const dynamic = "force-dynamic";
export function GET(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => previewBatch(await batchId(context))); }
