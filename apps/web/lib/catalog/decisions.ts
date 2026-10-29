import { applyDecision, CatalogDecisionError, CatalogPlainWarning, completeReplacement, retryEnlargement, startReplacement } from "@catalog/core/catalog/decisions";
import { enqueueTask } from "@catalog/core/tasks";
import { enqueueChunk, tryEnqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import type { UnparkedChunk } from "@catalog/core/catalog/pipeline/enlargement";
import { log } from "@catalog/core/log";
import * as storage from "@catalog/core/storage";
import { db } from "../db";
import { HttpError } from "../errors";

/** Turns the core decision errors (400, 404, 409 with their sentences) into HTTP errors. */
export async function decisionAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CatalogDecisionError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

/** Spec 18 lifecycle: a chunk a decision unparked on a batch that is not processing is sent now (the sweep covers a lost send). */
async function enqueueUnparked(unparked: UnparkedChunk[] | undefined): Promise<void> {
  for (const chunk of unparked ?? []) if (chunk.direct) await tryEnqueueChunk(enqueueTask, chunk, (message, fields) => log("WARNING", message, fields));
}
/** The 409 body of the plain warning (spec 18 lifecycle 3.6): the code and the channels whose images would be stretched. */
export interface PlainWarningBody { error: "plain_warning"; channels: string[] }
/**
 * "Use as is" or "Remove this photo", then publish for the product (spec 07 4.7). Spec 18 lifecycle 3.6: "Use as is"
 * on a photo that could not be enlarged answers the plain warning unless `acceptPlain` is set.
 */
export async function decidePhoto(outputId: string, decision: "use_as_is" | "remove", actor: string, acceptPlain = false): Promise<Awaited<ReturnType<typeof applyDecision>> | { warning: PlainWarningBody }> {
  try {
    return await decisionAction(async () => {
      const result = await applyDecision(db(), { outputId, decision, actor, acceptPlain });
      await enqueueTask("/tasks/catalog/publish", { batchId: result.batchId, productId: result.productId, trigger: result.decisionId }, { taskId: `publish-${result.productId}-${result.decisionId}` });
      await enqueueUnparked(result.unparked);
      return result;
    });
  } catch (error) {
    if (error instanceof CatalogPlainWarning) return { warning: { error: "plain_warning", channels: error.channels } };
    throw error;
  }
}
/** Spec 18 lifecycle 3.6 "Try again": the photo's failed enlargements are queued again with a parked one-photo render. */
export async function retryPhotoEnlargement(outputId: string, actor: string) {
  return decisionAction(() => retryEnlargement(db(), enqueueTask, { outputId, actor, log: (message, fields) => log("INFO", message, fields) }));
}

/** One signed PUT URL for a replacement photo (spec 07 4.8). */
export async function replacementUpload(outputId: string, input: { name: string; size: number; mime: string }) {
  return decisionAction(() => startReplacement({ db: db(), storage }, { outputId, ...input }));
}

/** Confirms the uploaded replacement and queues its one-source chunk at the matte stage. */
export async function finishReplacement(outputId: string, uploadId: string, actor: string) {
  return decisionAction(async () => {
    const result = await completeReplacement({ db: db(), storage }, { outputId, uploadId, actor });
    // Spec 15 E5: one chunk, dispatched at once outside the batch window (it is created with dispatched_at set).
    await enqueueChunk(enqueueTask, { id: result.chunkId, stage: "matte", step: 0 });
    await enqueueUnparked(result.unparked);
    return result;
  });
}
