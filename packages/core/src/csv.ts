// CSV helpers (spec 02, "CSV"). Writing: CRLF line ends and a UTF-8 BOM so Excel opens the file as
// UTF-8. Reading: RFC 4180 (quoted fields, doubled quotes, CRLF or LF, BOM stripped).

const BOM = "﻿";

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One field; quoted when it holds a comma, quote, CR or LF, or leading/trailing spaces. Inner quotes doubled. */
export function csvField(v: unknown): string {
  const s = stringify(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One line without its line end. */
export function csvLine(fields: unknown[]): string {
  return fields.map(csvField).join(",");
}

/** Header plus rows, CRLF line ends (including after the last row), UTF-8 BOM first. */
export function buildCsv(header: string[], rows: unknown[][]): string {
  return BOM + [header, ...rows].map((r) => `${csvLine(r)}\r\n`).join("");
}

/** RFC 4180 parse. A final line end does not produce an empty row. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === "") inQuotes = true;
    else if (c === ",") endField();
    else if (c === "\r" && src[i + 1] === "\n") {
      endRow();
      i++;
    } else if (c === "\n" || c === "\r") endRow();
    else field += c;
    i++;
  }
  if (field !== "" || row.length > 0 || inQuotes) endRow();
  return rows;
}
