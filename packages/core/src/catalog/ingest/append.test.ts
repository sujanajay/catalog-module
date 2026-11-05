// Tier 2 (PGlite; real Postgres when TEST_PG_URL is set, where the allocations below run on separate connections at
// the same time): follow-up shot numbers come from one place (M1 D30, re-review P1-A of PR #169).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../db/client";
import { createRealTestDb, createTestDb, TEST_PG_URL } from "../../db/testing";
import { catalogBatches, catalogProducts, catalogShotNumbers, catalogSourceImages, DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { allocateShots, plannedShots, shotNumbers } from "./append";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = TEST_PG_URL ? await createRealTestDb() : await createTestDb()); }, 180_000);
afterAll(async () => { await close?.(); });

async function batch(name: string, over: Partial<typeof catalogBatches.$inferInsert> = {}) {
  const [b] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "op@opptra.com", channels: ["noon"], options: { ...DEFAULT_BATCH_OPTIONS, append: true }, ...over }).returning();
  return b!;
}
/** A product whose parent batch is done and holds it for attention with shots 1-3 (not current, not live). */
async function heldProduct(key: string) {
  const parent = await batch(`${key} parent`, { status: "done", startedAt: new Date(), options: DEFAULT_BATCH_OPTIONS });
  const [p] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: key, pathKey: key, identifier: key, lockBatchId: parent.id }).returning();
  await db.insert(catalogSourceImages).values([1, 2, 3].map((n) => ({ batchId: parent.id, productId: p!.id, n, sha256: `${key}${n}`, originalName: `${n}.jpg`, rawUri: `gs://a/${key}${n}.jpg`, mime: "image/jpeg" })));
  return p!.id;
}

describe(`allocateShots on ${TEST_PG_URL ? "real Postgres" : "PGlite"}`, () => {
  it("gives follow-ups numbers after a product held for attention, never one number twice, even all at once", async () => {
    const product = await heldProduct("ALLOC1");
    const followUps = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => batch(`ALLOC1 more ${i}`)));
    const got = await Promise.all(followUps.map((f) => allocateShots(db, f.id, [{ productId: product, count: 2 }])));
    const all = got.flatMap((m) => m.get(product)!);
    expect(all.sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // A later follow-up comes after every one of them.
    const later = await batch("ALLOC1 later");
    expect((await allocateShots(db, later.id, [{ productId: product, count: 1 }])).get(product)).toEqual([16]);
  });

  it("keeps the numbers a batch holds when it groups again, and only adds the ones it is short of", async () => {
    const product = await heldProduct("ALLOC2");
    const f = await batch("ALLOC2 more");
    expect((await allocateShots(db, f.id, [{ productId: product, count: 2 }])).get(product)).toEqual([4, 5]);
    const other = await batch("ALLOC2 other");
    expect((await allocateShots(db, other.id, [{ productId: product, count: 1 }])).get(product)).toEqual([6]);
    expect((await allocateShots(db, f.id, [{ productId: product, count: 3 }])).get(product)).toEqual([4, 5, 7]);
    expect((await plannedShots(db, f.id, [{ productId: product, count: 4 }])).get(product)).toEqual([4, 5, 7, 8]);
  });

  it("refuses a second batch holding a number it already gave out (the primary key), instead of sharing it", async () => {
    const product = await heldProduct("ALLOC3");
    const f = await batch("ALLOC3 more");
    await allocateShots(db, f.id, [{ productId: product, count: 1 }]);
    const g = await batch("ALLOC3 other");
    await expect(db.insert(catalogShotNumbers).values({ productId: product, n: 4, batchId: g.id })).rejects.toThrow();
  });

  it("maps a product's distinct shots onto the numbers in order, two files of one shot keeping one number", () => {
    const items = [{ n: 2 }, { n: 1 }, { n: 2 }, { n: null }];
    const m = shotNumbers(items, [7, 8, 9]);
    expect(items.map((i) => m.get(i))).toEqual([8, 7, 8, 9]);
  });
});
