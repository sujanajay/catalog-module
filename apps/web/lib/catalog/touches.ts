// M6-S6 (M6-F3-R3): the operator touch counter. A route whose write means a person had to step in (a decision, a retry,
// Fix and continue, a cancel, Add SKU ids) calls countTouch after its write succeeded. The wizard's own path (create,
// add inputs, Continue, review, Start) does not; test/catalog-touches.test.ts holds every operator write route to one
// of the two lists. A touch that cannot be written is logged and never fails the operator's request.
import type { TouchAction } from "@catalog/core/db/schema";
import { recordTouch } from "@catalog/core/catalog/reliability";
import { log } from "@catalog/core/log";
import { db } from "../db";

export async function countTouch(action: TouchAction, target: { batchId: string } | { outputId: string }): Promise<void> {
  try {
    await recordTouch(db(), { action, ...target });
  } catch (error) {
    log("WARNING", "operator touch not recorded", { action, ...target, error: error instanceof Error ? error.message : String(error) });
  }
}
