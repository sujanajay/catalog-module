// Spec 16 F4: the local scale test.
// Part 1, the model (scale-model.ts, simulated time, no database): the F2 shape at 200, 2,000 and 7,000 products,
// with an operator batch started behind the big one. It checks the drain times against spec 16's estimates, the
// operator batch rule, the window, the 900 s deadline and the judge's 429 rate.
// Part 2, the real handlers (PGlite + fakes, two FIFO queues with their slots, photos at once): the pipeline drains
// with every photo cut out and rendered exactly once, no ownership-changed discard, no duplicate or stale task, the
// window held, and the operator batch done long before the bulk batch. A small size runs in `pnpm test`; set
// SCALE_PRODUCTS (for example 2000) for the full size, which takes about 15 minutes on one test thread. From
// 1,000 products it uses the F2 slots and window (SCALE_SHAPE=full or small picks one at any size), and
// SCALE_PROGRESS_MS prints progress. The fake photos are small (imageScale), because the real cut-out checks scan
// every pixel on the one thread the whole drain shares.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, count, eq, isNotNull, notInArray } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogSourceImages } from "@catalog/core/db/schema";
import { classifyOutputs, completionLine } from "@catalog/core/catalog/load/classify";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import { dispatchChunks, LOAD_BATCH_NAME_PREFIX } from "@catalog/core/catalog/pipeline/dispatch";
import { handleChunkTask } from "./chunk";
import { F2_SHAPE, F2_UPSCALE_MS, simulate, upscaleP50Ms, type ModelBatch, type ModelShape } from "./scale-model";
import { fakeWorld, seedBatch, type FakeWorld, type QueuedTask } from "../../test/catalog-fakes";

const MIN = 60_000;

describe("F4 part 1: the model at the F2 shape", () => {
  const behind = (products: number): ModelBatch[] => [
    { name: "bulk", products, photosPerProduct: 5, channels: 4, startAtMs: 0 },
    { name: "operator", products: 10, photosPerProduct: 5, channels: 4, startAtMs: 30_000 },
  ];

  it("7,000 and 2,000 products drain near spec 16's estimates; every photo once; no delivery near 900 s; judge 429 under 2% after retries", async () => {
    // Spec 16 section 1: 7,000 in about 3 h 20 min (range 3 h to 4 h 10), 2,000 in about 65 min (55 to 85). The model
    // has no finalize step and a fixed GPU warm-up, so it lands at the fast end; the bands below are the spec's
    // ranges widened by 10% at the bottom. Its numbers go in the build report next to the estimates.
    const big = await simulate(F2_SHAPE, behind(7000));
    const mid = await simulate(F2_SHAPE, behind(2000));
    expect(big.drainedAtMs.bulk! / MIN).toBeGreaterThan(180 * 0.9);
    expect(big.drainedAtMs.bulk! / MIN).toBeLessThan(250);
    expect(mid.drainedAtMs.bulk! / MIN).toBeGreaterThan(55 * 0.9);
    expect(mid.drainedAtMs.bulk! / MIN).toBeLessThan(85);
    for (const r of [big, mid]) {
      expect(r.mattedTwice).toBe(0);
      expect(r.maxDeliveryMs).toBeLessThan(F2_SHAPE.deadlineMs);
      expect(r.maxActiveChunks.bulk).toBeLessThanOrEqual(F2_SHAPE.bulkWindow);
      expect(r.maxActiveChunks.operator).toBeLessThanOrEqual(F2_SHAPE.operatorWindow);
      expect(r.judge.failedAfterRetries / r.judge.calls).toBeLessThan(0.02);
      // Stage fairness: render runs while matte still runs (one stage never waits for the other to finish).
      expect(r.renderOverlapsMatteMs.bulk!).toBeGreaterThan(0.8 * r.drainedAtMs.bulk!);
    }
    // The GPU is the limit: about 3.4 photos a second at the plan's 85% busy.
    expect(big.bestThreeMinutesPhotosPerMinute).toBeGreaterThan(190);
    expect(big.bestThreeMinutesPhotosPerMinute).toBeLessThan(250);
  }, 120_000);

  it("a 10-product operator batch behind a 7,000-product bulk batch makes its first image before the bulk batch's 40th chunk starts", async () => {
    const r = await simulate(F2_SHAPE, behind(7000), 7);
    expect(r.firstImageAtMs.operator!).toBeLessThan(r.chunkStartedAtMs.bulk![39]!);
    expect(r.drainedAtMs.operator! / MIN).toBeLessThan(10);
  }, 120_000);

  it("the 200-product shape lands near the section 9 estimate (12 to 15 minutes, at least 150 photos a minute at best)", async () => {
    const r = await simulate(F2_SHAPE, [{ name: "bulk", products: 200, photosPerProduct: 5, channels: 4, startAtMs: 0, bulk: true }]);
    expect(r.drainedAtMs.bulk! / MIN).toBeGreaterThan(12 * 0.75);
    expect(r.drainedAtMs.bulk! / MIN).toBeLessThan(15 * 1.1);
    expect(r.bestThreeMinutesPhotosPerMinute).toBeGreaterThanOrEqual(150);
  }, 60_000);
});

describe("spec 18 3.3.8: the enlarge queue in the model", () => {
  it("UPSCALE_P50_S sets one upscale's time; unset keeps the F2 calibration's 7 s", () => {
    expect(upscaleP50Ms({})).toBe(F2_UPSCALE_MS);
    expect(upscaleP50Ms({ UPSCALE_P50_S: "121" })).toBe(121_000);
    expect(upscaleP50Ms({ UPSCALE_P50_S: "x" })).toBe(F2_UPSCALE_MS);
  });

  it("200 products on CPU (121 s per enlargement): every enlargement settles before its render, every parked chunk is unparked once, the time shows", async () => {
    // The H3 shape: concurrency 3, the enlarge lanes 4 + 12 at 0.1 per second, catalog-upscale 16 x 1.
    const h3: ModelShape = { ...F2_SHAPE, workerConcurrency: 3, cpuService: { ...F2_SHAPE.cpuService, upscaleMs: 121_000 }, enlarge: { operatorSlots: 4, bulkSlots: 12, ratePerSecond: 0.1, serviceSlots: 16 } };
    const batches: ModelBatch[] = [{ name: "bulk", products: 200, photosPerProduct: 5, channels: 4, startAtMs: 0, bulk: true }];
    const r = await simulate(h3, batches);
    expect(r.enlarge.tasks).toBeGreaterThan(400);
    expect(r.enlarge.renderedEarly).toBe(0);
    expect(r.enlarge.parks).toBeGreaterThan(0);
    expect(r.enlarge.unparks).toBe(r.enlarge.parks);
    expect(r.mattedTwice).toBe(0);
    expect(r.maxActiveChunks.bulk).toBeLessThanOrEqual(h3.bulkWindow);
    // About 500 enlargements at 0.1 per second: at least 80 minutes, against 12 to 15 with the old inline 7 s.
    expect(r.drainedAtMs.bulk! / MIN).toBeGreaterThan(80);
    expect(Number.isFinite(r.drainedAtMs.bulk!)).toBe(true);
  }, 120_000);
});

// ------------------------------------------------------------------------------------------------------------
let db: Db, close: () => Promise<void>;
const bucketEnv = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const [key, value] of Object.entries(bucketEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await close(); });

/** Runs the queued tasks on two FIFO queues with `slots` each, until both are empty and nothing runs. */
function runQueues(w: FakeWorld, slots: { operator: number; bulk: number }, handle: (task: QueuedTask) => Promise<{ httpStatus: number }>): Promise<void> {
  const running = { operator: 0, bulk: 0 };
  const runnable = (t: QueuedTask) => t.route !== "/tasks/catalog/finalize";
  return new Promise<void>((resolve, reject) => {
    const pump = () => {
      for (const cls of ["operator", "bulk"] as const) {
        while (running[cls] < slots[cls]) {
          const i = w.tasks.findIndex((t) => runnable(t) && (t.bulk ? "bulk" : "operator") === cls);
          if (i < 0) break;
          const [task] = w.tasks.splice(i, 1);
          running[cls] += 1;
          handle(task!).then((result) => {
            running[cls] -= 1;
            if (result.httpStatus >= 500 && task!.retryCount < 4) w.tasks.push({ ...task!, retryCount: task!.retryCount + 1 });
            pump();
          }, reject);
        }
      }
      if (!running.operator && !running.bulk && !w.tasks.some(runnable)) resolve();
    };
    pump();
  });
}

describe("F4 part 2: the real handlers drain a bulk batch and an operator batch together", () => {
  const products = Number(process.env.SCALE_PRODUCTS ?? 12), full = process.env.SCALE_SHAPE ? process.env.SCALE_SHAPE === "full" : products >= 1000;
  const shape = full ? { slots: { operator: 8, bulk: 36 }, window: { operator: 8, bulk: 30 }, photos: 4 } : { slots: { operator: 2, bulk: 4 }, window: { operator: 2, bulk: 6 }, photos: 3 };

  it(`${products} bulk products (5 photos, 4 channels) and a 3-product operator batch: every photo once, no lost claim, window held, operator first`, async () => {
    vi.stubEnv("CATALOG_CHUNK_WINDOW", String(shape.window.operator)); vi.stubEnv("CATALOG_BULK_WINDOW", String(shape.window.bulk));
    try {
      const w = fakeWorld(db, 1, { imageScale: 0.1 });
      w.deps.photoConcurrency = shape.photos;
      const channels = ["noon", "amazon", "namshi", "trendyol"] as const;
      const bulk = await seedBatch(db, w, `${LOAD_BATCH_NAME_PREFIX}scale`, Array.from({ length: Math.ceil(products / 2) }, (_, i) => (i * 2 + 1 < products ? [5, 5] : [5])), { channels: [...channels] });
      const operator = await seedBatch(db, w, "scale-operator", [[5, 5], [5]], { channels: [...channels] });
      await dispatchChunks(db, w.deps.enqueue, bulk.batch.id);
      await dispatchChunks(db, w.deps.enqueue, operator.batch.id);
      const finished: string[] = [];
      let windowBreaks = 0;
      // SCALE_PROGRESS_MS (for example 60000) prints the drain's progress while a long run works.
      const t0 = Date.now(); let handled = 0, handlerMs = 0;
      const progress = process.env.SCALE_PROGRESS_MS ? setInterval(() => {
        const outcomes: Record<string, number> = {};
        for (const d of w.deliveries()) outcomes[String(d.outcome)] = (outcomes[String(d.outcome)] ?? 0) + 1;
        const owned = w.log.mock.calls.filter(([, f]) => JSON.stringify(f ?? {}).includes("ownership changed")).length;
        process.stderr.write(`[scale] t=${Math.round((Date.now() - t0) / 1000)}s chunksDone=${finished.length} tasks=${handled} avgTaskMs=${handled ? Math.round(handlerMs / handled) : 0} queued=${w.tasks.length} deliveries=${JSON.stringify(outcomes)} ownershipChanged=${owned}\n`);
        handled = 0; handlerMs = 0;
      }, Number(process.env.SCALE_PROGRESS_MS)) : undefined;
      await runQueues(w, shape.slots, async (task) => {
        const h0 = Date.now();
        try {
          if (task.route === "/tasks/catalog/publish") return { httpStatus: 200 };
          const chunkId = String(task.body.chunkId);
          const [chunk] = await db.select({ batchId: catalogChunks.batchId }).from(catalogChunks).where(eq(catalogChunks.id, chunkId));
          const [active] = await db.select({ n: count() }).from(catalogChunks).where(and(eq(catalogChunks.batchId, chunk!.batchId), isNotNull(catalogChunks.dispatchedAt), notInArray(catalogChunks.status, ["done", "failed"])));
          if (active!.n > (chunk!.batchId === bulk.batch.id ? shape.window.bulk : shape.window.operator)) windowBreaks += 1;
          const result = await handleChunkTask(w.deps, task.body, { retryCount: task.retryCount });
          const [after] = await db.select({ status: catalogChunks.status }).from(catalogChunks).where(eq(catalogChunks.id, chunkId));
          if (after!.status === "done") finished.push(chunk!.batchId);
          return result;
        } finally { handled += 1; handlerMs += Date.now() - h0; }
      }).finally(() => clearInterval(progress));
      // Drained: every chunk done, every photo cut out once and every image rendered once.
      for (const b of [bulk, operator]) {
        const chunks = await db.select({ status: catalogChunks.status }).from(catalogChunks).where(eq(catalogChunks.batchId, b.batch.id));
        expect(chunks.every((c) => c.status === "done")).toBe(true);
        const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, b.batch.id));
        expect(sources.every((s) => s.matteUri !== null)).toBe(true);
        const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, b.batch.id));
        expect(outputs).toHaveLength(sources.length * channels.length);
        expect(outputs.every((o) => o.status === "staged" && o.qaScores !== null)).toBe(true);
      }
      const totalPhotos = (products + 3) * 5;
      const matteUploads = [...w.uploads.entries()].filter(([uri]) => uri.includes("/derived/") || uri.endsWith("matte.png"));
      expect(matteUploads).toHaveLength(totalPhotos);
      expect(matteUploads.every(([, n]) => n === 1)).toBe(true);
      expect(vi.mocked(w.deps.matteFor)).toHaveBeenCalledTimes(totalPhotos);
      expect(vi.mocked(w.deps.renderAllChannels)).toHaveBeenCalledTimes(totalPhotos * channels.length);
      // No discarded work and no second copy of any task.
      const outcomes = new Set(w.deliveries().map((d) => d.outcome));
      expect([...outcomes]).toEqual(["done"]);
      expect(w.log.mock.calls.some(([, fields]) => JSON.stringify(fields ?? {}).includes("Chunk ownership changed"))).toBe(false);
      expect(windowBreaks).toBe(0);
      // One publish task per product, each on its batch's queue.
      expect(w.enqueue.mock.calls.filter(([route]) => route === "/tasks/catalog/publish")).toHaveLength(products + 3);
      // Not starved: the operator batch's last chunk finishes before the bulk batch is half done.
      const lastOperator = finished.lastIndexOf(operator.batch.id), bulkBefore = finished.slice(0, lastOperator).filter((id) => id === bulk.batch.id).length;
      expect(bulkBefore).toBeLessThan(bulk.chunks.length / 2);
      // Photos really ran at once.
      expect(w.peakMatte()).toBeGreaterThan(1);

      // Spec 17 section 7, one hold: the publish route is skipped here, so publishing is stood in for by
      // setting every output verified, except one product held for the operator (one forced needs_attention).
      // Its other outputs stay staged as held siblings: the load report counts them apart, silent stays 0.
      const heldProduct = operator.chunks[0]!.productIds[0]!;
      await db.update(catalogOutputs).set({ status: "verified", isLive: true }).where(and(eq(catalogOutputs.batchId, operator.batch.id), notInArray(catalogOutputs.productId, [heldProduct])));
      const [forced] = await db.select({ id: catalogOutputs.id }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, operator.batch.id), eq(catalogOutputs.productId, heldProduct))).limit(1);
      await db.update(catalogOutputs).set({ status: "needs_attention", reason: "Check the edge." }).where(eq(catalogOutputs.id, forced!.id));
      await db.update(catalogBatchProducts).set({ change: "pending_attention" }).where(and(eq(catalogBatchProducts.batchId, operator.batch.id), eq(catalogBatchProducts.productId, heldProduct)));
      await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, operator.batch.id));
      const pairs = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, operator.batch.id));
      const classified = classifyOutputs(await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, operator.batch.id)), new Set(pairs.filter((p) => p.change === "pending_attention").map((p) => p.productId)));
      expect(classified.heldSiblings.length).toBeGreaterThan(0);
      expect(classified.silent).toEqual([]);
      expect(completionLine(classified)).toBe(`Held with the product (waiting for the operator): ${classified.heldSiblings.length}. Silent outputs (must be none): 0.`);
      const now = new Date();
      const scoped = await runInvariants(db, vi.fn(), now, { batchId: operator.batch.id });
      expect(scoped.counts.silent_outputs).toBe(0);
      expect(scoped.results.filter((r) => r.severity === "ERROR" && r.violations > 0)).toEqual([]);

      // One slow chunk: a bulk chunk of a still-processing batch running for 11 minutes while the batch's finished chunks took seconds.
      const [slow] = await db.select({ id: catalogChunks.id }).from(catalogChunks).where(eq(catalogChunks.batchId, bulk.batch.id)).limit(1);
      await db.update(catalogChunks).set({ status: "running", startedAt: new Date(+now - 11 * MIN), finishedAt: null }).where(eq(catalogChunks.id, slow!.id));
      await db.update(catalogBatches).set({ status: "rendering" }).where(eq(catalogBatches.id, bulk.batch.id)); // the check watches processing batches only
      const slowRun = await runInvariants(db, vi.fn(), now, { batchId: bulk.batch.id });
      expect(slowRun.counts.slow_chunk).toBe(1);
      expect(slowRun.results.find((r) => r.id === "slow_chunk")!.sample).toEqual([slow!.id]);
    } finally { vi.unstubAllEnvs(); }
  }, Math.max(180_000, products * 2_000));
});
