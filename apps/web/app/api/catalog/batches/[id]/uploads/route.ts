import { planUploads } from "../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => planUploads(await batchId(context), await readJson(req))); }
