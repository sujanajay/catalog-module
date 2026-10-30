// The admin Ops page, the batch page's cost split and the Details additions, on PGlite with real core
// cost queries. AutoRefresh needs the App Router, which a static render does not have, so the router is
// stubbed; everything else (the page, its queries, requireRole) is the real code.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogChunks, catalogCostEvents, catalogEnlargements, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { recordCostEvents } from "@catalog/core/cost-events";
import { batchCostAttribution, batchCostByStage } from "@catalog/core/catalog/cost-report";
import { inrAmount, usdAmount } from "@catalog/core/catalog/cost";
import type { Role } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { ForbiddenError } from "../lib/errors";
import { activeBatches, recentFailures, resetOpsCostCache, batchChunkSummary, batchStageCost, costOverview, opsCostCacheSize, CACHE_MAX_ENTRIES, gpuCandidateRevision, healthSummary, setCloudRunReadForTests, GPU_SERVICE_PATH } from "../lib/catalog/ops";
import { batchCostLine } from "../lib/catalog/cost";
import CostLine from "../components/catalog/CostLine";
import { randomUUID } from "node:crypto";
import { chunkProgressText, fullCostParts, fullCostText, healthLines, logsUrl, money, REPORT_UNAVAILABLE } from "../lib/catalog/ops-copy";
import { showOpsMenuItem } from "../lib/people-copy";
import DetailsTab from "../components/catalog/DetailsTab";
import OpsPage from "../app/catalog/ops/page";
import BatchPage from "../app/catalog/[id]/page";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), notFound: () => { throw new Error("not found"); } }));

const MODEL_WORDS = /gemini|claude|qwen|birefnet|rmbg|bria|inspyre|ben_custom|esrgan|google\/|anthropic\/|openai\//i;
const NOW = new Date();
let db: Db, close: () => Promise<void>;
let role: Role = "admin";

beforeAll(async () => { ({ db, close } = await createTestDb()); setDbForTests(db); });
afterAll(async () => { setDbForTests(undefined); await close(); });
beforeEach(async () => {
  resetOpsCostCache();
  role = "admin";
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("DEV_USER_EMAIL", "admin@opptra.com");
  vi.stubEnv("INR_PER_USD", "85");
  vi.stubEnv("DAILY_SPEND_CAP_USD", "10");
  setUserDeps({ roleLookup: async () => role });
  setCloudRunReadForTests(async () => ({ trafficStatuses: [{ tag: "", revision: "catalog-matting-gpu-00007-abc", percent: 100 }] }));
  await db.delete(catalogCostEvents); await db.delete(catalogOutputs); await db.delete(catalogSourceImages); await db.delete(catalogProducts); await db.delete(catalogBatches);
});
afterEach(() => { resetUserDeps(); setCloudRunReadForTests(undefined); vi.unstubAllEnvs(); });

/** A running batch with one product, one photo on two channels, three chunks and ledger rows with model ids as engines. */
async function world() {
  const [batch] = await db.insert(catalogBatches).values({ name: "October drop", brandSlug: "uspa", brandName: "USPA", channels: ["noon", "amazon"], createdBy: "a@opptra.com", status: "rendering", startedAt: new Date(+NOW - 600_000) }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "uspa", isTest: false, productKey: "ABC123", pathKey: "abc-123", identifier: "ABC-123" }).returning();
  const [source] = await db.insert(catalogSourceImages).values({ productId: product!.id, batchId: batch!.id, n: 1, sha256: "s", originalName: "ABC-123_1.jpg", rawUri: "gs://b/r", mime: "image/jpeg" }).returning();
  const out = async (channel: "noon" | "amazon") => (await db.insert(catalogOutputs).values({ batchId: batch!.id, productId: product!.id, sourceImageId: source!.id, channel, n: 1, canvasW: 1, canvasH: 1, scale: 1, placedX: 0, placedY: 0, renderKey: "k", objectPath: `catalog/uspa/abc-123/${channel}/1.jpg`, publicUrl: "https://x", status: "staged" }).returning())[0]!;
  const noon = await out("noon"); await out("amazon");
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "render", productIds: [product!.id], status: "running" }).returning();
  await db.insert(catalogChunks).values({ batchId: batch!.id, index: 1, stage: "matte", productIds: [], status: "queued" });
  await db.insert(catalogChunks).values({ batchId: batch!.id, index: 2, stage: "qa", productIds: [], status: "failed", error: "birefnet-general timed out after 60 s", finishedAt: new Date(+NOW - 60_000) });
  const base = { batchId: batch!.id, brandSlug: "uspa", isTest: false, productId: product!.id, sourceImageId: source!.id, at: new Date(+NOW - 60_000) };
  await recordCostEvents(db, [
    { ...base, stage: "matte", kind: "matte_call", engine: "gpu", ms: 2000, usd: 0.002 },
    { ...base, stage: "matte", kind: "matte_call", engine: "gpu", ms: 2000, usd: 0.002 },
    { ...base, stage: "qa", kind: "llm_call", engine: "google/gemini-2.5-flash-lite", outputId: noon.id, channel: "noon", usd: 0.001 },
    { ...base, stage: "render", kind: "compute", engine: "worker", chunkId: chunk!.id, ms: 4000, usd: 0.0006 },
  ]);
  return { batch: batch!, chunk: chunk! };
}
const render = async (page: Promise<ReactElement>) => renderToStaticMarkup(createElement(ViewerPreviewProvider, null, createElement(ToastProvider, null, await page)));

describe("admin Ops page", () => {
  it("refuses operators and viewers with the existing forbidden error, and shows the menu item to admins only", async () => {
    for (const r of ["operator", "viewer"] as const) {
      role = r;
      await expect(OpsPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(showOpsMenuItem("admin", false)).toBe(true);
    expect(showOpsMenuItem("admin", true)).toBe(false);
    expect(showOpsMenuItem("operator", false)).toBe(false);
  });

  it("shows running batches, failures, brand and day cost and one batch's attribution from the core queries, with no model id", async () => {
    const { batch } = await world();
    await db.insert(catalogBatches).values({ name: "Swept batch", brandSlug: "uspa", brandName: "USPA", createdBy: "a@opptra.com", status: "failed", error: "No progress for 2 hours. Start the batch again.", counts: { ...EMPTY_BATCH_COUNTS, failReason: "No progress for 2 hours. Start the batch again." } });
    const html = await render(OpsPage({ searchParams: Promise.resolve({ batch: batch.id }) }));
    expect(html).toContain("October drop");
    expect(html).toContain("Making images");
    expect(html).toContain("3 in total · cut-out: 1 waiting · image making: 1 running · quality check: 1 gave up");
    expect(html).toContain("auto-refreshing every 30s");
    expect(html).toContain("Swept batch");
    expect(html).toContain("No progress for 2 hours. Start the batch again.");
    expect(html).toContain("Chunk 3 (quality check) gave up after repeated errors: model A timed out after 60 s.");
    expect(html).toContain("agency reference INR 60 per style");
    expect(html).toContain("Show all-time totals");
    expect(html).not.toContain("Cost per brand, all time");
    // Attribution figures are the core functions' own numbers.
    const attribution = await batchCostAttribution(db, batch.id);
    expect(attribution.byChannel.length).toBe(2);
    for (const c of attribution.byChannel) expect(html).toContain(money(c.usd, 85));
    expect(html).toContain(`Total ${money(attribution.totalUsd, 85)}`);
    expect(html).toContain("1 extra cut-out call, 1 quality check");
    expect(html).toContain("ABC-123, photo 1");
    expect(html).not.toContain("daily limit");
    expect(html).toContain(logsUrl(batch.id).replace(/&/g, "&amp;"));
    expect(html).not.toMatch(MODEL_WORDS);
  });

  it("loads lifetime brand totals only on demand, without auto refresh", async () => {
    await world();
    const html = await render(OpsPage({ searchParams: Promise.resolve({ lifetime: "1" }) }));
    expect(html).toContain("Cost per brand, all time");
    expect(html).not.toContain("auto-refreshing");
    expect(html).toContain("Back to the live view");
  });

  it("keeps the cost sections for a few minutes so the 30 s refresh reads only active batches and failures", async () => {
    const { batch } = await world();
    const read = async (at: Date) => { const r = await costOverview(db, at); if (!r.ok) throw new Error("report failed"); return r.value; };
    const first = await read(NOW);
    const before = (await activeBatches(db, NOW))[0]!.usd;
    await recordCostEvents(db, [{ batchId: batch.id, brandSlug: "uspa", isTest: false, stage: "qa", kind: "llm_call", engine: "x", usd: 1 }]);
    expect(await read(new Date(+NOW + 30_000))).toBe(first);
    // Cost so far of a running batch is kept 60 s; failures are read fresh on every call.
    expect((await activeBatches(db, new Date(+NOW + 30_000)))[0]!.usd).toBe(before);
    expect((await activeBatches(db, new Date(+NOW + 61_000)))[0]!.usd).toBeGreaterThan(1);
    expect((await read(new Date(+NOW + 6 * 60_000))).brands[0]!.usd).toBeGreaterThan(first.brands[0]!.usd);
    expect((await recentFailures(db, NOW)).chunks).toHaveLength(1);
  });

  it("forgets expired cost reads when storing and keeps at most 50", async () => {
    for (let i = 0; i < CACHE_MAX_ENTRIES + 10; i++) await batchStageCost(randomUUID(), db, NOW);
    expect(opsCostCacheSize()).toBe(CACHE_MAX_ENTRIES);
    await batchStageCost(randomUUID(), db, new Date(+NOW + 61_000));
    expect(opsCostCacheSize()).toBe(1);
  });

  it("shows a plain sentence, not an error page, when a report read times out", async () => {
    const { batch } = await world();
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const slow = new Proxy(db, { get: (target, key) => (key === "transaction" ? async () => { throw timeout; } : Reflect.get(target, key)) }) as Db;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setDbForTests(slow);
    try {
      const html = await render(OpsPage({ searchParams: Promise.resolve({ batch: batch.id, lifetime: "1" }) }));
      expect(html.split(REPORT_UNAVAILABLE.replace(/'/g, "&#x27;")).length - 1).toBe(4);
      expect(html).toContain("October drop");
    } finally { setDbForTests(db); warn.mockRestore(); }
  });

  it("ignores a batch parameter that is not an id", async () => {
    await world();
    const html = await render(OpsPage({ searchParams: Promise.resolve({ batch: "x'; drop table" }) }));
    expect(html).toContain("Choose a batch");
    expect(html).not.toContain("This batch was not found");
  });
});

describe("batch page and Details", () => {
  it("keeps the cost line as it is and adds a full-cost line whose parts add up to its own total", async () => {
    const { batch } = await world();
    const [costed] = await db.update(catalogBatches).set({ cost: { ...batch.cost, qaUsd: 0.001, computeUsd: 0.0006 } }).where(eq(catalogBatches.id, batch.id)).returning();
    const stages = await batchCostByStage(db, batch.id);
    const { usd, parts } = fullCostParts(stages);
    expect(parts.reduce((sum, p) => sum + p.usd, 0)).toBeCloseTo(usd, 12);
    expect(usd).toBeCloseTo(stages.reduce((sum, s) => sum + s.usd, 0), 12);
    const full = fullCostText(stages, 85)!;
    expect(full).toBe(`Full cost including the cut-out service: INR ${inrAmount(0.0056 * 85)} (cut-out INR ${inrAmount(0.004 * 85)}, images INR ${inrAmount(0.0006 * 85)}, quality checks INR ${inrAmount(0.001 * 85)})`);
    expect(fullCostText(stages, null)).toBe(`Full cost including the cut-out service: USD ${usdAmount(0.0056)} (cut-out USD ${usdAmount(0.004)}, images USD ${usdAmount(0.0006)}, quality checks USD ${usdAmount(0.001)})`);
    expect(fullCostText([], 85)).toBeNull();
    // The existing cost line (quality checks and worker time per style, against INR 60) is unchanged.
    const line = await batchCostLine(costed!, db);
    expect(line.usd).toBeCloseTo(0.0016, 12);
    const costLine = renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: line.usdPerIdentifier, inrPerIdentifier: line.inrPerIdentifier, usd: line.usd, inr: line.inr } }));
    const html = await render(BatchPage({ params: Promise.resolve({ id: batch.id }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Cost so far");
    expect(html).toContain(costLine);
    expect(html).toContain(`${costLine}<p class="cost-split">${full}</p>`);
    expect(html).not.toMatch(MODEL_WORDS);
  });

  it("shows chunk progress, the last chunk that gave up, the batch error and the logs link", async () => {
    const { batch } = await world();
    const chunks = await batchChunkSummary(batch.id, db);
    expect(chunkProgressText(chunks.counts)).toBe("cut-out: 1 waiting · image making: 1 running · quality check: 1 gave up");
    const html = renderToStaticMarkup(createElement(DetailsTab, {
      id: batch.id, brand: "uspa", isTest: false, counts: EMPTY_BATCH_COUNTS, failures: [], recheckFailures: [], notRefreshedChannels: [], hasReport: false,
      chunks: chunks.counts, lastFailedChunk: chunks.lastFailed, batchError: "No progress for 2 hours. Start the batch again.",
    }));
    expect(html).toContain("Work groups (chunks): 3 in total");
    expect(html).toContain("Chunk 3 (quality check) gave up after repeated errors: model A timed out after 60 s.");
    expect(html).toContain("Last problem recorded for this batch: No progress for 2 hours. Start the batch again.");
    expect(logsUrl(batch.id)).toBe(`https://console.cloud.google.com/logs/query;query=labels.batchId%3D%22${batch.id}%22;duration=P7D?project=image-links-agent`);
    expect(html).toContain(`href="${logsUrl(batch.id)}"`);
    expect(html).not.toMatch(MODEL_WORDS);
  });
});

describe("health lines (spec 17 3.1.5)", () => {
  it("sums silent outputs and held siblings from the batch counts and names the slowest running chunk of an active batch", async () => {
    const { batch } = await world();
    await db.insert(catalogBatches).values({ name: "Old", brandSlug: "uspa", brandName: "USPA", channels: ["noon"], createdBy: "a@opptra.com", status: "done", counts: { ...EMPTY_BATCH_COUNTS, silentOutputs: 2, heldSiblings: 5 } as typeof EMPTY_BATCH_COUNTS });
    await db.update(catalogBatches).set({ counts: { ...EMPTY_BATCH_COUNTS, heldSiblings: 3, slowestChunkMs: 14 * 60_000 } as typeof EMPTY_BATCH_COUNTS }).where(eq(catalogBatches.id, batch.id));
    const h = await healthSummary(db);
    // The running batch has no pinned route (started before the enlargement stage): spec 18 counts it.
    expect(h).toEqual({ silentOutputs: 2, heldSiblings: 8, slowest: { stage: "render", ms: 14 * 60_000, batchId: batch.id }, enlargeWaiting: 0, enlargeFailed: 0, enlargeWaitingLong: 0, plainAccepted: 0, startedBeforeEnlargement: 1 });
    expect(healthLines(h, null)).toEqual([
      "Silent outputs: 2",
      "Held with the product (waiting for the operator): 8",
      `Slowest running chunk: image making, 14 min (batch ${batch.id.slice(0, 8)})`,
      "GPU candidate revision: none",
      "Enlargements waiting: 0",
      "Enlargements failed: 0",
      "Running batches started before enlargement: 1",
    ]);
  });

  it("says none when nothing is slow, and shows the candidate revision from Cloud Run, or the plain sentence when it cannot be read", async () => {
    expect(healthLines(await healthSummary(db), "catalog-matting-gpu-00008-xyz")).toEqual([
      "Silent outputs: 0", "Held with the product (waiting for the operator): 0", "Slowest running chunk: none", "GPU candidate revision: catalog-matting-gpu-00008-xyz",
      "Enlargements waiting: 0", "Enlargements failed: 0",
    ]);
    const read = vi.fn(async () => ({ trafficStatuses: [{ revision: "catalog-matting-gpu-00007-abc", percent: 100 }, { tag: "candidate", revision: "catalog-matting-gpu-00008-xyz", percent: 0 }] }));
    setCloudRunReadForTests(read);
    expect(await gpuCandidateRevision(NOW)).toBe("catalog-matting-gpu-00008-xyz");
    expect(read).toHaveBeenCalledWith(GPU_SERVICE_PATH);
    resetOpsCostCache();
    setCloudRunReadForTests(async () => { throw new Error("PERMISSION_DENIED"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await gpuCandidateRevision(NOW)).toBeUndefined();
    expect(healthLines(await healthSummary(db), undefined)[3]).toBe(`GPU candidate revision: ${REPORT_UNAVAILABLE}`);
  });

  it("spec 18: counts the wanted enlargements waiting and failed in live batches (done included, a Try again), long waits and plain accepts, with no model id", async () => {
    const { batch } = await world();
    await db.update(catalogBatches).set({ options: { ...batch.options, enlargement: { model: "swinir-x2", minScale: 1.5 } } }).where(eq(catalogBatches.id, batch.id));
    const [product] = await db.insert(catalogProducts).values({ brandSlug: "uspa", isTest: false, productKey: "X2", pathKey: "x-2", identifier: "X-2" }).returning();
    const photos = await db.insert(catalogSourceImages).values([1, 2, 3, 4, 5].map((n) => ({ productId: product!.id, batchId: batch.id, n, sha256: `x2-${n}`, originalName: `X-2_${n}.jpg`, rawUri: "gs://b/r", mime: "image/jpeg" }))).returning();
    const row = (i: number, extra: Partial<typeof catalogEnlargements.$inferInsert>) => ({ batchId: batch.id, productId: product!.id, sourceImageId: photos[i]!.id, upscaler: "swinir-x2+cpu", factor: 2, scale: 1.8, outW: 1600, outH: 1600, route: "direct" as const, pixelHash: `p${i}`, identityHash: `i${i}`, ...extra });
    await db.insert(catalogEnlargements).values([
      row(0, {}), row(1, { attempts: 3, createdAt: new Date(Date.now() - 21 * 60 * 60_000) }), row(2, { status: "failed", attempts: 8 }), row(3, { status: "done" }), row(4, { wanted: false }),
    ]);
    const h = await healthSummary(db);
    expect(h).toMatchObject({ enlargeWaiting: 2, enlargeFailed: 1, enlargeWaitingLong: 1, startedBeforeEnlargement: 0 });
    const lines = healthLines(h, null);
    expect(lines.slice(4)).toEqual(["Enlargements waiting: 2", "Enlargements failed: 1", "Enlargements waiting more than 20 h: 1"]);
    expect(lines.join(" ")).not.toMatch(/swinir|realesrgan/);
    await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, batch.id));
    expect(await healthSummary(db)).toMatchObject({ enlargeWaiting: 2, enlargeFailed: 1 });
    await db.update(catalogBatches).set({ status: "failed" }).where(eq(catalogBatches.id, batch.id));
    expect(await healthSummary(db)).toMatchObject({ enlargeWaiting: 0, enlargeFailed: 0, enlargeWaitingLong: 0 });
  });

  it("the Ops page shows the four lines with no model id", async () => {
    await world();
    const html = await render(OpsPage({ searchParams: Promise.resolve({}) }));
    for (const text of ["Silent outputs: 0", "Held with the product (waiting for the operator): 0", "Slowest running chunk: none", "GPU candidate revision: none"]) expect(html).toContain(text);
    expect(html).not.toMatch(MODEL_WORDS);
  });
});
