import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { catalogBatches, type CatalogBatch } from "../../db/schema";
import type { Db } from "../../db/client";
import { mergeCounts } from "../counts";
import { log } from "../../log";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Why an input change was refused: the batch does not exist, or it is past the point where inputs can change. */
export type InputChangeRefused = { refused: "missing" } | { refused: "closed"; batch: CatalogBatch };

/**
 * M1 D23 (M1-S6, review P1-1): the batch row of an input change (add, complete, correct or remove an input), locked
 * for the rest of the transaction. A draft or a collecting batch that never started takes the change; anything else
 * is refused.
 *
 * The change never touches a placing lease, the run or the status: a batch-wide step in flight keeps running alone.
 * It only writes a new change marker (`inputsChangedAt`) and clears `previewReady` and the countdown. The step
 * recorded the marker it grouped with at its claim (`groupedChange`), so its closing write is refused when they
 * differ, and it releases the lease and queues a regroup instead (ingest `inputsChanged`). The regroup's groupBatch
 * removes the rows the step wrote and groups again with the inputs as they are then, so a removed input is never
 * placed, rendered or published. The claim takes this same row lock, so a change is either seen by the claim's
 * uploads check or caught at the close.
 */
export async function lockForInputChange(tx: Tx, id: string): Promise<{ batch: CatalogBatch } | InputChangeRefused> {
  const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, id)).for("update");
  if (!batch) return { refused: "missing" };
  if (batch.status !== "draft" && (batch.status !== "ingesting" || batch.startedAt)) return { refused: "closed", batch };
  // A draft has no step in flight: it is returned as it is, and the route clears previewReady when its change needs it.
  if (batch.status === "draft") return { batch };
  const [changed] = await tx.update(catalogBatches)
    .set({ counts: mergeCounts({ inputsChangedAt: randomUUID(), previewReady: false, autoStartAt: null }), updatedAt: new Date() })
    .where(eq(catalogBatches.id, id)).returning();
  log("INFO", "input changed while collecting: grouping again with the change", { batchId: id });
  return { batch: changed! };
}
