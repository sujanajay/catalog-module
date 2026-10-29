// Tier 2 (PGlite + fakes): the spec 18 enlargement lifecycle (docs/plans/2026-10-29-spec-18-enlargement-lifecycle.md
// section 6), the handler and its service behaviour. Every test drives the real entry points (handleChunkTask,
// handleEnlargeTask, handleSweep, recoverBatchChunks); the upscale service, its probe, GCS, Cloud Tasks and the judge are
// fakes (test/enlarge-world.ts). No test writes catalog_enlargements directly. Test names start with their plan id.
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogEnlargements } from "@catalog/core/db/schema";
import { ENLARGE_MAX_TIMEOUTS, ENLARGE_SEND_WARN, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, IDENTITY_UNSTABLE_SENTENCE, tilesFor } from "@catalog/core/catalog/pipeline/enlargement";
import { resendStaleEnlargements } from "@catalog/core/catalog/pipeline/dispatch";
import { retryEnlargement } from "@catalog/core/catalog/decisions";
import { enlargeTaskId } from "@catalog/core/tasks";
import { chunkRow } from "../../test/catalog-fakes";
import {
  batchOf, chunksOf, corruptObject, deliverChunk, enlargeBody, enlargeTasks, enlargeUntilSettled, enlargeWorld, outputsOf, photosOf, rowsOf, seedEnlargeBatch, sweep, upscaleCosts, type EnlargeWorld,
} from "../../test/enlarge-world";
import { handleEnlargeTask, upscaleProbeTimeoutMs, workerEnlargeProbe } from "./enlarge";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });
/** Runs `fn` with env overrides, restored after. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

/** A batch (pinned x2 at 1.0) after its matte stage: one wanted queued row per photo, the chunk parked. */
async function parked(name: string, options: { layout?: number[][]; world?: EnlargeWorld; channels?: ("trendyol" | "noon")[] } = {}) {
  const e = options.world ?? enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, options.layout ?? [[1]], { channels: options.channels ?? ["trendyol"] });
  for (const c of s.chunks) expect(await deliverChunk(db, e.w, c.id)).toMatchObject({ httpStatus: 200 });
  const rows = await rowsOf(db, s.batch.id);
  return { ...e, s, rows };
}
const rowNow = async (id: string) => (await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, id)))[0]!;
const errorLines = (e: EnlargeWorld, message: string) => e.w.log.mock.calls.filter(([m, f]) => m === message && f?.severity === "ERROR");

describe("the matte stage queues, the handler makes, the settle unparks", () => {
  it("one wanted queued row per photo, its task (enlarge-<id>-0), the chunk parked with dispatched_at set", async () => {
    const e = await parked("park", { layout: [[2]] });
    expect(e.rows.map((r) => [r.status, r.wanted, r.route, r.factor, r.sends])).toEqual([["queued", true, "direct", 2, 0], ["queued", true, "direct", 2, 0]]);
    expect(enlargeTasks(e.w).map((t) => t.taskId).sort()).toEqual(e.rows.map((r) => enlargeTaskId(r.id, 0)).sort());
    const chunk = await chunkRow(db, e.s.chunks[0]!.id);
    expect(chunk).toMatchObject({ stage: "render", status: "queued", taskName: ENLARGING_TASK });
    expect(chunk.dispatchedAt).not.toBeNull();
    expect(e.w.deliveries().at(-1)).toMatchObject({ outcome: "enlarging" });
  }, 60_000);
});

describe("handler: claims, duplicates and crashes", () => {
  it("T15 (F15): two concurrent deliveries make one call; the loser answers in_flight; attempts stay 0; the gate settles once", async () => {
    const e = await parked("t15");
    const row = e.rows[0]!;
    let release!: () => void;
    e.service.state.hold = new Promise<void>((r) => { release = r; });
    const first = handleEnlargeTask(e.w.deps, enlargeBody(row));
    while (!e.service.call.mock.calls.length) await new Promise((r) => setTimeout(r, 5));
    const second = await handleEnlargeTask(e.w.deps, enlargeBody(row));
    expect(second).toMatchObject({ httpStatus: 503, outcome: "in_flight" });
    release();
    expect(await first).toMatchObject({ httpStatus: 200, outcome: "done" });
    expect(e.service.paid()).toBe(1);
    expect((await upscaleCosts(db, e.s.batch.id)).length).toBe(1);
    expect(await rowNow(row.id)).toMatchObject({ status: "done", attempts: 0, timeouts: 0 });
    expect(e.w.tasks.filter((t) => t.route === "/tasks/catalog/chunk" && t.body.stage === "render")).toHaveLength(1);
  }, 60_000);

  it("T16 (F16): a task delivered after the row settled answers settled, no write, no call, no cost row", async () => {
    const e = await parked("t16");
    const row = e.rows[0]!;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    const before = await rowNow(row.id);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 200, outcome: "settled" });
    expect(await rowNow(row.id)).toEqual(before);
    expect(e.service.paid()).toBe(1);
    expect((await upscaleCosts(db, e.s.batch.id)).length).toBe(1);
  }, 60_000);

  it("T19 (F19): a crash after the claim: in_flight until the claim lapses (30 min), then the call; attempts 0 throughout", async () => {
    const e = await parked("t19");
    const row = e.rows[0]!;
    e.service.state.hold = new Promise<void>(() => {});
    void handleEnlargeTask(e.w.deps, enlargeBody(row));
    while (!e.service.call.mock.calls.length) await new Promise((r) => setTimeout(r, 5));
    const outcomes: string[] = [];
    for (let m = 5; m <= 35; m += 5) { e.clock.tick(5); outcomes.push((await handleEnlargeTask(e.w.deps, enlargeBody(row))).outcome); expect((await rowNow(row.id)).attempts).toBe(0); }
    expect(outcomes.slice(0, 5).every((o) => o === "in_flight")).toBe(true);
    expect(outcomes.at(-1)).toBe("done");
    expect(e.service.call).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("T20 (F20): a crash after the upload: the next delivery finds the object, no call, done, one cost row", async () => {
    const e = await parked("t20");
    const row = e.rows[0]!;
    const upload = e.w.deps.storage.uploadBuffer;
    let crashed = false;
    e.w.deps.storage.uploadBuffer = (async (...args: Parameters<typeof upload>) => { const uri = await upload(...args); if (!crashed && args[0].includes("/derived/") && args[0].endsWith(".jpg")) { crashed = true; throw new Error("crash after upload"); } return uri; }) as typeof upload;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 503 });
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 200, outcome: "done" });
    expect(e.service.paid()).toBe(1);
    expect((await upscaleCosts(db, e.s.batch.id)).length).toBe(1);
  }, 60_000);
});

describe("handler: outages delay, failures count", () => {
  it("T18 (F18): 40 busy answers then success: attempts 0, delays 40, done; never terminal", async () => {
    const e = await parked("t18");
    const row = e.rows[0]!;
    e.service.state.mode = "busy"; e.service.state.probe = "ok";
    for (let i = 0; i < 40; i++) { expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 503, outcome: "busy" }); e.clock.tick(1); }
    expect(await rowNow(row.id)).toMatchObject({ status: "queued", attempts: 0, timeouts: 0, delays: 40 });
    e.service.state.mode = "ok"; e.service.state.probe = null;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
  }, 60_000);

  it("T24 (F24, F49): a service that is healthy but never answers: one timeout per delivery, terminal at 24 with the sentence; the batch is never swept", async () => {
    const e = await parked("t24");
    const row = e.rows[0]!;
    e.service.state.mode = "healthyButHangs";
    const outcomes: string[] = [];
    for (let i = 0; i < ENLARGE_MAX_TIMEOUTS; i++) { outcomes.push((await handleEnlargeTask(e.w.deps, enlargeBody(row))).outcome); e.clock.tick(10); await sweep(db, e.w); expect((await batchOf(db, e.s.batch.id)).status).not.toBe("failed"); }
    expect(outcomes.slice(0, -1).every((o) => o === "retry")).toBe(true);
    expect(outcomes.at(-1)).toBe("failed");
    const settled = await rowNow(row.id);
    expect(settled).toMatchObject({ status: "failed", attempts: 0, timeouts: ENLARGE_MAX_TIMEOUTS });
    expect(settled.error).toMatch(/^The enlargement did not finish 24 times\./);
    expect(e.service.paid()).toBe(ENLARGE_MAX_TIMEOUTS);
    expect(errorLines(e, "enlargement failed")).toHaveLength(1);
    // The chunk was unparked by the terminal settle; the render holds the photo with the flag.
    expect(e.w.tasks.some((t) => t.route === "/tasks/catalog/chunk" && t.body.stage === "render")).toBe(true);
    expect((await handleEnlargeTask(e.w.deps, enlargeBody(row))).outcome).toBe("settled");
    expect(await deliverChunk(db, e.w, e.s.chunks[0]!.id)).toMatchObject({ httpStatus: 200 });
    expect((await outputsOf(db, e.s.batch.id)).map((o) => [o.status, o.flags.includes("enlargement_failed")])).toEqual([["needs_attention", true]]);
  }, 120_000);

  it("T25 (F25, F54): down 6 h, then paused 24 h, then up: attempts 0, delays only, no hold, never swept, done", async () => {
    const e = await parked("t25");
    const row = e.rows[0]!;
    e.service.state.mode = "down";
    for (let m = 0; m < 6 * 60; m += 10) { expect((await handleEnlargeTask(e.w.deps, enlargeBody(row))).httpStatus).toBe(503); e.clock.tick(10); await sweep(db, e.w); }
    e.service.state.mode = "paused";
    for (let m = 0; m < 24 * 60; m += 30) { expect((await handleEnlargeTask(e.w.deps, enlargeBody(row))).httpStatus).toBe(503); e.clock.tick(30); await sweep(db, e.w); }
    const waiting = await rowNow(row.id);
    expect(waiting).toMatchObject({ status: "queued", attempts: 0, timeouts: 0 });
    expect(waiting.delays).toBeGreaterThan(0);
    expect((await batchOf(db, e.s.batch.id)).status).not.toBe("failed");
    e.service.state.mode = "ok";
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    expect(e.service.paid()).toBe(1);
  }, 180_000);

  it("T26 (F26): 429 / no instance for 3 h: delays only, done after", async () => {
    const e = await parked("t26");
    const row = e.rows[0]!;
    e.service.state.mode = "busy";
    for (let m = 0; m < 180; m += 10) { expect((await handleEnlargeTask(e.w.deps, enlargeBody(row))).httpStatus).toBe(503); e.clock.tick(10); await sweep(db, e.w); }
    expect(await rowNow(row.id)).toMatchObject({ status: "queued", attempts: 0, timeouts: 0 });
    expect((await batchOf(db, e.s.batch.id)).status).not.toBe("failed");
    e.service.state.mode = "ok";
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
  }, 120_000);

  it("T29 (F29): a reply of the wrong size counts an attempt; terminal at 8 with an ERROR line", async () => {
    const e = await parked("t29");
    const row = e.rows[0]!;
    e.service.state.mode = "wrongSize";
    const results = await enlargeUntilSettled(e.w, row);
    expect(results).toHaveLength(ENLARGE_TASK_MAX_ATTEMPTS);
    expect(results.at(-1)).toMatchObject({ httpStatus: 200, outcome: "failed" });
    expect(await rowNow(row.id)).toMatchObject({ status: "failed", attempts: ENLARGE_TASK_MAX_ATTEMPTS, errorKind: "invalid_reply" });
    expect(errorLines(e, "enlargement failed")).toHaveLength(1);
    expect(e.w.objects.has((await rowNow(row.id)).uri ?? "none")).toBe(false);
  }, 60_000);

  it("T61 (F56): a poison input with the service up (re-probe 200, 429, timeout): one timeout per delivery, terminal at 24, exactly 24 paid calls; the other photos done", async () => {
    for (const reprobe of ["ok", "saturated", "timeout"] as const) {
      const e = await parked(`t61-${reprobe}`, { layout: [[1], [1]] });
      const [poison, good] = e.rows;
      e.service.state.poison.add(poison!.productId);
      if (reprobe === "saturated") e.service.state.mode = "saturated";
      if (reprobe === "timeout") e.service.state.probe = "timeout";
      for (let i = 0; i < 40 && (await rowNow(poison!.id)).status === "queued"; i++) await handleEnlargeTask(e.w.deps, enlargeBody(poison!));
      const settled = await rowNow(poison!.id);
      expect(settled).toMatchObject({ status: "failed", attempts: 0, timeouts: ENLARGE_MAX_TIMEOUTS });
      expect(e.service.paid(poison!.productId)).toBe(ENLARGE_MAX_TIMEOUTS);
      e.service.state.probe = null; e.service.state.mode = "ok";
      expect((await enlargeUntilSettled(e.w, good!)).at(-1)).toMatchObject({ outcome: "done" });
    }
  }, 180_000);

  it("T61 (F56 d): while the re-probe proves the service absent, a poison input only delays; once it answers, the next failure counts", async () => {
    const e = await parked("t61-absent");
    const row = e.rows[0]!;
    e.service.state.poison.add(row.productId);
    e.service.state.probe = "absent";
    for (let i = 0; i < 10; i++) expect((await handleEnlargeTask(e.w.deps, enlargeBody(row))).httpStatus).toBe(503);
    const waiting = await rowNow(row.id);
    expect(waiting).toMatchObject({ status: "queued", timeouts: 0, attempts: 0 });
    expect(waiting.delays).toBe(10);
    e.service.state.probe = null;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 503, outcome: "retry" });
    expect((await rowNow(row.id)).timeouts).toBe(1);
  }, 60_000);

  it("T62 (F57): a cold start fits the probe timeout; three probe timeouts make the call without one; a forced call's failure counts", async () => {
    // The probe waits the measured cold start plus 60 s.
    expect(upscaleProbeTimeoutMs({ UPSCALE_COLD_START_S: "20" })).toBe(80_000);
    expect(upscaleProbeTimeoutMs({})).toBe(180_000);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { await new Promise((r) => setTimeout(r, 30)); expect(init?.signal?.aborted).toBe(false); return Response.json({ upscale: { models: [{ id: "swinir-x2", available: true }] } }); });
    expect(await workerEnlargeProbe({ UPSCALE_URL: "https://upscale.test", UPSCALE_COLD_START_S: "20" }, { fetch, idToken: async () => "" })("swinir-x2")).toBe("ok");
    // Cold start: one delivery, the probe passes, done.
    const cold = await parked("t62-cold");
    cold.service.state.mode = "coldStart";
    expect(await handleEnlargeTask(cold.w.deps, enlargeBody(cold.rows[0]!))).toMatchObject({ outcome: "done" });
    // Probe always times out, calls succeed.
    const slow = await parked("t62-probe");
    const row = slow.rows[0]!;
    slow.service.state.mode = "probeTimesOut";
    for (const n of [1, 2, 3]) { expect(await handleEnlargeTask(slow.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 503, outcome: "probe_timeout" }); expect((await rowNow(row.id)).probeTimeouts).toBe(n); }
    expect(slow.service.paid()).toBe(0);
    expect(await handleEnlargeTask(slow.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    expect(await rowNow(row.id)).toMatchObject({ status: "done", probeTimeouts: 0 });
    // Probe always times out, calls fail: each forced call's failure counts (a probe timeout proves nothing).
    const dead = await parked("t62-dead");
    const bad = dead.rows[0]!;
    dead.service.state.probe = "timeout"; dead.service.state.mode = "healthyButHangs";
    for (let i = 0; i < 40 && (await rowNow(bad.id)).status === "queued"; i++) await handleEnlargeTask(dead.w.deps, enlargeBody(bad));
    expect(await rowNow(bad.id)).toMatchObject({ status: "failed", timeouts: ENLARGE_MAX_TIMEOUTS });
    expect(dead.service.paid()).toBe(ENLARGE_MAX_TIMEOUTS);
  }, 120_000);

  it("T63 (F58): a reply 1 px short is refused before the upload; a service that always answers short is terminal at 8 and the render never primes it", async () => {
    const e = await parked("t63-short");
    const row = e.rows[0]!;
    e.service.state.shortBy = 1;
    const results = await enlargeUntilSettled(e.w, row);
    expect(results.at(-1)).toMatchObject({ outcome: "failed" });
    expect(await rowNow(row.id)).toMatchObject({ status: "failed", attempts: ENLARGE_TASK_MAX_ATTEMPTS, errorKind: "invalid_reply", uri: null });
    const { handleChunkTask, currentChunkTask } = await import("./chunk");
    expect(await handleChunkTask(e.w.deps, await currentChunkTask(db, e.s.chunks[0]!.id))).toMatchObject({ httpStatus: 200 });
    const [out] = await outputsOf(db, e.s.batch.id);
    expect(out!.flags).toContain("enlargement_failed");
    expect(out!.flags).not.toContain("upscaled");
  }, 60_000);

  it("T63 (F58): a stored object 1 px short or undecodable is refused by the render and by the handler, counted, made again, done", async () => {
    const e = await parked("t63-stored", { layout: [[2]] });
    for (const row of e.rows) expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    const [a, b] = await rowsOf(db, e.s.batch.id);
    await corruptObject(e.w, a!.uri!);
    e.w.objects.set(b!.uri!, Buffer.from("not a jpeg"));
    const { handleChunkTask, currentChunkTask } = await import("./chunk");
    // The render refuses both (primeReadiness): attempts+1, back to queued, sent again, the chunk parks.
    expect(await handleChunkTask(e.w.deps, await currentChunkTask(db, e.s.chunks[0]!.id))).toMatchObject({ httpStatus: 200 });
    expect((await rowsOf(db, e.s.batch.id)).map((r) => [r.status, r.attempts, r.errorKind])).toEqual([["queued", 1, "invalid_object"], ["queued", 1, "invalid_object"]]);
    expect(await chunkRow(db, e.s.chunks[0]!.id)).toMatchObject({ taskName: ENLARGING_TASK });
    // The handler finds the refused object at its key and makes it again.
    for (const row of [a!, b!]) expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    expect(e.service.paid()).toBe(4);
    expect(await handleChunkTask(e.w.deps, await currentChunkTask(db, e.s.chunks[0]!.id))).toMatchObject({ httpStatus: 200 });
    expect((await outputsOf(db, e.s.batch.id)).every((o) => o.flags.includes("upscaled"))).toBe(true);
  }, 120_000);

  it("T66 (F61): the convert step down for 2 h only delays; a deleted raw file counts bad_source and is terminal at 8", async () => {
    const e = await parked("t66", { layout: [[1], [1]] });
    const [up, gone] = e.rows;
    const prepare = e.w.deps.prepare;
    let outage = true;
    e.w.deps.prepare = (async (buf, name, convert) => { await convert(buf); return prepare(buf, name, convert); }) as typeof prepare;
    e.w.deps.matting.convert = (async (b: Buffer) => { if (outage) throw new Error("convert 503"); return b; }) as typeof e.w.deps.matting.convert;
    for (let m = 0; m < 120; m += 10) { expect(await handleEnlargeTask(e.w.deps, enlargeBody(up!))).toMatchObject({ httpStatus: 503, outcome: "unavailable" }); e.clock.tick(10); }
    expect(await rowNow(up!.id)).toMatchObject({ status: "queued", attempts: 0 });
    outage = false;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(up!))).toMatchObject({ outcome: "done" });
    const photo = (await photosOf(db, e.s.batch.id)).find((p) => p.id === gone!.sourceImageId)!;
    e.w.objects.delete(photo.rawUri);
    const results = await enlargeUntilSettled(e.w, gone!);
    expect(results.at(-1)).toMatchObject({ outcome: "failed" });
    expect(await rowNow(gone!.id)).toMatchObject({ status: "failed", attempts: ENLARGE_TASK_MAX_ATTEMPTS, errorKind: "bad_source" });
  }, 60_000);
});

describe("handler: routes", () => {
  it("T6 (F6): the per-call cap lowered below the photo between the send and the delivery: the tile route, done, no hold", async () => {
    const e = await parked("t6");
    const row = e.rows[0]!;
    expect(row.route).toBe("direct");
    await withEnv({ UPSCALE_MAX_PIXELS: "80000" }, async () => {
      e.w.deps.enlargeTileBudgetMs = 10 ** 9;
      expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ httpStatus: 200, outcome: "done" });
    });
    const done = await rowNow(row.id);
    const tiles = tilesFor(done.outW / 2, done.outH / 2, 80_000).length;
    expect(tiles).toBeGreaterThan(1);
    expect(done.tilesDone).toBe(tiles);
    expect(e.service.paid()).toBe(tiles);
    const meta = await sharp(e.w.objects.get(done.uri!)!).metadata();
    expect([meta.width, meta.height]).toEqual([done.outW, done.outH]);
    const { handleChunkTask, currentChunkTask } = await import("./chunk");
    expect(await handleChunkTask(e.w.deps, await currentChunkTask(db, e.s.chunks[0]!.id))).toMatchObject({ httpStatus: 200 });
    expect((await outputsOf(db, e.s.batch.id))[0]!.flags).toContain("upscaled");
  }, 60_000);

  it("T67 (F62): with no tile budget each delivery makes one tile and answers more_tiles; done after one delivery per tile", async () => {
    await withEnv({ UPSCALE_MAX_PIXELS: "80000" }, async () => {
      const e = await parked("t67");
      const row = e.rows[0]!;
      expect(row.route).toBe("tiles");
      e.w.deps.enlargeTileBudgetMs = 0;
      const outcomes = (await enlargeUntilSettled(e.w, row)).map((r) => r.outcome);
      const tiles = tilesFor(row.outW / 2, row.outH / 2, 80_000).length;
      expect(outcomes).toEqual([...Array(tiles - 1).fill("more_tiles"), "done"]);
      expect(e.service.paid()).toBe(tiles);
      expect(await rowNow(row.id)).toMatchObject({ status: "done", attempts: 0, tilesDone: tiles });
    });
  }, 60_000);
});

describe("handler: identity", () => {
  it("T64 (F59): a prepare that alternates two colour handlings: three releases summed over two rows, then failed with the sentence; Try again resets; a stable prepare completes", async () => {
    const e = enlargeWorld(db);
    const prepare = e.w.deps.prepare;
    let calls = 0, stable = false;
    e.w.deps.prepare = (async (...args: Parameters<typeof prepare>) => { const p = await prepare(...args); if (!stable && calls++ % 2 === 1) p.rgb = Buffer.alloc(p.rgb.length, 140); return p; }) as typeof prepare;
    const s = await seedEnlargeBatch(db, e.w, "t64", [[1]]);
    const { handleChunkTask, currentChunkTask } = await import("./chunk");
    const chunkId = s.chunks[0]!.id;
    expect(await handleChunkTask(e.w.deps, await currentChunkTask(db, chunkId))).toMatchObject({ httpStatus: 200 });
    let failed = false;
    for (let round = 0; round < 12 && !failed; round++) {
      for (const row of (await rowsOf(db, s.batch.id)).filter((r) => r.wanted && r.status === "queued")) await handleEnlargeTask(e.w.deps, enlargeBody(row));
      const rows = await rowsOf(db, s.batch.id);
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(rows.reduce((n, r) => n + r.identityReleases, 0)).toBeLessThanOrEqual(3);
      failed = rows.some((r) => r.status === "failed");
      if (!failed) await handleChunkTask(e.w.deps, await currentChunkTask(db, chunkId));
    }
    const rows = await rowsOf(db, s.batch.id);
    expect(rows.reduce((n, r) => n + r.identityReleases, 0)).toBe(3);
    expect(rows.find((r) => r.status === "failed")).toMatchObject({ error: IDENTITY_UNSTABLE_SENTENCE, errorKind: "identity_unstable" });
    expect(e.service.paid()).toBe(0);
    // The render holds the photo.
    await handleChunkTask(e.w.deps, await currentChunkTask(db, chunkId));
    const [held] = await outputsOf(db, s.batch.id);
    expect(held!.flags).toContain("enlargement_failed");
    // Try again resets the sum; a stable prepare then completes.
    stable = true;
    const retry = await retryEnlargement(db, e.w.deps.enqueue, { outputId: held!.id, actor: "op@opptra.com", now: e.clock.now() });
    expect((await rowsOf(db, s.batch.id)).reduce((n, r) => n + r.identityReleases, 0)).toBe(0);
    for (const row of (await rowsOf(db, s.batch.id)).filter((r) => r.wanted && r.status === "queued")) expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    expect(await handleChunkTask(e.w.deps, await currentChunkTask(db, retry.chunkId))).toMatchObject({ httpStatus: 200 });
    expect((await outputsOf(db, s.batch.id))[0]!.flags).toContain("upscaled");
  }, 120_000);
});

describe("sweep and re-send", () => {
  it("T17 (F17): parked chunks are not re-sent while any enlarge delivery of the batch continues; after a quiet hour they are; the old task then answers settled", async () => {
    const e = await parked("t17", { layout: [[1], [1], [1]] });
    const [busy, b, c] = e.rows;
    expect((await chunksOf(db, e.s.batch.id)).every((ch) => ch.taskName === ENLARGING_TASK)).toBe(true);
    e.service.state.mode = "busy";
    for (let m = 0; m < 70; m += 10) { await handleEnlargeTask(e.w.deps, enlargeBody(busy!)); e.clock.tick(10); await sweep(db, e.w); }
    expect((await rowsOf(db, e.s.batch.id)).map((r) => r.sends)).toEqual([0, 0, 0]);
    e.clock.tick(61);
    await sweep(db, e.w);
    expect((await rowsOf(db, e.s.batch.id)).map((r) => r.sends)).toEqual([1, 1, 1]);
    expect(enlargeTasks(e.w).map((t) => t.taskId)).toEqual(expect.arrayContaining([b, c].map((r) => enlargeTaskId(r!.id, 1))));
    e.service.state.mode = "ok";
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(b!))).toMatchObject({ outcome: "done" });
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(b!))).toMatchObject({ outcome: "settled" });
    expect((await batchOf(db, e.s.batch.id)).status).not.toBe("failed");
  }, 120_000);

  it("T27 (F27): tasks dropped before the handler for 25 re-send rounds: sends 25, ERROR from the 21st, the row still queued, then a delivery completes it", async () => {
    const e = await parked("t27");
    const row = e.rows[0]!;
    const log = vi.fn();
    for (let round = 1; round <= 25; round++) {
      e.clock.tick(round > ENLARGE_SEND_WARN ? 6 * 60 + 1 : 61);
      await resendStaleEnlargements(db, e.w.deps.enqueue, e.s.batch.id, { now: e.clock.now(), log });
      expect((await rowNow(row.id)).sends).toBe(round);
    }
    const errors = log.mock.calls.filter(([m, f]) => m === "enlargement task cannot be delivered" && f?.severity === "ERROR");
    expect(errors.map(([, f]) => f.sends)).toEqual([21, 22, 23, 24, 25]);
    expect(await rowNow(row.id)).toMatchObject({ status: "queued", wanted: true });
    expect((await batchOf(db, e.s.batch.id)).status).not.toBe("failed");
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
  }, 60_000);
});
