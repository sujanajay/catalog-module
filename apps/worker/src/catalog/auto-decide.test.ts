// M1-S3 (M1-F3 tests 1 and 3, in the worker pipeline): an auto-decide batch delivers links for every product with at
// least one deliverable photo, flags what a rule delivered `provisional` with its rule id, drops a planted wrong-item
// photo while the product's other photos get links, never makes a product `pending_attention`, and releases every lock
// at finalize. The same input in a batch started before M1-S3 (no options.autoDecide) still holds, as on main.
import { FIXTURE_CHANNEL_RULES } from "@catalog/core/catalog/channel-rules";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogEnlargements, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { autoDecideRecordOf, autoDecideSnapshot, DEFAULT_AUTO_DECIDE_RULES, heldForPerson } from "@catalog/core/catalog/auto-decide";
import { NO_DELIVERABLE_PHOTO } from "@catalog/core/catalog/pipeline/publish";
import { ENLARGEMENT_TOO_LARGE_WHY, PROVISIONAL_IMPROVES_SENTENCE, PROVISIONAL_SENTENCE, type ChannelId, type OutputFlag } from "@catalog/core/catalog/types";
import { workerCatalogDeps, type CatalogDeps } from "./deps";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { handlePublishTask } from "./publish";
import { handleFinalizeTask } from "./finalize";
import { recutProductPhotos } from "./recut";
import { buildReport } from "@catalog/core/catalog/pipeline/report";
import { applyDecision } from "@catalog/core/catalog/decisions";
import { listAttention } from "@catalog/core/catalog/attention";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import { enqueueFinalize } from "./deps";

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
  const base = workerCatalogDeps(db,{channelRules:async()=>FIXTURE_CHANNEL_RULES});
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
/** `auto`: the batch was started with the auto-decide rules (read from the table migration 0014 seeds, as Start does). */
async function seed(w: ReturnType<typeof world>, name: string, options: { shots: string[]; auto: boolean; channels?: ChannelId[] }) {
  const autoDecide = options.auto ? await autoDecideSnapshot(db) : undefined;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", status: "matting", channels: options.channels ?? ["noon"],
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

it("migration 0014 seeds exactly the M1-F3-R1 default rules, and Start's snapshot reads them", async () => {
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

it("review P2-2: a pipeline failure in an auto batch stays failed and counted; only rule decisions are drops", async () => {
  const w = world(), s = await seed(w, "auto-failed", { shots: ["a", "b"], auto: true });
  await stages(w, s);
  // Photo 2 failed in the pipeline (as failChunk or a stage fault leaves it), not by an auto-decide rule.
  const failure = "The matting service did not answer. Start this product again.";
  const [, second] = await outputsOf(s.batch.id);
  await db.update(catalogOutputs).set({ status: "failed", reason: failure }).where(eq(catalogOutputs.id, second!.id));
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const [one, two] = await outputsOf(s.batch.id);
  expect(one).toMatchObject({ status: "verified", isLive: true });
  expect(two).toMatchObject({ status: "failed", reason: failure, isLive: false });
  expect(two!.flags).not.toContain("auto_dropped");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(batch!.counts).toMatchObject({ verified: 1, failed: 1, skipped: 0, attentionProducts: 0 });
}, 120_000);

it("review P2-2: an auto batch whose only photo failed in the pipeline is an exception with the failure kept", async () => {
  const w = world(), s = await seed(w, "auto-all-failed", { shots: ["a"], auto: true });
  await stages(w, s);
  await db.update(catalogOutputs).set({ status: "failed", reason: "Render failed." }).where(eq(catalogOutputs.batchId, s.batch.id));
  await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id });
  expect((await outputsOf(s.batch.id)).map(o => [o.status, o.flags.includes("auto_dropped")])).toEqual([["failed", false]]);
  expect((await pairOf(s.batch.id)).change).toBe("failed");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(batch!.counts).toMatchObject({ failed: 1, skipped: 0 });
}, 120_000);

it("review P3-1: while the product's chunk is open, a publish waits even when the judge scored a photo triage has not decided yet", async () => {
  const w = world(), s = await seed(w, "auto-race", { shots: ["a"], auto: true });
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  // Judged, not yet triaged (an operator's decision on the product can trigger a publish in this gap).
  await db.update(catalogOutputs).set({ status: "needs_attention", qaScores: PASS }).where(eq(catalogOutputs.batchId, s.batch.id));
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("waiting");
  const [output] = await outputsOf(s.batch.id);
  expect(output).toMatchObject({ status: "needs_attention" });
  expect(output!.flags).not.toContain("auto_dropped");
}, 120_000);

it("review P3-2: a hold with no cause is decided by the not_publishable rule, with its rule id", async () => {
  const w = world(), s = await seed(w, "auto-no-cause", { shots: ["a"], auto: true });
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  // A render held with no problem flag (the triage gives a hold without a cause).
  await db.update(catalogOutputs).set({ status: "needs_attention", flags: [] }).where(eq(catalogOutputs.batchId, s.batch.id));
  await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id));
  const [output] = await outputsOf(s.batch.id);
  expect(autoDecideRecordOf(output!.compliance)).toEqual({ rule: "not_publishable:*", cause: "not_publishable", action: "deliver" });
  expect(output!.status).not.toBe("needs_attention");
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

// M1 D40, the owner's words of 2026-11-06: only in very exceptional cases should a person be asked. Such a photo has no link, the rest is delivered and the batch finishes.
const FLAGGED = (input: { model: string }, flags: string[]) => ({ scores: { ...PASS, no_text_or_watermark: 10, overall: 80 }, verdict: "flag" as const, reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: flags as never });
const GOOD = (input: { model: string }) => ({ scores: PASS, view: "front", verdict: "pass" as const, reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: [] });

it("D40: a visible defect the channel cannot do without is held: no link, the other photo delivered, the batch finished, the lock released", async () => {
  const w = world(), s = await seed(w, "auto-held-defect", { shots: ["a", "m"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 2 ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  await stages(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const [one, two] = await outputsOf(s.batch.id);
  expect(one).toMatchObject({ status: "verified", isLive: true });
  expect(two).toMatchObject({ status: "needs_attention", isLive: false });
  expect(autoDecideRecordOf(two!.compliance)).toEqual({ rule: "visible_defect:*", cause: "visible_defect", action: "hold" });
  expect(two!.reason).toContain("the product's other photos are delivered");
  expect(w.copy).toHaveBeenCalledTimes(1);
  expect((await pairOf(s.batch.id)).change).not.toBe("pending_attention");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  expect(await lockOf(s.product.id)).toBeNull();
}, 120_000);

it.each([
  ["a product with one photo", "auto-held-single", ["m"]],
  ["a product whose other photo is held too", "auto-held-both", ["m", "n"]],
])("D40: the hold of %s does not say the product's other photos are delivered", async (_name, slug, shots) => {
  const w = world(), s = await seed(w, slug, { shots, auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => FLAGGED(input, ["text_or_watermark"]));
  await stages(w, s);
  const rows = await outputsOf(s.batch.id);
  expect(rows).toHaveLength(shots.length);
  for (const o of rows) {
    expect(autoDecideRecordOf(o.compliance)).toMatchObject({ action: "hold" });
    expect(o.reason).toContain("It has no link yet. Replace it, use it as it is, or remove it.");
    expect(o.reason).not.toMatch(/other photos|fixture|haiku|gemini|birefnet|bria/i);
  }
}, 120_000);

it("D40: a product with every photo held has no link and still reaches a person: in the needs-you count and the list the page shows", async () => {
  const w = world(), s = await seed(w, "auto-all-held", { shots: ["m", "n"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => FLAGGED(input, ["text_or_watermark"]));
  await stages(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("failed");
  expect((await pairOf(s.batch.id)).change).toBe("failed");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(batch!.digest).toMatchObject({ needsYou: 1 });
  expect(batch!.counts.needsAttention).toBe(2);
  expect((await listAttention(db, s.batch.id, async uri => uri)).flatMap(p => p.photos).length).toBeGreaterThan(0);
}, 120_000);

it("D40: with two good photos left, the same defect is simply left out and nobody is asked", async () => {
  const w = world(), s = await seed(w, "auto-left-out", { shots: ["a", "b", "m"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 3 ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  await stages(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  expect((await outputsOf(s.batch.id)).map(o => o.status)).toEqual(["verified", "verified", "skipped"]);
}, 120_000);

it("D40: image 1 held and another photo passed: the photos change places, and the held one, with two good photos left, is left out", async () => {
  const w = world(), s = await seed(w, "auto-promoted", { shots: ["m", "b", "c"], auto: true });
  // The judge reads the photo by its raw byte: "m" carries the mark, whatever number it has.
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, s.batch.id));
  const marked = sources.find(x => x.sha256 === "m")!.id;
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 1 && (await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, marked)))[0]!.n === 1 ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  await stages(w, s);
  expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, marked)))[0]!.n).toBeGreaterThan(1);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const outputs = await outputsOf(s.batch.id);
  expect(outputs.find(o => o.sourceImageId === marked)).toMatchObject({ status: "skipped", isLive: false });
  const first = outputs.find(o => o.n === 1)!;
  expect(first).toMatchObject({ status: "verified", isLive: true });
  expect(first.sourceImageId).not.toBe(marked);
  expect(first.objectPath).toMatch(/_1\.jpg$/);
  expect((first.compliance as { auto_actions?: { step: string }[] }).auto_actions?.map(a => a.step)).toContain("photo_promoted");
}, 120_000);

it("D42: a re-cut replaces a live image at the same link, on the batch's channels; a later publisher wins; a held result takes the old image down", async () => {
  const w = world(), s = await seed(w, "auto-recut", { shots: ["a", "b"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => GOOD(input));
  await stages(w, s);
  await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id });
  await handleFinalizeTask(w.deps, { batchId: s.batch.id });
  const [, liveTwo] = await outputsOf(s.batch.id), source = liveTwo!.sourceImageId!;
  // Bad request: a product locked by another batch is left alone.
  const [other] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: "other", isTest: true, createdBy: "t@opptra.com", status: "matting", channels: ["noon"], options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null }, counts: EMPTY_BATCH_COUNTS }).returning();
  await db.update(catalogProducts).set({ lockBatchId: other!.id }).where(eq(catalogProducts.id, s.product.id));
  expect((await recutProductPhotos(w.deps, { batchId: s.batch.id, sourceImageIds: [source] })).outcome).toBe("busy");
  await db.update(catalogProducts).set({ lockBatchId: null }).where(eq(catalogProducts.id, s.product.id));

  const matteCalls = vi.mocked(w.deps.matteFor).mock.calls.length;
  expect((await recutProductPhotos(w.deps, { batchId: s.batch.id, sourceImageIds: [source] })).outcome).toBe("recutting");
  // Sent twice: the second changes nothing, and no second chunk is queued.
  const rowsAfterFirst = await outputsOf(s.batch.id);
  expect((await recutProductPhotos(w.deps, { batchId: s.batch.id, sourceImageIds: [source] })).outcome).toBe("busy");
  expect(await outputsOf(s.batch.id)).toEqual(rowsAfterFirst);
  expect(await db.select().from(catalogChunks).where(and(eq(catalogChunks.batchId, s.batch.id), eq(catalogChunks.status, "queued")))).toHaveLength(1);
  const [chunk] = await db.select().from(catalogChunks).where(and(eq(catalogChunks.batchId, s.batch.id), eq(catalogChunks.status, "queued")));
  // The defect now found on the new image holds it.
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 2 ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  for (let i = 0; i < 3; i++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunk!.id))).httpStatus).toBe(200);
  // The stored matte is not used again.
  expect(vi.mocked(w.deps.matteFor).mock.calls.length).toBeGreaterThan(matteCalls);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const [one, two] = await outputsOf(s.batch.id);
  expect(one).toMatchObject({ status: "verified", isLive: true });
  expect(two).toMatchObject({ status: "needs_attention", isLive: false });
}, 180_000);

/** Runs one product through to a finished batch. */
const finished = async (w: ReturnType<typeof world>, s: Awaited<ReturnType<typeof seed>>) => {
  await stages(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
};
/** A later batch of the same product, at the same photos by default, run to its publish. */
async function secondBatch(w: ReturnType<typeof world>, s: Awaited<ReturnType<typeof seed>>, name: string, shots: string[]) {
  const autoDecide = await autoDecideSnapshot(db);
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", status: "matting", channels: ["noon"],
    options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null, autoDecide }, counts: { ...EMPTY_BATCH_COUNTS, products: 1, sources: shots.length, outputs: shots.length } }).returning();
  await db.update(catalogProducts).set({ lockBatchId: batch!.id }).where(eq(catalogProducts.id, s.product.id));
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: s.product.id, change: "new" });
  for (const [i, sha] of shots.entries()) {
    const rawUri = await w.upload(`catalog-test/anta/${batch!.id}/raw/${name}/${i + 1}.jpg`, Buffer.from([255, 216, 255, sha.charCodeAt(0)]), "image/jpeg");
    await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: s.product.id, n: i + 1, sha256: sha, originalName: `${name}_${i + 1}.jpg`, rawUri, mime: "image/jpeg", width: 800, height: 800 });
  }
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "matte", productIds: [s.product.id] }).returning();
  return { batch: batch!, product: s.product, chunk: chunk! };
}
const liveOf = async (productId: string) => (await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true)))).sort((a, b) => a.n - b.n);

it("D40: a held photo reads as waiting, never as a failed re-check; a person's decision publishes it on the finished batch", async () => {
  const w = world(), s = await seed(w, "auto-held-decide", { shots: ["a", "m"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 2 ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  await finished(w, s);
  let [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(deriveBatchState({ status: "done", counts: batch!.counts })).toMatchObject({ state: "attention", pill: "1 photo needs you" });
  const { report } = await buildReport(db, s.batch.id, { recheck: { ok: 1, total: 1, failures: [] }, exports: {} as never });
  expect(report.summary).toMatchObject({ linksPlanned: 1, linksVerified: 1, linksHeld: 1, photosHeld: 1 });
  const [, held] = await outputsOf(s.batch.id);
  // The rule that makes this reachable: the card is on the batch page, listed although the product itself is not held.
  expect((await listAttention(db, s.batch.id, async uri => uri)).flatMap(c => c.photos.map(photo => photo.outputId))).toEqual([held!.id]);
  await applyDecision(db, { outputId: held!.id, decision: "use_as_is", actor: "op@opptra.com" });
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  expect((await outputsOf(s.batch.id))[1]).toMatchObject({ status: "verified", isLive: true });
  await enqueueFinalize(w.deps, s.batch.id, undefined, { reopen: true });
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
  [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  expect(deriveBatchState({ status: "done", counts: batch!.counts }).state).toBe("ready");
  expect(await lockOf(s.product.id)).toBeNull();
}, 180_000);

it("D40: an agreed cut-out is judged whatever the sample rate", async () => {
  const agreement = { auto_actions: [{ step: "matte_agreement", trigger: ["product_removed"], result: "passed", channels: [], rejudged: false }] };
  const run = async (name: string) => {
    const w = world(), s = await seed(w, name, { shots: ["a", "b"], auto: true });
    vi.mocked(w.deps.resolvePolicy).mockResolvedValue({ matteModel: "fixture", qaModel: "test/judge", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 0, source: "default" } as never);
    vi.mocked(w.deps.judgeOutput).mockImplementation(async input => GOOD(input));
    for (let i = 0; i < 2; i++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id))).httpStatus).toBe(200);
    const rows = await outputsOf(s.batch.id);
    await db.update(catalogOutputs).set({ compliance: { ...(rows[1]!.compliance as object), ...agreement } as never }).where(eq(catalogOutputs.id, rows[1]!.id));
    expect((await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id))).httpStatus).toBe(200);
    return { w, s };
  };
  const seen = await run("auto-agreed-sampled");
  // The product is out of the sample; its agreed photo is judged all the same.
  const judged = vi.mocked(seen.w.deps.judgeOutput).mock.calls.map(c => c[0].n);
  expect(judged).toContain(2);
  expect((await outputsOf(seen.s.batch.id))[1]!.flags).not.toContain("qa_sampled_out");
  const first = (await outputsOf(seen.s.batch.id))[0]!, firstCompliance = first.compliance as { measured?: object };
  await db.update(catalogOutputs).set({ compliance: { ...firstCompliance, measured: { ...firstCompliance.measured, floorPatch: { share: 0.02, dropped: true } } } as never }).where(eq(catalogOutputs.id, first.id));
  expect((await buildReport(db, seen.s.batch.id, { recheck: { ok: 0, total: 0, failures: [] }, exports: {} as never })).report.qa).toMatchObject({ agreedCutOuts: 1, floorPatchesDropped: 1 });
}, 180_000);

it("D42: a later batch published the product: a re-cut of the older batch is refused every time and changes nothing; the last publisher's re-cut leaves the older batch's images alone", async () => {
  const w = world(), s = await seed(w, "auto-recut-later", { shots: ["a", "b", "c"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => GOOD(input));
  await finished(w, s);
  const [, keptTwo, replacedThree] = await outputsOf(s.batch.id);
  // The later batch sends photo 1 and 2 unchanged, a new photo 3 and a new photo 4.
  const later = await secondBatch(w, s, "auto-recut-later", ["a", "b", "z", "y"]);
  await stages(w, later);
  expect((await handlePublishTask(w.deps, { batchId: later.batch.id, productId: s.product.id })).outcome).toBe("published");
  expect((await handleFinalizeTask(w.deps, { batchId: later.batch.id })).outcome).toBe("done");
  await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, s.batch.id));
  const state = async () => ({ outputs: (await db.select().from(catalogOutputs).where(eq(catalogOutputs.productId, s.product.id))).sort((x, y) => x.id.localeCompare(y.id)), sources: (await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.productId, s.product.id))).sort((x, y) => x.id.localeCompare(y.id)), chunks: (await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id))).length, product: (await db.select().from(catalogProducts).where(eq(catalogProducts.id, s.product.id)))[0]! });
  const before = await state();
  expect(before.product.lastBatchId).toBe(later.batch.id);
  expect((await liveOf(s.product.id)).map(o => [o.n, o.batchId === s.batch.id])).toEqual([[1, true], [2, true], [3, false], [4, false]]);
  // Sent again and again, for a photo the later batch kept and for one it replaced, and both at once: nothing is written.
  for (const ids of [[keptTwo!.sourceImageId!], [replacedThree!.sourceImageId!], [keptTwo!.sourceImageId!, replacedThree!.sourceImageId!], [keptTwo!.sourceImageId!]]) {
    const refused = await recutProductPhotos(w.deps, { batchId: s.batch.id, sourceImageIds: ids });
    expect(refused.outcome).toBe("superseded");
    expect(Object.values(refused.photos!)).toEqual(ids.map(() => "superseded"));
    expect(await state()).toEqual(before);
  }
  // The last publisher's own re-cut, sent twice in a row: its image is replaced, the older batch's stay, and it stays the last publisher.
  const liveBefore = await liveOf(s.product.id);
  const laterFour = (await outputsOf(later.batch.id)).find(o => o.n === 4);
  for (let round = 0; round < 2; round++) {
    const result = await recutProductPhotos(w.deps, { batchId: later.batch.id, sourceImageIds: [laterFour!.sourceImageId!] });
    expect(result.outcome).toBe("recutting");
    const [chunk] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, result.chunkId!));
    for (let i = 0; i < 3; i++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunk!.id))).httpStatus).toBe(200);
    expect((await handlePublishTask(w.deps, { batchId: later.batch.id, productId: s.product.id })).outcome).toBe("published");
    await db.update(catalogBatches).set({ status: "matting" }).where(eq(catalogBatches.id, later.batch.id));
    expect((await handleFinalizeTask(w.deps, { batchId: later.batch.id })).outcome).toBe("done");
    const after = await liveOf(s.product.id);
    expect(after.map(o => [o.n, o.batchId])).toEqual(liveBefore.map(o => [o.n, o.batchId]));
    expect(after.slice(0, 2).map(o => o.generation)).toEqual(liveBefore.slice(0, 2).map(o => o.generation));
    expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id, s.product.id)))[0]).toMatchObject({ lastBatchId: later.batch.id, lockBatchId: null });
  }
  expect(await db.select({ sha: catalogSourceImages.sha256 }).from(catalogSourceImages).where(and(eq(catalogSourceImages.productId, s.product.id), eq(catalogSourceImages.isCurrent, true), eq(catalogSourceImages.n, 3)))).toEqual([{ sha: "z" }]);
}, 300_000);

it("D42: two photos of one product share one chunk, and a person's decision is left alone", async () => {
  const w = world(), s = await seed(w, "auto-recut-two", { shots: ["a", "b", "c"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => GOOD(input));
  await finished(w, s);
  const [, two, three] = await outputsOf(s.batch.id);
  await db.update(catalogOutputs).set({ decision: "use_as_is", decidedBy: "op@opptra.com" }).where(eq(catalogOutputs.id, three!.id));
  const result = await recutProductPhotos(w.deps, { batchId: s.batch.id, sourceImageIds: [two!.sourceImageId!, three!.sourceImageId!] });
  expect(result).toMatchObject({ outcome: "recutting", outputs: 1, photos: { [two!.sourceImageId!]: "recutting", [three!.sourceImageId!]: "nothing_to_recut" } });
  const [chunk] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, result.chunkId!));
  expect(chunk!.sourceImageIds).toEqual([two!.sourceImageId]);
  expect((await outputsOf(s.batch.id))[2]).toMatchObject({ decision: "use_as_is", status: "verified" });
}, 120_000);

it("D42: a re-cut of image 1 held by the judge keeps the live image 1 until a person decides", async () => {
  const w = world(), s = await seed(w, "auto-recut-one", { shots: ["a", "b"], auto: true });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => GOOD(input));
  await finished(w, s);
  const [one] = await outputsOf(s.batch.id);
  const result = await recutProductPhotos(w.deps, { batchId: s.batch.id, sourceImageIds: [one!.sourceImageId!] });
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.n === 1 ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  for (let i = 0; i < 3; i++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, result.chunkId!))).httpStatus).toBe(200);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  const [after] = await outputsOf(s.batch.id);
  expect(after).toMatchObject({ status: "needs_attention", isLive: true, n: 1 });
  expect(w.deps.storage.deletePublicObject).not.toHaveBeenCalled();
  // "Remove" is then what takes it down.
  await applyDecision(db, { outputId: after!.id, decision: "remove", actor: "op@opptra.com" });
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome).toBe("published");
  expect((await outputsOf(s.batch.id))[0]).toMatchObject({ isLive: false });
  expect(vi.mocked(w.deps.storage.deletePublicObject).mock.calls.map(c => c[0])).toEqual([one!.objectPath]);
}, 180_000);

it("D40: a product re-sent after a promotion keeps its delivered order: image 1 and image 2 never show one photo", async () => {
  const w = world(), s = await seed(w, "auto-promoted-resend", { shots: ["m", "b"], auto: true });
  const shaOf = async (batchId: string, n: number) => (await db.select({ sha: catalogSourceImages.sha256 }).from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId, batchId), eq(catalogSourceImages.n, n))))[0]!.sha;
  // The judge names the mark on "m" (whatever number it has), read from the bytes it is shown as the original.
  vi.mocked(w.deps.judgeOutput).mockImplementation(async input => input.original[3] === "m".charCodeAt(0) ? FLAGGED(input, ["text_or_watermark"]) : GOOD(input));
  await finished(w, s);
  expect(await shaOf(s.batch.id, 1)).toBe("b");
  const live = await liveOf(s.product.id);
  expect(live.map(o => o.n)).toEqual([1]);
  // The same file again, in its own order: "m" first.
  const again = await secondBatch(w, s, "auto-promoted-resend", ["m", "b"]);
  await stages(w, again);
  expect((await handlePublishTask(w.deps, { batchId: again.batch.id, productId: s.product.id })).outcome).toBe("published");
  expect(await shaOf(again.batch.id, 1)).toBe("b");
  const after = await liveOf(s.product.id);
  expect(after.map(o => o.n)).toEqual([1]);
  const shas = await db.select({ id: catalogSourceImages.id, sha: catalogSourceImages.sha256 }).from(catalogSourceImages).where(eq(catalogSourceImages.productId, s.product.id));
  expect(after.map(o => shas.find(x => x.id === o.sourceImageId)!.sha)).toEqual(["b"]);
}, 240_000);

// R1 exit: a failed enlargement is delivered with nobody looking in an auto-decide batch, so the judge looks first (M1 D40).
describe("a failed enlargement in an auto-decide batch is judged before it is delivered", () => {
  /** The render stage flags these channels `enlargement_failed`, as render.ts does when no stored enlargement exists. */
  const failEnlargementOn = (w: ReturnType<typeof world>, channels: ChannelId[]) => {
    const plain = w.deps.renderAllChannels;
    w.deps.renderAllChannels = vi.fn<CatalogDeps["renderAllChannels"]>(async (...args) => {
      const rendered = await plain(...args);
      for (const channel of args[2]) if (channels.includes(channel)) rendered[channel] = { ...rendered[channel], flags: ["enlargement_failed" as OutputFlag] } as typeof rendered[typeof channel];
      return rendered;
    });
  };
  const judgeSays = (w: ReturnType<typeof world>, scores: Partial<typeof PASS>, flags: OutputFlag[]) => vi.mocked(w.deps.judgeOutput).mockImplementation(async input => ({ scores: { ...PASS, ...scores }, verdict: "flag", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags }));
  const named = (w: ReturnType<typeof world>) => vi.mocked(w.deps.resolvePolicy).mockImplementation(async () => ({ matteModel: "fixture", qaModel: "judge-under-test", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" }));
  const publish = async (w: ReturnType<typeof world>, s: Awaited<ReturnType<typeof seed>>) => (await handlePublishTask(w.deps, { batchId: s.batch.id, productId: s.product.id })).outcome;
  const byChannel = (outputs: Awaited<ReturnType<typeof outputsOf>>, channel: ChannelId) => outputs.find(o => o.channel === channel)!;
  const sourceOf = async (productId: string) => (await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.productId, productId)))[0]!;
  const enlargementRow = (s: Awaited<ReturnType<typeof seed>>, sourceImageId: string, route: "none" | "direct") => db.insert(catalogEnlargements).values({ batchId: s.batch.id, productId: s.product.id, sourceImageId, upscaler: "u@h", factor: 2, scale: 1.3, outW: 2, outH: 2, route, pixelHash: "p", identityHash: route, status: "failed", errorKind: route === "none" ? "no_route" : "bad_input" });

  it("every channel flagged (the French Connection shape): one real judge call on the strictest channel, and a clean one is delivered provisional, judged", async () => {
    const w = world(), s = await seed(w, "enl-all-clean", { shots: ["a"], auto: true, channels: ["styli", "amazon", "noon"] });
    named(w); failEnlargementOn(w, ["styli", "amazon", "noon"]);
    await stages(w, s);
    expect(w.deps.judgeOutput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(w.deps.judgeOutput).mock.calls[0]![0].channel).toBe("styli");
    expect(await publish(w, s)).toBe("published");
    for (const o of await outputsOf(s.batch.id)) {
      expect([o.status, o.isLive, o.qaModel]).toEqual(["verified", true, "judge-under-test"]);
      expect(o.flags).toEqual(expect.arrayContaining(["enlargement_failed", "provisional"]));
      expect(autoDecideRecordOf(o.compliance)).toEqual({ rule: "not_enlarged:*", cause: "not_enlarged", action: "deliver" });
    }
  }, 120_000);

  it("a judged visible defect is held for a person, not delivered, and its note names the defect", async () => {
    const w = world(), s = await seed(w, "enl-all-defect", { shots: ["a"], auto: true, channels: ["styli", "noon"] });
    named(w); failEnlargementOn(w, ["styli", "noon"]);
    judgeSays(w, { product_intact: 10, overall: 70 }, ["product_removed"]);
    await stages(w, s);
    await publish(w, s);
    expect(w.copy).not.toHaveBeenCalled();
    for (const o of await outputsOf(s.batch.id)) {
      expect([o.status, o.isLive]).toEqual(["needs_attention", false]);
      expect(heldForPerson(o)).toBe(true);
      expect(autoDecideRecordOf(o.compliance)).toMatchObject({ cause: "visible_defect", action: "hold" });
      expect(o.flags).not.toContain("provisional");
      expect(o.reason).not.toMatch(/enlarge/i);
    }
  }, 120_000);

  it("a judged wrong item is dropped, not delivered", async () => {
    const w = world(), s = await seed(w, "enl-all-wrong", { shots: ["a", "b", "c"], auto: true, channels: ["noon"] });
    named(w); failEnlargementOn(w, ["noon"]);
    wrongItemOnTwo(w);
    await stages(w, s);
    expect(await publish(w, s)).toBe("published");
    const [, two] = await outputsOf(s.batch.id);
    expect([two!.status, two!.isLive]).toEqual(["skipped", false]);
    expect(autoDecideRecordOf(two!.compliance)).toMatchObject({ cause: "wrong_item", action: "drop" });
  }, 120_000);

  it("only the stretched channel flagged: it takes the judged channel's verdict and gets no call of its own", async () => {
    const w = world(), s = await seed(w, "enl-mixed", { shots: ["a"], auto: true, channels: ["styli", "noon"] });
    named(w); failEnlargementOn(w, ["noon"]);
    await stages(w, s);
    expect(vi.mocked(w.deps.judgeOutput).mock.calls.map(([input]) => input.channel)).toEqual(["styli"]);
    expect(await publish(w, s)).toBe("published");
    const outputs = await outputsOf(s.batch.id), noon = byChannel(outputs, "noon");
    expect(noon.qaModel).toBe("judge-under-test");
    expect(noon.flags).toEqual(expect.arrayContaining(["enlargement_failed", "provisional"]));
    expect(byChannel(outputs, "styli").flags).not.toContain("provisional");
  }, 120_000);

  it("a defect the judged channel shows is looked at on the stretched channel too, is not re-rendered there, and is not delivered there", async () => {
    const w = world(), s = await seed(w, "enl-mixed-defect", { shots: ["a"], auto: true, channels: ["styli", "noon"] });
    named(w); failEnlargementOn(w, ["noon"]);
    judgeSays(w, { edge_quality: 10, overall: 70 }, ["halo"]);
    const repaired: ChannelId[] = [];
    await stages(w, s);
    for (const [, , channels, options] of vi.mocked(w.deps.renderAllChannels).mock.calls) if (options?.fitScale !== undefined || options?.synthesiseShadow === false) repaired.push(...channels);
    expect(vi.mocked(w.deps.judgeOutput).mock.calls.map(([input]) => input.channel).slice(0, 2).sort()).toEqual(["noon", "styli"]);
    expect(repaired).not.toContain("noon");
    await publish(w, s);
    const noon = byChannel(await outputsOf(s.batch.id), "noon");
    expect(noon.isLive).toBe(false);
    expect(noon.flags).toContain("halo");
    expect(noon.flags).not.toContain("provisional");
  }, 120_000);

  it("a product the sample rate skips is still judged when a rule would deliver a failed enlargement", async () => {
    const w = world(), s = await seed(w, "enl-sampled", { shots: ["a"], auto: true, channels: ["noon"] });
    vi.mocked(w.deps.resolvePolicy).mockImplementation(async () => ({ matteModel: "fixture", qaModel: "judge-under-test", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 0, source: "default" }));
    failEnlargementOn(w, ["noon"]);
    await stages(w, s);
    expect(w.deps.judgeOutput).toHaveBeenCalledTimes(1);
    expect((await outputsOf(s.batch.id))[0]!.flags).not.toContain("qa_sampled_out");
  }, 120_000);

  it("a size refusal says so and promises no later improvement; a failure a call can retry may promise it", async () => {
    for (const [route, why, sentence, other] of [["none", ENLARGEMENT_TOO_LARGE_WHY, PROVISIONAL_SENTENCE, PROVISIONAL_IMPROVES_SENTENCE], ["direct", "could not be enlarged", PROVISIONAL_IMPROVES_SENTENCE, ENLARGEMENT_TOO_LARGE_WHY]] as const) {
      const w = world(), s = await seed(w, `enl-words-${route}`, { shots: ["a"], auto: true, channels: ["noon"] });
      named(w); failEnlargementOn(w, ["noon"]);
      await enlargementRow(s, (await sourceOf(s.product.id)).id, route);
      await stages(w, s);
      const [o] = await outputsOf(s.batch.id);
      expect(o!.reason).toContain(why);
      expect(o!.reason).toContain(sentence);
      expect(o!.reason).not.toContain(other);
    }
  }, 120_000);

  it("before M1-S3 (no auto-decide rules) a failed enlargement still waits for a person with no judge call", async () => {
    const w = world(), s = await seed(w, "enl-held", { shots: ["a"], auto: false, channels: ["styli", "noon"] });
    named(w); failEnlargementOn(w, ["styli", "noon"]);
    await stages(w, s);
    expect(w.deps.judgeOutput).not.toHaveBeenCalled();
    expect(await publish(w, s)).toBe("held");
    expect((await pairOf(s.batch.id)).change).toBe("pending_attention");
    for (const o of await outputsOf(s.batch.id)) {
      expect([o.status, o.isLive, o.qaModel, o.qaScores]).toEqual(["needs_attention", false, null, null]);
      expect(o.flags).not.toContain("provisional");
    }
    expect(w.copy).not.toHaveBeenCalled();
  }, 120_000);

  it("before M1-S3, the sample rate still skips such a product", async () => {
    const w = world(), s = await seed(w, "enl-held-sampled", { shots: ["a"], auto: false, channels: ["noon", "styli"] });
    vi.mocked(w.deps.resolvePolicy).mockImplementation(async () => ({ matteModel: "fixture", qaModel: "judge-under-test", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 0, source: "default" }));
    failEnlargementOn(w, ["noon"]);
    await stages(w, s);
    expect(w.deps.judgeOutput).not.toHaveBeenCalled();
    const outputs = await outputsOf(s.batch.id);
    expect(byChannel(outputs, "styli").flags).toContain("qa_sampled_out");
    expect(byChannel(outputs, "noon").flags).not.toContain("qa_sampled_out");
  }, 120_000);
});
