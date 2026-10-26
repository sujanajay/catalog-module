import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import { brandMaster, catalogBatches, catalogBatchProducts, catalogEvalLabels, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { findOrCreateProduct } from "@catalog/core/catalog/products";
import type { ChannelId } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { batchCompare, COMPARE_PAGE_SIZE, outputUrlOf, productCompare, whyOf } from "../lib/catalog/compare";
import { evalOutputs } from "../lib/catalog/eval";

let db: Db; let close: () => Promise<void>;
const actor = "admin@opptra.com";
const sign = vi.fn(async (uri: string) => `signed:${uri}`);
beforeAll(async () => { ({ db, close } = await createTestDb()); setDbForTests(db); });
afterAll(async () => { setDbForTests(undefined); await close(); });
beforeEach(async () => {
  sign.mockClear();
  await db.delete(catalogEvalLabels); await db.delete(catalogOutputs); await db.delete(catalogSourceImages); await db.delete(catalogProducts); await db.delete(catalogBatches); await db.delete(brandMaster);
  await db.insert(brandMaster).values({ slug: "uspa", name: "USPA", line: "softline", source: "manual" });
});

async function batch(name: string, extra: Partial<typeof catalogBatches.$inferInsert> = {}) {
  const [b] = await db.insert(catalogBatches).values({ name, brandSlug: "uspa", brandName: "USPA", channels: ["styli", "amazon"], createdBy: actor, status: "done", finishedAt: new Date(), ...extra }).returning();
  return b!;
}
async function product(identifier: string) {
  return (await findOrCreateProduct(db, { brandSlug: "uspa", identifier, isTest: false, skus: null, actor })).product;
}
async function source(batchId: string, productId: string, n: number, sha = `sha-${n}`, extra: Partial<typeof catalogSourceImages.$inferInsert> = {}) {
  const [s] = await db.insert(catalogSourceImages).values({ productId, batchId, n, sha256: sha, originalName: `${n}.jpg`, rawUri: `gs://private/${batchId}/raw/${productId}-${n}.jpg`, mime: "image/jpeg", ...extra }).returning();
  return s!;
}
async function output(batchId: string, productId: string, src: { id: string; n: number }, channel: ChannelId, extra: Partial<typeof catalogOutputs.$inferInsert> = {}) {
  const [o] = await db.insert(catalogOutputs).values({ batchId, productId, sourceImageId: src.id, channel, n: src.n, canvasW: 1, canvasH: 1, scale: 1, placedX: 0, placedY: 0, renderKey: "k", objectPath: `catalog/uspa/p/${channel}/${src.n}.jpg`, publicUrl: `https://public/${channel}/${src.n}.jpg`, stagingUri: `gs://private/${batchId}/staging/${channel}-${src.n}.jpg`, status: "verified", ...extra }).returning();
  return o!;
}
const link = (batchId: string, productId: string, change: typeof catalogBatchProducts.$inferInsert["change"] = "new") => db.insert(catalogBatchProducts).values({ batchId, productId, change });

it("shows this batch's output, then an earlier batch's output as unchanged, then could not be made", async () => {
  const first = await batch("First", { finishedAt: new Date(Date.now() - 60_000) });
  const p = await product("ABC-1"); await link(first.id, p.id);
  const old1 = await source(first.id, p.id, 1);
  const oldStyli = await output(first.id, p.id, old1, "styli", { isLive: true });
  await output(first.id, p.id, old1, "amazon", { isLive: true });
  const second = await batch("Second"); await link(second.id, p.id, "updated");
  const s1 = await source(second.id, p.id, 1, "sha-1", { replacesId: old1.id }); // same photo bytes
  const s2 = await source(second.id, p.id, 2, "sha-new");
  await output(second.id, p.id, s1, "amazon", { status: "needs_attention", flags: ["halo"] });
  await output(second.id, p.id, s2, "styli", { status: "failed", stagingUri: null, reason: "No product was found in this photo." });

  const page = await batchCompare(second.id, {}, db, sign);
  expect(page.total).toBe(2);
  expect(page.channels).toEqual(["styli", "amazon"]);
  const [row1, row2] = page.rows;
  expect(row1).toMatchObject({ identifier: "ABC-1", n: 1, originalUrl: `signed:${s1.rawUri}` });
  expect(row1!.cells[0]).toMatchObject({ channel: "styli", outputId: oldStyli.id, unchanged: true, grade: "unchanged", url: `signed:${oldStyli.stagingUri}` });
  expect(row1!.cells[1]).toMatchObject({ channel: "amazon", unchanged: false, grade: "attention" });
  expect(row1!.cells[1]!.why).toContain("edge");
  expect(row2!.cells[0]).toMatchObject({ channel: "styli", grade: "failed", url: null, why: "No product was found in this photo." });
  // Nothing at all for this photo on amazon in a finished batch, and no earlier output with the same bytes.
  expect(row2!.cells[1]).toMatchObject({ channel: "amazon", outputId: null, grade: "failed", url: null });

  // The past batch still shows its own outputs, never the later batch's.
  const past = await batchCompare(first.id, {}, db, sign);
  expect(past.rows).toHaveLength(1);
  expect(past.rows[0]!.cells.map(c => c.grade)).toEqual(["passed", "passed"]);
  expect(past.rows[0]!.originalUrl).toBe(`signed:${old1.rawUri}`);
});

it("never takes an unchanged output from a batch that ran after this one", async () => {
  const first = await batch("First", { finishedAt: new Date(Date.now() - 60_000) });
  const p = await product("ABC-2"); await link(first.id, p.id);
  const s = await source(first.id, p.id, 1);
  const later = await batch("Later"); await link(later.id, p.id, "updated");
  const s2 = await source(later.id, p.id, 1, "sha-1", { replacesId: s.id });
  await output(later.id, p.id, s2, "styli", { isLive: true });
  const page = await batchCompare(first.id, { channel: "styli" }, db, sign);
  expect(page.rows[0]!.cells).toEqual([expect.objectContaining({ outputId: null, grade: "failed" })]);
});

it("shows a running batch's missing output as not made yet", async () => {
  const b = await batch("Running", { status: "rendering", finishedAt: null });
  const p = await product("RUN-1"); await link(b.id, p.id);
  await source(b.id, p.id, 1);
  const page = await batchCompare(b.id, {}, db, sign);
  expect(page.rows[0]!.cells.map(c => c.grade)).toEqual(["waiting", "waiting"]);
});

it("hides a photo replaced inside the same batch and shows its replacement", async () => {
  const b = await batch("Replace");
  const p = await product("REP-1"); await link(b.id, p.id);
  const s = await source(b.id, p.id, 1);
  await source(b.id, p.id, 1, "sha-replacement", { replacesId: s.id, rawUri: "gs://private/replacement.jpg" });
  const page = await batchCompare(b.id, {}, db, sign);
  expect(page.rows.map(r => r.originalUrl)).toEqual(["signed:gs://private/replacement.jpg"]);
});

it("filters by channel, status and product, and pages 25 photos at a time", async () => {
  const b = await batch("Big");
  for (let i = 0; i < 30; i++) {
    const p = await product(`P-${String(i).padStart(2, "0")}`); await link(b.id, p.id);
    const s = await source(b.id, p.id, 1);
    await output(b.id, p.id, s, "styli", i === 3 ? { status: "needs_attention", flags: ["halo"] } : {});
    await output(b.id, p.id, s, "amazon", i === 7 ? { compliance: { auto_actions: [{ step: "shadow_off", trigger: ["halo"], result: "passed", channels: ["amazon"], rejudged: true }] } } : {});
  }
  const first = await batchCompare(b.id, {}, db, sign);
  expect(first.total).toBe(30); expect(first.rows).toHaveLength(COMPARE_PAGE_SIZE);
  const second = await batchCompare(b.id, { page: 1 }, db, sign);
  expect(second.rows.map(r => r.identifier)).toEqual(["P-25", "P-26", "P-27", "P-28", "P-29"]);
  expect((await batchCompare(b.id, { status: "attention" }, db, sign)).rows.map(r => r.identifier)).toEqual(["P-03"]);
  expect((await batchCompare(b.id, { status: "attention", channel: "amazon" }, db, sign)).total).toBe(0);
  const repaired = await batchCompare(b.id, { status: "repaired" }, db, sign);
  expect(repaired.rows.map(r => r.identifier)).toEqual(["P-07"]);
  expect(repaired.rows[0]!.cells.map(c => c.grade)).toEqual(["passed", "repaired"]);
  // A repair made on another channel does not mark this channel repaired.
  expect((await batchCompare(b.id, { status: "repaired", channel: "styli" }, db, sign)).total).toBe(0);
  expect((await batchCompare(b.id, { channel: "amazon" }, db, sign)).rows[0]!.cells.map(c => c.channel)).toEqual(["amazon"]);
  expect((await batchCompare(b.id, { q: "p-1" }, db, sign)).total).toBe(10);
  // A photo is listed when any of its shown channels has that state.
  expect((await batchCompare(b.id, { status: "passed" }, db, sign)).total).toBe(30);
  expect((await batchCompare(b.id, { status: "passed", channel: "styli" }, db, sign)).total).toBe(29);
  const beyond = await batchCompare(b.id, { status: "attention", page: 4 }, db, sign);
  expect(beyond).toMatchObject({ rows: [], total: 1, page: 4 });
});

it("finds the unchanged filter only on photos made in an earlier batch", async () => {
  const first = await batch("First", { finishedAt: new Date(Date.now() - 60_000) });
  const p = await product("U-1"); await link(first.id, p.id);
  const s = await source(first.id, p.id, 1);
  await output(first.id, p.id, s, "styli"); await output(first.id, p.id, s, "amazon");
  const second = await batch("Second"); await link(second.id, p.id, "updated");
  const s2 = await source(second.id, p.id, 1, "sha-1", { replacesId: s.id });
  await output(second.id, p.id, s2, "amazon");
  expect((await batchCompare(second.id, { status: "unchanged" }, db, sign)).total).toBe(1);
  expect((await batchCompare(second.id, { status: "unchanged", channel: "amazon" }, db, sign)).total).toBe(0);
  expect((await batchCompare(first.id, { status: "unchanged" }, db, sign)).total).toBe(0);
});

it("chooses the staging copy, then the public link only while live", async () => {
  const s = vi.fn(async (uri: string) => `signed:${uri}`);
  expect(await outputUrlOf({ stagingUri: "gs://a/b.jpg", isLive: true, publicUrl: "https://p" }, s)).toBe("signed:gs://a/b.jpg");
  expect(await outputUrlOf({ stagingUri: null, isLive: true, publicUrl: "https://p" }, s)).toBe("https://p");
  expect(await outputUrlOf({ stagingUri: null, isLive: false, publicUrl: "https://p" }, s)).toBeNull();
  expect(whyOf({ n: 1, channel: "styli", flags: [], status: "verified", compliance: null, reason: null, error: null })).toBe("");
});

it("keeps the eval list's shape", async () => {
  const b = await batch("Eval", { isTest: true, options: { evalSet: "set-1" } as never });
  const p = await product("EV-1"); await link(b.id, p.id);
  const s = await source(b.id, p.id, 1);
  await output(b.id, p.id, s, "styli", { qaScores: { verdict: "pass" } });
  await output(b.id, p.id, s, "amazon", { stagingUri: null, isLive: true, flags: ["halo"] });
  const page = await evalOutputs(b.id, {}, db, sign);
  expect(page.total).toBe(2);
  expect(Object.keys(page.items[0]!).sort()).toEqual(["channel", "identifier", "n", "originalUrl", "outputId", "outputUrl", "verdict", "why"]);
  expect(page.items.find(i => i.channel === "amazon")).toMatchObject({ outputUrl: "https://public/amazon/1.jpg", verdict: "flag" });
  expect(page.items.find(i => i.channel === "styli")).toMatchObject({ outputUrl: `signed:gs://private/${b.id}/staging/styli-1.jpg`, verdict: "pass", why: "" });
});

it("shows a product's current originals next to its live outputs and the batches that touched it", async () => {
  const first = await batch("First", { createdAt: new Date(Date.now() - 120_000) });
  const p = await product("PR-1"); await link(first.id, p.id);
  const s = await source(first.id, p.id, 1, "sha-1", { isCurrent: true });
  await output(first.id, p.id, s, "styli", { isLive: true, stagingUri: null });
  const second = await batch("Second"); await link(second.id, p.id, "unchanged");
  const view = await productCompare(p.id, db, sign);
  expect(view.channels).toEqual(["styli"]);
  expect(view.rows).toEqual([{ n: 1, originalUrl: `signed:${s.rawUri}`, cells: [expect.objectContaining({ channel: "styli", url: "https://public/styli/1.jpg" })] }]);
  expect(view.batches.map(b => [b.name, b.change])).toEqual([["Second", "unchanged"], ["First", "new"]]);
  await db.update(catalogSourceImages).set({ isCurrent: false }).where(eq(catalogSourceImages.id, s.id));
  expect((await productCompare(p.id, db, sign)).rows[0]!.originalUrl).toBeNull();
});
