import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogProductEvents, catalogSourceImages } from "../../db/schema";
import { GenerationMismatchError } from "../../storage";
import { publishProduct, type PublishDeps } from "./publish";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

async function replacement(name: string) {
  const [oldBatch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: `${name}-old`, isTest: true, createdBy: "test@opptra.com", channels: ["noon"] }).returning();
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", channels: ["noon"] }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: name, pathKey: name, identifier: name, lockBatchId: batch!.id, lastBatchId: oldBatch!.id }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "updated" });
  const [oldSource, source] = await db.insert(catalogSourceImages).values([
    { batchId: oldBatch!.id, productId: product!.id, n: 1, sha256: "old", originalName: "old.jpg", rawUri: "gs://assets/old.jpg", mime: "image/jpeg", isCurrent: true },
    { batchId: batch!.id, productId: product!.id, n: 1, sha256: "new", originalName: "new.jpg", rawUri: "gs://assets/new.jpg", mime: "image/jpeg" },
  ]).returning();
  const objectPath = `catalog-test/anta/${name}/noon/${name}_1.jpg`;
  const common = { productId: product!.id, channel: "noon" as const, n: 1, canvasW: 800, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, bytes: 4, objectPath, publicUrl: `https://storage.googleapis.com/public/${objectPath}` };
  const [old, output] = await db.insert(catalogOutputs).values([
    { ...common, batchId: oldBatch!.id, sourceImageId: oldSource!.id, renderKey: "old", crc32c: "old-crc", generation: 20, isLive: true, status: "verified", publishedAt: new Date("2026-01-01T00:00:00Z") },
    { ...common, batchId: batch!.id, sourceImageId: source!.id, renderKey: "new", crc32c: "new-crc", stagingUri: "gs://assets/staged.jpg", status: "staged" },
  ]).returning();
  let generation = 20, race = false;
  const copy = vi.fn<PublishDeps["storage"]["stageCopyToPublic"]>(async (_uri, _path, condition) => {
    if (race) generation = 99;
    if (Number(condition.ifGenerationMatch) !== generation) throw new GenerationMismatchError(objectPath);
    return { generation: String(++generation), crc32c: "new-crc" };
  });
  const deps: PublishDeps = {
    db, now: () => new Date("2026-01-02T00:00:00Z"), sleep: async () => {},
    fetch: vi.fn(async () => new Response(null, { status: 404 })),
    storage: {
      getPublicBucketName: () => "public",
      headObject: async () => ({ exists: true, size: 4, contentType: "image/jpeg", generation: String(generation), crc32c: generation === 20 ? "old-crc" : "new-crc" }),
      stageCopyToPublic: copy, deletePublicObject: vi.fn(async () => true), setCustomTime: vi.fn(async () => {}),
    },
  };
  return { deps, batch: batch!, product: product!, old: old!, output: output!, copy, generation: () => generation, raceBeforeCopy: () => { race = true; } };
}

it("reports the landed replacement generation when both public readbacks fail without claiming verified DB state", async () => {
  const s = await replacement("unverified-copy");
  expect(await publishProduct(s.deps, s.batch.id, s.product.id)).toEqual({ outcome: "failed" });
  expect(s.copy.mock.calls.map(call => call[2])).toEqual([{ ifGenerationMatch: 20 }, { ifGenerationMatch: "21" }]);
  expect(s.generation()).toBe(22);
  expect(s.deps.fetch).toHaveBeenCalledTimes(2);
  const [pair] = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, s.batch.id));
  expect(pair).toMatchObject({ change: "failed" });
  expect(pair!.notes).toContain("noon img 1 generation 22");
  expect(pair!.notes).toContain("replaced but unverified");
  expect(pair!.notes).not.toContain("previous images retained");
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.old.id)))[0]).toMatchObject({ isLive: true, generation: 20, supersededAt: null });
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.output.id)))[0]).toMatchObject({ isLive: false, generation: null, status: "failed", reason: "Uploaded file could not be read back from the public link" });
});

it("preserves previous live records and generation when a real storage generation precondition rejects the copy", async () => {
  const s = await replacement("generation-conflict");
  s.raceBeforeCopy();
  expect(await publishProduct(s.deps, s.batch.id, s.product.id)).toEqual({ outcome: "failed" });
  expect(s.copy).toHaveBeenCalledTimes(1);
  expect(s.copy.mock.calls[0]![2]).toEqual({ ifGenerationMatch: 20 });
  expect(s.generation()).toBe(99);
  expect(s.deps.fetch).not.toHaveBeenCalled();
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.old.id)))[0]).toMatchObject({ isLive: true, generation: 20, supersededAt: null, supersededByOutputId: null });
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.output.id)))[0]).toMatchObject({ isLive: false, generation: null, status: "failed", reason: "Changed by another run. Start the batch again for this product." });
  const [pair] = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, s.batch.id));
  expect(pair!.notes).toContain("Changed by another run");
  expect(pair!.notes).not.toContain("previous images retained");
  expect(pair!.notes).toContain("No replacements were verified");
  expect(pair!.notes).not.toContain("replaced but unverified");
  expect(await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, s.batch.id))).toEqual([]);
});
