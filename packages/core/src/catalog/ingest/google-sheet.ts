// Google Sheets (spec 04, "Google Sheet and Drive folder"). The operator shares with one address,
// catalog-web@ (SHARE_SA_EMAIL), so the web tier reads the sheet and writes it as a csv under the
// batch's uploads/<uploadId>/; the worker then reads that csv like a dropped links sheet.
//
// Writing catalog_uploads: collectGoogleSheetOnWeb and collectDriveFolderOnWeb take an optional
// `db` as their last argument. With it they write the upload row themselves (`detected`, `status`
// "uploaded" or "failed", `error`, `gcs_uri`); either way they return what they found, the same
// `Detected | { kind, error }` shape checkLinkAccess returns, so 06 can show the sentence.
import { eq } from "drizzle-orm";
import { buildCsv } from "../../csv";
import type { Db } from "../../db/client";
import { catalogUploads } from "../../db/schema";
import { getBucketName, toGsUri } from "../../storage";
import { uploadPath } from "../naming";
import type { UploadKind } from "../types";
import { detectColumns, readLinksSheetUpload, sheetDataRows, sheetTableFromRows, type SheetTable } from "./links-sheet";
import type { Adapter, CollectInput, Detected, DriveLike, SheetsLike } from "./types";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

/** Production clients (Application Default Credentials, read-only scopes). Tests pass fakes instead. */
export async function googleClients(): Promise<{ sheets: SheetsLike; drive: DriveLike }> {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ scopes: GOOGLE_SCOPES });
  return {
    sheets: google.sheets({ version: "v4", auth }) as unknown as SheetsLike,
    drive: google.drive({ version: "v3", auth }) as unknown as DriveLike,
  };
}

// --- The access-check sentences (prototype copy) --------------------------------

export const SHEET_NO_ACCESS = "Share the sheet with the address above, then paste again.";
export const FOLDER_NO_ACCESS = "Share the folder with the address above, then paste again.";
export const GOOGLE_POLICY_BLOCKED = "Your Google settings block sharing with our address. Download the folder as a zip and drop it instead.";

/** HTTP status and searchable text of a googleapis (gaxios) error. */
function googleError(err: unknown): { status: number | null; text: string } {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; message?: unknown; errors?: unknown; response?: { status?: unknown; data?: unknown } };
  const status = [e.status, e.response?.status, e.code].map(Number).find((n) => Number.isInteger(n) && n >= 100 && n < 600) ?? null;
  const text = [String(e.message ?? ""), JSON.stringify(e.errors ?? null), JSON.stringify(e.response?.data ?? null)].join(" ");
  return { status, text };
}

/**
 * The operator sentence for a Google access error, or null when the error is not about access (the
 * caller rethrows it). A 403 that mentions domain policy or cannotShareOutsideDomain is the
 * Workspace block; any other 403 or a 404 means the item is not shared with us.
 */
export function googleAccessError(err: unknown, what: "sheet" | "folder"): string | null {
  const { status, text } = googleError(err);
  if (status === 403 && /cannotShareOutsideDomain|domain policy|domainPolicy/i.test(text)) return GOOGLE_POLICY_BLOCKED;
  if (status === 403 || status === 404) return what === "sheet" ? SHEET_NO_ACCESS : FOLDER_NO_ACCESS;
  return null;
}

// --- Links ---------------------------------------------------------------------------

/** The spreadsheet id of a docs.google.com/spreadsheets link; the tab is read by parseSheetGid. */
export function parseSpreadsheetId(url: string): string | null {
  const m = /docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/i.exec(url);
  return m ? m[1]! : null;
}

/** The tab id from `#gid=<n>` (or `?gid=<n>`), or null. */
export function parseSheetGid(url: string): number | null {
  const m = /[#?&]gid=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** A1 range for a whole tab: the title in single quotes, inner quotes doubled. */
function tabRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * Read one tab (the `#gid=` tab, else the first) as a SheetTable titled with the spreadsheet title.
 * Throws the googleapis error on failure (see googleAccessError).
 */
export async function readGoogleSheet(sheets: SheetsLike, url: string): Promise<{ title: string; tab: string; table: SheetTable }> {
  const spreadsheetId = parseSpreadsheetId(url);
  if (!spreadsheetId) throw new Error(`Not a Google Sheet link: ${url.split(/[?#]/)[0]}`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties(sheetId,title)" });
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties ?? {});
  const gid = parseSheetGid(url);
  const tab = (gid !== null ? tabs.find((t) => t.sheetId === gid) : undefined) ?? tabs[0];
  const tabTitle = tab?.title ?? "Sheet1";
  const title = meta.data.properties?.title ?? tabTitle;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabRange(tabTitle) });
  const grid = (res.data.values ?? []).map((row) => (row ?? []).map((v) => (v === null || v === undefined ? "" : String(v))));
  return { title, tab: tabTitle, table: sheetTableFromRows(title, grid) };
}

/** What a readable sheet shows: `Google Sheet "<title>", <n> rows, <m> image columns found.` */
export function googleSheetDetected(title: string, table: SheetTable): Detected {
  const d = detectColumns(table);
  const rows = sheetDataRows(table, d.headerRow).length;
  return {
    kind: "google_sheet", title, rows, columns: [table.header, ...table.rows][d.headerRow - 1] ?? [], headerRow: d.headerRow,
    identifierColumn: d.identifierColumn, ...(d.identifierHeader !== null ? { identifierHeader: d.identifierHeader } : {}),
    styleColumn: d.styleColumn, colourColumn: d.colourColumn, urlColumns: d.urlColumns, eanColumn: d.eanColumn,
    cannotRead: d.cannotRead,
    message: `Google Sheet "${title}", ${rows} rows, ${d.urlColumns.length} image columns found.`,
  };
}

// --- Web tier collection ---------------------------------------------------------------

export type WebCollectResult = Detected | { kind: UploadKind; error: string };

/** Write the outcome of a web collection to the upload row. */
export async function saveWebCollection(db: Db, uploadId: string, result: WebCollectResult, gcsUri: string | null): Promise<void> {
  const failed = "error" in result;
  const detected: Detected = failed ? { kind: result.kind, message: result.error } : result;
  await db
    .update(catalogUploads)
    .set({
      detected: detected as unknown as Record<string, unknown>,
      status: failed ? "failed" : "uploaded",
      error: failed ? result.error : null,
      ...(gcsUri ? { gcsUri } : {}),
    })
    .where(eq(catalogUploads.id, uploadId));
}

/** Web tier: read the sheet as catalog-web@, write it as <uploads>/<uploadId>/<title>.csv, set detected. */
export async function collectGoogleSheetOnWeb(input: CollectInput, db?: Db): Promise<WebCollectResult> {
  const { upload, deps, prefix } = input;
  const url = upload.sourceUrl ?? upload.name;
  if (!deps.sheets) throw new Error("The Google Sheets client is not configured.");
  let read: Awaited<ReturnType<typeof readGoogleSheet>>;
  try {
    read = await readGoogleSheet(deps.sheets, url);
  } catch (err) {
    const sentence = googleAccessError(err, "sheet");
    if (!sentence) throw err;
    const result = { kind: "google_sheet" as const, error: sentence };
    if (db) await saveWebCollection(db, upload.id, result, null);
    return result;
  }
  const csv = buildCsv(read.table.header, read.table.rows);
  const gsUri = await deps.storage.uploadBuffer(uploadPath(prefix, upload.id, `${read.title}.csv`), Buffer.from(csv, "utf8"), "text/csv");
  input.onProgress?.(1, 1);
  const detected = googleSheetDetected(read.title, read.table);
  if (db) await saveWebCollection(db, upload.id, detected, gsUri);
  return detected;
}

/** The csv the web tier wrote: `upload.gcsUri`, else the first .csv under uploads/<uploadId>/. */
export async function sheetCopyUri(input: CollectInput): Promise<string> {
  const { upload, deps, prefix } = input;
  if (upload.gcsUri) return upload.gcsUri;
  const listed = await deps.storage.listObjects(toGsUri(getBucketName(), `${prefix}/uploads/${upload.id}/`));
  const csv = listed.find((u) => /\.csv$/i.test(u));
  if (!csv) throw new Error(`The Google Sheet ${upload.name} has not been copied yet. Paste the link again.`);
  return csv;
}

/** kind "google_sheet": worker side, reads the csv written above like a links sheet. */
export const googleSheetAdapter: Adapter = {
  kind: "google_sheet",
  async collect(input) {
    const gsUri = await sheetCopyUri(input);
    const title = typeof input.upload.detected?.title === "string" ? input.upload.detected.title : undefined;
    return (await readLinksSheetUpload(input, { gsUri, name: gsUri.split("/").pop() ?? "sheet.csv", title })).items;
  },
};
