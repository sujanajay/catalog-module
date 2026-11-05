// Tier 2 (PGlite): a follow-up batch's publish only adds photos (M1 D30, review P1-2 of PR #169).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { FIXTURE_CHANNEL_RULES } from "../channel-rules";
import { APPEND_TAKEN_NOTE, assertOwnedByBatch, NOT_OWN_OBJECT, overLimitNote, planPublish, publishProduct, type Output, type PublishDeps } from "./publish";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

/** A product the parent published with shots 1-3 on Noon, and a follow-up batch (append) holding it with `shots`. */
async function followUp(name: string, shots: number[]) {
  const [parent] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", channels: ["noon"], status: "done" }).returning();
  const [more] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: `${name} (more photos)`, isTest: true, createdBy: "test@opptra.com", channels: ["noon"], status: "publishing", parentBatchId: parent!.id, options: { ...DEFAULT_BATCH_OPTIONS, autoStart: true, append: true } }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: name, pathKey: name, identifier: name, lockBatchId: more!.id, lastBatchId: parent!.id }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: more!.id, productId: product!.id, change: "updated" });
  const path = (n: number) => `catalog-test/anta/${name}/noon/${name}_${n}.jpg`;
  const common = (n: number) => ({ productId: product!.id, channel: "noon" as const, n, canvasW: 800, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, bytes: 4, objectPath: path(n), publicUrl: `https://storage.googleapis.com/public/${path(n)}` });
  const parentSources = await db.insert(catalogSourceImages).values([1, 2, 3].map((n) => ({ batchId: parent!.id, productId: product!.id, n, sha256: `p${n}`, originalName: `${n}.jpg`, rawUri: `gs://assets/p${n}.jpg`, mime: "image/jpeg", isCurrent: true }))).returning();
  await db.insert(catalogOutputs).values(parentSources.map((s) => ({ ...common(s.n), batchId: parent!.id, sourceImageId: s.id, renderKey: `p${s.n}`, crc32c: "p", generation: 20, isLive: true, status: "verified" as const, publishedAt: new Date("2026-01-01T00:00:00Z") })));
  const sources = await db.insert(catalogSourceImages).values(shots.map((n) => ({ batchId: more!.id, productId: product!.id, n, sha256: `f${n}`, originalName: `more-${n}.jpg`, rawUri: `gs://assets/f${n}.jpg`, mime: "image/jpeg" }))).returning();
  await db.insert(catalogOutputs).values(sources.map((s) => ({ ...common(s.n), batchId: more!.id, sourceImageId: s.id, renderKey: `f${s.n}`, crc32c: "crc", stagingUri: `gs://assets/staged-${s.n}.jpg`, status: "staged" as const, qaScores: { verdict: "pass" } })));
  const jpeg = Buffer.from([255, 216, 255, 0]);
  const deps: PublishDeps = {
    db, now: () => new Date("2026-01-02T00:00:00Z"), sleep: async () => {}, channelRules: async () => FIXTURE_CHANNEL_RULES,
    fetch: vi.fn(async () => new Response(jpeg, { status: 200, headers: { "x-goog-generation": "1", "content-type": "image/jpeg", "content-length": "4" } })),
    storage: {
      getPublicBucketName: () => "public",
      headObject: async () => ({ exists: false, size: null, contentType: null, generation: null, crc32c: null }),
      stageCopyToPublic: vi.fn(async () => ({ generation: "1", crc32c: "crc" })),
      deletePublicObject: vi.fn(async () => true), setCustomTime: vi.fn(async () => {}),
    },
  };
  const outputsOf = async (batchId: string) => (await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batchId), eq(catalogOutputs.productId, product!.id)))).sort((a, b) => a.n - b.n);
  const sourcesOf = async (batchId: string) => (await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId))).sort((a, b) => a.n - b.n);
  const pair = async () => (await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, more!.id)))[0]!;
  return { deps, parent: parent!, more: more!, product: product!, outputsOf, sourcesOf, pair };
}

describe("a follow-up batch's publish (append, M1 D30)", () => {
  it("adds shots 4 and 5 and keeps the parent's live shots 1-3 and their photos current", async () => {
    const s = await followUp("append-adds", [4, 5]);
    expect(await publishProduct(s.deps, s.more.id, s.product.id)).toMatchObject({ outcome: "published", changed: true });
    expect(s.deps.storage.deletePublicObject).not.toHaveBeenCalled();
    expect((await s.outputsOf(s.parent.id)).map((o) => [o.n, o.isLive, o.status, o.supersededAt])).toEqual([[1, true, "verified", null], [2, true, "verified", null], [3, true, "verified", null]]);
    expect((await s.outputsOf(s.more.id)).map((o) => [o.n, o.isLive, o.status])).toEqual([[4, true, "verified"], [5, true, "verified"]]);
    expect((await s.sourcesOf(s.parent.id)).map((r) => [r.n, r.isCurrent])).toEqual([[1, true], [2, true], [3, true]]);
    expect((await s.sourcesOf(s.more.id)).map((r) => [r.n, r.isCurrent])).toEqual([[4, true], [5, true]]);
    expect(s.deps.storage.setCustomTime).not.toHaveBeenCalled();
    expect((await s.pair()).change).toBe("updated");
  });

  it("flags (not_added) a photo over its channel's image limit, and one whose place holds another batch's live photo, never replacing it", async () => {
    const s = await followUp("append-limit", [3, 4, 5]);
    expect(await publishProduct({ ...s.deps, imageLimits: { noon: 4 } }, s.more.id, s.product.id)).toMatchObject({ outcome: "published" });
    expect(s.deps.storage.deletePublicObject).not.toHaveBeenCalled();
    expect(s.deps.storage.stageCopyToPublic).toHaveBeenCalledTimes(1);
    expect((await s.outputsOf(s.parent.id)).map((o) => [o.n, o.isLive])).toEqual([[1, true], [2, true], [3, true]]);
    expect((await s.outputsOf(s.more.id)).map((o) => [o.n, o.isLive, o.status, o.reason])).toEqual([
      [3, false, "skipped", APPEND_TAKEN_NOTE],
      [4, true, "verified", null],
      [5, false, "skipped", overLimitNote("noon", 4)],
    ]);
    expect((await s.pair()).notes).toContain(overLimitNote("noon", 4));
    expect((await s.pair()).flags).toContain("not_added");
    expect((await s.outputsOf(s.more.id)).filter((o) => o.status === "skipped").every((o) => o.flags.includes("not_added"))).toBe(true);
    expect((await s.sourcesOf(s.parent.id)).every((r) => r.isCurrent)).toBe(true);
  });

  it("a remove decision in a follow-up leaves every parent photo untouched (re-review P1-A)", async () => {
    // The follow-up's photo 1 sits at the place of the parent's live photo 1 (a collision), and a person chose Remove on it.
    const s = await followUp("append-remove", [1, 4]);
    const [own1] = (await s.outputsOf(s.more.id)).filter((o) => o.n === 1);
    await db.update(catalogOutputs).set({ decision: "remove", status: "needs_attention" }).where(eq(catalogOutputs.id, own1!.id));
    expect(await publishProduct(s.deps, s.more.id, s.product.id)).toMatchObject({ outcome: "published" });
    expect(s.deps.storage.deletePublicObject).not.toHaveBeenCalled();
    expect((await s.outputsOf(s.parent.id)).map((o) => [o.n, o.isLive, o.status, o.generation, o.supersededAt])).toEqual([[1, true, "verified", 20, null], [2, true, "verified", 20, null], [3, true, "verified", 20, null]]);
    expect((await s.sourcesOf(s.parent.id)).every((r) => r.isCurrent)).toBe(true);
    expect((await s.outputsOf(s.more.id)).find((o) => o.n === 4)).toMatchObject({ isLive: true, status: "verified" });
  });
});

describe("planPublish in append mode (M1 D30)", () => {
  const out = (patch: Partial<Output>): Output => ({ id: "x", batchId: "parent", channel: "noon", n: 1, objectPath: "catalog/anta/A/noon/A_1.jpg", generation: 20, status: "verified", decision: null, isLive: true, flags: [], ...patch }) as Output;
  const base = { brandSlug: "anta", pathKey: "A", isTest: false, channels: ["noon" as const], sources: [{ n: 1 }], append: true, batchId: "more" };
  it("deletes only the batch's own live output of a removed shot, never the parent's at that place", () => {
    const parent1 = out({ id: "p1" });
    const own1 = out({ id: "m1", batchId: "more", isLive: false, status: "needs_attention", decision: "remove" });
    expect(planPublish({ ...base, outputs: [own1], live: [parent1] }).deletes).toEqual([]);
    const ownLive = out({ id: "m2", batchId: "more", n: 2, objectPath: "catalog/anta/A/noon/A_2.jpg", decision: "remove" });
    expect(planPublish({ ...base, sources: [{ n: 2 }], outputs: [ownLive], live: [parent1, ownLive] }).deletes.map((d) => d.output.id)).toEqual(["m2"]);
  });
  it("refuses to delete or overwrite another batch's object", () => {
    expect(() => assertOwnedByBatch(out({ batchId: "parent" }), "more", 1)).toThrow(NOT_OWN_OBJECT);
    expect(() => assertOwnedByBatch(out({ batchId: "more", n: 2 }), "more", 1)).toThrow(NOT_OWN_OBJECT);
    expect(() => assertOwnedByBatch(out({ batchId: "more" }), "more", 1)).not.toThrow();
  });
});

