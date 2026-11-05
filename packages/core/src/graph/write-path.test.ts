// Tier 2 (PGlite), M0-S3 write path: the perceptual hash, brand photo versions from ingest, output versions with their
// parent, and the reason and change type a publish names for each slot.
import { eq, like } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogAssets, catalogBatches, catalogContentVersions, catalogOptions, catalogProducts } from "../db/schema";
import { createTestDb } from "../db/testing";
import { phashFromDb, sha256Hex } from "./index";
import {
  dhash64, ensureSourceVersion, imageAsset, outputVersionSource, phashDistance, publishChangeSetId, publishChangeType, publishReason,
  recordOutputVersion, recordSourcePhotoVersions, sourceProducerRefsOf, type PublishedSlot, type SourcePhoto,
} from "./write-path";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => { await close?.(); });

/** A 64x64 JPEG: a left-to-right gradient, or its mirror. */
async function gradient(mirror = false, quality = 90, size = 64): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.fill(Math.round(((mirror ? size - 1 - x : x) / (size - 1)) * 255), (y * size + x) * 3, (y * size + x) * 3 + 3);
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality }).toBuffer();
}

let seq = 0;
async function fixture() {
  seq += 1;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test", name: `wp${seq}`, isTest: true, createdBy: "t@opptra.com", channels: ["noon"] }).returning();
  const [option] = await db.insert(catalogOptions).values({ brandSlug: "test_brand", optionKey: `wp-opt-${seq}`, keySource: "master" }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: `wp${seq}`, pathKey: `wp${seq}`, identifier: `wp${seq}`, optionId: option!.id }).returning();
  return { batch: batch!, optionId: option!.id, product: product! };
}
const photo = (productId: string, batchId: string, label: string, n = 1): SourcePhoto => ({
  productId, batchId, n, sha256: sha256Hex(new TextEncoder().encode(label)), rawUri: `gs://assets/raw/${label}.jpg`, mime: "image/jpeg", width: 800, height: 1000, bytes: 1234,
});

describe("M0-S3 perceptual hash (F2-R7)", () => {
  it("a re-compressed or resized copy stays within 6 bits; a different image is far", async () => {
    const a = await dhash64(await gradient(false, 90));
    expect(phashDistance(a, await dhash64(await gradient(false, 40)))).toBeLessThanOrEqual(6);
    expect(phashDistance(a, await dhash64(await gradient(false, 90, 200)))).toBeLessThanOrEqual(6);
    expect(phashDistance(a, await dhash64(await gradient(true)))).toBeGreaterThan(32);
    expect(phashDistance(0n, (1n << 64n) - 1n)).toBe(64);
  });

  it("imageAsset hashes the bytes it is given and reads their size; undecodable bytes keep a null perceptual hash", async () => {
    const jpeg = await gradient();
    const asset = await imageAsset(jpeg, "gs://assets/s.jpg", "image/jpeg");
    expect(asset).toMatchObject({ sha256: sha256Hex(jpeg), bytes: jpeg.length, width: 64, height: 64, uri: "gs://assets/s.jpg" });
    expect(typeof asset.phash).toBe("bigint");
    const broken = await imageAsset(Buffer.from([255, 216, 255, 1]), "gs://assets/x.jpg", "image/jpeg");
    expect(broken).toMatchObject({ sha256: sha256Hex(Buffer.from([255, 216, 255, 1])), phash: null, bytes: 4 });
  });

  it("bytes that are not a whole image never reach the decoder (sharp crashed a Windows process after a few hundred truncated JPEGs)", async () => {
    const jpeg = await gradient();
    const cut = jpeg.subarray(0, jpeg.length - 200);
    expect((await imageAsset(cut, "gs://assets/cut.jpg", "image/jpeg")).phash).toBeNull();
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#808080" } }).png().toBuffer();
    expect(typeof (await imageAsset(png, "gs://assets/p.png", "image/png")).phash).toBe("bigint");
    expect((await imageAsset(png.subarray(0, png.length - 12), "gs://assets/p.png", "image/png")).phash).toBeNull();
    const webp = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#808080" } }).webp().toBuffer();
    expect(typeof (await imageAsset(webp, "gs://assets/w.webp", "image/webp")).phash).toBe("bigint");
    for (let r = 0; r < 2000; r += 50) {
      const assets = await Promise.all(Array.from({ length: 50 }, (_, i) => imageAsset(Buffer.from([255, 216, 255, (r + i) % 251]), "gs://assets/x.jpg", "image/jpeg")));
      expect(assets.every((a) => a.phash === null)).toBe(true);
    }
  });
});

describe("M0-S3 brand photo versions (F2-R1)", () => {
  it("ingest records each accepted photo once as an asset and a brand version; a second run creates nothing; a non-sha row is left out", async () => {
    const f = await fixture();
    const photos = [photo(f.product.id, f.batch.id, "front", 1), photo(f.product.id, f.batch.id, "back", 2)].map((p) => ({ ...p, optionId: f.optionId, isTest: true }));
    expect(await recordSourcePhotoVersions(db, [...photos, { ...photos[0]!, sha256: "not-a-sha", n: 3 }])).toBe(2);
    expect(await recordSourcePhotoVersions(db, photos)).toBe(0);
    const rows = await db.select().from(catalogContentVersions).where(like(catalogContentVersions.producerRef, sourceProducerRefsOf(f.product.id)));
    expect(rows.map((r) => [r.position, r.source, r.scope, r.role, r.component, r.aiGenerated, r.producer, r.optionId, r.contentHash === r.assetSha256]).sort()).toEqual([
      [1, "brand", "master", "main", "image", false, "M1", f.optionId, true],
      [2, "brand", "master", "additional", "image", false, "M1", f.optionId, true],
    ]);
    const [asset] = await db.select().from(catalogAssets).where(eq(catalogAssets.sha256, photos[0]!.sha256));
    expect(asset).toMatchObject({ uri: photos[0]!.rawUri, width: 800, height: 1000, bytes: 1234 });
    // The render finds the same version (a replaced photo, never seen by ingest, gets its own).
    const again = await ensureSourceVersion(db, photos[0]!, { optionId: f.optionId, isTest: true });
    expect(again).toBe(rows.find((r) => r.position === 1)!.id);
    expect(await ensureSourceVersion(db, { ...photos[0]!, sha256: "not-a-sha" }, { optionId: f.optionId, isTest: true })).toBeNull();
  });

  it("review P3 of #184: the same photo sent again in the same position reuses its version; in another position it is a new version with that slot's role", async () => {
    const f = await fixture();
    const first = { ...photo(f.product.id, f.batch.id, "moved", 2), optionId: f.optionId, isTest: true };
    expect(await recordSourcePhotoVersions(db, [first])).toBe(1);
    expect(await recordSourcePhotoVersions(db, [first])).toBe(0);
    expect(await recordSourcePhotoVersions(db, [{ ...first, n: 1 }])).toBe(1);
    const rows = await db.select().from(catalogContentVersions).where(like(catalogContentVersions.producerRef, sourceProducerRefsOf(f.product.id)));
    expect(rows.map((r) => [r.position, r.role, r.contentHash === first.sha256]).sort()).toEqual([[1, "main", true], [2, "additional", true]]);
  });

  it("the same photo for two products is one asset and two versions", async () => {
    const a = await fixture(), b = await fixture();
    const pa = { ...photo(a.product.id, a.batch.id, "shared"), optionId: a.optionId, isTest: true };
    const pb = { ...photo(b.product.id, b.batch.id, "shared"), optionId: b.optionId, isTest: true };
    expect(await recordSourcePhotoVersions(db, [pa, pb])).toBe(2);
    expect(await db.select().from(catalogAssets).where(eq(catalogAssets.sha256, pa.sha256))).toHaveLength(1);
  });
});

describe("M0-S3 output versions (F2-R2 to R4, R6)", () => {
  it("records the staged bytes as a channel version with its photo's version as parent; the same bytes again return the same id", async () => {
    const f = await fixture();
    const source = photo(f.product.id, f.batch.id, "out-src");
    const jpeg = await gradient();
    const asset = await imageAsset(jpeg, "gs://assets/staging/noon/1.jpg", "image/jpeg");
    const output = { id: "9b6f3f9e-0000-4000-8000-000000000001", channel: "noon" as const, n: 1, publicUrl: "https://storage.googleapis.com/public/x/noon/1.jpg", flags: ["upscaled"] };
    const input = { output, source, product: { optionId: f.optionId }, batch: { id: f.batch.id, isTest: true, settingsSnapshotId: null }, asset };
    const id = await recordOutputVersion(db, input);
    expect(await recordOutputVersion(db, input)).toBe(id);
    const [v] = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, id));
    const parent = await ensureSourceVersion(db, source, { optionId: f.optionId, isTest: true });
    expect(v).toMatchObject({ scope: "noon", component: "image", role: "main", position: 1, source: "upscaled", aiGenerated: false, producer: "M3", producerRef: output.id,
      assetSha256: sha256Hex(jpeg), contentHash: sha256Hex(jpeg), parentVersionIds: [parent], publicUrl: output.publicUrl, batchId: f.batch.id, isTest: true, optionId: f.optionId });
    const [a] = await db.select().from(catalogAssets).where(eq(catalogAssets.sha256, sha256Hex(jpeg)));
    expect(phashFromDb(a!.phash!)).toBe(asset.phash);
    expect(outputVersionSource([])).toBe("cleanup");
  });
});

describe("M0-S3 publish reason and change type (F3-R9)", () => {
  const slot = (s: Partial<PublishedSlot> = {}): PublishedSlot => ({ versionSource: "cleanup", n: 2, sourceSha256: "a", previousSourceSha256: null, movedFromOtherSlot: false, flags: [], decision: null, ...s });
  it("names the M10 v0 type of each delivered slot", () => {
    expect(publishChangeType(slot({ versionSource: "crop" }))).toBe("img_shotset_crops");
    expect(publishChangeType(slot({ versionSource: "generated" }))).toBe("img_shotset_generated");
    expect(publishChangeType(slot({ movedFromOtherSlot: true, previousSourceSha256: "b" }))).toBe("img_reordered");
    expect(publishChangeType(slot({ n: 1, previousSourceSha256: "b" }))).toBe("img_main_replaced");
    expect(publishChangeType(slot({ n: 1, previousSourceSha256: "a", versionSource: "upscaled" }))).toBe("img_upscaled");
    expect(publishChangeType(slot({ n: 1 }))).toBe("img_background_fixed");
    expect(publishChangeType(slot({ previousSourceSha256: "a" }))).toBe("img_background_fixed");
  });
  it("says why: an auto-decide pick, the operator, a re-render of the same photo under the channel rules, or new content", () => {
    expect(publishReason(slot({ flags: ["provisional"] }), "10+c2")).toEqual({ reasonKind: "auto_decide", reasonRef: null });
    expect(publishReason(slot({ decision: "use_as_is" }), "10+c2")).toEqual({ reasonKind: "operator", reasonRef: null });
    expect(publishReason(slot({ previousSourceSha256: "a" }), "10+c2")).toEqual({ reasonKind: "rule", reasonRef: "channel-rules:10+c2" });
    expect(publishReason(slot({ previousSourceSha256: "b" }), "10+c2")).toEqual({ reasonKind: "new_content", reasonRef: null });
  });
  it("one product's publish in one batch is one stable change set", () => {
    const id = publishChangeSetId("b1", "p1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publishChangeSetId("b1", "p1")).toBe(id);
    expect(publishChangeSetId("b1", "p2")).not.toBe(id);
  });
});
