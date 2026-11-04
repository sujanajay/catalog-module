// M1-F2-R6 (M1-S2): a batch made on the one-page New batch starts by itself 10 s after collection and grouping end.
// The countdown runs on the server, so the operator can close the tab (R8): the end of collection arms it (writes
// `counts.autoStartAt` and queues the auto-start task with that delay); the task starts the batch only when the draft
// is still the one it armed. "Wait" (hold-start) turns auto-start off for the batch and leaves its one Start button.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches } from "../db/schema";
import type { enqueueTask } from "../tasks";
import { mergeCounts } from "./counts";
import { log } from "../log";

/** M1-F2-R6: the countdown, in seconds (an M12 admin setting, 0-60, once that store exists; M1 D2). */
export const AUTO_START_DELAY_SEC = 10;
/** M1-F2-R7: a batch whose products another running batch holds tries again this often until the lock frees. */
export const AUTO_START_BUSY_RETRY_SEC = 60;
export const AUTO_START_ROUTE = "/tasks/catalog/auto-start" as const;

export interface AutoStartBody { batchId: string; at: string }

/**
 * Arms the countdown of a draft made with `autoStart`, once its collection and grouping are done (`previewReady`):
 * writes `counts.autoStartAt` (when it starts) and queues the auto-start task to run then. Each arming has its own
 * task id; a task whose `at` is no longer the batch's is a no-op, so dropping more files restarts the countdown.
 * Returns the time armed, or null when the batch does not auto-start.
 */
export async function armAutoStart(db: Db, enqueue: typeof enqueueTask, batchId: string, delaySec = AUTO_START_DELAY_SEC, now = new Date()): Promise<string | null> {
  const at = new Date(now.getTime() + delaySec * 1000).toISOString();
  const rows = await db.update(catalogBatches)
    .set({ counts: mergeCounts({ autoStartAt: at }) })
    .where(and(
      eq(catalogBatches.id, batchId), eq(catalogBatches.status, "draft"),
      sql`(${catalogBatches.options}->>'autoStart')::boolean is true`,
      sql`(${catalogBatches.counts}->>'previewReady')::boolean is true`,
    ))
    .returning({ id: catalogBatches.id });
  if (!rows.length) return null;
  const body: AutoStartBody = { batchId, at };
  await enqueue(AUTO_START_ROUTE, { ...body }, { delaySec, taskId: `auto-start-${batchId}-${Date.parse(at)}` });
  log("INFO", "auto-start armed", { batchId, at });
  return at;
}

/**
 * M1-F2-R6 "Wait": the draft no longer starts by itself; the operator presses Start. Clears the countdown. False when
 * the batch is not a draft (it may have started a moment before).
 */
export async function holdAutoStart(db: Db, batchId: string): Promise<boolean> {
  const rows = await db.update(catalogBatches)
    .set({
      options: sql`${catalogBatches.options} || '{"autoStart": false}'::jsonb`,
      counts: mergeCounts({ autoStartAt: null }),
    })
    .where(and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "draft")))
    .returning({ id: catalogBatches.id });
  return rows.length > 0;
}
