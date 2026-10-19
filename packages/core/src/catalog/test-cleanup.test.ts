import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogSourceImages, spendDays } from "../db/schema";
import { recordCost, sumSpendForDay, utcDay } from "../spend";
import { CLEANED_UP_ERROR, cleanupTestBatches } from "./test-cleanup";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

const now = new Date("2026-10-19T12:00:00Z");
const yesterday = new Date("2026-10-18T12:00:00Z");
const deps = { deleteTestObjects: vi.fn(async () => 0), getBucketName: () => "assets", getPublicBucketName: () => "public" };

async function seed(name: string) {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: `catalog-test ${name}`, isTest: true, createdBy: "test@opptra.com", status: "done" }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: name, pathKey: name, identifier: name }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "new" });
  const [source] = await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n: 1, sha256: name, originalName: `${name}_1.jpg`, rawUri: `gs://assets/catalog-test/anta/${batch!.id}/raw/${name}/1.jpg`, mime: "image/jpeg", width: 800, height: 800 }).returning();
  await db.insert(catalogOutputs).values({ batchId: batch!.id, productId: product!.id, sourceImageId: source!.id, channel: "noon", n: 1, canvasW: 800, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, renderKey: name, objectPath: `catalog-test/anta/${name}/noon/1.jpg`, publicUrl: `https://storage.googleapis.com/public/catalog-test/anta/${name}/noon/1.jpg` });
  return { batch: batch!, product: product! };
}

it("keeps today's spend total unchanged and removes the rest of the test batches", async () => {
  const today = await seed("spent-today"), old = await seed("spent-yesterday");
  await recordCost(db, { brandSlug: "anta", batchId: today.batch.id, engine: "catalog_qa", costUsd: 0.25, day: now });
  await recordCost(db, { brandSlug: "anta", batchId: today.batch.id, engine: "catalog_compute", costUsd: 0.05, day: yesterday });
  await recordCost(db, { brandSlug: "anta", batchId: old.batch.id, engine: "catalog_qa", costUsd: 0.4, day: yesterday });
  const before = await sumSpendForDay(db, utcDay(now));
  expect(before).toBeCloseTo(0.25);

  const result = await cleanupTestBatches(db, deps, [today.batch.id, old.batch.id], now);

  expect(result.kept).toEqual([today.batch.id]);
  expect(await sumSpendForDay(db, utcDay(now))).toBeCloseTo(before);
  const ids = [today.batch.id, old.batch.id];
  expect(await db.select().from(catalogProducts).where(inArray(catalogProducts.id, [today.product.id, old.product.id]))).toHaveLength(0);
  expect(await db.select().from(catalogOutputs).where(inArray(catalogOutputs.batchId, ids))).toHaveLength(0);
  expect(await db.select().from(catalogSourceImages).where(inArray(catalogSourceImages.batchId, ids))).toHaveLength(0);
  expect(await db.select().from(catalogBatchProducts).where(inArray(catalogBatchProducts.batchId, ids))).toHaveLength(0);
  const left = await db.select().from(catalogBatches).where(inArray(catalogBatches.id, ids));
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ id: today.batch.id, status: "failed", error: CLEANED_UP_ERROR });
  expect(left[0]!.options.cleanedUp).toBe(true);
  expect(await db.select().from(spendDays).where(eq(spendDays.batchId, old.batch.id))).toHaveLength(0);

  // On a later day the kept row and its spend history go too.
  const tomorrow = new Date("2026-10-20T12:00:00Z");
  await expect(cleanupTestBatches(db, deps, [today.batch.id], tomorrow)).resolves.toEqual({ objects: 0, kept: [] });
  expect(await db.select().from(catalogBatches).where(eq(catalogBatches.id, today.batch.id))).toHaveLength(0);
}, 60_000);
