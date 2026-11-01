// Large-batch scale test (2026-11-01, the 25,476-row USPA sheet): one processed batch of 25,000 products with 3 photos
// each (75,000 photos) on one channel, seeded straight in SQL. The finalize and progress paths must stay well inside
// their deadlines with a fixed number of queries, not one per product: buildReport, refreshBatchProgress and a whole
// finalize (sheet, re-check in budgeted parts, done write). SCALE_PRODUCTS sets another size.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import type { Logger } from "drizzle-orm/logger";
import type { Db } from "@catalog/core/db/client";
import { createDbFromPglite } from "@catalog/core/db/testing";
import { runMigrations } from "@catalog/core/db/migrate";
import { catalogBatches } from "@catalog/core/db/schema";
import { buildReport } from "@catalog/core/catalog/pipeline/report";
import { seedLargeBatch } from "@catalog/core/catalog/pipeline/large-batch-fixture";
import { PROGRESS_REFRESH_INTERVAL_MS, refreshBatchProgress } from "./deps";
import { handleFinalizeTask } from "./finalize";
import { fakeWorld } from "../../test/catalog-fakes";

const PRODUCTS = Number(process.env.SCALE_PRODUCTS ?? 25_000), PHOTOS = 3;
let db: Db, close: () => Promise<void>, queries = 0, batchId = "";
const counter: Logger = { logQuery: () => { queries++; } };
const batchRow = async () => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)))[0]!;

beforeAll(async () => {
  const made = createDbFromPglite(undefined, { logger: counter });
  db = made.db; close = () => made.client.close();
  await runMigrations(db);
  ({ batchId } = await seedLargeBatch(db, { products: PRODUCTS, photosPerProduct: PHOTOS, channels: ["noon"], status: "qa", earlierLive: 500, oldChannel: "amazon" }));
}, 600_000);
afterAll(async () => { await close(); });

describe(`a ${PRODUCTS.toLocaleString("en")}-product batch`, () => {
  it("buildReport reads the batch in a fixed number of queries and well inside a request", async () => {
    const before = queries, t = performance.now();
    const built = await buildReport(db, batchId, { recheck: { ok: 0, total: 0, failures: [] }, exports: { xlsx: "x", csv: "c", report: "r", filledProductList: null, exportsMatch: true } });
    const ms = performance.now() - t, used = queries - before;
    console.log(`buildReport: ${Math.round(ms)} ms, ${used} queries`);
    expect(built.sheet.rows).toHaveLength(PRODUCTS);
    expect(built.batch.counts.verified).toBe(PRODUCTS * PHOTOS);
    expect(built.report.notRefreshedChannels).toEqual([expect.objectContaining({ channel: "amazon", lastBatchName: "earlier delivery" })]);
    expect(used).toBeLessThanOrEqual(12);
    // Per-product searches over every output took minutes here (25k x 75k); the build is now one pass.
    expect(ms).toBeLessThan(60_000);
  }, 300_000);

  it("refreshBatchProgress counts once per interval with one cheap query for every other call, and exactly when forced", async () => {
    const now = new Date();
    const t0 = performance.now(), q0 = queries;
    await refreshBatchProgress(db, batchId, now);
    const firstMs = performance.now() - t0, firstQueries = queries - q0;
    expect((await batchRow()).counts).toMatchObject({ verified: PRODUCTS * PHOTOS, prepared: PRODUCTS * PHOTOS, progressRefreshedAt: now.toISOString() });
    // 200 more deliveries within the interval: one row read each, no count of the batch.
    const t1 = performance.now(), q1 = queries;
    for (let i = 0; i < 200; i++) await refreshBatchProgress(db, batchId, new Date(+now + 10 * i));
    const throttledMs = (performance.now() - t1) / 200, throttledQueries = queries - q1;
    console.log(`refreshBatchProgress: counted ${Math.round(firstMs)} ms in ${firstQueries} queries; throttled ${throttledMs.toFixed(2)} ms and ${throttledQueries / 200} queries per call`);
    expect(throttledQueries).toBe(200);
    expect(throttledMs).toBeLessThan(25);
    expect(firstQueries).toBeLessThanOrEqual(10);
    // A change shows with the first call of the next interval, and at once when forced.
    await db.execute(sql`UPDATE catalog_outputs SET status = 'needs_attention' WHERE id IN (SELECT id FROM catalog_outputs WHERE batch_id = ${batchId}::uuid LIMIT 7)`);
    await refreshBatchProgress(db, batchId, new Date(+now + 1_000));
    expect((await batchRow()).counts.needsAttention).toBe(0);
    await refreshBatchProgress(db, batchId, new Date(+now + PROGRESS_REFRESH_INTERVAL_MS));
    expect((await batchRow()).counts.needsAttention).toBe(7);
    await db.execute(sql`UPDATE catalog_outputs SET status = 'verified' WHERE batch_id = ${batchId}::uuid AND status = 'needs_attention'`);
    await refreshBatchProgress(db, batchId, new Date(+now + PROGRESS_REFRESH_INTERVAL_MS + 1), { force: true });
    expect((await batchRow()).counts.needsAttention).toBe(0);
  }, 300_000);

  it("finalize writes the sheet and re-checks every link in budgeted parts, each well inside the 900 s deadline", async () => {
    await db.update(catalogBatches).set({ status: "publishing" }).where(eq(catalogBatches.id, batchId));
    const w = fakeWorld(db);
    let fetched = 0;
    // SCALE_HANDOFF=1: each link answers after about 2 ms and the budget is 20 s, so the re-check runs in several
    // hand-offs at full size (about 13 parts of 20 to 27 s on a dev laptop, 5 minutes). By default the links answer at
    // once and the whole finalize fits one part; the hand-off itself is covered in pipeline.test.ts.
    const handoff = process.env.SCALE_HANDOFF === "1";
    w.deps.fetch = (async () => { fetched++; if (handoff) await new Promise((resolve) => setTimeout(resolve, 2)); return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } }); }) as typeof fetch;
    // Production's budget is 420 s of real link reads; each part re-checks for at least a quarter of it.
    w.deps.finalizeTimeBudgetMs = handoff ? 20_000 : 120_000;
    const parts: { outcome: string; ms: number }[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now(), result = await handleFinalizeTask(w.deps, { batchId });
      parts.push({ outcome: result.outcome!, ms: performance.now() - t });
      if (result.outcome !== "rechecking") break;
      // The hand-off queued the next part as a named task.
      expect(w.tasks.at(-1)).toMatchObject({ route: "/tasks/catalog/finalize", body: { batchId } });
    }
    const checked = w.log.mock.calls.filter(([message]) => message === "finalize re-check continues").map(([, fields]) => fields!.checked);
    console.log(`finalize: ${parts.length} parts (${parts.map(p => `${p.outcome} ${Math.round(p.ms / 1000)} s`).join(", ")}), links checked after each hand-off ${checked.join(", ")}`);
    expect(parts.at(-1)!.outcome).toBe("done");
    if (handoff && PRODUCTS >= 20_000) expect(parts.length).toBeGreaterThan(1);
    expect(fetched).toBe(PRODUCTS * PHOTOS);
    expect(Math.max(...parts.map(p => p.ms))).toBeLessThan(120_000);
    const done = await batchRow();
    expect(done.status).toBe("done");
    expect(done.counts).toMatchObject({ recheckOk: PRODUCTS * PHOTOS, recheckTotal: PRODUCTS * PHOTOS, verified: PRODUCTS * PHOTOS, finalizePending: false });
    expect(done.counts).not.toHaveProperty("finalizeResume");
    expect(done.counts).not.toHaveProperty("progressRefreshedAt");
  }, 900_000);
});
