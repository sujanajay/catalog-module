import { eq } from "drizzle-orm";
import { catalogBatches } from "@catalog/core/db/schema";
import { db } from "../../../../../../lib/db";
import { countTouch } from "../../../../../../lib/catalog/touches";
import { ingestBatch } from "../../../../../../lib/catalog/uploads";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/**
 * Continue (a draft's first hand-off) and "Try again" on a collecting batch that stalled (RetryCollectButton). Only the
 * second is an operator touch (M6-F3-R3): the batch was already collecting when it was pressed.
 */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async () => {
    const id = await batchId(context);
    const [before] = await db().select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, id));
    const result = await ingestBatch(id);
    if (before?.status === "ingesting") await countTouch("retry_collect", { batchId: id });
    return result;
  });
}
