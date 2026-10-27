// Tier 2 (PGlite): the merge-only counts writes and the placing lease conditions (spec 14c F6).
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogBatches, EMPTY_BATCH_COUNTS } from "../db/schema";
import { createTestDb } from "../db/testing";
import { mergeCounts, PLACING_LEASE_MS, placingClaim, placingLeaseFree, placingLeaseHeld, placingLeaseResumable, placingToken, progressCounts, RATE_SAMPLES } from "./counts";
import type { BatchCounts } from "./types";

let db: Db;
let close: () => Promise<void>;
let id: string;
const t0 = new Date("2026-10-27T10:00:00Z");
const at = (s: number) => new Date(+t0 + s * 1000);

beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());
beforeEach(async () => {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name: "catalog-test counts", isTest: true, createdBy: "t@opptra.com", status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, collected: 40, collectTotal: 287 } }).returning();
  id = batch!.id;
});
const counts = async (): Promise<BatchCounts> => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!.counts;
const write = (value: ReturnType<typeof mergeCounts>) => db.update(catalogBatches).set({ counts: value }).where(eq(catalogBatches.id, id));

describe("mergeCounts", () => {
  it("changes only the named keys, so worker keys survive a web write", async () => {
    const claim = placingClaim("run:u1", t0);
    await write(progressCounts({ placingClaim: claim, placeTotal: 287 }, { phase: "placing", done: 0, at: t0 }));
    await write(mergeCounts({ previewReady: false }));
    const c = await counts();
    expect(c).toMatchObject({ collected: 40, collectTotal: 287, previewReady: false, phase: "placing", placeTotal: 287, placingClaim: claim });
    expect(c.rate).toHaveLength(1);
    await write(mergeCounts({ placingClaim: null, phase: "ready" }));
    expect(await counts()).toMatchObject({ placingClaim: null, phase: "ready", collected: 40 });
  });
});

describe("progressCounts", () => {
  it("adds samples of the current phase, keeps the last five, and restarts rate when the phase changes", async () => {
    for (let i = 0; i < 7; i++) await write(progressCounts({ collected: 40 + i * 10 }, { phase: "downloading", done: "collected", at: at(i * 30) }));
    let c = await counts();
    expect(c.phase).toBe("downloading");
    expect(c.rate).toHaveLength(RATE_SAMPLES);
    expect(c.rate!.map((s) => s.done)).toEqual([60, 70, 80, 90, 100]);
    expect(c.rate!.every((s) => s.phase === "downloading")).toBe(true);
    expect(c.rate!.at(-1)!.at).toBe(at(180).toISOString());

    await write(progressCounts({ placeTotal: 100, placed: 0 }, { phase: "placing", done: "placed", at: at(200) }));
    c = await counts();
    expect(c.rate).toEqual([{ at: at(200).toISOString(), phase: "placing", done: 0 }]);
    await write(progressCounts({ placed: 25 }, { phase: "placing", done: "placed", at: at(230) }));
    expect((await counts()).rate!.map((s) => s.done)).toEqual([0, 25]);
  });
  it("replaces the last sample when the one before it is under 10 s old, so frequent writes still span time", async () => {
    await write(progressCounts({}, { phase: "checking", done: 1, at: at(0) }));
    await write(progressCounts({}, { phase: "checking", done: 2, at: at(1) }));
    for (let s = 2; s <= 9; s++) await write(progressCounts({}, { phase: "checking", done: s + 1, at: at(s) }));
    expect((await counts()).rate!.map((s) => s.done)).toEqual([1, 10]);
    await write(progressCounts({}, { phase: "checking", done: 11, at: at(10) }));
    expect((await counts()).rate!.map((s) => s.done)).toEqual([1, 10, 11]);
  });
  it("reads collected after a separate counts bump and treats a missing key as 0", async () => {
    await write(progressCounts({}, { phase: "placing", done: "placed", at: t0 }));
    expect((await counts()).rate).toEqual([{ at: t0.toISOString(), phase: "placing", done: 0 }]);
    await write(progressCounts({}, { phase: "downloading", done: "collected", at: t0 }));
    expect((await counts()).rate![0]!.done).toBe(40);
  });
});

describe("placing lease", () => {
  const claimIfFree = async (token: string, now: Date) =>
    (await db.update(catalogBatches).set({ counts: mergeCounts({ placingClaim: placingClaim(token, now) }) }).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "ingesting"), placingLeaseFree(now))).returning({ id: catalogBatches.id })).length;
  it("is claimed once while live, again once lapsed, and after a null claim", async () => {
    const a = placingToken("run1", "u1"), b = placingToken("run2", "u2");
    expect(a).toBe("run1:u1");
    expect(await claimIfFree(a, t0)).toBe(1);
    expect(await claimIfFree(b, at(60))).toBe(0);
    const lapsed = new Date(+t0 + PLACING_LEASE_MS + 1000);
    expect(await claimIfFree(b, lapsed)).toBe(1);
    expect((await counts()).placingClaim!.token).toBe(b);
    await write(mergeCounts({ placingClaim: null }));
    expect(await claimIfFree(a, lapsed)).toBe(1);
  });
  it("guards a final write by token and attempt", async () => {
    const a = placingToken("run1", "u1");
    await write(mergeCounts({ placingClaim: placingClaim(a, t0, "att-1") }));
    const finish = async (token: string, attempt: string) => (await db.update(catalogBatches).set({ status: "draft" }).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "ingesting"), placingLeaseHeld(token, attempt))).returning({ id: catalogBatches.id })).length;
    expect(await finish("other:u9", "att-1")).toBe(0);
    expect(await finish(a, "att-2")).toBe(0);
    expect(await finish(a, "att-1")).toBe(1);
    const claim = placingClaim(a, t0);
    expect(new Date(claim.until).getTime() - t0.getTime()).toBe(PLACING_LEASE_MS);
    expect(PLACING_LEASE_MS).toBeGreaterThan(900_000);
  });
  it("lets the same token resume only a live claim no run works under", async () => {
    const a = placingToken("run1", "u1");
    const resume = async (token: string, now: Date) => (await db.update(catalogBatches).set({ counts: mergeCounts({ placingClaim: placingClaim(token, now, "att-2") }) }).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "ingesting"), placingLeaseResumable(token, now))).returning({ id: catalogBatches.id })).length;
    await write(mergeCounts({ placingClaim: placingClaim(a, t0, "att-1") }));
    expect(await resume(a, at(60))).toBe(0); // a run works under it (a duplicate delivery)
    await write(mergeCounts({ placingClaim: placingClaim(a, t0, null) }));
    expect(await resume("other:u9", at(60))).toBe(0);
    expect(await resume(a, new Date(+t0 + PLACING_LEASE_MS + 1000))).toBe(0); // lapsed: free for anyone instead
    expect(await resume(a, at(60))).toBe(1);
    expect((await counts()).placingClaim).toMatchObject({ token: a, attempt: "att-2" });
  });
});
