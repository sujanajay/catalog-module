// Step 2 data (spec 04, "Step 2 data"): what "Check what we found" shows, built from the batch's
// stored `catalog_uploads.detected` rows, its options and the source rows the ingest wrote. No
// guessing: a sheet whose identifier column could not be told says so and waits for the operator.
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogProducts, catalogSourceImages, catalogUploads, type CatalogUpload } from "../../db/schema";
import { signedUrl } from "../../storage";
import { IDENTIFIER_MODES, type IdentifierMode, type UploadKind } from "../types";
import type { Detected, DetectedStep2, IngestDeps } from "./types";

export const CANNOT_READ_IDENTIFIER = "Could not tell which column holds the identifier.";
/** Short TTL for the example thumbnails. */
export const EXAMPLE_THUMB_TTL_SEC = 900;
/** Thumbnails per example row. */
export const EXAMPLE_THUMBS = 5;
const EXAMPLES = 3;

const fmt = (n: number) => n.toLocaleString("en-US");
const collator = new Intl.Collator("en", { numeric: true });

// --- Pure helpers (the one copy; links-sheet.ts's detectColumns uses them and re-exports them) ---

/** Spreadsheet column letter: 0 -> A, 25 -> Z, 26 -> AA, 701 -> ZZ, 702 -> AAA. */
export function columnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`Not a column index: ${index}`);
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * First and last header joined with " to ", with the words they share dropped from the last one:
 * `Product Image 1` and `Product Image 6` give `Product Image 1 to 6`.
 */
export function headerRange(first: string, last: string): string {
  if (first === last) return first;
  const a = first.trim().split(/\s+/);
  const b = last.trim().split(/\s+/);
  let k = 0;
  while (k < a.length - 1 && k < b.length - 1 && a[k] === b[k]) k++;
  return `${first.trim()} to ${b.slice(k).join(" ")}`;
}

export interface SheetColumnsInput {
  identifierColumn: number;
  identifierHeader: string | null;
  styleColumn: number | null;
  colourColumn: number | null;
  urlColumns: number[];
  cannotRead?: string | null;
}

/** ` (<header>)`, or nothing when the header is blank (an unnamed column is named by its letter only). */
const inParens = (header: string | null | undefined) => (header && header.trim() ? ` (${header.trim()})` : "");

/**
 * The "Sheet columns" sentence: `We will use column B (Vendor Style Number) as the identifier and
 * columns H to M (Product Image 1 to 6) as photos.`; with a composite key `Grouped by style and
 * colour code (<style header> + <colour header>)`; the cannot-read sentence when no column was told.
 * A blank header leaves its parentheses out (`columns C to D as photos.`).
 */
export function sheetColumnsSentence(d: SheetColumnsInput, headers: string[]): string {
  const h = (i: number) => (headers[i] ?? "").trim();
  if (d.styleColumn !== null && d.colourColumn !== null) return `Grouped by style and colour code (${h(d.styleColumn)} + ${h(d.colourColumn)})`;
  if (d.identifierColumn < 0 || d.cannotRead) return d.cannotRead || CANNOT_READ_IDENTIFIER;
  const id = `We will use column ${columnLetter(d.identifierColumn)}${inParens(d.identifierHeader ?? h(d.identifierColumn))} as the identifier`;
  const urls = [...d.urlColumns].sort((x, y) => x - y);
  if (!urls.length) return `${id}.`;
  const first = urls[0]!;
  const last = urls[urls.length - 1]!;
  if (urls.length === 1) return `${id} and column ${columnLetter(first)}${inParens(h(first))} as photos.`;
  const range = h(first) && h(last) ? inParens(headerRange(h(first), h(last))) : "";
  return `${id} and columns ${columnLetter(first)} to ${columnLetter(last)}${range} as photos.`;
}

/** `<a> JPG, <b> PNG (transparent backgrounds kept), <c> HEIC (iPhone format, converted automatically), <d> other.` */
export function formatsSentence(f: { jpg: number; png: number; heic: number; other: number }): string {
  const parts = [`${fmt(f.jpg)} JPG`];
  if (f.png > 0) parts.push(`${fmt(f.png)} PNG (transparent backgrounds kept)`);
  if (f.heic > 0) parts.push(`${fmt(f.heic)} HEIC (iPhone format, converted automatically)`);
  if (f.other > 0) parts.push(`${fmt(f.other)} other`);
  return `${parts.join(", ")}.`;
}

/** Maximal runs of adjacent columns: [7, 8, 9, 12, 13] gives [[7, 8, 9], [12, 13]]. */
function runs(columns: number[]): number[][] {
  const out: number[][] = [];
  for (const c of [...new Set(columns)].sort((a, b) => a - b)) {
    const run = out[out.length - 1];
    if (run && run[run.length - 1] === c - 1) run.push(c);
    else out.push([c]);
  }
  return out;
}

// --- Upload classification -----------------------------------------------------------------

const FILE_KINDS: UploadKind[] = ["zip", "image", "drive_folder"];
const LINK_KINDS: UploadKind[] = ["sheet", "google_sheet", "url_list"];
const SHEET_KINDS: UploadKind[] = ["sheet", "google_sheet", "product_list"];

const BLOCKED = [/block sharing with our address/, /too large to read directly/];

function detectedOf(u: CatalogUpload): Detected | null {
  return (u.detected as Detected | null) ?? null;
}

/** The upload's kind after content detection and the step 2 choice: a sheet without image columns is a product list. */
function effectiveKind(u: CatalogUpload): UploadKind {
  const d = detectedOf(u);
  if (u.kind === "product_list" || d?.kind === "product_list") return "product_list";
  if (SHEET_KINDS.includes(u.kind) && d && Array.isArray(d.urlColumns) && d.urlColumns.length === 0 && (d.identifierColumn ?? -1) >= 0) return "product_list";
  return u.kind;
}

/** True for a purely numeric stem of up to three digits (`1.jpg`, `02.jpg`): a shot with no identifier. */
const isNumericStem = (name: string) => /^\s*\d{1,3}\s*(\.[^./\\]*)?$/.test(name.split(/[\\/]/).pop() ?? "");

/**
 * Step 2 data for one batch. `extra.sign` (after the contract's parameters) signs the example
 * thumbnails; it defaults to `signedUrl` with a short TTL. `deps` is kept for the contract; this
 * function reads only the database.
 */
export async function buildDetectedStep2(
  db: Db,
  batchId: string,
  _deps: Pick<IngestDeps, "storage">,
  extra: { sign?: (gsUri: string) => Promise<string> } = {},
): Promise<DetectedStep2> {
  const sign = extra.sign ?? ((u: string) => signedUrl(u, EXAMPLE_THUMB_TTL_SEC));
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error("This batch does not exist.");
  const options = batch.options;
  const uploads = await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, batchId)).orderBy(asc(catalogUploads.createdAt), asc(catalogUploads.id));
  const sources = await db
    .select({ productId: catalogSourceImages.productId, identifier: catalogProducts.identifier, n: catalogSourceImages.n, rawUri: catalogSourceImages.rawUri, originalName: catalogSourceImages.originalName, uploadId: catalogSourceImages.uploadId })
    .from(catalogSourceImages)
    .innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId))
    .where(eq(catalogSourceImages.batchId, batchId));

  const kinds = uploads.map(effectiveKind);
  const linksSheets = uploads.filter((u, i) => (kinds[i] === "sheet" || kinds[i] === "google_sheet") && detectedOf(u));
  const productLists = uploads.filter((_, i) => kinds[i] === "product_list");
  const fileUploadIds = new Set(uploads.filter((_, i) => FILE_KINDS.includes(kinds[i]!)).map((u) => u.id));
  const hasFiles = fileUploadIds.size > 0;

  // Identifier mode.
  const imageSources = kinds.filter((k) => k !== "product_list");
  const files = sources.filter((s) => s.uploadId !== null && fileUploadIds.has(s.uploadId));
  const hasFolders =
    uploads.some((u, i) => kinds[i] === "drive_folder" || (detectedOf(u)?.topLevelFolders?.length ?? 0) > 0) ||
    files.some((s) => /[\\/]/.test(s.originalName));
  let detectedMode: IdentifierMode = "filename";
  if (imageSources.length && imageSources.every((k) => k === "sheet" || k === "google_sheet")) detectedMode = "sheet_column";
  else if (files.length && files.filter((s) => isNumericStem(s.originalName)).length * 2 > files.length) detectedMode = "folder";
  const modeOptions = IDENTIFIER_MODES.filter(
    (m) => m === "filename" || m === options.identifierMode || m === detectedMode || (m === "folder" ? hasFolders : linksSheets.length > 0),
  );

  // The links sheet behind the "Sheet columns" card and the sheet_column wording.
  const sheet = linksSheets[0] ?? null;
  const sd = sheet ? detectedOf(sheet)! : null;
  const headers = sd?.columns ?? [];
  const override = options.sheetColumns;
  const composite = !override && sd?.styleColumn != null && sd?.colourColumn != null;
  const sheetIdColumn = override?.identifier ?? sd?.identifierColumn ?? -1;
  const sheetIdHeader = override ? headers[override.identifier] ?? null : sd?.identifierHeader ?? (sheetIdColumn >= 0 ? headers[sheetIdColumn] ?? null : null);

  // Examples: the first three products of the batch, in identifier order.
  const byProduct = new Map<string, typeof sources>();
  for (const s of sources) byProduct.set(s.productId, [...(byProduct.get(s.productId) ?? []), s]);
  const picked = [...byProduct.values()]
    .map((rows) => rows.sort((a, b) => a.n - b.n))
    .sort((a, b) => collator.compare(a[0]!.identifier, b[0]!.identifier))
    .slice(0, EXAMPLES);
  const examples = await Promise.all(
    picked.map(async (rows) => {
      const id = rows[0]!.identifier;
      const k = rows.length;
      const thumbs = await Promise.all(rows.slice(0, EXAMPLE_THUMBS).map((r) => sign(r.rawUri)));
      if (options.identifierMode === "folder") return { identifier: `${id}/`, label: `${fmt(k)} files in the folder`, thumbs };
      if (options.identifierMode === "sheet_column") {
        const col = sheetIdColumn >= 0 ? `column ${columnLetter(sheetIdColumn)}, ` : "";
        return { identifier: id, label: `${col}${fmt(k)} photo links`, thumbs };
      }
      return { identifier: id, label: k > 1 ? `from ${id}_1.jpg ... _${k}.jpg` : `from ${id}_1.jpg`, thumbs };
    }),
  );

  // The announcement line above the grouping table.
  let groupedBy: string;
  const tokenList = productLists.find((u) => detectedOf(u)?.styleColumn != null && detectedOf(u)?.colourColumn != null);
  if (options.identifierMode === "sheet_column") {
    groupedBy = composite
      ? `Grouped by style and colour code (${headers[sd!.styleColumn!] ?? ""} + ${headers[sd!.colourColumn!] ?? ""})`
      : `Grouped by the sheet column ${sheetIdHeader ?? ""}`;
  } else if (options.identifierMode === "folder") {
    groupedBy = "Grouped by folder name";
  } else if (tokenList && hasFiles) {
    groupedBy = "Matched by style and colour code found inside the file names";
  } else {
    groupedBy = "Grouped by file name (<identifier>_<n>)";
  }

  const formats = { jpg: 0, png: 0, heic: 0, other: 0 };
  for (const u of uploads) {
    const f = detectedOf(u)?.formats;
    if (!f) continue;
    formats.jpg += f.jpg ?? 0;
    formats.png += f.png ?? 0;
    formats.heic += f.heic ?? 0;
    formats.other += f.other ?? 0;
  }

  let sheetColumns: DetectedStep2["sheetColumns"] = null;
  if (sd) {
    const images = override?.images ?? sd.urlColumns ?? [];
    const sentence = sheetColumnsSentence(
      {
        identifierColumn: sheetIdColumn, identifierHeader: sheetIdHeader,
        styleColumn: composite ? sd.styleColumn! : null, colourColumn: composite ? sd.colourColumn! : null,
        urlColumns: images, cannotRead: override ? null : sd.cannotRead ?? null,
      },
      headers,
    );
    sheetColumns = {
      identifier: sheetIdColumn,
      images,
      sentence,
      choices: {
        identifier: headers.map((header, column) => ({ column, header })),
        images: runs(sd.urlColumns ?? []).map((columns) => ({ columns, header: headerRange(headers[columns[0]!] ?? "", headers[columns[columns.length - 1]!] ?? "") })),
      },
    };
  }

  const sheets: DetectedStep2["sheets"] = [];
  uploads.forEach((u, i) => {
    const d = detectedOf(u);
    if (!SHEET_KINDS.includes(u.kind) || !d) return;
    // Not read yet: the upload finished but the ingest has not written its columns. A failed upload
    // (for example a Google Sheet without access) is not "reading"; it keeps its cannot-read sentence.
    const reading = !Array.isArray(d.columns) && u.status !== "failed" && !u.error;
    const identifierColumn = d.identifierColumn ?? d.matchColumn ?? -1;
    sheets.push({
      uploadId: u.id,
      name: d.title ?? u.name,
      identifierColumn,
      identifierHeader: d.identifierHeader ?? (identifierColumn >= 0 ? d.columns?.[identifierColumn] ?? null : null),
      imageColumns: d.urlColumns ?? [],
      kind: kinds[i] === "product_list" ? "product_list" : "sheet",
      reading,
      cannotRead: reading ? null : identifierColumn < 0 ? d.cannotRead || CANNOT_READ_IDENTIFIER : null,
    });
  });

  const googleAccess: DetectedStep2["googleAccess"] = [];
  for (const u of uploads) {
    if (u.kind !== "google_sheet" && u.kind !== "drive_folder") continue;
    const url = u.sourceUrl ?? u.name;
    if (u.error) googleAccess.push({ url, kind: u.kind, status: BLOCKED.some((p) => p.test(u.error!)) ? "blocked" : "no_access", sentence: u.error });
    else if (detectedOf(u)) googleAccess.push({ url, kind: u.kind, status: "ok", sentence: detectedOf(u)!.message });
  }

  return {
    identifierMode: { detected: detectedMode, options: modeOptions, examples },
    groupedBy,
    precedence: { shown: kinds.some((k) => FILE_KINDS.includes(k)) && kinds.some((k) => LINK_KINDS.includes(k)), default: "uploads_then_links" },
    formats: { ...formats, sentence: formatsSentence(formats) },
    sheetColumns,
    sheets,
    googleAccess,
  };
}
