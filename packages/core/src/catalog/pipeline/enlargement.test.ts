// Spec 18 enlargement lifecycle, the pure owner (pipeline/enlargement.ts): identity, size arithmetic and routes (3.2,
// the worked examples of T28, T53, T54), the one validator (3.3), and the park, unpark, release and re-send rules on
// PGlite (3.8). These are unit tests of the owner module's own SQL, so they seed rows directly; every failure-table
// scenario (T1-T69) drives the real entry points in the worker.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogChunks, catalogEnlargements, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "../../db/schema";
import { dispatchChunks, recoverBatchChunks } from "./dispatch";
import {
  effectiveScale, enlargedDims, enlargedMetadata, enlargementRouteFor, ENLARGE_MAX_OUTPUT_PIXELS, ENLARGE_SEND_SLOW_MS, ENLARGE_SEND_WARN, ENLARGE_STALE_MS,
  ENLARGING_TASK, enlargementOptionFromEnv, identityOf, lockProductChunks, pixelHashOf, releaseEnlargements, routeFor, tilesFor, unparkSettledChunks, upscalerIdentityId, validateEnlargedObject,
} from "./enlargement";

const env = { UPSCALE_MAX_PIXELS: "8000000", UPSCALE_MAX_PIXELS_X4: "6400000" } as NodeJS.ProcessEnv;

describe("spec 18 lifecycle 3.2: identity and the size arithmetic", () => {
  it("identity: the prepared pixels with their size, the upscaler with its export hash and the scale", () => {
    const rgb = Buffer.alloc(12, 7);
    const p = pixelHashOf(rgb, 2, 2);
    expect(p).toMatch(/^[0-9a-f]{16}$/);
    expect(pixelHashOf(rgb, 4, 1)).not.toBe(p);
    expect(pixelHashOf(Buffer.alloc(12, 8), 2, 2)).not.toBe(p);
    expect(upscalerIdentityId("swinir-x2+cpu")).toBe("swinir-x2+cpu@9f4a3f85");
    expect(upscalerIdentityId("swinir-x4")).toBe("swinir-x4@f477a052");
    expect(upscalerIdentityId("swinir-x2+cpu", "deadbeef")).toBe("swinir-x2+cpu@deadbeef");
    const id = identityOf(p, "swinir-x2+cpu@9f4a3f85", 2);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(identityOf(p, "swinir-x2+cpu@9f4a3f85", 2)).toBe(id);
    expect(identityOf(p, "swinir-x2+cpu@deadbeef", 2)).not.toBe(id);
    expect(identityOf(p, "swinir-x2+cpu@9f4a3f85", 1.788)).not.toBe(id);
  });

  it("the worked examples: scale, shrunk, out = f x shrunk, route", () => {
    const at = (w: number, h: number, f: 2 | 4, need: number) => enlargementRouteFor(w, h, f, need, env);
    expect(at(3000, 3000, 2, 2.1)).toEqual({ route: "tiles", scale: 2, shrunkW: 3000, shrunkH: 3000, outW: 6000, outH: 6000 });
    expect(at(4000, 4000, 2, 2.1)).toEqual({ route: "tiles", scale: 2, shrunkW: 4000, shrunkH: 4000, outW: 8000, outH: 8000 });
    expect(at(5000, 4000, 2, 1.5 * 1.05)).toEqual({ route: "downscale_tiles", scale: 1.788, shrunkW: 4470, shrunkH: 3576, outW: 8940, outH: 7152 });
    expect(at(2400, 2400, 4, 2.5 * 1.05)).toEqual({ route: "downscale", scale: 3.333, shrunkW: 1999, shrunkH: 1999, outW: 7996, outH: 7996 });
    expect(at(2400, 2400, 4, 3.5 * 1.05).route).toBe("none");
    expect(at(6000, 6000, 2, 1.2 * 1.05)).toEqual({ route: "downscale_tiles", scale: 1.333, shrunkW: 3999, shrunkH: 3999, outW: 7998, outH: 7998 });
    expect(at(6000, 6000, 2, 1.4 * 1.05).route).toBe("none");
    expect(at(10000, 10000, 4, 1.0 * 1.05)).toMatchObject({ route: "none", scale: 0.8 });
    expect(at(800, 1200, 2, 2.1)).toEqual({ route: "direct", scale: 2, shrunkW: 800, shrunkH: 1200, outW: 1600, outH: 2400 });
    expect(at(800, 1200, 4, 4.2)).toEqual({ route: "direct", scale: 4, shrunkW: 800, shrunkH: 1200, outW: 3200, outH: 4800 });
    // At the model's factor a route always exists, whatever the need (the band's slack can pass the factor).
    expect(at(1000, 1000, 2, 2.1).route).toBe("direct");
  });

  it("the output never passes the 64 MP limit, and the scale is the largest 3-decimal one that keeps it", () => {
    for (const [w, h, f] of [[2400, 2400, 4], [5000, 4000, 2], [6000, 6000, 2], [4000, 4000, 2], [7999, 3001, 2], [1999, 2001, 4], [12345, 678, 4]] as const) {
      const scale = effectiveScale(w, h, f), d = enlargedDims(w, h, f, scale);
      expect(d.outW * d.outH).toBeLessThanOrEqual(ENLARGE_MAX_OUTPUT_PIXELS);
      expect(d.outW).toBe(f * d.shrunkW);
      expect(d.outH).toBe(f * d.shrunkH);
      if (scale < f) expect(w * h * (scale + 0.001) ** 2).toBeGreaterThan(ENLARGE_MAX_OUTPUT_PIXELS);
      expect(Math.max(d.outW, d.outH)).toBeLessThan(65_500);
    }
  });

  it("tiles: strips along the longer side, each within the cap with 64 px of overlap; the cores cover the photo once", () => {
    expect(tilesFor(3000, 3000, 8_000_000)).toHaveLength(2);
    expect(tilesFor(4000, 4000, 8_000_000)).toHaveLength(3);
    expect(tilesFor(800, 1200, 8_000_000)).toHaveLength(1);
    for (const [w, h] of [[3000, 3000], [4470, 3576], [1000, 16000]] as const) {
      const tiles = tilesFor(w, h, 8_000_000);
      for (const t of tiles) expect(t.w * t.h).toBeLessThanOrEqual(8_000_000);
      const covered = tiles.reduce((sum, t) => sum + t.coreW * t.coreH, 0);
      expect(covered).toBe(w * h);
    }
  });

  it("routeFor reads the batch's pinned route; a batch from before the stage has none", () => {
    expect(routeFor({ options: {} })).toBeNull();
    expect(routeFor({ options: { enlargement: { model: "swinir-x2" } } })).toEqual({ model: "swinir-x2", x4Model: null, minScale: 1.5, target: null });
    expect(routeFor({ options: { enlargement: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 } } })).toEqual({ model: "swinir-x2", x4Model: "swinir-x4", minScale: 1, target: null });
    // Spec 18 GPU upscaler: a batch started with UPSCALE_TARGET=gpu keeps the GPU for its whole life.
    expect(routeFor({ options: { enlargement: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1, target: "gpu" } } })).toEqual({ model: "swinir-x2", x4Model: "swinir-x4", minScale: 1, target: "gpu" });
  });

  it("GPU upscaler: Start pins target gpu only with UPSCALE_TARGET=gpu; cpu or unset pins none (the worker's UPSCALE_URL target)", () => {
    const env = { UPSCALE_MODEL: "swinir-x2", UPSCALE_MODEL_X4: "swinir-x4", UPSCALE_MIN_SCALE: "1" };
    expect(enlargementOptionFromEnv(env)).toEqual({ model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 });
    expect(enlargementOptionFromEnv({ ...env, UPSCALE_TARGET: "cpu" })).toEqual({ model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 });
    expect(enlargementOptionFromEnv({ ...env, UPSCALE_TARGET: "gpu" })).toEqual({ model: "swinir-x2", x4Model: "swinir-x4", minScale: 1, target: "gpu" });
    expect(enlargementOptionFromEnv({ ...env, UPSCALE_MODEL: "off", UPSCALE_TARGET: "gpu" })).toBeNull();
  });
});

describe("spec 18 lifecycle 3.3: validateEnlargedObject, the one judge of a stored object", () => {
  const row = { identityHash: "0123456789abcdef", outW: 40, outH: 30, pixelHash: "p", upscaler: "u@h", scale: 2 };
  const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  it("accepts the right identity and exact size; refuses another identity, another size, a truncated file and a wrong tile", async () => {
    const good = await jpeg(40, 30);
    expect(await validateEnlargedObject({ bytes: good, metadata: enlargedMetadata(row) }, row)).toEqual({ ok: true });
    expect((await validateEnlargedObject({ bytes: good, metadata: { ...enlargedMetadata(row), identity: "x" } }, row)).ok).toBe(false);
    expect((await validateEnlargedObject({ bytes: await jpeg(40, 29), metadata: enlargedMetadata(row) }, row)).ok).toBe(false);
    expect((await validateEnlargedObject({ bytes: good.subarray(0, Math.floor(good.length / 2)), metadata: enlargedMetadata(row) }, row)).ok).toBe(false);
    expect((await validateEnlargedObject({ bytes: Buffer.from("not a jpeg"), metadata: enlargedMetadata(row) }, row)).ok).toBe(false);
    const tile = await jpeg(20, 30);
    expect(await validateEnlargedObject({ bytes: tile, metadata: enlargedMetadata(row, 1) }, row, { index: 1, w: 20, h: 30 })).toEqual({ ok: true });
    expect((await validateEnlargedObject({ bytes: tile, metadata: enlargedMetadata(row, 0) }, row, { index: 1, w: 20, h: 30 })).ok).toBe(false);
  });
});

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

const T0 = new Date("2026-10-29T08:00:00Z");
const at = (ms: number) => new Date(+T0 + ms);
function fakeQueue() {
  const tasks: { route: string; taskId: string; body: Record<string, unknown> }[] = [];
  const enqueue = vi.fn(async (route: string, body: Record<string, unknown>, opts: { taskId?: string } = {}) => { tasks.push({ route, taskId: opts.taskId!, body }); return opts.taskId!; });
  return { tasks, enqueue };
}

/** A batch with one product of three photos in chunk 0 (parked at the render stage) and two plain waiting chunks. */
async function parkedBatch(name: string, status: "rendering" | "done" = "rendering") {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name, isTest: true, createdBy: "t@opptra.com", status, counts: EMPTY_BATCH_COUNTS }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: `${name}-p`, pathKey: `${name}-p`, identifier: `${name}-p` }).returning();
  const photos = [];
  for (const n of [1, 2, 3]) {
    const [row] = await db.insert(catalogSourceImages).values({ productId: product!.id, batchId: batch!.id, n, sha256: `${name}-${n}`, originalName: `p_${n}.jpg`, rawUri: `gs://a/${name}/${n}.jpg`, mime: "image/jpeg", matteUri: `gs://a/${name}/${n}.png` }).returning();
    photos.push(row!);
  }
  const row = (photo: { id: string }, identity: string, extra: Partial<typeof catalogEnlargements.$inferInsert> = {}) => db.insert(catalogEnlargements).values({ batchId: batch!.id, productId: product!.id, sourceImageId: photo.id, upscaler: "swinir-x2+cpu@9f4a3f85", factor: 2, scale: 2, outW: 200, outH: 200, route: "direct", pixelHash: "p", identityHash: identity, ...extra }).returning();
  // Photo 1 queued, photo 2 not needed, photo 3 queued.
  const [r1] = await row(photos[0]!, "i1"), [r3] = await row(photos[2]!, "i3", { attempts: 2 });
  const [parked] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "render", status: "queued", step: 1, stepKnown: true, productIds: [product!.id], attempt: 0, taskName: ENLARGING_TASK, dispatchedAt: at(0), progressAt: at(0) }).returning();
  for (const index of [1, 2]) await db.insert(catalogChunks).values({ batchId: batch!.id, index, stage: "matte", status: "queued", productIds: [], attempt: 0 });
  return { batchId: batch!.id, productId: product!.id, photos, rows: [r1!, r3!], parkedId: parked!.id };
}
const settle = (s: Awaited<ReturnType<typeof parkedBatch>>, id: string, patch: Partial<typeof catalogEnlargements.$inferInsert>, now = at(2000)) => db.transaction(async (tx) => {
  const chunks = await lockProductChunks(tx as unknown as Db, s.batchId, s.productId);
  await tx.update(catalogEnlargements).set(patch).where(eq(catalogEnlargements.id, id));
  return unparkSettledChunks(tx as unknown as Db, s.batchId, chunks, now);
});

describe("spec 18 lifecycle 3.8: park, unpark, release and the re-send", () => {
  it("a parked chunk holds no slot and is never dispatched; it is unparked once its last wanted queued row settles, then dispatched once", async () => {
    const s = await parkedBatch("gate"), queue = fakeQueue();
    expect(await dispatchChunks(db, queue.enqueue, s.batchId, { now: at(1000), window: 2 })).toBe(2);
    expect(queue.tasks.map((t) => t.body.chunkId)).not.toContain(s.parkedId);
    expect(await settle(s, s.rows[0]!.id, { status: "done" })).toEqual([]);
    expect(await settle(s, s.rows[1]!.id, { status: "failed" })).toEqual([{ id: s.parkedId, batchId: s.batchId, stage: "render", step: 1, direct: false }]);
    expect(await settle(s, s.rows[1]!.id, { status: "failed" })).toEqual([]);
    const [row] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(row).toMatchObject({ stage: "render", status: "queued", taskName: null, dispatchedAt: null, step: 1 });
    await db.update(catalogChunks).set({ status: "done" }).where(eq(catalogChunks.batchId, s.batchId));
    await db.update(catalogChunks).set({ status: "queued" }).where(eq(catalogChunks.id, s.parkedId));
    expect(await dispatchChunks(db, queue.enqueue, s.batchId, { now: at(3000), window: 2 })).toBe(1);
    expect(queue.tasks.at(-1)).toMatchObject({ route: "/tasks/catalog/chunk", taskId: `chunk-${s.parkedId}-render-1` });
  });

  it("a released row no longer holds the chunk; on a done batch the unpark keeps dispatched_at and asks for a direct enqueue", async () => {
    const s = await parkedBatch("done-batch", "done");
    await releaseEnlargements(db, { batchId: s.batchId, sourceImageIds: [s.photos[0]!.id], errorKind: "replaced" }, at(1000));
    const [released] = await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, s.rows[0]!.id));
    expect(released).toMatchObject({ wanted: false, status: "queued", errorKind: "replaced" });
    const unparked = await settle(s, s.rows[1]!.id, { status: "done" }, at(5000));
    expect(unparked).toEqual([{ id: s.parkedId, batchId: s.batchId, stage: "render", step: 1, direct: true }]);
    const [row] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(row).toMatchObject({ taskName: null, dispatchedAt: at(5000) });
  });

  it("recovery: a parked chunk with recent progress is left alone; a stale one re-sends its wanted queued rows with sends + 1; after 20 sends every 6 h with an ERROR line", async () => {
    const s = await parkedBatch("stale"), queue = fakeQueue(), lines: [string, Record<string, unknown> | undefined][] = [];
    const log = (message: string, fields?: Record<string, unknown>) => { lines.push([message, fields]); };
    let r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS - 1000), window: 0, log });
    expect(r.enlarge).toBe(0);
    r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS + 1000), window: 0, log });
    expect(r.enlarge).toBe(2);
    const sent = queue.tasks.filter((t) => t.route === "/tasks/catalog/enlarge");
    expect(sent.map((t) => t.taskId).sort()).toEqual([`enlarge-${s.rows[0]!.id}-1`, `enlarge-${s.rows[1]!.id}-1`].sort());
    expect(sent[0]!.body).toEqual({ batchId: s.batchId, productId: s.productId, enlargementId: expect.any(String) });
    // The lost-task rule never re-sends a parked chunk as a stage task, however old its dispatched_at.
    expect(queue.tasks.filter((t) => t.route === "/tasks/catalog/chunk").map((t) => t.body.chunkId)).not.toContain(s.parkedId);
    r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(ENLARGE_STALE_MS + 2000), window: 0, log });
    expect(r.enlarge).toBe(0);
    // Past 20 sends: the hourly pace stops; a re-send waits 6 h after the last one and logs ERROR.
    await db.update(catalogEnlargements).set({ sends: ENLARGE_SEND_WARN, updatedAt: at(2 * ENLARGE_STALE_MS) }).where(eq(catalogEnlargements.id, s.rows[0]!.id));
    await db.update(catalogEnlargements).set({ status: "done" }).where(eq(catalogEnlargements.id, s.rows[1]!.id));
    r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(4 * ENLARGE_STALE_MS), window: 0, log });
    expect(r.enlarge).toBe(0);
    r = await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(2 * ENLARGE_STALE_MS + ENLARGE_SEND_SLOW_MS + 1000), window: 0, log });
    expect(r.enlarge).toBe(1);
    expect(lines.some(([m, f]) => m === "enlargement task cannot be delivered" && f?.severity === "ERROR" && f?.sends === ENLARGE_SEND_WARN + 1)).toBe(true);
    const [still] = await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, s.rows[0]!.id));
    expect(still).toMatchObject({ status: "queued", wanted: true, sends: ENLARGE_SEND_WARN + 1 });
    // Settled without unparking it (a lost write): recovery unparks it.
    await db.update(catalogEnlargements).set({ status: "done" }).where(eq(catalogEnlargements.batchId, s.batchId));
    await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(10 * ENLARGE_STALE_MS), window: 0, log });
    const [after] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(after).toMatchObject({ taskName: null, dispatchedAt: null, status: "queued" });
  });

  it("the rollback switch: recovery releases the queued rows and unparks", async () => {
    const s = await parkedBatch("off"), queue = fakeQueue();
    await recoverBatchChunks(db, queue.enqueue, s.batchId, { now: at(1000), window: 0, enlargementOff: true });
    const rows = await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.batchId, s.batchId));
    expect(rows.every((r) => !r.wanted && r.errorKind === "off")).toBe(true);
    const [after] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.parkedId));
    expect(after).toMatchObject({ taskName: null, status: "queued" });
  });

  it("a one-photo chunk waits only on its own photos' rows", async () => {
    const s = await parkedBatch("replacement");
    await db.update(catalogChunks).set({ sourceImageIds: [s.photos[1]!.id] }).where(eq(catalogChunks.id, s.parkedId));
    const unparked = await db.transaction(async (tx) => unparkSettledChunks(tx as unknown as Db, s.batchId, await lockProductChunks(tx as unknown as Db, s.batchId, s.productId), at(1000)));
    expect(unparked.map((u) => u.id)).toEqual([s.parkedId]);
  });
});
