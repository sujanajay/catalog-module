// M0-S3 acceptance (R1-build section 7, M0-F2 tests 1 and 2, M0-F3-R1, R2, R9, M10-S1a): a batch run through the worker's
// chunk, publish and finalize handlers on PGlite with an in-memory bucket and real JPEG renders. Every delivered link has
// a content version with role, source, hash, channel and a publish time, whose hash is the public object's sha256 and
// whose parent is its brand photo's version; every change event names a reason and a change type; a re-run makes no
// new version.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIXTURE_CHANNEL_RULES } from "@catalog/core/catalog/channel-rules";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChangeEvents, catalogChannelListings, catalogChunks, catalogContentVersions, catalogOptions, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { recordVersion } from "@catalog/core/graph/index";
import { sourceProducerRef } from "@catalog/core/graph/write-path";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import * as storage from "@catalog/core/storage";
import { workerCatalogDeps, type CatalogDeps } from "./deps";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { handlePublishTask } from "./publish";
import { handleFinalizeTask } from "./finalize";

let db: Db, close: () => Promise<void>;
const bucketEnv = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => {
  storage.setStorageClient(undefined);
  for (const [key, value] of Object.entries(bucketEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await close();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** A real JPEG per photo and channel, so the version's perceptual hash and the public object's sha256 are real. */
const jpegOf = (shade: number, channel: string) => sharp({ create: { width: 80, height: 100, channels: 3, background: { r: shade, g: channel === "noon" ? 200 : 40, b: 255 - shade } } }).jpeg().toBuffer();

function world() {
  const objects = new Map<string, { buf: Buffer; mime: string; generation: string; crc32c: string }>();
  let generation = 100;
  const upload = async (path: string, buf: Buffer, mime: string) => { const uri = `gs://assets/${path}`; objects.set(uri, { buf, mime, generation: String(++generation), crc32c: sha(buf).slice(0, 12) }); return uri; };
  const client = { bucket: (bucket: string) => ({ file: (path: string) => ({ uri: `gs://${bucket}/${path}`,
    copy: async (dest: { uri: string }, options: { preconditionOpts: { ifGenerationMatch: number | string } }) => {
      const obj = objects.get(`gs://${bucket}/${path}`)!, old = objects.get(dest.uri);
      if (String(options.preconditionOpts.ifGenerationMatch) !== String(old?.generation ?? 0)) throw Object.assign(new Error("Precondition failed"), { code: 412 });
      const next = { ...obj, generation: String(++generation) }; objects.set(dest.uri, next);
      return [dest, { resource: { generation: next.generation, crc32c: next.crc32c } }];
    },
    getMetadata: async () => { throw new Error("No metadata in the fake."); } }) }) };
  storage.setStorageClient(client as unknown as storage.StorageLike);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const obj = objects.get(`gs://public/${new URL(String(url)).pathname.replace(/^\/public\//, "")}`);
    return obj ? new Response(new Uint8Array(obj.buf), { headers: { "content-type": obj.mime, "content-length": String(obj.buf.length), "x-goog-generation": obj.generation } }) : new Response(null, { status: 404 });
  });
  const base = workerCatalogDeps(db, { channelRules: async () => FIXTURE_CHANNEL_RULES });
  const deps: CatalogDeps = { ...base, routes: undefined, sleep: async () => {}, fetch, now: () => new Date("2026-11-05T09:00:00Z"), log: () => {}, enqueue: vi.fn(async () => "task"),
    resolvePolicy: vi.fn<CatalogDeps["resolvePolicy"]>(async () => ({ matteModel: "fixture", qaModel: "", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" })),
    storage: { ...storage, getBucketName: () => "assets", getPublicBucketName: () => "public", uploadBuffer: upload,
      downloadBuffer: async (uri) => { const o = objects.get(uri); if (!o) throw new Error(`No object ${uri}`); return { buf: o.buf, mime: o.mime }; },
      headObject: async (uri) => { const o = objects.get(uri); return o ? { exists: true, size: o.buf.length, contentType: o.mime, generation: o.generation, crc32c: o.crc32c } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }; },
      stageCopyToPublic: storage.stageCopyToPublic, deletePublicObject: vi.fn(async (path: string) => objects.delete(`gs://public/${path}`)), setCustomTime: vi.fn(async () => {}) },
    judgeOutput: vi.fn<CatalogDeps["judgeOutput"]>(async (input) => ({ scores: { complete_product: 95, same_product: 95, edge_quality: 95, background_clean: 95, no_text_or_watermark: 95, orientation_ok: 95, product_intact: 95, placement_ok: 95, overall: 95 }, verdict: "pass", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: [] })),
    classifyProductType: vi.fn<CatalogDeps["classifyProductType"]>(async () => ({ type: "footwear", confidence: 1, costUsd: 0, calls: 0, usage: {}, flags: [] })),
    matting: { ...base.matting, health: vi.fn(async () => ({ ok: true, models: [{ id: "fixture", inputSize: 1024, target: "cpu" }], default: "fixture", versions: { cpu: null, gpu: null } })), convert: base.matting.convert.bind(base.matting) } as unknown as CatalogDeps["matting"],
    prepare: vi.fn(async (buf) => ({ width: 800, height: 800, rgb: Buffer.alloc(800 * 800 * 3, buf[3] ?? 0), alphaSource: null, background: { uniform: true, color: [255, 255, 255] as [number, number, number], stdev: 0 }, flags: [], sourceMime: "image/jpeg" })),
    matteFor: vi.fn<CatalogDeps["matteFor"]>(async () => ({ alpha: Buffer.alloc(800 * 800, 255), width: 800, height: 800, model: "fixture", ms: 12, source: "model", target: "cpu", sentLongSide: 800 })),
    renderAllChannels: vi.fn<CatalogDeps["renderAllChannels"]>(async (p, _m, channels) => Object.fromEntries(await Promise.all(channels.map(async (channel) => {
      const jpeg = await jpegOf(p.rgb[0]!, channel);
      return [channel, { jpeg, status: "ok", plan: { w: 80, h: 100, lowResolution: false, safeBox: { x: 0, y: 0, w: 80, h: 100 }, scale: 1, placedX: 0, placedY: 0, detailShot: false }, quality: 90, bytes: jpeg.length, flags: [], notes: [], attention: null, compliance: { ok: true, failures: [] } }];
    }))) as unknown as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>) };
  return { deps, objects };
}
type World = ReturnType<typeof world>;

/** A product of an option with listings on Noon (one image set for AE and SA) and Amazon AE. */
async function optionWithListings(key: string) {
  const [option] = await db.insert(catalogOptions).values({ brandSlug: "anta", optionKey: key, keySource: "master" }).returning();
  const listings = await db.insert(catalogChannelListings).values([{ optionId: option!.id, channel: "noon", market: "ae" }, { optionId: option!.id, channel: "noon", market: "sa" }, { optionId: option!.id, channel: "amazon", market: "ae" }]).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: key, pathKey: key, identifier: key, optionId: option!.id }).returning();
  return { optionId: option!.id, listings, product: product! };
}

/** One batch of `product` with photos of the given shades (shot n = index + 1). */
async function seed(w: World, name: string, product: typeof catalogProducts.$inferSelect, shades: number[], channels: ("noon" | "amazon")[] = ["noon", "amazon"]) {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", status: "matting", channels, counts: { ...EMPTY_BATCH_COUNTS, products: 1, sources: shades.length, outputs: shades.length * channels.length } }).returning();
  await db.update(catalogProducts).set({ lockBatchId: batch!.id }).where(eq(catalogProducts.id, product.id));
  const [prior] = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.productId, product.id));
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product.id, change: prior ? "updated" : "new" });
  for (const [i, shade] of shades.entries()) {
    const raw = Buffer.from([255, 216, 255, shade]);
    const rawUri = await w.deps.storage.uploadBuffer(`catalog-test/anta/${batch!.id}/raw/${product.pathKey}/${i + 1}.jpg`, raw, "image/jpeg");
    await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product.id, n: i + 1, sha256: sha(raw), originalName: `${product.pathKey}_${i + 1}.jpg`, rawUri, mime: "image/jpeg", width: 800, height: 800, bytes: raw.length });
  }
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "matte", productIds: [product.id] }).returning();
  return { batch: batch!, chunk: chunk! };
}
async function runChunks(w: World, s: Awaited<ReturnType<typeof seed>>) {
  for (let i = 0; i < 3; i++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, s.chunk.id))).httpStatus).toBe(200);
}
async function runBatch(w: World, s: Awaited<ReturnType<typeof seed>>, productId: string) {
  await runChunks(w, s);
  expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId })).outcome).toBe("published");
  expect((await handleFinalizeTask(w.deps, { batchId: s.batch.id })).outcome).toBe("done");
}
const eventsOf = (batchId: string) => db.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.batchId, batchId));
const versionCount = async () => (await db.select({ id: catalogContentVersions.id }).from(catalogContentVersions)).length;

describe("M0-S3 write path through the worker", () => {
  it("every link of a finished batch has a version with role, source, hash, channel and publish time; events carry reason and change type; a re-run makes nothing new", async () => {
    const w = world(), { product, listings, optionId } = await optionWithListings("M0S3-ACCEPT");
    const s = await seed(w, "m0s3-accept", product, [11, 22]);
    await runBatch(w, s, product.id);

    const links = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.batch.id), eq(catalogOutputs.isLive, true)));
    expect(links).toHaveLength(4);
    const versions = await db.select().from(catalogContentVersions).where(inArray(catalogContentVersions.id, links.map((o) => o.contentVersionId!)));
    const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, s.batch.id));
    const brand = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.producerRef, sourceProducerRef(product.id)));
    expect(brand.map((v) => [v.source, v.scope, v.position, v.contentHash]).sort()).toEqual(sources.map((p) => ["brand", "master", p.n, p.sha256]).sort());
    for (const o of links) {
      const v = versions.find((x) => x.id === o.contentVersionId)!;
      expect(v).toMatchObject({ scope: o.channel, component: "image", role: "unknown", position: o.n, source: "cleanup", aiGenerated: false, producer: "M3", producerRef: o.id, optionId, publicUrl: o.publicUrl, batchId: s.batch.id });
      expect(o.publishedAt).toBeInstanceOf(Date);
      // F2 test 1: the version's hash is a fresh sha256 of the public object, and its parent is its photo's version.
      expect(v.contentHash).toBe(sha(w.objects.get(`gs://public/${o.objectPath}`)!.buf));
      expect(v.assetSha256).toBe(v.contentHash);
      const photo = sources.find((p) => p.id === o.sourceImageId)!;
      expect(v.parentVersionIds).toEqual([brand.find((b) => b.contentHash === photo.sha256)!.id]);
    }

    // One links_delivered per slot of every listing: Noon AE and SA share one image set, Amazon AE has its own.
    const events = await eventsOf(s.batch.id);
    expect(events).toHaveLength(6);
    for (const e of events) {
      const o = links.find((x) => x.contentVersionId === e.toVersionId)!;
      const listing = listings.find((l) => l.id === e.listingId)!;
      expect(listing.channel).toBe(o.channel);
      expect(e).toMatchObject({ kind: "links_delivered", slot: `image:${o.n}`, fromVersionId: null, evidence: "tool_publish", evidenceRef: `catalog_outputs:${o.id}`, reasonKind: "new_content", changeTypeId: "img_background_fixed", actor: "test@opptra.com", idempotencyKey: `publish:${o.id}:${listing.id}` });
    }
    expect(new Set(events.map((e) => e.changeSetId)).size).toBe(1);
    // The nightly invariant finds nothing missing.
    expect((await runInvariants(db, vi.fn(), new Date(), { batchId: s.batch.id })).counts.output_without_version).toBe(0);

    // F2 test 2: the same batch again changes nothing: no new version, no new event.
    const before = await versionCount();
    await handlePublishTask(w.deps, { batchId: s.batch.id, productId: product.id });
    const again = await seed(w, "m0s3-accept-again", product, [11, 22]);
    await runBatch(w, again, product.id);
    expect(await versionCount()).toBe(before);
    expect(await eventsOf(again.batch.id)).toHaveLength(0);
    expect(await eventsOf(s.batch.id)).toHaveLength(6);
    const [pair] = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, again.batch.id));
    expect(pair!.change).toBe("unchanged");
  }, 240_000);

  it("a re-ordered gallery and a removed shot are logged with their versions, reasons and change types", async () => {
    const w = world(), { product } = await optionWithListings("M0S3-ORDER");
    const first = await seed(w, "m0s3-order", product, [31, 32, 33], ["noon"]);
    await runBatch(w, first, product.id);
    const old = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, first.batch.id), eq(catalogOutputs.isLive, true)));
    // Photo 2 moves to slot 1, photo 1 to slot 2, photo 3 is dropped.
    const next = await seed(w, "m0s3-order-next", product, [32, 31], ["noon"]);
    await runBatch(w, next, product.id);
    const made = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, next.batch.id));
    const events = await eventsOf(next.batch.id);
    const delivered = events.filter((e) => e.kind === "links_delivered");
    expect(delivered).toHaveLength(4);
    for (const e of delivered) {
      const o = made.find((x) => x.contentVersionId === e.toVersionId)!;
      expect(e).toMatchObject({ slot: `image:${o.n}`, fromVersionId: old.find((x) => x.n === o.n)!.contentVersionId, reasonKind: "new_content", changeTypeId: "img_reordered" });
    }
    const removed = events.filter((e) => e.kind === "removed");
    expect(removed).toHaveLength(2);
    for (const e of removed) expect(e).toMatchObject({ slot: "image:3", toVersionId: null, fromVersionId: old.find((x) => x.n === 3)!.contentVersionId, reasonKind: "new_content", changeTypeId: "img_reordered" });
  }, 240_000);

  it("M10-S1a: a crop M3 recorded for a slot is published as img_shotset_crops", async () => {
    const w = world(), { product, optionId } = await optionWithListings("M0S3-CROPS");
    const s = await seed(w, "m0s3-crops", product, [41], ["noon"]);
    await runChunks(w, s);
    const [staged] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
    const [render] = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, staged!.contentVersionId!));
    // M3-F1's crop producer records its image as a crop of the render (the pipeline makes no crops yet in R1).
    const crop = await recordVersion(db, { optionId, scope: "noon", component: "image", role: "detail", position: 1, source: "crop", aiGenerated: false, producer: "M3", producerRef: `crop:${staged!.id}`, assetSha256: render!.assetSha256, parentVersionIds: [render!.id], batchId: s.batch.id, isTest: true, createdBy: "test" });
    await db.update(catalogOutputs).set({ contentVersionId: crop.versionId }).where(eq(catalogOutputs.id, staged!.id));
    expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: product.id })).outcome).toBe("published");
    const events = await eventsOf(s.batch.id);
    expect(events.map((e) => [e.changeTypeId, e.toVersionId, e.reasonKind])).toEqual([["img_shotset_crops", crop.versionId, "new_content"], ["img_shotset_crops", crop.versionId, "new_content"]]);
  }, 240_000);

  it("an output staged before the write path shipped gets its version at publish from its staged bytes", async () => {
    const w = world(), { product } = await optionWithListings("M0S3-LEGACY");
    const s = await seed(w, "m0s3-legacy", product, [51], ["amazon"]);
    await runChunks(w, s);
    const [staged] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
    await db.update(catalogOutputs).set({ contentVersionId: null }).where(eq(catalogOutputs.id, staged!.id));
    expect((await handlePublishTask(w.deps, { batchId: s.batch.id, productId: product.id })).outcome).toBe("published");
    const [live] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, staged!.id));
    const [v] = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, live!.contentVersionId!));
    expect(v!.contentHash).toBe(sha(w.objects.get(staged!.stagingUri!)!.buf));
    expect(await eventsOf(s.batch.id)).toHaveLength(1);
  }, 240_000);

  it("a product with no option yet gets versions but no event (it has no listing)", async () => {
    const w = world();
    const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: "m0s3-nooption", pathKey: "m0s3-nooption", identifier: "m0s3-nooption" }).returning();
    const s = await seed(w, "m0s3-nooption", product!, [61], ["noon"]);
    await runBatch(w, s, product!.id);
    const [o] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
    expect(o!.contentVersionId).toBeTruthy();
    expect(await eventsOf(s.batch.id)).toHaveLength(0);
  }, 240_000);
});
