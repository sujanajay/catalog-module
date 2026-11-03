// M1-S3 (M1-F3 tests 1 and 3, in the worker pipeline): an auto-decide batch delivers links for every product with at
// least one deliverable photo, flags what a rule delivered `provisional` with its rule id, drops a planted wrong-item
// photo while the product's other photos get links, never makes a product `pending_attention`, and releases every lock
// at finalize. The same input in a batch started before M1-S3 (no options.autoDecide) still holds, as on main.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { autoDecideRecordOf, autoDecideSnapshot, DEFAULT_AUTO_DECIDE_RULES } from "@catalog/core/catalog/auto-decide";
import { NO_DELIVERABLE_PHOTO } from "@catalog/core/catalog/pipeline/publish";
import { PROVISIONAL_SENTENCE } from "@catalog/core/catalog/types";
import { workerCatalogDeps, type CatalogDeps } from "./deps";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { handlePublishTask } from "./publish";
import { handleFinalizeTask } from "./finalize";

let db: Db, close: () => Promise<void>;
const bucketEnv = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => { storage.setStorageClient(undefined); for (const [key, value] of Object.entries(bucketEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await close(); });

const PASS = { complete_product: 95, same_product: 95, edge_quality: 95, background_clean: 95, no_text_or_watermark: 95, orientation_ok: 95, product_intact: 95, placement_ok: 95, overall: 95 };
/** The same in-memory world as pipeline.test.ts: real stageCopyToPublic over a fake bucket, mocked matte, render and judge. */
function world() {
  const objects = new Map<string, { buf: Buffer; mime: string; generation: string; crc32c: string }>();
  let generation = 100;
  const upload = async (path: string, buf: Buffer, mime: string) => { const uri = `gs://assets/${path}`; objects.set(uri, { buf, mime, generation: String(++generation), crc32c: buf.toString("base64") }); return uri; };
  const client = { bucket: (bucket: string) => ({ file: (path: string) => ({ uri: `gs://${bucket}/${path}`, copy: async (dest: { uri: string }, options: { preconditionOpts: { ifGenerationMatch: number | string } }) => { const obj = objects.get(`gs://${bucket}/${path}`)!, old = objects.get(dest.uri); if (String(options.preconditionOpts.ifGenerationMatch) !== String(old?.generation ?? 0)) throw Object.assign(new Error("Precondition failed"), { code: 412 }); const next = { ...obj, generation: String(++generation) }; objects.set(dest.uri, next); return [dest, { resource: { generation: next.generation, crc32c: next.crc32c } }]; }, getMetadata: async () => { throw new Error("No metadata in the fake."); } }) }) };
  storage.setStorageClient(client as unknown as storage.StorageLike);
  const copy = vi.fn(storage.stageCopyToPublic);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => { const path = new URL(String(url)).pathname.replace(/^\/public\//, ""); const obj = objects.get(`gs://public/${path}`); return obj ? new Response(new Uint8Array(obj.buf), { headers: { "content-type": obj.mime, "content-length": String(obj.buf.length), "x-goog-generation": obj.generation } }) : new Response(null, { status: 404 }); });
  const base = workerCatalogDeps(db);
  const deps: CatalogDeps = { ...base, routes: undefined, sleep: async () => {}, fetch, now: () => new Date("2026-01-01T00:00:00Z"), log: () => {}, enqueue: vi.fn(async () => "task"),
    resolvePolicy: vi.fn<CatalogDeps["resolvePolicy"]>(async () => ({ matteModel: "fixture", qaModel: "", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" })),
    storage: { ...storage, getBucketName: () => "assets", getPublicBucketName: () => "public", uploadBuffer: upload, downloadBuffer: async uri => { const o = objects.get(uri); if (!o) throw new Error(`No object ${uri}`); return { buf: o.buf, mime: o.mime }; }, headObject: async uri => { const o = objects.get(uri); return o ? { exists: true, size: o.buf.length, contentType: o.mime, generation: o.generation, crc32c: o.crc32c } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }; }, stageCopyToPublic: copy, deletePublicObject: vi.fn(async () => true), setCustomTime: vi.fn(async () => {}) },
    judgeOutput: vi.fn<CatalogDeps["judgeOutput"]>(async input => ({ scores: PASS, verdict: "pass", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: [] })),
    classifyProductType: vi.fn<CatalogDeps["classifyProductType"]>(async () => ({ type: "footwear", confidence: 1, costUsd: 0, calls: 0, usage: {}, flags: [] })),
    matting: { ...base.matting, health: vi.fn(async () => ({ ok: true, models: [{ id: "fixture", inputSize: 1024, target: "cpu" }], default: "fixture", versions: { cpu: null, gpu: null } })), convert: base.matting.convert.bind(base.matting) } as unknown as CatalogDeps["matting"],
    prepare: vi.fn(async (buf) => ({ width: 800, height: 800, rgb: Buffer.alloc(800 * 800 * 3, buf[3] ?? 0), alphaSource: null, background: { uniform: true, color: [255, 255, 255] as [number, number, number], stdev: 0 }, flags: [], sourceMime: "image/jpeg" })),
    matteFor: vi.fn<CatalogDeps["matteFor"]>(async () => ({ alpha: Buffer.alloc(800 * 800, 255), width: 800, height: 800, model: "fixture", ms: 12, source: "model", target: "cpu", sentLongSide: 800 })),
    renderAllChannels: vi.fn<CatalogDeps["renderAllChannels"]>(async (_p, _m, channels) => Object.fromEntries(channels.map(channel => [channel, { jpeg: Buffer.from([255, 216, 255, _p.rgb[0]!]), status: "ok", plan: { w: 800, h: 1000, lowResolution: false, safeBox: { x: 0, y: 0, w: 800, h: 1000 }, scale: 1, placedX: 0, placedY: 0, detailShot: false }, quality: 90, bytes: 4, flags: [], notes: [], attention: null, compliance: { ok: true, failures: [] } }])) as unknown as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>) };
  return { deps, copy, upload };
}
/** `auto`: the batch was started with the auto-decide rules (read from the table migration 0013 seeds, as Start does). */
async function seed(w: ReturnType<typeof world>, name: string, options: { shots: string[]; auto: boolean }) {
  const autoDecide = options.auto ? await autoDecideSnapshot(db) : undefined;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", status: "matting", channels: ["noon"],
    options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null, ...(autoDecide ? { autoDecide } : {}) },
    counts: { ...EMPTY_BATCH_COUNTS, products: 1, sources: options.shots.length, outputs: options.shots.length } }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: name, pathKey: name, identifier: name, lockBatchId: batch!.id }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "new" });
  for (const [i, sha] of options.shots.entries()) {
    const rawUri = await w.upload(`catalog-test/anta/${batch!.id}/raw/${name}/${i + 1}.jpg`, Buffer.from([255, 216, 255, sha.charCodeAt(0)]), "image/jpeg");
    await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n: i + 1, sha256: sha, originalName: `${name}_${i + 1}.jpg`, rawUri, mime: "image/jpeg", width: 800, height: 800 });
  }
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "matte", productIds: [product!.id] }).returning();
  return { batch: batch!, product: product!, chunk: chunk! };
}
const stages = async (w: ReturnType<typeof world>, s: Awaited<ReturnType<typeof seed>>) => { for (let i = 0; i < 3; i++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id))).httpStatus).toBe(200); };
const outputsOf = async (batchId: string) => (await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId))).sort((a, b) => a.n - b.n);
const pairOf = async (batchId: string) => (await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId)))[0]!;
const lockOf = async (productId: string) => (await db.select().from(catalogProducts).where(eq(catalogProducts.id, productId)))[0]!.lockBatchId;
/** Photo 2 (raw byte "w") is judged a different product. */
const wrongItemOnTwo = (w: ReturnType<typeof world>) => vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 2
  ? { scores: { ...PASS, same_product: 10, overall: 80 }, verdict: "flag", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: ["different_product"] }
  : { scores: PASS, verdict: "pass", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: [] });

it("migration 0013 seeds exactly the M1-F3-R1 default rules, and Start's snapshot reads them", async () => {
  const snapshot = await autoDecideSnapshot(db);
  expect([...snapshot.rules].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...DEFAULT_AUTO_DECIDE_RULES].sort((a, b) => a.id.localeCompare(b.id)));
}, 60_000);

it("F3 test 3: a planted wrong-item photo is dropped with its rule id and the product's other photos get links; nothing is held", async () => {
  const w = world(), s = await seed(w, "auto-wrong-item", { shots: ["a", "w", "c"], auto: true });
  wrongItemOnTwo(w);
  await stages(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const [one, two, three] = await outputsOf(s.batch.id);
  expect(two).toMatchObject({ status: "skipped", isLive: false });
  expect(two!.flags).toEqual(expect.arrayContaining(["different_product", "auto_dropped"]));
  expect(autoDecideRecordOf(two!.compliance)).toEqual({ rule: "wrong_item:*", cause: "wrong_item", action: "drop" });
  expect([one!.status, three!.status]).toEqual(["verified", "verified"]);
  expect([one!.isLive, three!.isLive]).toEqual([true, true]);
  expect(w.copy).toHaveBeenCalledTimes(2);
  expect((await pairOf(s.batch.id)).change).toBe("new");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(batch!.counts).toMatchObject({ attentionProducts: 0, needsAttention: 0, verified: 2 });
  expect(await lockOf(s.product.id)).toBeNull();
}, 120_000);

it("before M1-S3 (no auto-decide rules on the batch) the same wrong-item photo still holds the whole product", async () => {
  const w = world(), s = await seed(w, "held-wrong-item", { shots: ["a", "w", "c"], auto: false });
  wrongItemOnTwo(w);
  await stages(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("held");
  expect((await pairOf(s.batch.id)).change).toBe("pending_attention");
  expect(w.copy).not.toHaveBeenCalled();
}, 120_000);

it("F3 test 1: with the judge capped, every output is delivered provisional with its rule id; 0 pending_attention, 0 waiting, every lock released", async () => {
  const w = world(), s = await seed(w, "auto-capped", { shots: ["a", "b"], auto: true });
  for (let i = 0; i < 2; i++) await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  vi.stubEnv("DAILY_SPEND_CAP_USD", "0");
  try { expect((await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id))).httpStatus).toBe(200); } finally { vi.unstubAllEnvs(); }
  expect(w.deps.judgeOutput).not.toHaveBeenCalled();
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const outputs = await outputsOf(s.batch.id);
  expect(outputs.map(o => [o.status, o.isLive])).toEqual([["verified", true], ["verified", true]]);
  for (const o of outputs) {
    expect(o.flags).toEqual(expect.arrayContaining(["qa_cap", "provisional"]));
    expect(autoDecideRecordOf(o.compliance)).toEqual({ rule: "unchecked:*", cause: "unchecked", action: "deliver" });
    expect(o.reason).toContain(PROVISIONAL_SENTENCE);
  }
  expect((await pairOf(s.batch.id)).change).toBe("new");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(batch!.counts).toMatchObject({ attentionProducts: 0, needsAttention: 0, verified: 2, provisional: 2 });
  expect(await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.batch.id), eq(catalogOutputs.status, "needs_attention")))).toHaveLength(0);
  expect(await lockOf(s.product.id)).toBeNull();
}, 120_000);

it("F3-R7: a product whose chunk stopped before its photos were made is an exception, never held; while the chunk is open its publish waits", async () => {
  const w = world(), s = await seed(w, "auto-stopped", { shots: ["a"], auto: true });
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  // Rendered but not judged yet: a publish now (an early delivery) waits and writes nothing.
  expect((await outputsOf(s.batch.id)).map(o => [o.status, o.qaScores])).toEqual([["staged", null]]);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("waiting");
  expect((await pairOf(s.batch.id)).change).toBe("new");
  // The chunk then stops for good: the unjudged image is dropped with its reason, never published unseen.
  await db.update(catalogChunks).set({ status: "failed" }).where(eq(catalogChunks.id, s.chunk.id));
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("failed");
  expect(w.copy).not.toHaveBeenCalled();
  const [output] = await outputsOf(s.batch.id);
  expect(output).toMatchObject({ status: "skipped", isLive: false });
  expect(output!.flags).toContain("auto_dropped");
  const pair = await pairOf(s.batch.id);
  expect(pair.change).toBe("failed");
  expect(pair.notes).toContain(NO_DELIVERABLE_PHOTO);
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  expect(await lockOf(s.product.id)).toBeNull();
}, 120_000);

it("F3-R2: a product whose only photo is a different item is an exception (failed with a reason), never held; the batch finishes", async () => {
  const w = world(), s = await seed(w, "auto-nothing", { shots: ["w"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => ({ scores: { ...PASS, same_product: 10, overall: 80 }, verdict: "flag", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: ["different_product"] }));
  await stages(w, s);
  await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id });
  const pair = await pairOf(s.batch.id);
  expect(pair.change).toBe("failed");
  expect(pair.notes).toContain(NO_DELIVERABLE_PHOTO);
  expect(w.copy).not.toHaveBeenCalled();
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  expect(await lockOf(s.product.id)).toBeNull();
}, 120_000);
