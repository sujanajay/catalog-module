import { describe, expect, it, vi } from "vitest";
import type { CatalogUpload } from "../../db/schema";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { uploadPath } from "../naming";
import type { ObjectHead } from "../../storage";
import { completeUploads, isSkippedPath, planSignedUploads, uploadObjectPath } from "./local-files";
import type { CollectInput, IngestDeps } from "./types";

const PREFIX = "catalog-test/uspa/b1";

function fakeBucket(objects: Record<string, { size: number; contentType: string }>) {
  const heads: string[] = [];
  const storage = {
    async listObjects(prefixUri: string) {
      return Object.keys(objects).filter((k) => k.startsWith(prefixUri));
    },
    async headObject(gsUri: string): Promise<ObjectHead> {
      heads.push(gsUri);
      const o = objects[gsUri];
      return o
        ? { exists: true, size: o.size, contentType: o.contentType, generation: "1", crc32c: "x" }
        : { exists: false, size: null, contentType: null, generation: null, crc32c: null };
    },
  };
  return { storage: storage as unknown as IngestDeps["storage"], heads };
}

function upload(over: Partial<CatalogUpload>): CatalogUpload {
  return {
    id: "u1", batchId: "b1", kind: "image", name: "files", relativePath: null, gcsUri: null, sourceUrl: null,
    sizeBytes: null, mime: null, status: "uploaded", detected: null, error: null, createdAt: new Date(), ...over,
  };
}

function input(u: CatalogUpload, storage: IngestDeps["storage"], onProgress?: CollectInput["onProgress"]): CollectInput {
  return { batchId: "b1", brandSlug: "uspa", prefix: PREFIX, upload: u, options: DEFAULT_BATCH_OPTIONS, deps: { storage, fetch }, onProgress };
}

describe("planSignedUploads", () => {
  it("signs one PUT per file at the upload path, keeping folders and the browser's content type", async () => {
    const sign = vi.fn(async (objectPath: string, contentType: string) => `https://signed/${objectPath}?ct=${contentType}`);
    const planned = await planSignedUploads(
      {
        prefix: PREFIX, uploadId: "u1",
        files: [
          { relativePath: "ABC123_1.jpg", size: 10, type: "image/jpeg" },
          { relativePath: "Spring Drop/Rectangle/XYZ 9_2.png", size: 20, type: "" },
          { relativePath: "IMG_2041.heic", size: 30, type: "image/heic" },
        ],
      },
      sign,
    );
    expect(planned).toEqual([
      { relativePath: "ABC123_1.jpg", objectPath: "catalog-test/uspa/b1/uploads/u1/ABC123_1.jpg", contentType: "image/jpeg", putUrl: "https://signed/catalog-test/uspa/b1/uploads/u1/ABC123_1.jpg?ct=image/jpeg" },
      { relativePath: "Spring Drop/Rectangle/XYZ 9_2.png", objectPath: "catalog-test/uspa/b1/uploads/u1/Spring_Drop/Rectangle/XYZ_9_2.png", contentType: "image/png", putUrl: "https://signed/catalog-test/uspa/b1/uploads/u1/Spring_Drop/Rectangle/XYZ_9_2.png?ct=image/png" },
      { relativePath: "IMG_2041.heic", objectPath: "catalog-test/uspa/b1/uploads/u1/IMG_2041.heic", contentType: "image/heic", putUrl: "https://signed/catalog-test/uspa/b1/uploads/u1/IMG_2041.heic?ct=image/heic" },
    ]);
    // Default TTL: no third argument.
    expect(sign.mock.calls.every((c) => c.length === 2)).toBe(true);
    expect(uploadObjectPath(PREFIX, "u1", "ABC123_1.jpg")).toBe(uploadPath(PREFIX, "u1", "ABC123_1.jpg"));
  });

  it("refuses two files that would overwrite each other and paths that escape the upload", async () => {
    const sign = vi.fn(async () => "u");
    await expect(
      planSignedUploads({ prefix: PREFIX, uploadId: "u1", files: [{ relativePath: "A B_1.jpg", size: 1, type: "image/jpeg" }, { relativePath: "A_B_1.jpg", size: 1, type: "image/jpeg" }] }, sign),
    ).rejects.toThrow("A B_1.jpg and A_B_1.jpg would be stored under the same name. Rename one and add them again.");
    expect(uploadObjectPath(PREFIX, "u1", "../../x/../a_1.jpg")).toBe("catalog-test/uspa/b1/uploads/u1/x/a_1.jpg");
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("completeUploads", () => {
  const base = `gs://bkt/${PREFIX}/uploads/u1/`;

  it("lists a folder upload, HEADs every object and keeps folders for grouping", async () => {
    const { storage, heads } = fakeBucket({
      [`${base}Shoes/ABC123_2.jpg`]: { size: 5, contentType: "image/jpeg" },
      [`${base}Shoes/ABC123_1.jpg`]: { size: 5, contentType: "image/jpeg" },
      [`${base}DEF/Square/01.jpg`]: { size: 5, contentType: "image/jpeg" },
      [`${base}DEF/.DS_Store`]: { size: 5, contentType: "application/octet-stream" },
      [`${base}__MACOSX/DEF/._01.jpg`]: { size: 5, contentType: "application/octet-stream" },
      [`${base}noext`]: { size: 5, contentType: "image/png" },
      [`gs://bkt/${PREFIX}/uploads/u2/other_1.jpg`]: { size: 5, contentType: "image/jpeg" },
    });
    const progress: [number, number | null][] = [];
    const items = await completeUploads(input(upload({ gcsUri: base }), storage, (d, t) => progress.push([d, t])));
    expect(items.map((i) => [i.originalName, i.identifier, i.n, i.suffix, i.folder, i.ext, i.origin])).toEqual([
      ["DEF/Square/01.jpg", "", 1, "", "Square", "jpg", "image"],
      ["Shoes/ABC123_1.jpg", "ABC123", 1, "", "Shoes", "jpg", "image"],
      ["Shoes/ABC123_2.jpg", "ABC123", 2, "", "Shoes", "jpg", "image"],
      ["noext", "noext", null, "", null, "png", "image"],
    ]);
    expect(items[1]!.bytes).toEqual({ kind: "gcs", gsUri: `${base}Shoes/ABC123_1.jpg` });
    expect(heads).toHaveLength(4);
    expect(progress.at(-1)).toEqual([4, 4]);
  });

  it("uses BUCKET and the upload path when the row has no gcsUri", async () => {
    const prev = process.env.BUCKET;
    process.env.BUCKET = "bkt";
    try {
      const { storage } = fakeBucket({ [`${base}XYZ_1.jpg`]: { size: 5, contentType: "image/jpeg" } });
      const items = await completeUploads(input(upload({}), storage));
      expect(items.map((i) => i.originalName)).toEqual(["XYZ_1.jpg"]);
    } finally {
      if (prev === undefined) delete process.env.BUCKET;
      else process.env.BUCKET = prev;
    }
  });

  it("treats a row naming one object as one file with its verbatim relative path", async () => {
    const uri = `${base}Spring_Drop/XYZ_9_2.jpg`;
    const { storage } = fakeBucket({ [uri]: { size: 5, contentType: "image/jpeg" } });
    const [item] = await completeUploads(input(upload({ gcsUri: uri, relativePath: "Spring Drop/XYZ 9_2.jpg", name: "XYZ 9_2.jpg" }), storage));
    expect(item).toMatchObject({ originalName: "Spring Drop/XYZ 9_2.jpg", identifier: "XYZ 9", n: 2, folder: "Spring Drop", bytes: { kind: "gcs", gsUri: uri } });

    const missing = upload({ gcsUri: `${base}gone_1.jpg`, name: "gone_1.jpg" });
    await expect(completeUploads(input(missing, storage))).rejects.toThrow("gone_1.jpg did not finish uploading. Add it again.");
  });

  it("knows junk paths", () => {
    expect(isSkippedPath("__MACOSX/a/._x.jpg")).toBe(true);
    expect(isSkippedPath("a/.DS_Store")).toBe(true);
    expect(isSkippedPath(".hidden/x_1.jpg")).toBe(true);
    expect(isSkippedPath("a/x_1.jpg")).toBe(false);
  });
});
