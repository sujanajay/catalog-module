// The admin Ops page, the batch page's cost split and the Details additions, on PGlite with real core
// cost queries. AutoRefresh needs the App Router, which a static render does not have, so the router is
// stubbed; everything else (the page, its queries, requireRole) is the real code.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogChunks, catalogCostEvents, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { recordCostEvents } from "@catalog/core/cost-events";
import { batchCostAttribution, batchCostByStage } from "@catalog/core/catalog/cost-report";
import { inrAmount, usdAmount } from "@catalog/core/catalog/cost";
import type { Role } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { ForbiddenError } from "../lib/errors";
import { activeBatches, recentFailures, resetOpsCostCache, batchChunkSummary, costOverview } from "../lib/catalog/ops";
import { chunkProgressText, logsUrl, money, stageSplitText } from "../lib/catalog/ops-copy";
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
  await db.delete(catalogCostEvents); await db.delete(catalogOutputs); await db.delete(catalogSourceImages); await db.delete(catalogProducts); await db.delete(catalogBatches);
});
afterEach(() => { resetUserDeps(); vi.unstubAllEnvs(); });

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
    expect(html).toContain("% of the daily limit");
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
    const first = await costOverview(db, NOW);
    await recordCostEvents(db, [{ batchId: batch.id, brandSlug: "uspa", isTest: false, stage: "qa", kind: "llm_call", engine: "x", usd: 1 }]);
    expect(await costOverview(db, new Date(+NOW + 30_000))).toBe(first);
    expect((await costOverview(db, new Date(+NOW + 6 * 60_000))).brands[0]!.usd).toBeGreaterThan(first.brands[0]!.usd);
    // The live parts read fresh on every call.
    expect((await activeBatches(db))[0]!.usd).toBeGreaterThan(1);
    expect((await recentFailures(db, NOW)).chunks).toHaveLength(1);
  });

  it("ignores a batch parameter that is not an id", async () => {
    await world();
    const html = await render(OpsPage({ searchParams: Promise.resolve({ batch: "x'; drop table" }) }));
    expect(html).toContain("Choose a batch");
    expect(html).not.toContain("This batch was not found");
  });
});

describe("batch page and Details", () => {
  it("adds a cost split by step under the cost line from batchCostByStage", async () => {
    const { batch } = await world();
    const stages = await batchCostByStage(db, batch.id);
    const split = stageSplitText(stages, 85)!;
    expect(split).toBe(`By step: cut-out INR ${inrAmount(0.004 * 85)}, images INR ${inrAmount(0.0006 * 85)}, quality checks INR ${inrAmount(0.001 * 85)}`);
    expect(stageSplitText(stages, null)).toBe(`By step: cut-out USD ${usdAmount(0.004)}, images USD ${usdAmount(0.0006)}, quality checks USD ${usdAmount(0.001)}`);
    expect(stageSplitText([], 85)).toBeNull();
    const html = await render(BatchPage({ params: Promise.resolve({ id: batch.id }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Cost so far");
    expect(html).toContain(split);
    expect(html).toContain("agency reference INR 60 per style");
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
    expect(logsUrl(batch.id)).toBe(`https://console.cloud.google.com/logs/query;query=labels.batchId%3D%22${batch.id}%22?project=image-links-agent`);
    expect(html).toContain(`href="${logsUrl(batch.id)}"`);
    expect(html).not.toMatch(MODEL_WORDS);
  });
});
