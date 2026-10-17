// Naming and object paths (spec 02, "Naming and paths"). There is no version argument, no batch id
// and no SKU id in any public path. `publicObjectPath` is the only builder of a public path.
import type { ChannelId } from "./types";

export const TEST_PREFIX = "catalog-test/";
const ROOTS = ["catalog/", TEST_PREFIX] as const;

export interface ParsedShotName {
  identifier: string;
  n: number | null;
  suffix: "" | "_rect" | "_square";
  stem: string;
}

/**
 * Split a file name into identifier, shot number and suffix (rules in spec 02 "Naming and paths").
 * STUB: workstream A implements this with its unit tests.
 */
export function parseShotName(_fileName: string): ParsedShotName {
  throw new Error("parseShotName: not implemented");
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
