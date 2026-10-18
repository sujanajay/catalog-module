// Google Drive folders (spec 04, "Google Sheet and Drive folder"). The web tier lists the shared
// folder recursively as catalog-web@ and copies every file into the batch's uploads/<uploadId>/
// under its relative path; the worker then reads those objects like a dropped folder. A folder
// whose listed sizes add up to more than DRIVE_FOLDER_MAX_BYTES is not downloaded at all: the
// operator is asked for a zip instead (the copy has to finish inside one 900 s web request).
import type { Readable } from "node:stream";
import type { Db } from "../../db/client";
import { DEFAULT_MAX_BYTES } from "../../safe-url";
import { mimeFromPath } from "../../storage";
import { FOLDER_NO_ACCESS, googleAccessError, saveWebCollection, type WebCollectResult } from "./google-sheet";
import { completeUploads, uploadObjectPath } from "./local-files";
import type { Adapter, CollectInput, Detected, DriveLike } from "./types";

/**
 * Builder constant: the most a folder may hold for the web tier to copy it. At a sustained 10 MB/s
 * from Drive to our bucket 1 GiB takes under two minutes, well inside the 900 s request limit with
 * room for slow files and per-file latency.
 */
export const DRIVE_FOLDER_MAX_BYTES = 1024 ** 3;
/** Same cap as a fetched link or a zip entry. */
export const DRIVE_FILE_MAX_BYTES = DEFAULT_MAX_BYTES;
/** Files copied at once. */
const COPY_CONCURRENCY = 6;
const PAGE_SIZE = 1000;

export const FOLDER_TOO_LARGE = "This folder is too large to read directly. Download it as a zip and drop it instead.";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

/** The folder id of a drive.google.com `.../folders/<id>` link. */
export function parseFolderId(url: string): string | null {
  const m = /drive\.google\.com\/.*?folders\/([A-Za-z0-9_-]+)/i.exec(url);
  return m ? m[1]! : null;
}

export interface DriveEntry { id: string; name: string; mimeType: string; size: number | null; relativePath: string }

/** One page of a folder's children (shared drives included). */
export function listChildren(drive: DriveLike, folderId: string, pageToken?: string) {
  return drive.files.list({
    q: `'${folderId.replace(/['\\]/g, "\\$&")}' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, mimeType, size)",
    pageSize: PAGE_SIZE,
    ...(pageToken ? { pageToken } : {}),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
}

/** Every file under the folder, recursively, with its path relative to the folder; sub-folders are walked, not returned. */
export async function listDriveFolder(drive: DriveLike, folderId: string): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  const queue: { id: string; path: string }[] = [{ id: folderId, path: "" }];
  const seen = new Set<string>([folderId]);
  while (queue.length) {
    const folder = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const res = await listChildren(drive, folder.id, pageToken);
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        const relativePath = folder.path ? `${folder.path}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          if (!seen.has(f.id)) {
            seen.add(f.id);
            queue.push({ id: f.id, path: relativePath });
          }
          continue;
        }
        out.push({ id: f.id, name: f.name, mimeType: f.mimeType ?? "", size: f.size ? Number(f.size) : null, relativePath });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

async function readCapped(stream: Readable, maxBytes: number, name: string): Promise<Buffer | string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      return `${name} is larger than 40 MB and was skipped.`;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/** Web tier: list the folder as catalog-web@, stream every image into <uploads>/<uploadId>/<relative path>, set detected. */
export async function collectDriveFolderOnWeb(input: CollectInput, db?: Db): Promise<WebCollectResult> {
  const { upload, deps, prefix } = input;
  const drive = deps.drive;
  if (!drive) throw new Error("The Google Drive client is not configured.");
  const folderId = parseFolderId(upload.sourceUrl ?? upload.name);
  if (!folderId) throw new Error(`Not a Google Drive folder link: ${(upload.sourceUrl ?? upload.name).split(/[?#]/)[0]}`);
  const finish = async (result: WebCollectResult, gcsUri: string | null) => {
    if (db) await saveWebCollection(db, upload.id, result, gcsUri);
    return result;
  };
  const denied = async (err: unknown) => {
    const sentence = googleAccessError(err, "folder");
    if (!sentence) throw err;
    return finish({ kind: "drive_folder", error: sentence }, null);
  };

  let entries: DriveEntry[];
  try {
    entries = await listDriveFolder(drive, folderId);
  } catch (err) {
    return denied(err);
  }
  // Drive answers an empty list (not an error) for a folder that is not shared with us, so an empty
  // folder and an unshared one look the same; both get the share sentence.
  if (!entries.length) return finish({ kind: "drive_folder", error: FOLDER_NO_ACCESS }, null);
  const total = entries.reduce((s, e) => s + (e.size ?? 0), 0);
  if (total > DRIVE_FOLDER_MAX_BYTES) return finish({ kind: "drive_folder", error: FOLDER_TOO_LARGE }, null);

  const rejected: { name: string; reason: string }[] = [];
  const copy: DriveEntry[] = [];
  for (const e of entries) {
    if (e.mimeType.startsWith(GOOGLE_APPS_PREFIX)) rejected.push({ name: e.relativePath, reason: `${e.relativePath} is not an image.` });
    else if ((e.size ?? 0) > DRIVE_FILE_MAX_BYTES) rejected.push({ name: e.relativePath, reason: `${e.relativePath} is larger than 40 MB and was skipped.` });
    else copy.push(e);
  }

  let done = 0;
  let copied = 0;
  let prefixUri: string | null = null;
  let accessError: unknown = null;
  input.onProgress?.(0, copy.length);
  const work = copy.slice();
  const worker = async () => {
    for (let e = work.shift(); e && !accessError; e = work.shift()) {
      let res: { data: Readable };
      try {
        res = await drive.files.get({ fileId: e.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
      } catch (err) {
        accessError = err;
        return;
      }
      const body = await readCapped(res.data, DRIVE_FILE_MAX_BYTES, e.relativePath);
      if (typeof body === "string") rejected.push({ name: e.relativePath, reason: body });
      else {
        const objectPath = uploadObjectPath(prefix, upload.id, e.relativePath);
        const uri = await deps.storage.uploadBuffer(objectPath, body, e.mimeType || mimeFromPath(e.name));
        prefixUri ??= uri.slice(0, uri.length - objectPath.length) + `${prefix}/uploads/${upload.id}/`;
        copied++;
      }
      input.onProgress?.(++done, copy.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, copy.length) }, worker));
  if (accessError) return denied(accessError);

  const topLevelFolders = [...new Set(entries.filter((e) => e.relativePath.includes("/")).map((e) => e.relativePath.split("/")[0]!))];
  const detected: Detected = {
    kind: "drive_folder", fileCount: copied, topLevelFolders, rejected,
    message: `Drive folder, ${copied} files copied.`,
  };
  return finish(detected, prefixUri);
}

/**
 * kind "drive_folder": worker side, exactly what completeUploads (local-files.ts) builds for a
 * dropped folder over the files the web tier copied: bytes {kind:"gcs"}, `parseShotName(baseName)`,
 * the nearest parent folder and the relative path in `originalName`; junk paths are skipped.
 */
export const driveFolderAdapter: Adapter = { kind: "drive_folder", collect: completeUploads };
