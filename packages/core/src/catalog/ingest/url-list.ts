// Pasted image URLs (spec 04, "URL list"): one link per line, optionally `identifier<TAB>url`.
// Collecting only lists the links (bytes {kind:"url"}); the bytes are fetched when the item is
// copied to raw/, through `fetchSourceUrl`, which is GET only (Supabase is only ever read), SSRF
// safe, capped at 40 MB and follows redirects by hand (02's safeFetch).
import { fileTypeFromBuffer } from "file-type";
import { safeFetch, type SafeFetchOptions } from "../../safe-url";
import { normalizeKey, parseShotName } from "../naming";
import { extOf, urlFileName, type SheetSourceItem } from "./links-sheet";
import type { Adapter, IngestDeps, SourceItem } from "./types";

const URL_RE = /^https?:\/\//i;

/** One entry per line with an http(s) link; blank lines and lines without a link are skipped. */
export function parseUrlList(text: string): { identifier: string | null; url: string }[] {
  const out: { identifier: string | null; url: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    const id = tab >= 0 ? line.slice(0, tab).trim() : "";
    const url = (tab >= 0 ? line.slice(tab + 1) : line).trim();
    if (URL_RE.test(url)) out.push({ identifier: id || null, url });
    else if (!url && URL_RE.test(id)) out.push({ identifier: null, url: id }); // a link with a trailing tab
  }
  return out;
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
 * Items for a pasted list. Identifier = the pasted identifier (shots numbered in line order), else
 * parseShotName of the URL's last path segment. The pasted text is read from the upload's object
 * when `gcsUri` is set, else from `sourceUrl`.
 */
export function urlListItems(text: string, uploadId: string): SourceItem[] {
  const counts = new Map<string, number>();
  return parseUrlList(text).map(({ identifier, url }) => {
    const originalName = urlFileName(url);
    const parsed = parseShotName(originalName);
    const base = { originalName, folder: urlFolder(url), sheetIdentifier: null, ext: extOf(originalName), bytes: { kind: "url" as const, url }, uploadId, origin: "url_list" as const, warnings: [] };
    if (identifier) {
      const key = normalizeKey(identifier);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { ...base, identifier, n, suffix: "" as const };
    }
    return { ...base, identifier: parsed.identifier, n: parsed.n, suffix: parsed.suffix };
  });
}

/** kind "url_list". */
export const urlListAdapter: Adapter = {
  kind: "url_list",
  async collect(input) {
    const { upload, deps } = input;
    const text = upload.gcsUri ? (await deps.storage.downloadBuffer(upload.gcsUri)).buf.toString("utf8") : (upload.sourceUrl ?? "");
    return urlListItems(text, upload.id);
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
