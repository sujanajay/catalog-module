// Image check (spec 04, "Image check"): sniff the real type from the bytes, read the dimensions and
// classify what cannot be used. HEIC/HEIF is a normal image here; 05 converts it before decoding.
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { MIN_SOURCE_LONG_SIDE_PX } from "../channels";
import { flagReason, type OutputFlag } from "../types";

/**
 * A usable image. `width` and `height` are 0 when they could not be read yet (a HEIC file whose
 * container has no readable `ispe` box); 05's `prepare()` fills them after converting the file.
 */
export interface ImageInfo { mime: string; ext: string; width: number; height: number; hasAlpha: boolean; pages: number; orientation: number | null; space: string; ok: true }
export type ImageCheck = ImageInfo | { ok: false; reason: "unsupported" | "corrupt" | "not_image"; message: string };

/** Types sharp decodes with its prebuilt binary (file-type ext names). */
const DECODABLE = new Set(["jpg", "png", "webp", "tif", "gif", "avif"]);

export function unsupportedMessage(name: string, format: string): string {
  return flagReason("unsupported", { name, format });
}
export function corruptMessage(name: string): string {
  return `${name} is corrupt (cannot be decoded).`;
}
export function notImageMessage(name: string): string {
  return `${name} is not an image.`;
}

/**
 * The kind of an image-check reject from its sentence, or null for any other sentence. Lets the
 * step 4 warning tell unreadable files apart from grouping rejects in `GroupingResult.rejected`.
 */
export function classifyImageReject(reason: string): "unsupported" | "corrupt" | "not_image" | null {
  if (/ is an? \S+ file\. Save it as JPEG or PNG and add it again\.$/.test(reason)) return "unsupported";
  if (reason.endsWith(" is corrupt (cannot be decoded).")) return "corrupt";
  if (reason.endsWith(" is not an image.")) return "not_image";
  return null;
}

/**
 * Sniff the bytes (the full file when given, else `head`, the first bytes) and, when `fullOrNull`
 * is given, decode the whole file so a truncated or broken image is caught here rather than in 05.
 * - HEIC/HEIF: `image/heic`, ext `heic`; dimensions from the container's `ispe` box, else 0.
 * - BMP and other image formats sharp cannot decode: `unsupported`.
 * - PDF, documents, archives, unknown bytes: `not_image`.
 * - jpeg, png, webp, tiff, gif, avif: probed with sharp metadata (first page only); a decode error is `corrupt`.
 */
export async function checkImage(head: Buffer, fullOrNull: Buffer | null, name: string): Promise<ImageCheck> {
  // TIFF keeps its first directory wherever the writer put it, often past the head, so the full
  // bytes are sniffed when we have them.
  const type = await fileTypeFromBuffer(fullOrNull ?? head);
  if (!type || !type.mime.startsWith("image/")) return { ok: false, reason: "not_image", message: notImageMessage(name) };

  if (type.ext === "heic") {
    const size = readHeifSize(fullOrNull ?? head);
    return {
      ok: true, mime: "image/heic", ext: "heic", width: size?.width ?? 0, height: size?.height ?? 0,
      hasAlpha: false, pages: 1, orientation: null, space: "",
    };
  }
  if (!DECODABLE.has(type.ext)) {
    return { ok: false, reason: "unsupported", message: unsupportedMessage(name, type.ext.toUpperCase()) };
  }

  const bytes = fullOrNull ?? head;
  try {
    const meta = await sharp(bytes, { pages: 1, failOn: "warning" }).metadata();
    // metadata() reads only the header; decoding the pixels is what finds a truncated file.
    if (fullOrNull) await sharp(fullOrNull, { pages: 1, failOn: "warning" }).raw().toBuffer();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    return {
      ok: true, mime: type.mime, ext: type.ext, width: meta.width, height: meta.height,
      hasAlpha: meta.hasAlpha ?? false, pages: meta.pages ?? 1, orientation: meta.orientation ?? null, space: meta.space ?? "",
    };
  } catch {
    // With only the head, a failed probe says nothing about the file; the full bytes decide later.
    if (!fullOrNull) {
      return { ok: true, mime: type.mime, ext: type.ext, width: 0, height: 0, hasAlpha: false, pages: 1, orientation: null, space: "" };
    }
    return { ok: false, reason: "corrupt", message: corruptMessage(name) };
  }
}

/** Flags for the version row: `small_source` when the long side is under MIN_SOURCE_LONG_SIDE_PX. */
export function imageFlags(info: ImageInfo): OutputFlag[] {
  const longSide = Math.max(info.width, info.height);
  return longSide > 0 && longSide < MIN_SOURCE_LONG_SIDE_PX ? ["small_source"] : [];
}

// --- HEIF container reader -------------------------------------------------

interface Box { type: string; start: number; end: number; body: number }

/** Child boxes of `buf[from..to)` (ISO BMFF: 32-bit size, 4-char type, optional 64-bit size). */
function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < body - p || p + size > to) break;
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}

/**
 * Width and height from the `ispe` properties in `meta/iprp/ipco`. A HEIC usually holds several
 * (the full image, its grid tiles, a thumbnail); the largest is the image itself. Null when absent.
 */
export function readHeifSize(buf: Buffer): { width: number; height: number } | null {
  const meta = boxes(buf, 0, buf.length).find((b) => b.type === "meta");
  if (!meta) return null;
  const iprp = boxes(buf, meta.body + 4, meta.end).find((b) => b.type === "iprp"); // meta is a full box
  const ipco = iprp && boxes(buf, iprp.body, iprp.end).find((b) => b.type === "ipco");
  if (!ipco) return null;
  let best: { width: number; height: number } | null = null;
  for (const b of boxes(buf, ipco.body, ipco.end)) {
    if (b.type !== "ispe" || b.body + 12 > b.end) continue;
    const width = buf.readUInt32BE(b.body + 4); // after version and flags
    const height = buf.readUInt32BE(b.body + 8);
    if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
  }
  return best;
}
