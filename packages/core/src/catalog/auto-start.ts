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
/**
 * M1-F2-R7: a batch whose products another running batch holds tries again after this, doubling each time up to
 * AUTO_START_BUSY_MAX_SEC, until the lock frees (M1 D21). The cap keeps a long wait to about 4 tasks an hour.
 */
export const AUTO_START_BUSY_RETRY_SEC = 60;
export const AUTO_START_BUSY_MAX_SEC = 900;
/** A wait for locked products longer than this is logged as a WARNING (once per retry past it). */
export const AUTO_START_BUSY_WARN_MS = 60 * 60 * 1000;
/** The delay of busy retry number `retries` (0 for the first). */
export function busyRetryDelaySec(retries: number): number {
  return Math.min(AUTO_START_BUSY_MAX_SEC, AUTO_START_BUSY_RETRY_SEC * 2 ** Math.max(0, Math.min(retries, 10)));
}
export const AUTO_START_ROUTE = "/tasks/catalog/auto-start" as const;

/** `busyRetries` and `busySince` (ISO): set on the retries of a batch waiting for locked products (R7). */
export interface AutoStartBody { batchId: string; at: string; busyRetries?: number; busySince?: string }

/**
 * Arms the countdown of a draft made with `autoStart`, once its collection and grouping are done (`previewReady`):
 * writes `counts.autoStartAt` (when it starts) and queues the auto-start task to run then. Each arming has its own
 * task id; a task whose `at` is no longer the batch's is a no-op, so dropping more files restarts the countdown.
 * Returns the time armed, or null when the batch does not auto-start.
 */
export async function armAutoStart(db: Db, enqueue: typeof enqueueTask, batchId: string, delaySec = AUTO_START_DELAY_SEC, now = new Date(), busy?: { busyRetries: number; busySince: string }): Promise<string | null> {
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
  const body: AutoStartBody = { batchId, at, ...busy };
  try {
    await enqueue(AUTO_START_ROUTE, { ...body }, { delaySec, taskId: `auto-start-${batchId}-${Date.parse(at)}` });
  } catch (err) {
    // No task runs this countdown: clear it, so the page shows the Start button instead of a countdown stuck at 1 s.
    await db.update(catalogBatches).set({ counts: mergeCounts({ autoStartAt: null }) })
      .where(and(eq(catalogBatches.id, batchId), sql`${catalogBatches.counts}->>'autoStartAt' = ${at}`));
    log("WARNING", "auto-start could not be queued", { batchId, at, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  log("INFO", "auto-start armed", { batchId, at });
  return at;
}

/**
 * M1-F2-R6 "Wait": the draft no longer starts by itself; the operator presses Start. Clears the countdown. False when
 * the batch is not a draft (it may have started a moment before). It takes the batch row lock that Start's
 * transaction takes, so Wait and an auto-start never interleave: either the start committed first (false here), or
 * the start sees autoStart off under its lock and does not start (startDraftBatch's auto-start guard).
 * `stopped` is true only when this Wait turned auto-start off or cleared a countdown, read under that lock: a second
 * Wait, or a Wait on a draft that never counted down, stops nothing (one operator touch per real decision, M1 D33).
 */
export async function holdAutoStart(db: Db, batchId: string): Promise<{ held: boolean; stopped: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ status: catalogBatches.status, options: catalogBatches.options, counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, batchId)).for("update");
    if (row?.status !== "draft") return { held: false, stopped: false };
    const stopped = row.options.autoStart === true || row.counts.autoStartAt != null;
    if (!stopped) return { held: true, stopped: false };
    await tx.update(catalogBatches)
      .set({
        options: sql`${catalogBatches.options} || '{"autoStart": false}'::jsonb`,
        counts: mergeCounts({ autoStartAt: null }),
      })
      .where(eq(catalogBatches.id, batchId));
    return { held: true, stopped: true };
  });
}
