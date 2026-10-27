import { and, desc, eq, sql } from "drizzle-orm";
import type { UploadKind } from "@catalog/core/catalog/types";
import { catalogBatches, catalogUploads, type CatalogBatch, type CatalogUpload } from "@catalog/core/db/schema";
import { accessStatus, checkLinkAccess, detectPastedText, NOTHING_TO_CHECK, pasteReadback } from "@catalog/core/catalog/ingest/detect";
import { collectGoogleSheetOnWeb, googleClients } from "@catalog/core/catalog/ingest/google-sheet";
import { collectDriveFolderOnWeb } from "@catalog/core/catalog/ingest/drive-folder";
import { batchPrefix } from "@catalog/core/catalog/naming";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { db } from "../db";
import { badRequest, HttpError } from "../errors";
import { assertDraft, draftForUpdate, INPUT_NOT_FOUND, LINK_KINDS, mergeCounts } from "./batches";

export async function addLinks(id: string, value: unknown, target?: string) {
  await assertDraft(id);
  const text = (value as { text?: unknown })?.text;
  if (typeof text !== "string") throw badRequest(NOTHING_TO_CHECK);
  const detected = detectPastedText(text);
  if (!detected) throw badRequest(NOTHING_TO_CHECK);
  const kind = detected.kind;
  const deps = kind === "url_list" ? { fetch: pinnedFetch } : { ...await googleClients(), fetch: pinnedFetch };
  const result = await checkLinkAccess(text, deps);
  const access = accessStatus(result);
  const summary = "error" in result ? result.error : result.message;
  const values = { kind, name: "title" in result && result.title ? result.title : kind === "url_list" ? "Image links" : text.trim(), sourceUrl: text.trim(), status: access === "ok" ? "uploaded" as const : "failed" as const, error: access === "ok" ? null : summary, detected: { ...result, message: summary } };
  const uploadId = await db().transaction(async (tx) => {
    await draftForUpdate(tx, id);
    const prior = await linkRowFor(tx, id, kind, text.trim(), target);
    if (prior) await tx.update(catalogUploads).set({ ...values, ...(access === "ok" ? {gcsUri:null} : {}) }).where(eq(catalogUploads.id, prior.id));
    const rowId = prior?.id ?? (await tx.insert(catalogUploads).values({ ...values, batchId: id }).returning({ id: catalogUploads.id }))[0]!.id;
    // Changing an input invalidates the preview (spec 14b F3), as a merge-only counts write.
    if (access === "ok" || prior) await tx.update(catalogBatches).set({ counts: mergeCounts({ previewReady: false }), updatedAt: new Date() }).where(eq(catalogBatches.id, id));
    else await tx.update(catalogBatches).set({ updatedAt: new Date() }).where(eq(catalogBatches.id, id));
    return rowId;
  });
  // A list of image links answers with its readback pill and notes (spec 14b F2).
  const readback = kind === "url_list" && !("error" in result) ? pasteReadback(result) : null;
  return { kind, access, summary, count: "fileCount" in result ? result.fileCount : undefined, uploadId, ...(readback ? { pill: readback.pill, notes: readback.notes } : {}) };
}
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
/**
 * The row a paste writes to (spec 14b F3): the row named by `PATCH /links/[uploadId]`; else, for image
 * links, the batch's one `url_list` row (even a removed one, so pasting again brings it back as one
 * input); else, for a Google link, the row of that same link. Null means a new row.
 */
async function linkRowFor(tx: Tx, id: string, kind: UploadKind, text: string, target?: string): Promise<CatalogUpload | null> {
  if (target) {
    const [row] = await tx.select().from(catalogUploads).where(and(eq(catalogUploads.id, target), eq(catalogUploads.batchId, id))).for("update");
    if (!row || !LINK_KINDS.includes(row.kind)) throw new HttpError(404, INPUT_NOT_FOUND);
    return row;
  }
  const [row] = kind === "url_list"
    ? await tx.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), eq(catalogUploads.kind, "url_list"))).orderBy(sql`${catalogUploads.status} = 'removed'`, desc(catalogUploads.createdAt)).limit(1).for("update")
    : await tx.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), eq(catalogUploads.sourceUrl, text))).limit(1).for("update");
  return row ?? null;
}
/** `PATCH /links/[uploadId]` `{text}`: replaces that paste or link in place (spec 14b F3). */
export function replaceLinks(id: string, uploadId: string, value: unknown) {
  return addLinks(id, value, uploadId);
}
export async function collectGoogleLink(batch: CatalogBatch, upload: CatalogUpload) {
  const deps = { ...await googleClients(), fetch: pinnedFetch, storage };
  const input = { batchId: batch.id, brandSlug: batch.brandSlug, prefix: batchPrefix(batch.brandSlug, batch.id, batch.isTest), upload, options: batch.options, deps };
  if (upload.kind === "google_sheet") return collectGoogleSheetOnWeb(input, db());
  return collectDriveFolderOnWeb(input, db());
}
