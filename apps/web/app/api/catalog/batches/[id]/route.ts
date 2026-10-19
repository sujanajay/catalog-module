import { getBatch, patchBatch } from "../../../../../lib/catalog/batches";
import { batchId, catalogRoute, type BatchContext } from "../../../../../lib/catalog/api";
import { readJson } from "../../../../../lib/errors";
export const dynamic = "force-dynamic";
export function GET(req: Request, context: BatchContext) { return catalogRoute(req, "viewer", async () => getBatch(await batchId(context))); }
export function PATCH(req: Request, context: BatchContext) { return catalogRoute(req, "operator", async () => patchBatch(await batchId(context), await readJson(req))); }
