// Tier 2 (PGlite + fake storage, fake fetch, fake enqueue): the ingest run (spec 04, "Ingest run").
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client";
import {
  catalogBatches,
  catalogBatchProducts,
  catalogContentVersions,
  catalogOutputs,
  catalogProductAliases,
  catalogProducts,
  catalogSourceImages,
  catalogUploads,
  skuMap,
  type CatalogBatch,
} from "../../db/schema";
import { createTestDb } from "../../db/testing";
import { batchPrefix, rawPath } from "../naming";
import { findOrCreateProduct } from "../products";
import type { ChannelId, IdentifierMode, UploadKind } from "../types";
import { buildZip } from "../../../test-fixtures/catalog/ingest-a/builders";
import { mergeCounts, PLACING_LEASE_MS } from "../counts";
import { buildPreview, deliveryToken, failStoppedIngest, GROUP_TIME_BUDGET_MS, INGEST_STOPPED_TEXT, INGEST_TIME_BUDGET_MS, LINK_MAX_ATTEMPTS, LINK_RETRY_ATTEMPTS, PLACE_BUDGET_ITEMS, runIngest } from "./index";
import { linkFailuresBlock } from "./detect-step";
import { collectDriveFolderOnWeb } from "./drive-folder";
import { lockForInputChange } from "./input-change";
import { sourceProducerRefsOf } from "../../graph/write-path";
import { readIngestReport } from "../pipeline/report";
import { groupingSentence } from "./roots";
import { linkFailuresOf } from "./link-failures";
import { manifestPath, type UploadManifest } from "./manifest";
import type { IngestDeps } from "./types";

// findOrCreateProduct keeps its real behaviour; one test makes a call fail part-way through.
vi.mock(import("../products"), async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, findOrCreateProduct: vi.fn(mod.findOrCreateProduct) };
});

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
  const objects = new Map<string, { buf: Buffer; mime: string; sha256?: string }>();
  const calls = { uploads: [] as string[], downloads: [] as string[], customTime: [] as string[], fetches: [] as string[] };
  const gs = (p: string) => `gs://${BUCKET}/${p}`;
  const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
  const storage: IngestDeps["storage"] = {
    uploadBuffer: async (path: string, buf: Buffer, mime: string, opts?: { sha256?: string }) => {
      objects.set(gs(path), { buf, mime, ...(opts?.sha256 ? { sha256: opts.sha256 } : {}) });
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
      return { exists: !!o, size: o ? o.buf.length : null, contentType: o?.mime ?? null, generation: o ? "1" : null, crc32c: null, ...(o?.sha256 ? { sha256: o.sha256 } : {}) };
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
  // Link retries wait for nothing here (spec 14d F5 part 2); the retry tests pass their own clock.
  return { storage: w.storage, fetch: w.fetch, enqueue: w.enqueue as never, sleep: async () => {}, ...(budgetItems ? { budgetItems } : {}) };
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

  it("a retry after the batch-wide step failed part-way still counts this batch's products as new", async () => {
    const w = fakeWorld();
    const batch = await newBatch("retry");
    const uploadId = await folderUpload(w, batch, { "RT1_1.jpg": await jpeg(), "RT2_1.jpg": await jpeg() });
    const { findOrCreateProduct: real } = await vi.importActual<typeof import("../products")>("../products");
    let calls = 0;
    vi.mocked(findOrCreateProduct).mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("Connection terminated unexpectedly");
      return real(...args);
    });
    try {
      // RT1 is created, then the database drops: the claim is given back for the retry.
      await expect(runIngest(db, deps(w), { batchId: batch.id, uploadId })).rejects.toThrow("Connection terminated unexpectedly");
      expect((await batchRow(batch.id)).status).toBe("ingesting");
    } finally {
      vi.mocked(findOrCreateProduct).mockImplementation(real);
    }

    expect((await runIngest(db, deps(w), { batchId: batch.id, uploadId })).outcome).toBe("preview ready: 2 products, 2 photos");
    expect((await batchRow(batch.id)).counts).toMatchObject({ newProducts: 2, existingProducts: 0 });
    const changes = await db.select({ change: catalogBatchProducts.change }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id));
    expect(changes.map((c) => c.change)).toEqual(["new", "new"]);
    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.overwrite).toMatchObject({ newProducts: 2, existingProducts: [] });
  });

  it("two new spellings that only become one product when created are both left out", async () => {
    const w = fakeWorld();
    const batch = await newBatch("late spellings");
    // The EAN file name resolves to the option id LATE OPT, which is also the other file's key.
    await db.insert(skuMap).values({
      opptraSku: "LATE_OPT_40", brand: "USPA", brandSlug: "uspa", line: "softline", source: "warehouse",
      optionKey: "LATEOPT", optionIdStyleColor: "LATE OPT", ean: "8680000000099",
    });
    await folderUpload(w, batch, { "8680000000099_1.jpg": await jpeg(), "LATE-OPT_1.jpg": await jpeg(), "KEEPME_1.jpg": await jpeg() });
    expect(await ingestAll(w, batch)).toEqual(["preview ready: 1 products, 1 photos"]);

    expect(await linkStatusesOf(batch.id)).toEqual({ KEEPME: "ok" });
    const keys = (await db.select({ pathKey: catalogProducts.pathKey }).from(catalogProducts).where(eq(catalogProducts.brandSlug, "uspa"))).map((p) => p.pathKey);
    expect(keys).not.toContain("8680000000099");
    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.overwrite.duplicates).toEqual([{ a: "8680000000099", b: "LATE-OPT" }]);
    expect(preview.rows.map((r) => [r.identifier, r.notes])).toEqual([
      ["8680000000099", ["8680000000099 and LATE-OPT are the same product. Keep one."]],
      ["KEEPME", []],
      ["LATE-OPT", ["8680000000099 and LATE-OPT are the same product. Keep one."]],
    ]);
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
      { name: "Row 3", identifier: "X1", reason: "Row 3 repeats X1, so its 1 new link was not used: only the first row of an identifier is read." },
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

  it("a follow-up batch (append, M1 D30) numbers a known product's photos after its highest shot and removes none", async () => {
    const w = fakeWorld();
    const parent = await newBatch("append parent");
    await folderUpload(w, parent, { "APP1_1.jpg": await jpeg(), "APP1_2.jpg": await jpeg(), "APP1_3.jpg": await jpeg() });
    await ingestAll(w, parent);
    await db.update(catalogSourceImages).set({ isCurrent: true }).where(eq(catalogSourceImages.batchId, parent.id));
    await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, parent.id));
    const parentRows = (await sourcesOf(parent.id)).sort((a, b) => a.n - b.n);
    await db.insert(catalogOutputs).values(parentRows.map((r) => ({
      batchId: parent.id, productId: r.productId, sourceImageId: r.id, channel: "noon" as const, n: r.n, canvasW: 1080, canvasH: 1480, scale: 1,
      placedX: 0, placedY: 0, renderKey: `ap-${r.n}`, objectPath: `catalog-test/uspa/APP1/noon/APP1_${r.n}.jpg`,
      publicUrl: `https://storage.googleapis.com/x/catalog-test/uspa/APP1/noon/APP1_${r.n}.jpg`, isLive: true, status: "verified" as const,
    })));

    const created = await newBatch("append follow-up", { channels: ["noon"] });
    const [more] = await db.update(catalogBatches).set({ options: { ...created.options, append: true } }).where(eq(catalogBatches.id, created.id)).returning();
    await folderUpload(w, more!, { "APP1_1.jpg": await jpeg(), "APP1_2.jpg": await jpeg() });
    await ingestAll(w, more!);

    const rows = (await sourcesOf(more!.id)).sort((a, b) => a.n - b.n);
    expect(rows.map((r) => [r.n, r.replacesId, r.productId])).toEqual([[4, null, parentRows[0]!.productId], [5, null, parentRows[0]!.productId]]);
    expect(rows[0]!.rawUri).toBe(`gs://${BUCKET}/${rawPath(prefixOf(more!), "APP1", 4, "jpg")}`);
    expect(await sourcesOf(parent.id)).toEqual(expect.arrayContaining(parentRows));
    expect((await batchRow(more!.id)).counts).toMatchObject({ existingProducts: 1, shotsToRemove: 0 });
    const preview = await buildPreview(db, more!.id, { storage: w.storage });
    expect(preview.overwrite).toMatchObject({ existingProducts: [{ identifier: "APP1", liveShots: [1, 2, 3], uploadShots: [4, 5], shotsToRemove: [], channels: ["noon"] }] });
  });

  describe("follow-up shot numbers come from one place (M1 D30, re-review P1-A)", () => {
    /** A parent that made product `id` with shots 1-3 and holds it for attention: done, photos neither current nor live. */
    async function heldParent(id: string) {
      const w = fakeWorld();
      const parent = await newBatch(`attention parent ${id}`, { channels: ["noon"] });
      await folderUpload(w, parent, { [`${id}_1.jpg`]: await jpeg(), [`${id}_2.jpg`]: await jpeg(), [`${id}_3.jpg`]: await jpeg() });
      await ingestAll(w, parent);
      await db.update(catalogBatches).set({ status: "done", startedAt: new Date(), counts: mergeCounts({ attentionProducts: 1 }) }).where(eq(catalogBatches.id, parent.id));
      const rows = await sourcesOf(parent.id);
      await db.update(catalogProducts).set({ lockBatchId: parent.id }).where(eq(catalogProducts.id, rows[0]!.productId));
      return { parent, productId: rows[0]!.productId };
    }
    async function followUpOf(name: string, files: string[]) {
      const w = fakeWorld();
      const created = await newBatch(name, { channels: ["noon"] });
      const [b] = await db.update(catalogBatches).set({ options: { ...created.options, append: true } }).where(eq(catalogBatches.id, created.id)).returning();
      const photos: Record<string, Buffer> = {};
      for (const f of files) photos[f] = await jpeg();
      await folderUpload(w, b!, photos);
      return { w, batch: b! };
    }
    const shotsOf = async (batchId: string) => (await sourcesOf(batchId)).map((r) => r.n).sort((a, b) => a - b);

    it("numbers after a parent's product held for attention, and two follow-ups grouping at once never share a number; a third follows both", async () => {
      const { productId } = await heldParent("ATT1");
      const one = await followUpOf("attention follow-up one", ["ATT1_1.jpg", "ATT1_2.jpg"]);
      const two = await followUpOf("attention follow-up two", ["ATT1_1.jpg", "ATT1_2.jpg"]);
      // Both group at the same time: two deliveries running side by side, each with its own queue.
      await Promise.all([ingestAll(one.w, one.batch), ingestAll(two.w, two.batch)]);
      const a = await shotsOf(one.batch.id), b = await shotsOf(two.batch.id);
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(2);
      expect([...a, ...b].sort((x, y) => x - y)).toEqual([4, 5, 6, 7]);
      expect((await sourcesOf(one.batch.id)).every((r) => r.productId === productId)).toBe(true);
      const three = await followUpOf("attention follow-up three", ["ATT1_1.jpg"]);
      await ingestAll(three.w, three.batch);
      expect(await shotsOf(three.batch.id)).toEqual([8]);
      // A regroup of a follow-up keeps the numbers it holds.
      await db.update(catalogBatches).set({ status: "ingesting" }).where(eq(catalogBatches.id, one.batch.id));
      const [read] = await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, one.batch.id));
      await runIngest(db, deps(one.w), { batchId: one.batch.id, uploadId: read!.id });
      expect(await shotsOf(one.batch.id)).toEqual(a);
    });
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
    // M0-F2-R1: each accepted photo is a brand version of the product, once: the two photos sent again reuse theirs.
    const brand = await db.select().from(catalogContentVersions).where(like(catalogContentVersions.producerRef, sourceProducerRefsOf(rows[0]!.productId)));
    expect(brand).toHaveLength(5);
    expect(new Set(brand.map((v) => v.contentHash))).toEqual(new Set([...firstRows, ...rows].map((r) => r.sha256)));
    expect(brand.every((v) => v.source === "brand" && v.scope === "master" && v.role === (v.position === 1 ? "main" : "additional") && v.isTest && v.assetSha256 === v.contentHash)).toBe(true);
    expect(brand.find((v) => v.contentHash === rows[1]!.sha256)).toMatchObject({ position: 2, batchId: second.id });
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

describe("an input removed while the batch-wide step runs (spec 14b F3)", () => {
  it("leaves the preview not ready instead of ready with the removed input's photos, and the next run leaves them out", async () => {
    const w = fakeWorld();
    const batch = await newBatch("remove during finish");
    const kept = await folderUpload(w, batch, { "RK_1.jpg": await jpeg() });
    const gone = await folderUpload(w, batch, { "RG_1.jpg": await jpeg() });
    await runIngest(db, deps(w), { batchId: batch.id, uploadId: kept });
    // The operator's Remove lands while the last delivery's batch-wide step reads the manifests.
    const keptManifest = `gs://${BUCKET}/${manifestPath(prefixOf(batch), kept)}`;
    let removedOnce = false;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri: string) => {
        // The batch-wide step runs while the batch is grouping (spec 14c F6: it stays `ingesting`).
        if (gsUri === keptManifest && !removedOnce && (await batchRow(batch.id)).counts.phase === "grouping") {
          removedOnce = true;
          await db.update(catalogUploads).set({ status: "removed" }).where(eq(catalogUploads.id, gone));
        }
        return w.storage.downloadBuffer(gsUri);
      },
    };
    const from = w.enqueued.length;
    await runIngest(db, { ...deps(w), storage }, { batchId: batch.id, uploadId: gone });
    expect(removedOnce).toBe(true);
    // M1 D24: the step does not close with the removed input; it releases its lease and queues a regroup of a read upload.
    expect((await batchRow(batch.id))).toMatchObject({ status: "ingesting", counts: { previewReady: false, failReason: null, placingClaim: null } });
    const regroup = w.enqueued.slice(from).map((e) => e.body);
    expect(regroup).toEqual([expect.objectContaining({ batchId: batch.id, uploadId: kept })]);

    // The regroup runs the step again without the removed input.
    await runIngest(db, deps(w), regroup[0] as never);
    expect((await batchRow(batch.id)).counts).toMatchObject({ previewReady: true, products: 1, sources: 1 });
    expect((await sourcesOf(batch.id)).map((s) => s.uploadId)).toEqual([kept]);
  });
});

describe("an input change while the batch-wide step runs, with the page's hand-off running next to it (M1 D24, review P1-1)", () => {
  /** The page's hand-off after an input change (web handOffIngest): a new run named on the batch, still collecting. */
  async function handOffNewRun(batchId: string): Promise<string> {
    const run = `run-${Math.random().toString(36).slice(2)}`;
    await db.update(catalogBatches).set({ status: "ingesting", counts: mergeCounts({ previewReady: false, ingestRun: run }) }).where(eq(catalogBatches.id, batchId));
    return run;
  }
  /** Runs every queued task from `from` on, following what they queue, until the queue is empty. */
  async function drain(w: World, from: number): Promise<void> {
    for (let i = from; i < w.enqueued.length; i++) await runIngest(db, deps(w), w.enqueued[i]!.body as never);
  }

  /**
   * A db for the running step whose first write of version rows waits for `hook` first: the moment after the step's
   * last lease write, when nothing it does is checked again until its close.
   */
  function pausedAtVersionRows(hook: () => Promise<void>): Db {
    let fired = false;
    const gate = (b: object): object => new Proxy(b, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (p === "then") {
          const then = v as (res: unknown, rej: unknown) => unknown;
          return (res: unknown, rej: unknown) => (fired ? Promise.resolve() : ((fired = true), hook())).then(() => then.call(t, res, rej));
        }
        return typeof v === "function" ? (...args: unknown[]) => gate((v as (...a: unknown[]) => object).apply(t, args)) : v;
      },
    });
    return new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (p === "insert") return (table: unknown) => (table === catalogSourceImages ? gate(t.insert(table as never)) : t.insert(table as never));
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  }

  for (const landing of ["while it reads the manifests", "after its last lease write, as it writes the version rows"] as const) {
    it(`a removal ${landing} never lets the removed input's photos into the batch, and only one step groups at a time`, async () => {
      const w = fakeWorld();
      const batch = await newBatch(`remove during step, concurrent hand-off, ${landing}`);
      const kept = await folderUpload(w, batch, { "CK_1.jpg": await jpeg(), "CK_2.jpg": await jpeg() });
      const gone = await folderUpload(w, batch, { "CG_1.jpg": await jpeg() });
      await runIngest(db, deps(w), { batchId: batch.id, uploadId: kept });
      let edited = false;
      let second: { outcome: string } | null = null;
      const edit = async () => {
        edited = true;
        // The operator removes an input (web removeInput: the batch row lock, then the upload row) ...
        await db.transaction(async (tx) => {
          const locked = await lockForInputChange(tx, batch.id);
          expect("refused" in locked).toBe(false);
          await tx.update(catalogUploads).set({ status: "removed" }).where(eq(catalogUploads.id, gone));
        });
        // ... and the page hands the batch on at once: a new run's delivery runs while the step is mid-way.
        const run = await handOffNewRun(batch.id);
        second = await runIngest(db, deps(w), { batchId: batch.id, uploadId: kept, run });
      };
      const keptManifest = `gs://${BUCKET}/${manifestPath(prefixOf(batch), kept)}`;
      const storage: IngestDeps["storage"] = {
        ...w.storage,
        downloadBuffer: async (gsUri: string) => {
          if (landing === "while it reads the manifests" && gsUri === keptManifest && !edited && (await batchRow(batch.id)).counts.phase === "grouping") await edit();
          return w.storage.downloadBuffer(gsUri);
        },
      };
      const stepDb = landing === "while it reads the manifests" ? db : pausedAtVersionRows(edit);
      const from = w.enqueued.length;
      await runIngest(stepDb, { ...deps(w), storage }, { batchId: batch.id, uploadId: gone });
      expect(edited).toBe(true);
      // The new run's delivery did not start a second step next to the running one.
      expect(second!.outcome).toMatch(/^noop/);
      await drain(w, from);

      const done = await batchRow(batch.id);
      expect(done).toMatchObject({ status: "draft", counts: { previewReady: true, products: 1, sources: 2, placingClaim: null } });
      expect((await sourcesOf(batch.id)).map((r) => r.uploadId)).toEqual([kept, kept]);
      expect(Object.keys(await linkStatusesOf(batch.id))).toEqual(["CK"]);
    });
  }

  it("an input added while the step runs is grouped: the step does not close ready without it", async () => {
    const w = fakeWorld();
    const batch = await newBatch("add during step, concurrent hand-off");
    const first = await folderUpload(w, batch, { "CA_1.jpg": await jpeg() });
    const last = await folderUpload(w, batch, { "CB_1.jpg": await jpeg() });
    await runIngest(db, deps(w), { batchId: batch.id, uploadId: first });
    const firstManifest = `gs://${BUCKET}/${manifestPath(prefixOf(batch), first)}`;
    let added: string | null = null;
    let second: { outcome: string } | null = null;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri: string) => {
        if (gsUri === firstManifest && !added && (await batchRow(batch.id)).counts.phase === "grouping") {
          // The operator drops one more folder (web planUploads and completeUpload) ...
          const id = randomUUID();
          const base = `${prefixOf(batch)}/uploads/${id}/`;
          w.put(`${base}CC_1.jpg`, await jpeg());
          await db.transaction(async (tx) => {
            const locked = await lockForInputChange(tx, batch.id);
            expect("refused" in locked).toBe(false);
            await tx.insert(catalogUploads).values({ id, batchId: batch.id, kind: "image", name: "folder", gcsUri: `gs://${BUCKET}/${base}`, status: "uploaded" });
          });
          added = id;
          // ... and the page hands it on: its delivery reads it while this step is mid-way.
          const run = await handOffNewRun(batch.id);
          second = await runIngest(db, deps(w), { batchId: batch.id, uploadId: id, run });
        }
        return w.storage.downloadBuffer(gsUri);
      },
    };
    const from = w.enqueued.length;
    await runIngest(db, { ...deps(w), storage }, { batchId: batch.id, uploadId: last });
    expect(added).not.toBeNull();
    expect(second!.outcome).not.toMatch(/^preview ready/);
    await drain(w, from);

    expect(await batchRow(batch.id)).toMatchObject({ status: "draft", counts: { previewReady: true, products: 3, sources: 3, placingClaim: null } });
    expect(new Set((await sourcesOf(batch.id)).map((r) => r.uploadId))).toEqual(new Set([first, last, added]));
  });
});

describe("a pasted grid of links (spec 14b F2)", () => {
  it("collects intake-pasted-grid.txt end to end: 6 products, 27 photos, the space-name product with 5 shots", async () => {
    const w = fakeWorld();
    const text = readFileSync(new URL("../../../test-fixtures/catalog/intake/intake-pasted-grid.txt", import.meta.url), "utf8");
    // The fake host serves every link of the paste, by the URL that is fetched (spaces as %20).
    for (const line of text.trim().split("\n")) for (const link of line.split("\t").filter((c) => c.startsWith("https://"))) w.web.set(link.replace(/ /g, "%20"), await jpeg());
    const [b] = await db.insert(catalogBatches).values({
      brandSlug: "test_brand", brandName: "Test Brand", name: "pasted grid", isTest: true, createdBy: "op@opptra.com", channels: [],
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
    }).returning();
    const [u] = await db.insert(catalogUploads).values({ batchId: b!.id, kind: "url_list", name: "Image links", sourceUrl: text.trim(), gcsUri: null, status: "uploaded" }).returning();
    const lookup = async () => ["93.184.215.14"];
    let body: { batchId: string; uploadId: string; cursor?: string } | null = { batchId: b!.id, uploadId: u!.id };
    while (body) {
      const from = w.enqueued.length;
      await runIngest(db, { ...deps(w), lookup }, body);
      body = (w.enqueued[from]?.body as typeof body) ?? null;
    }

    expect((await batchRow(b!.id)).counts).toMatchObject({ products: 6, sources: 27, unsupportedFiles: 0, previewReady: true, failReason: null });
    const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, u!.id));
    expect(upload!.detected?.rejected ?? []).toEqual([]);
    const statuses = await linkStatusesOf(b!.id);
    expect(Object.keys(statuses).sort()).toEqual(["BH-4610-NE-NERO", "BH-4611-BX-BOXER", "BH-4612-MO-MOCHA", "BH-4613-TN-TAN", "BH-4614-OL-OLIVE", "BHSS2620Z-WHITE NAVY"]);
    const rows = await sourcesOf(b!.id);
    expect(rows).toHaveLength(27);
    expect(rows.filter((r) => r.originalName.startsWith("BHSS2620Z-WHITE NAVY_")).map((r) => r.originalName).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `BHSS2620Z-WHITE NAVY_${n}.JPG`));
    expect(w.calls.fetches.filter((f) => f.includes("BHSS2620Z")).every((f) => f.includes("WHITE%20NAVY"))).toBe(true);
  });
});

describe("a Supabase folder paste through the worker (M1-F1-R4, review #10)", () => {
  it("collects the listed folder as image links, groups it by folder name per root and names it in the sentence", async () => {
    const w = fakeWorld();
    const folder = "https://projref.supabase.co/storage/v1/object/public/softlines/anta";
    // The row addLinks saves for a listed folder: `<product folder>\t<url>` lines and detected.supabaseFolder.
    const links = ["ZSKU1/back.jpg", "ZSKU1/front.jpg", "ZSKU2/front.jpg"].map((p) => [p.split("/")[0]!, `${folder}/${p}`] as const);
    for (const [, url] of links) w.web.set(url, await jpeg());
    const [b] = await db.insert(catalogBatches).values({
      brandSlug: "test_brand", brandName: "Test Brand", name: "supabase folder", isTest: true, createdBy: "op@opptra.com", channels: [],
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null, perRoot: true },
    }).returning();
    const name = "Supabase folder softlines/anta";
    const [u] = await db.insert(catalogUploads).values({
      batchId: b!.id, kind: "url_list", name, sourceUrl: links.map(([id, url]) => `${id}\t${url}`).join("\n"), gcsUri: null, status: "uploaded",
      detected: { kind: "url_list", fileCount: 3, title: name, message: `${name}: 3 photos in 2 folders, grouped by folder name.`, supabaseFolder: { url: folder, mode: "folder" } },
    }).returning();
    // A dropped folder of view-named photos beside it: its own root, also by folder name.
    await folderUpload(w, b!, { "USPA_AW26/ZSKU100/front.jpg": await jpeg(), "USPA_AW26/ZSKU100/back.jpg": await jpeg() });
    const lookup = async () => ["93.184.215.14"];
    for (const row of await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, b!.id))) {
      let body: { batchId: string; uploadId: string; cursor?: string } | null = { batchId: b!.id, uploadId: row.id };
      while (body) {
        const from = w.enqueued.length;
        await runIngest(db, { ...deps(w), lookup }, body);
        body = (w.enqueued[from]?.body as typeof body) ?? null;
      }
    }

    const batch = await batchRow(b!.id);
    expect(batch.counts).toMatchObject({ products: 3, sources: 5, previewReady: true, failReason: null });
    expect(Object.keys(await linkStatusesOf(b!.id)).sort()).toEqual(["ZSKU1", "ZSKU100", "ZSKU2"]);
    const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, u!.id));
    expect(upload!.detected?.rejected ?? []).toEqual([]);
    expect(upload!.detected).toMatchObject({ supabaseFolder: { url: folder, mode: "folder" } });
    expect(batch.counts.roots).toEqual(expect.arrayContaining([{ kind: "links", name, mode: "folder" }, expect.objectContaining({ kind: "folder", name: "USPA_AW26", mode: "folder" })]));
    expect(groupingSentence(batch.counts.roots!)).toContain(`${name} by folder name`);
  });
});

describe("links that could not be downloaded (spec 14b F5 part 1)", () => {
  const G = "https://example.com/test_brand";
  /** Collects intake-pasted-grid.txt with a fake host that answers `status(url)` (200 serves a jpeg). */
  async function collectGrid(status: (url: string) => number) {
    const w = fakeWorld();
    const text = readFileSync(new URL("../../../test-fixtures/catalog/intake/intake-pasted-grid.txt", import.meta.url), "utf8");
    const fetches: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      fetches.push(url);
      const s = status(url);
      return s === 200 ? new Response(new Uint8Array(await jpeg()), { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: s, headers: { "content-type": "text/plain" } });
    };
    const [b] = await db.insert(catalogBatches).values({
      brandSlug: "test_brand", brandName: "Test Brand", name: "failing grid", isTest: true, createdBy: "op@opptra.com", channels: [],
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
    }).returning();
    const [u] = await db.insert(catalogUploads).values({ batchId: b!.id, kind: "url_list", name: "Image links", sourceUrl: text.trim(), gcsUri: null, status: "uploaded" }).returning();
    let body: { batchId: string; uploadId: string; cursor?: string } | null = { batchId: b!.id, uploadId: u!.id };
    while (body) {
      const from = w.enqueued.length;
      await runIngest(db, { ...deps(w), fetch, lookup: async () => ["93.184.215.14"] }, body);
      body = (w.enqueued[from]?.body as typeof body) ?? null;
    }
    return { batch: await batchRow(b!.id), fetches };
  }

  it("the grid with every link 404 fails with the all-permanent no-photos sentence, linkFailures 27, unsupportedFiles 0", async () => {
    const { batch } = await collectGrid(() => 404);
    expect(batch.status).toBe("failed");
    expect(batch.counts).toMatchObject({ linkFailures: 27, unsupportedFiles: 0, sources: 0 });
    expect(batch.counts.failReason).toBe(
      `No photos could be downloaded from the 27 links you pasted. 27 answered 'not found' (404), for example ${G}/BH-4610-NE-NERO_1.JPG (row 1, column 1). ` +
      "Check that the links open in a browser, then press Fix and continue and paste the corrected links.",
    );
  });

  it("with some links answering 503, the some-temporary sentence", async () => {
    const { batch } = await collectGrid((url) => (url.includes("BH-4612-MO-MOCHA") ? 503 : 404));
    expect(batch.status).toBe("failed");
    expect(batch.counts).toMatchObject({ linkFailures: 27, unsupportedFiles: 0 });
    expect(batch.counts.failReason).toBe(
      `No photos could be downloaded from the 27 links you pasted. 22 answered 'not found' (404), for example ${G}/BH-4610-NE-NERO_1.JPG (row 1, column 1). ` +
      `5 could not be reached, for example ${G}/BH-4612-MO-MOCHA_1.JPG (row 3, column 1). Some of these may work on a second try. Press Try the failed links again.`,
    );
  });

  it("a batch of a file and a link that both fail names the link as a link, never as one of the other files (removed sentence of release B)", async () => {
    const w = fakeWorld();
    const batch = await newBatch("file and link fail");
    await folderUpload(w, batch, { "ODD_1.bmp": bmp() });
    const [u] = await db.insert(catalogUploads).values({ batchId: batch.id, kind: "url_list", name: "Image links", sourceUrl: `${G}/GONE_1.JPG`, gcsUri: null, status: "uploaded" }).returning();
    for (const id of (await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, batch.id))).map((r) => r.id)) {
      await runIngest(db, { ...deps(w), lookup: async () => ["93.184.215.14"] }, { batchId: batch.id, uploadId: id });
    }
    expect(u).toBeDefined();
    const { status, counts } = await batchRow(batch.id);
    expect(status).toBe("failed");
    expect(counts).toMatchObject({ linkFailures: 1, unsupportedFiles: 1 });
    expect(counts.failReason).toMatch(/1 link that could not be downloaded/);
    expect(counts.failReason).not.toMatch(/other files?/);
  });

  it("a partial failure keeps the batch ready and counts only the failed links", async () => {
    const { batch } = await collectGrid((url) => (url.includes("BH-4611-BX-BOXER_2") ? 404 : 200));
    expect(batch.status).toBe("draft");
    expect(batch.counts).toMatchObject({ linkFailures: 1, unsupportedFiles: 0, sources: 26, previewReady: true });
  });
});

describe("phase, rate and the placing lease (spec 14c F6)", () => {
  const T0 = Date.parse("2026-10-27T10:00:00Z");
  /** A clock the test moves by hand. */
  function clock() {
    let t = T0;
    return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
  }
  type Body = { batchId: string; uploadId: string; cursor?: string; run?: string };

  it("collecting writes phase and rate; placing stays ingesting with phase placing, then draft with phase ready and the lease and rate cleared", async () => {
    const w = fakeWorld();
    const c = clock();
    const batch = await newBatch("phases");
    const files: Record<string, Buffer> = {};
    for (let n = 1; n <= 6; n++) files[`PH${n}_1.jpg`] = await jpeg();
    const uploadId = await folderUpload(w, batch, files);

    await runIngest(db, { ...deps(w, 2), now: c.now }, { batchId: batch.id, uploadId });
    const first = (await batchRow(batch.id)).counts;
    expect(first).toMatchObject({ phase: "checking", collected: 2, collectTotal: 6, placingClaim: null });
    expect(first.rate?.at(-1)).toEqual({ at: new Date(T0).toISOString(), phase: "checking", done: 2 });
    c.advance(30_000);
    await runIngest(db, { ...deps(w, 2), now: c.now }, w.enqueued[0]!.body as Body);
    expect((await batchRow(batch.id)).counts.rate?.map((s) => [s.phase, s.done])).toEqual([["checking", 0], ["checking", 2], ["checking", 4]]);

    // Snapshot the row while the last delivery places the photos.
    // Each photo placed takes 11 s on the test clock, so `placed` is written while placing.
    let during: CatalogBatch | null = null;
    let beforeClose: CatalogBatch | null = null;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri) => {
        if (gsUri.includes("/uploads/")) {
          const row = await batchRow(batch.id);
          if (row.counts.phase === "placing") {
            during ??= row;
            c.advance(11_000);
          }
        }
        return w.storage.downloadBuffer(gsUri);
      },
      uploadBuffer: async (path, buf, mime, opts) => {
        if (path.endsWith("preview-state.json")) beforeClose = await batchRow(batch.id);
        return w.storage.uploadBuffer(path, buf, mime, opts);
      },
    };
    c.advance(30_000);
    const last = w.enqueued[1]!.body as Body;
    expect((await runIngest(db, { ...deps(w, 2), storage, now: c.now }, last)).outcome).toBe("preview ready: 6 products, 6 photos");
    expect(during).not.toBeNull();
    expect(during!.status).toBe("ingesting");
    expect(during!.counts).toMatchObject({ phase: "placing", placed: 0, placeTotal: 6, placingClaim: { token: deliveryToken(last), until: new Date(T0 + 60_000 + PLACING_LEASE_MS).toISOString() } });
    // The phase changed, so rate restarted with placing samples only.
    expect(during!.counts.rate!.every((s) => s.phase === "placing")).toBe(true);
    // Before the closing write: every photo placed, and a `placed` sample written part-way.
    expect(beforeClose!).toMatchObject({ status: "ingesting", counts: { phase: "placing", placed: 6 } });
    const dones = beforeClose!.counts.rate!.map((s) => s.done);
    expect(dones.some((d) => d > 0 && d < 6)).toBe(true);
    expect(dones.at(-1)).toBe(6);

    const done = await batchRow(batch.id);
    expect(done.status).toBe("draft");
    expect(done.counts).toMatchObject({ phase: "ready", placed: 6, placeTotal: 6, placingClaim: null, rate: [], previewReady: true, collected: 6 });
  });

  it("a thrown placing leaves the lease; another token does nothing while it is live; the retry with the same token runs it to the end", async () => {
    const w = fakeWorld();
    const c = clock();
    const batch = await newBatch("lease retry");
    const uploadId = await folderUpload(w, batch, { "LR1_1.jpg": await jpeg(), "LR2_1.jpg": await jpeg() });
    const body: Body = { batchId: batch.id, uploadId, run: "run-1" };
    let fail = true;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      uploadBuffer: async (path, buf, mime, opts) => {
        if (fail && path.includes("/raw/")) throw Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
        return w.storage.uploadBuffer(path, buf, mime, opts);
      },
    };
    await expect(runIngest(db, { ...deps(w), storage, now: c.now }, body)).rejects.toThrow("Connection reset");
    let row = await batchRow(batch.id);
    expect(row.status).toBe("ingesting");
    expect(row.counts.placingClaim?.token).toBe(deliveryToken(body));
    expect(row.counts.phase).toBe("placing");
    fail = false;

    // A delivery of another hand-off (another token) while the lease is live: nothing happens.
    c.advance(60_000);
    expect((await runIngest(db, { ...deps(w), now: c.now }, { ...body, run: "run-2" })).outcome).toBe("noop: upload already collected");
    row = await batchRow(batch.id);
    expect(row.status).toBe("ingesting");
    expect(row.counts.placingClaim?.token).toBe(deliveryToken(body));
    expect(await sourcesOf(batch.id)).toEqual([]);

    // Cloud Tasks retries the same task: same token, so it continues.
    expect((await runIngest(db, { ...deps(w), now: c.now }, body)).outcome).toBe("preview ready: 2 products, 2 photos");
    row = await batchRow(batch.id);
    expect(row).toMatchObject({ status: "draft", counts: { phase: "ready", placingClaim: null, previewReady: true } });
    expect(await sourcesOf(batch.id)).toHaveLength(2);
  });

  it("a duplicate delivery of the claiming task while its first copy still places does nothing", async () => {
    const w = fakeWorld();
    const batch = await newBatch("lease duplicate");
    const uploadId = await folderUpload(w, batch, { "LD1_1.jpg": await jpeg(), "LD2_1.jpg": await jpeg() });
    const body: Body = { batchId: batch.id, uploadId, run: "run-1" };
    let duplicate: string | null = null;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri) => {
        if (duplicate === null && gsUri.includes("/uploads/") && (await batchRow(batch.id)).counts.phase === "placing") {
          // Cloud Tasks delivers the same task again (same body, same token) while this run places.
          duplicate = (await runIngest(db, deps(w), body)).outcome;
        }
        return w.storage.downloadBuffer(gsUri);
      },
    };
    expect((await runIngest(db, { ...deps(w), storage }, body)).outcome).toBe("preview ready: 2 products, 2 photos");
    expect(duplicate).toBe("noop: upload already collected");
    expect((await batchRow(batch.id)).counts).toMatchObject({ phase: "ready", placingClaim: null, previewReady: true });
    expect(await sourcesOf(batch.id)).toHaveLength(2);
  });

  it("a lapsed lease can be claimed by another delivery", async () => {
    const w = fakeWorld();
    const c = clock();
    const batch = await newBatch("lease lapsed");
    const uploadId = await folderUpload(w, batch, { "LL1_1.jpg": await jpeg() });
    const body: Body = { batchId: batch.id, uploadId, run: "dead" };
    const storage: IngestDeps["storage"] = { ...w.storage, uploadBuffer: async () => { throw new Error("killed"); } };
    await expect(runIngest(db, { ...deps(w), storage, now: c.now }, body)).rejects.toThrow("killed");
    c.advance(PLACING_LEASE_MS + 1_000);
    const other: Body = { ...body, run: "try-again" };
    expect((await runIngest(db, { ...deps(w), now: c.now }, other)).outcome).toBe("preview ready: 1 products, 1 photos");
    expect((await batchRow(batch.id)).counts).toMatchObject({ phase: "ready", placingClaim: null });
  });

  it("a web write merged during placing (as regroupBatch now writes) keeps phase and placingClaim", async () => {
    const w = fakeWorld();
    const batch = await newBatch("merge during placing");
    const uploadId = await folderUpload(w, batch, { "MP1_1.jpg": await jpeg() });
    let seen: CatalogBatch | null = null;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri) => {
        if (!seen && gsUri.includes("/uploads/") && (await batchRow(batch.id)).counts.phase === "placing") {
          await db.update(catalogBatches).set({ counts: mergeCounts({ previewReady: false }) }).where(eq(catalogBatches.id, batch.id));
          seen = await batchRow(batch.id);
        }
        return w.storage.downloadBuffer(gsUri);
      },
    };
    await runIngest(db, { ...deps(w), storage }, { batchId: batch.id, uploadId });
    expect(seen!.counts).toMatchObject({ phase: "placing", previewReady: false, placingClaim: { token: deliveryToken({ uploadId }) } });
  });
});

describe("placing never re-copies (spec 14c F7 part 1)", () => {
  it("a second placing run on the same batch performs zero copies", async () => {
    const w = fakeWorld();
    const batch = await newBatch("no re-copy");
    await folderUpload(w, batch, { "NR1_1.jpg": await jpeg(), "NR1_2.jpg": await jpeg(), "NR2_1.jpg": await jpeg() });
    await ingestAll(w, batch);
    const copies = w.calls.uploads.filter((u) => u.includes("/raw/")).length;
    expect(copies).toBe(3);
    const raw = w.objects.get(`gs://${BUCKET}/${rawPath(prefixOf(batch), "NR1", 1, "jpg")}`)!;
    expect(raw.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Continue on step 2 hands the uploads again: the grouping runs, the photos are already in place.
    await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.batchId, batch.id));
    await ingestAll(w, batch);
    expect(w.calls.uploads.filter((u) => u.includes("/raw/")).length).toBe(copies);
    expect((await batchRow(batch.id)).counts).toMatchObject({ previewReady: true, sources: 3, phase: "ready" });
    expect(await sourcesOf(batch.id)).toHaveLength(3);

    // A raw object whose bytes differ (another sha256), or that carries no sha256 (written before
    // release C), is copied again and gets the item's sha256.
    const changed = `gs://${BUCKET}/${rawPath(prefixOf(batch), "NR1", 1, "jpg")}`;
    const unmarked = `gs://${BUCKET}/${rawPath(prefixOf(batch), "NR2", 1, "jpg")}`;
    w.objects.set(changed, { ...w.objects.get(changed)!, sha256: "0".repeat(64) });
    w.objects.set(unmarked, { ...w.objects.get(unmarked)!, sha256: undefined });
    await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.batchId, batch.id));
    await ingestAll(w, batch);
    expect(w.calls.uploads.filter((u) => u.includes("/raw/")).length).toBe(copies + 2);
    expect(w.objects.get(changed)!.sha256).toBe(raw.sha256);
    expect(w.objects.get(unmarked)!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cancel guards (spec 14c F4 part 2)", () => {
  type Body = { batchId: string; uploadId: string; cursor?: string };
  const cancel = (id: string) => db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, id));
  const products = async (batchId: string) => db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId));

  it("a batch cancelled mid-collection stays cancelled through the remaining deliveries and the placing, with no version rows", async () => {
    const w = fakeWorld();
    const batch = await newBatch("cancel collecting");
    const files: Record<string, Buffer> = {};
    for (let n = 1; n <= 6; n++) files[`CC${n}_1.jpg`] = await jpeg();
    const uploadId = await folderUpload(w, batch, files);
    const other = await folderUpload(w, batch, { "CO1_1.jpg": await jpeg() });

    await runIngest(db, deps(w, 2), { batchId: batch.id, uploadId });
    // The operator cancels while the second delivery reads its photos.
    let cancelled = false;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      downloadBuffer: async (gsUri) => {
        if (!cancelled && gsUri.endsWith(".jpg")) {
          cancelled = true;
          await cancel(batch.id);
        }
        return w.storage.downloadBuffer(gsUri);
      },
    };
    const queued = w.enqueued.length;
    expect((await runIngest(db, { ...deps(w, 2), storage }, w.enqueued[0]!.body as Body)).outcome).toBe("stopped: the batch was cancelled");
    expect(w.enqueued).toHaveLength(queued);
    // Every later delivery, including the other upload's first one, does nothing.
    expect((await runIngest(db, deps(w, 10), { batchId: batch.id, uploadId, cursor: "4" })).outcome).toBe("noop: the batch is cancelled");
    expect((await runIngest(db, deps(w, 10), { batchId: batch.id, uploadId: other })).outcome).toBe("noop: the batch is cancelled");
    await db.update(catalogUploads).set({ status: "collected" }).where(eq(catalogUploads.batchId, batch.id));
    expect((await runIngest(db, deps(w, 10), { batchId: batch.id, uploadId: other })).outcome).toBe("noop: the batch is cancelled");

    expect((await batchRow(batch.id)).status).toBe("cancelled");
    expect(await sourcesOf(batch.id)).toEqual([]);
    expect(await products(batch.id)).toEqual([]);
  });

  it("a batch cancelled while placing is not revived, and the rows placing wrote are removed", async () => {
    const w = fakeWorld();
    const batch = await newBatch("cancel placing");
    const uploadId = await folderUpload(w, batch, { "CP1_1.jpg": await jpeg(), "CP2_1.jpg": await jpeg() });
    let cancelled = false;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      uploadBuffer: async (path, buf, mime, opts) => {
        if (!cancelled && path.includes("/raw/")) {
          cancelled = true;
          await cancel(batch.id);
        }
        return w.storage.uploadBuffer(path, buf, mime, opts);
      },
    };
    expect((await runIngest(db, { ...deps(w), storage }, { batchId: batch.id, uploadId })).outcome).toBe("stopped: the batch was cancelled");
    const row = await batchRow(batch.id);
    expect(row.status).toBe("cancelled");
    expect(row.counts.previewReady).toBe(false);
    expect(await sourcesOf(batch.id)).toEqual([]);
    expect(await products(batch.id)).toEqual([]);
    // A retry of the same task finds the batch cancelled.
    expect((await runIngest(db, deps(w), { batchId: batch.id, uploadId })).outcome).toBe("noop: the batch is cancelled");
    expect((await batchRow(batch.id)).status).toBe("cancelled");
  });
});


/** A distinct tiny jpeg per index (the colour encodes it), quick enough for a thousand photos. */
async function tinyJpeg(i: number): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: i % 256, g: (i % 4) * 60, b: Math.floor(i / 256) * 40 % 256 } } }).jpeg().toBuffer();
}

type PlaceBody = { batchId: string; uploadId: string; cursor?: string; run?: string; place?: string };
const rawCopies = (w: World) => w.calls.uploads.filter((u) => u.includes("/raw/")).length;

describe("placing in resumable chunks (spec 14d F7 part 2)", () => {
  it("1,000 photos with PLACE_BUDGET_ITEMS 300: four placing deliveries, placed 300, 600, 900, 1,000, rows only after the last", async () => {
    const w = fakeWorld();
    const batch = await newBatch("chunked placing");
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 1000; i++) files[`CH${String(Math.floor(i / 4)).padStart(3, "0")}_${(i % 4) + 1}.jpg`] = await tinyJpeg(i);
    const uploadId = await folderUpload(w, batch, files);
    const d = { ...deps(w, 1000), placeBudgetItems: 300 };

    const placed: number[] = [];
    const first = await runIngest(db, d, { batchId: batch.id, uploadId, run: "r1" });
    expect(first.outcome).toBe("placed 300 of 1000; continuing at 300");
    let row = await batchRow(batch.id);
    placed.push(row.counts.placed ?? 0);
    expect(row).toMatchObject({ status: "ingesting", counts: { phase: "placing", placeTotal: 1000 } });
    expect(await sourcesOf(batch.id)).toEqual([]);
    // The plan is saved under its lease's own name.
    const lease = createHash("sha256").update(deliveryToken({ uploadId, run: "r1" })).digest("hex").slice(0, 16);
    expect(w.objects.has(`gs://${BUCKET}/${prefixOf(batch)}/derived/_ingest/place-state-${lease}.json`)).toBe(true);

    let deliveries = 1;
    for (let next = w.enqueued.at(-1); next?.body.place; next = w.enqueued.at(-1)) {
      const from = w.enqueued.length;
      const r = await runIngest(db, d, next.body as PlaceBody);
      deliveries++;
      row = await batchRow(batch.id);
      placed.push(row.counts.placed ?? 0);
      if (w.enqueued.length === from) {
        expect(r.outcome).toBe("preview ready: 250 products, 1000 photos");
        break;
      }
      expect(row).toMatchObject({ status: "ingesting", counts: { phase: "placing" } });
      expect(await sourcesOf(batch.id)).toEqual([]);
    }
    expect(deliveries).toBe(4);
    expect(placed).toEqual([300, 600, 900, 1000]);
    // Every continuation carries the lease's body (same token) and a named task.
    expect(w.enqueued.filter((e) => e.body.place).map((e) => [e.body.place, e.body.run])).toEqual([["300", "r1"], ["600", "r1"], ["900", "r1"]]);
    row = await batchRow(batch.id);
    expect(row).toMatchObject({ status: "draft", counts: { phase: "ready", previewReady: true, placed: 1000, sources: 1000, placingClaim: null } });
    expect(await sourcesOf(batch.id)).toHaveLength(1000);
    expect(rawCopies(w)).toBe(1000);
  }, 120_000);

  it("a delivery killed after chunk 2 keeps the lease and the cursor: its retry with the same token continues to the end", async () => {
    const w = fakeWorld();
    const batch = await newBatch("killed placing");
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 10; i++) files[`KP${i}_1.jpg`] = await tinyJpeg(2000 + i);
    const uploadId = await folderUpload(w, batch, files);
    let kill = true;
    const enqueue = async (route: string, body: Record<string, unknown>) => {
      if (kill && body.place === "6") throw new Error("killed");
      return w.enqueue(route, body);
    };
    const d = { ...deps(w), enqueue: enqueue as never, placeBudgetItems: 3 };
    const body: PlaceBody = { batchId: batch.id, uploadId, run: "kp" };
    await runIngest(db, d, body);
    const second = w.enqueued.at(-1)!.body as PlaceBody;
    expect(second.place).toBe("3");
    await expect(runIngest(db, d, second)).rejects.toThrow("killed");
    let row = await batchRow(batch.id);
    expect(row).toMatchObject({ status: "ingesting", counts: { phase: "placing", placed: 6, placingClaim: { token: deliveryToken(body) } } });
    const copies = rawCopies(w);
    expect(copies).toBe(6);

    // Cloud Tasks retries the killed delivery (same body, same token): chunk 2 costs no copy, then on.
    kill = false;
    await runIngest(db, d, second);
    expect(rawCopies(w)).toBe(copies);
    for (let next = w.enqueued.at(-1)!.body as PlaceBody; next.place !== "done"; ) {
      const from = w.enqueued.length;
      await runIngest(db, d, next);
      next = (w.enqueued[from]?.body as PlaceBody) ?? { ...next, place: "done" };
    }
    row = await batchRow(batch.id);
    expect(row).toMatchObject({ status: "draft", counts: { phase: "ready", placed: 10, placingClaim: null } });
    expect(await sourcesOf(batch.id)).toHaveLength(10);
    expect(rawCopies(w)).toBe(10);
  });

  it("a continuation under an older lease places nothing once a later run regrouped the batch", async () => {
    const w = fakeWorld();
    const batch = await newBatch("stale continuation");
    const uploadId = await folderUpload(w, batch, { "SC1_1.jpg": await tinyJpeg(3001), "SC2_1.jpg": await tinyJpeg(3002) });
    const d = { ...deps(w), placeBudgetItems: 1 };
    await runIngest(db, d, { batchId: batch.id, uploadId, run: "old" });
    const stale = w.enqueued.at(-1)!.body as PlaceBody;
    // Try again on a stalled batch: the web clears the lease and a new run takes it and regroups.
    await db.update(catalogBatches).set({ counts: mergeCounts({ placingClaim: null }) }).where(eq(catalogBatches.id, batch.id));
    await runIngest(db, d, { batchId: batch.id, uploadId, run: "new" });
    expect((await runIngest(db, d, stale)).outcome).toBe("noop: another delivery holds the placing lease");
    expect(await sourcesOf(batch.id)).toEqual([]);
  });

  it("a redelivered grouping task after the first hand-off queues the continuation again and never regroups", async () => {
    const w = fakeWorld();
    const batch = await newBatch("regroup redelivery");
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 6; i++) files[`RG${i}_1.jpg`] = await tinyJpeg(5000 + i);
    const uploadId = await folderUpload(w, batch, files);
    const d = { ...deps(w), placeBudgetItems: 2 };
    const body: PlaceBody = { batchId: batch.id, uploadId, run: "rg" };
    await runIngest(db, d, body);
    const productsBefore = (await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).map((p) => p.productId).sort();
    const from = w.enqueued.length;
    // At-least-once delivery: the grouping task arrives again while its chain is under way.
    const again = await runIngest(db, d, body);
    expect(again.outcome).toBe("placing already at 2; continuation queued again");
    expect(w.enqueued.slice(from).map((e) => e.body.place)).toEqual(["2"]);
    const productsAfter = (await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).map((p) => p.productId).sort();
    expect(productsAfter).toEqual(productsBefore);
    expect(await batchRow(batch.id)).toMatchObject({ status: "ingesting", counts: { placed: 2, placingClaim: { next: 2, attempt: null } } });
  });

  it("a duplicate continuation while its first copy still places does nothing", async () => {
    const w = fakeWorld();
    const batch = await newBatch("duplicate continuation");
    const uploadId = await folderUpload(w, batch, { "DC1_1.jpg": await tinyJpeg(5101), "DC2_1.jpg": await tinyJpeg(5102), "DC3_1.jpg": await tinyJpeg(5103) });
    const d = { ...deps(w), placeBudgetItems: 1 };
    await runIngest(db, d, { batchId: batch.id, uploadId, run: "dc" });
    const second = w.enqueued.at(-1)!.body as PlaceBody;
    // The first copy took the attempt (as resumeAttempt does) and is still running.
    await db.update(catalogBatches).set({ counts: sql`jsonb_set(${catalogBatches.counts}, '{placingClaim,attempt}', '"running"'::jsonb)` }).where(eq(catalogBatches.id, batch.id));
    expect((await runIngest(db, d, second)).outcome).toBe("noop: another delivery holds the placing lease");
    expect(rawCopies(w)).toBe(1);
  });

  it("a cancel between two placing chunks removes the products and rows grouping wrote", async () => {
    const w = fakeWorld();
    const batch = await newBatch("cancel between chunks");
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 10; i++) files[`CB${i}_1.jpg`] = await tinyJpeg(5200 + i);
    const uploadId = await folderUpload(w, batch, files);
    const d = { ...deps(w), placeBudgetItems: 3 };
    await runIngest(db, d, { batchId: batch.id, uploadId, run: "cb" });
    const next = w.enqueued.at(-1)!.body as PlaceBody;
    const created = (await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).map((p) => p.productId);
    expect(created).toHaveLength(10);
    await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, batch.id));
    expect((await runIngest(db, d, next)).outcome).toBe("noop: the batch is cancelled");
    expect(await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).toEqual([]);
    expect(await db.select().from(catalogProducts).where(inArray(catalogProducts.id, created))).toEqual([]);
    expect(await sourcesOf(batch.id)).toEqual([]);
  });

  it("an options-only regroup runs groupBatch then placeBatch with zero copies and no upload status change", async () => {
    const w = fakeWorld();
    const batch = await newBatch("options only");
    const uploadId = await folderUpload(w, batch, { "OO1_1.jpg": await tinyJpeg(4001), "OO1_2.jpg": await tinyJpeg(4002), "OO2_1.jpg": await tinyJpeg(4003) });
    await ingestAll(w, batch);
    const copies = rawCopies(w);
    expect(copies).toBe(3);
    // What the web tier does (regroupBatch with optionsOnly, then ingestBatch): new options, the batch
    // collecting again, the preview cleared, one collected upload handed under a new run.
    await db.update(catalogBatches).set({ status: "ingesting", options: { ...batch.options, precedence: "uploads_only" }, counts: mergeCounts({ previewReady: false, placingClaim: null }) }).where(eq(catalogBatches.id, batch.id));
    const outcome = await runIngest(db, deps(w), { batchId: batch.id, uploadId, run: "regroup" });
    expect(outcome.outcome).toBe("preview ready: 2 products, 3 photos");
    expect(rawCopies(w)).toBe(copies);
    const uploads = await db.select({ status: catalogUploads.status }).from(catalogUploads).where(eq(catalogUploads.batchId, batch.id));
    expect(uploads.map((u) => u.status)).toEqual(["collected"]);
    expect((await batchRow(batch.id))).toMatchObject({ status: "draft", options: { precedence: "uploads_only" }, counts: { previewReady: true, phase: "ready" } });
  });

  it("measures groupBatch at about 2,000 products against the 900 s deadline", async () => {
    const w = fakeWorld();
    const batch = await newBatch("group timing");
    const files: Record<string, Buffer> = {};
    const N = 2000;
    for (let i = 0; i < N; i++) files[`GT${String(i).padStart(4, "0")}_1.jpg`] = await tinyJpeg(10_000 + i);
    const uploadId = await folderUpload(w, batch, files);
    // Collect all but one item first, so the timed delivery reads one item and then groups.
    await runIngest(db, deps(w, N - 1), { batchId: batch.id, uploadId, run: "gt" });
    let manifestSaved = 0, planSaved = 0;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      uploadBuffer: async (path, buf, mime, opts) => {
        if (path.endsWith("manifest.json")) manifestSaved = performance.now();
        if (/\/place-state-[0-9a-f]+\.json$/.test(path)) planSaved = performance.now();
        return w.storage.uploadBuffer(path, buf, mime, opts);
      },
    };
    // One products chunk for all of them, so the delivery groups everything and places the first chunk.
    const r = await runIngest(db, { ...deps(w), storage, productBudgetItems: N }, w.enqueued.at(-1)!.body as PlaceBody);
    expect(r.outcome).toBe(`placed ${PLACE_BUDGET_ITEMS} of ${N}; continuing at ${PLACE_BUDGET_ITEMS}`);
    const groupMs = Math.round(planSaved - manifestSaved);
    // PGlite in one process is slower than Cloud SQL, so this bound is loose.
    console.info(JSON.stringify({ event: "groupBatch timing", products: N, ms: groupMs }));
    expect(groupMs).toBeGreaterThan(0);
    expect(groupMs).toBeLessThan(300_000);
  }, 600_000);
});

type GroupBody = PlaceBody & { group?: string };

describe("grouping in resumable chunks (large batches)", () => {
  /** A batch of `n` one-photo products, all collected, and the body of its last delivery not yet run. */
  async function grouped(name: string, n: number, seed: number) {
    const w = fakeWorld();
    const batch = await newBatch(name);
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < n; i++) files[`${name.replace(/\W/g, "").slice(0, 6).toUpperCase()}${i}_1.jpg`] = await tinyJpeg(seed + i);
    const uploadId = await folderUpload(w, batch, files);
    return { w, batch, uploadId, body: { batchId: batch.id, uploadId, run: name } as GroupBody };
  }

  it("7 products with PRODUCT_BUDGET_ITEMS 2: four grouping deliveries renew the lease and write progress, then placing", async () => {
    const { w, batch, body } = await grouped("seven products", 7, 6000);
    const T0 = Date.parse("2026-11-01T08:00:00Z");
    let t = T0;
    const d = { ...deps(w), productBudgetItems: 2, now: () => new Date(t) };
    const first = await runIngest(db, d, body);
    expect(first.outcome).toBe("grouped 2 of 7 products; continuing at 2");
    const progress: [number | undefined, string | undefined][] = [];
    let row = await batchRow(batch.id);
    progress.push([row.counts.grouped, row.counts.placingClaim?.until]);
    expect(row).toMatchObject({ status: "ingesting", counts: { phase: "grouping", grouped: 2, groupTotal: 7, placingClaim: { token: deliveryToken(body), group: 2, attempt: null } } });
    expect(await sourcesOf(batch.id)).toEqual([]);
    expect(w.enqueued.at(-1)!.body).toEqual({ ...body, group: "2" });
    let deliveries = 1;
    for (let next = w.enqueued.at(-1)!.body as GroupBody; next.group !== undefined; next = w.enqueued.at(-1)!.body as GroupBody) {
      t += 60_000;
      const from = w.enqueued.length;
      const r = await runIngest(db, d, next);
      deliveries++;
      row = await batchRow(batch.id);
      progress.push([row.counts.grouped, row.counts.placingClaim?.until]);
      if (w.enqueued.length === from) {
        expect(r.outcome).toBe("preview ready: 7 products, 7 photos");
        break;
      }
    }
    expect(deliveries).toBe(4);
    // Each chunk renewed the lease (a later `until`) and moved `grouped` on; the last one cleared both.
    expect(progress.slice(0, 3)).toEqual([2, 4, 6].map((g, i) => [g, new Date(T0 + i * 60_000 + PLACING_LEASE_MS).toISOString()]));
    expect(row).toMatchObject({ status: "draft", counts: { phase: "ready", previewReady: true, products: 7, sources: 7, newProducts: 7, placingClaim: null } });
    const rows = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id));
    expect(rows.map((r) => r.change)).toEqual(Array(7).fill("new"));
    expect(await sourcesOf(batch.id)).toHaveLength(7);
    expect(w.enqueued.filter((e) => e.body.group).map((e) => e.body.group)).toEqual(["2", "4", "6"]);
  });

  it("a duplicate delivery of a grouping chunk while its first copy runs does nothing; a redelivery after its hand-off only queues the next chunk", async () => {
    const { w, batch, body } = await grouped("dup group chunk", 6, 6100);
    const d = { ...deps(w), productBudgetItems: 2 };
    await runIngest(db, d, body);
    const second = w.enqueued.at(-1)!.body as GroupBody;
    // The first copy of chunk 2 took the attempt and is still running.
    await db.update(catalogBatches).set({ counts: sql`jsonb_set(${catalogBatches.counts}, '{placingClaim,attempt}', '"running"'::jsonb)` }).where(eq(catalogBatches.id, batch.id));
    const calls = vi.mocked(findOrCreateProduct).mock.calls.length;
    expect((await runIngest(db, d, second)).outcome).toBe("noop: another delivery holds the placing lease");
    expect(vi.mocked(findOrCreateProduct).mock.calls.length).toBe(calls);
    // It finishes and hands on to chunk 4; the same task delivered again only queues chunk 4 again.
    await db.update(catalogBatches).set({ counts: sql`jsonb_set(${catalogBatches.counts}, '{placingClaim,attempt}', 'null'::jsonb)` }).where(eq(catalogBatches.id, batch.id));
    expect((await runIngest(db, d, second)).outcome).toBe("grouped 4 of 6 products; continuing at 4");
    const from = w.enqueued.length;
    expect((await runIngest(db, d, second)).outcome).toBe("grouping already at 4; continuation queued again");
    expect((await runIngest(db, d, body)).outcome).toBe("grouping already at 4; continuation queued again");
    expect(w.enqueued.slice(from).map((e) => e.body.group)).toEqual(["4", "4"]);
    expect(vi.mocked(findOrCreateProduct).mock.calls.length).toBe(calls + 2);
    expect(await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).toHaveLength(4);
  });

  it("a chunk that throws part-way is retried from its saved state: no product is counted twice and the created ones stay new", async () => {
    const { w, batch, body } = await grouped("retry group chunk", 6, 6200);
    const d = { ...deps(w), productBudgetItems: 3 };
    await runIngest(db, d, body);
    const second = w.enqueued.at(-1)!.body as GroupBody;
    expect(second.group).toBe("3");
    // The fifth product's write fails after the fourth was created.
    vi.mocked(findOrCreateProduct).mockImplementationOnce(async (...args) => (await vi.importActual<typeof import("../products")>("../products")).findOrCreateProduct(...args));
    vi.mocked(findOrCreateProduct).mockRejectedValueOnce(new Error("connection reset"));
    await expect(runIngest(db, d, second)).rejects.toThrow("connection reset");
    expect((await batchRow(batch.id)).counts.placingClaim).toMatchObject({ token: deliveryToken(body), group: 3, attempt: null });
    expect(await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).toHaveLength(4);
    // Cloud Tasks retries the same task.
    expect((await runIngest(db, d, second)).outcome).toBe("preview ready: 6 products, 6 photos");
    const rows = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id));
    expect(rows.map((r) => r.change)).toEqual(Array(6).fill("new"));
    expect((await batchRow(batch.id)).counts).toMatchObject({ products: 6, newProducts: 6, existingProducts: 0 });
  });

  it("a cancel between two grouping chunks stops the next one and removes the products already created", async () => {
    const { w, batch, body } = await grouped("cancel group chunk", 6, 6300);
    const d = { ...deps(w), productBudgetItems: 2 };
    await runIngest(db, d, body);
    const next = w.enqueued.at(-1)!.body as GroupBody;
    const created = (await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).map((p) => p.productId);
    expect(created).toHaveLength(2);
    await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, batch.id));
    const calls = vi.mocked(findOrCreateProduct).mock.calls.length;
    expect((await runIngest(db, d, next)).outcome).toBe("noop: the batch is cancelled");
    expect(vi.mocked(findOrCreateProduct).mock.calls.length).toBe(calls);
    expect(await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).toEqual([]);
    expect(await db.select().from(catalogProducts).where(inArray(catalogProducts.id, created))).toEqual([]);
  });

  it("a cancel during a grouping chunk stops it at its next progress write", async () => {
    const { w, batch, body } = await grouped("cancel in chunk", 5, 6400);
    let t = Date.parse("2026-11-01T09:00:00Z");
    const d = { ...deps(w), now: () => new Date(t) };
    const real = await vi.importActual<typeof import("../products")>("../products");
    let n = 0;
    vi.mocked(findOrCreateProduct).mockImplementation(async (...args) => {
      // Each product takes 11 s; after the second the operator cancels.
      t += 11_000;
      if (++n === 2) await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, batch.id));
      return real.findOrCreateProduct(...args);
    });
    try {
      expect((await runIngest(db, d, body)).outcome).toBe("stopped: the batch was cancelled");
    } finally {
      vi.mocked(findOrCreateProduct).mockImplementation(real.findOrCreateProduct);
    }
    expect(n).toBe(2);
    expect(await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id))).toEqual([]);
    expect(await sourcesOf(batch.id)).toEqual([]);
  });

  it("a chunk stops on GROUP_TIME_BUDGET_MS and the delivery that finds the last product hands placing on when out of time", async () => {
    const { w, batch, body } = await grouped("time budget", 4, 6500);
    let t = Date.parse("2026-11-01T10:00:00Z");
    const real = await vi.importActual<typeof import("../products")>("../products");
    vi.mocked(findOrCreateProduct).mockImplementation(async (...args) => {
      t += GROUP_TIME_BUDGET_MS / 2;
      return real.findOrCreateProduct(...args);
    });
    const d = { ...deps(w), now: () => new Date(t) };
    const outcomes: string[] = [];
    try {
      outcomes.push((await runIngest(db, d, body)).outcome);
      for (let next = w.enqueued.at(-1)!.body as GroupBody; next.group !== undefined; next = w.enqueued.at(-1)!.body as GroupBody) outcomes.push((await runIngest(db, d, next)).outcome);
    } finally {
      vi.mocked(findOrCreateProduct).mockImplementation(real.findOrCreateProduct);
    }
    expect(outcomes).toEqual(["grouped 2 of 4 products; continuing at 2", "grouped 4 products; placing continues at 0"]);
    expect(await batchRow(batch.id)).toMatchObject({ status: "ingesting", counts: { phase: "placing", placed: 0, placeTotal: 4, placingClaim: { next: 0, attempt: null } } });
    expect((await runIngest(db, d, w.enqueued.at(-1)!.body as GroupBody)).outcome).toBe("preview ready: 4 products, 4 photos");
  });

  it("an ingest task out of attempts fails a collecting batch with the operator sentence; a cancelled one stays cancelled", async () => {
    const { w, batch, body } = await grouped("out of attempts", 4, 6700);
    await runIngest(db, { ...deps(w), productBudgetItems: 2 }, body);
    expect(await failStoppedIngest(db, batch.id, w.enqueued.at(-1)!.body as GroupBody)).toBe(true);
    expect(await batchRow(batch.id)).toMatchObject({ status: "failed", counts: { failReason: INGEST_STOPPED_TEXT, placingClaim: null, phase: null, previewReady: false } });
    const other = await newBatch("cancelled out of attempts");
    await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, other.id));
    expect(await failStoppedIngest(db, other.id, { uploadId: "u1" })).toBe(false);
    expect((await batchRow(other.id)).status).toBe("cancelled");
  });

  it("a task of an earlier run out of attempts never fails the batch a newer run is collecting", async () => {
    const { w, batch, uploadId, body } = await grouped("stale stop", 4, 6800);
    const d = { ...deps(w), productBudgetItems: 2 };
    await runIngest(db, d, body);
    const stale = w.enqueued.at(-1)!.body as GroupBody;
    // Try again: the web clears the lost lease and names the newer run (ingestBatch).
    await db.update(catalogBatches).set({ counts: mergeCounts({ placingClaim: null, ingestRun: "stale stop 2" }) }).where(eq(catalogBatches.id, batch.id));
    // Before the newer run claims: only a task of the newer run counts.
    expect(await failStoppedIngest(db, batch.id, stale)).toBe(false);
    expect(await failStoppedIngest(db, batch.id, body)).toBe(false);
    const newer = { batchId: batch.id, uploadId, run: "stale stop 2" };
    expect((await runIngest(db, d, newer)).outcome).toBe("grouped 2 of 4 products; continuing at 2");
    // The newer run holds the lease: the earlier run's continuation is dropped, the batch keeps collecting.
    expect(await failStoppedIngest(db, batch.id, stale)).toBe(false);
    expect((await batchRow(batch.id)).status).toBe("ingesting");
    expect(await failStoppedIngest(db, batch.id, w.enqueued.at(-1)!.body as GroupBody)).toBe(true);
    expect((await batchRow(batch.id)).counts.failReason).toBe(INGEST_STOPPED_TEXT);
  });

  it("an earlier run frozen while it saves its grouping never breaks the newer run's chunks", async () => {
    const { w, batch, uploadId, body } = await grouped("frozen group state", 4, 6900);
    const d = { ...deps(w), productBudgetItems: 2 };
    // The earlier run's grouping delivery stalls while it saves what it decided (a frozen instance).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      uploadBuffer: async (path, buf, mime, opts) => {
        if (!held && path.includes("/group-state")) {
          held = true;
          await gate;
        }
        return w.storage.uploadBuffer(path, buf, mime, opts);
      },
    };
    const frozen = runIngest(db, { ...d, storage }, body);
    while (!held) await new Promise((r) => setTimeout(r, 5));
    // Try again clears the lost lease; the newer run claims it and groups its first chunk.
    await db.update(catalogBatches).set({ counts: mergeCounts({ placingClaim: null }) }).where(eq(catalogBatches.id, batch.id));
    expect((await runIngest(db, d, { batchId: batch.id, uploadId, run: "frozen group state 2" })).outcome).toBe("grouped 2 of 4 products; continuing at 2");
    const next = w.enqueued.at(-1)!.body as GroupBody;
    // The frozen delivery wakes, saves late and finds the lease gone.
    release();
    expect((await frozen).outcome).toBe("stopped: another delivery holds the placing lease");
    expect((await runIngest(db, d, next)).outcome).toBe("preview ready: 4 products, 4 photos");
  });

  it("a product created and then left out in a chunk that crashed is still removed by the retry", async () => {
    const w = fakeWorld();
    const batch = await newBatch("crashed late spellings");
    // The EAN file name resolves to the option id CRASH OPT, which is also the second file's key.
    await db.insert(skuMap).values({
      opptraSku: "CRASH_OPT_40", brand: "USPA", brandSlug: "uspa", line: "softline", source: "warehouse",
      optionKey: "CRASHOPT", optionIdStyleColor: "CRASH OPT", ean: "8680000000098",
    });
    const uploadId = await folderUpload(w, batch, { "8680000000098_1.jpg": await jpeg(), "CRASH-OPT_1.jpg": await jpeg(), "CRZ_1.jpg": await jpeg() });
    const real = (await vi.importActual<typeof import("../products")>("../products")).findOrCreateProduct;
    let thrown = false;
    // The database drops on the product after the two spellings met, before the chunk saved anything.
    vi.mocked(findOrCreateProduct).mockImplementation(async (tx, input) => {
      if (input.identifier === "CRZ" && !thrown) {
        thrown = true;
        throw new Error("Connection terminated unexpectedly");
      }
      return real(tx, input);
    });
    try {
      await expect(runIngest(db, deps(w), { batchId: batch.id, uploadId })).rejects.toThrow("Connection terminated unexpectedly");
    } finally {
      vi.mocked(findOrCreateProduct).mockImplementation(real);
    }
    expect((await runIngest(db, deps(w), { batchId: batch.id, uploadId })).outcome).toBe("preview ready: 1 products, 1 photos");
    const keys = (await db.select({ pathKey: catalogProducts.pathKey }).from(catalogProducts).where(eq(catalogProducts.brandSlug, "uspa"))).map((p) => p.pathKey);
    expect(keys).not.toContain("8680000000098");
    expect(await linkStatusesOf(batch.id)).toEqual({ CRZ: "ok" });
  });

  it("a grouping continuation under an older lease does nothing once a later run regrouped the batch", async () => {
    const { w, batch, uploadId, body } = await grouped("stale group", 4, 6600);
    const d = { ...deps(w), productBudgetItems: 2 };
    await runIngest(db, d, body);
    const stale = w.enqueued.at(-1)!.body as GroupBody;
    await db.update(catalogBatches).set({ counts: mergeCounts({ placingClaim: null }) }).where(eq(catalogBatches.id, batch.id));
    await runIngest(db, d, { batchId: batch.id, uploadId, run: "newer" });
    const calls = vi.mocked(findOrCreateProduct).mock.calls.length;
    expect((await runIngest(db, d, stale)).outcome).toBe("noop: another delivery holds the placing lease");
    expect(vi.mocked(findOrCreateProduct).mock.calls.length).toBe(calls);
  });
});

describe("automatic retry of transient link failures (spec 14d F5 part 2)", () => {
  const LINK = "https://104.18.38.10/retry";
  /** A url_list batch of `urls`, a clock the fake fetch and sleep move, and the fetch log. */
  async function linkBatch(urls: string[], answer: (url: string, call: number) => number | "timeout") {
    const w = fakeWorld();
    let t = Date.parse("2026-10-27T10:00:00Z");
    const calls = new Map<string, number>();
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      const n = (calls.get(url) ?? 0) + 1;
      calls.set(url, n);
      const a = answer(url, n);
      if (a === "timeout") {
        t += 60_000;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return a === 200 ? new Response(new Uint8Array(await jpeg()), { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: a, headers: { "content-type": "text/plain" } });
    };
    const [b] = await db.insert(catalogBatches).values({
      brandSlug: "test_brand", brandName: "Test Brand", name: "retry", isTest: true, createdBy: "op@opptra.com", channels: [],
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
    }).returning();
    const [u] = await db.insert(catalogUploads).values({ batchId: b!.id, kind: "url_list", name: "Image links", sourceUrl: urls.join("\n"), gcsUri: null, status: "uploaded" }).returning();
    const d = { ...deps(w), fetch, now: () => new Date(t), sleep: async (ms: number) => { t += ms; } };
    /** Runs one hand-off (a new run) through its collecting continuations. */
    const run = async (runId: string) => {
      await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.id, u!.id));
      await db.update(catalogBatches).set({ status: "draft" }).where(eq(catalogBatches.id, b!.id));
      let body: PlaceBody | null = { batchId: b!.id, uploadId: u!.id, run: runId };
      while (body) {
        const from = w.enqueued.length;
        await runIngest(db, d, body);
        body = (w.enqueued[from]?.body as PlaceBody | undefined) ?? null;
      }
    };
    const manifest = async () => JSON.parse(w.objects.get(`gs://${BUCKET}/${manifestPath(batchPrefix(b!.brandSlug, b!.id, true), u!.id)}`)!.buf.toString("utf8")) as UploadManifest;
    const result = async (url: string) => (await manifest()).results[`url:${url}`];
    return { w, calls, run, manifest, result, batchId: b!.id, uploadId: u!.id, d, tick: () => t };
  }

  it("503 twice then 200 gives one photo with attempts 3", async () => {
    const x = await linkBatch([`${LINK}/A_1.jpg`], (_url, n) => (n <= 2 ? 503 : 200));
    await x.run("r1");
    expect(await x.result(`${LINK}/A_1.jpg`)).toMatchObject({ ok: true, attempts: 3 });
    expect((await batchRow(x.batchId)).counts).toMatchObject({ sources: 1, linkFailures: 0 });
  });

  it("a 404 is final and never fetched again; a 429 left non-final is fetched again only by a new run; after LINK_MAX_ATTEMPTS it is final", async () => {
    const nf = `${LINK}/NF_1.jpg`, busy = `${LINK}/BUSY_1.jpg`, ok = `${LINK}/OK_1.jpg`;
    const x = await linkBatch([nf, busy, ok], (url) => (url === nf ? 404 : url === busy ? 429 : 200));
    await x.run("r1");
    expect(await x.result(nf)).toMatchObject({ ok: false, attempts: 1, final: true });
    expect(await x.result(busy)).toMatchObject({ ok: false, attempts: LINK_RETRY_ATTEMPTS, final: false });
    expect(x.calls.get(busy)).toBe(3);

    // A continuation of the same run reads the saved manifest: nothing is fetched again.
    await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.id, x.uploadId));
    await db.update(catalogBatches).set({ status: "ingesting" }).where(eq(catalogBatches.id, x.batchId));
    await runIngest(db, x.d, { batchId: x.batchId, uploadId: x.uploadId, run: "r1", cursor: "0" });
    expect([x.calls.get(nf), x.calls.get(busy)]).toEqual([1, 3]);

    // A new run fetches the non-final link again, never the final one; the attempts add up.
    await x.run("r2");
    expect([x.calls.get(nf), x.calls.get(busy)]).toEqual([1, 6]);
    expect(await x.result(busy)).toMatchObject({ attempts: 6, final: false });
    await x.run("r3");
    expect(await x.result(busy)).toMatchObject({ ok: false, attempts: LINK_MAX_ATTEMPTS, final: true });
    expect((await x.result(busy) as { reason: string }).reason).toContain("(got 429)");
    await x.run("r4");
    expect(x.calls.get(busy)).toBe(LINK_MAX_ATTEMPTS);
    expect(x.calls.get(ok)).toBe(1);
    // The card's sentence: the highest attempt count of a retried link.
    expect(linkFailuresBlock(await linkFailuresOf(db, x.batchId, { storage: x.w.storage })).attempts).toBe(LINK_MAX_ATTEMPTS);
  });

  it("a new run that reads only part of the earlier run's non-final links leaves the rest unread, not restored", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `${LINK}/PART${i}_1.jpg`);
    const x = await linkBatch(urls, () => 429);
    await x.run("r1");
    expect(Object.values((await x.manifest()).results).every((r) => !r.ok && r.final === false)).toBe(true);
    // The new run's first delivery reads two links (the item budget), then saves.
    await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.id, x.uploadId));
    await runIngest(db, { ...x.d, budgetItems: 2 }, { batchId: x.batchId, uploadId: x.uploadId, run: "r2" });
    const m = await x.manifest();
    expect(Object.keys(m.results)).toHaveLength(2);
    expect(Object.keys(m.priorAttempts ?? {})).toHaveLength(6);
    expect(x.w.enqueued.at(-1)).toMatchObject({ body: { run: "r2", cursor: expect.any(String) } });
  });

  it("a host that answers after 60 s every time still yields a saved manifest and a continuation within the time budget", async () => {
    const urls = Array.from({ length: 40 }, (_, i) => `${LINK}/SLOW${i}_1.jpg`);
    const x = await linkBatch(urls, () => "timeout");
    await runIngest(db, x.d, { batchId: x.batchId, uploadId: x.uploadId, run: "slow" });
    const m = await x.manifest();
    const read = Object.keys(m.results).length;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(urls.length);
    expect(Object.values(m.results).every((r) => !r.ok && r.final === false && r.attempts === LINK_RETRY_ATTEMPTS)).toBe(true);
    expect(x.w.enqueued.at(-1)).toMatchObject({ route: "/tasks/catalog/ingest", body: { uploadId: x.uploadId, run: "slow", cursor: expect.any(String) } });
    expect((await batchRow(x.batchId)).counts.collected).toBe(read);
    // The continuation starts again with a fresh budget and reads the next items.
    await runIngest(db, x.d, x.w.enqueued.at(-1)!.body as PlaceBody);
    expect(Object.keys((await x.manifest()).results).length).toBeGreaterThan(read);
    expect(INGEST_TIME_BUDGET_MS).toBe(600_000);
  });
});

describe("links shared by many rows (all sizes of a colour share the same photos)", () => {
  const SHARED = `${HOST}/shared`;
  /** A pasted grid: one row per size, every size of a colour listing the colour's same photo links. */
  async function sharedBatch(w: World, colours: string[], sizes: string[], photos: number) {
    const lines = colours.flatMap((c) => sizes.map((s) => [`${c}_${s}`, ...Array.from({ length: photos }, (_, k) => `${SHARED}/${c}_${k + 1}.jpg`)].join("\t")));
    const [b] = await db.insert(catalogBatches).values({
      brandSlug: "test_brand", brandName: "Test Brand", name: "shared links", isTest: true, createdBy: "op@opptra.com", channels: [],
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
    }).returning();
    const [u] = await db.insert(catalogUploads).values({ batchId: b!.id, kind: "url_list", name: "Image links", sourceUrl: lines.join("\n"), gcsUri: null, status: "uploaded" }).returning();
    const prefix = batchPrefix(b!.brandSlug, b!.id, true);
    const manifest = () => JSON.parse(w.objects.get(`gs://${BUCKET}/${manifestPath(prefix, u!.id)}`)!.buf.toString("utf8")) as UploadManifest;
    const stagedUploads = () => w.calls.uploads.filter((p) => p.includes(`/derived/_ingest/${u!.id}/`) && !p.endsWith("manifest.json"));
    const fetchesOf = (url: string) => w.calls.fetches.filter((f) => f === `GET ${url}`).length;
    return { batchId: b!.id, uploadId: u!.id, prefix, rows: colours.length * sizes.length * photos, manifest, stagedUploads, fetchesOf };
  }
  const uploadRow = async (id: string) => (await db.select().from(catalogUploads).where(eq(catalogUploads.id, id)))[0]!;

  it("fetches and stages each shared link once and counts every row as collected", async () => {
    const w = fakeWorld();
    const colours = ["BLUE", "GREEN"], photos = 3;
    for (const c of colours) for (let k = 1; k <= photos; k++) w.web.set(`${SHARED}/${c}_${k}.jpg`, await jpeg());
    const x = await sharedBatch(w, colours, ["29-33", "30-33", "31-33", "32-33", "34-33"], photos);
    await ingestAll(w, (await batchRow(x.batchId)) as CatalogBatch);

    for (const c of colours) for (let k = 1; k <= photos; k++) expect(x.fetchesOf(`${SHARED}/${c}_${k}.jpg`)).toBe(1);
    expect(x.stagedUploads()).toHaveLength(colours.length * photos);
    const results = Object.values(x.manifest().results);
    expect(results).toHaveLength(colours.length * photos);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await batchRow(x.batchId)).counts.collected).toBe(x.rows);
    expect((await uploadRow(x.uploadId)).status).toBe("collected");
  });

  it("writes the same bytes under two different links once, and never rewrites an object already staged", async () => {
    const w = fakeWorld();
    const same = await jpeg(), other = await jpeg();
    w.web.set(`${SHARED}/TWIN_1.jpg`, same);
    w.web.set(`${SHARED}/TWIN_2.jpg`, same);
    w.web.set(`${SHARED}/TWIN_3.jpg`, other);
    const x = await sharedBatch(w, ["TWIN"], ["S"], 3);
    // TWIN_3's bytes are already staged (a Cloud Tasks re-delivery, or an earlier run).
    w.put(`${x.prefix}/derived/_ingest/${x.uploadId}/${createHash("sha256").update(other).digest("hex")}.jpg`, other);
    await runIngest(db, deps(w), { batchId: x.batchId, uploadId: x.uploadId });

    expect(x.stagedUploads()).toHaveLength(1);
    const r = x.manifest().results;
    const [one, two] = [r[`url:${SHARED}/TWIN_1.jpg`], r[`url:${SHARED}/TWIN_2.jpg`]] as { ok: true; uri: string }[];
    expect(one!.uri).toBe(two!.uri);
    expect(r[`url:${SHARED}/TWIN_3.jpg`]).toMatchObject({ ok: true });
  });

  it("an item budget counts links, not rows: one delivery collects every row of two shared links", async () => {
    const w = fakeWorld();
    w.web.set(`${SHARED}/LEFT_1.jpg`, await jpeg());
    w.web.set(`${SHARED}/RIGHT_1.jpg`, await jpeg());
    // The first two rows are LEFT's: a budget of two rows would never reach RIGHT.
    const x = await sharedBatch(w, ["LEFT", "RIGHT"], ["S", "M", "L"], 1);
    await runIngest(db, deps(w, 2), { batchId: x.batchId, uploadId: x.uploadId });
    expect((await batchRow(x.batchId)).counts.collected).toBe(x.rows);
    expect((await uploadRow(x.uploadId)).status).toBe("collected");
  });

  it("a storage error on one photo keeps what the delivery read, and the retry reads only the rest", async () => {
    const w = fakeWorld();
    const photos = 6;
    const bufs = await Promise.all(Array.from({ length: photos }, () => jpeg()));
    bufs.forEach((buf, k) => w.web.set(`${SHARED}/HEAVY_${k + 1}.jpg`, buf));
    const x = await sharedBatch(w, ["HEAVY"], ["S", "M"], photos);
    const busy = Object.assign(new Error("exceeded the rate limit for object mutation operations"), { code: 429 });
    let failing = true;
    const storage: IngestDeps["storage"] = {
      ...w.storage,
      uploadBuffer: async (path, buf, mime, opts) => {
        if (failing && buf.equals(bufs[3]!)) throw busy;
        return w.storage.uploadBuffer(path, buf, mime, opts);
      },
    };
    const body = { batchId: x.batchId, uploadId: x.uploadId };
    await expect(runIngest(db, { ...deps(w), storage }, body)).rejects.toThrow("rate limit");
    const kept = x.manifest().results;
    expect(Object.keys(kept)).toHaveLength(photos - 1);
    expect(kept[`url:${SHARED}/HEAVY_4.jpg`]).toBeUndefined();
    expect((await batchRow(x.batchId)).counts.collected).toBe(x.rows - 2);

    // Cloud Tasks retries the same body: only the photo that failed is fetched again.
    failing = false;
    await runIngest(db, { ...deps(w), storage }, body);
    expect(x.fetchesOf(`${SHARED}/HEAVY_4.jpg`)).toBe(2);
    expect(x.fetchesOf(`${SHARED}/HEAVY_1.jpg`)).toBe(1);
    expect(Object.values(x.manifest().results).every((r) => r.ok)).toBe(true);
    expect((await uploadRow(x.uploadId)).status).toBe("collected");
  });
});

describe("a real folder with each shot stored twice (R1 exit 2 finding 1)", () => {
  it("makes one photo of X_1.jpg and X_1.jpeg with the same bytes, reading each file once; different bytes leave the product out, on the record", async () => {
    const w = fakeWorld();
    const batch = await newBatch("same-bytes");
    const [one, two, a, b] = [await jpeg(), await jpeg(), await jpeg(), await jpeg()];
    const files = { "10255347_Black/10255347_Black_1.jpg": one!, "10255347_Black/10255347_Black_1.jpeg": one!, "10255347_Black/10255347_Black_2.jpg": two!, "10255347_Black/10255347_Black_2.jpeg": two!, "10288257_Choc/10288257_Choc_1.jpg": a!, "10288257_Choc/10288257_Choc_1.jpeg": b! };
    await folderUpload(w, batch, files);
    const outcomes = await ingestAll(w, batch);
    expect(outcomes.at(-1)).toBe("preview ready: 1 products, 2 photos");
    // The grouping reads no bytes of its own: every file was downloaded once, to hash it.
    const prefix = `gs://${BUCKET}/${prefixOf(batch)}/uploads/`;
    const downloads = w.calls.downloads.filter((d) => d.startsWith(prefix) && d.endsWith("_1.jpg"));
    expect(downloads.length).toBeGreaterThan(0);
    expect(new Set(downloads).size).toBe(downloads.length);

    const done = await batchRow(batch.id);
    expect(done.counts).toMatchObject({ products: 1, sources: 2, duplicateFiles: 2, productsLeftOut: 1 });
    expect((await sourcesOf(batch.id)).map((s) => [s.n, s.originalName]).sort()).toEqual([[1, "10255347_Black/10255347_Black_1.jpeg"], [2, "10255347_Black/10255347_Black_2.jpeg"]]);

    const report = await readIngestReport({ ...w.storage, getBucketName: () => BUCKET } as never, prefixOf(batch));
    expect(report!.leftOutProducts).toEqual([{
      identifier: "10288257_Choc", why: "same_shot", photos: 2, files: ["10288257_Choc/10288257_Choc_1.jpeg", "10288257_Choc/10288257_Choc_1.jpg"],
      reason: "Two files claim shot 1 of 10288257_Choc: 10288257_Choc_1.jpeg, 10288257_Choc_1.jpg. Rename one and re-upload.",
    }]);
    expect(report!.sameFiles).toHaveLength(2);

    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.kpis.products).toBe(1);
    expect(preview.rows.find((r) => r.identifier === "10255347_Black")).toMatchObject({ status: "ok", shots: 2, notes: expect.arrayContaining(["10255347_Black_1.jpeg and 10255347_Black_1.jpg are the same photo, so one was used."]) });
    expect(preview.rows.find((r) => r.identifier === "10288257_Choc")).toMatchObject({ status: "duplicate shot" });
  }, 120_000);
});

describe("nothing is lost without a word at grouping (owner, 2026-11-06)", () => {
  const reportOf = (w: World, batch: CatalogBatch) => readIngestReport({ ...w.storage, getBucketName: () => BUCKET } as never, prefixOf(batch));

  it("when every product is left out it says why, not that no photos were found (P2-1)", async () => {
    const w = fakeWorld();
    const batch = await newBatch("all-left-out");
    await folderUpload(w, batch, { "P_1.jpg": await jpeg(), "P_1.jpeg": await jpeg() });
    await ingestAll(w, batch);
    const done = await batchRow(batch.id);
    expect(done.counts.failReason).toBe("The product could not be used: two different photos have the same shot number. Fix the files and start again.");
  }, 60_000);

  it("a left-out product on the product list is that row and not a second product (P2-3)", async () => {
    const w = fakeWorld();
    const batch = await newBatch("left-out-on-list");
    await folderUpload(w, batch, { "OK1_1.jpg": await jpeg(), "CL1_1.jpg": await jpeg(), "CL1_1.jpeg": await jpeg() });
    const listPath = `${prefixOf(batch)}/uploads/items.csv`;
    w.put(listPath, Buffer.from("Style\nOK1\nCL-1\nNOPHOTOS\n"));
    await newUpload(batch, "product_list", "items.csv", `gs://${BUCKET}/${listPath}`);
    await ingestAll(w, batch);
    const report = await reportOf(w, batch);
    expect(report!.leftOutProducts!.map((l) => l.identifier)).toEqual(["CL1"]);
    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    expect(preview.rows.filter((r) => /^cl-?1$/i.test(r.identifier ?? "")).map((r) => r.identifier)).toHaveLength(1);
    expect(preview.rows.map((r) => r.identifier)).toContain("NOPHOTOS");
    expect((await batchRow(batch.id)).counts).toMatchObject({ products: 1, productsLeftOut: 1 });
  }, 60_000);

  it("a product list that cannot be used is named in the report as an input not read", async () => {
    const w = fakeWorld();
    const batch = await newBatch("list-not-read");
    await folderUpload(w, batch, { "OK1_1.jpg": await jpeg() });
    const listPath = `${prefixOf(batch)}/uploads/items.csv`;
    w.put(listPath, Buffer.from("Image 1\nhttps://example.com/a.jpg\n"));
    await newUpload(batch, "product_list", "items.csv", `gs://${BUCKET}/${listPath}`);
    await ingestAll(w, batch);
    const report = await reportOf(w, batch);
    expect(report!.unsupportedFiles).toEqual([expect.objectContaining({ name: "items.csv", upload: true, reason: expect.stringContaining("could not be read") })]);
  }, 60_000);

  it("a product with uploads and a paste: a distinct photo follows the uploads, one naming a taken shot is on the record, and a bad cell too (P1-A, P2-E)", async () => {
    const w = fakeWorld();
    const batch = await newBatch("uploads-and-paste");
    await folderUpload(w, batch, { "X_1.jpg": await jpeg() });
    w.web.set(`${HOST}/front.jpg`, await jpeg());
    w.web.set(`${HOST}/X_1.jpeg`, await jpeg());
    const [paste] = await db.insert(catalogUploads).values({ batchId: batch.id, kind: "url_list", name: "paste", gcsUri: null, status: "uploaded", sourceUrl: `X\t${HOST}/front.jpg\nX\t${HOST}/X_1.jpeg\nX\thtp://bad/side.jpg\t${HOST}/none.jpg` }).returning();
    expect(paste).toBeTruthy();
    w.web.set(`${HOST}/none.jpg`, await jpeg());
    await ingestAll(w, batch);
    const report = await reportOf(w, batch);
    const reasons = report!.unsupportedFiles.map((f) => (f as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining([
      "X_1.jpeg was not used. An uploaded file has shot 1, and we kept that file.",
      'Row 3: "htp://bad/side.jpg" is not a working link, so it was not used.',
    ]));
    expect(report!.leftOutProducts).toEqual([]);
    expect((await sourcesOf(batch.id)).map((src) => src.originalName).sort()).toEqual(["X_1.jpg", "front.jpg", "none.jpg"]);
  }, 60_000);

  it("a Drive file the web step skipped reaches the report, once, through runIngest (P1-C)", async () => {
    const w = fakeWorld();
    const batch = await newBatch("drive-skipped");
    const photo = await jpeg();
    const files = [{ id: "b", name: "X_1.jpg" }, { id: "a", name: "X_1.jpg" }, { id: "c", name: "X_2.jpg" }].map((f) => ({ ...f, mimeType: "image/jpeg", size: String(photo.length) }));
    const drive = {
      files: {
        list: async () => ({ data: { files, nextPageToken: null } }),
        get: async () => ({ data: Readable.from([photo]) }),
      },
    };
    const id = await newUpload(batch, "drive_folder", "folder", null);
    const [row] = await db.update(catalogUploads).set({ sourceUrl: "https://drive.google.com/drive/folders/1xYzRootFolderId_abc" }).where(eq(catalogUploads.id, id)).returning();
    await collectDriveFolderOnWeb({ batchId: batch.id, brandSlug: batch.brandSlug, prefix: prefixOf(batch), upload: row!, options: batch.options, deps: { ...deps(w), drive } as never }, db);
    await ingestAll(w, batch);
    const reason = "X_1.jpg would be stored under the same name as another file in this Drive folder, so it was not used. Rename one and send it in a new batch.";
    const report = await reportOf(w, batch);
    expect(report!.unsupportedFiles).toEqual([expect.objectContaining({ name: "X_1.jpg", reason })]);
    const [after] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, id));
    expect((after!.detected as { rejected: { reason: string }[] }).rejected.filter((r) => r.reason === reason)).toHaveLength(1);
    expect((await batchRow(batch.id)).status).toBe("draft");
  }, 60_000);

  it("carries a Supabase folder's files under 1 KB into the ledger; a folder of only those is a product left out", async () => {
    const w = fakeWorld();
    const batch = await newBatch("under-1kb");
    const id = await folderUpload(w, batch, { "OK1_1.jpg": await jpeg() });
    const small = [{ name: "T/T_1.jpg", identifier: "T", reason: "T_1.jpg is under 1 KB, so it was treated as a placeholder, not a photo." }];
    await db.update(catalogUploads).set({ detected: { kind: "image", supabaseFolder: { url: "u", mode: "folder", small } } }).where(eq(catalogUploads.id, id));
    await ingestAll(w, batch);
    const report = await reportOf(w, batch);
    expect(report!.leftOutProducts).toMatchObject([{ identifier: "T", photos: 1, files: ["T/T_1.jpg"] }]);
    expect(report!.unsupportedFiles).toEqual([expect.objectContaining({ name: "T/T_1.jpg", identifier: "T" })]);
    expect((await batchRow(batch.id)).counts).toMatchObject({ products: 1, productsLeftOut: 1 });
  }, 60_000);
});
