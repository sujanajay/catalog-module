// Sheet readers for the independent re-check (spec 09 section 4.4). The xlsx has two header rows:
// a channel label merged over its "Image 1..N" columns, then "Image n"; the csv has one flat
// "<Channel> Image n" header. Both give the same list of link cells.
import ExcelJS from "exceljs";
import { parseCsv } from "../../csv";
import { CHANNELS } from "../channels";
import type { ChannelId } from "../types";

export interface SheetLink { url: string; identifier: string; channel: ChannelId; n: number; hyperlinkOk: boolean }
export interface SheetLinks { identifiers: string[]; links: SheetLink[]; problems: { problem: string; detail: string }[] }

const byLabel = new Map(Object.values(CHANNELS).map(c => [c.label.toLowerCase(), c.id] as const));

/** Channel id of a header label ("Noon", "6th Street"), or null. */
export function channelOfLabel(label: string): ChannelId | null {
  return byLabel.get(label.trim().toLowerCase()) ?? null;
}

/** Every link cell of a links workbook, with the channel read through the merged header. */
export async function readSheetLinks(xlsx: Buffer): Promise<SheetLinks> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(xlsx) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const out: SheetLinks = { identifiers: [], links: [], problems: [] };
  const ws = wb.worksheets[0];
  if (!ws) { out.problems.push({ problem: "no_sheet", detail: "The workbook has no links sheet." }); return out; }
  let idCol = 0;
  const columns: { col: number; channel: ChannelId; n: number }[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    const top = ws.getCell(1, c).master.text.trim(), sub = ws.getCell(2, c).text.trim();
    if (top === "identifier") idCol = c;
    const m = /^Image (\d+)$/.exec(sub);
    if (!m) continue;
    const channel = channelOfLabel(top);
    if (!channel) { out.problems.push({ problem: "unknown_channel", detail: `Column ${c} has the channel header "${top}".` }); continue; }
    columns.push({ col: c, channel, n: Number(m[1]) });
  }
  if (!idCol) out.problems.push({ problem: "no_identifier_column", detail: "The sheet has no identifier column." });
  for (let r = 3; r <= ws.rowCount; r++) {
    const identifier = idCol ? ws.getCell(r, idCol).text.trim() : "";
    const row = columns.map(({ col, channel, n }) => ({ cell: ws.getCell(r, col), channel, n })).filter(x => x.cell.value !== null && x.cell.value !== undefined && x.cell.text !== "");
    if (!identifier && !row.length) continue;
    out.identifiers.push(identifier);
    for (const { cell, channel, n } of row) {
      const v = cell.value;
      const isLink = typeof v === "object" && v !== null && "hyperlink" in v;
      const url = isLink ? String(v.hyperlink) : cell.text.trim();
      out.links.push({ url, identifier, channel, n, hyperlinkOk: isLink && cell.text === url });
    }
  }
  return out;
}

/** Every link cell of a links csv (no hyperlinks in csv, so `hyperlinkOk` is always true). */
export function readCsvLinks(csv: string): SheetLinks {
  const out: SheetLinks = { identifiers: [], links: [], problems: [] };
  const [header = [], ...rows] = parseCsv(csv);
  const idCol = header.indexOf("identifier");
  if (idCol < 0) out.problems.push({ problem: "no_identifier_column", detail: "The csv has no identifier column." });
  const columns: { col: number; channel: ChannelId; n: number }[] = [];
  header.forEach((h, col) => {
    const m = /^(.+) Image (\d+)$/.exec(h.trim());
    if (!m) return;
    const channel = channelOfLabel(m[1]!);
    if (!channel) out.problems.push({ problem: "unknown_channel", detail: `Column ${col + 1} has the channel header "${h}".` });
    else columns.push({ col, channel, n: Number(m[2]) });
  });
  for (const cells of rows) {
    if (!cells.some(c => c.trim())) continue;
    const identifier = idCol >= 0 ? (cells[idCol] ?? "").trim() : "";
    out.identifiers.push(identifier);
    for (const { col, channel, n } of columns) {
      const url = (cells[col] ?? "").trim();
      if (url) out.links.push({ url, identifier, channel, n, hyperlinkOk: true });
    }
  }
  return out;
}
