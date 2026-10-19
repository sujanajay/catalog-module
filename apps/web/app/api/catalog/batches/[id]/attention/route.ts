import { batchAttention } from "../../../../../../lib/catalog/products";
import { evalOutputs } from "../../../../../../lib/catalog/eval";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";

/** The problem photos by product; with `?eval=1` every output of an eval batch, paged (spec 07 4.7, 4.10). */
export function GET(req: Request, context: BatchContext) {
  return catalogRoute(req, "viewer", async () => {
    const id = await batchId(context);
    const q = new URL(req.url).searchParams;
    if (q.get("eval") === "1") return evalOutputs(id, { page: Number(q.get("page") ?? 0) || 0, channel: q.get("channel") ?? "", verdict: q.get("verdict") ?? "" });
    return batchAttention(id);
  });
}
