// M1 D42: the re-cut job's one call. The photos are reset (core catalog/recut.ts), their matte chunk sent and the batch's finalize
// re-opened, so the new images are published at the same URLs and a new links sheet written. It runs in the job, not as a task,
// so the job can report each outcome. A lost send is covered by the sweep (recoverBatchChunks), and sending twice answers `busy`.
import { enqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import { recutPhotos, type RecutResult } from "@catalog/core/catalog/recut";
import { enqueueFinalize, type CatalogDeps } from "./deps";

export async function recutProductPhotos(deps: CatalogDeps, input: { batchId: string; sourceImageIds: readonly string[] }): Promise<RecutResult> {
  const result = await recutPhotos(deps.db, { ...input, now: deps.now() });
  if (result.outcome === "recutting") {
    await enqueueChunk(deps.enqueue, { id: result.chunkId!, stage: "matte", step: 0 });
    await enqueueFinalize(deps, input.batchId, undefined, { reopen: true });
  }
  deps.log("photos re-cut", { batchId: input.batchId, sourceImageIds: input.sourceImageIds, outcome: result.outcome, ...(result.outputs ? { outputs: result.outputs } : {}) });
  return result;
}
