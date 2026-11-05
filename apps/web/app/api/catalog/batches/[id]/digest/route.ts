import { batchDigest } from "../../../../../../lib/catalog/digest";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
export const dynamic = "force-dynamic";
/** M1-F4-R1: the batch digest JSON, read from catalog_batches.digest alone (M1-F4-R6). Viewer. */
export function GET(req: Request, context: BatchContext) { return catalogRoute(req, "viewer", async () => batchDigest(await batchId(context))); }
