// Naming and object paths (spec 02, "Naming and paths"). There is no version argument, no batch id
// and no SKU id in any public path. `publicObjectPath` is the only builder of a public path.
import { flagReason, type ChannelId } from "./types";

export const TEST_PREFIX = "catalog-test/";
const ROOTS = ["catalog/", TEST_PREFIX] as const;

export interface ParsedShotName {
  identifier: string;
  n: number | null;
  suffix: "" | "_rect" | "_square";
  stem: string;
}

const SHAPE_SUFFIX = /[_-](rect|square)$/i;
/** `<identifier><sep>[v]<1 to 3 digits>`: four or more digits stay part of the identifier. */
const SHOT_NUMBER = /^(.+)[_-][vV]?(\d{1,3})$/;

function takeShape(s: string): { rest: string; suffix: ParsedShotName["suffix"] } {
  const m = SHAPE_SUFFIX.exec(s);
  if (!m || m.index === 0) return { rest: s, suffix: "" };
  return { rest: s.slice(0, m.index), suffix: m[1]!.toLowerCase() === "rect" ? "_rect" : "_square" };
}

/**
 * Split a file name into identifier, shot number and shape suffix (spec 02 "Naming and paths").
 * - Directories and the extension are dropped; `stem` is the file name without its extension.
 * - The shot number is the number after the last `_` or `-` (`_1`, `-1`, `_01`; a single `v` before
 *   it is tolerated, so `ABC123_2_v3` is identifier `ABC123_2`, shot 3). At most three digits; a
 *   longer trailing number is part of the identifier and `n` is null.
 * - `_rect` or `_square` at the end or just before the number goes into `suffix`.
 * - `n` is null when there is no shot number; the caller assigns 1 to a product's single file.
 * - A purely numeric stem of up to three digits (`1.jpg`, `02.jpg`) has no identifier of its own:
 *   identifier "" and `n` the number (04 takes the identifier from the folder name).
 * The identifier is returned verbatim (case and spaces kept).
 */
export function parseShotName(fileName: string): ParsedShotName {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const trimmed = stem.trim();
  if (/^\d{1,3}$/.test(trimmed)) return { identifier: "", n: Number(trimmed), suffix: "", stem };

  const end = takeShape(trimmed);
  const m = SHOT_NUMBER.exec(end.rest);
  if (!m) return { identifier: end.rest, n: null, suffix: end.suffix, stem };
  const n = Number(m[2]);
  if (end.suffix) return { identifier: m[1]!, n, suffix: end.suffix, stem };
  const before = takeShape(m[1]!);
  return { identifier: before.rest, n, suffix: before.suffix, stem };
}

export interface NumberedShot<T> {
  item: T;
  /** Position 1..k: the shot number used in paths and the sheet. */
  n: number;
  /** The number read from the file name. */
  original: number;
}

export interface RenumberResult<T> {
  shots: NumberedShot<T>[];
  /** File-name numbers between 1 and the highest one that no file carries. */
  missing: number[];
  flag: "numbering_gap" | null;
  /** The sheet row note when numbers are missing, else null. */
  note: string | null;
}

/**
 * Numbering rule (spec 02): shots are ordered by the number in their file names and renumbered to
 * positions 1..k, so there is never a blank cell for a gap. Arrival order never matters (the sort is
 * by number, ties keep input order). A gap gives `numbering_gap` and the notes sentence.
 */
export function renumberShots<T>(items: readonly T[], numberOf: (item: T) => number): RenumberResult<T> {
  const sorted = items
    .map((item, i) => ({ item, original: numberOf(item), i }))
    .sort((a, b) => a.original - b.original || a.i - b.i);
  const shots = sorted.map((s, idx) => ({ item: s.item, n: idx + 1, original: s.original }));
  const present = new Set(sorted.map((s) => s.original));
  const highest = sorted.length ? sorted[sorted.length - 1]!.original : 0;
  const missing: number[] = [];
  for (let k = 1; k < highest; k++) if (!present.has(k)) missing.push(k);
  if (!missing.length) return { shots, missing, flag: null, note: null };
  return { shots, missing, flag: "numbering_gap", note: flagReason("numbering_gap", { list: missing.join(", ") }) };
}

/** Spaces to "_"; keeps letters, digits, "-", "_" and "."; case kept. */
export function sanitizeSegment(s: string): string {
  return s.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
}

/** Lowercase, sanitised brand slug. */
export function brandSlug(name: string): string {
  return sanitizeSegment(name).toLowerCase();
}

/** Uppercase with spaces, "_" and "-" removed. Used for product_key and alias keys. */
export function normalizeKey(s: string): string {
  return s.toUpperCase().replace(/[\s_-]/g, "");
}

export function rootPrefix(isTest: boolean): "catalog" | "catalog-test" {
  return isTest ? "catalog-test" : "catalog";
}

/** `<root>/<brand>/<batchId>` in the private bucket. */
export function batchPrefix(brandSlug: string, batchId: string, isTest: boolean): string {
  return `${rootPrefix(isTest)}/${brandSlug}/${batchId}`;
}

/**
 * Spec 18 lifecycle 3.1: `<root>/<brand>` in the private bucket, the prefix of every stored enlargement. Not per batch:
 * the object key is the identity (the photo's pixels, the upscaler with its export hash, the scale), so a second
 * batch of the same photo, a replacement with the same bytes or a re-wanted row finds the object without a call.
 */
export function enlargementPrefix(brandSlug: string, isTest: boolean): string {
  return `${rootPrefix(isTest)}/${brandSlug}`;
}

/** `<root>/<brand>/<pathKey>/` in the public bucket (always ends with "/"). */
export function productPrefix(brandSlug: string, pathKey: string, isTest: boolean): string {
  return `${rootPrefix(isTest)}/${brandSlug}/${pathKey}/`;
}

/** `<pathKey>_<n>`. */
export function shotStem(pathKey: string, n: number): string {
  return `${pathKey}_${n}`;
}

/** `<prefix>/uploads/<uploadId>/<sanitised file name>`. */
export function uploadPath(prefix: string, uploadId: string, fileName: string): string {
  return `${prefix}/uploads/${uploadId}/${sanitizeSegment(fileName)}`;
}

/** `<prefix>/raw/<pathKey>/<pathKey>_<n>.<ext>`. */
export function rawPath(prefix: string, pathKey: string, n: number, ext: string): string {
  return `${prefix}/raw/${pathKey}/${shotStem(pathKey, n)}.${ext.replace(/^\./, "")}`;
}

/** `<prefix>/derived/<pathKey>/<pathKey>_<n>.<kind>.png`. */
export function derivedPath(prefix: string, pathKey: string, n: number, kind: string): string {
  return `${prefix}/derived/${pathKey}/${shotStem(pathKey, n)}.${kind}.png`;
}

/**
 * Spec 18 lifecycle 3.1: `<prefix>/derived/<pathKey>/<pathKey>_<n>.<upscaler slug>.s<scale>.<identity hash>.jpg`, the
 * stored enlargement of one identity (the whole prepared photo, enlarged by the upscaler at the effective scale) next
 * under the brand's enlargement prefix (enlargementPrefix), in the private assets bucket. Never public, never raw. The upscaler is its
 * identity id with the export hash (`swinir-x2+cpu@f477a052`), lower case, anything but letters, digits, dots and
 * dashes as a dash. Same identity, same key: a re-delivery, a re-wanted row or a second batch of the same photo finds
 * the object. The metadata names the identity too (validateEnlargedObject).
 */
export function enlargedPath(prefix: string, pathKey: string, n: number, upscaler: string, scale: number, identityHash: string): string {
  return `${prefix}/derived/${pathKey}/${shotStem(pathKey, n)}.${upscalerSlug(upscaler)}.s${scaleLabel(scale)}.${identityHash}.jpg`;
}
/** Spec 18 lifecycle 3.2 tile route: tile `i` of an enlargement, `<enlargedPath key>.tile-<i>.jpg`. */
export function enlargedTilePath(key: string, i: number): string {
  return `${key}.tile-${i}.jpg`;
}
function upscalerSlug(upscaler: string): string {
  return upscaler.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}
/** The scale as a key part: an integer as is (`2`), a fraction to 3 decimals without trailing zeros (`3.333`). */
function scaleLabel(scale: number): string {
  return String(Number(scale.toFixed(3)));
}

/** `<prefix>/staging/<pathKey>/<channel>/<pathKey>_<n>.jpg`. */
export function stagingPath(prefix: string, pathKey: string, channel: ChannelId, n: number): string {
  return `${prefix}/staging/${pathKey}/${channel}/${shotStem(pathKey, n)}.jpg`;
}

/** `<prefix>/exports/<name>` (links-v<k>.xlsx|csv, report-v<k>.json). */
export function exportPath(prefix: string, name: string): string {
  return `${prefix}/exports/${name}`;
}

/** `<root>/<brand>/exports/<name>` (links-<yyyymmdd-hhmmss>.xlsx|csv). */
export function brandExportPath(brandSlug: string, name: string, isTest: boolean): string {
  return `${rootPrefix(isTest)}/${brandSlug}/exports/${name}`;
}

/** `<root>/<brand>/<pathKey>/<channel>/<pathKey>_<n>.jpg`: the only builder of a public path. */
export function publicObjectPath(brandSlug: string, pathKey: string, channel: ChannelId, n: number, isTest: boolean): string {
  return `${productPrefix(brandSlug, pathKey, isTest)}${channel}/${shotStem(pathKey, n)}.jpg`;
}

/** `https://storage.googleapis.com/<bucket>/<path>` with every segment URI-encoded. */
export function publicUrl(bucket: string, objectPath: string): string {
  return `https://storage.googleapis.com/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Throws unless `objectPath` lies under `productPrefix` and `productPrefix` is a product prefix
 * (`catalog/<brand>/<pathKey>/` or `catalog-test/<brand>/<pathKey>/`, trailing slash required).
 */
export function assertWithinProduct(objectPath: string, productPrefix: string): void {
  const segments = productPrefix.split("/");
  const isProductPrefix =
    ROOTS.some((r) => productPrefix.startsWith(r)) &&
    productPrefix.endsWith("/") &&
    segments.length === 4 &&
    segments.slice(0, 3).every((s) => s !== "" && s !== "." && s !== "..");
  if (!isProductPrefix) {
    throw new Error(`Refusing to touch ${objectPath}: ${productPrefix} is not a product prefix under catalog/ or catalog-test/.`);
  }
  const rest = objectPath.slice(productPrefix.length);
  if (!objectPath.startsWith(productPrefix) || rest === "" || rest.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`Refusing to touch ${objectPath}: it is outside the product prefix ${productPrefix}.`);
  }
}

/** Throws unless `objectPath` starts with `catalog-test/`. */
export function assertTestPrefix(objectPath: string): void {
  if (!objectPath.startsWith(TEST_PREFIX) || objectPath.split("/").some((s) => s === "..")) {
    throw new Error(`Refusing to touch ${objectPath}: test cleanup is allowed only under ${TEST_PREFIX}.`);
  }
}
