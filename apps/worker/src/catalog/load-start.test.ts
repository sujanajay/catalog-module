// The catalog-load driver's Start (load-start.ts) pins options.enlargement exactly as the web's Start does
// (startedBatchOptions). The 2026-10-30 200-product load made no enlargement because the driver left it out.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS } from "@catalog/core/db/schema";
import { enlargementOptionFromEnv } from "@catalog/core/catalog/pipeline/enlargement";
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

  it("leaves enlargement out when the upscaler is off (the rollback switch), as the web's Start does", async () => {
    const batch = await draftBatch("load-off");
    await startLoadBatch(db, batch.id, { enqueue: (async () => "task") as never, env: { UPSCALE_MODEL: "off" } as NodeJS.ProcessEnv });
    expect((await read(batch.id)).options.enlargement).toBeUndefined();
  });
});
