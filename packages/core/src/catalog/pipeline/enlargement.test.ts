// Tier 2 (PGlite): spec 18 H3's render gate. A chunk parked for its photos' enlargements holds no window slot, is never
// dispatched, is unparked only once no photo of it is queued, and its recovery re-sends only queued photos, as a new
// round, once the chunk saw no attempt for ENLARGE_STALE_MS.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogChunks, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "../../db/schema";
import { dispatchChunks, recoverBatchChunks } from "./dispatch";
import { ENLARGE_STALE_MS, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, lockProductChunks, photoEnlargementState, unparkSettledChunks } from "./enlargement";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

const T0 = new Date("2026-10-29T08:00:00Z");
const at = (ms: number) => new Date(+T0 + ms);

function fakeQueue() {
  const tasks: { route: string; taskId: string; body: Record<string, unknown>; bulk?: boolean }[] = [];
  const enqueue = vi.fn(async (route: string, body: Record<string, unknown>, opts: { taskId?: string; bulk?: boolean } = {}) => { tasks.push({ route, taskId: opts.taskId!, body, ...(opts.bulk ? { bulk: true } : {}) }); return opts.taskId!; });
  return { tasks, enqueue };
}

/** A batch with one product of three photos in chunk 0 (parked at the render stage) and two plain waiting chunks. */
async function parkedBatch(name: string) {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name, isTest: true, createdBy: "t@opptra.com", status: "rendering", counts: EMPTY_BATCH_COUNTS }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: `${name}-p`, pathKey: `${name}-p`, identifier: `${name}-p` }).returning();
  const photos = [];
  for (const n of [1, 2, 3]) {
    const [row] = await db.insert(catalogSourceImages).values({ productId: product!.id, batchId: batch!.id, n, sha256: `${name}-${n}`, originalName: `p_${n}.jpg`, rawUri: `gs://a/${name}/${n}.jpg`, mime: "image/jpeg", matteUri: `gs://a/${name}/${n}.png` }).returning();
    photos.push(row!);
  }
  // Photo 1 queued, photo 2 not needed, photo 3 queued.
  await db.update(catalogSourceImages).set({ x2Model: "swinir-x2+cpu" }).where(eq(catalogSourceImages.id, photos[0]!.id));
  await db.update(catalogSourceImages).set({ x2Model: "swinir-x2+cpu", x2Attempts: 2 }).where(eq(catalogSourceImages.id, photos[2]!.id));
  const [parked] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "render", status: "queued", step: 1, stepKnown: true, productIds: [product!.id], attempt: 0, taskName: ENLARGING_TASK, dispatchedAt: null, progressAt: at(0) }).returning();
  for (const index of [1, 2]) await db.insert(catalogChunks).values({ batchId: batch!.id, index, stage: "matte", status: "queued", productIds: [], attempt: 0 });
  return { batchId: batch!.id, productId: product!.id, photos, parkedId: parked!.id };
}

describe("spec 18: the render gate", () => {
  it("reads a photo's state from its four columns", () => {
    expect(photoEnlargementState({ x2Model: null, x2Uri: null, x2Attempts: 0 })).toBe("not_needed");
    expect(photoEnlargementState({ x2Model: "m", x2Uri: null, x2Attempts: ENLARGE_TASK_MAX_ATTEMPTS - 1 })).toBe("queued");
    expect(photoEnlargementState({ x2Model: "m", x2Uri: null, x2Attempts: ENLARGE_TASK_MAX_ATTEMPTS })).toBe("failed");
    expect(photoEnlargementState({ x2Model: "m", x2Uri: "gs://a/x.x2.jpg", x2Attempts: 3 })).toBe("done");
  });

  it("a parked chunk holds no slot and is never dispatched; it is unparked once its last queued photo settles, then dispatched first", async () => {
    const s = await parkedBatch("gate"), queue = fakeQueue();
    // Window 2: the parked chunk takes no slot, so both waiting chunks are queued and the parked one is not.
    expect(await dispatchChunks(db, queue.enqueue, s.batchId, { now: at(1000), window: 2 })).toBe(2);
    expect(queue.tasks.map((t) => t.body.chunkId)).not.toContain(s.parkedId);
    const settle = async (id: string, patch: Partial<typeof catalogSourceImages.$inferInsert>) => db.transaction(async (tx) => {
      const chunks = await lockProductChunks(tx as unknown as Db, s.batchId, s.productId);
      await tx.update(catalogSourceImages).set(patch).where(eq(catalogSourceImages.id, id));
      return unparkSettledChunks(tx as unknown as Db, chunks, at(2000));
    });
    // Photo 1 done: photo 3 is still queued, so the chunk stays parked.
    expect(await settle(s.photos[0]!.id, { x2Uri: "gs://a/1.x2.jpg" })).toEqual([]);
    // Photo 3 fails for good: nothing is queued now, the chunk is an ordinary waiting chunk.
    expect(await settle(s.photos[2]!.id, { x2Attempts: ENLARGE_TASK_MAX_ATTEMPTS, x2Error: "busy" })).toEqual([s.parkedId]);
    // A second settle (a duplicate delivery) changes nothing.
    expect(await settle(s.photos[2]!.id, { x2Error: "busy" })).toEqual([]);
    const [row] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(row).toMatchObject({ stage: "render", status: "queued", taskName: null, dispatchedAt: null, step: 1 });
    await db.update(catalogChunks).set({ status: "done" }).where(eq(catalogChunks.batchId, s.batchId));
    await db.update(catalogChunks).set({ status: "queued" }).where(eq(catalogChunks.id, s.parkedId));
    expect(await dispatchChunks(db, queue.enqueue, s.batchId, { now: at(3000), window: 2 })).toBe(1);
    expect(queue.tasks.at(-1)).toMatchObject({ route: "/tasks/catalog/chunk", taskId: `chunk-${s.parkedId}-render-1` });
  });

  it("recovery: a parked chunk with a recent attempt is left alone; a stale one takes the next step and re-sends only its queued photos as that round", async () => {
    const s = await parkedBatch("stale"), queue = fakeQueue();
    let r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS - 1000), window: 0 });
    expect(r.enlarge).toBe(0);
    expect(queue.tasks.filter((t) => t.route === "/tasks/catalog/enlarge")).toEqual([]);
    r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS + 1000), window: 0 });
    expect(r.enlarge).toBe(2);
    const sent = queue.tasks.filter((t) => t.route === "/tasks/catalog/enlarge");
    expect(sent.map((t) => t.taskId).sort()).toEqual([`enlarge-${s.photos[0]!.id}-2`, `enlarge-${s.photos[2]!.id}-2`].sort());
    expect(sent[0]!.body).toMatchObject({ batchId: s.batchId, productId: s.productId, round: 2 });
    const [row] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(row).toMatchObject({ step: 2, taskName: ENLARGING_TASK, dispatchedAt: null });
    // Right after, the progress is fresh: nothing is sent twice.
    r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS + 2000), window: 0 });
    expect(r.enlarge).toBe(0);
    // Nothing queued any more (both settled without unparking it, a lost write): recovery unparks it.
    await db.update(catalogSourceImages).set({ x2Uri: "gs://a/x2.jpg" }).where(eq(catalogSourceImages.batchId, s.batchId));
    await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS + 3000), window: 0 });
    const [after] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(after).toMatchObject({ taskName: null, dispatchedAt: null, status: "queued" });
  });

  it("a replacement chunk waits only on its own photos", async () => {
    const s = await parkedBatch("replacement");
    // The chunk names photo 2 (not needed) only: nothing of it is queued, so the settle of any photo unparks it.
    await db.update(catalogChunks).set({ sourceImageIds: [s.photos[1]!.id] }).where(eq(catalogChunks.id, s.parkedId));
    const unparked = await db.transaction(async (tx) => unparkSettledChunks(tx as unknown as Db, await lockProductChunks(tx as unknown as Db, s.batchId, s.productId), at(1000)));
    expect(unparked).toEqual([s.parkedId]);
  });
});
