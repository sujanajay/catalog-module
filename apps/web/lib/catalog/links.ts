import { and, desc, eq, sql } from "drizzle-orm";
import type { UploadKind } from "@catalog/core/catalog/types";
import { catalogBatches, catalogUploads, type CatalogBatch, type CatalogUpload } from "@catalog/core/db/schema";
import { accessStatus, checkLinkAccess, detectPastedText, NOTHING_TO_CHECK, pasteReadback } from "@catalog/core/catalog/ingest/detect";
import { collectGoogleSheetOnWeb, googleClients } from "@catalog/core/catalog/ingest/google-sheet";
import { collectDriveFolderOnWeb } from "@catalog/core/catalog/ingest/drive-folder";
import { readSupabaseFolder, type SupabaseStorageLike } from "@catalog/core/catalog/ingest/supabase-folder";
import { withoutSupabaseFolders } from "@catalog/core/catalog/ingest/supabase-link";
import { batchPrefix } from "@catalog/core/catalog/naming";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { db } from "../db";
import { badRequest, HttpError } from "../errors";
import { assertInputsOpen, batchForInputChange, INPUT_NOT_FOUND, LINK_KINDS, mergeCounts } from "./batches";
import { supabaseClient } from "./supabase";

export async function addLinks(id: string, value: unknown, target?: string) {
  await assertInputsOpen(id);
  const text = (value as { text?: unknown })?.text;
  if (typeof text !== "string") throw badRequest(NOTHING_TO_CHECK);
  // Supabase folder links are a paste kind only while the client is on; off, such a link is an image link as before.
  const client = supabaseClient();
  const detected = detectPastedText(text, { supabaseFolders: client !== null });
  if (!detected) throw badRequest(NOTHING_TO_CHECK);
  if (detected.kind === "supabase_folder") return addSupabaseFolders(id, client!, text, detected.ids, target);
  return addPastedText(id, text, detected.kind, target);
}
async function addPastedText(id: string, text: string, kind: "google_sheet" | "drive_folder" | "url_list", target?: string) {
  const deps = kind === "url_list" ? { fetch: pinnedFetch } : { ...await googleClients(), fetch: pinnedFetch };
  const result = await checkLinkAccess(text, deps);
  const access = accessStatus(result);
  const summary = "error" in result ? result.error : result.message;
  const values = { kind, name: "title" in result && result.title ? result.title : kind === "url_list" ? "Image links" : text.trim(), sourceUrl: kind === "url_list" ? text : text.trim(), status: access === "ok" ? "uploaded" as const : "failed" as const, error: access === "ok" ? null : summary, detected: { ...result, message: summary } };
  const uploadId = await saveLinkRow(id, values, access === "ok", (tx) => linkRowFor(tx, id, kind, text.trim(), target));
  // A list of image links answers with its readback pill and notes (spec 14b F2).
  const readback = kind === "url_list" && !("error" in result) ? pasteReadback(result) : null;
  return { kind, access, summary, count: "fileCount" in result ? result.fileCount : undefined, uploadId, ...(readback ? { pill: readback.pill, notes: readback.notes } : {}) };
}
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type LinkRowValues = Omit<typeof catalogUploads.$inferInsert, "batchId">;
/** Writes a paste's row (the prior one found by `rowFor`, else a new one) and invalidates the preview when it changed an input. */
async function saveLinkRow(id: string, values: LinkRowValues, ok: boolean, rowFor: (tx: Tx) => Promise<CatalogUpload | null>): Promise<string> {
  return db().transaction(async (tx) => {
    await batchForInputChange(tx, id);
    const prior = await rowFor(tx);
    if (prior) await tx.update(catalogUploads).set({ ...values, ...(ok ? {gcsUri:null} : {}) }).where(eq(catalogUploads.id, prior.id));
    const rowId = prior?.id ?? (await tx.insert(catalogUploads).values({ ...values, batchId: id }).returning({ id: catalogUploads.id }))[0]!.id;
    // Changing an input invalidates the preview (spec 14b F3), as a merge-only counts write.
    if (ok || prior) await tx.update(catalogBatches).set({ counts: mergeCounts({ previewReady: false }), updatedAt: new Date() }).where(eq(catalogBatches.id, id));
    else await tx.update(catalogBatches).set({ updatedAt: new Date() }).where(eq(catalogBatches.id, id));
    return rowId;
  });
}
/**
 * Every Supabase folder link in a paste, each as its own input, then the rest of the text (image
 * links next to the folders) through the normal path. The first answer is returned, with the others
 * under `others`. Replacing one input (`target`) takes the first folder only.
 */
async function addSupabaseFolders(id: string, client: SupabaseStorageLike, text: string, links: string[], target?: string) {
  if (target) return addSupabaseFolder(id, client, links[0]!, target);
  const answers: Record<string, unknown>[] = [];
  for (const link of links) answers.push(await addSupabaseFolder(id, client, link));
  const rest = withoutSupabaseFolders(text);
  // With folder detection off, the rest is never a folder paste again.
  const restKind = detectPastedText(rest, { supabaseFolders: false })?.kind;
  if (restKind && restKind !== "supabase_folder") answers.push(await addPastedText(id, rest, restKind));
  const [first, ...others] = answers;
  return others.length ? { ...first, others } : first!;
}
/**
 * A pasted Supabase folder link (M1-F1-R4): listed read-only on the web tier and saved as its own
 * `url_list` row of image links (product folder names kept as the rows' names when the folder is one
 * folder per product). `detected.supabaseFolder` holds the canonical link (no token), so pasting the
 * same folder again in any spelling updates that row and the plain image-links row stays apart.
 */
async function addSupabaseFolder(id: string, client: SupabaseStorageLike, link: string, target?: string) {
  const read = await readSupabaseFolder(client, link);
  const values: LinkRowValues = read.ok
    ? { kind: "url_list", name: read.title, sourceUrl: read.text, status: "uploaded", error: null, detected: { kind: "url_list", fileCount: read.photos, title: read.title, message: read.message, supabaseFolder: { url: read.url, mode: read.mode } } }
    : { kind: "url_list", name: "Supabase folder", sourceUrl: link, status: "failed", error: read.error, detected: { kind: "url_list", message: read.error, supabaseFolder: { url: link, mode: "filename" } } };
  const uploadId = await saveLinkRow(id, values, read.ok, async (tx) => {
    if (target) return linkRowFor(tx, id, "url_list", link, target);
    const [row] = await tx.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), eq(catalogUploads.kind, "url_list"), sql`${catalogUploads.detected}->'supabaseFolder'->>'url' = ${link}`)).limit(1).for("update");
    return row ?? null;
  });
  return read.ok
    ? { kind: "supabase_folder", access: "ok", summary: read.message, count: read.photos, uploadId, pill: `${read.photos.toLocaleString("en-US")} ${read.photos === 1 ? "photo" : "photos"}` }
    : { kind: "supabase_folder", access: "no_access", summary: read.error, uploadId };
}
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
    // A Supabase folder's row is its own input, never the pasted image links row.
    ? await tx.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), eq(catalogUploads.kind, "url_list"), sql`${catalogUploads.detected}->'supabaseFolder' IS NULL`)).orderBy(sql`${catalogUploads.status} = 'removed'`, desc(catalogUploads.createdAt)).limit(1).for("update")
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
