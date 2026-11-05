import { followUpBatch } from "@catalog/core/catalog/follow-up";
import { db } from "../../../../../../lib/db";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
/**
 * M1-F5-R2 (M1-S6): more photos for a batch that has already started. Answers the linked follow-up batch (the one the
 * operator already has open, else a new one: same brand, channels and grouping, starts by itself once collected);
 * the page then opens it on the New batch page. A batch that has not started is 409: its own page takes the photos.
 */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async (user) => followUpBatch(db(), await batchId(context), user.email));
}
