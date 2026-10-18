import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CatalogUpload } from "../../db/schema";
import {
  DRIVE_FOLDER_MAX_BYTES, FOLDER_TOO_LARGE, collectDriveFolderOnWeb, driveFolderAdapter, listDriveFolder, parseFolderId,
} from "./drive-folder";
import { FOLDER_NO_ACCESS, GOOGLE_POLICY_BLOCKED } from "./google-sheet";
import type { CollectInput, DriveLike, IngestDeps } from "./types";

const ROOT = "1xYzRootFolderId_abc";
const FOLDER = "application/vnd.google-apps.folder";
type F = { id: string; name: string; mimeType: string; size?: string };

/** Fake Drive: a folder tree, list pages of `pageSize` 2 so pagination is exercised; records calls. */
function fakeDrive(tree: Record<string, F[]>, opts: { listError?: unknown; getError?: unknown } = {}) {
  const lists: { q: string; pageToken?: string }[] = [];
  const gets: string[] = [];
  const drive: DriveLike = {
    files: {
      async list(params) {
        lists.push({ q: params.q, ...(params.pageToken ? { pageToken: params.pageToken } : {}) });
        if (opts.listError) throw opts.listError;
        expect(params).toMatchObject({ fields: "nextPageToken, files(id, name, mimeType, size)", supportsAllDrives: true, includeItemsFromAllDrives: true });
        const parent = /^'([^']+)' in parents and trashed = false$/.exec(params.q)![1]!;
        const all = tree[parent] ?? [];
        const start = Number(params.pageToken ?? 0);
        const next = start + 2 < all.length ? String(start + 2) : null;
        return { data: { files: all.slice(start, start + 2), nextPageToken: next } };
      },
      async get(params, options) {
        expect(params).toMatchObject({ alt: "media", supportsAllDrives: true });
        expect(options).toEqual({ responseType: "stream" });
        gets.push(params.fileId);
        if (opts.getError) throw opts.getError;
        return { data: Readable.from([Buffer.from(`bytes of ${params.fileId}`)]) };
      },
    },
  };
  return { drive, lists, gets };
}

function fakeStorage() {
  const objects = new Map<string, { buf: Buffer; mime: string }>();
  const storage = {
    uploadBuffer: async (path: string, buf: Buffer, mime: string) => (objects.set(`gs://bucket/${path}`, { buf, mime }), `gs://bucket/${path}`),
    listObjects: async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
  } as unknown as IngestDeps["storage"];
  return { storage, objects };
}

const gaxios = (status: number, message: string, reason?: string) =>
  Object.assign(new Error(message), { code: status, response: { status, data: { error: { errors: reason ? [{ reason, message }] : [] } } } });

function input(deps: Partial<IngestDeps>, upload: Partial<CatalogUpload> = {}, progress?: [number, number | null][]): CollectInput {
  return {
    batchId: "b1", brandSlug: "anta", prefix: "catalog-test/anta/b1",
    upload: { id: "u7", kind: "drive_folder", name: "Drive folder", sourceUrl: `https://drive.google.com/drive/folders/${ROOT}?usp=sharing`, gcsUri: null, ...upload } as CatalogUpload,
    options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
    deps: { storage: fakeStorage().storage, fetch: async () => { throw new Error("no fetch"); }, ...deps },
    ...(progress ? { onProgress: (d: number, t: number | null) => progress.push([d, t]) } : {}),
  };
}

const TREE: Record<string, F[]> = {
  [ROOT]: [
    { id: "f-shoes", name: "Shoes", mimeType: FOLDER },
    { id: "a1", name: "ABC123_1.jpg", mimeType: "image/jpeg", size: "1000" },
    { id: "doc", name: "Notes", mimeType: "application/vnd.google-apps.document" },
    { id: "f-rect", name: "Rectangle Shots", mimeType: FOLDER },
  ],
  "f-shoes": [
    { id: "s1", name: "1.jpg", mimeType: "image/jpeg", size: "2000" },
    { id: "s2", name: "2.heic", mimeType: "image/heic", size: "3000" },
    { id: "big", name: "huge.tif", mimeType: "image/tiff", size: String(41 * 1024 * 1024) },
  ],
  "f-rect": [{ id: "r1", name: "XYZ 9_2.png", mimeType: "image/png", size: "500" }],
};

describe("parseFolderId", () => {
  it("reads /drive/folders/, /drive/u/<n>/folders/ and /folders/ links", () => {
    expect(parseFolderId(`https://drive.google.com/drive/folders/${ROOT}?usp=sharing`)).toBe(ROOT);
    expect(parseFolderId(`https://drive.google.com/drive/u/1/folders/${ROOT}`)).toBe(ROOT);
    expect(parseFolderId(`https://drive.google.com/folders/${ROOT}`)).toBe(ROOT);
    expect(parseFolderId("https://docs.google.com/spreadsheets/d/abc/edit")).toBeNull();
  });
});

describe("listDriveFolder", () => {
  it("walks sub-folders and follows nextPageToken", async () => {
    const { drive, lists } = fakeDrive(TREE);
    const entries = await listDriveFolder(drive, ROOT);
    expect(entries.map((e) => e.relativePath)).toEqual(["ABC123_1.jpg", "Notes", "Rectangle Shots/XYZ 9_2.png", "Shoes/1.jpg", "Shoes/2.heic", "Shoes/huge.tif"]);
    expect(lists).toEqual([
      { q: `'${ROOT}' in parents and trashed = false` },
      { q: `'${ROOT}' in parents and trashed = false`, pageToken: "2" },
      { q: "'f-shoes' in parents and trashed = false" },
      { q: "'f-shoes' in parents and trashed = false", pageToken: "2" },
      { q: "'f-rect' in parents and trashed = false" },
    ]);
  });
});

describe("collectDriveFolderOnWeb", () => {
  it("copies every file under uploads/<uploadId>/<relative path> and lists what it skipped", async () => {
    const { drive, gets } = fakeDrive(TREE);
    const { storage, objects } = fakeStorage();
    const progress: [number, number | null][] = [];
    const result = await collectDriveFolderOnWeb(input({ drive, storage }, {}, progress));
    expect([...objects.keys()].sort()).toEqual([
      "gs://bucket/catalog-test/anta/b1/uploads/u7/ABC123_1.jpg",
      "gs://bucket/catalog-test/anta/b1/uploads/u7/Rectangle_Shots/XYZ_9_2.png",
      "gs://bucket/catalog-test/anta/b1/uploads/u7/Shoes/1.jpg",
      "gs://bucket/catalog-test/anta/b1/uploads/u7/Shoes/2.heic",
    ]);
    expect(objects.get("gs://bucket/catalog-test/anta/b1/uploads/u7/Shoes/2.heic")).toEqual({ buf: Buffer.from("bytes of s2"), mime: "image/heic" });
    expect(gets.sort()).toEqual(["a1", "r1", "s1", "s2"]);
    expect(result).toEqual({
      kind: "drive_folder", fileCount: 4, topLevelFolders: ["Rectangle Shots", "Shoes"],
      rejected: [
        { name: "Notes", reason: "Notes is not an image." },
        { name: "Shoes/huge.tif", reason: "Shoes/huge.tif is larger than 40 MB and was skipped." },
      ],
      message: "Drive folder, 4 files copied.",
    });
    expect(progress[0]).toEqual([0, 4]);
    expect(progress[progress.length - 1]).toEqual([4, 4]);
  });

  it("stops before downloading when the folder is larger than DRIVE_FOLDER_MAX_BYTES", async () => {
    const half = String(Math.ceil(DRIVE_FOLDER_MAX_BYTES / 2) + 1);
    const { drive, gets } = fakeDrive({ [ROOT]: [{ id: "x", name: "a_1.jpg", mimeType: "image/jpeg", size: half }, { id: "y", name: "a_2.jpg", mimeType: "image/jpeg", size: half }] });
    const { storage, objects } = fakeStorage();
    expect(await collectDriveFolderOnWeb(input({ drive, storage }))).toEqual({ kind: "drive_folder", error: FOLDER_TOO_LARGE });
    expect(FOLDER_TOO_LARGE).toBe("This folder is too large to read directly. Download it as a zip and drop it instead.");
    expect(gets).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it("returns the share sentence on 403 and the block sentence on a domain-policy 403", async () => {
    const denied = fakeDrive(TREE, { listError: gaxios(403, "The user does not have sufficient permissions for this file.") });
    expect(await collectDriveFolderOnWeb(input({ drive: denied.drive }))).toEqual({ kind: "drive_folder", error: FOLDER_NO_ACCESS });
    const blocked = fakeDrive(TREE, { getError: gaxios(403, "Forbidden", "cannotShareOutsideDomain") });
    const { storage, objects } = fakeStorage();
    expect(await collectDriveFolderOnWeb(input({ drive: blocked.drive, storage }))).toEqual({ kind: "drive_folder", error: GOOGLE_POLICY_BLOCKED });
    expect(objects.size).toBe(0);
  });

  it("treats an empty listing (what an unshared folder returns) as no access", async () => {
    const { drive } = fakeDrive({});
    expect(await collectDriveFolderOnWeb(input({ drive }))).toEqual({ kind: "drive_folder", error: FOLDER_NO_ACCESS });
  });
});

describe("driveFolderAdapter", () => {
  it("builds gcs items from the copied files with shot numbers and the nearest folder", async () => {
    const { drive } = fakeDrive(TREE);
    const { storage } = fakeStorage();
    await collectDriveFolderOnWeb(input({ drive, storage }));
    const items = await driveFolderAdapter.collect(input({ storage }, { gcsUri: "gs://bucket/catalog-test/anta/b1/uploads/u7/" }));
    expect(items.map((i) => [i.originalName, i.identifier, i.n, i.suffix, i.folder, i.ext])).toEqual([
      ["ABC123_1.jpg", "ABC123", 1, "", null, "jpg"],
      ["Rectangle_Shots/XYZ_9_2.png", "XYZ_9", 2, "", "Rectangle_Shots", "png"],
      ["Shoes/1.jpg", "", 1, "", "Shoes", "jpg"],
      ["Shoes/2.heic", "", 2, "", "Shoes", "heic"],
    ]);
    expect(items[0]).toMatchObject({ bytes: { kind: "gcs", gsUri: "gs://bucket/catalog-test/anta/b1/uploads/u7/ABC123_1.jpg" }, origin: "drive_folder", uploadId: "u7", sheetIdentifier: null, warnings: [] });
  });
});
