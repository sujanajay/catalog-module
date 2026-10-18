// Product lists (spec 04, "Product list"): an item master or option list that says which products
// the operator expects. It never creates source images; it gives each product its link_status and
// extra SKU mapping keys. Matching is deterministic, on normalizeKey values, in this order: exact,
// shape suffix (_rect/_square share the row), size-level keys (02's product_code rule), token
// containment of a composite style+colour key inside file stems, and the match column with a
// trailing _<n> stripped.
import { normalizeKey } from "../naming";
import type { LinkStatus } from "../types";
import { columnLetter, detectColumns, loadSheet, normalizeHeader, sheetDataRows, CANNOT_READ_IDENTIFIER } from "./links-sheet";
import type { Detected, GroupingResult } from "./types";

export interface ProductListRow {
  identifier: string; ean: string | null; raw: Record<string, string>;
  /** Set when the identifier is the composite `<style>_<colour code>` (token containment needs both parts). */
  composite?: { style: string; colour: string };
}

export const MATCHED_INSIDE_FILE_NAMES = "Matched by style and colour code found inside the file names";

async function readList(buf: Buffer, name: string, columns?: { identifier: number; ean?: number }) {
  const { table, sheetNames } = await loadSheet(buf, name);
  const d = detectColumns(table);
  const composite = !columns && d.styleColumn !== null && d.colourColumn !== null;
  const identifierColumn = columns?.identifier ?? d.identifierColumn;
  const eanColumn = columns ? (columns.ean ?? null) : d.eanColumn;
  const header = [table.header, ...table.rows][d.headerRow - 1] ?? [];
  return { table, sheetNames, d, composite, identifierColumn, eanColumn, header };
}

/** Header names for `raw`: the header text, `Column <L>` when blank, `<header> (<L>)` when repeated. */
function rawKeys(header: string[], width: number): string[] {
  const used = new Set<string>();
  return Array.from({ length: width }, (_, c) => {
    const h = (header[c] ?? "").trim();
    const key = !h ? `Column ${columnLetter(c)}` : used.has(h) ? `${h} (${columnLetter(c)})` : h;
    used.add(key);
    return key;
  });
}

/**
 * Rows of a product list. `columns` is the step 2 choice (identifier = the match column); without it
 * the detected identifier, or the composite style + colour key, is used. Rows without an identifier
 * are left out. Throws "Could not tell which column holds the identifier." when nothing can be told.
 */
export async function readProductList(buf: Buffer, name: string, columns?: { identifier: number; ean?: number }): Promise<ProductListRow[]> {
  const { table, d, composite, identifierColumn, eanColumn, header } = await readList(buf, name, columns);
  if (!composite && identifierColumn < 0) throw new Error(CANNOT_READ_IDENTIFIER);
  const width = Math.max(header.length, ...table.rows.map((r) => r.length));
  const keys = rawKeys(header, width);
  const rows: ProductListRow[] = [];
  for (const { cells } of sheetDataRows(table, d.headerRow)) {
    const at = (c: number | null) => (c === null || c < 0 ? "" : (cells[c] ?? "").trim());
    const style = composite ? at(d.styleColumn) : "";
    const colour = composite ? at(d.colourColumn) : "";
    const identifier = composite ? (style && colour ? `${style}_${colour}` : "") : at(identifierColumn);
    if (!identifier) continue;
    const raw: Record<string, string> = {};
    keys.forEach((k, c) => (raw[k] = at(c)));
    rows.push({ identifier, ean: at(eanColumn) || null, raw, ...(composite ? { composite: { style, colour } } : {}) });
  }
  return rows;
}

/**
 * catalog_uploads.detected for a product list: the columns, `matchColumn` (the column finalize, 06,
 * matches on for the filled copy; the style column for a composite key) and every `sheetNames`.
 */
export async function productListDetected(buf: Buffer, name: string, columns?: { identifier: number; ean?: number }): Promise<Detected> {
  const { table, sheetNames, d, composite, identifierColumn, eanColumn, header } = await readList(buf, name, columns);
  const cannotRead = !composite && identifierColumn < 0 ? CANNOT_READ_IDENTIFIER : null;
  const identifierHeader = composite ? d.identifierHeader : identifierColumn >= 0 ? (header[identifierColumn] ?? "") : null;
  return {
    kind: "product_list", title: table.title, rows: sheetDataRows(table, d.headerRow).length, columns: header, headerRow: d.headerRow,
    identifierColumn, ...(identifierHeader !== null ? { identifierHeader } : {}),
    styleColumn: composite ? d.styleColumn : null, colourColumn: composite ? d.colourColumn : null,
    urlColumns: d.urlColumns, eanColumn, ...(identifierColumn >= 0 ? { matchColumn: identifierColumn } : {}), sheetNames, cannotRead,
    message: cannotRead ?? d.sentence,
  };
}

// --- Matching ----------------------------------------------------------------------------

export interface ProductListMatch {
  /** Product identifier (after renames) -> the list rows that matched it. */
  byIdentifier: Map<string, ProductListRow[]>;
  /** Grouped identifier -> the sheet key it becomes (token containment: the key is the identifier and path_key). */
  renamed: Map<string, string>;
  /** Rows matched by their size-level key, and the distinct products they matched. */
  sizeRowsMatched: number;
  productsMatchedBySize: number;
  /** "<k> size rows matched <m> products." or null. */
  sizeSentence: string | null;
  /** MATCHED_INSIDE_FILE_NAMES when token containment matched anything, else null. */
  groupedBy: string | null;
  unmatchedRows: ProductListRow[];
  /** Product identifier -> every Opptra SKU id found on its rows (a column whose header holds "opptrasku"). */
  skuIds: Map<string, string[]>;
}

const SHAPE = /[_-](rect|square)$/i;
const SHOT_SUFFIX = /[_-]\d{1,3}$/;

/** The size-level forms of a list key: before the first "/", else without the last "_" or "-" segment (02's product_code rule). */
function sizeBases(key: string): string[] {
  const s = key.trim();
  const slash = s.indexOf("/");
  if (slash > 0) return [s.slice(0, slash)];
  const sep = Math.max(s.lastIndexOf("_"), s.lastIndexOf("-"));
  return sep > 0 ? [s.slice(0, sep)] : [];
}

/** True when `tokens` (a token's own `_` segments) appears as a consecutive run of `segments`. */
function hasRun(segments: string[], tokens: string[]): boolean {
  if (!tokens.length) return false;
  for (let i = 0; i + tokens.length <= segments.length; i++) {
    if (tokens.every((t, k) => segments[i + k] === t)) return true;
  }
  return false;
}

const segmentsOf = (s: string) => s.split("_").map(normalizeKey).filter(Boolean);

/**
 * Match list rows to the grouped identifiers, every rule in order (first hit wins per row). With
 * `byMatchColumn` (the operator chose a match column in step 2) the trailing `_<n>` rule runs before
 * the size-level rule, so shot-numbered stems are not counted as size rows.
 */
export function matchProductList(list: ProductListRow[], identifiers: string[], opts: { byMatchColumn?: boolean } = {}): ProductListMatch {
  const exact = new Map<string, string[]>();
  const shapes = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const id of identifiers) {
    push(exact, normalizeKey(id), id);
    if (SHAPE.test(id)) push(shapes, normalizeKey(id.replace(SHAPE, "")), id);
  }
  const lookup = (key: string) => [...new Set([...(exact.get(normalizeKey(key)) ?? []), ...(shapes.get(normalizeKey(key)) ?? [])])];

  const byIdentifier = new Map<string, ProductListRow[]>();
  const renamed = new Map<string, string>();
  const unmatchedRows: ProductListRow[] = [];
  const bySize = new Set<string>();
  let sizeRowsMatched = 0;
  let tokenUsed = false;

  type Rule = (row: ProductListRow) => string[];
  const exactRule: Rule = (row) => lookup(row.identifier);
  const sizeRule: Rule = (row) => {
    for (const base of sizeBases(row.identifier)) {
      const ids = lookup(base);
      if (ids.length) return ids;
    }
    return [];
  };
  const tokenRule: Rule = (row) => {
    if (!row.composite) return [];
    const style = segmentsOf(row.composite.style);
    const colour = segmentsOf(row.composite.colour);
    return identifiers.filter((id) => !renamed.has(id) && hasRun(segmentsOf(id), style) && hasRun(segmentsOf(id), colour));
  };
  const matchColumnRule: Rule = (row) => (SHOT_SUFFIX.test(row.identifier) ? lookup(row.identifier.replace(SHOT_SUFFIX, "")) : []);
  const rules: [string, Rule][] = opts.byMatchColumn
    ? [["exact", exactRule], ["matchColumn", matchColumnRule], ["size", sizeRule], ["token", tokenRule]]
    : [["exact", exactRule], ["size", sizeRule], ["token", tokenRule], ["matchColumn", matchColumnRule]];

  for (const row of list) {
    let hit: { rule: string; ids: string[] } | null = null;
    for (const [rule, fn] of rules) {
      const ids = fn(row);
      if (ids.length) {
        hit = { rule, ids };
        break;
      }
    }
    if (!hit) {
      unmatchedRows.push(row);
      continue;
    }
    if (hit.rule === "size") {
      sizeRowsMatched++;
      hit.ids.forEach((id) => bySize.add(id));
    }
    let targets = hit.ids;
    if (hit.rule === "token") {
      tokenUsed = true;
      hit.ids.forEach((id) => renamed.set(id, row.identifier));
      targets = [row.identifier];
    }
    for (const id of targets) byIdentifier.set(id, [...(byIdentifier.get(id) ?? []), row]);
  }

  const skuIds = new Map<string, string[]>();
  for (const [id, rows] of byIdentifier) {
    const ids = rows.flatMap((r) => Object.entries(r.raw).filter(([h, v]) => v && normalizeHeader(h).includes("opptrasku")).map(([, v]) => v));
    if (ids.length) skuIds.set(id, [...new Set(ids)].sort());
  }
  return {
    byIdentifier, renamed, sizeRowsMatched, productsMatchedBySize: bySize.size,
    sizeSentence: sizeRowsMatched ? `${sizeRowsMatched.toLocaleString("en-US")} size rows matched ${bySize.size.toLocaleString("en-US")} products.` : null,
    groupedBy: tokenUsed ? MATCHED_INSIDE_FILE_NAMES : null, unmatchedRows, skuIds,
  };
}

/**
 * The identifier a list-only product gets: the row's key, or its size-level base when the list is
 * size-level (a key with "/", or a list where other rows matched by size), so the sizes of one
 * colourway become one missing product.
 */
export function missingIdentifier(row: ProductListRow, sizeLevel: boolean): string {
  if (row.identifier.includes("/") || sizeLevel) return sizeBases(row.identifier)[0] ?? row.identifier;
  return row.identifier;
}

/**
 * ok = in list and has images; missing_images = in list, no images; not_in_sheet = has images, not in
 * list. Keys are product identifiers after token-containment renames (see matchProductList.renamed);
 * shapes the upload does not contain are not reported missing. Without a product list every grouped
 * identifier is ok.
 */
export function linkStatuses(list: ProductListRow[], grouped: GroupingResult): Map<string, LinkStatus> {
  const identifiers = [...grouped.products.keys()];
  const out = new Map<string, LinkStatus>();
  if (!list.length) {
    for (const id of identifiers) out.set(id, "ok");
    return out;
  }
  const m = matchProductList(list, identifiers);
  for (const id of identifiers) {
    const final = m.renamed.get(id) ?? id;
    out.set(final, m.byIdentifier.has(final) ? "ok" : "not_in_sheet");
  }
  const seen = new Set([...out.keys()].map(normalizeKey));
  for (const row of m.unmatchedRows) {
    const id = missingIdentifier(row, m.sizeRowsMatched > 0);
    const key = normalizeKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(id, "missing_images");
  }
  return out;
}
