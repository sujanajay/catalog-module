import { and, desc, eq, sql } from "drizzle-orm";
import type { UploadKind } from "@catalog/core/catalog/types";
import { catalogBatches, catalogUploads, type CatalogBatch, type CatalogUpload } from "@catalog/core/db/schema";
import { accessStatus, checkLinkAccess, detectPastedText, NOTHING_TO_CHECK, pasteReadback } from "@catalog/core/catalog/ingest/detect";
import { collectGoogleSheetOnWeb, googleClients } from "@catalog/core/catalog/ingest/google-sheet";
import { collectDriveFolderOnWeb } from "@catalog/core/catalog/ingest/drive-folder";
import { readSupabaseFolder, type SupabaseListState, type SupabaseStorageLike } from "@catalog/core/catalog/ingest/supabase-folder";
import { canonicalFolderUrl, parseSupabaseFolderLink, withoutSupabaseFolders } from "@catalog/core/catalog/ingest/supabase-link";
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
  if (detected.kind === "supabase_folder") {
    // The paste box carrying on a folder still being read (one link, `continue: true`): never revives a removed row.
    if ((value as { continue?: unknown }).continue === true && !target) return addSupabaseFolder(id, client!, detected.ids[0]!, undefined, true);
    return addSupabaseFolders(id, client!, text, detected.ids, target);
  }
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
 *
 * A folder too large to list in one request (R1 exit finding 1: a whole brand of 477 product folders) is
 * read over several: the row stays `pending` ("reading") with where the listing got to in
 * `detected.supabaseFolder.listing`, the answer is `access: "reading"`, and the paste box sends the
 * folder link again with `continue: true`, which carries on from there until the row is `uploaded` (or failed).
 * A listing that paused on Supabase errors keeps its state on the failed row, so pasting again carries on.
 *
 * `resume` (a continuation): only a row that is still reading is carried on, and only forward. A folder removed
 * meanwhile stays removed and one another request finished stays finished; the answer then says what the row is.
 */
async function addSupabaseFolder(id: string, client: SupabaseStorageLike, link: string, target?: string, resume = false) {
  const parsed = parseSupabaseFolderLink(link);
  const key = parsed ? canonicalFolderUrl(parsed) : link;
  const prior = target
    ? (await db().select().from(catalogUploads).where(and(eq(catalogUploads.id, target), eq(catalogUploads.batchId, id))).limit(1))[0]
    : (await db().select().from(catalogUploads).where(folderRowOf(id, key, link)).limit(1))[0];
  if (resume && prior?.status !== "pending") return folderAnswer(prior);
  const read = await readSupabaseFolder(client, link, { state: listingOf(prior, key) });
  const values: LinkRowValues = read.ok
    ? { kind: "url_list", name: read.title, sourceUrl: read.text, status: "uploaded", error: null, detected: { kind: "url_list", fileCount: read.photos, title: read.title, message: read.message, supabaseFolder: { url: read.url, mode: read.mode, ...(read.small.length ? { small: read.small } : {}) } } }
    : read.reading
      ? { kind: "url_list", name: read.title, sourceUrl: read.url, status: "pending", error: null, detected: { kind: "url_list", title: read.title, message: read.message, supabaseFolder: { url: read.url, mode: "filename", listing: read.state } } }
      : read.state
        ? { kind: "url_list", name: read.title ?? "Supabase folder", sourceUrl: read.url ?? link, status: "failed", error: read.error, detected: { kind: "url_list", message: read.error, supabaseFolder: { url: read.url ?? key, mode: "filename", listing: read.state } } }
        : { kind: "url_list", name: "Supabase folder", sourceUrl: link, status: "failed", error: read.error, detected: { kind: "url_list", message: read.error, supabaseFolder: { url: link, mode: "filename" } } };
  // How far this request got, in folders listed: a finished folder (or a plain failure) counts as all the way.
  const reached = read.ok || !(read.reading || read.state) ? Infinity : (read.reading ? read.state : read.state!).folders;
  let uploadId: string;
  try {
    uploadId = await saveLinkRow(id, values, read.ok, async (tx) => {
      const [row] = target
        ? [await linkRowFor(tx, id, "url_list", link, target)]
        : await tx.select().from(catalogUploads).where(folderRowOf(id, key, link)).limit(1).for("update");
      if (resume && !(row?.status === "pending" && (listingOf(row, key)?.folders ?? 0) <= reached)) throw new Superseded(row ?? undefined);
      // A plain paste keeps the further of two reads of the same folder: a finished folder is not set back to
      // reading or paused, and a read further along is not overwritten by one behind it (review 2 P3-3).
      if (!resume && !target && row && progressOf(row, key) > reached) throw new Superseded(row);
      return row ?? null;
    });
  } catch (err) {
    if (err instanceof Superseded) return folderAnswer(err.row);
    throw err;
  }
  if (read.ok) return { kind: "supabase_folder", access: "ok", summary: read.message, count: read.photos, uploadId, pill: photosPill(read.photos) };
  if (read.reading) return { kind: "supabase_folder", access: "reading", summary: read.message, count: read.photos, uploadId, pill: SUPABASE_READING_PILL, folder: read.url };
  // A listing that paused on Supabase errors: Try again (or the same paste) carries on from where it stopped.
  if (read.state) return { kind: "supabase_folder", access: "paused", summary: read.error, uploadId, pill: SUPABASE_PAUSED_PILL, folder: read.url };
  return { kind: "supabase_folder", access: "no_access", summary: read.error, uploadId };
}
/** How far a folder row has got, in folders listed: finished is all the way, a fresh or failed row is nowhere. */
function progressOf(row: CatalogUpload, key: string): number {
  const url = (row.detected as { supabaseFolder?: { url?: string } } | null)?.supabaseFolder?.url;
  if ((row.status === "uploaded" || row.status === "collected") && url === key) return Infinity;
  return listingOf(row, key)?.folders ?? -Infinity;
}
/** The pill of a Supabase folder whose listing paused on Supabase errors. */
export const SUPABASE_PAUSED_PILL = "Paused";
/** A continuation found its row changed under it (removed, finished, or further along): nothing is written. */
class Superseded extends Error {
  readonly row: CatalogUpload | undefined;
  constructor(row: CatalogUpload | undefined) {
    super("superseded");
    this.row = row;
  }
}
/** The pill of a Supabase folder still being read. */
export const SUPABASE_READING_PILL = "Reading folder";
/** What a continuation answers when its folder row was removed from the batch: the paste box stops sending it. */
export const SUPABASE_FOLDER_REMOVED = "This folder was removed from the batch.";
const photosPill = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "photo" : "photos"}`;
/** The paste answer a folder row stands for now, without reading Supabase. */
function folderAnswer(row: CatalogUpload | undefined) {
  const detected = (row?.detected ?? {}) as { message?: string; fileCount?: number; supabaseFolder?: { url?: string } };
  if (!row || row.status === "removed") return { kind: "supabase_folder", access: "removed", summary: SUPABASE_FOLDER_REMOVED, uploadId: row?.id };
  if (row.status === "uploaded" || row.status === "collected") return { kind: "supabase_folder", access: "ok", summary: detected.message ?? "", count: detected.fileCount, uploadId: row.id, pill: photosPill(detected.fileCount ?? 0) };
  if (row.status === "pending") return { kind: "supabase_folder", access: "reading", summary: detected.message ?? "", uploadId: row.id, pill: SUPABASE_READING_PILL, folder: detected.supabaseFolder?.url };
  if (row.status === "failed" && listingOf(row, detected.supabaseFolder?.url ?? "")) return { kind: "supabase_folder", access: "paused", summary: row.error ?? "", uploadId: row.id, pill: SUPABASE_PAUSED_PILL, folder: detected.supabaseFolder?.url };
  return { kind: "supabase_folder", access: "no_access", summary: row.error ?? detected.message ?? "", uploadId: row.id };
}
/** The batch's row of one Supabase folder link (stored canonical; a failed paste keeps the link as pasted). */
function folderRowOf(id: string, key: string, link: string) {
  return and(eq(catalogUploads.batchId, id), eq(catalogUploads.kind, "url_list"), sql`${catalogUploads.detected}->'supabaseFolder'->>'url' IN (${key}, ${link})`);
}
/**
 * Where an unfinished listing of this folder got to, so the next request carries on; else a fresh listing. A row
 * still reading, or one whose listing paused on Supabase errors, carries on; a removed or finished row does not.
 */
function listingOf(row: CatalogUpload | null | undefined, key: string): SupabaseListState | undefined {
  if (!row || (row.status !== "pending" && row.status !== "failed")) return undefined;
  const folder = (row.detected as { supabaseFolder?: { url?: string; listing?: SupabaseListState } } | null)?.supabaseFolder;
  return folder?.url === key && folder.listing ? folder.listing : undefined;
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
