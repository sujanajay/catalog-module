import { completeUpload } from "../../../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../../../lib/catalog/api";
import { badRequest } from "../../../../../../../../lib/errors";
export function POST(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => { const { uploadId } = await context.params; if (!uploadId || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(uploadId)) throw badRequest("Choose the file again and retry the upload."); return completeUpload(await batchId(context), uploadId); }); }
