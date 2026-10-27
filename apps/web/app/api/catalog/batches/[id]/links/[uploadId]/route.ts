import { replaceLinks } from "../../../../../../../lib/catalog/links";
import { removeInput } from "../../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, uploadIdOf, type BatchContext } from "../../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../../lib/errors";
/** Replace a paste or a Google link in place with `{text}` (spec 14b F3). Draft only. */
export function PATCH(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => { const id = await batchId(context); const uploadId = await uploadIdOf(context); return replaceLinks(id, uploadId, await readJson(req)); }); }
/** Remove a paste or a Google link (spec 14b F3): the row becomes `removed`. Draft only. */
export function DELETE(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => removeInput(await batchId(context), await uploadIdOf(context), "links")); }
