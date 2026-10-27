// Detection of what was dropped or pasted (spec 04, "Detection"), and the instant access check
// behind the paste box. The check runs on the web tier as catalog-web@ (SHARE_SA_EMAIL, 02), the
// address shown next to the box, so its sentences say "the address above".
import type { UploadKind } from "../types";
import { FOLDER_NO_ACCESS, GOOGLE_POLICY_BLOCKED, googleAccessError, googleSheetDetected, parseSpreadsheetId, readGoogleSheet } from "./google-sheet";
import { FOLDER_TOO_LARGE, listChildren, parseFolderId } from "./drive-folder";
import { safeFetch } from "../../safe-url";
import { parseShotName } from "../naming";
import { errorReason, LINK_REASON, statusReason } from "./link-reasons";
import { urlFileName } from "./links-sheet";
import { fetchableUrl, parsePastedLinks, type PastedTable } from "./url-list";
import type { Detected, IngestDeps } from "./types";

/** Spec 04's url_list sentence; since 14b F2 the paste readback (pasteReadback) replaces it. */
export const URL_LIST_SENTENCE = "We will download them when you start. No sharing needed.";
export const DRIVE_FOLDER_OK = "Drive folder found. We will copy its files when you start.";
export const NOTHING_TO_CHECK = "Paste a Google Sheet link, a Google Drive folder link, or image links one per line.";

const startsWith = (head: Buffer, bytes: number[], offset = 0) => head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
const ascii = (head: Buffer, start: number, end: number) => head.subarray(start, end).toString("latin1");

/** HEIF brands (heic, heix, hevc, mif1 ...) and AVIF brands in the `ftyp` box. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * The image types the ingest takes (jpeg, png, webp, tiff, gif, avif, heic), by their magic bytes.
 * The same signatures file-type checks; kept synchronous here because detectUploadKind is.
 */
function isImageHead(head: Buffer): boolean {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return true;                               // jpeg
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true; // png
  if (ascii(head, 0, 4) === "GIF8") return true;                                        // gif
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return true;       // webp
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return true; // tiff
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12).toLowerCase();
    return HEIC_BRANDS.has(brand) || AVIF_BRANDS.has(brand);
  }
  return false;
}

/**
 * Zip by magic bytes 50 4B 03 04; an xlsx is a zip too, so a `.xlsx` name or an `xl/workbook.xml`
 * entry in the head makes it a sheet. `.csv` is a sheet. Images by their magic bytes. Anything else
 * (BMP, PDF, ...) is "unknown"; image-check gives those their sentences.
 */
export function detectUploadKind(name: string, head: Buffer): UploadKind | "unknown" {
  const lower = name.toLowerCase();
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (/\.xls[xm]$/.test(lower) || head.includes("xl/workbook.xml", 0, "latin1")) return "sheet";
    return "zip";
  }
  if (lower.endsWith(".csv")) return "sheet";
  if (isImageHead(head)) return "image";
  return "unknown";
}

const SHEET_LINK = /https?:\/\/docs\.google\.com\/spreadsheets\/[^\s]+/gi;
const FOLDER_LINK = /https?:\/\/drive\.google\.com\/[^\s]*folders\/[^\s]+/gi;

/** docs.google.com/spreadsheets -> google_sheet; drive.google.com/drive/folders or /folders/ -> drive_folder; one or more http(s) lines -> url_list; else null. */
export function detectPastedText(text: string): { kind: "google_sheet" | "drive_folder" | "url_list"; ids: string[] } | null {
  const sheets = [...text.matchAll(SHEET_LINK)].map((m) => parseSpreadsheetId(m[0])).filter((id): id is string => !!id);
  if (sheets.length) return { kind: "google_sheet", ids: [...new Set(sheets)] };
  const folders = [...text.matchAll(FOLDER_LINK)].map((m) => parseFolderId(m[0])).filter((id): id is string => !!id);
  if (folders.length) return { kind: "drive_folder", ids: [...new Set(folders)] };
  const urls = parsePastedLinks(text).rows.flatMap((r) => r.urls);
  if (urls.length) return { kind: "url_list", ids: urls };
  return null;
}

// --- The paste readback (spec 14b F2) ------------------------------------------------

/** How many links the readback opens, and how it opens them. */
export const SAMPLE_LINKS = 3;
export const SAMPLE_TIMEOUT_MS = 5_000;
export const SAMPLE_BYTES = 1024;
export const SHARE_PAGES = "These look like share pages, not image links. Download the photos and drop them here, or paste direct image links.";

type Sample = NonNullable<Detected["sample"]>;
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const listAnd = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * Opens one link the way the readback does: GET through safeFetch with `Range: bytes=0-1023`, at
 * most 1,024 bytes read, 5 s per hop. Ok for a 200 or 206 whose type is an image or whose first
 * bytes carry an image signature; a web page for text/html or a body starting with `<`; otherwise
 * the reason phrase for its status (or "could not be reached" for another non-image answer).
 */
async function peekLink(url: string, deps: Pick<IngestDeps, "fetch" | "lookup">): Promise<"ok" | { reason: string; webPage: boolean }> {
  try {
    const r = await safeFetch(fetchableUrl(url), {
      fetch: deps.fetch, ...(deps.lookup ? { lookup: deps.lookup } : {}),
      headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` }, truncateAt: SAMPLE_BYTES, timeoutMs: SAMPLE_TIMEOUT_MS,
    });
    if (r.status !== 200 && r.status !== 206) return { reason: statusReason(r.status), webPage: false };
    if (r.mime.startsWith("image/") || isImageHead(r.buf)) return "ok";
    if (r.mime === "text/html" || r.buf.toString("latin1").trimStart().startsWith("<")) return { reason: LINK_REASON.webPage, webPage: true };
    return { reason: LINK_REASON.unreachable, webPage: false };
  } catch (err) {
    return { reason: errorReason(err), webPage: false };
  }
}

/** Opens the first three links of a paste at once; never throws (its failures are information). */
export async function samplePastedLinks(table: PastedTable, deps: Pick<IngestDeps, "fetch" | "lookup">): Promise<Sample> {
  const urls = table.rows.flatMap((r) => r.urls).slice(0, SAMPLE_LINKS);
  const verdicts = await Promise.all(urls.map((url) => peekLink(url, deps)));
  const failures: Sample["failures"] = [];
  let ok = 0;
  let webPages = 0;
  verdicts.forEach((v, i) => {
    if (v === "ok") ok++;
    else {
      if (v.webPage) webPages++;
      failures.push({ url: urls[i]!.split(/[?#]/)[0]!, reason: v.reason });
    }
  });
  return { tried: urls.length, ok, webPages, failures };
}

/** The example name of the naming sentence: the first identifier, the first row name, or the first file name stem. */
function exampleName(table: PastedTable): string {
  if (table.shape === "id_and_links") return table.rows.find((r) => r.identifier)!.identifier!;
  if (table.shape === "links_grid") return table.rows.find((r) => r.name)?.name ?? "";
  const first = urlFileName(table.rows[0]?.urls[0] ?? "");
  return parseShotName(first).identifier || first;
}

/** The readback line: links per row (not for one link per line), the naming sentence and the sample sentence. */
export function readbackMessage(table: PastedTable, sample: Sample): string {
  const parts: string[] = [];
  const { min, max } = table.linksPerRow;
  if (table.shape !== "one_per_line") parts.push(min === max ? `${num(max)} ${plural(max, "link", "links")} per row.` : `${num(min)} to ${num(max)} links per row.`);
  const example = exampleName(table);
  if (table.shape === "id_and_links") parts.push(`Products will be named by the first column, for example ${example}.`);
  else if (table.shape === "links_grid") parts.push(`This paste has no product code column, so products will be named from the photo file names, for example ${example}. To name them yourself, copy the product code column in as the first column.`);
  else parts.push(`Products will be named from the file names, for example ${example}.`);
  if (sample.tried > 0) {
    const opened = sample.tried === 1 ? "We opened the link" : `We opened the first ${num(sample.tried)} links`;
    parts.push(sample.failures.length === 0 ? `${opened}: all fine.` : `${opened}: ${num(sample.ok)} of ${num(sample.tried)} opened; ${sample.failures[0]!.reason}.`);
  }
  return parts.join(" ");
}

/**
 * What the paste box shows for a url_list readback: the pill, the line (`detected.message`) and the
 * notes below it (share pages, rows with the same name, ignored cells), each an exact sentence.
 */
export function pasteReadback(d: Pick<Detected, "fileCount" | "rows" | "shape" | "collisions" | "ignoredCells" | "sample" | "message">): { pill: string; message: string; notes: string[] } {
  const links = d.fileCount ?? 0;
  const rows = d.rows ?? 0;
  const pill = d.shape === "one_per_line" || !d.shape ? `${num(links)} image ${plural(links, "link", "links")}` : `${num(rows)} ${plural(rows, "row", "rows")}, ${num(links)} ${plural(links, "link", "links")}`;
  const notes: string[] = [];
  if ((d.sample?.webPages ?? 0) > 0) notes.push(SHARE_PAGES);
  for (const c of d.collisions ?? []) notes.push(`Rows ${listAnd(c.rows.map(num))} would get the same name, ${c.name}. Check those rows before you continue.`);
  const ignored = d.ignoredCells ?? 0;
  if (ignored > 0) notes.push(`${num(ignored)} empty or non-link ${plural(ignored, "cell was", "cells were")} ignored.`);
  return { pill, message: d.message, notes };
}

/** The step 2 Google access status for a check result (DetectedStep2.googleAccess). */
export function accessStatus(result: Detected | { kind: UploadKind; error: string }): "ok" | "no_access" | "blocked" {
  if (!("error" in result)) return "ok";
  return result.error === GOOGLE_POLICY_BLOCKED || result.error === FOLDER_TOO_LARGE ? "blocked" : "no_access";
}

/**
 * The instant access check for pasted text (the first Google link when several are pasted; 06 calls
 * it once per link). Sentences, exactly the prototype copy:
 * - readable sheet: `Google Sheet "<title>", <n> rows, <m> image columns found.`
 * - 403/404 from Sheets: "Share the sheet with the address above, then paste again."
 * - 403/404 from Drive (or an empty listing, which is what an unshared folder returns): "Share the folder ..."
 * - a 403 about domain policy or cannotShareOutsideDomain: "Your Google settings block sharing ..."
 * - a URL list (spec 14b F2): the readback. `rows`, `fileCount` (= links), `linksPerRow`, `shape`,
 *   `collisions`, `ignoredCells`, the `sample` of the first three links and `message` (readbackMessage);
 *   pasteReadback turns it into the pill and the notes. A list whose sampled links all fail is still
 *   a result, never an error: the sample never blocks the paste.
 * Errors that are not about access are thrown.
 */
export async function checkLinkAccess(text: string, deps: Pick<IngestDeps, "sheets" | "drive" | "fetch" | "lookup">): Promise<Detected | { kind: UploadKind; error: string }> {
  const found = detectPastedText(text);
  if (!found) return { kind: "url_list", error: NOTHING_TO_CHECK };

  if (found.kind === "url_list") {
    const table = parsePastedLinks(text);
    const sample = await samplePastedLinks(table, deps);
    return {
      kind: "url_list", rows: table.rows.length, fileCount: table.links, linksPerRow: table.linksPerRow, shape: table.shape,
      collisions: table.collisions, ignoredCells: table.ignoredCells, sample, message: readbackMessage(table, sample),
    };
  }

  if (found.kind === "google_sheet") {
    if (!deps.sheets) throw new Error("The Google Sheets client is not configured.");
    const link = [...text.matchAll(SHEET_LINK)][0]![0];
    try {
      const { title, table } = await readGoogleSheet(deps.sheets, link);
      return googleSheetDetected(title, table);
    } catch (err) {
      const sentence = googleAccessError(err, "sheet");
      if (!sentence) throw err;
      return { kind: "google_sheet", error: sentence };
    }
  }

  if (!deps.drive) throw new Error("The Google Drive client is not configured.");
  try {
    const res = await listChildren(deps.drive, found.ids[0]!);
    if (!(res.data.files ?? []).length) return { kind: "drive_folder", error: FOLDER_NO_ACCESS };
    return { kind: "drive_folder", message: DRIVE_FOLDER_OK };
  } catch (err) {
    const sentence = googleAccessError(err, "folder");
    if (!sentence) throw err;
    return { kind: "drive_folder", error: sentence };
  }
}
