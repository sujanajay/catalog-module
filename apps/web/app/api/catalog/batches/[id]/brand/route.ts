import { changeBrand } from "../../../../../../lib/catalog/intake-defaults";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";
/** M1 D14: change the brand of a draft before it starts; its files are grouped again and its channels re-derived. */
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => changeBrand(await batchId(context), await readJson(req))); }
