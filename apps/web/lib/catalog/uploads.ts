import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { detectUploadKind } from "@catalog/core/catalog/ingest/detect";
import { planSignedUploads, mapLimit } from "@catalog/core/catalog/ingest/local-files";
import { batchPrefix } from "@catalog/core/catalog/naming";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { db } from "../db";
import { badRequest, HttpError } from "../errors";
import { assertDraft, draftForUpdate, queryBatch } from "./batches";
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
  if (upload.status === "uploaded" || upload.status === "collected") return { uploaded: true };
  const head = await storage.headObject(upload.gcsUri);
  if (!head.exists || head.size !== upload.sizeBytes) throw badRequest(`${upload.name} did not finish uploading. Try again.`);
  const bytes = head.size ? await storage.readRange(upload.gcsUri, 0, Math.min(4099, head.size - 1)) : Buffer.alloc(0);
  const kind = detectUploadKind(upload.name, bytes);
  await db().transaction(async (tx) => {
    const current = await draftForUpdate(tx, id);
    await tx.update(catalogUploads).set({ status: "uploaded", kind: kind === "unknown" ? "image" : kind, error: null, detected: { ...upload.detected, completedAt: new Date().toISOString() } }).where(eq(catalogUploads.id, uploadId));
    await tx.update(catalogBatches).set({ counts: { ...current.counts, previewReady: false }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  });
  return { uploaded: true };
}
export async function ingestBatch(id: string) {
  const batch = await queryBatch(id);
  if (!["draft", "ingesting"].includes(batch.status)) throw new HttpError(409, "This batch has already started. Make a new batch to add more photos.");
  const all = await db().select().from(catalogUploads).where(eq(catalogUploads.batchId, id));
  if (!all.length) throw badRequest("Add photos or a links sheet before continuing.");
  if (all.some((u) => u.status === "pending")) throw badRequest("Wait for every file to finish uploading, then continue.");
  for (const upload of all) {
    if ((upload.kind === "google_sheet" || upload.kind === "drive_folder") && upload.status === "uploaded" && !upload.gcsUri) await collectGoogleLink(batch, upload);
  }
  const uploads = await db().select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), eq(catalogUploads.status, "uploaded")));
  if (!uploads.length && batch.counts.previewReady) return { collecting: false };
  if (!uploads.length) throw badRequest("No files are ready. Check access to your links and try again.");
  await db().update(catalogBatches).set({ status: "ingesting", counts: { ...batch.counts, previewReady: false }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  for (const upload of uploads) await enqueueTask("/tasks/catalog/ingest", { batchId: id, uploadId: upload.id });
  return { collecting: true };
}
export async function regroupBatch(id: string) {
  const batch = await assertDraft(id);
  await db().update(catalogUploads).set({ status: "uploaded" }).where(and(eq(catalogUploads.batchId, id), inArray(catalogUploads.status, ["collected", "failed"])));
  await db().update(catalogBatches).set({ counts: { ...batch.counts, previewReady: false } }).where(eq(catalogBatches.id, id));
  return ingestBatch(id);
}
