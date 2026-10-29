// Tier 2 (PGlite + fakes): the spec 18 enlargement lifecycle at the stages (plan section 6): the pinned route, the
// identity, the matte and render stages' reconcile, readiness and park, the sweep, and the size routes. Real entry
// points only (handleChunkTask, handleEnlargeTask, handlePublishTask, handleFinalizeTask, handleSweep,
// reconcileEnlargements); fakes for the upscale service, GCS, Cloud Tasks and the judge (test/enlarge-world.ts).
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogChunks, catalogEnlargements, catalogSourceImages } from "@catalog/core/db/schema";
import { enlargedBox, primeSourceX2, storedUpscaler, upscaledRgb } from "@catalog/core/catalog/upscale";
import { enlargementRouteFor, ENLARGING_TASK, tilesFor } from "@catalog/core/catalog/pipeline/enlargement";
import { dispatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { enlargementPlan } from "@catalog/core/catalog/render";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import { chunkRow } from "../../test/catalog-fakes";
import {
  batchOf, bigPhotos, boxMattePng, deliverChunk, drain, enlargeBody, enlargeTasks, enlargeUntilSettled, enlargeWorld, outputsOf, photosOf, rowsOf, seedEnlargeBatch, seedSecondBatch, startChunks, sweep, upscaleCosts, type EnlargeWorld,
} from "../../test/enlarge-world";
import { batchEnlargement, handleEnlargeTask, loadShotFromMatte, reconcileEnlargements } from "./enlarge";
import { currentChunkTask, handleChunkTask } from "./chunk";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

const rowNow = async (id: string) => (await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, id)))[0]!;
const invariants = async (batchId: string, now: Date) => (await runInvariants(db, () => {}, now, { batchId })).counts;
/** Runs a batch through the queue until it is quiet. */
async function runBatch(e: EnlargeWorld, s: { batch: { id: string }; chunks: { id: string }[] }) {
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  return drain(e.w, { only: { db, batchId: s.batch.id } });
}
/** The largest planned scale of a `width x height` photo with a centred `box` on Trendyol (the photo's need). */
function needOf(width: number, height: number, box: { w: number; h: number }, x4: boolean): number {
  const alpha = Buffer.alloc(width * height, 0), x0 = Math.floor((width - box.w) / 2), y0 = Math.floor((height - box.h) / 2);
  for (let y = y0; y < y0 + box.h; y++) alpha.fill(255, y * width + x0, y * width + x0 + box.w);
  const [needs] = enlargementPlan(["trendyol"], [{ width, height, rgb: Buffer.alloc(0), alpha, model: "fixture" }], "footwear", 1, x4);
  return Math.max(0, ...needs!.map((n) => n.maxScale));
}
/** A square-ish box (the photo's aspect) whose need on Trendyol is within 0.04 of `target`. */
function boxForNeed(width: number, height: number, target: number, x4: boolean): { w: number; h: number } {
  let lo = 0.02, hi = 1;
  for (let i = 0; i < 18; i++) {
    const f = (lo + hi) / 2, box = { w: Math.max(8, Math.round(width * f)), h: Math.max(8, Math.round(height * f)) };
    const need = needOf(width, height, box, x4);
    if (Math.abs(need - target) < 0.04) return box;
    if (need > target) lo = f; else hi = f;
  }
  throw new Error(`no box for need ${target}`);
}

describe("the pinned route (I9)", () => {
  it("T1 (F1): a batch started before the stage takes the plain path: no rows, no flag, the invariant holds", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t1", [[2]], { route: null });
    await runBatch(e, s);
    expect(await rowsOf(db, s.batch.id)).toEqual([]);
    const outs = await outputsOf(db, s.batch.id);
    expect(outs.every((o) => o.status === "verified" && !o.flags.includes("upscaled") && !o.flags.includes("enlargement_failed"))).toBe(true);
    expect(outs.every((o) => o.scale > 1.5)).toBe(true);
    expect((await invariants(s.batch.id, e.clock.now())).enlarged_without_upscaler).toBe(0);
    expect(e.service.paid()).toBe(0);
  }, 120_000);

  it("T2 (F2): a batch pinned at 1.5: its 1.0-1.5x outputs render plain without a flag, whatever the worker's env; the invariant agrees", async () => {
    const e = enlargeWorld(db, { imageScale: 1 });
    const s = await seedEnlargeBatch(db, e.w, "t2", [[1]], { channels: ["noon"], route: { model: "swinir-x2", minScale: 1.5 } });
    await withEnv({ UPSCALE_MIN_SCALE: "1.0" }, () => runBatch(e, s));
    expect(await rowsOf(db, s.batch.id)).toEqual([]);
    const [out] = await outputsOf(db, s.batch.id);
    expect(out!.scale).toBeGreaterThan(1); expect(out!.scale).toBeLessThanOrEqual(1.5);
    expect(out).toMatchObject({ status: "verified" });
    expect(out!.flags).not.toContain("upscaled"); expect(out!.flags).not.toContain("enlargement_failed");
    expect((await invariants(s.batch.id, e.clock.now())).enlarged_without_upscaler).toBe(0);
  }, 120_000);

  it("T3 (F3): a batch pinned without x4 keeps x2 when x4 is switched on later; a new batch pinned with x4 wants x4", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t3-old", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    await withEnv({ UPSCALE_MODEL_X4: "swinir-x4" }, async () => { await drain(e.w, { only: { db, batchId: s.batch.id } }); });
    expect((await rowsOf(db, s.batch.id)).map((r) => [r.factor, r.status])).toEqual([[2, "done"]]);
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
    const n = await seedEnlargeBatch(db, e.w, "t3-new", [[1]], { route: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 } });
    await deliverChunk(db, e.w, n.chunks[0]!.id);
    expect((await rowsOf(db, n.batch.id)).map((r) => r.factor)).toEqual([4]);
  }, 120_000);
});

describe("identity (I1)", () => {
  it("T4 (F4): two worker revisions with different export hashes: each identity made once, no hold, both objects kept", async () => {
    const e = enlargeWorld(db);
    e.w.deps.exportHashes = { "swinir-x2": "aaaa1111" };
    const s = await seedEnlargeBatch(db, e.w, "t4", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [a] = await rowsOf(db, s.batch.id);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(a!))).toMatchObject({ outcome: "done" });
    // The new revision renders: it wants its own identity, releases the old row and parks.
    const next = { ...e.w.deps, exportHashes: { "swinir-x2": "bbbb2222" } };
    expect(await handleChunkTask(next, await currentChunkTask(db, s.chunks[0]!.id))).toMatchObject({ httpStatus: 200 });
    const rows = (await rowsOf(db, s.batch.id)).sort((x, y) => Number(x.wanted) - Number(y.wanted));
    expect(rows.map((r) => [r.identityHash === a!.identityHash, r.wanted, r.status])).toEqual([[true, false, "done"], [false, true, "queued"]]);
    // A late task of the old identity, delivered by the old revision: settled, no call.
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(a!))).toMatchObject({ outcome: "settled" });
    expect(await handleEnlargeTask(next, enlargeBody(rows[1]!))).toMatchObject({ outcome: "done" });
    expect(e.service.paid()).toBe(2);
    expect(await handleChunkTask(next, await currentChunkTask(db, s.chunks[0]!.id))).toMatchObject({ httpStatus: 200 });
    const [out] = await outputsOf(db, s.batch.id);
    expect(out!.flags).toContain("upscaled"); expect(out!.flags).not.toContain("enlargement_failed");
    for (const r of await rowsOf(db, s.batch.id)) expect(e.w.objects.has(r.uri!)).toBe(true);
  }, 120_000);

  it("T5 (F5): an export hash change makes a new identity at a new key; the old object is untouched", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t5", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [old] = await rowsOf(db, s.batch.id);
    await handleEnlargeTask(e.w.deps, enlargeBody(old!));
    const oldUri = (await rowNow(old!.id)).uri!, oldBytes = Buffer.from(e.w.objects.get(oldUri)!);
    e.w.deps.exportHashes = { "swinir-x2": "ffff0000" };
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const fresh = (await rowsOf(db, s.batch.id)).find((r) => r.wanted)!;
    expect(fresh.identityHash).not.toBe(old!.identityHash);
    expect(fresh.pixelHash).toBe(old!.pixelHash);
    await handleEnlargeTask(e.w.deps, enlargeBody(fresh));
    const freshUri = (await rowNow(fresh.id)).uri!;
    expect(freshUri).not.toBe(oldUri);
    expect(e.w.objects.get(oldUri)!.equals(oldBytes)).toBe(true);
  }, 120_000);

  it("T7 (F7): a matte replaced after the matte stage (the guard's pass-through) keeps the identity: one row, no second call", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t7", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    await handleEnlargeTask(e.w.deps, enlargeBody(row!));
    const [photo] = await photosOf(db, s.batch.id);
    const p = await e.w.deps.prepare(e.w.objects.get(photo!.rawUri)!, photo!.originalName, async (b) => b);
    e.w.objects.set(photo!.matteUri!, await boxMattePng(p.width, p.height, 0));
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    expect((await rowsOf(db, s.batch.id)).map((r) => [r.id, r.wanted, r.status])).toEqual([[row!.id, true, "done"]]);
    expect(e.service.paid()).toBe(1);
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
  }, 120_000);

  it("T45 (F43): prepare changed between the matte stage and the handler: the row is released (identity_changed), no call; the render wants the new identity and completes", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t45", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    const prepare = e.w.deps.prepare;
    e.w.deps.prepare = (async (...args: Parameters<typeof prepare>) => { const p = await prepare(...args); p.rgb = Buffer.alloc(p.rgb.length, 99); return p; }) as typeof prepare;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 200, outcome: "released" });
    expect(await rowNow(row!.id)).toMatchObject({ wanted: false, identityReleases: 1, errorKind: "identity_changed" });
    expect(e.service.paid()).toBe(0);
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBeNull();
    await drain(e.w, { only: { db, batchId: s.batch.id } });
    const rows = await rowsOf(db, s.batch.id);
    expect(rows.find((r) => r.wanted)).toMatchObject({ status: "done" });
    expect(e.service.paid()).toBe(1);
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
  }, 120_000);

  it("T46 (F44): a failed row released and wanted again stays failed (hold kept); a done row released and wanted again is reused", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t46", [[2]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [bad, good] = await rowsOf(db, s.batch.id);
    e.service.state.mode = "badInput";
    await enlargeUntilSettled(e.w, bad!);
    e.service.state.mode = "ok";
    await handleEnlargeTask(e.w.deps, enlargeBody(good!));
    const [batch] = [await batchOf(db, s.batch.id)];
    const be = batchEnlargement(e.w.deps, batch)!;
    const photos = await photosOf(db, s.batch.id);
    const shots = await Promise.all(photos.map(async (source) => { const { p, alpha } = await loadShotFromMatte(e.w.deps, source, source.matteUri!, {}); return { source, p, alpha, matteModel: "fixture" }; }));
    const product = { id: photos[0]!.productId, productType: "footwear" as const };
    const write = <T>(fn: (d: Db) => Promise<T>) => fn(db);
    const scope = photos.map((p) => p.id);
    await reconcileEnlargements(e.w.deps, { be, batch, product, shots, scope, wanted: new Set(), mode: "queue", write });
    expect((await rowsOf(db, s.batch.id)).map((r) => [r.wanted, r.status])).toEqual([[false, "failed"], [false, "done"]]);
    const again = await reconcileEnlargements(e.w.deps, { be, batch, product, shots, scope, wanted: new Set(scope), mode: "queue", write });
    const byId = (x: [string, boolean, string], y: [string, boolean, string]) => x[0].localeCompare(y[0]);
    expect(again.rows.map((r) => [r.id, r.wanted, r.status] as [string, boolean, string]).sort(byId)).toEqual(([[bad!.id, true, "failed"], [good!.id, true, "done"]] as [string, boolean, string][]).sort(byId));
    expect(again).toMatchObject({ queued: false, terminal: 1 });
    // A render with nothing of these photos to prepare (T40 found it): a wanted photo without a shot keeps its rows,
    // so a held photo's failed row stays for Try again.
    await reconcileEnlargements(e.w.deps, { be, batch, product, shots: [], scope, wanted: new Set(scope), mode: "queue", write });
    expect((await rowsOf(db, s.batch.id)).every((r) => r.wanted)).toBe(true);
    expect(e.service.paid(bad!.productId)).toBe(ENLARGE_ATTEMPTS + 1);
  }, 120_000);

  it("T48 (F46): a second batch of the same photo: a new row, no call, done from the stored object", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t48", [[1]]);
    await runBatch(e, s);
    expect(e.service.paid()).toBe(1);
    const n = await seedSecondBatch(db, e.w, s, "t48-again");
    await runBatch(e, n);
    const [first] = await rowsOf(db, s.batch.id), [second] = await rowsOf(db, n.batch.id);
    expect(second!.id).not.toBe(first!.id);
    expect(second).toMatchObject({ status: "done", identityHash: first!.identityHash, uri: first!.uri });
    expect(e.service.paid()).toBe(1);
    expect((await outputsOf(db, n.batch.id)).every((o) => o.flags.includes("upscaled"))).toBe(true);
  }, 120_000);
});

describe("the stages", () => {
  it("T21 (F21): an enqueue that throws at the matte stage leaves the row to the stale re-send (sends 1); a redelivered matte stage sends the same task id once", async () => {
    const e = enlargeWorld(db);
    const enqueue = e.w.deps.enqueue;
    let failOnce = true;
    e.w.deps.enqueue = (async (route, body, opts) => { if (route === "/tasks/catalog/enlarge" && failOnce) { failOnce = false; throw new Error("tasks down"); } return enqueue(route, body, opts); }) as typeof enqueue;
    const s = await seedEnlargeBatch(db, e.w, "t21-lost", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    expect(enlargeTasks(e.w)).toEqual([]);
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBe(ENLARGING_TASK);
    e.clock.tick(61);
    await sweep(db, e.w);
    const [row] = await rowsOf(db, s.batch.id);
    expect(row!.sends).toBe(1);
    expect(enlargeTasks(e.w).filter((t) => t.body.batchId === s.batch.id).map((t) => t.taskId)).toEqual([`enlarge-${row!.id}-1`]);
    // A matte delivery that fails after its reconcile is redelivered: the same task id, one task in the queue.
    const f = enlargeWorld(db);
    const log = f.w.deps.log;
    let crash = true;
    f.w.deps.log = ((message: string, fields?: Record<string, unknown>) => { if (message === "catalog enlargement queued" && crash) { crash = false; throw new Error("crash after the send"); } return log(message, fields); }) as typeof log;
    const t = await seedEnlargeBatch(db, f.w, "t21-redelivered", [[1]]);
    expect((await deliverChunk(db, f.w, t.chunks[0]!.id)).httpStatus).toBe(503);
    expect((await deliverChunk(db, f.w, t.chunks[0]!.id)).httpStatus).toBe(200);
    const [r] = await rowsOf(db, t.batch.id);
    expect(enlargeTasks(f.w).map((x) => x.taskId)).toEqual([`enlarge-${r!.id}-0`]);
    expect(f.w.enqueue.mock.calls.filter(([route]) => route === "/tasks/catalog/enlarge")).toHaveLength(2);
  }, 120_000);

  it("T22 (F22): a crash after a held output's patch: the redelivery renders again; Try again then makes the image and the render uses it", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t22", [[1]], { channels: ["trendyol", "noon"] });
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    e.service.state.mode = "badInput";
    await enlargeUntilSettled(e.w, row!);
    // The delivery dies after the first held output's patch (its second render never returns); the lease lapses, the
    // sweep re-sends the step, and the redelivery renders the rest.
    const render = e.w.deps.renderAllChannels;
    let calls = 0;
    e.w.deps.renderAllChannels = (async (...args: Parameters<typeof render>) => { if (++calls === 2) await new Promise(() => {}); return render(...args); }) as typeof render;
    void deliverChunk(db, e.w, s.chunks[0]!.id);
    while (calls < 2) await new Promise((r) => setTimeout(r, 5));
    expect((await outputsOf(db, s.batch.id)).filter((o) => o.status === "needs_attention")).toHaveLength(1);
    e.clock.tick(3);
    await sweep(db, e.w);
    expect(await deliverChunk(db, e.w, s.chunks[0]!.id)).toMatchObject({ httpStatus: 200 });
    const held = await outputsOf(db, s.batch.id);
    expect(held.every((o) => o.flags.includes("enlargement_failed"))).toBe(true);
    e.service.state.mode = "ok";
    const { retryEnlargement } = await import("@catalog/core/catalog/decisions");
    const retry = await retryEnlargement(db, e.w.deps.enqueue, { outputId: held[0]!.id, actor: "op@opptra.com", now: e.clock.now() });
    await drain(e.w, { only: { db, batchId: s.batch.id } });
    expect((await chunkRow(db, retry.chunkId)).status).not.toBe("failed");
    const outs = await outputsOf(db, s.batch.id);
    expect(outs.every((o) => o.flags.includes("upscaled") && !o.flags.includes("enlargement_failed"))).toBe(true);
  }, 180_000);

  it("T23 (F23): storage heads failing during render deliveries are a dependency wait: 503 without a chunk error, then upscaled; no flag ever written", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t23", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    await handleEnlargeTask(e.w.deps, enlargeBody(row!));
    const uri = (await rowNow(row!.id)).uri!;
    const head = e.w.deps.storage.headObject;
    let fails = 5;
    e.w.deps.storage.headObject = (async (u: string) => { if (u === uri && fails > 0) { fails--; throw new Error("GCS 503"); } return head(u); }) as typeof head;
    for (let i = 0; i < 5; i++) {
      expect(await deliverChunk(db, e.w, s.chunks[0]!.id)).toMatchObject({ httpStatus: 503, outcome: "retry" });
      const chunk = await chunkRow(db, s.chunks[0]!.id);
      expect(chunk.status).toBe("queued"); expect(chunk.error).toBeNull();
      expect((await outputsOf(db, s.batch.id)).some((o) => o.flags.includes("enlargement_failed"))).toBe(false);
    }
    expect(await deliverChunk(db, e.w, s.chunks[0]!.id)).toMatchObject({ httpStatus: 200 });
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
    expect(e.w.log.mock.calls.filter(([m]) => m === "chunk failed")).toHaveLength(0);
  }, 120_000);

  it("T30 (F30): an object deleted after done: the render puts the row back to queued (counters kept), sends it in the same pass, parks; made again; upscaled", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t30", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    e.service.state.mode = "badInput";
    await handleEnlargeTask(e.w.deps, enlargeBody(row!));
    e.service.state.mode = "ok";
    await handleEnlargeTask(e.w.deps, enlargeBody(row!));
    const done = await rowNow(row!.id);
    e.w.objects.delete(done.uri!);
    expect(await deliverChunk(db, e.w, s.chunks[0]!.id)).toMatchObject({ httpStatus: 200 });
    expect(await rowNow(row!.id)).toMatchObject({ status: "queued", attempts: 1, sends: 1 });
    // Sent in the same pass under a fresh task name (the first one already ran).
    expect(enlargeTasks(e.w).map((t) => t.taskId)).toContain(`enlarge-${row!.id}-1`);
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBe(ENLARGING_TASK);
    await drain(e.w, { only: { db, batchId: s.batch.id } });
    expect(await rowNow(row!.id)).toMatchObject({ status: "done" });
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
  }, 120_000);

  it("T31 (F31, F53): a batch cancelled while rows are queued: the handler stops, recovery skips it; a new batch of the same products makes new rows and reuses the objects", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t31", [[2]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [made, waiting] = await rowsOf(db, s.batch.id);
    await handleEnlargeTask(e.w.deps, enlargeBody(made!));
    const { catalogBatches } = await import("@catalog/core/db/schema");
    await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, s.batch.id));
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(waiting!))).toMatchObject({ httpStatus: 200, outcome: "stopped" });
    e.clock.tick(120);
    await sweep(db, e.w);
    expect((await rowNow(waiting!.id)).sends).toBe(0);
    expect(e.service.paid()).toBe(1);
    const n = await seedSecondBatch(db, e.w, s, "t31-again");
    await runBatch(e, n);
    const rows = await rowsOf(db, n.batch.id);
    expect(rows.every((r) => r.status === "done")).toBe(true);
    expect(e.service.paid()).toBe(2);
  }, 120_000);

  it("T34 (F34): the rollback switch while parked: the delivery releases the rows and unparks; the plain path, no flag, no call; the invariant reports the outputs; the sweep does the same", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t34", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    e.w.deps.enlarge = undefined;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 200, outcome: "off" });
    expect(await rowNow(row!.id)).toMatchObject({ wanted: false, status: "queued", errorKind: "off" });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBeNull();
    await drain(e.w, { only: { db, batchId: s.batch.id } });
    const outs = await outputsOf(db, s.batch.id);
    expect(outs.every((o) => o.status === "verified" && !o.flags.includes("upscaled") && !o.flags.includes("enlargement_failed"))).toBe(true);
    expect(e.service.paid()).toBe(0);
    expect((await invariants(s.batch.id, e.clock.now())).enlarged_without_upscaler).toBe(outs.length);
    // The sweep with the switch on releases and unparks too.
    const f = enlargeWorld(db);
    const t = await seedEnlargeBatch(db, f.w, "t34-sweep", [[1]]);
    await deliverChunk(db, f.w, t.chunks[0]!.id);
    await sweep(db, f.w, { enlargementOff: true });
    expect((await rowsOf(db, t.batch.id)).map((r) => r.wanted)).toEqual([false]);
    expect((await chunkRow(db, t.chunks[0]!.id)).taskName).toBeNull();
  }, 180_000);

  it("T35 (F35): a chart image and a corrupt file get no rows; the good photo's row only", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t35", [[3]], { corrupt: [2] });
    const photos = await photosOf(db, s.batch.id);
    await db.update(catalogSourceImages).set({ flags: ["chart_image"] }).where(eq(catalogSourceImages.id, photos[2]!.id));
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    expect((await rowsOf(db, s.batch.id)).map((r) => r.sourceImageId)).toEqual([photos[0]!.id]);
  }, 60_000);

  it("T36 (F36): two rows of one product settling at once unpark the chunk once and queue one render task", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t36", [[2]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const rows = await rowsOf(db, s.batch.id);
    const results = await Promise.all(rows.map((r) => handleEnlargeTask(e.w.deps, enlargeBody(r))));
    expect(results.map((r) => r.outcome)).toEqual(["done", "done"]);
    expect(e.w.tasks.filter((t) => t.route === "/tasks/catalog/chunk" && t.body.chunkId === s.chunks[0]!.id && t.body.stage === "render")).toHaveLength(1);
    expect(e.w.log.mock.calls.filter(([m, f]) => m === "chunk enlarged" && f?.chunkId === s.chunks[0]!.id)).toHaveLength(1);
  }, 60_000);

  it("T37 (F37): rows that settle before the matte stage parks: the chunk never parks and goes on to the render", async () => {
    const e = enlargeWorld(db);
    const enqueue = e.w.deps.enqueue;
    e.w.deps.enqueue = (async (route, body, opts) => { if (route === "/tasks/catalog/enlarge") { await handleEnlargeTask(e.w.deps, body); return "inline"; } return enqueue(route, body, opts); }) as typeof enqueue;
    const s = await seedEnlargeBatch(db, e.w, "t37", [[1]]);
    expect(await deliverChunk(db, e.w, s.chunks[0]!.id)).toMatchObject({ httpStatus: 200 });
    expect((await rowsOf(db, s.batch.id))[0]).toMatchObject({ status: "done" });
    expect(await chunkRow(db, s.chunks[0]!.id)).toMatchObject({ stage: "render", taskName: expect.not.stringMatching(ENLARGING_TASK) });
    expect(e.w.deliveries().at(-1)!.outcome).not.toBe("enlarging");
  }, 60_000);

  it("T38 (F38): different bytes on a second make after a delete: publish writes a new generation, no hold", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t38", [[1]]);
    await runBatch(e, s);
    const [first] = await outputsOf(db, s.batch.id);
    expect(first).toMatchObject({ status: "verified" });
    const [row] = await rowsOf(db, s.batch.id);
    e.w.objects.delete(row!.uri!);
    e.service.state.colour = 90;
    const n = await seedSecondBatch(db, e.w, s, "t38-again");
    await runBatch(e, n);
    const [second] = await outputsOf(db, n.batch.id);
    expect(second).toMatchObject({ status: "verified" });
    expect(second!.flags).toContain("upscaled");
    expect(second!.generation).not.toBe(first!.generation);
    expect(e.service.paid()).toBe(2);
  }, 180_000);

  it("T44 (F42): an old revision's dispatch (dispatched_at IS NULL) never picks a parked chunk; after the unpark the new dispatch sends it once", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t44", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    // 8d4f940 semantics: the window sent queued chunks with no dispatched_at.
    const oldPick = await db.select().from(catalogChunks).where(and(eq(catalogChunks.batchId, s.batch.id), eq(catalogChunks.status, "queued"), isNull(catalogChunks.dispatchedAt)));
    expect(oldPick).toEqual([]);
    expect(await dispatchChunks(db, e.w.deps.enqueue, s.batch.id)).toBe(0);
    const [row] = await rowsOf(db, s.batch.id);
    await handleEnlargeTask(e.w.deps, enlargeBody(row!));
    expect(await dispatchChunks(db, e.w.deps.enqueue, s.batch.id)).toBe(0);
    expect(e.w.tasks.filter((t) => t.route === "/tasks/catalog/chunk" && t.body.chunkId === s.chunks[0]!.id && t.body.stage === "render")).toHaveLength(1);
  }, 60_000);

  it("T47 (F45): a release while the handler is mid-call: done is written with its cost row, nobody reads it", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t47", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    let release!: () => void;
    e.service.state.hold = new Promise<void>((r) => { release = r; });
    const pending = handleEnlargeTask(e.w.deps, enlargeBody(row!));
    while (!e.service.call.mock.calls.length) await new Promise((r) => setTimeout(r, 5));
    const { releaseEnlargements } = await import("@catalog/core/catalog/pipeline/enlargement");
    await releaseEnlargements(db, { batchId: s.batch.id, sourceImageIds: [row!.sourceImageId], errorKind: "removed" }, e.clock.now());
    release();
    expect(await pending).toMatchObject({ outcome: "done" });
    expect(await rowNow(row!.id)).toMatchObject({ status: "done", wanted: false });
    expect((await upscaleCosts(db, s.batch.id)).map((c) => c.outcome)).toEqual(["ok"]);
  }, 60_000);

  it("T52 (F25b): the worker and the service redeployed mid-call: the claim lapses, new deps complete the same row, one object", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t52", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    e.service.state.hold = new Promise<void>(() => {});
    void handleEnlargeTask(e.w.deps, enlargeBody(row!));
    while (!e.service.call.mock.calls.length) await new Promise((r) => setTimeout(r, 5));
    e.clock.tick(31);
    const { fakeUpscale } = await import("../../test/enlarge-world");
    const fresh = fakeUpscale(e.clock);
    const next = { ...e.w.deps, enlarge: fresh.call, enlargeProbe: fresh.probe };
    expect(await handleEnlargeTask(next, enlargeBody(row!))).toMatchObject({ outcome: "done" });
    const done = await rowNow(row!.id);
    expect(e.w.uploads.get(done.uri!)).toBe(1);
    expect(fresh.paid()).toBe(1);
  }, 60_000);

  it("T55 (F55): the queue paused 5 h then resumed: re-sent copies answer settled or in_flight; nothing fails; done", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t55", [[2]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    for (let m = 0; m < 300; m += 10) { e.clock.tick(10); await sweep(db, e.w); }
    expect((await rowsOf(db, s.batch.id)).every((r) => r.sends >= 4)).toBe(true);
    const seen = await drain(e.w, { only: { db, batchId: s.batch.id } });
    const enlarge = seen.filter((x) => x.task.route === "/tasks/catalog/enlarge").map((x) => x.result.outcome);
    expect(enlarge.filter((o) => o === "done")).toHaveLength(2);
    expect(enlarge.every((o) => ["done", "settled", "in_flight"].includes(o))).toBe(true);
    expect((await batchOf(db, s.batch.id)).status).toBe("done");
    expect(e.service.paid()).toBe(2);
  }, 180_000);

  it("T68 (F63): a render delivery skips a product whose row is queued before preparing it; the other product renders; the chunk parks", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t68", [[1, 1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    for (const r of await rowsOf(db, s.batch.id)) await handleEnlargeTask(e.w.deps, enlargeBody(r));
    const photos = await photosOf(db, s.batch.id);
    const [a, b] = [photos.find((p) => p.productId === s.chunks[0]!.productIds[0])!, photos.find((p) => p.productId === s.chunks[0]!.productIds[1])!];
    // While product A renders, a newer worker revision reconciles product B with its own identity (F4): B is queued.
    const render = e.w.deps.renderAllChannels;
    let raced = false;
    const downloads: string[] = [];
    const download = e.w.deps.storage.downloadBuffer;
    e.w.deps.storage.downloadBuffer = (async (uri: string) => { downloads.push(uri); return download(uri); }) as typeof download;
    e.w.deps.renderAllChannels = (async (...args: Parameters<typeof render>) => {
      if (!raced) {
        raced = true;
        const newer = { ...e.w.deps, exportHashes: { "swinir-x2": "cccc3333" } };
        const batch = await batchOf(db, s.batch.id), be = batchEnlargement(newer, batch)!;
        const { p, alpha } = await loadShotFromMatte(newer, b, b.matteUri!, {});
        await reconcileEnlargements(newer, { be, batch, product: { id: b.productId, productType: "footwear" }, shots: [{ source: b, p, alpha, matteModel: "fixture" }], scope: [b.id], wanted: new Set([b.id]), mode: "queue", write: (fn) => fn(db) });
        downloads.length = 0;
      }
      return render(...args);
    }) as typeof render;
    expect(await deliverChunk(db, e.w, s.chunks[0]!.id)).toMatchObject({ httpStatus: 200 });
    expect(e.w.deliveries().at(-1)).toMatchObject({ outcome: "enlarging" });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBe(ENLARGING_TASK);
    expect(downloads.filter((u) => u === b.rawUri || u === b.matteUri)).toEqual([]);
    const outs = await outputsOf(db, s.batch.id);
    expect(outs.find((o) => o.sourceImageId === a.id)!.status).not.toBe("pending");
    expect(outs.find((o) => o.sourceImageId === b.id)!.status).toBe("pending");
  }, 120_000);
});

describe("waiting is never failing", () => {
  it("T42 (F24b, F40): a one-product batch whose service takes 20 h: never swept; waiting-long shows at 20 h; the output ends upscaled", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t42", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    e.service.state.mode = "busy";
    let shown = -1;
    for (let m = 0; m <= 21 * 60; m += 30) {
      await handleEnlargeTask(e.w.deps, enlargeBody(row!));
      await sweep(db, e.w);
      expect((await batchOf(db, s.batch.id)).status).not.toBe("failed");
      if (shown < 0 && ((await invariants(s.batch.id, e.clock.now())).enlargement_waiting_long ?? 0) > 0) shown = m;
      e.clock.tick(30);
    }
    expect(shown).toBeGreaterThanOrEqual(20 * 60);
    expect(shown).toBeLessThanOrEqual(20 * 60 + 30);
    e.service.state.mode = "ok";
    await handleEnlargeTask(e.w.deps, enlargeBody(row!));
    await drain(e.w, { only: { db, batchId: s.batch.id } });
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
    expect((await batchOf(db, s.batch.id)).status).toBe("done");
  }, 300_000);
});

describe("size routes (3.2)", () => {
  it("T28 (F28): 3000x3000 at x2 (9 MP, above the 8 MP cap): two tiles, stitched to exactly 6000x6000, done", async () => {
    const e = enlargeWorld(db);
    bigPhotos(e, 3000, 3000, { w: 300, h: 300 });
    const s = await seedEnlargeBatch(db, e.w, "t28", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    expect(row).toMatchObject({ route: "tiles", factor: 2, scale: 2, outW: 6000, outH: 6000 });
    e.w.deps.enlargeTileBudgetMs = 10 ** 9;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ outcome: "done" });
    const done = await rowNow(row!.id);
    expect(done.tilesDone).toBe(2);
    const meta = await sharp(e.w.objects.get(done.uri!)!).metadata();
    expect([meta.width, meta.height]).toEqual([6000, 6000]);
  }, 120_000);

  it("T53 (F28, F50, F51): tiles resume after a crash; a tile's 400 counts on the identity; the downscale routes' exact sizes pass the validator on the first make", async () => {
    // 4000x4000 at x2: 16 MP, output 64 MP, three tiles. A crash after two tiles: the next delivery makes only the third.
    const e = enlargeWorld(db);
    bigPhotos(e, 4000, 4000, { w: 400, h: 400 });
    const s = await seedEnlargeBatch(db, e.w, "t53-tiles", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    expect(row).toMatchObject({ route: "tiles", outW: 8000, outH: 8000 });
    expect(tilesFor(4000, 4000, 8_000_000)).toHaveLength(3);
    e.w.deps.enlargeTileBudgetMs = 10 ** 9;
    const upload = e.w.deps.storage.uploadBuffer;
    let tilesUp = 0;
    e.w.deps.storage.uploadBuffer = (async (...args: Parameters<typeof upload>) => { if (args[0].includes(".tile-") && ++tilesUp === 3) throw new Error("crash"); return upload(...args); }) as typeof upload;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 503 });
    expect((await rowNow(row!.id)).tilesDone).toBe(2);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ outcome: "done" });
    expect(e.service.paid()).toBe(4);
    expect(await rowNow(row!.id)).toMatchObject({ attempts: 0, tilesDone: 3 });
    // A deterministic 400 on one tile counts on the identity: terminal at 8, the sentence names the tile.
    const f = enlargeWorld(db);
    bigPhotos(f, 4000, 4000, { w: 400, h: 400 });
    const t = await seedEnlargeBatch(db, f.w, "t53-bad-tile", [[1]]);
    await deliverChunk(db, f.w, t.chunks[0]!.id);
    const [bad] = await rowsOf(db, t.batch.id);
    const tiles = tilesFor(4000, 4000, 8_000_000);
    f.service.state.badWhen = (u) => u.h === tiles[1]!.h && u.w === tiles[1]!.w && tiles[1]!.w !== tiles[0]!.w;
    if (tiles[1]!.w === tiles[0]!.w) f.service.state.badWhen = (u) => u.w === tiles[1]!.w && u.h === tiles[1]!.h && u.h !== tiles[0]!.h;
    f.w.deps.enlargeTileBudgetMs = 10 ** 9;
    const results = await enlargeUntilSettled(f.w, bad!);
    expect(results.at(-1)).toMatchObject({ outcome: "failed" });
    expect((await rowNow(bad!.id)).error).toMatch(/tile 2 of 3/);
    expect(await rowNow(bad!.id)).toMatchObject({ attempts: 8, status: "failed" });
  }, 300_000);

  it("T53 (F51): 5000x4000 at x2 with a need of 1.5: downscale_tiles, scale 1.788, shrunk 4470x3576, out 8940x7152, valid on the first make", async () => {
    const e = enlargeWorld(db);
    bigPhotos(e, 5000, 4000, boxForNeed(5000, 4000, 1.5, false));
    const s = await seedEnlargeBatch(db, e.w, "t53-down-tiles", [[1]]);
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = await rowsOf(db, s.batch.id);
    expect(row).toMatchObject({ route: "downscale_tiles", factor: 2, outW: 8940, outH: 7152 });
    expect(row!.scale).toBeCloseTo(1.788, 3);
    e.w.deps.enlargeTileBudgetMs = 10 ** 9;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ outcome: "done" });
    expect(await rowNow(row!.id)).toMatchObject({ attempts: 0 });
    const calls = e.service.state.calls;
    expect(Math.max(...calls.map((c) => c.w))).toBeLessThanOrEqual(4470);
  }, 300_000);

  it("T53 (F51): 2400x2400 at x4 with a need of 2.5: downscale, scale 3.333, shrunk 1999x1999, out 7996x7996, direct, sx 3.3317", async () => {
    const e = enlargeWorld(db);
    bigPhotos(e, 2400, 2400, boxForNeed(2400, 2400, 2.5, true));
    const s = await seedEnlargeBatch(db, e.w, "t53-down", [[1]], { route: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 } });
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const [row] = (await rowsOf(db, s.batch.id)).filter((r) => r.factor === 4);
    expect(row).toMatchObject({ route: "downscale", outW: 7996, outH: 7996 });
    expect(row!.scale).toBeCloseTo(3.333, 3);
    expect(row!.outW / 2400).toBeCloseTo(3.3317, 4);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ outcome: "done" });
    expect(e.service.state.calls.map((c) => [c.w, c.h])).toEqual([[1999, 1999]]);
  }, 300_000);

  it("T54 (F28, F52): needs no route can make are held with the size sentence before any call", async () => {
    // 2400x2400 at x4 with a need of 3.5: 3.333 < 3.675.
    const e = enlargeWorld(db);
    bigPhotos(e, 2400, 2400, boxForNeed(2400, 2400, 3.5, true));
    const s = await seedEnlargeBatch(db, e.w, "t54-x4", [[1]], { route: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 } });
    await deliverChunk(db, e.w, s.chunks[0]!.id);
    const row = (await rowsOf(db, s.batch.id)).find((r) => r.factor === 4)!;
    expect(row).toMatchObject({ route: "none", status: "failed", errorKind: "no_route" });
    expect(row.error).toMatch(/^This photo is too large to enlarge as much as trendyol needs\.$/);
    expect(row.error).not.toMatch(/swinir/);
    // 6000x6000 at x2: a need of 1.2 (1.26 with slack) is served by downscale_tiles; 1.4 (1.47) holds.
    const served = enlargementRouteFor(6000, 6000, 2, 1.2 * 1.05);
    expect(served).toMatchObject({ route: "downscale_tiles", shrunkW: 3999, outW: 7998 });
    expect(served.scale).toBeCloseTo(1.333, 3);
    expect(enlargementRouteFor(6000, 6000, 2, 1.4 * 1.05).route).toBe("none");
    // 10000x10000 at any factor: 0.8, always held.
    expect(enlargementRouteFor(10000, 10000, 2, 1.05)).toMatchObject({ route: "none", scale: 0.8 });
    expect(enlargementRouteFor(10000, 10000, 4, 1.05)).toMatchObject({ route: "none", scale: 0.8 });
    // Through the stage: 6000x6000 with a need of 1.4 is born failed, no call.
    const f = enlargeWorld(db);
    bigPhotos(f, 6000, 6000, boxForNeed(6000, 6000, 1.4, false));
    const t = await seedEnlargeBatch(db, f.w, "t54-x2", [[1]]);
    await deliverChunk(db, f.w, t.chunks[0]!.id);
    expect((await rowsOf(db, t.batch.id)).map((r) => [r.route, r.status])).toEqual([["none", "failed"]]);
    expect(e.service.paid() + f.service.paid()).toBe(0);
    expect((await chunkRow(db, t.chunks[0]!.id)).taskName).toBeNull();
  }, 300_000);

  it("T69: the downscale mapping keeps colour on the alpha within 0.5 output px (5000x4000 at sx 1.788, 2400 at sx 3.3317)", async () => {
    for (const { width, outW } of [{ width: 5000, outW: 8940 }, { width: 2400, outW: 7996 }]) {
      const height = 4, outH = 12;
      // A sharp vertical edge at x = edge in the photo; the "model" reproduces it exactly at edge x sx.
      const edge = Math.floor(width * 0.43) + 0.5;
      const sx = outW / width;
      const enlarged = Buffer.alloc(outW * outH * 3);
      for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) enlarged.fill(x + 0.5 < edge * sx ? 0 : 255, (y * outW + x) * 3, (y * outW + x) * 3 + 3);
      const jpeg = await sharp(enlarged, { raw: { width: outW, height: outH, channels: 3 } }).png().toBuffer();
      const up = storedUpscaler("swinir-x2", 1), rgb = Buffer.alloc(width * height * 3, 7);
      primeSourceX2(up, rgb, width, jpeg, { w: outW, h: outH });
      const crop = { x: Math.floor(width * 0.3) + 0.37, y: 0, w: width * 0.25, h: height };
      const target = { w: 997, h: 9 };
      const out = (await upscaledRgb(up, rgb, width, crop, target))!.rgb;
      // Where the edge must land in the output (the alpha's mapping) and where the colour's 50% crossing is.
      const want = ((edge - crop.x) / crop.w) * target.w;
      const row = 4;
      let cross = -1;
      for (let x = 1; x < target.w; x++) { const a = out[(row * target.w + x - 1) * 3]!, b = out[(row * target.w + x) * 3]!; if (a < 128 && b >= 128) { cross = x - 1 + (128 - a) / (b - a) + 0.5; break; } }
      expect(cross).toBeGreaterThan(0);
      expect(Math.abs(cross - want)).toBeLessThanOrEqual(0.5);
      expect(enlargedBox(crop, sx, outH / height, outW, outH).left).toBeLessThanOrEqual(crop.x * sx);
    }
  }, 60_000);
});

const ENLARGE_ATTEMPTS = 8;
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
