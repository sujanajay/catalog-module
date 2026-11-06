// M1 D41: POST /tasks/catalog/recut {batchId, sourceImageId}. The photo is reset (core catalog/recut.ts), its one-photo matte
// chunk sent and the batch's finalize re-opened, so the new image is published at the same URL and a new links sheet written.
import { enqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import { recutPhoto } from "@catalog/core/catalog/recut";
import type { TaskRoute } from "@catalog/core/tasks";
import type { HandleResult } from "../server";
import { enqueueFinalize, type CatalogDeps } from "./deps";

export const RECUT_ROUTE = "/tasks/catalog/recut" satisfies TaskRoute;

export async function handleRecutTask(deps: CatalogDeps, body: Record<string, unknown>): Promise<HandleResult> {
  if (typeof body.batchId !== "string" || typeof body.sourceImageId !== "string") return { httpStatus: 400, outcome: "batchId and sourceImageId are required" };
  const { batchId, sourceImageId } = body;
  const result = await recutPhoto(deps.db, { batchId, sourceImageId, now: deps.now() });
  if (result.outcome === "recutting") {
    await enqueueChunk(deps.enqueue, { id: result.chunkId!, stage: "matte", step: 0 });
    await enqueueFinalize(deps, batchId, undefined, { reopen: true });
  }
  deps.log("photo re-cut", { batchId, sourceImageId, outcome: result.outcome, ...(result.outputs ? { outputs: result.outputs } : {}) });
  return { httpStatus: 200, outcome: result.outcome };
}
