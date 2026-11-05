// The catalog-load driver's Start (load-start.ts) pins options.enlargement exactly as the web's Start does
// (startedBatchOptions). The 2026-10-30 200-product load made no enlargement because the driver left it out.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS } from "@catalog/core/db/schema";
import { enlargementOptionFromEnv } from "@catalog/core/catalog/pipeline/enlargement";
import { changeSetting, loadSettingsSnapshot } from "@catalog/core/settings/store";
import { settingFrom } from "@catalog/core/settings/snapshot";
import { DEFAULT_OWNERS, UPSCALE_MIN_SCALE_KEY } from "@catalog/core/settings/registry";
import { autoDecideOf, autoDecideSnapshot } from "@catalog/core/catalog/auto-decide";
import { seedTaxonomy } from "@catalog/core/analyze/taxonomy-seed";
import { seedChannelRules } from "@catalog/core/catalog/rules/seed";
import { publishChannelChange } from "@catalog/core/catalog/channel-rules-testing";
import { startLoadBatch } from "./load-start";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); });
afterAll(async () => { await close(); });

async function draftBatch(name: string) {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name, isTest: true, createdBy: "t@opptra.com", status: "draft", productType: "footwear", channels: ["noon", "amazon"] }).returning();
  for (let p = 0; p < 2; p++) {
    const key = `${name}-${p}`;
    const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: key, pathKey: key, identifier: key, productType: "footwear" }).returning();
    await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "new" });
    for (let n = 1; n <= 2; n++) await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n, sha256: `${key}-${n}`, originalName: `${key}_${n}.jpg`, rawUri: `gs://assets/catalog-test/test_brand/${batch!.id}/raw/${key}/${n}.jpg`, mime: "image/jpeg", width: 800, height: 800 });
  }
  return batch!;
}
const read = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;

describe("catalog-load Start", () => {
  it("pins the enlargement route the web's Start pins when the upscaler is on", async () => {
    const env = { UPSCALE_MODEL: "swinir-x2", UPSCALE_MODEL_X4: "swinir-x4" } as NodeJS.ProcessEnv;
    const batch = await draftBatch("load-on");
    const enqueue = vi.fn(async () => "task");
    const started = await startLoadBatch(db, batch.id, { enqueue: enqueue as never, env });
    const after = await read(batch.id);
    expect(after.status).toBe("matting");
    expect(after.options.enlargement).toEqual(enlargementOptionFromEnv(env));
    expect(after.options.enlargement).toMatchObject({ model: "swinir-x2", x4Model: "swinir-x4" });
    // The other options stay as they were.
    expect(after.options.identifierMode).toBe(DEFAULT_BATCH_OPTIONS.identifierMode);
    expect(after.counts).toMatchObject({ products: 2, sources: 4, outputs: 8 });
    expect(started).toEqual({ chunks: (await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, batch.id))).length, sources: 4 });
    expect(enqueue).toHaveBeenCalled();
  });

  it("copies the auto-decide rules into the batch as the web's Start does (M1-S3), so a load batch never waits for a person", async () => {
    const batch = await draftBatch("load-auto");
    await startLoadBatch(db, batch.id, { enqueue: (async () => "task") as never, env: {} as NodeJS.ProcessEnv });
    const options = (await read(batch.id)).options;
    expect(autoDecideOf(options)).toEqual(await autoDecideSnapshot(db));
    expect(options.autoDecide!.rules.length).toBeGreaterThan(0);
  });

  it("leaves enlargement out when the upscaler is off (the rollback switch), as the web's Start does", async () => {
    const batch = await draftBatch("load-off");
    await startLoadBatch(db, batch.id, { enqueue: (async () => "task") as never, env: { UPSCALE_MODEL: "off" } as NodeJS.ProcessEnv });
    expect((await read(batch.id)).options.enlargement).toBeUndefined();
  });

  it("M12-S1: a setting changed mid-batch does not affect that batch; the next batch uses it", async () => {
    const env = { UPSCALE_MODEL: "swinir-x2", UPSCALE_MIN_SCALE: "1.2" } as NodeJS.ProcessEnv;
    const enqueue = (async () => "task") as never;
    const a = await draftBatch("settings-a");
    await startLoadBatch(db, a.id, { enqueue, env });
    const runningA = await read(a.id);
    // The settings store, not UPSCALE_MIN_SCALE, decides the threshold (registry default 1).
    expect(runningA.options.enlargement?.minScale).toBe(1);
    expect(runningA.settingsSnapshotId).toBeTruthy();

    await changeSetting(db, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5, reason: "Test." }, DEFAULT_OWNERS[0]!);

    const afterA = await read(a.id);
    expect(afterA.options.enlargement?.minScale).toBe(1);
    expect(afterA.settingsSnapshotId).toBe(runningA.settingsSnapshotId);
    expect(settingFrom((await loadSettingsSnapshot(db, afterA.settingsSnapshotId!))!, UPSCALE_MIN_SCALE_KEY)).toBe(1);

    const b = await draftBatch("settings-b");
    await startLoadBatch(db, b.id, { enqueue, env });
    const runningB = await read(b.id);
    expect(runningB.options.enlargement?.minScale).toBe(1.5);
    expect(runningB.settingsSnapshotId).not.toBe(runningA.settingsSnapshotId);
    const snapB = (await loadSettingsSnapshot(db, runningB.settingsSnapshotId!))!;
    expect(settingFrom(snapB, UPSCALE_MIN_SCALE_KEY)).toBe(1.5);
    expect(snapB.versions.map((v) => v.key)).toEqual([UPSCALE_MIN_SCALE_KEY]);
  });

  // Last in the file: once rules are published, a Start without a storage fake would reach for the real bucket.
  it("M5-S3: pins the ruleset version as the web's Start does; a publish mid-batch reaches only the next batch", async () => {
    const files = new Map<string, Buffer>(), enqueue = (async () => "task") as never, env = {} as NodeJS.ProcessEnv;
    const fake = { getBucketName: () => "assets", headObject: async (uri: string) => ({ exists: files.has(uri) }), uploadBuffer: async (path: string, buf: Buffer) => { files.set(`gs://assets/${path}`, buf); return `gs://assets/${path}`; } } as never;
    await seedTaxonomy(db);
    await seedChannelRules(db);
    const a = await draftBatch("rules-a");
    await startLoadBatch(db, a.id, { enqueue, env, storage: fake });
    expect((await read(a.id)).rulesetVersion).toBe(2);
    expect([...files.keys()]).toEqual(["gs://assets/rules/snapshots/v2.json"]);
    const published = await publishChannelChange(db, "noon", { background: "#F5F5F5" });
    expect((await read(a.id)).rulesetVersion).toBe(2);
    const b = await draftBatch("rules-b");
    await startLoadBatch(db, b.id, { enqueue, env, storage: fake });
    expect((await read(b.id)).rulesetVersion).toBe(published);
  }, 180_000);
});
