// Detection of what was dropped or pasted (spec 04, "Detection"), and the instant access check
// behind the paste box. The check runs on the web tier as catalog-web@ (SHARE_SA_EMAIL, 02), the
// address shown next to the box, so its sentences say "the address above".
import type { UploadKind } from "../types";
import { FOLDER_NO_ACCESS, GOOGLE_POLICY_BLOCKED, googleAccessError, googleSheetDetected, parseSpreadsheetId, readGoogleSheet } from "./google-sheet";
import { FOLDER_TOO_LARGE, listChildren, parseFolderId } from "./drive-folder";
import { parseUrlList } from "./url-list";
import type { Detected, IngestDeps } from "./types";

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
  const urls = parseUrlList(text);
  if (urls.length) return { kind: "url_list", ids: urls.map((u) => u.url) };
  return null;
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
 * - a URL list: `fileCount` = the number of links (the pill "<n> image links") and URL_LIST_SENTENCE.
 * Errors that are not about access are thrown.
 */
export async function checkLinkAccess(text: string, deps: Pick<IngestDeps, "sheets" | "drive" | "fetch">): Promise<Detected | { kind: UploadKind; error: string }> {
  const found = detectPastedText(text);
  if (!found) return { kind: "url_list", error: NOTHING_TO_CHECK };

  if (found.kind === "url_list") {
    return { kind: "url_list", fileCount: found.ids.length, rows: found.ids.length, message: URL_LIST_SENTENCE };
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
