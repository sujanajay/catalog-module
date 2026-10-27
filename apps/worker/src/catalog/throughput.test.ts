// Tier 2 (PGlite + fakes): spec 16 F3, photos at once inside a chunk delivery, the bulk class and queue, the
// window by class, the heartbeat under parallel photos, the compute line and the CPU upscale price.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogChunks, catalogCostEvents, catalogOutputs, catalogSourceImages } from "@catalog/core/db/schema";
import { dispatchChunks, LOAD_BATCH_NAME_PREFIX } from "@catalog/core/catalog/pipeline/dispatch";
import { upscalerId } from "@catalog/core/catalog/upscale";
import { DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND, DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND } from "@catalog/core/catalog/cost";
import type { CatalogDeps } from "./deps";
import { computeVcpuPerSecond, currentChunkTask, handleChunkTask } from "./chunk";
import { chunkRow, fakeWorld, seedBatch, type FakeWorld } from "../../test/catalog-fakes";

let db: Db, close: () => Promise<void>;
const bucketEnv = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const [key, value] of Object.entries(bucketEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await close(); });

/** Delivers the chunk's current step until it is done (each step once, no queue). */
async function toEnd(w: FakeWorld, chunkId: string, limit = 10) {
  for (let i = 0; i < limit; i++) {
    const row = await chunkRow(db, chunkId);
    if (row.status === "done" || row.status === "failed") return;
    expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunkId))).httpStatus).toBe(200);
  }
}
const outputsOf = (batchId: string) => db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId));
const sourcesOf = (batchId: string) => db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId)).orderBy(catalogSourceImages.n);

describe("F3: photos at once inside a delivery", () => {
  it("N=3 with one photo failing decode: the other two are cut out, rendered and judged; the failed one fails alone", async () => {
    const w = fakeWorld(db, 5);
    w.deps.photoConcurrency = 3;
    const s = await seedBatch(db, w, "f3-decode", [[3]], { channels: ["noon", "amazon"], corrupt: [2] });
    await toEnd(w, s.chunks[0]!.id);
    expect(w.peakMatte()).toBe(2);
    const sources = await sourcesOf(s.batch.id);
    expect(sources.map((x) => x.status)).toEqual(["matted", "failed", "matted"]);
    const outputs = await outputsOf(s.batch.id);
    expect(outputs.filter((o) => o.status === "failed").map((o) => o.sourceImageId)).toEqual([sources[1]!.id, sources[1]!.id]);
    expect(outputs.filter((o) => o.status !== "failed").every((o) => o.qaScores !== null && o.status === "staged")).toBe(true);
    expect((await chunkRow(db, s.chunks[0]!.id)).status).toBe("done");
    expect(w.tasks.filter((t) => t.route === "/tasks/catalog/publish")).toHaveLength(1);
    expect(w.deliveries().every((d) => d.outcome === "done")).toBe(true);
  }, 60_000);

  it("an ownership loss stops all N: no photo writes after the loss and the delivery answers lost", async () => {
    const w = fakeWorld(db, 5);
    w.deps.photoConcurrency = 3;
    const s = await seedBatch(db, w, "f3-lost", [[6]]);
    const id = s.chunks[0]!.id, matte = w.deps.matteFor;
    let stolen = false;
    w.deps.matteFor = vi.fn(async (...args: Parameters<CatalogDeps["matteFor"]>) => {
      // The first cut-out finds its chunk taken over (a sweep or another delivery).
      if (!stolen) { stolen = true; await db.update(catalogChunks).set({ taskName: "someone-else" }).where(eq(catalogChunks.id, id)); }
      return matte(...args);
    });
    const result = await handleChunkTask(w.deps, await currentChunkTask(db, id));
    expect(result).toEqual({ httpStatus: 200, outcome: "lost" });
    // Only the first wave started; none of them saved a matte, and no later photo started.
    expect(vi.mocked(w.deps.matteFor).mock.calls.length).toBeLessThanOrEqual(3);
    expect((await sourcesOf(s.batch.id)).every((x) => x.matteUri === null)).toBe(true);
    expect([...w.uploads.keys()].some((k) => k.endsWith("-matte.png") || k.includes("/derived/"))).toBe(false);
    expect(await chunkRow(db, id)).toMatchObject({ taskName: "someone-else", status: "running" });
  }, 60_000);

  it("cost sums with 4 photos at once equal the one-at-a-time run", async () => {
    vi.stubEnv("PRICE_MATTE_CPU_USD_PER_SECOND", "0.5");
    try {
      const sums = [];
      for (const n of [1, 4]) {
        const w = fakeWorld(db, 2);
        w.deps.photoConcurrency = n;
        const s = await seedBatch(db, w, `f3-cost-${n}`, [[5]], { channels: ["noon", "amazon"] });
        await toEnd(w, s.chunks[0]!.id);
        const rows = await db.select({ kind: catalogCostEvents.kind, n: sql<number>`count(*)::int`, usd: sql<string>`sum(${catalogCostEvents.usd})` }).from(catalogCostEvents)
          .where(and(eq(catalogCostEvents.batchId, s.batch.id), sql`${catalogCostEvents.kind} <> 'compute'`)).groupBy(catalogCostEvents.kind).orderBy(catalogCostEvents.kind);
        sums.push(rows.map((r) => ({ kind: r.kind, n: r.n, usd: Number(r.usd) })));
      }
      expect(sums[1]).toEqual(sums[0]);
      expect(sums[0]!.find((r) => r.kind === "matte_call")).toMatchObject({ n: 5 });
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);

  it("the time budget with photos at once: the first wave finishes, no new photo starts, the rest is handed off", async () => {
    const w = fakeWorld(db, 5);
    w.deps.photoConcurrency = 3;
    w.deps.chunkTimeBudgetMs = 1;
    const s = await seedBatch(db, w, "f3-budget", [[7]]);
    const id = s.chunks[0]!.id;
    const first = await handleChunkTask(w.deps, await currentChunkTask(db, id));
    expect(first.httpStatus).toBe(200);
    expect(w.deliveries("handed_off")).toHaveLength(1);
    const matted = (await sourcesOf(s.batch.id)).filter((x) => x.matteUri !== null).length;
    expect(matted).toBe(3);
    expect(vi.mocked(w.deps.matteFor)).toHaveBeenCalledTimes(3);
    w.deps.chunkTimeBudgetMs = undefined;
    await toEnd(w, id);
    // Every photo cut out exactly once across the hand-off.
    expect(vi.mocked(w.deps.matteFor)).toHaveBeenCalledTimes(7);
    expect([...w.uploads.entries()].filter(([k]) => k.includes("matte")).every(([, n]) => n === 1)).toBe(true);
  }, 60_000);

  it("the heartbeat keeps renewing while photos run in parallel, and stops once the claim is lost", async () => {
    const w = fakeWorld(db, 5);
    w.deps.photoConcurrency = 4;
    const s = await seedBatch(db, w, "f3-heartbeat", [[4]]);
    const id = s.chunks[0]!.id;
    let renew: (() => Promise<boolean>) | undefined;
    w.deps.heartbeat = (r) => { renew = r; return () => {}; };
    const matte = w.deps.matteFor, renewed: boolean[] = [];
    w.deps.matteFor = vi.fn(async (...args: Parameters<CatalogDeps["matteFor"]>) => { renewed.push(await renew!()); return matte(...args); });
    expect((await handleChunkTask(w.deps, await currentChunkTask(db, id))).outcome).toBe("done");
    expect(renewed).toEqual([true, true, true, true]);
    expect(w.deliveries("lost")).toHaveLength(0);
    await db.update(catalogChunks).set({ status: "running", taskName: "other" }).where(eq(catalogChunks.id, id));
    expect(await renew!()).toBe(false);
  }, 60_000);
});

describe("F3: the bulk class, its queue and its window", () => {
  it("a bulk batch's chunk and publish tasks are marked bulk and use the bulk window; an operator batch's are not", async () => {
    vi.stubEnv("CATALOG_CHUNK_WINDOW", "2"); vi.stubEnv("CATALOG_BULK_WINDOW", "5");
    try {
      const w = fakeWorld(db, 1);
      const bulk = await seedBatch(db, w, `${LOAD_BATCH_NAME_PREFIX}f3 a`, [[1], [1], [1], [1], [1], [1], [1]]);
      const operator = await seedBatch(db, w, "f3-operator", [[1], [1], [1], [1]]);
      expect(await dispatchChunks(db, w.deps.enqueue, bulk.batch.id)).toBe(5);
      expect(await dispatchChunks(db, w.deps.enqueue, operator.batch.id)).toBe(2);
      const chunkTasks = (batch: typeof bulk) => w.tasks.filter((t) => batch.chunks.some((c) => c.id === t.body.chunkId));
      expect(chunkTasks(bulk).map((t) => t.bulk)).toEqual([true, true, true, true, true]);
      expect(chunkTasks(operator).map((t) => t.bulk)).toEqual([false, false]);
      await toEnd(w, bulk.chunks[0]!.id);
      await toEnd(w, operator.chunks[0]!.id);
      // Every later step, the publish task and the window's next chunk keep the batch's class.
      expect(chunkTasks(bulk).every((t) => t.bulk)).toBe(true);
      expect(chunkTasks(operator).every((t) => !t.bulk)).toBe(true);
      const publish = w.tasks.filter((t) => t.route === "/tasks/catalog/publish");
      expect(publish.map((t) => [t.body.batchId === bulk.batch.id, t.bulk])).toEqual([[true, true], [false, false]]);
      expect(chunkTasks(bulk).filter((t) => t.body.chunkId === bulk.chunks[5]!.id)).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);
});

describe("F3: cost lines", () => {
  it("the compute line is wall x WORKER_CPU / WORKER_CONCURRENCY", () => {
    expect(computeVcpuPerSecond({})).toBe(1);
    expect(computeVcpuPerSecond({ WORKER_CPU: "4", WORKER_CONCURRENCY: "2" })).toBe(2);
    expect(computeVcpuPerSecond({ WORKER_CPU: "x", WORKER_CONCURRENCY: "0" })).toBe(1);
  });

  it("an upscale made on the CPU service is priced at the CPU rate, one made on the GPU at the GPU rate", async () => {
    for (const target of ["cpu", "gpu"] as const) {
      const w = fakeWorld(db, 1);
      const render = w.deps.renderAllChannels;
      w.deps.renderAllChannels = vi.fn(async (...args: Parameters<CatalogDeps["renderAllChannels"]>) => Object.fromEntries(Object.entries(await render(...args)).map(([c, o]) => [c, { ...o, flags: ["upscaled"], upscale: { model: upscalerId("realesrgan-x2plus", target), ms: 1000 } }])) as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>);
      const s = await seedBatch(db, w, `f3-upscale-${target}`, [[1]]);
      await toEnd(w, s.chunks[0]!.id);
      const [row] = await db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.batchId, s.batch.id), eq(catalogCostEvents.kind, "upscale_call")));
      expect(row).toMatchObject({ engine: target, ms: 1000 });
      expect(Number(row!.usd)).toBeCloseTo(target === "cpu" ? DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND : DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND, 12);
    }
  }, 60_000);
});
