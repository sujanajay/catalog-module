// Pasted image URLs (spec 04 "URL list", spec 14b F2): one link per line, `identifier<TAB>url`
// lines, or a grid of links copied from a spreadsheet (each row a product). Collecting only lists
// the links (bytes {kind:"url"}); the bytes are fetched when the item is copied to raw/, through
// `fetchSourceUrl`, which is GET only (Supabase is only ever read), SSRF safe, capped at 40 MB and
// follows redirects by hand (02's safeFetch).
import { fileTypeFromBuffer } from "file-type";
import { safeFetch, type SafeFetchOptions } from "../../safe-url";
import { normalizeKey, parseShotName } from "../naming";
import { extOf, isLinkToken, splitCell, urlFileName, type SheetSourceItem } from "./links-sheet";
import type { Adapter, IngestDeps, SourceItem } from "./types";

/** One pasted row with at least one link. `row` is its 1-based line number in the paste. */
export interface PastedRow { row: number; identifier: string | null; urls: string[]; name: string | null }

/** What a paste holds (spec 14b F2). */
export interface PastedTable {
  rows: PastedRow[];
  links: number;
  linksPerRow: { min: number; max: number };
  shape: "one_per_line" | "id_and_links" | "links_grid";
  ignoredCells: number;
  collisions: { name: string; rows: number[] }[];
}

/** Cells that are never an identifier: blank, `0`, `-` and `n/a`. */
const FILLER = new Set(["", "0", "-", "n/a"]);

/**
 * Reads pasted text (spec 14b F2). Lines split into cells on tabs; a cell, and a line without a
 * tab, split further only before a following http(s) link (splitCell). Every link of a row is a URL
 * of that row in column order; the first non-link cell that is not filler is the identifier; every
 * other non-link cell is ignored and counted. Naming: the identifier; else, for two or more links,
 * the first link's file name stem (parseShotName); else null (grouped by file name later). Rows
 * without a link are skipped. A collision is two or more named rows with the same name (compared
 * as normalizeKey does) where at least one of them holds two or more links: one link per line under
 * a repeated identifier is how shots are listed, not a collision.
 */
export function parsePastedLinks(text: string): PastedTable {
  const rows: PastedRow[] = [];
  let ignoredCells = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    const tokens = line.includes("\t") ? line.split("\t").flatMap((cell) => (cell.trim() === "" ? [""] : splitCell(cell))) : splitCell(line);
    const urls = tokens.filter(isLinkToken);
    if (!urls.length) return;
    let identifier: string | null = null;
    for (const token of tokens) {
      if (isLinkToken(token)) continue;
      if (identifier === null && !FILLER.has(token.toLowerCase())) identifier = token;
      else ignoredCells++;
    }
    const stem = urls.length >= 2 ? parseShotName(urlFileName(urls[0]!)).identifier : "";
    rows.push({ row: i + 1, identifier, urls, name: identifier ?? (stem || null) });
  });

  const byName = new Map<string, PastedRow[]>();
  for (const r of rows) {
    if (r.name === null) continue;
    const key = normalizeKey(r.name);
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  const collisions = [...byName.values()]
    .filter((group) => group.length > 1 && group.some((r) => r.urls.length >= 2))
    .map((group) => ({ name: group[0]!.name!, rows: group.map((r) => r.row) }));

  const counts = rows.map((r) => r.urls.length);
  const shape = rows.some((r) => r.identifier !== null) ? "id_and_links" : counts.some((n) => n >= 2) ? "links_grid" : "one_per_line";
  return {
    rows, links: counts.reduce((a, b) => a + b, 0),
    linksPerRow: { min: counts.length ? Math.min(...counts) : 0, max: counts.length ? Math.max(...counts) : 0 },
    shape, ignoredCells, collisions,
  };
}

/** The link as it is fetched: internal spaces percent-encoded (the pasted text keeps them). */
export function fetchableUrl(url: string): string {
  return url.replace(/ /g, "%20");
}

/** Decoded parent path segment of a URL (`.../ABC123/1.jpg` -> `ABC123`), or null. */
function urlFolder(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs.length > 1 ? decodeURIComponent(segs[segs.length - 2]!) : null;
  } catch {
    return null;
  }
}

/**
 * Items for a paste (parsePastedLinks). A row with an identifier: that identifier, shots numbered
 * in order and continuing across rows with the same identifier (one link per line). A named row
 * without one (two or more links): its name, shots 1..k in column order. Else parseShotName of the
 * link's file name. `originalName` is always the link's own decoded file name; the fetched URL has
 * its spaces percent-encoded. The pasted text is read from the upload's object when `gcsUri` is
 * set, else from `sourceUrl`.
 */
export function urlListItems(table: PastedTable, uploadId: string): SourceItem[] {
  const counts = new Map<string, number>();
  return table.rows.flatMap(({ identifier, urls, name }) => urls.map((url, i) => {
    const originalName = urlFileName(url);
    const base = { originalName, folder: urlFolder(url), sheetIdentifier: null, ext: extOf(originalName), bytes: { kind: "url" as const, url: fetchableUrl(url) }, uploadId, origin: "url_list" as const, warnings: [] };
    if (identifier) {
      const key = normalizeKey(identifier);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { ...base, identifier, n, suffix: "" as const };
    }
    if (name) return { ...base, identifier: name, n: i + 1, suffix: "" as const };
    const parsed = parseShotName(originalName);
    return { ...base, identifier: parsed.identifier, n: parsed.n, suffix: parsed.suffix };
  }));
}

/** kind "url_list". */
export const urlListAdapter: Adapter = {
  kind: "url_list",
  async collect(input) {
    const { upload, deps } = input;
    const text = upload.gcsUri ? (await deps.storage.downloadBuffer(upload.gcsUri)).buf.toString("utf8") : (upload.sourceUrl ?? "");
    return urlListItems(parsePastedLinks(text), upload.id);
  },
};

// --- Fetching --------------------------------------------------------------------

export type UrlFetchResult = { ok: true; buf: Buffer; mime: string; finalUrl: string } | { ok: false; reason: string };

/** A link for a sentence: no query string or fragment (they can carry access tokens). */
function shownUrl(url: string): string {
  return url.split(/[?#]/)[0]!;
}

/**
 * GET the bytes of a url item and check they are an image. The failure is the operator sentence:
 * "<url> did not return an image (got <status or content-type>)." and, for an item read from a
 * links sheet, "Row <r>, column <header>: <url> did not return an image (got ...)." `opts` passes
 * safeFetch options through (tests inject `lookup`; production leaves it empty).
 */
export async function fetchSourceUrl(item: SourceItem, deps: Pick<IngestDeps, "fetch">, opts: Pick<SafeFetchOptions, "lookup" | "maxBytes" | "timeoutMs"> = {}): Promise<UrlFetchResult> {
  if (item.bytes.kind !== "url") throw new Error(`${item.originalName} is not a link.`);
  const url = item.bytes.url;
  const sheet = item as Partial<SheetSourceItem>;
  const fail = (got: string): UrlFetchResult => {
    const base = `${shownUrl(url)} did not return an image (got ${got}).`;
    return { ok: false, reason: sheet.sheetRow !== undefined ? `Row ${sheet.sheetRow}, column ${sheet.sheetHeader}: ${base}` : base };
  };

  let lastStatus: number | null = null;
  const recording: typeof fetch = async (input, init) => {
    const res = await deps.fetch(input, init);
    lastStatus = res.status;
    return res;
  };
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, { ...opts, fetch: recording });
  } catch (err) {
    const status = lastStatus as number | null;
    if (status !== null && status >= 400) return fail(String(status));
    return fail(((err as Error)?.message ?? String(err)).replace(/\.$/, ""));
  }
  if (res.mime.startsWith("image/")) return { ok: true, buf: res.buf, mime: res.mime, finalUrl: res.finalUrl };
  const sniffed = await fileTypeFromBuffer(res.buf);
  if (sniffed?.mime.startsWith("image/")) return { ok: true, buf: res.buf, mime: sniffed.mime, finalUrl: res.finalUrl };
  return fail(res.mime);
}
