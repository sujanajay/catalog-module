// Tier 2 (PGlite + fake storage, fake fetch, fake enqueue): the ingest run (spec 04, "Ingest run").
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client";
import {
  catalogBatches,
  catalogBatchProducts,
  catalogOutputs,
  catalogProductAliases,
  catalogProducts,
  catalogSourceImages,
  catalogUploads,
  type CatalogBatch,
} from "../../db/schema";
import { createTestDb } from "../../db/testing";
import { batchPrefix, rawPath } from "../naming";
import type { ChannelId, IdentifierMode, UploadKind } from "../types";
import { buildZip } from "../../../test-fixtures/catalog/ingest-a/builders";
import { buildPreview, runIngest } from "./index";
import type { IngestDeps } from "./types";

const BUCKET = "test-assets";
const HOST = "https://104.18.38.10"; // an IP literal: safeFetch needs no DNS lookup for it

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  vi.stubEnv("BUCKET", BUCKET);
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

// --- Fakes ---------------------------------------------------------------------------------

function fakeWorld() {
  const objects = new Map<string, { buf: Buffer; mime: string }>();
  const calls = { uploads: [] as string[], downloads: [] as string[], customTime: [] as string[], fetches: [] as string[] };
  const gs = (p: string) => `gs://${BUCKET}/${p}`;
  const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
  const storage: IngestDeps["storage"] = {
    uploadBuffer: async (path: string, buf: Buffer, mime: string) => {
      objects.set(gs(path), { buf, mime });
      calls.uploads.push(gs(path));
      return gs(path);
    },
    downloadBuffer: async (gsUri: string) => {
      const o = objects.get(gsUri);
      if (!o) throw notFound();
      calls.downloads.push(gsUri);
      return { buf: o.buf, mime: o.mime };
    },
    headObject: async (gsUri: string) => {
      const o = objects.get(gsUri);
      return { exists: !!o, size: o ? o.buf.length : null, contentType: o?.mime ?? null, generation: o ? "1" : null, crc32c: null };
    },
    readRange: async (gsUri: string, start: number, end: number) => objects.get(gsUri)!.buf.subarray(start, end + 1),
    createRangeStream: (gsUri: string, start: number, end: number) => Readable.from([objects.get(gsUri)!.buf.subarray(start, end + 1)]),
    listObjects: async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    setCustomTime: async (gsUri: string) => {
      calls.customTime.push(gsUri);
    },
  };
  const web = new Map<string, Buffer>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.fetches.push(`${init?.method ?? "GET"} ${url}`);
    const body = web.get(url);
    if (!body) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const enqueued: { route: string; body: Record<string, unknown> }[] = [];
  const enqueue = async (route: string, body: Record<string, unknown>) => {
    enqueued.push({ route, body });
    return `task-${enqueued.length}`;
  };
  return { objects, calls, storage, web, fetch, enqueue, enqueued, put: (p: string, buf: Buffer, mime = "image/jpeg") => objects.set(gs(p), { buf, mime }) };
}
type World = ReturnType<typeof fakeWorld>;

let shade = 0;
/** A distinct 600x800 jpeg (a different flat colour each call). */
async function jpeg(): Promise<Buffer> {
  shade++;
  return sharp({ create: { width: 600, height: 800, channels: 3, background: { r: shade % 256, g: (shade * 7) % 256, b: (shade * 13) % 256 } } }).jpeg().toBuffer();
}

function bmp(): Buffer {
  const b = Buffer.alloc(54);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(10, 18);
  b.writeInt32LE(10, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  return b;
}

async function newBatch(name: string, opts: { identifierMode?: IdentifierMode; channels?: ChannelId[] } = {}): Promise<CatalogBatch> {
  const [b] = await db
    .insert(catalogBatches)
    .values({
      brandSlug: "uspa", brandName: "USPA", name, isTest: true, createdBy: "op@opptra.com", channels: opts.channels ?? [],
      options: { identifierMode: opts.identifierMode ?? "filename", precedence: "uploads_then_links", sheetColumns: null },
    })
    .returning();
  return b!;
}

const prefixOf = (b: CatalogBatch) => batchPrefix(b.brandSlug, b.id, b.isTest);

async function newUpload(batch: CatalogBatch, kind: UploadKind, name: string, gcsUri: string | null): Promise<string> {
  const [u] = await db.insert(catalogUploads).values({ batchId: batch.id, kind, name, gcsUri, status: "uploaded" }).returning();
  return u!.id;
}

/** A folder upload: files under uploads/<uploadId>/, the row pointing at the folder. */
async function folderUpload(w: World, batch: CatalogBatch, files: Record<string, Buffer>): Promise<string> {
  const id = await newUpload(batch, "image", "folder", null);
  const base = `${prefixOf(batch)}/uploads/${id}/`;
  for (const [rel, buf] of Object.entries(files)) w.put(base + rel, buf);
  await db.update(catalogUploads).set({ gcsUri: `gs://${BUCKET}/${base}` }).where(eq(catalogUploads.id, id));
  return id;
}

function deps(w: World, budgetItems?: number) {
  return { storage: w.storage, fetch: w.fetch, enqueue: w.enqueue as never, ...(budgetItems ? { budgetItems } : {}) };
}

/** Runs every upload of the batch, following the self-enqueued continuations. */
async function ingestAll(w: World, batch: CatalogBatch): Promise<string[]> {
  const uploads = await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, batch.id));
  const outcomes: string[] = [];
  for (const u of uploads) {
    const from = w.enqueued.length;
    outcomes.push((await runIngest(db, deps(w), { batchId: batch.id, uploadId: u.id })).outcome);
    for (let i = from; i < w.enqueued.length; i++) {
      outcomes.push((await runIngest(db, deps(w), w.enqueued[i]!.body as { batchId: string; uploadId: string; cursor: string })).outcome);
    }
  }
  return outcomes;
}

const batchRow = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
const sourcesOf = async (batchId: string) => db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId));

async function linkStatusesOf(batchId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ identifier: catalogProducts.identifier, linkStatus: catalogBatchProducts.linkStatus })
    .from(catalogBatchProducts)
    .innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId))
    .where(eq(catalogBatchProducts.batchId, batchId));
  return Object.fromEntries(rows.map((r) => [r.identifier, r.linkStatus]));
}

// --- Tests -----------------------------------------------------------------------------------

describe("runIngest", () => {
  it("collects 60 items in three budgeted calls, survives a corrupt file and is a no-op when repeated", async () => {
    const w = fakeWorld();
    const batch = await newBatch("sixty");
    const files: Record<string, Buffer> = {};
    for (let p = 1; p <= 20; p++) for (let n = 1; n <= 3; n++) files[`P${String(p).padStart(2, "0")}_${n}.jpg`] = await jpeg();
    const good = files["P20_3.jpg"]!;
    files["P20_3.jpg"] = good.subarray(0, Math.floor(good.length / 2));
    const uploadId = await folderUpload(w, batch, files);

    const r1 = await runIngest(db, deps(w, 25), { batchId: batch.id, uploadId });
    expect(r1.progress).toEqual({ done: 25, total: 60, phase: "copying" });
    expect(w.enqueued).toEqual([{ route: "/tasks/catalog/ingest", body: { batchId: batch.id, uploadId, cursor: "25" } }]);
    expect((await batchRow(batch.id)).counts).toMatchObject({ collected: 25, collectTotal: 60, previewReady: false });
    expect((await batchRow(batch.id)).status).toBe("ingesting");

    const r2 = await runIngest(db, deps(w, 25), w.enqueued[0]!.body as never);
    expect(r2.progress).toEqual({ done: 50, total: 60, phase: "copying" });
    expect(w.enqueued[1]).toEqual({ route: "/tasks/catalog/ingest", body: { batchId: batch.id, uploadId, cursor: "50" } });
    const r3 = await runIngest(db, deps(w, 25), w.enqueued[1]!.body as never);
    expect(r3.outcome).toBe("preview ready: 20 products, 59 photos");
    expect(w.enqueued).toHaveLength(2);

    const done = await batchRow(batch.id);
    expect(done.status).toBe("draft");
    expect(done.counts).toMatchObject({
      collected: 60, collectTotal: 60, products: 20, sources: 59, unsupportedFiles: 1, duplicateFiles: 0,
      newProducts: 20, existingProducts: 0, shotsToRemove: 0, previewReady: true, failReason: null,
    });
    const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, uploadId));
    expect(upload!.status).toBe("collected");
    expect(upload!.detected).toMatchObject({ formats: { jpg: 59, png: 0, heic: 0, other: 0 }, rejected: [{ name: "P20_3.jpg", reason: "P20_3.jpg is corrupt (cannot be decoded)." }] });

    const rows = await sourcesOf(batch.id);
    expect(rows).toHaveLength(59);
    expect(rows.every((r) => !r.isCurrent && r.status === "prepared" && r.replacesId === null && /^[0-9a-f]{64}$/.test(r.sha256))).toBe(true);
    const p01 = rows.find((r) => r.originalName === "P01_2.jpg")!;
    expect(p01).toMatchObject({ n: 2, mime: "image/jpeg", width: 600, height: 800, uploadId, rawUri: `gs://${BUCKET}/${rawPath(prefixOf(batch), "P01", 2, "jpg")}` });
    expect(w.objects.get(p01.rawUri)!.buf.equals(files["P01_2.jpg"]!)).toBe(true);

    // A repeated first delivery changes nothing and reads nothing.
    const before = { uploads: w.calls.uploads.length, downloads: w.calls.downloads.length };
    const again = await runIngest(db, deps(w, 25), { batchId: batch.id, uploadId });
    expect(again.outcome).toBe("noop: upload already collected");
    expect({ uploads: w.calls.uploads.length, downloads: w.calls.downloads.length }).toEqual(before);
    expect(await sourcesOf(batch.id)).toHaveLength(59);
    expect(w.enqueued).toHaveLength(2);

    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.kpis).toEqual({ products: 20, photos: 59, channels: 0, outputs: 0 });
    expect(preview.totalRows).toBe(20);
    expect(preview.rows[0]).toMatchObject({ identifier: "P01", shots: 3, status: "ok", firstShotUri: `gs://${BUCKET}/${rawPath(prefixOf(batch), "P01", 1, "jpg")}` });
    expect(preview.rows[0]!.files).toEqual([1, 2, 3].map((n) => ({ n, originalName: `P01_${n}.jpg`, width: 600, height: 800 })));
    expect(preview.rows.find((r) => r.identifier === "P20")).toMatchObject({ shots: 2, notes: ["P20_3.jpg is corrupt (cannot be decoded)."] });
    expect(preview.overwrite).toMatchObject({ newProducts: 20, existingProducts: [], duplicates: [], busy: [] });
    expect(preview.warnings.map((x) => x.headline)).toEqual(["1 files could not be read."]);
    expect(w.calls.customTime).toEqual([]);
  });

  it("a late duplicate delivery keeps what the other deliveries read and counts nothing twice", async () => {
    const w = fakeWorld();
    const batch = await newBatch("duplicate delivery");
    const files: Record<string, Buffer> = {};
    for (let n = 1; n <= 6; n++) files[`D_${n}.jpg`] = await jpeg();
    const uploadId = await folderUpload(w, batch, files);
    await runIngest(db, deps(w, 2), { batchId: batch.id, uploadId });
    const second = w.enqueued[0]!.body as { batchId: string; uploadId: string; cursor: string };

    // Cloud Tasks delivers the second call twice. The late copy loads the manifest, then stalls
    // reading its photos while the other copy and the third call finish the upload.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stalled!: () => void;
    const reached = new Promise<void>((r) => (stalled = r));
    const slow: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri) => {
        if (gsUri.endsWith(".jpg")) {
          stalled();
          await gate;
        }
        return w.storage.downloadBuffer(gsUri);
      },
    };
    const late = runIngest(db, { ...deps(w, 2), storage: slow }, second);
    await reached;
    await runIngest(db, deps(w, 2), second);
    expect((await runIngest(db, deps(w, 2), w.enqueued[1]!.body as never)).outcome).toBe("preview ready: 1 products, 6 photos");
    release();
    await late;

    const manifest = JSON.parse(w.objects.get(`gs://${BUCKET}/${prefixOf(batch)}/derived/_ingest/${uploadId}/manifest.json`)!.buf.toString("utf8"));
    expect(Object.keys(manifest.results)).toHaveLength(6);
    expect((await batchRow(batch.id)).counts).toMatchObject({ collected: 6, collectTotal: 6, previewReady: true });
    expect(w.enqueued).toHaveLength(2);
  });

  it("a product list adds missing_images and not_in_sheet rows", async () => {
    const w = fakeWorld();
    const batch = await newBatch("with list");
    await folderUpload(w, batch, { "LA_1.jpg": await jpeg(), "LB_1.jpg": await jpeg() });
    const listPath = `${prefixOf(batch)}/uploads/list/items.csv`;
    w.put(listPath, Buffer.from("identifier,name\nLA,first\nLC,third\n"), "text/csv");
    const listId = await newUpload(batch, "product_list", "items.csv", `gs://${BUCKET}/${listPath}`);
    await ingestAll(w, batch);

    expect(await linkStatusesOf(batch.id)).toEqual({ LA: "ok", LB: "not_in_sheet", LC: "missing_images" });
    expect((await batchRow(batch.id)).counts).toMatchObject({ products: 2, sources: 2, missingImages: 1, notInSheet: 1, newProducts: 2 });
    const [list] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, listId));
    expect(list!.detected).toMatchObject({ kind: "product_list", identifierColumn: 0, matchColumn: 0, sheetNames: ["items.csv"] });

    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.rows.map((r) => [r.identifier, r.status])).toEqual([["LA", "ok"], ["LB", "ok"], ["LC", "missing images"]]);
    expect(preview.warnings.map((x) => x.headline)).toEqual([
      "1 products have no photos.",
      "1 products have photos but are not in your product list: LB.",
    ]);
  });

  it("fails the batch with the failReason sentence when no photo was found", async () => {
    const w = fakeWorld();
    const batch = await newBatch("no photos");
    await folderUpload(w, batch, { "scan.bmp": bmp(), "doc.pdf": Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n", "latin1") });
    expect(await ingestAll(w, batch)).toEqual(["failed: no photos"]);
    const b = await batchRow(batch.id);
    expect(b.status).toBe("failed");
    expect(b.counts.failReason).toBe("No photos were found in what you uploaded. 1 BMP file and 1 PDF. Upload photos and start again.");
    expect(await sourcesOf(batch.id)).toEqual([]);
  });

  it("builds the failReason from the upload errors when every upload failed (a missing zip)", async () => {
    const w = fakeWorld();
    const batch = await newBatch("missing zip");
    await newUpload(batch, "zip", "Images.zip", `gs://${BUCKET}/${prefixOf(batch)}/uploads/z/Images.zip`);
    expect(await ingestAll(w, batch)).toEqual(["failed: no photos"]);
    const [u] = await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, batch.id));
    expect(u).toMatchObject({ status: "failed", error: "The zip Images.zip was not found in storage. Add it again." });
    const b = await batchRow(batch.id);
    expect(b.status).toBe("failed");
    expect(b.counts.failReason).toBe("No photos were found in what you uploaded. The zip Images.zip was not found in storage. Upload photos and start again.");

    // With a reject from another upload, both are named.
    const w2 = fakeWorld();
    const mixed = await newBatch("missing zip and a bmp");
    await newUpload(mixed, "zip", "Images.zip", `gs://${BUCKET}/${prefixOf(mixed)}/uploads/z/Images.zip`);
    await folderUpload(w2, mixed, { "scan.bmp": bmp() });
    await ingestAll(w2, mixed);
    expect((await batchRow(mixed.id)).counts.failReason).toBe(
      "No photos were found in what you uploaded. 1 BMP file. The zip Images.zip was not found in storage. Upload photos and start again.",
    );
  });

  it("reads links sheets and zips: duplicate rows warned, a failed link reported by row, nested zips rejected", async () => {
    const w = fakeWorld();
    const batch = await newBatch("sheet and zip");
    const [x1, x1b, z1, z2] = [await jpeg(), await jpeg(), await jpeg(), await jpeg()];
    w.web.set(`${HOST}/X1_1.jpg`, x1);
    w.web.set(`${HOST}/X1_9.jpg`, x1b);
    const sheetPath = `${prefixOf(batch)}/uploads/s/links.csv`;
    w.put(sheetPath, Buffer.from(`Option ID,Image 1\nX1,${HOST}/X1_1.jpg\nX1,${HOST}/X1_9.jpg\nX2,${HOST}/missing.jpg\n`), "text/csv");
    const sheetId = await newUpload(batch, "sheet", "links.csv", `gs://${BUCKET}/${sheetPath}`);
    const zipPath = `${prefixOf(batch)}/uploads/z/photos.zip`;
    w.put(zipPath, buildZip([{ path: "Shoes/Z1_1.jpg", data: z1 }, { path: "Shoes/Z1_2.jpg", data: z2, compress: true }, { path: "Shoes/inner.zip", data: Buffer.from("PK") }]), "application/zip");
    const zipId = await newUpload(batch, "zip", "photos.zip", `gs://${BUCKET}/${zipPath}`);
    await ingestAll(w, batch);

    expect(w.calls.fetches.every((f) => f.startsWith("GET "))).toBe(true);
    const [sheet] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, sheetId));
    expect((sheet!.detected as { rejected: unknown[] }).rejected).toEqual([
      { name: "missing.jpg", reason: `Row 4, column Image 1: ${HOST}/missing.jpg did not return an image (got 404).` },
    ]);
    const [zip] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, zipId));
    expect(zip!.detected).toMatchObject({
      topLevelFolders: ["Shoes"], formats: { jpg: 2 },
      rejected: [{ name: "Shoes/inner.zip", reason: "Nested zip files are not opened. Unzip inner.zip and upload its contents." }],
    });

    const rows = await sourcesOf(batch.id);
    expect(rows.map((r) => r.originalName).sort()).toEqual(["Shoes/Z1_1.jpg", "Shoes/Z1_2.jpg", "X1_1.jpg"]);
    const zipped = rows.find((r) => r.originalName === "Shoes/Z1_2.jpg")!;
    expect(w.objects.get(zipped.rawUri)!.buf.equals(z2)).toBe(true);

    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.warnings.map((x) => x.headline)).toContain("1 identifiers appear more than once in links.csv; the first row of each is used.");
    expect(preview.rows.map((r) => [r.identifier, r.status, r.shots])).toEqual([["inner", "unreadable", 0], ["X1", "ok", 1], ["X2", "unreadable", 0], ["Z1", "ok", 2]]);
  });

  it("a re-upload of a known product adds not-current versions that replace the current ones, touching nothing else", async () => {
    const w = fakeWorld();
    const first = await newBatch("first delivery");
    const shots = [await jpeg(), await jpeg(), await jpeg(), await jpeg()];
    await folderUpload(w, first, { "ABC123_1.jpg": shots[0]!, "ABC123_2.jpg": shots[1]!, "ABC123_3.jpg": shots[2]!, "ABC123_4.jpg": shots[3]! });
    await ingestAll(w, first);
    // 06's publish step would make them current and live on Noon.
    await db.update(catalogSourceImages).set({ isCurrent: true }).where(eq(catalogSourceImages.batchId, first.id));
    await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, first.id));
    const firstRows = (await sourcesOf(first.id)).sort((a, b) => a.n - b.n);
    await db.insert(catalogOutputs).values(
      firstRows.map((r) => ({
        batchId: first.id, productId: r.productId, sourceImageId: r.id, channel: "noon" as const, n: r.n, canvasW: 1080, canvasH: 1480, scale: 1,
        placedX: 0, placedY: 0, renderKey: `rk-${r.n}`, objectPath: `catalog-test/uspa/ABC123/noon/ABC123_${r.n}.jpg`,
        publicUrl: `https://storage.googleapis.com/x/catalog-test/uspa/ABC123/noon/ABC123_${r.n}.jpg`, isLive: true, status: "verified" as const,
      })),
    );

    const second = await newBatch("second delivery");
    await folderUpload(w, second, { "abc-123_1.jpg": shots[0]!, "abc-123_2.jpg": await jpeg(), "abc-123_3.jpg": shots[2]! });
    await ingestAll(w, second);

    const rows = (await sourcesOf(second.id)).sort((a, b) => a.n - b.n);
    expect(rows.map((r) => [r.n, r.isCurrent, r.replacesId, r.productId])).toEqual(firstRows.slice(0, 3).map((f) => [f.n, false, f.id, f.productId]));
    expect(rows[0]!.sha256).toBe(firstRows[0]!.sha256);
    expect(rows[1]!.sha256).not.toBe(firstRows[1]!.sha256);
    expect(rows[0]!.rawUri).toBe(`gs://${BUCKET}/${rawPath(prefixOf(second), "ABC123", 1, "jpg")}`);
    const after = (await sourcesOf(first.id)).sort((a, b) => a.n - b.n);
    expect(after).toEqual(firstRows);
    expect(w.calls.customTime).toEqual([]);
    expect((await batchRow(second.id)).counts).toMatchObject({ newProducts: 0, existingProducts: 1, shotsToRemove: 0 });

    // Channels picked after ingest: step 4 reads the live shots on them now.
    await db.update(catalogBatches).set({ channels: ["noon"] }).where(eq(catalogBatches.id, second.id));
    const preview = await buildPreview(db, second.id, { storage: w.storage });
    expect(preview.overwrite).toMatchObject({
      newProducts: 0,
      existingProducts: [{ identifier: "abc-123", liveShots: [1, 2, 3, 4], uploadShots: [1, 2, 3], shotsToRemove: [4], channels: ["noon"] }],
    });
    expect(preview.kpis).toEqual({ products: 1, photos: 3, channels: 1, outputs: 3 });
  });

  it("a step 2 re-run regroups from bytes already in the bucket and replaces only the batch's own rows", async () => {
    const w = fakeWorld();
    const other = await newBatch("someone else");
    await folderUpload(w, other, { "KEEP1_1.jpg": await jpeg() });
    await ingestAll(w, other);
    const otherRows = await sourcesOf(other.id);

    const batch = await newBatch("regroup");
    await folderUpload(w, batch, { "FOLD1/ra_1.jpg": await jpeg(), "FOLD1/ra_2.jpg": await jpeg(), "FOLD2/rb_1.jpg": await jpeg() });
    w.web.set(`${HOST}/RC_1.jpg`, await jpeg());
    const listPath = `${prefixOf(batch)}/uploads/urls/urls.txt`;
    w.put(listPath, Buffer.from(`${HOST}/RC_1.jpg\n`), "text/plain");
    await newUpload(batch, "url_list", "urls.txt", `gs://${BUCKET}/${listPath}`);
    await ingestAll(w, batch);
    expect(await linkStatusesOf(batch.id)).toEqual({ ra: "ok", rb: "ok", RC: "ok" });
    const fetches = w.calls.fetches.length;
    expect(fetches).toBe(1);

    // 06's step 2 save: the new option, every upload back to `uploaded`, ingest again.
    await db.update(catalogBatches).set({ options: { identifierMode: "folder", precedence: "uploads_then_links", sheetColumns: null } }).where(eq(catalogBatches.id, batch.id));
    await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.batchId, batch.id));
    await ingestAll(w, batch);

    expect(w.calls.fetches.length).toBe(fetches);
    expect(await linkStatusesOf(batch.id)).toEqual({ FOLD1: "ok", FOLD2: "ok", RC: "ok" });
    const rows = await sourcesOf(batch.id);
    expect(rows.map((r) => r.originalName).sort()).toEqual(["FOLD1/ra_1.jpg", "FOLD1/ra_2.jpg", "FOLD2/rb_1.jpg", "RC_1.jpg"]);
    expect(rows.find((r) => r.originalName === "FOLD1/ra_2.jpg")!.rawUri).toBe(`gs://${BUCKET}/${rawPath(prefixOf(batch), "FOLD1", 2, "jpg")}`);
    // The products the first grouping created are gone with their aliases; the other batch is untouched.
    const names = (await db.select({ identifier: catalogProducts.identifier }).from(catalogProducts)).map((p) => p.identifier);
    expect(names).not.toContain("ra");
    expect(names).not.toContain("rb");
    expect(await db.select().from(catalogProductAliases).where(and(eq(catalogProductAliases.aliasKey, "RA"), eq(catalogProductAliases.brandSlug, "uspa")))).toEqual([]);
    expect(await sourcesOf(other.id)).toEqual(otherRows);
    expect((await batchRow(batch.id)).counts).toMatchObject({ products: 3, sources: 4, newProducts: 3, collected: 4, collectTotal: 4 });
  });
});
