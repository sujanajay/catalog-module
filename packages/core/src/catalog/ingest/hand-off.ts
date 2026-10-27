// Paged hand-off (spec 14d F11 part 2): the web request hands at most HAND_OFF_PAGE `uploaded` rows to
// collection and queues one `/tasks/catalog/ingest-more` task for the rest; that task hands the next
// page and queues itself again until none remain, so one Continue is enough for any number of files.
// Pages follow the upload id order and each task carries the last id it handed (`after`), so every
// upload reaches the queue once; the ingest task names (`ingest-<uploadId>-<run>`) deduplicate a
// repeated page as well.
import { createHash } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogUploads } from "../../db/schema";
import type { enqueueTask } from "../../tasks";

/** Builder constant: uploads handed per request or task. */
export const HAND_OFF_PAGE = 500;

export const INGEST_MORE_ROUTE = "/tasks/catalog/ingest-more" as const;

/** The ingest task of one upload in one hand-off run. */
export const ingestTaskId = (uploadId: string, run: string) => `ingest-${uploadId}-${run}`;

/** The ingest-more task after `after` in `run` (hashed, as Cloud Tasks recommends for task names). */
export const ingestMoreTaskId = (batchId: string, run: string, after: string) => `more-${createHash("sha256").update(`${batchId}|${run}|${after}`).digest("hex").slice(0, 40)}`;

/** The next page of the batch's `uploaded` uploads after `after` (upload id order), and whether more follow. */
export async function uploadedPage(db: Db, batchId: string, after: string | null, page = HAND_OFF_PAGE): Promise<{ ids: string[]; more: boolean }> {
  const rows = await db
    .select({ id: catalogUploads.id })
    .from(catalogUploads)
    .where(and(eq(catalogUploads.batchId, batchId), eq(catalogUploads.status, "uploaded"), ...(after ? [gt(catalogUploads.id, after)] : [])))
    .orderBy(asc(catalogUploads.id))
    .limit(page + 1);
  return { ids: rows.slice(0, page).map((r) => r.id), more: rows.length > page };
}

/**
 * Hands `ids` to collection (one ingest task each, under `run`), then, when `more`, queues the
 * ingest-more task for the uploads after the last of them. `onHanded` counts tasks as they reach the
 * queue (the web request reports a partial hand-off with it).
 */
export async function handOff(
  enqueue: typeof enqueueTask,
  batchId: string,
  run: string,
  page: { ids: string[]; more: boolean },
  onHanded?: () => void,
): Promise<void> {
  for (const uploadId of page.ids) {
    // `run` is part of the placing token (spec 14c F6), so a Try again never reuses a lost delivery's lease.
    await enqueue("/tasks/catalog/ingest", { batchId, uploadId, run }, { taskId: ingestTaskId(uploadId, run) });
    onHanded?.();
  }
  const last = page.ids.at(-1);
  if (page.more && last) await enqueue(INGEST_MORE_ROUTE, { batchId, run, after: last }, { taskId: ingestMoreTaskId(batchId, run, last) });
}
