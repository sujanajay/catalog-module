import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "../db/schema";
import { createTestDb } from "../db/testing";
import { recordCostEvents, type CostEventInput } from "../cost-events";
import { batchCostAttribution, batchCostByEngine, batchCostByStage, brandCostReport, dayCostTotals, ENGINE_LABELS, engineLabel } from "./cost-report";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); });
afterAll(async () => { await close(); });

const NOW = new Date("2026-10-22T10:00:00Z");

/** One batch: product P1 with two photos (noon, amazon, styli; styli skipped on photo 2), product P2 with one photo, one chunk. */
async function world(name: string, opts: { brandSlug?: string; isTest?: boolean; at?: Date } = {}) {
  const brandSlug = opts.brandSlug ?? "anta", isTest = opts.isTest ?? true, at = opts.at ?? NOW;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug, brandName: brandSlug, name, isTest, createdBy: "t", channels: ["noon", "amazon", "styli"] }).returning();
  const product = async (key: string) => (await db.insert(catalogProducts).values({ brandSlug, isTest, productKey: `${name}-${key}`, pathKey: `${name}-${key}`, identifier: key }).returning())[0]!;
  const source = async (productId: string, n: number) => (await db.insert(catalogSourceImages).values({ productId, batchId: batch!.id, n, sha256: `${name}-${productId}-${n}`, originalName: `${n}.jpg`, rawUri: "gs://b/r", mime: "image/jpeg" }).returning())[0]!;
  const output = async (productId: string, sourceImageId: string, channel: "noon" | "amazon" | "styli", n: number, status: "staged" | "skipped" = "staged") =>
    (await db.insert(catalogOutputs).values({ batchId: batch!.id, productId, sourceImageId, channel, n, canvasW: 1, canvasH: 1, scale: 1, placedX: 0, placedY: 0, renderKey: "k", objectPath: `catalog-test/${name}/${productId}/${channel}/${n}.jpg`, publicUrl: "https://x", status }).returning())[0]!;
  const p1 = await product("P1"), p2 = await product("P2");
  const s1 = await source(p1.id, 1), s2 = await source(p1.id, 2), s3 = await source(p2.id, 1);
  const o = {
    s1noon: await output(p1.id, s1.id, "noon", 1), s1amazon: await output(p1.id, s1.id, "amazon", 1), s1styli: await output(p1.id, s1.id, "styli", 1),
    s2noon: await output(p1.id, s2.id, "noon", 2), s2amazon: await output(p1.id, s2.id, "amazon", 2), s2styli: await output(p1.id, s2.id, "styli", 2, "skipped"),
    s3noon: await output(p2.id, s3.id, "noon", 1), s3amazon: await output(p2.id, s3.id, "amazon", 1), s3styli: await output(p2.id, s3.id, "styli", 1),
  };
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "qa", productIds: [p1.id, p2.id] }).returning();
  const base = { batchId: batch!.id, brandSlug, isTest, chunkId: chunk!.id, at };
  const row = (r: Omit<CostEventInput, "batchId" | "brandSlug" | "isTest">): CostEventInput => ({ ...base, ...r });
  return { batch: batch!, p1, p2, s1, s2, s3, o, chunk: chunk!, row };
}

describe("cost report", () => {
  it("labels engines by kind, never by model", () => {
    expect(engineLabel("llm_call")).toBe("quality check");
    expect(engineLabel("matte_call")).toBe("cut-out");
    expect(engineLabel("upscale_call")).toBe("image making");
    expect(Object.values(ENGINE_LABELS).join(" ")).not.toMatch(/gemini|birefnet|claude|gpt|\//i);
  });

  it("splits a photo's cut-out across its channels, the compute row across the chunk's outputs; judge, render and upscale rows stay direct", async () => {
    const w = await world("split");
    await recordCostEvents(db, [
      // Photo 1: three live channels share the cut-out (0.30); the judge (0.03 over two attempts) is direct to the noon image it checked.
      w.row({ productId: w.p1.id, sourceImageId: w.s1.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 0.30, ms: 2000, attempt: 1 }),
      w.row({ productId: w.p1.id, sourceImageId: w.s1.id, outputId: w.o.s1noon.id, channel: "noon", stage: "qa", kind: "llm_call", engine: "test/judge", usd: 0.01, outcome: "rate_limited", attempt: 1 }),
      w.row({ productId: w.p1.id, sourceImageId: w.s1.id, outputId: w.o.s1noon.id, channel: "noon", stage: "qa", kind: "llm_call", engine: "test/judge", usd: 0.02, attempt: 2 }),
      // Photo 2: styli is skipped, so two channels share its cut-out (0.20); a retry and a guard step were needed.
      w.row({ productId: w.p1.id, sourceImageId: w.s2.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 0.05, outcome: "fallback", attempt: 1 }),
      w.row({ productId: w.p1.id, sourceImageId: w.s2.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 0.05, attempt: 2 }),
      w.row({ productId: w.p1.id, sourceImageId: w.s2.id, stage: "matte", kind: "matte_call", engine: "gpu", usd: 0.10, attempt: 3 }),
      // Direct rows: one upscale on photo 1's noon output, renders (usd 0).
      w.row({ productId: w.p1.id, sourceImageId: w.s1.id, outputId: w.o.s1noon.id, channel: "noon", stage: "upscale", kind: "upscale_call", engine: "gpu", usd: 0.06, ms: 300 }),
      w.row({ productId: w.p1.id, sourceImageId: w.s1.id, outputId: w.o.s1noon.id, channel: "noon", stage: "render", kind: "render", engine: "worker", usd: 0, ms: 120 }),
      // The classifier row of product 2 belongs to its photo (three channels).
      w.row({ productId: w.p2.id, sourceImageId: w.s3.id, stage: "classify", kind: "llm_call", engine: "test/classifier", usd: 0.03 }),
      // The chunk's compute row: 8 non-skipped outputs share 0.80.
      w.row({ stage: "qa", kind: "compute", engine: "worker", usd: 0.80, ms: 5000 }),
      // A publish row with no money.
      w.row({ productId: w.p1.id, stage: "publish", kind: "compute", engine: "worker", usd: 0, ms: 50 }),
    ]);
    const report = await batchCostAttribution(db, w.batch.id);
    // 0.30 + 0.01 + 0.02 + 0.05 + 0.05 + 0.10 + 0.06 + 0 + 0.03 + 0.80 + 0
    expect(report.totalUsd).toBeCloseTo(1.42, 9);
    expect(report.unattributedUsd).toBe(0);
    const channel = Object.fromEntries(report.byChannel.map((c) => [c.channel, c.usd]));
    // noon: s1 cut-out 0.30/3 + judge 0.03 direct + upscale 0.06 + s2 0.20/2 + s3 0.03/3 + compute 3*0.10
    expect(channel.noon).toBeCloseTo(0.10 + 0.03 + 0.06 + 0.10 + 0.01 + 0.30, 9);
    expect(channel.amazon).toBeCloseTo(0.10 + 0.10 + 0.01 + 0.30, 9);
    // styli: s1 share + s3 share + compute for its two live outputs; nothing from the skipped photo 2, nothing from the judge.
    expect(channel.styli).toBeCloseTo(0.10 + 0.01 + 0.20, 9);
    expect(report.byChannel.find((c) => c.channel === "styli")!.outputs).toBe(2);
    expect(report.byChannel.map((c) => c.usd).reduce((a, b) => a + b, 0)).toBeCloseTo(1.42, 9);

    expect(report.topProducts.map((p) => p.identifier)).toEqual(["P1", "P2"]);
    const [p1, p2] = report.topProducts;
    expect(p1!.usd).toBeCloseTo(0.33 + 0.06 + 0.20 + 0.50, 9);
    expect(p1!.hints).toEqual({ matteCalls: 4, matteExtraCalls: 2, judgeCalls: 2, upscaleCalls: 1 });
    expect(p2!.usd).toBeCloseTo(0.03 + 0.30, 9);
    expect(p2!.hints).toEqual({ matteCalls: 0, matteExtraCalls: 0, judgeCalls: 0, upscaleCalls: 0 });

    expect(report.topImages[0]).toMatchObject({ sourceImageId: w.s1.id, identifier: "P1", n: 1, outputs: 3, hints: { matteCalls: 1, matteExtraCalls: 0, judgeCalls: 2, upscaleCalls: 1 } });
    expect(report.topImages[0]!.usd).toBeCloseTo(0.33 + 0.06 + 0.30, 9);
    expect(report.topImages.find((i) => i.sourceImageId === w.s2.id)).toMatchObject({ n: 2, outputs: 2, hints: { matteCalls: 3, matteExtraCalls: 2, judgeCalls: 0, upscaleCalls: 0 } });
    expect((await batchCostAttribution(db, w.batch.id, { top: 1 })).topImages).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("test/judge");
  });

  it("money for a photo whose outputs are all skipped is reported as unattributed, not lost", async () => {
    const w = await world("unattributed");
    await db.update(catalogOutputs).set({ status: "skipped" }).where(eq(catalogOutputs.sourceImageId, w.s3.id));
    await recordCostEvents(db, [w.row({ productId: w.p2.id, sourceImageId: w.s3.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 0.4 })]);
    const report = await batchCostAttribution(db, w.batch.id);
    expect(report.unattributedUsd).toBeCloseTo(0.4, 9);
    expect(report.totalUsd).toBeCloseTo(0.4, 9);
    expect(report.byChannel.map((c) => c.usd).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("totals per stage and per engine label", async () => {
    const w = await world("stages");
    await recordCostEvents(db, [
      w.row({ sourceImageId: w.s1.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 0.2, ms: 1000, estimated: true }),
      w.row({ sourceImageId: w.s1.id, stage: "qa", kind: "llm_call", engine: "test/judge", usd: 0.01, ms: 500 }),
      w.row({ outputId: w.o.s1noon.id, stage: "upscale", kind: "upscale_call", engine: "gpu", usd: 0.05, ms: 200 }),
      w.row({ outputId: w.o.s1noon.id, stage: "render", kind: "render", engine: "worker", usd: 0, ms: 100 }),
      w.row({ stage: "qa", kind: "compute", engine: "worker", usd: 0.3, ms: 3000 }),
    ]);
    const stages = await batchCostByStage(db, w.batch.id);
    expect(stages.map((s) => s.stage)).toEqual(["qa", "matte", "upscale", "render"]);
    expect(stages.find((s) => s.stage === "qa")).toMatchObject({ calls: 2, ms: 3500 });
    expect(stages.find((s) => s.stage === "qa")!.usd).toBeCloseTo(0.31, 9);
    expect(stages.find((s) => s.stage === "matte")!.estimatedUsd).toBeCloseTo(0.2, 9);
    const engines = await batchCostByEngine(db, w.batch.id);
    expect(engines.map((e) => e.engine)).toEqual(["worker", "cut-out", "image making", "quality check"]);
    expect(engines.find((e) => e.engine === "image making")).toMatchObject({ calls: 2, ms: 300 });
  });

  it("per-brand totals for 30 days and lifetime, per product and per image, leaving test batches out unless asked", async () => {
    const old = new Date("2026-08-01T00:00:00Z");
    const recent = await world("brand-recent", { brandSlug: "penti", isTest: false });
    const older = await world("brand-old", { brandSlug: "penti", isTest: false, at: old });
    const test = await world("brand-test", { brandSlug: "penti", isTest: true });
    await recordCostEvents(db, [
      recent.row({ productId: recent.p1.id, sourceImageId: recent.s1.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 1 }),
      recent.row({ productId: recent.p1.id, sourceImageId: recent.s2.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 1 }),
      recent.row({ stage: "qa", kind: "compute", engine: "worker", usd: 2 }),
      older.row({ productId: older.p2.id, sourceImageId: older.s3.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 4 }),
      test.row({ productId: test.p1.id, sourceImageId: test.s1.id, stage: "matte", kind: "matte_call", engine: "cpu", usd: 100 }),
    ]);
    const report = await brandCostReport(db, { now: NOW });
    const penti30 = report.last30Days.find((b) => b.brandSlug === "penti")!, pentiAll = report.lifetime.find((b) => b.brandSlug === "penti")!;
    expect(penti30).toMatchObject({ usd: 4, batches: 1, products: 1, images: 2, usdPerProduct: 4, usdPerImage: 2 });
    expect(pentiAll).toMatchObject({ usd: 8, batches: 2, products: 2, images: 3, usdPerProduct: 4 });
    expect(pentiAll.usdPerImage).toBeCloseTo(8 / 3, 9);
    expect((await brandCostReport(db, { now: NOW, includeTest: true })).lifetime.find((b) => b.brandSlug === "penti")!.usd).toBe(108);
  });

  it("day totals over the window, oldest first, UTC days", async () => {
    const w = await world("days", { brandSlug: "days", isTest: false });
    // Other tests of this file share the database, so the check is on what this batch adds.
    const at = (days: Awaited<ReturnType<typeof dayCostTotals>>, day: string) => days.find((d) => d.day === day) ?? { day, usd: 0, batches: 0 };
    const before = await dayCostTotals(db, { now: NOW, days: 7 });
    await recordCostEvents(db, [
      w.row({ stage: "qa", kind: "compute", engine: "worker", usd: 1, at: new Date("2026-10-22T23:59:00Z") }),
      w.row({ stage: "qa", kind: "compute", engine: "worker", usd: 2, at: new Date("2026-10-20T00:30:00Z") }),
      w.row({ stage: "qa", kind: "compute", engine: "worker", usd: 4, at: new Date("2026-09-01T00:00:00Z") }),
    ]);
    const days = await dayCostTotals(db, { now: NOW, days: 7 });
    expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort());
    expect(at(days, "2026-10-20").usd - at(before, "2026-10-20").usd).toBeCloseTo(2, 9);
    expect(at(days, "2026-10-20").batches - at(before, "2026-10-20").batches).toBe(1);
    expect(at(days, "2026-10-22").usd - at(before, "2026-10-22").usd).toBeCloseTo(1, 9);
    expect(days.some((d) => d.day === "2026-09-01")).toBe(false);
  });
});
