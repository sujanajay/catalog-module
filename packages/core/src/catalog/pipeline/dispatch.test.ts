// Tier 2 (PGlite): the per-batch window (spec 15 E5) and the recovery rules shared by the sweep and Start (E4).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogChunks, EMPTY_BATCH_COUNTS } from "../../db/schema";
import { chunkTaskId } from "../../tasks";
import { chunkTimeBudgetMs, chunkWindow, CHUNK_TIME_BUDGET_MS, dispatchChunks, enqueueChunk, isBulkBatch, LOAD_BATCH_NAME_PREFIX, recoverBatchChunks, redispatchUnstartedChunks, REDISPATCHED_TASK, windowFor } from "./dispatch";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

const T0 = new Date("2026-10-27T08:00:00Z");
const at = (ms: number) => new Date(+T0 + ms);

async function batchWith(chunks: number, name = "b") {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name, isTest: true, createdBy: "t@opptra.com", status: "matting", counts: EMPTY_BATCH_COUNTS }).returning();
  for (let index = 0; index < chunks; index++) await db.insert(catalogChunks).values({ batchId: batch!.id, index, stage: "matte", status: "queued", productIds: [], attempt: 0 });
  return batch!.id;
}

interface Task { taskId: string; body: { chunkId: string; stage: string; step: number } }
/** A FIFO fake of the queue; `create` refuses a name that exists, as Cloud Tasks does. */
function fakeQueue() {
  const tasks: Task[] = [], names = new Set<string>();
  const enqueue = vi.fn(async (_route: string, body: Record<string, unknown>, opts: { taskId?: string } = {}) => {
    if (names.has(opts.taskId!)) throw Object.assign(new Error("exists"), { code: 6 });
    names.add(opts.taskId!);
    tasks.push({ taskId: opts.taskId!, body: body as Task["body"] });
    return opts.taskId!;
  });
  return { tasks, enqueue };
}

/**
 * A stand-in for the worker that follows the chunk handler's state rules: a delivery claims its step, does the
 * stage, advances (step + 1, a new task at the back of the queue) or finishes and tops up the window.
 */
async function deliver(queue: ReturnType<typeof fakeQueue>, task: Task, events: string[], window: number) {
  const [chunk] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, task.body.chunkId));
  if (!chunk || chunk.stage !== task.body.stage || chunk.step !== task.body.step || chunk.status !== "queued") return "stale";
  events.push(`${chunk.batchId}:${chunk.index}:${chunk.stage}`);
  if (chunk.stage === "qa") {
    await db.update(catalogChunks).set({ status: "done" }).where(eq(catalogChunks.id, chunk.id));
    await dispatchChunks(db, queue.enqueue, chunk.batchId, { window });
  } else {
    const [next] = await db.update(catalogChunks).set({ stage: chunk.stage === "matte" ? "render" : "qa", step: chunk.step + 1 }).where(eq(catalogChunks.id, chunk.id)).returning();
    await enqueueChunk(queue.enqueue, next!);
  }
  return "done";
}

describe("chunk task ids and env", () => {
  it("names one task per chunk step and reads the window and budget env", () => {
    expect(chunkTaskId("c1", "render", 2)).toBe("chunk-c1-render-2");
    expect(chunkWindow({})).toBe(8);
    expect(chunkWindow({ CATALOG_CHUNK_WINDOW: "3" })).toBe(3);
    expect(chunkWindow({ CATALOG_CHUNK_WINDOW: "x" })).toBe(8);
    expect(chunkTimeBudgetMs({})).toBe(CHUNK_TIME_BUDGET_MS);
    expect(chunkTimeBudgetMs({ CATALOG_CHUNK_TIME_BUDGET_MS: "60000" })).toBe(60_000);
    expect(chunkTimeBudgetMs({ CATALOG_CHUNK_TIME_BUDGET_MS: "900000" })).toBe(CHUNK_TIME_BUDGET_MS);
    expect(chunkTimeBudgetMs({ CATALOG_CHUNK_TIME_BUDGET_MS: "-5" })).toBe(CHUNK_TIME_BUDGET_MS);
  });
});

describe("batch class (spec 16)", () => {
  it("bulk at BULK_BATCH_PRODUCTS products or a Test Brand load batch; the window follows the class", () => {
    const batch = (products: number, name = "Spring drop", isTest = false) => ({ isTest, name, counts: { products } });
    expect(isBulkBatch(batch(99), {})).toBe(false);
    expect(isBulkBatch(batch(100), {})).toBe(true);
    expect(isBulkBatch(batch(20), { BULK_BATCH_PRODUCTS: "20" })).toBe(true);
    expect(isBulkBatch(batch(3, `${LOAD_BATCH_NAME_PREFIX}r1 A`, true), {})).toBe(true);
    expect(isBulkBatch(batch(3, `${LOAD_BATCH_NAME_PREFIX}r1 A`, false), {})).toBe(false);
    expect(isBulkBatch({ isTest: false, name: "x", counts: null }, {})).toBe(false);
    expect(windowFor(false, { CATALOG_CHUNK_WINDOW: "8", CATALOG_BULK_WINDOW: "30" })).toBe(8);
    expect(windowFor(true, { CATALOG_CHUNK_WINDOW: "8", CATALOG_BULK_WINDOW: "30" })).toBe(30);
    expect(windowFor(true, { CATALOG_CHUNK_WINDOW: "5" })).toBe(5);
  });
});

describe("dispatchChunks (E5)", () => {
  it("20 chunks with window 3: Start queues 3, each finished chunk queues exactly one more, all finish, none twice", async () => {
    const batchId = await batchWith(20, "window"), queue = fakeQueue(), events: string[] = [];
    expect(await dispatchChunks(db, queue.enqueue, batchId, { window: 3, now: T0 })).toBe(3);
    expect(await dispatchChunks(db, queue.enqueue, batchId, { window: 3, now: T0 })).toBe(0);
    expect(queue.tasks.map((t) => t.taskId)).toEqual((await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, batchId))).filter((c) => c.index < 3).sort((a, b) => a.index - b.index).map((c) => chunkTaskId(c.id, "matte", 0)));
    let maxQueued = 0;
    while (queue.tasks.length) {
      maxQueued = Math.max(maxQueued, queue.tasks.length);
      await deliver(queue, queue.tasks.shift()!, events, 3);
    }
    const chunks = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, batchId));
    expect(chunks.every((c) => c.status === "done")).toBe(true);
    expect(maxQueued).toBeLessThanOrEqual(3);
    // Each chunk ran each stage once: 60 deliveries, 20 matte tasks.
    expect(events).toHaveLength(60);
    expect(new Set(events).size).toBe(60);
    expect(queue.enqueue.mock.calls.filter(([, body]) => (body as Task["body"]).stage === "matte")).toHaveLength(20);
  });

  it("two batches on a FIFO queue with 2 slots: B's first image is made before A's 6th chunk starts", async () => {
    const a = await batchWith(20, "A"), queue = fakeQueue(), events: string[] = [];
    await dispatchChunks(db, queue.enqueue, a, { window: 3, now: T0 });
    // B starts a little later, while A runs.
    let b: string | undefined;
    let deliveries = 0, maxPerBatch = 0;
    while (queue.tasks.length) {
      const slots = queue.tasks.splice(0, 2);
      for (const task of slots) await deliver(queue, task, events, 3);
      if (++deliveries === 2 && !b) { b = await batchWith(2, "B"); await dispatchChunks(db, queue.enqueue, b, { window: 3, now: T0 }); }
      const ids = new Map((await db.select().from(catalogChunks)).map((c) => [c.id, c.batchId]));
      for (const batch of [a, b]) maxPerBatch = Math.max(maxPerBatch, queue.tasks.filter((t) => ids.get(t.body.chunkId) === batch).length);
    }
    const firstImageOfB = events.findIndex((e) => e.startsWith(`${b}:`) && e.endsWith(":render"));
    const sixthChunkOfA = events.indexOf(`${a}:5:matte`);
    expect(firstImageOfB).toBeGreaterThan(-1);
    expect(firstImageOfB).toBeLessThan(sixthChunkOfA);
    expect(maxPerBatch).toBeLessThanOrEqual(3);
  });

  it("puts a chunk back to waiting when its enqueue fails, so the next call queues it", async () => {
    const batchId = await batchWith(2, "fail"), queue = fakeQueue(), log = vi.fn();
    const failing = vi.fn(async () => { throw new Error("UNAVAILABLE"); });
    expect(await dispatchChunks(db, failing, batchId, { window: 1, now: T0, log })).toBe(1);
    expect(log).toHaveBeenCalledWith("chunk dispatch failed", expect.objectContaining({ severity: "WARNING" }));
    expect(await dispatchChunks(db, queue.enqueue, batchId, { window: 1, now: T0 })).toBe(1);
    expect(queue.tasks).toHaveLength(1);
  });

  it("queues nothing for a batch that is not processing", async () => {
    const batchId = await batchWith(2, "failed"), queue = fakeQueue();
    await db.update(catalogBatches).set({ status: "failed" }).where(eq(catalogBatches.id, batchId));
    expect(await dispatchChunks(db, queue.enqueue, batchId, { now: T0 })).toBe(0);
  });
});

describe("recoverBatchChunks (E4)", () => {
  it("recovers a lapsed lease and a lost task once, and never a live lease or a recent task", async () => {
    const batchId = await batchWith(5, "recover"), queue = fakeQueue(), log = vi.fn();
    const rows = (await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, batchId))).sort((x, y) => x.index - y.index);
    const set = (i: number, patch: Partial<typeof catalogChunks.$inferInsert>) => db.update(catalogChunks).set(patch).where(eq(catalogChunks.id, rows[i]!.id));
    await set(0, { status: "running", startedAt: at(-5 * 3600_000), leaseUntil: at(10 * 60_000), dispatchedAt: at(-5 * 3600_000) }); // live lease (renewed), 5 h old
    await set(1, { status: "running", startedAt: at(-300_000), leaseUntil: at(-1_000), dispatchedAt: at(-300_000), step: 2 }); // lapsed
    await set(2, { status: "queued", dispatchedAt: at(-5 * 60_000) }); // waiting 5 min
    await set(3, { status: "queued", dispatchedAt: at(-31 * 60_000), step: 1 }); // lost
    await set(4, { status: "running", startedAt: at(-10 * 60_000), leaseUntil: null, dispatchedAt: at(-10 * 60_000), stepKnown: false }); // pre-0004 claim, 10 min
    const result = await recoverBatchChunks(db, queue.enqueue, batchId, { now: T0, window: 5, log });
    expect(result).toEqual({ lapsed: 1, lost: 1, unstarted: 0, dispatched: 0 });
    expect(queue.tasks.map((t) => t.taskId).sort()).toEqual([chunkTaskId(rows[1]!.id, "matte", 3), chunkTaskId(rows[3]!.id, "matte", 2)].sort());
    expect(log).toHaveBeenCalledWith("chunk recovered", expect.objectContaining({ chunkId: rows[1]!.id, reason: "lease_lapsed", step: 3 }));
    expect(log).toHaveBeenCalledWith("chunk recovered", expect.objectContaining({ chunkId: rows[3]!.id, reason: "task_lost", step: 2 }));
    // The same minute: nothing more.
    expect(await recoverBatchChunks(db, queue.enqueue, batchId, { now: at(30_000), window: 5, log })).toEqual({ lapsed: 0, lost: 0, unstarted: 0, dispatched: 0 });
    // A pre-0004 claim keeps its 960 s lease: untouched at 10 min, recovered at 17 min.
    expect((await recoverBatchChunks(db, queue.enqueue, batchId, { now: at(7 * 60_000), window: 5, log })).lapsed).toBe(1);
    const [legacy] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, rows[4]!.id));
    expect(legacy).toMatchObject({ status: "queued", step: 1, stepKnown: true });
    const [live] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, rows[0]!.id));
    expect(live).toMatchObject({ status: "running", step: 0 });
  });
});

describe("redispatchUnstartedChunks (spec 17 G4)", () => {
  it("re-sends a step whose task never started after 6 min, once per step; leaves a step that ran, a recent one and a running one alone", async () => {
    const batchId = await batchWith(4, "unstarted"), queue = fakeQueue(), log = vi.fn();
    const rows = (await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, batchId))).sort((x, y) => x.index - y.index);
    const set = (i: number, patch: Partial<typeof catalogChunks.$inferInsert>) => db.update(catalogChunks).set(patch).where(eq(catalogChunks.id, rows[i]!.id));
    await set(0, { status: "queued", step: 1, startedAt: at(-10 * 60_000), dispatchedAt: at(-7 * 60_000) }); // handed off 7 min ago, task never started
    await set(1, { status: "queued", step: 1, startedAt: at(-7 * 60_000), dispatchedAt: at(-9 * 60_000) }); // its step ran and failed: its own retry is due
    await set(2, { status: "queued", dispatchedAt: at(-5 * 60_000) }); // waiting 5 min
    await set(3, { status: "running", taskName: "alive", startedAt: at(-60_000), leaseUntil: at(60_000), dispatchedAt: at(-20 * 60_000) });
    expect(await redispatchUnstartedChunks(db, queue.enqueue, batchId, { now: T0, log })).toBe(1);
    expect(queue.tasks.map((t) => t.taskId)).toEqual([chunkTaskId(rows[0]!.id, "matte", 2)]);
    expect(log).toHaveBeenCalledWith("chunk recovered", expect.objectContaining({ chunkId: rows[0]!.id, reason: "task_not_started", step: 2 }));
    const [resent] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, rows[0]!.id));
    expect(resent).toMatchObject({ status: "queued", step: 2, taskName: REDISPATCHED_TASK, dispatchedAt: T0 });
    // Twice at once, or again 7 min later: the re-sent step is not re-sent (the 5-min one now is).
    expect(await redispatchUnstartedChunks(db, queue.enqueue, batchId, { now: T0, log })).toBe(0);
    expect(await redispatchUnstartedChunks(db, queue.enqueue, batchId, { now: at(7 * 60_000), log })).toBe(1);
    expect(queue.tasks.map((t) => t.taskId)).toEqual([chunkTaskId(rows[0]!.id, "matte", 2), chunkTaskId(rows[2]!.id, "matte", 1)]);
    expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id, rows[1]!.id)))[0]).toMatchObject({ step: 1, taskName: null });
    // The 30-minute lost-task rule still covers a re-sent step whose new task is lost too.
    await recoverBatchChunks(db, queue.enqueue, batchId, { now: at(31 * 60_000), window: 4, log });
    expect(queue.tasks.map((t) => t.taskId)).toContain(chunkTaskId(rows[0]!.id, "matte", 3));
    expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id, rows[0]!.id)))[0]).toMatchObject({ step: 3, taskName: null });
  });
});
