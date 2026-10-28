// Tier 2 (PGlite + fakes): spec 15, processing resilience. A fake clock in deps.now, slow fake matting, render
// and judge that advance it, a fake FIFO queue, and a guard that no simulated delivery passes the 900 s deadline.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogCostEvents, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { CHUNK_QUEUED_STALE_MS, CHUNK_STALLED_REASON, CHUNK_UNSTARTED_STALE_MS, dispatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { chunkTaskId, DISPATCH_DEADLINE_SEC } from "@catalog/core/tasks";
import type { ChannelId } from "@catalog/core/catalog/types";
import { refreshBatchProgress, workerCatalogDeps, type CatalogDeps } from "./deps";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { handleSweep } from "./sweep";
import type { HandleOptions } from "../server";

let db: Db, close: () => Promise<void>;
const bucketEnv = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const [key, value] of Object.entries(bucketEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await close(); });

const T0 = +new Date("2026-10-27T08:00:00Z");
const DEADLINE_MS = DISPATCH_DEADLINE_SEC * 1000;
interface Task { taskId: string; body: Record<string, unknown>; retryCount: number }

/** In-memory storage, fake services, a settable clock and a FIFO queue of chunk tasks. */
function world() {
  const objects = new Map<string, Buffer>();
  let t = T0;
  const queue: Task[] = [], names = new Set<string>();
  const log = vi.fn<CatalogDeps["log"]>();
  const base = workerCatalogDeps(db);
  const enqueue = vi.fn(async (route: string, body: Record<string, unknown>, opts: { taskId?: string } = {}) => {
    if (route !== "/tasks/catalog/chunk") return "other";
    // Cloud Tasks refuses a name that exists or ran recently; enqueueTask treats that as success.
    if (opts.taskId && names.has(opts.taskId)) return opts.taskId;
    if (opts.taskId) names.add(opts.taskId);
    queue.push({ taskId: opts.taskId ?? `anon-${queue.length}`, body, retryCount: 0 });
    return opts.taskId ?? "task";
  });
  const deps: CatalogDeps = {
    ...base, sleep: async () => {}, now: () => new Date(t), log, enqueue: enqueue as unknown as CatalogDeps["enqueue"], heartbeat: () => () => {},
    resolvePolicy: vi.fn<CatalogDeps["resolvePolicy"]>(async () => ({ matteModel: "fixture", qaModel: "test/judge", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" })),
    storage: { ...storage, getBucketName: () => "assets", getPublicBucketName: () => "public",
      uploadBuffer: async (path: string, buf: Buffer) => { objects.set(`gs://assets/${path}`, buf); return `gs://assets/${path}`; },
      downloadBuffer: async (uri: string) => { const buf = objects.get(uri); if (!buf) throw new Error(`No object ${uri}`); return { buf, mime: "image/jpeg" }; },
      headObject: async (uri: string) => { const buf = objects.get(uri); return buf ? { exists: true, size: buf.length, contentType: "image/jpeg", generation: "1", crc32c: "c" } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }; } } as unknown as CatalogDeps["storage"],
    matting: { ...base.matting, health: vi.fn(async () => ({ ok: true, models: [{ id: "fixture", inputSize: 1024, target: "cpu" }], default: "fixture", versions: { cpu: null, gpu: null } })), convert: base.matting.convert.bind(base.matting) } as unknown as CatalogDeps["matting"],
    // Each photo has its own size (from its first byte), so a product plan that misses a photo would differ.
    prepare: vi.fn(async (buf: Buffer) => { const width = 600 + (buf[3] ?? 0) * 4; return { width, height: 800, rgb: Buffer.alloc(width * 800 * 3, 128), alphaSource: null, background: { uniform: true, color: [255, 255, 255] as [number, number, number], stdev: 0 }, flags: [], sourceMime: "image/jpeg" }; }) as unknown as CatalogDeps["prepare"],
    matteFor: vi.fn<CatalogDeps["matteFor"]>(async (p) => ({ alpha: Buffer.alloc(p.width * p.height, 255), width: p.width, height: p.height, model: "fixture", ms: 12, source: "model", target: "cpu", sentLongSide: 800 })),
    renderAllChannels: vi.fn<CatalogDeps["renderAllChannels"]>(async (p, _m, channels, ctx) => Object.fromEntries(channels.map((channel) => [channel, { jpeg: Buffer.from([255, 216, 255, p.width % 251]), status: "ok", plan: { w: ctx?.canvas?.w ?? p.width, h: ctx?.canvas?.h ?? p.height, lowResolution: false, safeBox: { x: 0, y: 0, w: 1, h: 1 }, scale: ctx?.uniformScale ?? 1, placedX: (ctx?.canvas?.w ?? 0) - p.width, placedY: 0, detailShot: false }, quality: 90, bytes: 4, flags: [], notes: [], attention: null, compliance: { ok: true, failures: [] } }])) as unknown as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>),
    judgeOutput: vi.fn<CatalogDeps["judgeOutput"]>(async (input) => ({ scores: { complete_product: 95, same_product: 95, edge_quality: 95, background_clean: 95, no_text_or_watermark: 95, orientation_ok: 95, product_intact: 95, placement_ok: 95, overall: 95 }, verdict: "pass", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: [] })),
  };
  /** Makes a fake take `ms` of clock time per call. */
  const slow = <K extends "matteFor" | "renderAllChannels" | "judgeOutput">(key: K, ms: (call: number) => number) => {
    const fn = deps[key] as unknown as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    deps[key] = vi.fn(async (...args: unknown[]) => { const result = await fn(...args); t += ms(++calls); return result; }) as unknown as CatalogDeps[K];
  };
  /** One delivery, with the no-deadline guard of spec 15 section 6. */
  const deliver = async (body: Record<string, unknown>, opts: HandleOptions = {}) => {
    const start = t, result = await handleChunkTask(deps, body, opts);
    expect(t - start).toBeLessThan(DEADLINE_MS);
    return result;
  };
  return { deps, objects, queue, log, enqueue, slow, deliver, clock: () => t, set: (ms: number) => { t = ms; }, advance: (ms: number) => { t += ms; } };
}
type World = ReturnType<typeof world>;

/** One batch; each entry of `layout` is one chunk, listing its products' photo counts. */
async function seed(w: World, name: string, layout: number[][], options: { channels?: ChannelId[]; status?: "matting" | "rendering" | "qa" } = {}) {
  const channels = options.channels ?? ["noon"];
  const photos = layout.flat().reduce((a, b) => a + b, 0);
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name, isTest: true, createdBy: "t@opptra.com", status: options.status ?? "matting", productType: "footwear", channels, startedAt: new Date(T0), counts: { ...EMPTY_BATCH_COUNTS, products: layout.flat().length, sources: photos, outputs: photos * channels.length } }).returning();
  const chunks: (typeof catalogChunks.$inferSelect)[] = [];
  let p = 0;
  for (const [index, group] of layout.entries()) {
    const productIds: string[] = [];
    for (const shots of group) {
      const key = `${name}-${p++}`;
      const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: key, pathKey: key, identifier: key, productType: "footwear", lockBatchId: batch!.id }).returning();
      await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "new" });
      for (let n = 1; n <= shots; n++) {
        const rawUri = await w.deps.storage.uploadBuffer(`catalog-test/test_brand/${batch!.id}/raw/${key}/${n}.jpg`, Buffer.from([255, 216, 255, n * 3]), "image/jpeg");
        await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n, sha256: `${key}-${n}`, originalName: `${key}_${n}.jpg`, rawUri, mime: "image/jpeg", width: 800, height: 800 });
      }
      productIds.push(product!.id);
    }
    const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index, stage: "matte", status: "queued", attempt: 0, productIds }).returning();
    chunks.push(chunk!);
  }
  return { batch: batch!, chunks };
}
const row = async (id: string) => (await db.select().from(catalogChunks).where(eq(catalogChunks.id, id)))[0]!;
const batchRow = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
const deliveries = (w: World, outcome?: string) => w.log.mock.calls.filter(([message, fields]) => message === "chunk delivery" && (!outcome || fields?.outcome === outcome)).map(([, fields]) => fields!);
/** Delivers every queued task in order until the queue is empty (at most `limit`). */
async function drain(w: World, limit = 200) {
  for (let i = 0; i < limit && w.queue.length; i++) {
    const task = w.queue.shift()!;
    const result = await w.deliver(task.body, { retryCount: task.retryCount });
    if (result.httpStatus >= 500 && task.retryCount < 4) w.queue.push({ ...task, retryCount: task.retryCount + 1 });
  }
}

describe("E1: a delivery never reaches the deadline", () => {
  it("10 photos at 60 s each with a 480 s budget: 8, a hand-off, then 2 and the advance; no photo matted twice; one compute row per delivery", async () => {
    const w = world(), s = await seed(w, "e1-ten", [[10]]);
    w.slow("matteFor", () => 60_000);
    const id = s.chunks[0]!.id;
    expect((await w.deliver(await currentChunkTask(db, id))).httpStatus).toBe(200);
    expect(w.deps.matteFor).toHaveBeenCalledTimes(8);
    expect(w.queue.map((t) => t.taskId)).toEqual([chunkTaskId(id, "matte", 1)]);
    expect(w.queue[0]!.body).toEqual({ chunkId: id, stage: "matte", step: 1, fromProduct: 0 });
    expect(await row(id)).toMatchObject({ stage: "matte", status: "queued", step: 1, leaseUntil: null, taskName: null });
    expect(deliveries(w, "handed_off")).toHaveLength(1);
    // E7: the hand-off moved the batch page's prepared count.
    expect((await batchRow(s.batch.id)).counts.prepared).toBe(8);
    await drain(w, 1);
    expect(w.deps.matteFor).toHaveBeenCalledTimes(10);
    expect(await row(id)).toMatchObject({ stage: "render", status: "queued", step: 2, attempt: 0 });
    expect(w.queue.map((t) => t.taskId)).toEqual([chunkTaskId(id, "render", 2)]);
    expect((await batchRow(s.batch.id)).counts.prepared).toBe(10);
    const compute = (await db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.chunkId, id), eq(catalogCostEvents.kind, "compute"))));
    expect(compute.map((r) => r.ms).sort((a, b) => a - b)).toEqual([120_000, 480_000]);
  }, 60_000);

  it("worst case: a photo that starts at 479 s and takes 400 s ends at 879 s, inside the deadline", async () => {
    const w = world(), s = await seed(w, "e1-worst", [[3]]);
    w.slow("matteFor", (call) => [479_000, 400_000, 10_000][call - 1] ?? 10_000);
    const result = await w.deliver(await currentChunkTask(db, s.chunks[0]!.id));
    expect(result.httpStatus).toBe(200);
    expect(w.clock() - T0).toBe(879_000);
    expect(deliveries(w, "handed_off")[0]).toMatchObject({ photos: 2, ms: 879_000 });
  }, 60_000);

  it("render stopped mid-product: every output has the same canvas, scale and placement as an uninterrupted run", async () => {
    const channels: ChannelId[] = ["noon", "styli"];
    const plain = world(), a = await seed(plain, "e1-render-a", [[3]], { channels });
    await drain(plain);
    plain.queue.push({ taskId: "start", body: await currentChunkTask(db, a.chunks[0]!.id), retryCount: 0 });
    await drain(plain);
    const cut = world(), b = await seed(cut, "e1-render-b", [[3]], { channels });
    cut.queue.push({ taskId: "start", body: await currentChunkTask(db, b.chunks[0]!.id), retryCount: 0 });
    await drain(cut, 1); // matte, no clock time
    cut.slow("renderAllChannels", () => 300_000);
    await drain(cut);
    expect(deliveries(cut, "handed_off").filter((d) => d.stage === "render").length).toBeGreaterThanOrEqual(2);
    const shape = async (batchId: string) => (await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId))).map((o) => `${o.n}:${o.channel}:${o.canvasW}x${o.canvasH}:${o.scale}:${o.placedX},${o.placedY}:${o.status}`).sort();
    const expected = await shape(a.batch.id);
    expect(expected.every((line) => !line.includes(":0x0:"))).toBe(true);
    expect(await shape(b.batch.id)).toEqual(expected);
    expect(cut.deps.renderAllChannels).toHaveBeenCalledTimes(6);
  }, 60_000);

  it("QA stopped between photo groups: judged rows are not judged again and triage runs once per product, after its last group", async () => {
    const w = world(), s = await seed(w, "e1-qa", [[1, 3]]);
    const id = s.chunks[0]!.id;
    w.queue.push({ taskId: "start", body: await currentChunkTask(db, id), retryCount: 0 });
    await drain(w, 2); // matte and render, no clock time
    expect((await row(id)).stage).toBe("qa");
    w.slow("judgeOutput", () => 300_000);
    const [first, second] = s.chunks[0]!.productIds;
    const outputsOf = (productId: string) => db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.batch.id), eq(catalogOutputs.productId, productId)));
    await drain(w, 1);
    expect(w.queue[0]!.body).toMatchObject({ stage: "qa", fromProduct: 1 });
    const firstAfter = await outputsOf(first!);
    expect(firstAfter.every((o) => o.qaScores?.finalStatus)).toBe(true);
    const judged = (await outputsOf(second!)).filter((o) => o.qaScores);
    expect(judged).toHaveLength(1);
    expect(judged[0]!.qaScores!.autoAction).toBeNull(); // not triaged yet
    await drain(w);
    expect(w.deps.judgeOutput).toHaveBeenCalledTimes(4);
    expect((await outputsOf(first!)).map((o) => +o.updatedAt)).toEqual(firstAfter.map((o) => +o.updatedAt));
    expect((await outputsOf(second!)).every((o) => o.qaScores?.finalStatus)).toBe(true);
    expect(await row(id)).toMatchObject({ status: "done" });
  }, 60_000);
});

/** A delivery paused inside its first cut-out call, holding its claim. */
async function liveDelivery(w: World, chunkId: string) {
  let release!: () => void, entered!: () => void, renew!: () => Promise<boolean>;
  const paused = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const matte = w.deps.matteFor;
  let first = true;
  w.deps.matteFor = vi.fn(async (...args: Parameters<CatalogDeps["matteFor"]>) => { if (first) { first = false; entered(); await paused; } return matte(...args); }) as CatalogDeps["matteFor"];
  w.deps.heartbeat = (fn) => { renew = fn; return () => {}; };
  const body = await currentChunkTask(db, chunkId);
  const result = handleChunkTask(w.deps, body);
  await started;
  w.deps.heartbeat = () => () => {};
  return { body, result, release, renew: () => renew() };
}

describe("E2: heartbeat lease", () => {
  it("a delivery that renews is never claimed up to its deadline; renewal stops at the deadline", async () => {
    const w = world(), s = await seed(w, "e2-live", [[1]]), id = s.chunks[0]!.id;
    const live = await liveDelivery(w, id);
    const holder = (await row(id)).taskName;
    for (let t = 30_000; t < DEADLINE_MS; t += 30_000) {
      w.set(T0 + t);
      expect(await live.renew()).toBe(true);
      expect(await handleChunkTask(w.deps, live.body)).toEqual({ httpStatus: 503, outcome: "busy" });
      expect(await handleChunkTask(w.deps, live.body, { retryCount: 4 })).toEqual({ httpStatus: 200, outcome: "duplicate" });
    }
    expect((await row(id)).taskName).toBe(holder);
    w.set(T0 + DEADLINE_MS);
    const before = (await row(id)).leaseUntil;
    expect(await live.renew()).toBe(false);
    expect((await row(id)).leaseUntil).toEqual(before);
    live.release();
    expect((await live.result).httpStatus).toBe(200);
  }, 120_000);

  it("after the holder's heartbeat stops and 121 s pass, a second delivery claims it and the first drops itself", async () => {
    const w = world(), s = await seed(w, "e2-dead", [[1]]), id = s.chunks[0]!.id;
    const live = await liveDelivery(w, id);
    w.set(T0 + 60_000);
    await live.renew();
    w.set(T0 + 60_000 + 119_000);
    expect((await handleChunkTask(w.deps, live.body, { retryCount: 4 })).outcome).toBe("duplicate");
    w.set(T0 + 60_000 + 121_000);
    expect((await handleChunkTask(w.deps, live.body, { retryCount: 1 })).httpStatus).toBe(200);
    live.release();
    expect(await live.result).toEqual({ httpStatus: 200, outcome: "lost" });
    expect(await row(id)).toMatchObject({ stage: "render", status: "queued" });
    expect(w.deps.matteFor).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("a claim from before 0004 (no lease) keeps its 960 s: not claimable at 10 min, claimable at 17 min", async () => {
    const w = world(), s = await seed(w, "e2-legacy", [[1]]), id = s.chunks[0]!.id;
    await db.update(catalogChunks).set({ status: "running", taskName: "old-code", startedAt: new Date(T0 - 10 * 60_000), dispatchedAt: new Date(T0 - 10 * 60_000), stepKnown: false }).where(eq(catalogChunks.id, id));
    expect(await w.deliver({ chunkId: id })).toEqual({ httpStatus: 200, outcome: "duplicate" });
    w.set(T0 + 7 * 60_000);
    expect(await w.deliver({ chunkId: id })).toEqual({ httpStatus: 200, outcome: "done" });
    expect(await row(id)).toMatchObject({ stage: "render", stepKnown: true, step: 1 });
  }, 60_000);
});

describe("E3: one live task per chunk", () => {
  it("other-step copies arriving while a delivery is live answer 200 and change nothing; a same-step copy past its retries is a duplicate", async () => {
    const w = world(), s = await seed(w, "e3-copies", [[1]]), id = s.chunks[0]!.id;
    const live = await liveDelivery(w, id);
    const before = await row(id);
    expect(await w.deliver({ chunkId: id, stage: "matte", step: 5 })).toEqual({ httpStatus: 200, outcome: "stale" });
    expect(await w.deliver({ chunkId: id, stage: "render", step: 0 })).toEqual({ httpStatus: 200, outcome: "stale" });
    expect(await w.deliver(live.body, { retryCount: 4 })).toEqual({ httpStatus: 200, outcome: "duplicate" });
    expect(await w.deliver({ chunkId: id })).toEqual({ httpStatus: 200, outcome: "stale" });
    expect(await row(id)).toEqual(before);
    expect(w.queue).toHaveLength(0);
    live.release();
    await live.result;
  }, 60_000);

  it("a render-step task arriving while the row is in qa answers stale", async () => {
    const w = world(), s = await seed(w, "e3-stage", [[1]]), id = s.chunks[0]!.id;
    w.queue.push({ taskId: "start", body: await currentChunkTask(db, id), retryCount: 0 });
    await drain(w, 2);
    expect(await row(id)).toMatchObject({ stage: "qa", step: 2 });
    expect(await w.deliver({ chunkId: id, stage: "render", step: 1 })).toEqual({ httpStatus: 200, outcome: "stale" });
  }, 60_000);

  it("the same task's retries after a crash wait (503) on the queue's real back-off and the last one claims", async () => {
    const w = world(), s = await seed(w, "e3-crash", [[1]]), id = s.chunks[0]!.id;
    // The holder renewed just before it crashed at T0, so its lease runs the full 120 s.
    await db.update(catalogChunks).set({ status: "running", taskName: "crashed", startedAt: new Date(T0 - 60_000), leaseUntil: new Date(T0 + 120_000), dispatchedAt: new Date(T0 - 60_000) }).where(eq(catalogChunks.id, id));
    const body = { chunkId: id, stage: "matte", step: 0 };
    // Cloud Tasks: 5 attempts, back-off 10 s doubling, so retries 1-4 arrive at about +10, +30, +70 and +150 s.
    for (const [retryCount, at] of [[1, 10_000], [2, 30_000], [3, 70_000]] as const) {
      w.set(T0 + at);
      expect(await w.deliver(body, { retryCount })).toEqual({ httpStatus: 503, outcome: "busy" });
    }
    w.set(T0 + 150_000);
    expect(await w.deliver(body, { retryCount: 4 })).toEqual({ httpStatus: 200, outcome: "done" });
  }, 60_000);
});

describe("E4: the sweep recovers only dead chunks", () => {
  const sweep = (w: World) => handleSweep({ db, enqueue: w.deps.enqueue, releaseLocks: async () => 0, now: w.deps.now, window: 8 }, {});

  it("leaves a waiting task and a live lease alone, re-dispatches a task that never started once, and the old task then answers stale", async () => {
    const w = world(), s = await seed(w, "e4-sweep", [[1], [1]]);
    const [held, waiting] = s.chunks.map((c) => c.id);
    await db.update(catalogChunks).set({ status: "running", taskName: "alive", startedAt: new Date(T0 - 5 * 3600_000), leaseUntil: new Date(T0 + 3600_000), dispatchedAt: new Date(T0 - 5 * 3600_000) }).where(eq(catalogChunks.id, held!));
    await db.update(catalogChunks).set({ dispatchedAt: new Date(T0 - 5 * 60_000) }).where(eq(catalogChunks.id, waiting!));
    await sweep(w);
    expect(w.queue).toHaveLength(0);
    expect(await row(waiting!)).toMatchObject({ step: 0, status: "queued" });
    // The sweep covers every batch in the shared test database; keep only this batch's tasks.
    const own = () => w.queue.filter((t) => t.body.chunkId === held || t.body.chunkId === waiting).map((t) => t.taskId);
    w.set(T0 + 21 * 60_000);
    await sweep(w);
    expect(own()).toEqual([chunkTaskId(waiting!, "matte", 1)]);
    w.set(T0 + 21 * 60_000 + 30_000);
    await sweep(w);
    expect(own()).toHaveLength(1);
    expect(await row(held!)).toMatchObject({ status: "running", taskName: "alive", step: 0 });
    expect(await w.deliver({ chunkId: waiting!, stage: "matte", step: 0 })).toEqual({ httpStatus: 200, outcome: "stale" });
  }, 60_000);

  it("recovers a lapsed lease with the next step", async () => {
    const w = world(), s = await seed(w, "e4-lapsed", [[1]]), id = s.chunks[0]!.id;
    await db.update(catalogChunks).set({ status: "running", taskName: "dead", startedAt: new Date(T0 - 300_000), leaseUntil: new Date(T0 - 1_000), dispatchedAt: new Date(T0 - 300_000) }).where(eq(catalogChunks.id, id));
    await sweep(w);
    expect(await row(id)).toMatchObject({ status: "queued", step: 1, taskName: null });
    await drain(w);
    expect(await row(id)).toMatchObject({ status: "done" });
  }, 60_000);

  it("a hand-off whose enqueue fails is logged, keeps the delivery's 200, and the sweep sends the next step after 30 min", async () => {
    const w = world(), s = await seed(w, "e4-handoff-lost", [[10]]), id = s.chunks[0]!.id;
    w.slow("matteFor", () => 60_000);
    const enqueue = w.deps.enqueue;
    w.deps.enqueue = vi.fn(async (...args: Parameters<CatalogDeps["enqueue"]>) => { if (args[2]?.taskId === chunkTaskId(id, "matte", 1)) throw new Error("UNAVAILABLE"); return enqueue(...args); }) as CatalogDeps["enqueue"];
    expect((await w.deliver(await currentChunkTask(db, id))).httpStatus).toBe(200);
    expect(deliveries(w, "handed_off")).toHaveLength(1);
    expect(w.log).toHaveBeenCalledWith("chunk dispatch failed", expect.objectContaining({ severity: "WARNING", chunkId: id, step: 1 }));
    expect(w.queue).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "queued", step: 1 });
    w.advance(31 * 60_000);
    await sweep(w);
    // The database is shared by this file's tests; keep only this chunk's tasks.
    w.queue.splice(0, w.queue.length, ...w.queue.filter((t) => t.body.chunkId === id));
    expect(w.queue.map((t) => t.taskId)).toEqual([chunkTaskId(id, "matte", 2)]);
    await drain(w);
    expect(await row(id)).toMatchObject({ status: "done" });
    expect(w.deps.matteFor).toHaveBeenCalledTimes(10);
  }, 60_000);

  it("three deliveries in a row that finish no photo fail the chunk with the sentence", async () => {
    const w = world(), s = await seed(w, "e4-stall", [[1]]), id = s.chunks[0]!.id;
    w.deps.prepare = vi.fn(async () => { throw new Error("decoder crashed"); }) as unknown as CatalogDeps["prepare"];
    const body = await currentChunkTask(db, id);
    for (let i = 0; i < 3; i++) { expect((await w.deliver(body)).httpStatus).toBe(503); w.advance(30_000); }
    expect(await w.deliver(body)).toEqual({ httpStatus: 200, outcome: "failed" });
    expect(await row(id)).toMatchObject({ status: "failed", error: CHUNK_STALLED_REASON, stalls: 3 });
    const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
    expect(outputs.map((o) => [o.status, o.reason])).toEqual([["failed", "Processing stopped: no photo finished in three tries in a row."]]);
    expect(w.log).toHaveBeenCalledWith("chunk failed", expect.objectContaining({ severity: "ERROR", chunkId: id }));
  }, 60_000);

  it("property: across a 2-hour simulated run with random crashes the queue never holds two live-step tasks for one chunk (50 seeds)", async () => {
    let finished = 0;
    for (let seedNo = 1; seedNo <= 50; seedNo++) {
      let state = seedNo * 7919;
      const random = () => { state = (state * 48271) % 2147483647; return state / 2147483647; };
      for (let i = 0; i < 10; i++) random(); // the first values of a small seed are small
      const w = world(), s = await seed(w, `e4-prop-${seedNo}`, [[1], [1], [1]]);
      await dispatchChunks(db, w.deps.enqueue, s.batch.id, { window: 2, now: w.deps.now() });
      const matte = w.deps.matteFor, render = w.deps.renderAllChannels;
      // A crash: the process dies inside the call; its delivery never returns, and the queue retries the task later.
      let crashed = () => {};
      const crashing = <F extends (...args: never[]) => Promise<unknown>>(fn: F) => vi.fn(async (...args: Parameters<F>) => { if (random() < 0.2) { crashed(); await new Promise(() => {}); } return fn(...args); }) as unknown as F;
      w.deps.matteFor = crashing(matte); w.deps.renderAllChannels = crashing(render);
      const retries: { at: number; task: Task }[] = [];
      let lastSweep = T0;
      const liveSteps = async () => {
        const rows = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id));
        for (const chunk of rows) {
          if (chunk.status === "done" || chunk.status === "failed") continue;
          const live = [...w.queue, ...retries.map((r) => r.task)].filter((t) => t.body.chunkId === chunk.id && t.body.stage === chunk.stage && t.body.step === chunk.step);
          expect(live.length, `seed ${seedNo} chunk ${chunk.index}`).toBeLessThanOrEqual(1);
        }
      };
      while (w.clock() < T0 + 2 * 3600_000) {
        await liveSteps();
        for (const r of retries.splice(0)) if (r.at <= w.clock()) w.queue.push(r.task); else retries.push(r);
        const task = w.queue.shift();
        if (task) {
          const pending = handleChunkTask(w.deps, task.body, { retryCount: task.retryCount });
          const outcome = await Promise.race([pending, new Promise<null>((resolve) => { crashed = () => resolve(null); })]);
          // A hung delivery is a crash: Cloud Tasks sees a timeout and retries the same task (5 attempts in all).
          if ((outcome === null || outcome.httpStatus >= 500) && task.retryCount < 4) retries.push({ at: w.clock() + (outcome === null ? DEADLINE_MS : 20_000), task: { ...task, retryCount: task.retryCount + 1 } });
        }
        w.advance(task ? 5_000 : 60_000);
        if (w.clock() - lastSweep >= 10 * 60_000) { lastSweep = w.clock(); await sweep(w); }
        const rows = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id));
        if (rows.every((c) => c.status === "done")) break;
      }
      const rows = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id));
      // Every chunk ends: done, or failed by the stall rule after three crashed deliveries in a row. None is left stuck.
      for (const c of rows) expect(c.status === "done" || (c.status === "failed" && c.error === CHUNK_STALLED_REASON), `seed ${seedNo} chunk ${c.index} ${c.status} ${c.error}`).toBe(true);
      finished += rows.filter((c) => c.status === "done").length;
    }
    expect(finished).toBeGreaterThanOrEqual(140); // of 150 chunks
  }, 600_000);
});

describe("G4 (spec 17): a task the queue dropped after a successful enqueue", () => {
  // Stage times and the queue wait are scaled to batch d9469ed5 (2026-10-27): 8 photos, median chunk span 390 s.
  const WAIT_MS = 43_000;
  const timed = (w: World) => { w.slow("matteFor", () => 15_000); w.slow("renderAllChannels", () => 20_000); w.slow("judgeOutput", () => 3_000); };
  /** Runs one chunk's tasks in order, each after the queue wait; returns its span (first delivery start to last end). */
  async function runChunk(w: World, id: string, delivered: Task[] = []): Promise<number> {
    let start: number | undefined;
    for (let i = 0; i < 20 && (await row(id)).status !== "done"; i++) {
      const at = w.queue.findIndex((t) => t.body.chunkId === id);
      expect(at, "the chunk has a task").toBeGreaterThanOrEqual(0);
      const [task] = w.queue.splice(at, 1);
      w.advance(WAIT_MS);
      start ??= w.clock();
      delivered.push(task!);
      await w.deliver(task!.body, { retryCount: task!.retryCount });
    }
    expect((await row(id)).status).toBe("done");
    return w.clock() - start!;
  }

  it("the dropped render task is re-sent at the first delivery end after 6 min, and the chunk ends within 2 x the median chunk time", async () => {
    // The median, from healthy chunks run one at a time (window 1, so no task waits while another chunk runs).
    const healthy = world(), h = await seed(healthy, "g4-median", [[8], [8], [8]]);
    timed(healthy); healthy.deps.chunkWindow = 1;
    await dispatchChunks(db, healthy.deps.enqueue, h.batch.id, { window: 1, now: healthy.deps.now() });
    const spans: number[] = [];
    for (const c of h.chunks) spans.push(await runChunk(healthy, c.id));
    const median = [...spans].sort((a, b) => a - b)[1]!;
    expect(median).toBeGreaterThan(300_000);

    const w = world(), s = await seed(w, "g4-dropped", [[8], [8]]), [lost, peer] = s.chunks.map((c) => c.id) as [string, string];
    timed(w);
    await dispatchChunks(db, w.deps.enqueue, s.batch.id, { window: 8, now: w.deps.now() });
    // The matte step of the tail chunk ends and queues its render step: the enqueue succeeds.
    const matteTask = w.queue.splice(w.queue.findIndex((t) => t.body.chunkId === lost), 1)[0]!;
    w.advance(WAIT_MS);
    const start = w.clock();
    expect(await w.deliver(matteTask.body)).toEqual({ httpStatus: 200, outcome: "done" });
    const matteEnd = w.clock();
    const dropped = chunkTaskId(lost, "render", 1);
    expect(w.queue.map((t) => t.taskId)).toContain(dropped);
    // Cloud Tasks then deletes it after its 429 retries: no error reaches the worker, nothing is logged.
    w.queue.splice(w.queue.findIndex((t) => t.taskId === dropped), 1);
    expect(w.log).not.toHaveBeenCalledWith("chunk dispatch failed", expect.anything());
    // Another chunk of the batch ends a delivery 10 s after the 6-minute mark (a big batch ends one every few seconds).
    w.set(matteEnd + CHUNK_UNSTARTED_STALE_MS + 10_000 - 120_000);
    const peerTask = w.queue.splice(w.queue.findIndex((t) => t.body.chunkId === peer), 1)[0]!;
    await w.deliver(peerTask.body);
    expect(w.clock()).toBe(matteEnd + CHUNK_UNSTARTED_STALE_MS + 10_000);
    expect(w.log).toHaveBeenCalledWith("chunk recovered", expect.objectContaining({ chunkId: lost, stage: "render", step: 2, reason: "task_not_started" }));
    expect(w.queue.map((t) => t.taskId)).toContain(chunkTaskId(lost, "render", 2));
    // The re-sent step runs; the chunk is done long before the 30-minute rule, within 2 x the median.
    const delivered: Task[] = [];
    await runChunk(w, lost, delivered);
    const span = w.clock() - start;
    expect(span).toBeLessThanOrEqual(2 * median);
    expect(span).toBeLessThan(CHUNK_QUEUED_STALE_MS);
    expect(deliveries(w).filter((d) => d.chunkId === lost).map((d) => [d.stage, d.step, d.outcome])).toEqual([["matte", 0, "done"], ["render", 2, "done"], ["qa", 3, "done"]]);

    // Idempotent: the "dropped" task turning up late, and a second delivery of every task the chunk ran, answer 200
    // (a done chunk answers "done") and change nothing.
    const counts = () => [w.deps.matteFor, w.deps.renderAllChannels, w.deps.judgeOutput].map((fn) => vi.mocked(fn).mock.calls.length);
    const before = await row(lost), calls = counts();
    for (const body of [{ chunkId: lost, stage: "render", step: 1 }, ...[matteTask, ...delivered].map((t) => t.body)]) expect(await w.deliver(body)).toEqual({ httpStatus: 200, outcome: "done" });
    expect(await row(lost)).toEqual(before);
    expect(counts()).toEqual(calls);
    expect(w.queue.filter((t) => t.body.chunkId === lost)).toHaveLength(0);
  }, 120_000);

  it("a step is re-sent only once, and a duplicate delivery of the re-sent task while it runs is a no-op", async () => {
    const w = world(), s = await seed(w, "g4-duplicate", [[2]]), id = s.chunks[0]!.id;
    const sweep = () => handleSweep({ db, enqueue: w.deps.enqueue, releaseLocks: async () => 0, now: w.deps.now, window: 8 }, {});
    await dispatchChunks(db, w.deps.enqueue, s.batch.id, { window: 8, now: w.deps.now() });
    // The first matte task is lost before it ever starts: the sweep 10 min later re-sends the step once.
    w.queue.splice(0, w.queue.length);
    w.advance(10 * 60_000);
    await sweep();
    w.advance(10 * 60_000);
    await sweep();
    // The sweep covers every batch in the shared test database; keep only this chunk's tasks.
    expect(w.queue.filter((t) => t.body.chunkId === id).map((t) => t.taskId)).toEqual([chunkTaskId(id, "matte", 1)]);
    // A copy of the re-sent task arrives while the first copy holds the chunk: it waits (busy), then finds the step done.
    const live = await liveDelivery(w, id);
    expect(await handleChunkTask(w.deps, live.body)).toEqual({ httpStatus: 503, outcome: "busy" });
    live.release();
    expect((await live.result).httpStatus).toBe(200);
    expect(await handleChunkTask(w.deps, live.body, { retryCount: 1 })).toEqual({ httpStatus: 200, outcome: "stale" });
    expect(w.deps.matteFor).toHaveBeenCalledTimes(2);
    expect(await row(id)).toMatchObject({ stage: "render", status: "queued", step: 2 });
  }, 60_000);
});

describe("E5: a window per batch", () => {
  it("each finished chunk queues exactly one more, and the queue never holds more than the window for the batch", async () => {
    const w = world(), s = await seed(w, "e5-window", [[1], [1], [1], [1], [1]]);
    w.deps.chunkWindow = 2;
    await dispatchChunks(db, w.deps.enqueue, s.batch.id, { window: 2, now: w.deps.now() });
    expect(w.queue).toHaveLength(2);
    let most = 0;
    while (w.queue.length) { most = Math.max(most, w.queue.length); await drain(w, 1); }
    expect(most).toBeLessThanOrEqual(2);
    const rows = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id));
    expect(rows.every((c) => c.status === "done")).toBe(true);
    expect(w.enqueue.mock.calls.filter(([route, body]) => route === "/tasks/catalog/chunk" && (body as { stage: string }).stage === "matte")).toHaveLength(5);
    expect((await batchRow(s.batch.id)).status).toBe("publishing");
  }, 60_000);
});

describe("E7: the operator sees true processing progress", () => {
  it("counts a photo the cut-out step skipped (no matte) as prepared once its chunk has left that step", async () => {
    const w = world(), s = await seed(w, "e7-skipped", [[2], [1]]);
    const [first, second] = s.chunks.map((c) => c.id);
    const prepared = async () => { await refreshBatchProgress(db, s.batch.id); return (await batchRow(s.batch.id)).counts.prepared; };
    expect(await prepared()).toBe(0);
    // As for unchanged shots of a re-upload: the first chunk moved on with no matte written for its photos.
    await db.update(catalogChunks).set({ stage: "render" }).where(eq(catalogChunks.id, first!));
    expect(await prepared()).toBe(2);
    await db.update(catalogChunks).set({ status: "failed" }).where(eq(catalogChunks.id, second!));
    expect(await prepared()).toBe(3);
  }, 60_000);

  it("counts prepared photos of a 2,000-product batch quickly (the count runs after every delivery)", async () => {
    // Spec 16 F4: a per-photo search over every chunk grew with photos x chunks; at 2,000 products it took about
    // 10 s per delivery on PGlite and stalled the scale test. Listing the moved-on chunks' photos once stays flat.
    const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name: "e7-big", isTest: true, createdBy: "t@opptra.com", status: "matting", productType: "footwear", channels: ["noon"], startedAt: new Date(), counts: { ...EMPTY_BATCH_COUNTS } }).returning();
    const products = await db.insert(catalogProducts).values(Array.from({ length: 2000 }, (_, i) => ({ brandSlug: "test_brand", isTest: true, productKey: `e7-big-${i}`, pathKey: `e7-big-${i}`, identifier: `e7-big-${i}`, productType: "footwear" as const, lockBatchId: batch!.id }))).returning({ id: catalogProducts.id });
    for (let i = 0; i < products.length; i += 500) {
      await db.insert(catalogSourceImages).values(products.slice(i, i + 500).flatMap((p) => [1, 2, 3, 4, 5].map((n) => ({ batchId: batch!.id, productId: p.id, n, sha256: `${p.id}-${n}`, originalName: `${n}.jpg`, rawUri: `gs://assets/catalog-test/${p.id}/${n}.jpg`, mime: "image/jpeg", width: 800, height: 800 }))));
    }
    // 1,000 chunks of two products; the first 400 left the cut-out step with no matte written, and one of them
    // names only its first photo (as a targeted re-run does).
    const chunks = Array.from({ length: 1000 }, (_, index) => ({ batchId: batch!.id, index, stage: (index < 400 ? "render" : "matte") as "render" | "matte", status: "queued" as const, attempt: 0, productIds: [products[index * 2]!.id, products[index * 2 + 1]!.id] }));
    for (let i = 0; i < chunks.length; i += 500) await db.insert(catalogChunks).values(chunks.slice(i, i + 500));
    const [first] = await db.select({ id: catalogSourceImages.id }).from(catalogSourceImages).where(and(eq(catalogSourceImages.productId, products[0]!.id), eq(catalogSourceImages.n, 1)));
    await db.update(catalogChunks).set({ sourceImageIds: [first!.id] }).where(and(eq(catalogChunks.batchId, batch!.id), eq(catalogChunks.index, 0)));
    const started = Date.now();
    await refreshBatchProgress(db, batch!.id);
    const ms = Date.now() - started;
    expect((await batchRow(batch!.id)).counts.prepared).toBe(399 * 10 + 1);
    expect(ms).toBeLessThan(2000);
    // The sweep tests below scan every processing batch; this one is not meant to run.
    await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, batch!.id));
  }, 120_000);

  it("logs one chunk delivery line per delivery with the step times, and a render hand-off moves the measured rate", async () => {
    const w = world(), s = await seed(w, "e7-line", [[4]]), id = s.chunks[0]!.id;
    w.queue.push({ taskId: "start", body: await currentChunkTask(db, id), retryCount: 0 });
    await drain(w, 1);
    expect(deliveries(w)[0]).toMatchObject({ batchId: s.batch.id, chunkId: id, stage: "matte", step: 0, attempt: 1, outcome: "done", photos: 4, ms: 0,
      msPerStep: { download: expect.any(Number), prepare: expect.any(Number), matte: expect.any(Number), guard: expect.any(Number), render: expect.any(Number), upscale: expect.any(Number), judge: expect.any(Number), write: expect.any(Number) } });
    expect(w.log).toHaveBeenCalledWith("chunk delivered", expect.objectContaining({ chunkId: id, stage: "matte" }));
    w.slow("renderAllChannels", () => 200_000);
    await drain(w, 1);
    const after = (await batchRow(s.batch.id)).counts;
    expect(deliveries(w, "handed_off")).toHaveLength(1);
    expect(after.processingRate!.at(-1)).toMatchObject({ made: 3 });
    expect(after.progressAt).toBe(new Date(w.clock()).toISOString());
  }, 60_000);
});

describe("E8: rollout without a purge", () => {
  it("a batch in the state of 09dd86f2 with legacy task copies: no live chunk is taken over, each finishes once, the queue drains, extra copies answer 200", async () => {
    const w = world(), s = await seed(w, "e8-legacy", Array.from({ length: 16 }, () => [1]));
    // The 0004 backfill: every row from before is legacy and already dispatched. 6 run (2 to 20 min old), 10 wait.
    for (const [i, chunk] of s.chunks.entries()) {
      const running = i < 6, startedAt = running ? new Date(T0 - (2 + i * 3.6) * 60_000) : null;
      await db.update(catalogChunks).set({ stepKnown: false, attempt: 2, dispatchedAt: startedAt ?? new Date(T0 - 3600_000), ...(running ? { status: "running" as const, taskName: `old-${i}`, startedAt } : {}) }).where(eq(catalogChunks.id, chunk.id));
    }
    const young = s.chunks.slice(0, 6).filter((_c, i) => 2 + i * 3.6 < 16).map((c) => c.id);
    // 3 legacy tasks per chunk plus 2 recovery copies, all with the old body.
    for (const chunk of s.chunks) for (let copy = 0; copy < 5; copy++) w.queue.push({ taskId: `legacy-${chunk.index}-${copy}`, body: { chunkId: chunk.id }, retryCount: 0 });
    const legacy = w.queue.length;
    const outcomes: Record<string, string[]> = {};
    for (let i = 0; i < legacy; i++) {
      const task = w.queue.shift()!;
      const result = await w.deliver(task.body);
      (outcomes[task.body.chunkId as string] ??= []).push(result.outcome);
      expect(result.httpStatus).toBe(200);
    }
    for (const id of young) {
      expect(outcomes[id]).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
      expect((await row(id)).taskName).toMatch(/^old-/);
    }
    for (const chunk of s.chunks.filter((c) => !young.includes(c.id))) expect(outcomes[chunk.id]).toEqual(["done", "stale", "stale", "stale", "stale"]);
    // The old revision's young deliveries die with it; their leases lapse and the sweep adopts them.
    w.set(T0 + 17 * 60_000);
    await handleSweep({ db, enqueue: w.deps.enqueue, releaseLocks: async () => 0, now: w.deps.now }, {});
    await drain(w);
    expect(w.queue).toHaveLength(0);
    const rows = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id));
    expect(rows.every((c) => c.status === "done")).toBe(true);
    expect(w.deps.matteFor).toHaveBeenCalledTimes(16);
    expect(w.deps.renderAllChannels).toHaveBeenCalledTimes(16);
  }, 120_000);
});
