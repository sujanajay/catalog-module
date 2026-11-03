// Ingest tasks (spec 04 "Ingest run"). `/tasks/catalog/ingest`: one delivery per upload, or per
// continuation of one (collecting or placing). runIngest does the work and enqueues its own
// continuation, so this handler answers 200 on progress or completion and 500 on an unexpected error
// (Cloud Tasks retries without limit; M6-F2-R4: the handler counts failures on the upload row and stops the batch at
// INGEST_MAX_FAILURES). `/tasks/catalog/ingest-more` (spec 14d F11 part 2): hands the
// next page of a batch's `uploaded` uploads to collection. A body without the ids is refused with 400.
import { failStoppedIngest, runIngest } from "@catalog/core/catalog/ingest/index";
import { handOff, uploadedPage } from "@catalog/core/catalog/ingest/hand-off";
import type { IngestDeps } from "@catalog/core/catalog/ingest/types";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { log } from "@catalog/core/log";
import { and, eq, gt, sql } from "drizzle-orm";
import type { HandleOptions, HandleResult } from "../server";

/**
 * M6-F2-R4 (M6-S4): failed deliveries of one upload in a row (catalog_uploads.ingest_failures) after which the batch is
 * stopped. The ingest queue retries without limit (infra/lib/queues.sh INGEST_QUEUE_RETRY), so only a delivery whose
 * handler threw counts: a 429 or 503 before the handler ran, a deploy's drain or a killed instance never does. A
 * delivery that succeeds sets the count back to 0.
 */
export const INGEST_MAX_FAILURES = 5;

export interface IngestTaskDeps {
  db: Db;
  ingest: IngestDeps & { enqueue: typeof enqueueTask };
  /** Defaults to runIngest; tests pass a fake. */
  run?: typeof runIngest;
  /** Tests: stands in for failStoppedIngest. */
  failStopped?: typeof failStoppedIngest;
  /** Milliseconds now, for the per-delivery log line; tests pass a fake. */
  clock?: () => number;
}

/**
 * What the worker runs ingest with: the private bucket (BUCKET), Cloud Tasks for the continuation,
 * and 02's DNS-pinned fetch, so a pasted link's connection only goes to the public address safeFetch
 * checked (no DNS rebinding). The Google kinds were already copied by the web tier.
 */
export function workerIngestDeps(): IngestTaskDeps["ingest"] {
  return { storage, fetch: pinnedFetch, enqueue: enqueueTask };
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isOptionalText = (v: unknown) => v === undefined || typeof v === "string";

export async function handleIngestTask(deps: IngestTaskDeps, body: Record<string, unknown>, opts: HandleOptions = {}): Promise<HandleResult> {
  const { batchId, uploadId, cursor, run, place, group } = body;
  if (!isId(batchId) || !isId(uploadId) || !isOptionalText(cursor) || !isOptionalText(run) || !isOptionalText(place) || !isOptionalText(group)) {
    return { httpStatus: 400, outcome: "invalid body: batchId and uploadId are required" };
  }
  const clock = deps.clock ?? Date.now;
  const started = clock();
  try {
    // `run` (optional, spec 14c F6): the hand-off's run id, part of the placing token. Bodies without it
    // (an earlier web tier) still work: the token is then the upload id and the cursor. `place` (spec
    // 14d F7 part 2) marks a placing continuation, `group` a grouping one.
    const { progress, outcome } = await (deps.run ?? runIngest)(deps.db, deps.ingest, {
      batchId, uploadId, ...(cursor ? { cursor } : {}), ...(run ? { run } : {}), ...(typeof place === "string" ? { place } : {}), ...(typeof group === "string" ? { group } : {}),
    });
    // One INFO line per delivery (spec 14d F12): what it did, how far the upload or placing is, how long it took.
    log("INFO", "ingest", { event: "ingest", batchId, uploadId, phase: progress.phase, done: progress.done, total: progress.total, ms: clock() - started, outcome });
    // M6-F2-R4: the failures in a row start again (a write only when there were some). The work succeeded, so a reset
    // that cannot be written is logged and never counted as a failure.
    try {
      await deps.db.update(catalogUploads).set({ ingestFailures: 0 }).where(and(eq(catalogUploads.id, uploadId), gt(catalogUploads.ingestFailures, 0)));
    } catch (resetErr) {
      log("WARNING", "ingest failure count not reset", { batchId, uploadId, error: resetErr instanceof Error ? resetErr.message : String(resetErr) });
    }
    return { httpStatus: 200, outcome };
  } catch (err) {
    // M6-F2-R4: one more failure on the upload row. A count that cannot be written (the database is down too) is not
    // terminal: the queue retries.
    const [counted] = await deps.db.update(catalogUploads).set({ ingestFailures: sql`${catalogUploads.ingestFailures} + 1` })
      .where(eq(catalogUploads.id, uploadId)).returning({ failures: catalogUploads.ingestFailures }).catch(() => []);
    const failures = counted?.failures ?? null;
    log("ERROR", "ingest task failed", { batchId, uploadId, ms: clock() - started, failures, retryCount: opts.retryCount ?? null, error: err instanceof Error ? err : String(err) });
    // The last failure: the handler stops the batch (Try again starts it again). A task of an earlier run (Try again
    // started a newer one) leaves the batch alone and is acknowledged.
    if (failures !== null && failures >= INGEST_MAX_FAILURES) {
      try {
        const delivery = { uploadId, ...(cursor ? { cursor } : {}), ...(run ? { run } : {}) };
        if (await (deps.failStopped ?? failStoppedIngest)(deps.db, batchId, delivery)) {
          log("WARNING", "batch failed", { batchId, uploadId, cause: "ingest_out_of_attempts" });
          // Stopped: acknowledged, so the unlimited queue does not send it again.
          return { httpStatus: 200, outcome: "stopped: out of attempts" };
        } else return { httpStatus: 200, outcome: "dropped: out of attempts, and the batch was not this task's to stop" };
      } catch (markErr) {
        log("ERROR", "ingest out of attempts: the batch could not be marked failed", { batchId, error: markErr instanceof Error ? markErr : String(markErr) });
      }
    }
    return { httpStatus: 500, outcome: "error" };
  }
}

/**
 * `/tasks/catalog/ingest-more` `{ batchId, run, after }` (spec 14d F11 part 2): hands the next page of
 * the batch's `uploaded` uploads after `after` to collection under the same run, and queues itself for
 * the page after. A batch that is no longer collecting (cancelled, for example) is handed nothing.
 */
export async function handleIngestMoreTask(deps: IngestTaskDeps, body: Record<string, unknown>): Promise<HandleResult> {
  const { batchId, run, after } = body;
  if (!isId(batchId) || !isId(run) || !isOptionalText(after)) return { httpStatus: 400, outcome: "invalid body: batchId and run are required" };
  try {
    const [batch] = await deps.db.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
    if (batch?.status !== "ingesting") return { httpStatus: 200, outcome: `noop: the batch is ${batch?.status ?? "missing"}` };
    const page = await uploadedPage(deps.db, batchId, typeof after === "string" && after ? after : null);
    await handOff(deps.ingest.enqueue, batchId, run, page);
    const outcome = `handed ${page.ids.length}${page.more ? "; more follow" : ""}`;
    log("INFO", "ingest-more", { event: "ingest-more", batchId, handed: page.ids.length, more: page.more });
    return { httpStatus: 200, outcome };
  } catch (err) {
    log("ERROR", "ingest-more task failed", { batchId, error: err instanceof Error ? err : String(err) });
    return { httpStatus: 500, outcome: "error" };
  }
}
