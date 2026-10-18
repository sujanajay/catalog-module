import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildZip } from "../../../test-fixtures/catalog/ingest-a/builders";
import type { CatalogUpload } from "../../db/schema";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import type { IngestDeps } from "./types";
import { collectRejectReason, gcsZipSource, openZipReader, ZIP_ENTRY_MAX_BYTES, zipAdapter } from "./zip";

const ZIP_URI = "gs://bkt/catalog-test/anta/b1/uploads/u1/photos.zip";

/** A bucket holding one object; every range read is recorded with the bytes it served. */
function fakeRangeStorage(objects: Record<string, Buffer>) {
  const reads: { start: number; end: number; served: number }[] = [];
  const storage = {
    async headObject(gsUri: string) {
      const buf = objects[gsUri];
      return { exists: !!buf, size: buf ? buf.length : null, contentType: buf ? "application/zip" : null, generation: null, crc32c: null };
    },
    createRangeStream(gsUri: string, start: number, endInclusive: number) {
      const buf = objects[gsUri]!;
      // The real helper refuses a range that is not inside the object.
      expect(Number.isInteger(start) && Number.isInteger(endInclusive) && start >= 0 && endInclusive >= start).toBe(true);
      expect(endInclusive).toBeLessThan(buf.length);
      const slice = buf.subarray(start, endInclusive + 1);
      reads.push({ start, end: endInclusive, served: slice.length });
      return Readable.from([slice]);
    },
  };
  return { storage: storage as unknown as IngestDeps["storage"], reads };
}

function upload(over: Partial<CatalogUpload> = {}): CatalogUpload {
  return {
    id: "u1", batchId: "b1", kind: "zip", name: "photos.zip", relativePath: null, gcsUri: ZIP_URI, sourceUrl: null,
    sizeBytes: null, mime: "application/zip", status: "uploaded", detected: null, error: null, createdAt: new Date(), ...over,
  };
}

async function readAll(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe("gcsZipSource", () => {
  it("turns offset + length into an inclusive end and serves exactly length bytes", async () => {
    const data = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    const { storage, reads } = fakeRangeStorage({ [ZIP_URI]: data });
    const src = gcsZipSource(storage, ZIP_URI, data.length);
    expect(await src.size()).toBe(100);

    expect([...(await readAll(src.stream(10, 5)))]).toEqual([10, 11, 12, 13, 14]);
    expect(reads.at(-1)).toEqual({ start: 10, end: 14, served: 5 });

    // No length: to the last byte.
    expect((await readAll(src.stream(90))).length).toBe(10);
    expect(reads.at(-1)).toEqual({ start: 90, end: 99, served: 10 });

    // A padded read past the end is clamped to the last byte.
    expect((await readAll(src.stream(95, 1000))).length).toBe(5);
    expect(reads.at(-1)).toEqual({ start: 95, end: 99, served: 5 });

    // Zero bytes asked: no range request at all.
    const before = reads.length;
    expect((await readAll(src.stream(20, 0))).length).toBe(0);
    expect(reads.length).toBe(before);
  });
});

describe("zipAdapter", () => {
  const jpg = (n: number) => Buffer.alloc(n, 0xab);
  const archive = buildZip([
    { path: "Anta/" },
    { path: "Anta/Shoes/ABC123_1.jpg", data: jpg(1500), compress: true },
    { path: "Anta/Shoes/ABC123_2.jpg", data: jpg(800) },
    { path: "Anta/DEF/1.jpg", data: jpg(300), compress: true },
    { path: "Anta\\Win\\GHI_1.jpg", data: jpg(10) },
    { path: "top.png", data: jpg(42) },
    { path: "__MACOSX/Anta/._ABC123_1.jpg", data: jpg(20) },
    { path: "Anta/.DS_Store", data: jpg(12) },
    { path: "Anta/empty_1.jpg", data: Buffer.alloc(0) },
    { path: "Anta/more/inner.zip", data: buildZip([{ path: "x_1.jpg", data: jpg(5) }]) },
  ]);

  it("lists nested entries with sizes and folders, skipping junk, directories and empty files", async () => {
    const { storage, reads } = fakeRangeStorage({ [ZIP_URI]: archive });
    const items = await zipAdapter.collect({
      batchId: "b1", brandSlug: "anta", prefix: "catalog-test/anta/b1", upload: upload(), options: DEFAULT_BATCH_OPTIONS,
      deps: { storage, fetch: (() => { throw new Error("no fetch in zip") }) as unknown as typeof fetch },
    });

    expect(zipAdapter.kind).toBe("zip");
    expect(items.map((i) => [i.originalName, i.identifier, i.n, i.folder, i.ext])).toEqual([
      ["Anta/Shoes/ABC123_1.jpg", "ABC123", 1, "Shoes", "jpg"],
      ["Anta/Shoes/ABC123_2.jpg", "ABC123", 2, "Shoes", "jpg"],
      ["Anta/DEF/1.jpg", "", 1, "DEF", "jpg"],
      ["Anta/Win/GHI_1.jpg", "GHI", 1, "Win", "jpg"],
      ["top.png", "top", null, null, "png"],
      ["Anta/more/inner.zip", "inner", null, "more", "zip"],
    ]);
    const first = items[0]!;
    expect(first.bytes).toMatchObject({ kind: "zip-entry", zipGsUri: ZIP_URI, entryPath: "Anta/Shoes/ABC123_1.jpg", uncompressedSize: 1500 });
    if (first.bytes.kind !== "zip-entry") throw new Error("expected a zip entry");
    expect(first.bytes.compressedSize).toBeLessThan(1500);
    expect(items[1]!.bytes).toMatchObject({ compressedSize: 800, uncompressedSize: 800 });
    expect(items.every((i) => i.uploadId === "u1" && i.origin === "zip" && i.sheetIdentifier === null)).toBe(true);

    expect(collectRejectReason(items[5]!)).toBe("Nested zip files are not opened. Unzip inner.zip and upload its contents.");
    expect(items.slice(0, 5).map(collectRejectReason)).toEqual([null, null, null, null, null]);

    // Only the central directory and the end record were read, never the whole archive in one go
    // from the start, and every read served exactly end - start + 1 bytes.
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.served).toBe(r.end - r.start + 1);
    expect(reads.some((r) => r.start === 0 && r.end === archive.length - 1)).toBe(false);
  });

  it("streams one entry's bytes back out of the archive", async () => {
    const { storage } = fakeRangeStorage({ [ZIP_URI]: archive });
    const reader = await openZipReader(storage, ZIP_URI);
    expect(await readAll(reader.entryStream("Anta/Shoes/ABC123_1.jpg"))).toEqual(jpg(1500));
    expect(await readAll(reader.entryStream("Anta/Shoes/ABC123_2.jpg"))).toEqual(jpg(800));
    expect(() => reader.entryStream("nope.jpg")).toThrow("nope.jpg is not in the zip.");
  });

  it("closes every range stream it opens, so no connection is left waiting (many entries at once)", async () => {
    const { storage } = fakeRangeStorage({ [ZIP_URI]: archive });
    const streams: Readable[] = [];
    const tracked = {
      ...storage,
      // Small chunks, as a network response arrives, so a reader that stops pulling stalls it.
      createRangeStream: (gsUri: string, start: number, end: number) => {
        const slice = archive.subarray(start, end + 1);
        const chunks = Array.from({ length: Math.ceil(slice.length / 64) }, (_, i) => slice.subarray(i * 64, (i + 1) * 64));
        const s = Readable.from(chunks, { highWaterMark: 1 });
        streams.push(s);
        return s;
      },
    } as IngestDeps["storage"];
    const reader = await openZipReader(tracked, ZIP_URI);
    const paths = ["Anta/Shoes/ABC123_1.jpg", "Anta/Shoes/ABC123_2.jpg"];
    const bufs = await Promise.all([...paths, ...paths].map((p) => readAll(reader.entryStream(p))));
    expect(bufs.map((b) => b.length)).toEqual([1500, 800, 1500, 800]);
    await new Promise((r) => setImmediate(r));
    expect(streams.length).toBeGreaterThan(4);
    // unzipper pulls only what it needs (entry reads are padded past the data); every range
    // response must still be read to its end or closed, never left half read.
    expect(streams.filter((s) => !s.destroyed && !s.readableEnded)).toEqual([]);
  });

  it("fails the entry stream when its range read fails, instead of an uncaught error", async () => {
    const { storage } = fakeRangeStorage({ [ZIP_URI]: archive });
    let failNext = false;
    const flaky = {
      ...storage,
      createRangeStream: (gsUri: string, start: number, end: number) => {
        if (!failNext) return storage.createRangeStream(gsUri, start, end);
        return new Readable({
          read() {
            this.destroy(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          },
        });
      },
    } as IngestDeps["storage"];
    const reader = await openZipReader(flaky, ZIP_URI);
    failNext = true;
    await expect(readAll(reader.entryStream("Anta/Shoes/ABC123_1.jpg"))).rejects.toThrow("socket hang up");
  });

  it("marks an entry over 40 MB with its sentence without reading it", async () => {
    // A stored entry claiming a huge size: only the central directory is ever read.
    const small = buildZip([{ path: "big_1.jpg", data: jpg(16) }]);
    const cdStart = small.readUInt32LE(small.length - 22 + 16);
    const patched = Buffer.from(small);
    patched.writeUInt32LE(ZIP_ENTRY_MAX_BYTES + 1, cdStart + 24); // central directory uncompressed size
    const { storage } = fakeRangeStorage({ [ZIP_URI]: patched });
    const [item] = await zipAdapter.collect({
      batchId: "b1", brandSlug: "anta", prefix: "p", upload: upload(), options: DEFAULT_BATCH_OPTIONS,
      deps: { storage, fetch: fetch },
    });
    expect(collectRejectReason(item!)).toBe("big_1.jpg is larger than 40 MB and was skipped.");
  });

  it("says so when the zip is not in storage", async () => {
    const { storage } = fakeRangeStorage({});
    await expect(
      zipAdapter.collect({ batchId: "b1", brandSlug: "anta", prefix: "p", upload: upload(), options: DEFAULT_BATCH_OPTIONS, deps: { storage, fetch } }),
    ).rejects.toThrow("The zip photos.zip was not found in storage. Add it again.");
  });
});
