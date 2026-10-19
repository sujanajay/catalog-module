import { addLinks } from "../../../../../../lib/catalog/links";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => addLinks(await batchId(context), await readJson(req))); }
