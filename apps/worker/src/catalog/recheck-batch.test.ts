import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { writeLinksXlsx } from "@catalog/core/catalog/sheet";
import { createTestDb } from "@catalog/core/db/testing";
import { recheckBatch } from "./recheck-batch";

/** Tier 2 (PGlite, fake storage, fake fetch): `catalog:recheck --batch` against recorded live rows. */
let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

const link = (n: number) => `https://storage.googleapis.com/pub/catalog-test/test_brand/ABC/noon/ABC_${n}.jpg`;
const noonJpeg = () => sharp({ create: { width: 1080, height: 1480, channels: 3, background: "#E0E0E0" } }).withDensity(72).withIccProfile("srgb").jpeg().toBuffer();

async function seed(links: string[], generations: number[]) {
  const sheet = await writeLinksXlsx({ channels: ["noon"], rows: [{ brand: "Test Brand", identifier: "ABC", optionIdStyleColor: "", opptraSkuIds: [], links: { noon: links }, status: "ok", notes: "", change: "new", changedAt: null }] });
  const updatedAt = new Date("2026-10-19T08:00:00Z");
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name: "catalog-test recheck", isTest: true, status: "done", channels: ["noon"], createdBy: "t@opptra.com", sheetXlsxUri: "gs://private/catalog-test/sheet.xlsx", counts: { ...EMPTY_BATCH_COUNTS, products: 1 }, updatedAt }).returning();
  const [p] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", identifier: "ABC", productKey: "abc", pathKey: "ABC", isTest: true }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: p!.id, change: "new" });
  const [source] = await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: p!.id, n: 1, sha256: "a", rawUri: "gs://private/one.jpg", originalName: "ABC_1.jpg", mime: "image/jpeg", width: 1200, height: 1600 }).returning();
  for (const [i, url] of links.entries()) {
    await db.insert(catalogOutputs).values({ batchId: batch!.id, productId: p!.id, sourceImageId: source!.id, channel: "noon", n: i + 1, canvasW: 1080, canvasH: 1480, scale: 1, placedX: 0, placedY: 0, renderKey: `r${i}`, objectPath: `catalog-test/test_brand/ABC/noon/ABC_${i + 1}.jpg`, publicUrl: url, isLive: true, status: "verified", generation: generations[i]! });
  }
  return { batch: batch!, store: { downloadBuffer: vi.fn(async () => ({ buf: sheet, mime: "application/octet-stream" })) }, updatedAt };
}

describe("recheckBatch (PGlite)", () => {
  it("fails a link whose x-goog-generation differs from the recorded live row and writes the two numbers", async () => {
    const { batch, store, updatedAt } = await seed([link(1), link(2)], [111, 222]);
    const body = await noonJpeg();
    const fetch = vi.fn(async () => new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg", "x-goog-generation": "111" } }));
    const r = await recheckBatch(db, batch.id, { fetch, store });
    expect(r.results.map(x => x.problem)).toEqual(["", "wrong_generation"]);
    expect(r.summary).toMatchObject({ ok: 1, total: 2, passed: false });
    const [after] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batch.id));
    expect(after!.counts).toMatchObject({ recheckOk: 1, recheckTotal: 2, products: 1 });
    expect(after!.updatedAt.getTime()).toBe(updatedAt.getTime());
  });

  it("never reports an empty sheet as OK", async () => {
    const { batch, store } = await seed([], []);
    const r = await recheckBatch(db, batch.id, { fetch: vi.fn(), store });
    expect(r.summary.passed).toBe(false);
    expect(r.summary.total).toBeGreaterThan(r.summary.ok);
    expect(r.problems.map(p => p.problem)).toContain("no_links");
  });
});
