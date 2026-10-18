// Local files (spec 04, "Local files"): the server side of the browser's direct-to-GCS upload. The
// browser PUTs every file to its own signed URL; afterwards completeUploads turns what landed in
// `uploads/<uploadId>/` into SourceItems. The identifier mode is applied later in groupItems, so a
// step 2 change never needs the files again.
import { parseShotName, sanitizeSegment, uploadPath } from "../naming";
import { extFromMime, getBucketName, mimeFromPath, parseGsUri, toGsUri, type signedPutUrl } from "../../storage";
import type { UploadKind } from "../types";
import type { BytesRef, CollectInput, SourceItem } from "./types";

export interface PlannedUpload { relativePath: string; objectPath: string; putUrl: string; contentType: string }

/** Parallel signing and HEAD requests per call; keeps a 3,000-file folder well under API rate limits. */
const PARALLEL = 16;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Path segments of a browser or archive path ("\" and "/" both separate; empty, "." and ".." dropped). */
function segmentsOf(relativePath: string): string[] {
  return relativePath.split(/[\\/]/).filter((s) => s !== "" && s !== "." && s !== "..");
}

/** `__MACOSX/` and dotfiles (`.DS_Store`, `._x.jpg`, anything under a dot folder) are skipped. */
export function isSkippedPath(relativePath: string): boolean {
  return segmentsOf(relativePath).some((s) => s === "__MACOSX" || s.startsWith("."));
}

/**
 * Object path of one browser file. `uploadPath` sanitises a single name and would drop the "/"
 * between folders, so each segment is sanitised on its own and the folders are kept: the folder
 * and grandparent names drive identifierMode "folder", numeric stems and `_rect`/`_square`. For a
 * file without folders this is exactly `uploadPath(prefix, uploadId, relativePath)`.
 */
export function uploadObjectPath(prefix: string, uploadId: string, relativePath: string): string {
  const segs = segmentsOf(relativePath);
  if (!segs.length) throw new Error(`"${relativePath}" is not a file name.`);
  return uploadPath(prefix, uploadId, "") + segs.map(sanitizeSegment).join("/");
}

/** One signed PUT per file; TTL is signedPutUrl's default. Two files that would land on the same object are refused. */
export async function planSignedUploads(
  input: { prefix: string; uploadId: string; files: { relativePath: string; size: number; type: string }[] },
  sign: typeof signedPutUrl,
): Promise<PlannedUpload[]> {
  const seen = new Map<string, string>();
  const planned = input.files.map((f) => {
    const objectPath = uploadObjectPath(input.prefix, input.uploadId, f.relativePath);
    const other = seen.get(objectPath);
    if (other !== undefined) {
      throw new Error(`${other} and ${f.relativePath} would be stored under the same name. Rename one and add them again.`);
    }
    seen.set(objectPath, f.relativePath);
    const contentType = f.type || mimeFromPath(f.relativePath);
    return { relativePath: f.relativePath, objectPath, contentType };
  });
  return mapLimit(planned, PARALLEL, async (p) => ({ ...p, putUrl: await sign(p.objectPath, p.contentType) }));
}

/** A SourceItem for a file at `relativePath`: `parseShotName` of the base name, `folder` = nearest parent folder. */
export function sourceItemFromPath(relativePath: string, bytes: BytesRef, uploadId: string, origin: UploadKind): SourceItem {
  const segs = segmentsOf(relativePath);
  const base = segs[segs.length - 1] ?? relativePath;
  const parsed = parseShotName(base);
  const dot = base.lastIndexOf(".");
  return {
    identifier: parsed.identifier,
    n: parsed.n,
    suffix: parsed.suffix,
    originalName: segs.join("/"),
    folder: segs.length > 1 ? segs[segs.length - 2]! : null,
    sheetIdentifier: null,
    ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : "",
    bytes,
    uploadId,
    origin,
    warnings: [],
  };
}

/**
 * After the browser finishes: HEAD each object and produce SourceItems with `bytes = {kind: "gcs"}`.
 * - An upload row whose `gcsUri` names one object is one file; its `relativePath` (else `name`) is
 *   kept verbatim in `originalName`.
 * - Otherwise (a folder drop, or a Drive folder the web tier streamed in) every object under
 *   `gcsUri` (when it ends in "/") or `<prefix>/uploads/<uploadId>/` is a file, and the relative
 *   path is the object name below that prefix (sanitised segments; the verbatim names are not
 *   stored anywhere else).
 * A file without an extension takes it from the stored content type. Junk paths are skipped.
 */
export async function completeUploads(input: CollectInput): Promise<SourceItem[]> {
  const { upload, deps } = input;
  const origin = upload.kind;
  const single = upload.gcsUri && !upload.gcsUri.endsWith("/") ? upload.gcsUri : null;

  let files: { gsUri: string; relativePath: string }[];
  if (single) {
    files = [{ gsUri: single, relativePath: upload.relativePath || upload.name }];
  } else {
    const base = upload.gcsUri ?? toGsUri(getBucketName(), uploadPath(input.prefix, upload.id, ""));
    const basePath = parseGsUri(base).path;
    const listed = await deps.storage.listObjects(base);
    files = listed
      .filter((u) => !u.endsWith("/"))
      .map((u) => ({ gsUri: u, relativePath: parseGsUri(u).path.slice(basePath.length) }));
  }
  files = files.filter((f) => !isSkippedPath(f.relativePath)).sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  let done = 0;
  const items = await mapLimit(files, PARALLEL, async (f) => {
    const head = await deps.storage.headObject(f.gsUri);
    input.onProgress?.(++done, files.length);
    if (!head.exists) {
      if (single) throw new Error(`${f.relativePath} did not finish uploading. Add it again.`);
      return null; // removed between the listing and the HEAD
    }
    const item = sourceItemFromPath(f.relativePath, { kind: "gcs", gsUri: f.gsUri }, upload.id, origin);
    if (!item.ext && head.contentType) {
      const ext = extFromMime(head.contentType);
      if (ext !== "bin") item.ext = ext;
    }
    return item;
  });
  return items.filter((i): i is SourceItem => i !== null);
}
