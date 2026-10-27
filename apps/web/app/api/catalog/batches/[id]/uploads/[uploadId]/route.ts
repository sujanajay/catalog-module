import { removeInput } from "../../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, uploadIdOf, type BatchContext } from "../../../../../../../lib/catalog/api";
/** Remove a file input (spec 14b F3): the row becomes `removed`. Draft only. */
export function DELETE(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => removeInput(await batchId(context), await uploadIdOf(context), "uploads")); }
