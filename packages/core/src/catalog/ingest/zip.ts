// Zip adapter (spec 04, "Zip"). The archive stays in GCS: unzipper's Open.custom reads only the
// central directory through ranged reads, and each entry is later streamed on its own by runIngest.
import { Readable } from "node:stream";
import unzipper, { type CentralDirectory } from "unzipper";
import { DEFAULT_MAX_BYTES } from "../../safe-url";
import type { Adapter, BytesRef, CollectInput, IngestDeps, SourceItem } from "./types";
import { isSkippedPath, sourceItemFromPath } from "./local-files";

/** Entries larger than this are skipped with a sentence (the same 40 MB cap as fetched links). */
export const ZIP_ENTRY_MAX_BYTES = DEFAULT_MAX_BYTES;

export function nestedZipMessage(name: string): string {
  return `Nested zip files are not opened. Unzip ${name} and upload its contents.`;
}
export function tooLargeMessage(name: string): string {
  return `${name} is larger than 40 MB and was skipped.`;
}

const REJECT_PATTERNS = [/^Nested zip files are not opened\. Unzip .+ and upload its contents\.$/, / is larger than 40 MB and was skipped\.$/];

/**
 * The reject sentence the zip adapter attached to an item (nested zip, entry over 40 MB), or null.
 * Adapters return items only, so such entries come back as items carrying their sentence; the
 * runner and `groupItems` move them to the rejects instead of copying them.
 */
export function collectRejectReason(item: SourceItem): string | null {
  return item.warnings.find((w) => REJECT_PATTERNS.some((p) => p.test(w))) ?? null;
}

type RangeStorage = Pick<IngestDeps["storage"], "createRangeStream">;

/**
 * The `Open.custom` source over one GCS object. unzipper asks for `length` bytes from `offset`, or
 * for everything from `offset` when `length` is undefined; GCS ranges end inclusively, so the end
 * is `offset + length - 1`, clamped to the last byte (unzipper pads entry reads past the end).
 *
 * Each range is read to its end at once and unzipper gets a stream over those bytes. unzipper pulls
 * lazily and only as far as it needs, so handing it the network stream itself left responses half
 * read; on the real bucket that held connections until the server reset them ("socket hang up")
 * and stalled parallel entry reads. A range is the directory or one entry (at most 40 MB plus
 * unzipper's padding), and readItem holds a whole entry in memory anyway.
 * `onStream` sees every stream handed out, so the caller can watch it for errors and close it.
 */
export function gcsZipSource(
  storage: RangeStorage,
  gsUri: string,
  size: number,
  onStream?: (stream: Readable) => void,
): { size: () => Promise<number>; stream: (offset: number, length?: number) => Readable } {
  return {
    size: async () => size,
    stream: (offset: number, length?: number) => {
      const last = size - 1;
      const end = length === undefined ? last : Math.min(offset + length - 1, last);
      const stream = offset > last || end < offset ? Readable.from([]) : Readable.from(readToEnd(storage.createRangeStream(gsUri, offset, end)));
      onStream?.(stream);
      return stream;
    },
  };
}

/** The whole range as one chunk, read as soon as the stream is first pulled. */
async function* readToEnd(range: Readable): AsyncGenerator<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of range) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  yield Buffer.concat(chunks);
}

type ZipStorage = Pick<IngestDeps["storage"], "createRangeStream" | "headObject">;
type StreamHook = { current: ((stream: Readable) => void) | null };

/**
 * Reads the central directory. unzipper attaches no error listener to the streams it asks for, so
 * a failed read would be an uncaught error and the open would never settle; every stream opened
 * here is watched (an error fails the open) and closed once the directory is read. Later entry
 * reads go to `hook.current` (see openZipReader).
 */
async function openDirectory(storage: ZipStorage, gsUri: string, hook: StreamHook = { current: null }): Promise<CentralDirectory> {
  const head = await storage.headObject(gsUri);
  if (!head.exists || head.size === null) throw new Error(`The zip ${gsUri.split("/").pop()} was not found in storage. Add it again.`);
  const opened: Readable[] = [];
  let fail: (err: unknown) => void = () => undefined;
  const streamFailed = new Promise<never>((_, reject) => (fail = reject));
  const onStream = (s: Readable) => {
    if (hook.current) return hook.current(s);
    opened.push(s);
    s.on("error", (err) => fail(err));
  };
  try {
    // The typings declare `length` as required; unzipper itself calls stream(offset) without it.
    const source = gcsZipSource(storage, gsUri, head.size, onStream) as Parameters<typeof unzipper.Open.custom>[0];
    return await Promise.race([unzipper.Open.custom(source), streamFailed]);
  } finally {
    for (const s of opened.splice(0)) s.destroy();
  }
}

const entryPathOf = (p: string) => p.replace(/\\/g, "/");

/**
 * Reads entries of one archive by path; the central directory is read once per reader. Each entry
 * is read from its own range stream (unzipper pads it past the entry's data, so it is never pulled
 * to its end); that stream is closed when the entry stream ends, fails or is closed, and an error
 * on it fails the entry stream instead of going uncaught.
 */
export async function openZipReader(storage: ZipStorage, zipGsUri: string): Promise<{ entryStream(entryPath: string): Readable }> {
  const hook: StreamHook = { current: null };
  const dir = await openDirectory(storage, zipGsUri, hook);
  const byPath = new Map(dir.files.map((f) => [entryPathOf(f.path), f]));
  return {
    entryStream(entryPath: string): Readable {
      const file = byPath.get(entryPath);
      if (!file) throw new Error(`${entryPath} is not in the zip.`);
      const ranges: Readable[] = [];
      // unzipper opens the entry's range stream synchronously inside file.stream().
      hook.current = (s) => ranges.push(s);
      let entry: Readable;
      try {
        entry = file.stream();
      } finally {
        hook.current = null;
      }
      const release = () => {
        for (const r of ranges.splice(0)) r.destroy();
      };
      for (const r of ranges) r.on("error", (err) => entry.destroy(err));
      entry.once("end", release).once("error", release).once("close", release);
      return entry;
    },
  };
}

/**
 * Lists the archive: directories, `__MACOSX/`, dotfiles and zero-byte entries are skipped; every
 * other entry becomes an item with `bytes = {kind: "zip-entry"}` and `folder` from its path. A
 * nested zip or an entry over 40 MB carries its reject sentence (see `collectRejectReason`).
 */
async function collect(input: CollectInput): Promise<SourceItem[]> {
  const { upload, deps } = input;
  if (!upload.gcsUri) throw new Error(`The zip ${upload.name} was not uploaded. Add it again.`);
  const zipGsUri = upload.gcsUri;
  const dir = await openDirectory(deps.storage, zipGsUri);
  const items: SourceItem[] = [];
  for (const f of dir.files) {
    const entryPath = entryPathOf(f.path);
    if (f.type === "Directory" || entryPath.endsWith("/") || isSkippedPath(entryPath) || f.uncompressedSize === 0) continue;
    const bytes: BytesRef = { kind: "zip-entry", zipGsUri, entryPath, compressedSize: f.compressedSize, uncompressedSize: f.uncompressedSize };
    const item = sourceItemFromPath(entryPath, bytes, upload.id, "zip");
    const name = entryPath.split("/").pop()!;
    if (item.ext === "zip") item.warnings.push(nestedZipMessage(name));
    else if (f.uncompressedSize > ZIP_ENTRY_MAX_BYTES) item.warnings.push(tooLargeMessage(name));
    items.push(item);
  }
  input.onProgress?.(items.length, items.length);
  return items;
}

export const zipAdapter: Adapter = { kind: "zip", collect };
