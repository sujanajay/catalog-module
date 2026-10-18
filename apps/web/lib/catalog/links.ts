import { and, eq } from "drizzle-orm";
import { catalogBatches, catalogUploads, type CatalogBatch, type CatalogUpload } from "@catalog/core/db/schema";
import { accessStatus, checkLinkAccess, detectPastedText, NOTHING_TO_CHECK } from "@catalog/core/catalog/ingest/detect";
import { collectGoogleSheetOnWeb, googleClients } from "@catalog/core/catalog/ingest/google-sheet";
import { collectDriveFolderOnWeb } from "@catalog/core/catalog/ingest/drive-folder";
import { batchPrefix } from "@catalog/core/catalog/naming";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { db } from "../db";
import { badRequest } from "../errors";
import { assertDraft, draftForUpdate } from "./batches";

export async function addLinks(id: string, value: unknown) {
  await assertDraft(id);
  const text = (value as { text?: unknown })?.text;
  if (typeof text !== "string" || !detectPastedText(text)) throw badRequest(NOTHING_TO_CHECK);
  const kind = detectPastedText(text)!.kind;
  const deps = kind === "url_list" ? { fetch: pinnedFetch } : { ...await googleClients(), fetch: pinnedFetch };
  const result = await checkLinkAccess(text, deps);
  const access = accessStatus(result);
  const summary = "error" in result ? result.error : result.message;
  const values = { kind, name: "title" in result && result.title ? result.title : kind === "url_list" ? "Image links" : text.trim(), sourceUrl: text.trim(), status: access === "ok" ? "uploaded" as const : "failed" as const, error: access === "ok" ? null : summary, detected: { ...result, message: summary } };
  await db().transaction(async (tx) => {
    const current = await draftForUpdate(tx, id);
    const [prior] = await tx.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), eq(catalogUploads.sourceUrl, text.trim())));
    if (prior) await tx.update(catalogUploads).set({ ...values, ...(access === "ok" ? {gcsUri:null} : {}) }).where(eq(catalogUploads.id, prior.id));
    else await tx.insert(catalogUploads).values({ ...values, batchId: id });
    await tx.update(catalogBatches).set({ counts: access === "ok" ? { ...current.counts, previewReady: false } : current.counts, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  });
  return { kind, access, summary, count: "fileCount" in result ? result.fileCount : undefined };
}
export async function collectGoogleLink(batch: CatalogBatch, upload: CatalogUpload) {
  const deps = { ...await googleClients(), fetch: pinnedFetch, storage };
  const input = { batchId: batch.id, brandSlug: batch.brandSlug, prefix: batchPrefix(batch.brandSlug, batch.id, batch.isTest), upload, options: batch.options, deps };
  if (upload.kind === "google_sheet") return collectGoogleSheetOnWeb(input, db());
  return collectDriveFolderOnWeb(input, db());
}
