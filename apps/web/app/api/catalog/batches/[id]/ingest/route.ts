import { ingestBatch } from "../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => ingestBatch(await batchId(context))); }
