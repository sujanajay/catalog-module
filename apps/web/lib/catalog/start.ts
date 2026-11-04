import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { STALE_PREVIEW, startDraftBatch } from "@catalog/core/catalog/pipeline/start";
import { db } from "../db";
import { badRequest } from "../errors";

/**
 * The Start button (and an API Start): the shared start (core pipeline/start.ts), which the auto-start task runs too
 * (M1-F2-R6). Its refusals (StartRefused) answer with their own status (errors.ts).
 */
export async function startBatch(id: string, value: unknown, _actor: string) {
  const previewAt = (value as { previewAt?: unknown })?.previewAt;
  if (typeof previewAt !== "string" || !Number.isFinite(Date.parse(previewAt))) throw badRequest(STALE_PREVIEW);
  return startDraftBatch(db(), { storage, enqueue: enqueueTask }, id, previewAt);
}
