import { detectedBatch, patchDetected } from "../../../../../../lib/catalog/preview";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";
export const dynamic = "force-dynamic";
export function GET(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => detectedBatch(await batchId(context))); }
export function PATCH(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => patchDetected(await batchId(context), await readJson(req))); }
