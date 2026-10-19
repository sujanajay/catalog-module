import { startBatch } from "../../../../../../lib/catalog/start";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async (user) => startBatch(await batchId(context), await readJson(req), user.email));
}
