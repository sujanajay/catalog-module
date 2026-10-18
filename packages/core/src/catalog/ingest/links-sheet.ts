// Links sheets (spec 04, "Links sheet"): an xlsx or csv whose rows are products and whose URL
// columns are the photos. Column detection is deterministic and never guesses: when the identifier
// column cannot be told, the sheet is refused with "Could not tell which column holds the
// identifier." and step 2 asks the operator. Columns are 0-based everywhere (as in
// BatchOptions.sheetColumns and 02's fillProductListWorkbook); row numbers in sentences are the
// spreadsheet's own 1-based numbers.
import ExcelJS from "exceljs";
import { parseCsv } from "../../csv";
import { normalizeKey } from "../naming";
import type { BatchOptions, UploadKind } from "../types";
import { CANNOT_READ_IDENTIFIER, columnLetter, sheetColumnsSentence } from "./detect-step";
import type { Adapter, CollectInput, Detected, SourceItem } from "./types";

export interface SheetTable { title: string; header: string[]; rows: string[][] }

export interface ColumnDetection {
  headerRow: number; identifierColumn: number; identifierHeader: string | null;
  styleColumn: number | null; colourColumn: number | null; urlColumns: number[]; eanColumn: number | null;
  isProductList: boolean; cannotRead: string | null; sentence: string;
}

/** A SourceItem read from a sheet row, with the row and column its URL came from (for the failure sentence). */
export interface SheetSourceItem extends SourceItem { sheetRow: number; sheetHeader: string }

// The column letter, the cannot-read sentence and the step 2 sentence have one copy, in detect-step.ts.
export { CANNOT_READ_IDENTIFIER, columnLetter };

/** Rows scanned for the header row; a header lower than this is not looked for. */
const HEADER_SCAN_ROWS = 20;

/** lowercase, every character that is not a letter or digit removed. */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// Known headings, compared after normalizeHeader. A key matches a heading equal to it, ending with
// it ("Vendor Style Number" ends with "stylenumber") or equal to it plus "id" ("Option ID").
const ID_KEYS = ["identifier", "option", "optionidstylecolor", "optionidstylecolour"];
const STYLE_KEYS = ["style", "stylenumber", "styleid", "stylecode", "styleno"];
const COLOUR_CODE_KEYS = ["colorcode", "colourcode", "colorid", "colourid"];
const COLOUR_NAME_KEYS = ["colourname", "colorname", "colour", "color"];
const EAN_KEYS = ["ean", "barcode", "gtin", "upc"];
const URL_WORDS = ["url", "link", "image"];
const OTHER_KNOWN = [
  "sku", "opptrasku", "size", "brand", "name", "productname", "description", "category", "gender",
  "price", "mrp", "itemcode", "itemno", "article", "articleno", "productcode", "quantity", "qty",
];

function keyMatch(h: string, keys: readonly string[]): boolean {
  return h !== "" && keys.some((k) => h === k || h.endsWith(k) || h === `${k}id`);
}
const isEanHeader = (h: string) => h !== "" && EAN_KEYS.some((k) => h.startsWith(k) || h.endsWith(k));
const isUrlHeader = (h: string) => URL_WORDS.some((w) => h.includes(w));
const isColourCodeHeader = (h: string) => keyMatch(h, COLOUR_CODE_KEYS);
const isColourNameHeader = (h: string) => !isColourCodeHeader(h) && keyMatch(h, COLOUR_NAME_KEYS);
const isKnownHeading = (h: string) =>
  keyMatch(h, ID_KEYS) || keyMatch(h, STYLE_KEYS) || isColourCodeHeader(h) || isColourNameHeader(h) ||
  isEanHeader(h) || (h !== "" && isUrlHeader(h)) || keyMatch(h, OTHER_KNOWN);

const URL_RE = /^https?:\/\//i;

/** The URL tokens of a cell: split on "," and ";", trimmed, http(s) only. */
export function cellUrls(cell: string | undefined): string[] {
  return (cell ?? "").split(/[,;]/).map((s) => s.trim()).filter((s) => URL_RE.test(s));
}

/** The step 2 sentence for a detection (detect-step.ts's sheetColumnsSentence on this sheet's header). */
function columnsSentence(header: string[], d: Pick<ColumnDetection, "identifierColumn" | "styleColumn" | "colourColumn" | "urlColumns" | "cannotRead">): string {
  const identifierHeader = d.identifierColumn >= 0 ? (header[d.identifierColumn] ?? "") : null;
  return sheetColumnsSentence({ ...d, identifierHeader }, header);
}

// --- Reading ----------------------------------------------------------------

function cellString(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    // A hyperlinked cell ("Image 1" linking to the photo) counts as its link.
    if ("hyperlink" in v) return URL_RE.test(v.hyperlink) ? v.hyperlink : cellString(v.text as ExcelJS.CellValue);
    if ("formula" in v || "sharedFormula" in v) return cellString(v.result as ExcelJS.CellValue);
    if ("error" in v) return "";
  }
  return String(v);
}

function trimTrailingEmpty(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.every((c) => c === "")) end--;
  return rows.slice(0, end);
}

/** A table from a grid whose first row is spreadsheet row 1 (header detection happens later). */
export function sheetTableFromRows(title: string, grid: string[][]): SheetTable {
  const rows = trimTrailingEmpty(grid.map((r) => r.map((c) => (c ?? "").trim())));
  return { title, header: rows[0] ?? [], rows: rows.slice(1) };
}

const isZip = (buf: Buffer) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/** One worksheet as a table (see below), and every worksheet name (the product list records them). */
export async function loadSheet(buf: Buffer, name: string): Promise<{ table: SheetTable; sheetNames: string[] }> {
  const title = name.split(/[\\/]/).pop() ?? name;
  if (/\.csv$/i.test(name) || !isZip(buf)) {
    return { table: sheetTableFromRows(title, parseCsv(buf.toString("utf8"))), sheetNames: [title] };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  // The first worksheet with a header row, so a notes tab in front of the data is passed over;
  // else the first worksheet with any data.
  const tables = wb.worksheets.filter((w) => w.actualRowCount > 0).map((ws) => {
    const grid: string[][] = [];
    const width = ws.columnCount;
    ws.eachRow((row, rowNumber) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellString(row.getCell(c).value));
      while (grid.length < rowNumber - 1) grid.push([]);
      grid.push(cells);
    });
    return sheetTableFromRows(title, grid);
  });
  const table = tables.find((t) => headerIndex(t) !== null) ?? tables[0] ?? sheetTableFromRows(title, []);
  return { table, sheetNames: wb.worksheets.map((w) => w.name) };
}

/** xlsx via ExcelJS workbook.xlsx.load + eachRow; csv via parseCsv. Title = the file name. */
export async function readSheetTable(buf: Buffer, name: string): Promise<SheetTable> {
  return (await loadSheet(buf, name)).table;
}

/** Data rows below the header row, with their spreadsheet row numbers; empty rows left out. */
export function sheetDataRows(table: SheetTable, headerRow: number): { r: number; cells: string[] }[] {
  const all = [table.header, ...table.rows];
  const out: { r: number; cells: string[] }[] = [];
  for (let i = headerRow; i < all.length; i++) {
    const cells = all[i]!;
    if (cells.some((c) => c !== "")) out.push({ r: i + 1, cells });
  }
  return out;
}

// --- Column detection --------------------------------------------------------

const isText = (c: string) => c !== "" && !/^[\d.,\s-]+$/.test(c) && !URL_RE.test(c);

/** 0-based index of the first row where at least half the cells are text and two match a known heading, or null. */
function headerIndex(table: SheetTable): number | null {
  const all = [table.header, ...table.rows];
  const width = Math.max(0, ...all.map((r) => r.length));
  for (let i = 0; i < Math.min(all.length, HEADER_SCAN_ROWS); i++) {
    const row = all[i]!;
    const text = row.filter(isText).length;
    const known = row.filter((c) => !URL_RE.test(c) && isKnownHeading(normalizeHeader(c))).length;
    if (text * 2 >= width && known >= 2) return i;
  }
  return null;
}

/**
 * Deterministic column detection (spec 04 "Column detection rules"):
 * header row = the first row where at least half the cells are non-empty text and two match a known
 * heading (else the first non-empty row); URL column = http(s) in at least half the non-empty cells or
 * a header containing url, link or image; EAN never the identifier; identifier = an identifier/option
 * heading, else style + colour code as a composite key, else the first non-URL column whose values
 * are at least 90% unique (and filled on at least half the rows); else -1 with cannotRead.
 */
export function detectColumns(table: SheetTable): ColumnDetection {
  const all = [table.header, ...table.rows];
  const width = Math.max(0, ...all.map((r) => r.length));
  const found = headerIndex(table);
  const h = found ?? Math.max(0, all.findIndex((r) => r.some((c) => c !== "")));
  const headerRow = h + 1;
  const header = Array.from({ length: width }, (_, c) => all[h]?.[c] ?? "");
  const nh = header.map(normalizeHeader);
  const data = sheetDataRows(table, headerRow).map((x) => x.cells);
  const column = (c: number) => data.map((r) => (r[c] ?? "").trim()).filter((v) => v !== "");

  const eanColumn = nh.findIndex(isEanHeader);
  const ean = eanColumn >= 0 ? eanColumn : null;
  const urlColumns: number[] = [];
  for (let c = 0; c < width; c++) {
    if (c === ean) continue;
    const values = column(c);
    if (!values.length) continue;
    const withUrl = values.filter((v) => cellUrls(v).length > 0).length;
    if (withUrl * 2 >= values.length || isUrlHeader(nh[c]!)) urlColumns.push(c);
  }
  const usable = (c: number) => c !== ean && !urlColumns.includes(c);
  const first = (pred: (h: string) => boolean) => nh.findIndex((x, c) => usable(c) && pred(x));

  let identifierColumn = first((x) => keyMatch(x, ID_KEYS));
  let styleColumn: number | null = null;
  let colourColumn: number | null = null;
  if (identifierColumn < 0) {
    const style = first((x) => keyMatch(x, STYLE_KEYS) && !isColourCodeHeader(x));
    const colour = first(isColourCodeHeader);
    if (style >= 0 && colour >= 0) {
      identifierColumn = style;
      styleColumn = style;
      colourColumn = colour;
    }
  }
  if (identifierColumn < 0) {
    for (let c = 0; c < width; c++) {
      if (!usable(c) || isColourNameHeader(nh[c]!)) continue;
      const values = column(c);
      if (!values.length || values.length * 2 < data.length) continue;
      if (new Set(values.map(normalizeKey)).size >= 0.9 * values.length) {
        identifierColumn = c;
        break;
      }
    }
  }
  const cannotRead = identifierColumn < 0 ? CANNOT_READ_IDENTIFIER : null;
  const identifierHeader =
    identifierColumn < 0 ? null : styleColumn !== null && colourColumn !== null ? `${header[styleColumn]} + ${header[colourColumn]}` : header[identifierColumn]!;
  const detection = { headerRow, identifierColumn, identifierHeader, styleColumn, colourColumn, urlColumns, eanColumn: ean, isProductList: urlColumns.length === 0, cannotRead };
  return { ...detection, sentence: columnsSentence(header, detection) };
}

/** The detection with step 2's `options.sheetColumns` applied (the operator's choice wins; no composite key). */
export function applySheetColumns(table: SheetTable, detection: ColumnDetection, chosen: BatchOptions["sheetColumns"]): ColumnDetection {
  if (!chosen) return detection;
  const header = [table.header, ...table.rows][detection.headerRow - 1] ?? [];
  const d = {
    ...detection,
    identifierColumn: chosen.identifier, identifierHeader: header[chosen.identifier] ?? "",
    styleColumn: null, colourColumn: null, urlColumns: [...chosen.images],
    isProductList: chosen.images.length === 0, cannotRead: null,
  };
  return { ...d, sentence: columnsSentence(header, d) };
}

// --- Rows to items -------------------------------------------------------------

/** Last path segment of a URL, decoded; the URL itself when it has none. */
export function urlFileName(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : url;
  } catch {
    return url;
  }
}

export function extOf(name: string): string {
  const base = name.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export interface LinksSheetResult {
  table: SheetTable;
  detection: ColumnDetection;                 // with options.sheetColumns applied
  items: SheetSourceItem[];
  rejected: { name: string; reason: string }[];   // "Row <r> has no identifier."
  warnings: string[];                             // the duplicate-identifier sentence
  detected: Detected;                             // for catalog_uploads.detected
}

/**
 * Turn the rows of a links sheet into items. URL column order is shot order and a cell with several
 * URLs continues the numbering; a row without an identifier is rejected; a repeated normalised
 * identifier keeps its first row only.
 */
export function readLinksSheet(table: SheetTable, options: Pick<BatchOptions, "sheetColumns">, ctx: { uploadId: string; origin: UploadKind; message?: string }): LinksSheetResult {
  const detection = applySheetColumns(table, detectColumns(table), options.sheetColumns);
  const header = [table.header, ...table.rows][detection.headerRow - 1] ?? [];
  const items: SheetSourceItem[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const warnings: string[] = [];
  const rows = sheetDataRows(table, detection.headerRow);

  if (detection.identifierColumn >= 0) {
    const composite = detection.styleColumn !== null && detection.colourColumn !== null;
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const { r, cells } of rows) {
      const at = (c: number) => (cells[c] ?? "").trim();
      const identifier = composite
        ? at(detection.styleColumn!) && at(detection.colourColumn!) ? `${at(detection.styleColumn!)}_${at(detection.colourColumn!)}` : ""
        : at(detection.identifierColumn);
      if (!identifier) {
        rejected.push({ name: `Row ${r}`, reason: `Row ${r} has no identifier.` });
        continue;
      }
      const key = normalizeKey(identifier);
      if (seen.has(key)) {
        repeated.add(key);
        continue;
      }
      seen.add(key);
      let n = 0;
      for (const c of detection.urlColumns) {
        for (const url of cellUrls(cells[c])) {
          const originalName = urlFileName(url);
          items.push({
            identifier, n: ++n, suffix: "", originalName, folder: null, sheetIdentifier: identifier,
            ext: extOf(originalName), bytes: { kind: "url", url }, uploadId: ctx.uploadId, origin: ctx.origin,
            warnings: [], sheetRow: r, sheetHeader: header[c] || columnLetter(c),
          });
        }
      }
    }
    if (repeated.size) warnings.push(`${repeated.size} identifiers appear more than once in ${table.title}; the first row of each is used.`);
  }

  const detected: Detected = {
    kind: ctx.origin, title: table.title, rows: rows.length, columns: header, headerRow: detection.headerRow,
    identifierColumn: detection.identifierColumn,
    ...(detection.identifierHeader !== null ? { identifierHeader: detection.identifierHeader } : {}),
    styleColumn: detection.styleColumn, colourColumn: detection.colourColumn, urlColumns: detection.urlColumns,
    eanColumn: detection.eanColumn, cannotRead: detection.cannotRead, rejected,
    message: ctx.message ?? detection.sentence,
  };
  return { table, detection, items, rejected, warnings, detected };
}

/** Read a sheet upload from our bucket (`upload.gcsUri`, or `source` for the Google Sheet copy). */
export async function readLinksSheetUpload(input: CollectInput, source?: { gsUri: string; name: string; title?: string }): Promise<LinksSheetResult> {
  const gsUri = source?.gsUri ?? input.upload.gcsUri;
  if (!gsUri) throw new Error(`The sheet ${input.upload.name} has not been uploaded yet.`);
  const { buf } = await input.deps.storage.downloadBuffer(gsUri);
  const table = await readSheetTable(buf, source?.name ?? input.upload.name);
  if (source?.title) table.title = source.title;
  return readLinksSheet(table, input.options, { uploadId: input.upload.id, origin: input.upload.kind });
}

/** kind "sheet": items with bytes {kind:"url"} and sheetIdentifier; honours options.sheetColumns. */
export const linksSheetAdapter: Adapter = {
  kind: "sheet",
  async collect(input) {
    return (await readLinksSheetUpload(input)).items;
  },
};
