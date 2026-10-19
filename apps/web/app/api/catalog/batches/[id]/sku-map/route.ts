import { addSkuMap, SKU_MAP_MAX_BYTES, SKU_MAP_TOO_LARGE } from "../../../../../../lib/catalog/sku-map";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { badRequest } from "../../../../../../lib/errors";

/** "Add Opptra SKU ids": one xlsx or csv mapping sheet as multipart field `file` (spec 07 4.9). Operator. */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async (user) => {
    const id = await batchId(context);
    // Refuse an oversized body before it is buffered (the multipart wrapper adds a little).
    if (Number(req.headers.get("content-length") ?? 0) > SKU_MAP_MAX_BYTES + 64 * 1024) throw badRequest(SKU_MAP_TOO_LARGE);
    const file = (await req.formData().catch(() => null))?.get("file");
    if (!(file instanceof File)) throw badRequest("Choose an xlsx or csv mapping sheet.");
    return addSkuMap(id, file, user.email);
  });
}
