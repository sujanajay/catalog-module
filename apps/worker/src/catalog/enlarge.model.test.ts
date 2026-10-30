// Tier 2 (PGlite + fakes): T40, the spec 18 enlargement lifecycle state machine, and T39, the end-to-end queue test
// (plan section 6). A seeded PRNG draws event sequences over a 3-product batch; every event goes through the real
// entry points (handleChunkTask, handleEnlargeTask, handlePublishTask, handleFinalizeTask, handleSweep, applyDecision,
// retryEnlargement, completeReplacement) and the invariants are checked after each one. The seed is printed on failure.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogChunks, catalogCostEvents, catalogEnlargements, catalogOutputs } from "@catalog/core/db/schema";
import { applyDecision, CatalogDecisionError, CatalogPlainWarning, retryEnlargement } from "@catalog/core/catalog/decisions";
import { tryEnqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import {
  ENLARGE_CLAIM_MS, ENLARGE_MAX_IDENTITY_CHANGES, ENLARGE_MAX_TIMEOUTS, ENLARGE_PROBE_TIMEOUTS_MAX, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, validateEnlargedObject,
} from "@catalog/core/catalog/pipeline/enlargement";
import { DIMENSION_FLAGS } from "@catalog/core/catalog/qa/judge";
import type { QueuedTask } from "../../test/catalog-fakes";
import type { HandleResult } from "../server";
import { clearMadeImages } from "./enlarge";
import {
  batchOf, batchOfTask, chunksOf, corruptObject, deliver, enlargeBody, enlargeWorld, outputsOf, replacePhoto, rowsOf, seedEnlargeBatch, startChunks, sweep, type EnlargeWorld, type ServiceMode,
} from "../../test/enlarge-world";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { handleEnlargeTask } from "./enlarge";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

/** 200 sequences of 60 events (the plan); ENLARGE_MODEL_SEQUENCES and ENLARGE_MODEL_SEED narrow a rerun. */
const SEQUENCES = Number(process.env.ENLARGE_MODEL_SEQUENCES ?? 200);
const EVENTS = 60;
const FIRST_SEED = Number(process.env.ENLARGE_MODEL_SEED ?? 0x5eed18);
/**
 * Cloud Tasks retry (infra/lib/queues.sh): a 5xx answer puts the task back with its next schedule time, the back-off
 * doubling from the floor to the ceiling (enlarge 30 s to 900 s, chunk queue 10 s to 60 s). Every queue retries
 * without limit (the enlarge lanes --max-attempts=-1, lifecycle 3.8), so only loseTask drops a task.
 */
const ENLARGE_BACKOFF_MIN = 0.5, ENLARGE_BACKOFF_MAX = 15, CHUNK_BACKOFF_MIN = 10 / 60, CHUNK_BACKOFF_MAX = 1;
const backoffMin = (route: string, retry: number) => route === "/tasks/catalog/enlarge"
  ? Math.min(ENLARGE_BACKOFF_MIN * 2 ** (retry - 1), ENLARGE_BACKOFF_MAX) : Math.min(CHUNK_BACKOFF_MIN * 2 ** (retry - 1), CHUNK_BACKOFF_MAX);
const IN_FLIGHT_BOUND = ENLARGE_CLAIM_MS / (ENLARGE_BACKOFF_MIN * 60_000);
const actor = "model@opptra.com";
const LOSABLE = new Set<string>(["/tasks/catalog/enlarge", "/tasks/catalog/chunk"]);

/** An `Math.imul` LCG (no new dependency): a fraction in [0, 1). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

type Seeded = Awaited<ReturnType<typeof seedEnlargeBatch>>;
/**
 * `callKill` (final check 2026-10-30): the next service call reaches the service and the delivery's request is killed
 * in the middle of it (Cloud Run's request timeout, the worker's instance gone): the handler never continues.
 * `uploadFail`: every upload of the next made image is refused (403) within its delivery.
 */
interface Arm { renderHang: boolean; callHang: boolean; callKill: boolean; uploadFail: boolean; complianceFail: boolean; productRemoved: boolean; jitter: boolean; enqueueFail: boolean; onHang?: (() => void) | undefined }
interface Model {
  e: EnlargeWorld; s: Seeded; rnd: () => number; off: boolean; arm: Arm;
  /** Rows whose stored object an event broke on purpose (excluded from check d until the row is made again). */
  broken: Set<string>;
  inFlight: Map<string, number>;
  trail: string[];
}

/** One-shot faults the next render, judge, prepare, service call or enqueue picks up. */
function armWorld(e: EnlargeWorld, arm: Arm) {
  const render = e.w.deps.renderAllChannels;
  e.w.deps.renderAllChannels = (async (p, m, channels, ctx) => {
    if (arm.renderHang) { arm.renderHang = false; arm.onHang?.(); return new Promise(() => {}); }
    const out = await render(p, m, channels, ctx);
    if (arm.complianceFail && ctx?.jpegQualityMin === undefined) {
      arm.complianceFail = false;
      for (const c of channels) out[c] = { ...out[c]!, flags: [...out[c]!.flags, "failed_compliance"], compliance: { ...out[c]!.compliance, ok: false, failures: ["bytes: The file is over 2 MB."] } };
    }
    return out;
  }) as typeof render;
  const judge = e.w.deps.judgeOutput;
  e.w.deps.judgeOutput = vi.fn(async (input, llm) => {
    const result = await judge(input, llm);
    if (!arm.productRemoved) return result;
    arm.productRemoved = false;
    const low = Object.fromEntries(Object.entries(DIMENSION_FLAGS).filter(([, flag]) => flag === "product_removed").map(([d]) => [d, 20]));
    return { ...result, verdict: "fail", flags: ["product_removed"] as never, scores: { ...result.scores, ...low } };
  }) as typeof judge;
  const prepare = e.w.deps.prepare;
  e.w.deps.prepare = vi.fn(async (...args: Parameters<typeof prepare>) => {
    const p = await prepare(...args);
    if (!arm.jitter) return p;
    arm.jitter = false;
    const rgb = Buffer.from(p.rgb); rgb[0] = (rgb[0]! + 1) % 256;
    return { ...p, rgb };
  }) as typeof prepare;
  const call = e.w.deps.enlarge!;
  e.w.deps.enlarge = (async (...args: Parameters<typeof call>) => {
    // callHang: the worker dies with the call in flight; callKill: the request is killed at its deadline mid-call. Either
    // way the request was sent and the handler cannot know whether an instance billed it, so the next claim writes a
    // cost row for it (3.10): the model records it as a call that reached the service, which check (f) counts.
    if (arm.callHang || arm.callKill) {
      arm.callHang = false;
      arm.callKill = false;
      e.service.state.calls.push({ upscaler: args[2]?.upscaler ?? "swinir-x2", productId: String(args[1].productId ?? ""), w: 0, h: 0, mode: e.service.state.mode, ok: false, handled: true });
      arm.onHang?.();
      return new Promise(() => {});
    }
    return call(...args);
  }) as typeof call;
  const upload = e.w.deps.storage.uploadBuffer;
  e.w.deps.storage.uploadBuffer = (async (...args: Parameters<typeof upload>) => {
    if (arm.uploadFail && args[0].includes("/derived/")) throw Object.assign(new Error("Forbidden"), { code: 403 });
    return upload(...args);
  }) as typeof upload;
  const enqueue = e.w.deps.enqueue;
  e.w.deps.enqueue = (async (...args: Parameters<typeof enqueue>) => {
    // Spec 18 scope: a lost enlarge or chunk send (the stale re-send and the lost-task rule recover them). A lost
    // publish or finalize is the spec 14 watchdog's (it fails the batch after 2 hours) and is not drawn here.
    if (arm.enqueueFail && LOSABLE.has(args[0])) { arm.enqueueFail = false; throw new Error("tasks unavailable"); }
    return enqueue(...args);
  }) as typeof enqueue;
}

/** The next task of this batch, delivered as Cloud Tasks would (a 5xx retried after the back-off, enlarge lanes give up after 9). */
/**
 * Delivers the first due task (a task sent with a delay waits for its schedule time, as Cloud Tasks does); a 5xx
 * answer goes back on the queue after the back-off. False when nothing was due.
 */
async function deliverNext(m: Model): Promise<boolean> {
  const tasks = m.e.w.tasks, now = m.e.w.deps.now();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    if ((await batchOfTask(db, task)) !== m.s.batch.id) { tasks.splice(i--, 1); continue; }
    if (task.notBefore && task.notBefore > now) continue;
    tasks.splice(i, 1);
    const result = await raceHang(m, task);
    if (result === "hung") return true;
    if (task.route === "/tasks/catalog/enlarge") m.arm.uploadFail = false;
    if (process.env.ENLARGE_MODEL_TRACE) console.info(`  DELIVER ${task.route.split("/").pop()}:${String(task.body.chunkId ?? task.body.enlargementId ?? task.body.productId ?? "").slice(0, 4)} -> ${result.httpStatus} ${result.outcome ?? ""} :: ${(await rowsOf(db, m.s.batch.id)).map((r) => `${r.sourceImageId.slice(0, 4)}:${r.identityHash.slice(0, 4)}:${r.status}/${r.wanted ? "w" : "r"}/a${r.attempts}`).join(" ")} ;; ${(await outputsOf(db, m.s.batch.id)).map((o) => `${o.sourceImageId.slice(0, 4)}:${o.status}/${o.flags.join("+")}`).join(" ")}`);
    if (result.httpStatus >= 500) {
      task.retryCount++;
      task.notBefore = new Date(+now + backoffMin(task.route, task.retryCount) * 60_000);
      tasks.push(task);
    }
    return true;
  }
  return false;
}
/** A delivery that may hang (an armed render or service call, a kill mid-call): returns "hung" when it does, the answer otherwise. */
async function raceHang(m: Model, task: QueuedTask) {
  const armed = m.arm.renderHang || m.arm.callHang || m.arm.callKill;
  // A hung delivery stops where the fault was armed (the render or the service call never returns): move on then.
  const hung = armed ? new Promise<"hung">((resolve) => { m.arm.onHang = () => resolve("hung"); }) : null;
  const run = (): Promise<HandleResult | "hung"> => (hung ? Promise.race([deliver(m.e.w, task), hung]) : deliver(m.e.w, task));
  try { return task.route === "/tasks/catalog/enlarge" ? await deliverEnlarge(m, task.body.enlargementId as string, run) : await run(); } finally { m.arm.onHang = undefined; }
}
/**
 * An enlarge delivery with check (k) (no paid call without a counter: a call an instance handled leaves the row with
 * more progress or a higher count, also when the delivery was killed in the middle of it) and check (l) (no call-free
 * loop).
 */
async function deliverEnlarge<R extends HandleResult | "hung">(m: Model, rowId: string, run: () => Promise<R>): Promise<R> {
  const read = async () => (await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, rowId)))[0];
  const handled = () => m.e.service.state.calls.filter((c) => c.handled).length;
  const before = await read(), calls = handled(), mode = m.e.service.state.mode;
  const result = await run();
  const after = await read();
  const outcome = result === "hung" ? "hung" : result.outcome;
  if (before && after && handled() > calls && !["down", "paused"].includes(mode)) {
    const progress = (r: typeof before) => r.attempts + r.timeouts + r.tilesDone + (r.status === "done" ? 1 : 0);
    expect(progress(after), `(k) row ${rowId} made a call without a counter (${outcome})`).toBeGreaterThan(progress(before));
  }
  if (result === "hung") return result;
  const streak = result.outcome === "in_flight" ? (m.inFlight.get(rowId) ?? 0) + 1 : 0;
  m.inFlight.set(rowId, streak);
  expect(streak, `(l) row ${rowId} answered in_flight ${streak} times in a row`).toBeLessThanOrEqual(IN_FLIGHT_BOUND);
  return result;
}

const pick = <T>(m: Model, list: readonly T[]): T | undefined => list.length ? list[Math.floor(m.rnd() * list.length)] : undefined;
const heldOutputs = async (m: Model) => (await outputsOf(db, m.s.batch.id)).filter((o) => o.decision === null && (o.status === "needs_attention" || o.status === "failed"));
/** A refused action (409/400, the plain warning) or an enqueue failure after the commit (the route answers 500; the sweep's lost-task rule recovers). */
const decided = (error: unknown) => { if (!(error instanceof CatalogDecisionError) && !(error instanceof CatalogPlainWarning) && !(error instanceof Error && error.message === "tasks unavailable")) throw error; };
/** What the web does after a decision: the product's publish, then the direct unparked chunks. */
async function afterDecision(m: Model, result: Awaited<ReturnType<typeof applyDecision>>) {
  await m.e.w.deps.enqueue("/tasks/catalog/publish", { batchId: result.batchId, productId: result.productId, trigger: result.decisionId }, { taskId: `publish-${result.productId}-${result.decisionId}` });
  for (const chunk of result.unparked ?? []) if (chunk.direct) await tryEnqueueChunk(m.e.w.deps.enqueue, chunk, m.e.w.deps.log);
}

const MODES: ServiceMode[] = ["ok", "busy", "down", "paused", "wrongSize", "badInput", "healthyButHangs", "slow", "crashOnThisInput", "coldStart", "probeTimesOut", "saturated", "crash503", "crash500", "noInstance"];
/** The events and their weights. */
const EVENTS_TABLE: [number, string, (m: Model) => Promise<void>][] = [
  [30, "deliverNext", async (m) => { await deliverNext(m); }],
  [4, "deliverEnlarge(duplicate)", async (m) => {
    const row = pick(m, (await rowsOf(db, m.s.batch.id)).filter((r) => r.wanted && r.status === "queued"));
    if (row) await deliverEnlarge(m, row.id, () => handleEnlargeTask(m.e.w.deps, enlargeBody(row)));
  }],
  [2, "crashEnlargeAfter(claim)", async (m) => { m.arm.callHang = true; await deliverNext(m); m.arm.callHang = false; }],
  [2, "crashRenderAfter(patch)", async (m) => { m.arm.renderHang = true; await deliverNext(m); m.arm.renderHang = false; }],
  [2, "killAtDeadline(midCall)", async (m) => { m.arm.callKill = true; await deliverNext(m); m.arm.callKill = false; }],
  [2, "uploadError", async (m) => { m.arm.uploadFail = true; }],
  [0.4, "flip(off)", async (m) => { if (m.off) return; m.off = true; m.e.w.deps.enlarge = undefined; await sweep(db, m.e.w, { enlargementOff: true }).catch(decided); }],
  [2, "judgeProductRemoved", async (m) => { m.arm.productRemoved = true; }],
  [2, "complianceFail", async (m) => { m.arm.complianceFail = true; }],
  [2, "replacePhoto", async (m) => { const o = pick(m, await heldOutputs(m)); if (o) await replacePhoto(db, m.e.w, o.id, m.e.w.deps.now).catch(decided); }],
  [2, "useAsIs", async (m) => {
    const o = pick(m, await heldOutputs(m));
    if (o) { const r = await applyDecision(db, { outputId: o.id, decision: "use_as_is", actor, acceptPlain: m.rnd() < 0.6, now: m.e.clock.now() }).catch(decided); if (r) await afterDecision(m, r).catch(decided); }
  }],
  [3, "retryEnlargement", async (m) => {
    const o = pick(m, (await heldOutputs(m)).filter((x) => x.flags.includes("enlargement_failed")));
    if (o) await retryEnlargement(db, m.e.w.deps.enqueue, { outputId: o.id, actor, now: m.e.clock.now() }).catch(decided);
  }],
  [1, "remove", async (m) => { const o = pick(m, await heldOutputs(m)); if (o) { const r = await applyDecision(db, { outputId: o.id, decision: "remove", actor, now: m.e.clock.now() }).catch(decided); if (r) await afterDecision(m, r).catch(decided); } }],
  [6, "sweep(+N min)", async (m) => { const r = m.rnd(); await timeTravel(m, r < 0.05 ? 24 * 60 * m.rnd() : r < 0.3 ? 30 + 90 * m.rnd() : 1 + 10 * m.rnd()); }],
  [2, "deleteObject", async (m) => { const row = pick(m, (await rowsOf(db, m.s.batch.id)).filter((r) => r.status === "done" && r.uri)); if (row) { m.e.w.objects.delete(row.uri!); m.broken.add(row.id); } }],
  [2, "invalidObject", async (m) => { const row = pick(m, (await rowsOf(db, m.s.batch.id)).filter((r) => r.status === "done" && r.uri)); if (row) { await corruptObject(m.e.w, row.uri!); m.broken.add(row.id); } }],
  [6, "serviceMode", async (m) => {
    const mode = pick(m, MODES)!;
    m.e.service.state.mode = mode;
    m.e.service.state.poison.clear();
    if (mode === "crashOnThisInput" || mode === "saturated" || mode === "crash503" || mode === "crash500") {
      // The generator pairs saturated with a poison input; a crash on this input is one product.
      const product = pick(m, m.s.chunks.flatMap((c) => c.productIds))!;
      m.e.service.state.poison.add(product);
    }
  }],
  [1, "nondeterministicPrepare", async (m) => { m.arm.jitter = true; }],
  [2, "enqueueFail", async (m) => { m.arm.enqueueFail = true; }],
  [2, "loseTask", async (m) => { const tasks = m.e.w.tasks, losable = tasks.filter((t) => LOSABLE.has(t.route)); const t = pick(m, losable); if (t) tasks.splice(tasks.indexOf(t), 1); }],
  [2, "oldRevisionDeliver", async (m) => {
    const parked = pick(m, (await chunksOf(db, m.s.batch.id)).filter((c) => c.taskName === ENLARGING_TASK && c.status === "queued"));
    if (!parked) return;
    await handleChunkTask(m.e.w.deps, await currentChunkTask(db, parked.id));
    const [after] = (await chunksOf(db, m.s.batch.id)).filter((c) => c.id === parked.id);
    // (j) a parked chunk is never dispatched by a delivery: it stays parked while its rows are queued.
    const queued = (await rowsOf(db, m.s.batch.id)).some((r) => r.wanted && r.status === "queued");
    if (queued) expect(after, `(j) parked chunk ${parked.id} was dispatched`).toMatchObject({ taskName: ENLARGING_TASK });
  }],
];
const TOTAL_WEIGHT = EVENTS_TABLE.reduce((t, [w]) => t + w, 0);
function draw(m: Model) {
  let r = m.rnd() * TOTAL_WEIGHT;
  for (const entry of EVENTS_TABLE) { r -= entry[0]; if (r < 0) return entry; }
  return EVENTS_TABLE[0]!;
}

/** Checks (a)-(h) after every event. */
async function check(m: Model) {
  const batchId = m.s.batch.id;
  const [rows, outputs, chunks, batch] = await Promise.all([rowsOf(db, batchId), outputsOf(db, batchId), chunksOf(db, batchId), batchOf(db, batchId)]);
  const wantedQueued = rows.filter((r) => r.wanted && r.status === "queued");
  // (a) a parked chunk has a wanted queued row among its photos (the converse: a QA re-queue does not park, 3.3).
  for (const c of chunks.filter((x) => x.taskName === ENLARGING_TASK && x.status === "queued")) {
    const photos = c.sourceImageIds?.length ? new Set(c.sourceImageIds) : null;
    const waiting = wantedQueued.some((r) => c.productIds.includes(r.productId) && (!photos || photos.has(r.sourceImageId)));
    expect(waiting, `(a) chunk ${c.id} parked with nothing queued`).toBe(true);
  }
  // (b) a held enlargement_failed output has a failed wanted row for its photo.
  for (const o of outputs.filter((x) => x.decision === null && x.status === "needs_attention" && x.flags.includes("enlargement_failed"))) {
    expect(rows.some((r) => r.sourceImageId === o.sourceImageId && r.wanted && r.status === "failed"), `(b) output ${o.id} held without a failed row`).toBe(true);
  }
  // (c) no staged or verified output above the threshold lacks `upscaled`, unless accepted plain (or `off` was drawn).
  if (!m.off) for (const o of outputs.filter((x) => (x.status === "staged" || x.status === "verified") && (x.scale ?? 0) > 1 && !x.flags.includes("upscaled"))) {
    expect(o.decision === "use_as_is" && o.flags.includes("enlargement_failed"), `(c) output ${o.id} (scale ${o.scale}) is plain`).toBe(true);
  }
  // (d) every done row's object passes the validator, unless an event broke it: readiness finds that lazily (the next
  // render or ladder step queues the row again), so a broken row is checked again once it has been made again.
  for (const r of rows) if (m.broken.has(r.id) && r.status !== "done") m.broken.delete(r.id);
  for (const r of rows.filter((x) => x.status === "done" && x.uri)) {
    if (m.broken.has(r.id)) continue;
    const bytes = m.e.w.objects.get(r.uri!);
    expect(bytes, `(d) done row ${r.id} has no object`).toBeDefined();
    expect(await validateEnlargedObject({ bytes: bytes!, metadata: m.e.w.metadata.get(r.uri!) }, r), `(d) done row ${r.id}`).toEqual({ ok: true });
  }
  // (e) counters within their caps, the status one of three.
  const releases = new Map<string, number>();
  for (const r of rows) {
    expect(["queued", "done", "failed"]).toContain(r.status);
    expect(r.attempts, `(e) attempts of ${r.id}`).toBeLessThanOrEqual(ENLARGE_TASK_MAX_ATTEMPTS);
    expect(r.timeouts, `(e) timeouts of ${r.id}`).toBeLessThanOrEqual(ENLARGE_MAX_TIMEOUTS);
    expect(r.probeTimeouts, `(e) probe timeouts of ${r.id}`).toBeLessThanOrEqual(ENLARGE_PROBE_TIMEOUTS_MAX);
    releases.set(r.sourceImageId, Math.max(releases.get(r.sourceImageId) ?? 0, r.identityReleases));
  }
  for (const [photo, n] of releases) expect(n, `(e) identity releases of photo ${photo}`).toBeLessThanOrEqual(ENLARGE_MAX_IDENTITY_CHANGES);
  // (f) one cost row per call that reached the service at most, and at least one ok row per row made here.
  const costs = await db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.batchId, batchId), eq(catalogCostEvents.kind, "upscale_call")));
  expect(costs.length, "(f) cost rows without a call").toBeLessThanOrEqual(m.e.service.state.calls.length);
  // (g) no two wanted rows of one photo share an identity.
  const keys = rows.filter((r) => r.wanted).map((r) => `${r.sourceImageId}|${r.identityHash}`);
  expect(new Set(keys).size, "(g) duplicate wanted identity").toBe(keys.length);
  // (h) the batch never fails.
  expect(batch.status, "(h) batch failed").not.toBe("failed");
}

/**
 * Time passes as it does in production: the sweep runs every 5 minutes and Cloud Tasks delivers what is queued (each
 * task once per step, a 5xx back on the queue), so a long wait is a long run of sweeps and deliveries, never a jump.
 */
async function timeTravel(m: Model, minutes: number) {
  for (let left = minutes; left > 0; left -= 5) {
    m.e.clock.tick(Math.min(5, left));
    await sweep(db, m.e.w, m.off ? { enlargementOff: true } : {}).catch(decided);
    for (let n = m.e.w.tasks.length; n > 0 && (await deliverNext(m)); n--) await check(m);
  }
}
/** Quiet: the batch done, nothing queued, no chunk queued or running (a done batch's retry or replacement included). */
async function quiet(batchId: string, e: EnlargeWorld) {
  if ((await batchOf(db, batchId)).status !== "done" || e.w.tasks.length) return false;
  return !(await chunksOf(db, batchId)).some((c) => c.status === "queued" || c.status === "running");
}
/** Deliver everything until quiet, sweeping with time travel up to 48 h, the service `ok`. */
async function settle(m: Model) {
  m.e.service.state.mode = "ok"; m.e.service.state.poison.clear(); m.e.service.state.probe = null;
  m.arm.renderHang = m.arm.callHang = m.arm.callKill = m.arm.uploadFail = m.arm.enqueueFail = false;
  for (let hours = 0; hours <= 48; hours += 0.5) {
    for (let n = 0; n < 400 && (await deliverNext(m)); n++) await check(m);
    if (await quiet(m.s.batch.id, m.e)) break;
    m.e.clock.tick(30);
    await sweep(db, m.e.w, m.off ? { enlargementOff: true } : {}).catch(decided);
  }
}

async function runSequence(seed: number) {
  const rnd = lcg(seed);
  clearMadeImages();
  const e = enlargeWorld(db);
  const arm: Arm = { renderHang: false, callHang: false, callKill: false, uploadFail: false, complianceFail: false, productRemoved: false, jitter: false, enqueueFail: false };
  armWorld(e, arm);
  const s = await seedEnlargeBatch(db, e.w, `t40-${seed}`, [[1, 1], [1]]);
  const m: Model = { e, s, rnd, off: false, arm, broken: new Set(), inFlight: new Map(), trail: [] };
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  try {
    for (let i = 0; i < EVENTS; i++) {
      const [, name, run] = draw(m);
      m.trail.push(name);
      await run(m);
      if (process.env.ENLARGE_MODEL_TRACE) {
        const rows = await rowsOf(db, s.batch.id), outs = await outputsOf(db, s.batch.id);
        console.info(`TRACE ${i} ${name}: rows ${rows.map((r) => `${r.sourceImageId.slice(0, 4)}:${r.identityHash.slice(0, 4)}:${r.status}/${r.wanted ? "w" : "r"}/a${r.attempts} ${r.errorKind ?? ""}`).join(" | ")}; outs ${outs.map((o) => `${o.sourceImageId.slice(0, 4)}:${o.status}/${o.decision ?? "-"}/${o.flags.join("+")}`).join(" | ")}`);
        const ch = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id));
        console.info(`  CHUNKS ${ch.map((c) => `${c.id.slice(0, 4)}:${c.stage}/${c.status}/${c.taskName ?? "-"}/${c.productIds.map((x) => x.slice(0, 4)).join(",")}`).join(" | ")}; TASKS ${m.e.w.tasks.map((t) => `${t.route.split("/").pop()}:${String(t.body.chunkId ?? t.body.enlargementId ?? t.body.productId ?? "").slice(0, 4)}`).join(" ")}`);
      }
      await check(m);
    }
    await settle(m);
    const batch = await batchOf(db, s.batch.id);
    expect(batch.status, "the batch reached done").toBe("done");
    const outputs = await outputsOf(db, s.batch.id);
    expect(outputs.filter((o) => o.status === "pending"), "no output pending").toEqual([]);
    for (const o of outputs.filter((x) => x.decision === null && (x.status === "needs_attention" || x.status === "failed"))) expect(o.reason ?? o.error, `held output ${o.id} has a reason`).toBeTruthy();
    return m.trail;
  } catch (error) {
    const batch = await batchOf(db, s.batch.id), chunks = await chunksOf(db, s.batch.id), rows = await rowsOf(db, s.batch.id);
    const state = `batch ${batch.status} ${batch.error ?? ""}; chunks ${chunks.map((c) => `${c.index}:${c.stage}/${c.status}/${c.taskName ?? "-"}/a${c.attempt} ${c.error ?? ""}`).join(" | ")}; rows ${rows.map((r) => `${r.status}/${r.wanted ? "w" : "r"}/a${r.attempts}t${r.timeouts}s${r.sends} ${r.errorKind ?? ""}`).join(" | ")}`;
    throw new Error(`T40 seed ${seed} (rerun: ENLARGE_MODEL_SEED=${seed} ENLARGE_MODEL_SEQUENCES=1), events: ${m.trail.join(", ")}\nstate: ${state}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

describe("T40: the enlargement lifecycle state machine", () => {
  it(`${SEQUENCES} sequences of ${EVENTS} events: invariants after every event, every batch done at the end`, async () => {
    const counts = new Map<string, number>();
    for (let k = 0; k < SEQUENCES; k++) {
      const trail = await runSequence(FIRST_SEED + k);
      for (const name of trail) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    // Every event kind was drawn at least once over the run.
    if (SEQUENCES >= 50) for (const [, name] of EVENTS_TABLE) expect(counts.get(name) ?? 0, `event ${name} never drawn`).toBeGreaterThan(0);
  }, 6 * 60 * 60_000);
});

describe("T39: end to end through the queue", () => {
  it("the real render, one forced terminal product: zero silent outputs, every parked chunk's render queued once, the held product has enlargement_failed", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t39", [[1, 1], [1]]);
    const terminal = s.chunks[0]!.productIds[1]!;
    e.service.state.mode = "crashOnThisInput";
    e.service.state.poison.add(terminal);
    const m: Model = { e, s, rnd: lcg(39), off: false, arm: { renderHang: false, callHang: false, callKill: false, uploadFail: false, complianceFail: false, productRemoved: false, jitter: false, enqueueFail: false }, broken: new Set(), inFlight: new Map(), trail: [] };
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    for (let hours = 0; hours <= 48; hours += 0.5) {
      for (let n = 0; n < 400 && (await deliverNext(m)); n++) await check(m);
      if (await quiet(s.batch.id, e)) break;
      e.clock.tick(30);
      await sweep(db, e.w);
    }
    expect((await batchOf(db, s.batch.id)).status).toBe("done");
    const outputs = await outputsOf(db, s.batch.id);
    // Zero silent: every output is upscaled, or held with enlargement_failed.
    for (const o of outputs) expect(o.flags.includes("upscaled") || (o.status === "needs_attention" && o.flags.includes("enlargement_failed")), `output ${o.id}`).toBe(true);
    const held = outputs.filter((o) => o.productId === terminal);
    expect(held.map((o) => [o.status, o.flags.includes("enlargement_failed")])).toEqual([["needs_attention", true]]);
    expect(outputs.filter((o) => o.productId !== terminal).every((o) => o.status === "verified")).toBe(true);
    const rows = await db.select().from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, s.batch.id), eq(catalogEnlargements.productId, terminal)));
    // A crash on this input with a healthy service is counted (3.4 step 9): terminal at a counter's cap.
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
    expect(rows[0]!.attempts === ENLARGE_TASK_MAX_ATTEMPTS || rows[0]!.timeouts === ENLARGE_MAX_TIMEOUTS).toBe(true);
    // Every parked chunk's render was queued once after its rows settled (one "chunk enlarged" per chunk).
    const enlarged = e.w.log.mock.calls.filter(([message]) => message === "chunk enlarged").map(([, fields]) => fields?.chunkId as string);
    for (const c of s.chunks) expect(enlarged.filter((id) => id === c.id).length, `chunk ${c.id}`).toBeLessThanOrEqual(1);
    const renders = e.w.enqueue.mock.calls.filter(([route, body]) => route === "/tasks/catalog/chunk" && body.stage === "render").map(([, body]) => body.chunkId as string);
    for (const c of s.chunks) expect(renders.filter((id) => id === c.id).length, `render tasks of chunk ${c.id}`).toBe(1);
    expect((await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.batch.id), isNull(catalogOutputs.decision), eq(catalogOutputs.status, "pending")))).length).toBe(0);
  }, 600_000);
});
