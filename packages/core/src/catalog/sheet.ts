// Links sheet writers (spec 02, "Links sheet"). One grid is built once and written both as xlsx
// (two header rows, a merged channel label over "Image 1..N") and as csv (flat "<Channel> Image n"
// header), so the two files always carry the same cells; compareXlsxCsv checks that.
import ExcelJS from "exceljs";
import { buildCsv, parseCsv } from "../csv";
import { channel } from "./channels";
import { normalizeKey } from "./naming";
import { CHANNEL_IDS, type ChangeKind, type ChannelId, type SheetStatus } from "./types";

export interface SheetRow {
  brand: string;
  identifier: string;
  optionIdStyleColor: string;
  opptraSkuIds: string[];
  /** Index = shot order - 1; null = removed or missing. */
  links: Partial<Record<ChannelId, (string | null)[]>>;
  status: SheetStatus;
  notes: string;
  change: ChangeKind;
  changedAt: Date | null;
}

/** `channels` in the order the operator ticked them. */
export interface SheetSpec {
  channels: ChannelId[];
  rows: SheetRow[];
}

const FIXED = ["brand", "identifier", "option_id_style_color", "opptra_sku_ids"];
const TAIL = ["status", "notes", "change", "changed_at"];
const MAX_WIDTH = 60;
const MIN_LINK_WIDTH = 40;
const LINK_FONT: Partial<ExcelJS.Font> = { color: { argb: "FF0563C1" }, underline: true };

/** Links a row carries: none for `missing_images` (the status word says why). */
function rowLinks(row: SheetRow, ch: ChannelId): (string | null)[] {
  return row.status === "missing_images" ? [] : (row.links[ch] ?? []);
}

/**
 * Column layout: the four fixed columns, then per channel N image columns (N = the most shots that
 * channel has across the rows, at least 1 so a ticked channel always shows), then the four tail
 * columns. Channels not in `spec.channels` have 0.
 */
export function sheetColumns(spec: SheetSpec): { fixed: string[]; perChannel: Record<ChannelId, number>; tail: string[] } {
  const perChannel = Object.fromEntries(CHANNEL_IDS.map((c) => [c, 0])) as Record<ChannelId, number>;
  for (const ch of spec.channels) {
    perChannel[ch] = spec.rows.reduce((most, r) => Math.max(most, rowLinks(r, ch).length), 1);
  }
  return { fixed: [...FIXED], perChannel, tail: [...TAIL] };
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Natural sort of `identifier`; ties broken by code points so the same input always gives the same order. */
function sortRows(rows: SheetRow[]): SheetRow[] {
  return [...rows].sort(
    (a, b) =>
      collator.compare(a.identifier, b.identifier) ||
      (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0) ||
      collator.compare(a.brand, b.brand),
  );
}

interface Column {
  /** First header row: fixed or tail name, or the channel label. */
  top: string;
  /** Second header row: "Image n" for link columns, "" otherwise. */
  sub: string;
  flat: string;
  link: boolean;
  /** Text cells get numFmt "@". */
  text: boolean;
}

interface Grid {
  columns: Column[];
  channelSpans: { ch: ChannelId; label: string; start: number; count: number }[];
  rows: { row: SheetRow; cells: string[] }[];
}

function buildGrid(spec: SheetSpec): Grid {
  const layout = sheetColumns(spec);
  const columns: Column[] = FIXED.map((name) => ({ top: name, sub: "", flat: name, link: false, text: true }));
  const channelSpans: Grid["channelSpans"] = [];
  for (const ch of spec.channels) {
    const label = channel(ch).label;
    const count = layout.perChannel[ch];
    channelSpans.push({ ch, label, start: columns.length, count });
    for (let i = 1; i <= count; i++) {
      columns.push({ top: label, sub: `Image ${i}`, flat: `${label} Image ${i}`, link: true, text: false });
    }
  }
  for (const name of TAIL) columns.push({ top: name, sub: "", flat: name, link: false, text: false });

  const rows = sortRows(spec.rows).map((row) => {
    const cells = [row.brand, row.identifier, row.optionIdStyleColor, row.opptraSkuIds.join(";")];
    for (const span of channelSpans) {
      const links = rowLinks(row, span.ch);
      for (let i = 0; i < span.count; i++) cells.push(links[i] ?? "");
    }
    cells.push(row.status, row.notes, row.change, row.changedAt ? row.changedAt.toISOString() : "");
    return { row, cells };
  });
  return { columns, channelSpans, rows };
}

function columnWidth(values: string[], link: boolean): number {
  const longest = values.reduce((most, v) => Math.max(most, v.length), 0);
  return Math.min(MAX_WIDTH, link ? Math.max(MIN_LINK_WIDTH, longest) : longest);
}

function toBuffer(data: ArrayBuffer | Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
}

/** The links workbook: one sheet, two bold header rows, frozen below them, hyperlinked link cells. */
export async function writeLinksXlsx(spec: SheetSpec): Promise<Buffer> {
  const grid = buildGrid(spec);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Links");

  grid.columns.forEach((col, i) => {
    const c = i + 1;
    if (col.link) {
      ws.getCell(2, c).value = col.sub;
    } else {
      ws.getCell(1, c).value = col.top;
      ws.mergeCells(1, c, 2, c);
    }
  });
  for (const span of grid.channelSpans) {
    ws.getCell(1, span.start + 1).value = span.label;
    if (span.count > 1) ws.mergeCells(1, span.start + 1, 1, span.start + span.count);
  }
  for (let r = 1; r <= 2; r++) {
    for (let c = 1; c <= grid.columns.length; c++) ws.getCell(r, c).font = { bold: true };
  }

  grid.rows.forEach(({ cells }, i) => {
    const r = i + 3;
    cells.forEach((value, j) => {
      const col = grid.columns[j]!;
      const cell = ws.getCell(r, j + 1);
      if (col.link) {
        if (value) {
          cell.value = { text: value, hyperlink: value };
          cell.font = LINK_FONT;
        }
      } else {
        cell.value = value;
        if (col.text) cell.numFmt = "@";
      }
    });
  });

  grid.columns.forEach((col, j) => {
    const values = [col.link ? col.sub : col.top, ...grid.rows.map((r) => r.cells[j]!)];
    ws.getColumn(j + 1).width = columnWidth(values, col.link);
  });
  ws.views = [{ state: "frozen", ySplit: 2 }];
  return toBuffer(await wb.xlsx.writeBuffer());
}

/** The links csv: flat header `<Channel> Image n`, same cells as the xlsx, CRLF and BOM. */
export function writeLinksCsv(spec: SheetSpec): string {
  const grid = buildGrid(spec);
  return buildCsv(
    grid.columns.map((c) => c.flat),
    grid.rows.map((r) => r.cells),
  );
}

/** Plain text of a cell value as a reader sees it (hyperlinks give their text, formulas their result). */
function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("hyperlink" in v) return cellText(v.text as ExcelJS.CellValue);
    if ("formula" in v || "sharedFormula" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("error" in v) return String(v.error);
  }
  return String(v);
}

/** Header row of a product list sheet: the first row (of the first 20) with at least two non-empty cells. */
function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  let firstNonEmpty: number | null = null;
  const last = Math.min(ws.rowCount, 20);
  for (let r = 1; r <= last; r++) {
    let filled = 0;
    ws.getRow(r).eachCell((cell) => {
      if (cellText(cell.value).trim()) filled++;
    });
    if (filled >= 2) return r;
    if (filled > 0 && firstNonEmpty === null) firstNonEmpty = r;
  }
  return firstNonEmpty;
}

/** Keys a product list value can match: itself, then size-level forms (before the first "/", or without the last "_"/"-" segment). */
function matchKeys(value: string): string[] {
  const keys = [value];
  const slash = value.indexOf("/");
  if (slash > 0) keys.push(value.slice(0, slash));
  const sep = Math.max(value.lastIndexOf("_"), value.lastIndexOf("-"));
  if (sep > 0) keys.push(value.slice(0, sep));
  return keys.map(normalizeKey).filter(Boolean);
}

/**
 * The operator's product list workbook with the links appended (spec 02). Every sheet, column and
 * value is kept. On each sheet that has a header row and at least one matching row, `link_status` and per channel
 * `<Channel> Image 1..N` are appended to the right of the last used column; each row is matched on
 * column `matchColumn` (0-based, as in 04's column detection) by `normalizeKey` of the identifier
 * or `option_id_style_color`, then by its size-level forms, so every per-size row of a colourway
 * repeats that colourway's links. `link_status` is the sheet row's status word (`missing_images`
 * when no row matches). One row per `not_in_sheet` product not matched anywhere is appended at the
 * bottom of the first such sheet, its identifier in the match column as text. The input buffer is
 * never modified.
 */
export async function fillProductListWorkbook(original: Buffer, spec: SheetSpec, matchColumn: number): Promise<Buffer> {
  if (!Number.isInteger(matchColumn) || matchColumn < 0) throw new Error(`matchColumn must be a 0-based column index, got ${matchColumn}`);
  const grid = buildGrid(spec);
  const linkColumns = grid.columns.map((c, j) => ({ c, j })).filter(({ c }) => c.link);
  const statusIndex = grid.columns.findIndex((c) => c.flat === "status");

  const byKey = new Map<string, Grid["rows"][number]>();
  for (const r of grid.rows) {
    for (const key of [r.row.identifier, r.row.optionIdStyleColor].map(normalizeKey)) {
      if (key && !byKey.has(key)) byKey.set(key, r);
    }
  }
  const matched = new Set<SheetRow>();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(original) as unknown as Parameters<typeof wb.xlsx.load>[0]);

  type Target = { ws: ExcelJS.Worksheet; headerRow: number; start: number };
  let first: Target | null = null;
  const writeHeader = ({ ws, headerRow, start }: Target) => {
    ["link_status", ...linkColumns.map(({ c }) => c.flat)].forEach((h, k) => {
      const cell = ws.getCell(headerRow, start + k);
      cell.value = h;
      cell.font = { bold: true };
    });
  };
  const writeRow = (ws: ExcelJS.Worksheet, r: number, start: number, cells: string[] | null, status: string) => {
    ws.getCell(r, start).value = status;
    if (!cells) return;
    linkColumns.forEach(({ j }, k) => {
      const url = cells[j];
      if (!url) return;
      const cell = ws.getCell(r, start + 1 + k);
      cell.value = { text: url, hyperlink: url };
      cell.font = LINK_FONT;
    });
  };

  // A sheet gets the columns only when at least one of its rows matches a product, so a notes or
  // valid-values tab is left as it was. The not_in_sheet rows go to the first filled sheet (or the
  // first sheet with a header row when nothing matched anywhere).
  let fallback: Target | null = null;
  for (const ws of wb.worksheets) {
    const headerRow = findHeaderRow(ws);
    if (headerRow === null) continue;
    const target: Target = { ws, headerRow, start: ws.columnCount + 1 };
    fallback ??= target;
    const rows: { r: number; hit: Grid["rows"][number] | undefined }[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const value = cellText(ws.getCell(r, matchColumn + 1).value).trim();
      if (!value) continue;
      rows.push({ r, hit: matchKeys(value).map((k) => byKey.get(k)).find(Boolean) });
    }
    if (!rows.some((x) => x.hit)) continue;
    writeHeader(target);
    for (const { r, hit } of rows) {
      if (hit) matched.add(hit.row);
      writeRow(ws, r, target.start, hit ? hit.cells : null, hit ? hit.cells[statusIndex]! : "missing_images");
    }
    first ??= target;
  }

  const notInSheet = grid.rows.filter((r) => r.row.status === "not_in_sheet" && !matched.has(r.row));
  if (!first && fallback && notInSheet.length) {
    first = fallback;
    writeHeader(first);
  }
  if (first) {
    const { ws, start } = first;
    for (const r of notInSheet) {
      const rowNumber = ws.rowCount + 1;
      const idCell = ws.getCell(rowNumber, matchColumn + 1);
      idCell.value = r.row.identifier;
      idCell.numFmt = "@";
      writeRow(ws, rowNumber, start, r.cells, r.row.status);
    }
  }
  return toBuffer(await wb.xlsx.writeBuffer());
}

/** Flatten the first sheet of a links workbook into one header row plus data rows. */
async function flattenXlsx(xlsx: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(xlsx) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const width = ws.columnCount;
  const header: string[] = [];
  for (let c = 1; c <= width; c++) {
    const top = cellText(ws.getCell(1, c).value);
    const sub = cellText(ws.getCell(2, c).value);
    header.push(!sub || sub === top ? top : `${top} ${sub}`);
  }
  const rows = [header];
  for (let r = 3; r <= ws.rowCount; r++) {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(ws.getCell(r, c).value));
    rows.push(cells);
  }
  return rows;
}

/**
 * Compare a links workbook with its csv cell by cell (finalize in 06, re-check in 09). Each
 * difference is a plain sentence naming the row, the column and both values.
 */
export async function compareXlsxCsv(xlsx: Buffer, csv: string): Promise<{ equal: boolean; differences: string[] }> {
  const a = await flattenXlsx(xlsx);
  const b = parseCsv(csv);
  const differences: string[] = [];
  if (a.length !== b.length) differences.push(`The xlsx has ${a.length - 1} data rows and the csv has ${b.length - 1}.`);
  const header = b[0] ?? a[0] ?? [];
  const rows = Math.max(a.length, b.length);
  for (let r = 0; r < rows; r++) {
    const x = a[r] ?? [];
    const y = b[r] ?? [];
    const width = Math.max(x.length, y.length);
    for (let c = 0; c < width; c++) {
      const xv = x[c] ?? "";
      const yv = y[c] ?? "";
      if (xv === yv) continue;
      const where = r === 0 ? "header" : `row ${r} (${y[1] ?? x[1] ?? ""})`;
      differences.push(`${where}, column ${header[c] ?? c + 1}: xlsx ${JSON.stringify(xv)}, csv ${JSON.stringify(yv)}`);
    }
  }
  return { equal: differences.length === 0, differences };
}
