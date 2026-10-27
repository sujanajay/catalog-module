import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { detectUploadKind } from "@catalog/core/catalog/ingest/detect";
import { planSignedUploads, mapLimit } from "@catalog/core/catalog/ingest/local-files";
import { batchPrefix } from "@catalog/core/catalog/naming";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { isTransientError } from "@catalog/core/retry";
import { db } from "../db";
import { badRequest, HttpError } from "../errors";
import { assertDraft, draftForUpdate, INPUT_NOT_FOUND, LINK_KINDS, mergeCounts, queryBatch } from "./batches";
import { HAND_OFF_FAILED, HAND_OFF_RETRY } from "./copy";
import { collectGoogleLink } from "./links";

export async function planUploads(id: string, value: unknown) {
  const batch = await assertDraft(id);
  const files = (value as { files?: unknown })?.files;
  if (!Array.isArray(files) || !files.length) throw badRequest("Choose at least one file to upload.");
  const prefix = batchPrefix(batch.brandSlug, id, batch.isTest);
  return mapLimit(files, 16, async (input: unknown) => {
    const f = input as { name?: unknown; size?: unknown; mime?: unknown; relativePath?: unknown };
    if (typeof f?.name !== "string" || !f.name || !Number.isSafeInteger(f.size) || Number(f.size) < 0 || typeof f.mime !== "string" || typeof f.relativePath !== "string" || !f.relativePath) throw badRequest("A file could not be read. Choose it again.");
    const uploadId = randomUUID();
    const [plan] = await planSignedUploads({ prefix, uploadId, files: [{ relativePath: f.relativePath, size: Number(f.size), type: f.mime }] }, storage.signedPutUrl);
    const kind = /\.zip$/i.test(f.name) ? "zip" : /\.(csv|xls[xm])$/i.test(f.name) ? "sheet" : "image";
    await db().transaction(async (tx) => {
      const current = await draftForUpdate(tx, id);
      await tx.insert(catalogUploads).values({ id: uploadId, batchId: id, name: f.name as string, relativePath: f.relativePath as string, kind, sizeBytes: Number(f.size), mime: plan!.contentType, gcsUri: storage.toGsUri(storage.getBucketName(), plan!.objectPath) });
      await tx.update(catalogBatches).set({ counts: { ...current.counts, previewReady: false }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
    });
    return { uploadId, putUrl: plan!.putUrl, headers: { "Content-Type": plan!.contentType } };
  });
}
export async function completeUpload(id: string, uploadId: string) {
  await assertDraft(id);
  const [upload] = await db().select().from(catalogUploads).where(and(eq(catalogUploads.id, uploadId), eq(catalogUploads.batchId, id)));
  if (!upload?.gcsUri) throw new HttpError(404, "This upload does not exist. Choose the file again.");
  if (upload.status === "removed") throw new HttpError(410, UPLOAD_REMOVED);
  if (upload.status === "uploaded" || upload.status === "collected") return { uploaded: true };
  const head = await storage.headObject(upload.gcsUri);
  if (!head.exists || head.size !== upload.sizeBytes) throw badRequest(`${upload.name} did not finish uploading. Try again.`);
  const bytes = head.size ? await storage.readRange(upload.gcsUri, 0, Math.min(4099, head.size - 1)) : Buffer.alloc(0);
  const kind = detectUploadKind(upload.name, bytes);
  await db().transaction(async (tx) => {
    const current = await draftForUpdate(tx, id);
    // Conditional: a Remove that landed while the bytes were checked wins (the row stays removed).
    const [done] = await tx.update(catalogUploads).set({ status: "uploaded", kind: kind === "unknown" ? "image" : kind, error: null, detected: { ...upload.detected, completedAt: new Date().toISOString() } }).where(and(eq(catalogUploads.id, uploadId), ne(catalogUploads.status, "removed"))).returning({ id: catalogUploads.id });
    if (!done) throw new HttpError(410, UPLOAD_REMOVED);
    await tx.update(catalogBatches).set({ counts: { ...current.counts, previewReady: false }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  });
  return { uploaded: true };
}
/** completeUpload's answer for a file the operator removed while it was uploading (410, so the Uploader does not read it as "already started"). */
export const UPLOAD_REMOVED = "This file was removed. Add it again to use it.";
/**
 * Remove (spec 14b F3, decision 1): the row becomes `removed`, so collection, step 2, the preview and
 * the counts ignore it; its object under uploads/ is left for the lifecycle. Draft only (the existing
 * refusal for a collecting or started batch, until release C). Removing an input invalidates the
 * preview with a merge-only counts write. `route` is the route family the id came in on.
 */
export async function removeInput(id: string, uploadId: string, route: "uploads" | "links") {
  await db().transaction(async (tx) => {
    await draftForUpdate(tx, id);
    const [upload] = await tx.select().from(catalogUploads).where(and(eq(catalogUploads.id, uploadId), eq(catalogUploads.batchId, id))).for("update");
    if (!upload || LINK_KINDS.includes(upload.kind) !== (route === "links")) throw new HttpError(404, INPUT_NOT_FOUND);
    if (upload.status === "removed") return;
    await tx.update(catalogUploads).set({ status: "removed" }).where(eq(catalogUploads.id, uploadId));
    await tx.update(catalogBatches).set({ counts: mergeCounts({ previewReady: false }), updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  });
  return { removed: true };
}
/** Maps a failed hand-off to the operator's sentence. The raw library error is logged, never shown. */
export function handOffError(err: unknown): HttpError {
  return isTransientError(err) ? new HttpError(503, HAND_OFF_RETRY) : new HttpError(500, HAND_OFF_FAILED);
}
/**
 * Hands every `uploaded` upload to the worker (one ingest task each) and marks the batch collecting.
 * Also the "Try again" of a stalled collecting batch: an upload still `uploaded` is handed again
 * (ingest is idempotent, so a second delivery only reads what was never read), and when every upload
 * is already read but the batch-wide step never ran, one read upload is handed so its task runs it.
 * Each call names its tasks `ingest-<uploadId>-<run>`, so enqueueTask's retries never duplicate one.
 */
export async function ingestBatch(id: string) {
  const batch = await queryBatch(id);
  if (!["draft", "ingesting"].includes(batch.status)) throw new HttpError(409, "This batch has already started. Make a new batch to add more photos.");
  // A removed input (spec 14b F3) is neither collected nor waited for.
  const all = await db().select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
  if (!all.length) throw badRequest("Add photos or a links sheet before continuing.");
  if (all.some((u) => u.status === "pending")) throw badRequest("Wait for every file to finish uploading, then continue.");
  for (const upload of all) {
    if ((upload.kind === "google_sheet" || upload.kind === "drive_folder") && upload.status === "uploaded" && !upload.gcsUri) await collectGoogleLink(batch, upload);
  }
  const current = await db().select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
  const uploads = current.filter((u) => u.status === "uploaded");
  if (!uploads.length && batch.counts.previewReady) return { collecting: false };
  const targets = uploads.length ? uploads : current.filter((u) => u.status === "collected").slice(0, 1);
  if (!targets.length) throw badRequest("No files are ready. Check access to your links and try again.");
  await db().update(catalogBatches).set({ status: "ingesting", counts: { ...batch.counts, previewReady: false }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  const run = randomUUID();
  let handed = 0;
  try {
    for (const upload of targets) {
      await enqueueTask("/tasks/catalog/ingest", { batchId: id, uploadId: upload.id }, { taskId: `ingest-${upload.id}-${run}` });
      handed++;
    }
  } catch (err) {
    console.error(JSON.stringify({ severity: "ERROR", message: "ingest hand-off failed", batchId: id, handed, uploads: targets.length, code: (err as { code?: unknown } | null)?.code ?? null, error: err instanceof Error ? err.message : String(err) }));
    // Nothing reached the queue: the batch goes back to draft, so Continue (PATCH, then /ingest) works
    // again instead of answering 409. Once a task is queued its worker may already be collecting, so
    // the batch stays collecting; the next /ingest (Continue or Try again) hands over the rest.
    if (!handed && batch.status === "draft") await db().update(catalogBatches).set({ status: "draft" }).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "ingesting")));
    throw handOffError(err);
  }
  return { collecting: true };
}
export async function regroupBatch(id: string) {
  const batch = await assertDraft(id);
  await db().update(catalogUploads).set({ status: "uploaded" }).where(and(eq(catalogUploads.batchId, id), inArray(catalogUploads.status, ["collected", "failed"])));
  await db().update(catalogBatches).set({ counts: { ...batch.counts, previewReady: false } }).where(eq(catalogBatches.id, id));
  return ingestBatch(id);
}
