// Ingest task (`/tasks/catalog/ingest`, spec 04 "Ingest run"): one delivery per upload, or per
// continuation of one. runIngest does the work and enqueues its own continuation, so this handler
// answers 200 on progress or completion and 500 on an unexpected error (Cloud Tasks retries, 5
// attempts). A body without a batch and an upload id is refused with 400.
import { runIngest } from "@catalog/core/catalog/ingest/index";
import type { IngestDeps } from "@catalog/core/catalog/ingest/types";
import type { Db } from "@catalog/core/db/client";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import type { HandleResult } from "../server";

export interface IngestTaskDeps {
  db: Db;
  ingest: IngestDeps & { enqueue: typeof enqueueTask };
  /** Defaults to runIngest; tests pass a fake. */
  run?: typeof runIngest;
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

export async function handleIngestTask(deps: IngestTaskDeps, body: Record<string, unknown>): Promise<HandleResult> {
  const { batchId, uploadId, cursor } = body;
  if (!isId(batchId) || !isId(uploadId) || (cursor !== undefined && typeof cursor !== "string")) {
    return { httpStatus: 400, outcome: "invalid body: batchId and uploadId are required" };
  }
  try {
    const { outcome } = await (deps.run ?? runIngest)(deps.db, deps.ingest, { batchId, uploadId, ...(cursor ? { cursor } : {}) });
    return { httpStatus: 200, outcome };
  } catch (err) {
    console.error(JSON.stringify({ severity: "ERROR", message: "ingest task failed", batchId, uploadId, error: err instanceof Error ? err.message : String(err) }));
    return { httpStatus: 500, outcome: "error" };
  }
}
