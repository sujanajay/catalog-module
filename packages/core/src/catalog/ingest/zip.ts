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
 */
export function gcsZipSource(storage: RangeStorage, gsUri: string, size: number): { size: () => Promise<number>; stream: (offset: number, length?: number) => Readable } {
  return {
    size: async () => size,
    stream: (offset: number, length?: number) => {
      const last = size - 1;
      const end = length === undefined ? last : Math.min(offset + length - 1, last);
      if (offset > last || end < offset) return Readable.from([]);
      return storage.createRangeStream(gsUri, offset, end);
    },
  };
}

async function openDirectory(storage: Pick<IngestDeps["storage"], "createRangeStream" | "headObject">, gsUri: string): Promise<CentralDirectory> {
  const head = await storage.headObject(gsUri);
  if (!head.exists || head.size === null) throw new Error(`The zip ${gsUri.split("/").pop()} was not found in storage. Add it again.`);
  // The typings declare `length` as required; unzipper itself calls stream(offset) without it.
  return unzipper.Open.custom(gcsZipSource(storage, gsUri, head.size) as Parameters<typeof unzipper.Open.custom>[0]);
}

const entryPathOf = (p: string) => p.replace(/\\/g, "/");

/** Reads entries of one archive by path; the central directory is read once per reader. */
export async function openZipReader(storage: Pick<IngestDeps["storage"], "createRangeStream" | "headObject">, zipGsUri: string): Promise<{ entryStream(entryPath: string): Readable }> {
  const dir = await openDirectory(storage, zipGsUri);
  const byPath = new Map(dir.files.map((f) => [entryPathOf(f.path), f]));
  return {
    entryStream(entryPath: string): Readable {
      const file = byPath.get(entryPath);
      if (!file) throw new Error(`${entryPath} is not in the zip.`);
      return file.stream();
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
