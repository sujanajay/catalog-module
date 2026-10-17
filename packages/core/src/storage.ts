import type { Readable } from "node:stream";
import { Storage, type CopyResponse } from "@google-cloud/storage";
import { assertTestPrefix, assertWithinProduct, productPrefix } from "@catalog/core/catalog/naming";

/**
 * GCS helpers for the private bucket (BUCKET, default image-links-agent-assets) and the public
 * bucket (PUBLIC_BUCKET, default image-links-agent-public). The Storage client is created lazily
 * with Application Default Credentials; tests inject a fake via `setStorageClient`.
 *
 * Signed URLs (v4): on Cloud Run there is no key file, so the library signs through the IAM
 * Credentials `signBlob` API. The runtime service account needs
 * `roles/iam.serviceAccountTokenCreator` on itself for that to work (bootstrap grants it to catalog-web@).
 *
 * Public bucket rule: `stageCopyToPublic` and `deletePublicObject` are the only two functions that
 * write to the public bucket, and both run only in the worker.
 */

/** Minimal surface of `Storage` we use - lets tests pass a hand-rolled fake. */
export type StorageLike = Pick<Storage, "bucket">;

let client: StorageLike | undefined;

export function setStorageClient(c: StorageLike | undefined): void {
  client = c;
}

function getStorage(): StorageLike {
  if (!client) client = new Storage();
  return client;
}

export function getBucketName(env: NodeJS.ProcessEnv = process.env): string {
  const b = env.BUCKET;
  if (!b) throw new Error("BUCKET env var is not set");
  return b;
}

export const DEFAULT_PUBLIC_BUCKET = "image-links-agent-public";

/** PUBLIC_BUCKET, default "image-links-agent-public". */
export function getPublicBucketName(env: NodeJS.ProcessEnv = process.env): string {
  return env.PUBLIC_BUCKET || DEFAULT_PUBLIC_BUCKET;
}

/** Cache header on every public object: a re-upload shows within five minutes. */
export const PUBLIC_CACHE_CONTROL = "public, max-age=300";

/** Max TTL for a v4 signed URL (7 days). */
export const MAX_SIGNED_URL_TTL_SEC = 7 * 86400;

/** Default TTL for a signed PUT (browser upload). */
export const SIGNED_PUT_TTL_SEC = 900;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
};

export function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase().split(";")[0]!.trim()] ?? "bin";
}

export function mimeFromPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const found = Object.entries(MIME_EXT).find(([, e]) => e === ext);
  if (found) return found[0];
  if (ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

export function toGsUri(bucket: string, objectPath: string): string {
  return `gs://${bucket}/${objectPath.replace(/^\/+/, "")}`;
}

export function parseGsUri(gsUri: string): { bucket: string; path: string } {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUri);
  if (!m) throw new Error(`Not a gs:// URI: ${gsUri}`);
  return { bucket: m[1]!, path: m[2]! };
}

// --- Errors and retries ------------------------------------------------------

/** A generation precondition failed (GCS HTTP 412): another run changed the object first. */
export class GenerationMismatchError extends Error {
  readonly objectPath: string;
  constructor(objectPath: string, options?: { cause?: unknown }) {
    super("Changed by another run. Start the batch again for this product.", options);
    this.name = "GenerationMismatchError";
    this.objectPath = objectPath;
  }
}

/** Attempts after the first one for a write, copy, delete or verify GET. */
export const STORAGE_RETRIES = 3;
/** Backoff base: waits 1 s, 2 s, 4 s. */
export const STORAGE_RETRY_BASE_MS = 1000;

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** HTTP status of a GCS ApiError (or a gaxios-style error), if it has one. */
export function httpStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof e.code === "number") return e.code;
  if (typeof e.status === "number") return e.status;
  if (typeof e.response?.status === "number") return e.response.status;
  return undefined;
}

/** 429, 5xx and network errors are retried; everything else (including 412) is not. */
export function isRetryableStorageError(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : "";
  return /socket hang up|network|ECONNRESET|ETIMEDOUT/i.test(message);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sleep: (ms: number) => Promise<void> = realSleep;

/** Test hook: replace the backoff sleep (pass undefined to restore the real one). */
export function setStorageSleep(fn: ((ms: number) => Promise<void>) | undefined): void {
  sleep = fn ?? realSleep;
}

/**
 * Run a storage call with up to STORAGE_RETRIES retries (1 s, 2 s, 4 s) on 429, 5xx and network
 * errors. A 412 becomes GenerationMismatchError and is never retried.
 */
async function withStorageRetry<T>(objectPath: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (httpStatusOf(err) === 412) throw new GenerationMismatchError(objectPath, { cause: err });
      if (attempt >= STORAGE_RETRIES || !isRetryableStorageError(err)) throw err;
      await sleep(STORAGE_RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

function isNotFound(err: unknown): boolean {
  return httpStatusOf(err) === 404;
}

/**
 * Product guard for a copy to the public bucket. The source must be a staged image in BUCKET,
 * `<root>/<brand>/<batchId>/staging/<pathKey>/<channel>/<file>`, and the target must be the same
 * product's `<root>/<brand>/<pathKey>/<channel>/<file>`; assertWithinProduct checks the target
 * against the product prefix taken from the staging path.
 */
function assertStagedForTarget(src: { bucket: string; path: string }, objectPath: string): void {
  const [root, brand, , stage, pathKey, channel, name, ...extra] = src.path.split("/");
  if (src.bucket !== getBucketName() || stage !== "staging" || !name || extra.length || (root !== "catalog" && root !== "catalog-test")) {
    throw new Error(`Refusing to write ${objectPath}: only staged images under catalog/ or catalog-test/ in the private bucket are published.`);
  }
  const prefix = productPrefix(brand!, pathKey!, root === "catalog-test");
  assertWithinProduct(objectPath, prefix);
  if (objectPath !== `${prefix}${channel}/${name}`) {
    throw new Error(`Refusing to write ${objectPath}: it is not the public path of the staged image ${src.path}.`);
  }
}

/** Clock skew allowed when deciding whether an object was created by this call. */
const CREATED_SKEW_MS = 60_000;

// --- Private bucket: lifted base -------------------------------------------

/** Upload to `BUCKET` at `path`; returns the gs:// URI. */
export async function uploadBuffer(path: string, buf: Buffer, mime: string): Promise<string> {
  const bucket = getBucketName();
  const objectPath = path.replace(/^\/+/, "");
  await withStorageRetry(objectPath, () =>
    getStorage().bucket(bucket).file(objectPath).save(buf, { contentType: mime, resumable: false }),
  );
  return toGsUri(bucket, objectPath);
}

export async function downloadBuffer(gsUri: string): Promise<{ buf: Buffer; mime: string }> {
  const { bucket, path } = parseGsUri(gsUri);
  const file = getStorage().bucket(bucket).file(path);
  const [[buf], [meta]] = await Promise.all([file.download(), file.getMetadata()]);
  const mime = typeof meta.contentType === "string" && meta.contentType ? meta.contentType : mimeFromPath(path);
  return { buf, mime };
}

/** v4 read-signed HTTPS URL; ttl is clamped to the 7-day v4 maximum. */
export async function signedUrl(gsUri: string, ttlSec: number = MAX_SIGNED_URL_TTL_SEC): Promise<string> {
  const { bucket, path } = parseGsUri(gsUri);
  const ttl = Math.max(1, Math.min(ttlSec, MAX_SIGNED_URL_TTL_SEC));
  const [url] = await getStorage()
    .bucket(bucket)
    .file(path)
    .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ttl * 1000 });
  return url;
}

// --- Additions (spec 02 "Storage") -----------------------------------------

/**
 * v4 write-signed URL for a browser PUT into `BUCKET` at `objectPath`. The browser must send the
 * same Content-Type header. ttl is clamped to the 7-day v4 maximum.
 */
export async function signedPutUrl(objectPath: string, contentType: string, ttlSec: number = SIGNED_PUT_TTL_SEC): Promise<string> {
  const bucket = getBucketName();
  const path = objectPath.replace(/^\/+/, "");
  const ttl = Math.max(1, Math.min(ttlSec, MAX_SIGNED_URL_TTL_SEC));
  const [url] = await getStorage()
    .bucket(bucket)
    .file(path)
    .getSignedUrl({ version: "v4", action: "write", contentType, expires: Date.now() + ttl * 1000 });
  return url;
}

export interface ObjectHead {
  exists: boolean;
  size: number | null;
  contentType: string | null;
  generation: string | null;
  crc32c: string | null;
}

/** Metadata of one object; `exists: false` (other fields null) when it is not there. */
export async function headObject(gsUri: string): Promise<ObjectHead> {
  const { bucket, path } = parseGsUri(gsUri);
  const file = getStorage().bucket(bucket).file(path);
  try {
    const [meta] = await withStorageRetry(path, () => file.getMetadata());
    return {
      exists: true,
      size: meta.size === undefined ? null : Number(meta.size),
      contentType: typeof meta.contentType === "string" ? meta.contentType : null,
      generation: meta.generation === undefined ? null : String(meta.generation),
      crc32c: typeof meta.crc32c === "string" ? meta.crc32c : null,
    };
  } catch (err) {
    if (isNotFound(err)) return { exists: false, size: null, contentType: null, generation: null, crc32c: null };
    throw err;
  }
}

function assertRange(start: number, endInclusive: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(endInclusive) || start < 0 || endInclusive < start) {
    throw new Error(`Invalid byte range ${start}-${endInclusive}`);
  }
}

/** Bytes `start..endInclusive` (both inclusive, as GCS ranges are). */
export async function readRange(gsUri: string, start: number, endInclusive: number): Promise<Buffer> {
  assertRange(start, endInclusive);
  const { bucket, path } = parseGsUri(gsUri);
  const [buf] = await getStorage().bucket(bucket).file(path).download({ start, end: endInclusive });
  return buf;
}

/** Stream of bytes `start..endInclusive` (both inclusive). */
export function createRangeStream(gsUri: string, start: number, endInclusive: number): Readable {
  assertRange(start, endInclusive);
  const { bucket, path } = parseGsUri(gsUri);
  return getStorage().bucket(bucket).file(path).createReadStream({ start, end: endInclusive });
}

/** gs:// URIs of every object whose name starts with the prefix of `gsPrefixUri`. */
export async function listObjects(gsPrefixUri: string): Promise<string[]> {
  const { bucket, path } = parseGsUri(gsPrefixUri);
  const [files] = await getStorage().bucket(bucket).getFiles({ prefix: path, autoPaginate: true });
  return files.map((f) => toGsUri(bucket, f.name));
}

export interface GenerationPrecondition {
  /** 0 = the object must not exist yet; otherwise the live generation expected. */
  ifGenerationMatch: number | string;
}

/**
 * Copy a staged JPEG from the private bucket to `objectPath` in the public bucket under a generation
 * precondition. Returns the new live generation and its crc32c. A 412 throws GenerationMismatchError.
 */
export async function stageCopyToPublic(
  stagingGsUri: string,
  objectPath: string,
  { ifGenerationMatch }: GenerationPrecondition,
): Promise<{ generation: string; crc32c: string }> {
  const src = parseGsUri(stagingGsUri);
  assertStagedForTarget(src, objectPath);
  const storage = getStorage();
  const srcFile = storage.bucket(src.bucket).file(src.path);
  const dest = storage.bucket(getPublicBucketName()).file(objectPath);
  const startedAt = Date.now();
  let copied: CopyResponse[0];
  let apiResponse: CopyResponse[1];
  try {
    [copied, apiResponse] = await withStorageRetry<CopyResponse>(objectPath, () =>
      srcFile.copy(dest, {
        preconditionOpts: { ifGenerationMatch },
        contentType: "image/jpeg",
        cacheControl: PUBLIC_CACHE_CONTROL,
      }),
    );
  } catch (err) {
    // A retried copy (ours or the client's) gets 412 when an earlier attempt succeeded but its
    // answer was lost. If the live object is this staged image, created during this call, it is ours.
    if (err instanceof GenerationMismatchError) {
      const landed = await copyAlreadyLanded(srcFile, dest, startedAt);
      if (landed) return landed;
    }
    throw err;
  }
  // The rewrite response carries the new object resource; the returned File's metadata may not be
  // refreshed by the client, so it is the fallback, and a metadata read is the last resort.
  const resource = (apiResponse as { resource?: { generation?: unknown; crc32c?: unknown } } | undefined)?.resource;
  let generation = resource?.generation ?? copied.metadata?.generation;
  let crc32c = resource?.crc32c ?? copied.metadata?.crc32c;
  if (generation === undefined || crc32c === undefined) {
    const [meta] = await withStorageRetry(objectPath, () => copied.getMetadata());
    generation = meta.generation;
    crc32c = meta.crc32c;
  }
  if (generation === undefined || typeof crc32c !== "string") {
    throw new Error(`Copy to ${objectPath} returned no generation or crc32c`);
  }
  return { generation: String(generation), crc32c };
}

type GcsFile = ReturnType<ReturnType<StorageLike["bucket"]>["file"]>;

/** The live object's generation when it holds the staged bytes and was created since `since`; else null. */
async function copyAlreadyLanded(srcFile: GcsFile, dest: GcsFile, since: number): Promise<{ generation: string; crc32c: string } | null> {
  try {
    const [[s], [d]] = await Promise.all([srcFile.getMetadata(), dest.getMetadata()]);
    const created = Date.parse(String(d.timeCreated ?? ""));
    const same = typeof d.crc32c === "string" && d.crc32c === s.crc32c && String(d.size) === String(s.size);
    if (!same || d.generation === undefined || !(created >= since - CREATED_SKEW_MS)) return null;
    return { generation: String(d.generation), crc32c: d.crc32c as string };
  } catch {
    return null;
  }
}

/**
 * Delete one public object under a generation precondition, only inside `productPrefix`
 * (checked before the client is touched). Returns false when the object was already gone.
 */
export async function deletePublicObject(
  objectPath: string,
  productPrefix: string,
  { ifGenerationMatch }: GenerationPrecondition,
): Promise<boolean> {
  assertWithinProduct(objectPath, productPrefix);
  const file = getStorage().bucket(getPublicBucketName()).file(objectPath);
  try {
    await withStorageRetry(objectPath, () => file.delete({ ifGenerationMatch }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Mark a superseded raw object so the assets lifecycle removes it 180 days later. */
export async function setCustomTime(gsUri: string, when: Date): Promise<void> {
  const { bucket, path } = parseGsUri(gsUri);
  const file = getStorage().bucket(bucket).file(path);
  await withStorageRetry(path, () => file.setMetadata({ customTime: when.toISOString() }));
}

/**
 * Delete every object under a `catalog-test/` prefix (either bucket); returns how many were deleted.
 * The only bulk delete in the codebase.
 */
export async function deleteTestObjects(gsPrefixUri: string): Promise<number> {
  const { bucket, path } = parseGsUri(gsPrefixUri);
  assertTestPrefix(path);
  const b = getStorage().bucket(bucket);
  const [files] = await b.getFiles({ prefix: path, autoPaginate: true });
  let deleted = 0;
  for (const f of files) {
    assertTestPrefix(f.name);
    try {
      await withStorageRetry(f.name, () => b.file(f.name).delete());
      deleted++;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return deleted;
}
