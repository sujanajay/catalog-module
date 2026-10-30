// Test support for the spec 18 enlargement lifecycle (enlarge.test.ts, enlarge.model.test.ts): a fake upscale service
// and health probe driven by a mode, a clock the tests move (claims, the sweep, the back-off), a batch with its pinned
// route, a generation-aware in-memory public bucket (publish and finalize run for real), and a queue driver that
// delivers every task to its real handler (a 503 goes back to the end of the queue, as Cloud Tasks retries it).
import sharp from "sharp";
import { vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogCostEvents, catalogEnlargements, catalogOutputs, catalogProducts, catalogSourceImages, catalogUploads, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { completeReplacement, startReplacement } from "@catalog/core/catalog/decisions";
import { enqueueChunk, tryEnqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import { renderAllChannels } from "@catalog/core/catalog/render";
import { upscalerFactor } from "@catalog/core/catalog/upscale";
import { EnlargeBadInputError, EnlargeBusyError, EnlargeError, EnlargeModelUnavailableError, EnlargeTimeoutError, enlargeViaService, type UpscaleProbe } from "@catalog/core/catalog/enlarge";
import type { EnlargementOption } from "@catalog/core/catalog/pipeline/enlargement";
import { releaseLocks } from "@catalog/core/catalog/pipeline/publish";
import type { ChannelId } from "@catalog/core/catalog/types";
import type { HandleResult } from "../src/server";
import { currentChunkTask, handleChunkTask } from "../src/catalog/chunk";
import { handleEnlargeTask, type EnlargeCall, type EnlargeProbe } from "../src/catalog/enlarge";
import { handlePublishTask } from "../src/catalog/publish";
import { handleFinalizeTask } from "../src/catalog/finalize";
import { handleSweep } from "../src/catalog/sweep";
import { repairOwnDefects } from "../src/catalog/qa-stage";
import { fakeWorld, seedBatch, type FakeWorld, type QueuedTask } from "./catalog-fakes";

export type ServiceMode = "ok" | "busy" | "down" | "paused" | "unavailable" | "wrongSize" | "slow" | "badInput" | "healthyButHangs" | "crashOnThisInput" | "coldStart" | "probeTimesOut" | "saturated" | "crash503" | "crash500" | "noInstance";
/** One call that reached the service; `handled` is false when no instance did any work (Cloud Run refused it, the service was absent). */
export interface ServiceCall { upscaler: string; productId: string; w: number; h: number; mode: ServiceMode; ok: boolean; handled: boolean }
/** Cloud Run's own answers (docs.cloud.google.com/run/docs/troubleshooting), read 2026-10-30. */
export const CLOUD_RUN_CRASH_503 = "The request failed because either the HTTP response was malformed or connection to the instance had an error.";
export const CLOUD_RUN_MEMORY_500 = "While handling this request, the container instance was found to be using too much memory and was terminated.";
export const CLOUD_RUN_NO_INSTANCE_500 = "The request was aborted because there was no available instance.";
/** A Cloud Run answer as the real client classifies it (core enlargeViaService over a fake fetch). */
async function cloudRunAnswer(status: number, body: string): Promise<never> {
  throw await enlargeViaService({ url: "https://catalog-upscale-abc-el.a.run.app", jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), model: "swinir-x2", maxAttempts: 1 }, { idToken: async () => "t", fetch: (async () => new Response(body, { status })) as unknown as typeof fetch }).catch((e: unknown) => e);
}

/** The test clock: deps.now reads it; `tick` moves it (minutes). Starts at the real time so database defaults agree. */
export function testClock(start = Date.now()) {
  let t = start;
  return { now: () => new Date(t), tick: (minutes: number) => { t += minutes * 60_000; }, at: () => t, set: (ms: number) => { t = ms; } };
}
export type TestClock = ReturnType<typeof testClock>;

/** A transport failure as enlargeViaService reports it (refused: the service is absent; reset: a crash on this input). */
function transportError(transport: "refused" | "reset"): EnlargeError {
  const error = new EnlargeError(`The enlargement service failed (${transport === "refused" ? "connection refused" : "connection reset"}).`, transport === "refused" ? "unavailable" : "server", null, true, 1);
  error.transport = transport;
  return error;
}

/**
 * The fake upscale service. Each call enlarges the uploaded JPEG by the row's factor (a flat image, cheap), or fails
 * by `mode`: busy (429), down (connection refused), paused / unavailable (the service's own 503), wrongSize (factor 3),
 * slow (10 minutes of clock, then ok), badInput (400), healthyButHangs (no answer: timeout), crashOnThisInput (a reset
 * for the products in `poison`, others ok), coldStart / probeTimesOut / saturated (the probe answers differently,
 * calls succeed), crash503 / crash500 (Cloud Run's answers when the instance handling a `poison` product is killed:
 * a 503 "connection to the instance had an error", a 500 for memory; others ok), noInstance (Cloud Run's 500 "no
 * available instance": never handled). `shortBy` answers N px short on the width (an invalid object). The probe
 * answers by mode, unless `probe` overrides it.
 *
 * The delivery's wall clock (final check 2026-10-30): `callMs` and `probeMs` move the test clock by that long per call
 * or probe (a probe longer than its timeout answers "timeout" at its timeout); `hangUntilDeadline` makes a call run
 * until its `deadlineAt` and then time out, as the real client does. While `killAt` is set (deliverWithDeadline), a
 * call or probe that would still run at that instant moves the clock there and never returns: Cloud Run killed the
 * request mid-call (`killed` resolves).
 */
export function fakeUpscale(clock: TestClock) {
  const state = { mode: "ok" as ServiceMode, poison: new Set<string>(), probe: null as UpscaleProbe | null, shortBy: 0, hold: null as Promise<void> | null, badWhen: null as ((upload: { w: number; h: number }) => boolean) | null, colour: 200, calls: [] as ServiceCall[], probes: 0,
    callMs: 0, probeMs: 0, hangUntilDeadline: false, killAt: null as number | null, onKill: null as (() => void) | null };
  /** Moves the clock by `ms`, or to the kill instant and never returns when the delivery is killed first. */
  const spend = async (ms: number) => {
    if (state.killAt !== null && clock.at() + ms >= state.killAt) { clock.set(state.killAt); state.onKill?.(); await new Promise(() => {}); }
    clock.set(clock.at() + ms);
  };
  const call = vi.fn<EnlargeCall>(async (jpeg, trace, opts) => {
    const meta = await sharp(jpeg).metadata(), id = opts?.upscaler ?? "swinir-x2", mode = state.mode;
    const productId = String(trace.productId ?? "");
    const record = (ok: boolean, handled = true) => state.calls.push({ upscaler: id, productId, w: meta.width!, h: meta.height!, mode, ok, handled });
    if (state.hold) { const hold = state.hold; state.hold = null; await hold; }
    if (state.hangUntilDeadline) { record(false); await spend(Math.max(0, (opts?.deadlineAt ?? clock.at()) - clock.at())); throw new EnlargeTimeoutError(Math.max(0, (opts?.deadlineAt ?? 0) - clock.at()), 1); }
    if (state.callMs) { state.calls.push({ upscaler: id, productId, w: meta.width!, h: meta.height!, mode, ok: false, handled: true }); const at = state.calls.length - 1; await spend(state.callMs); state.calls.splice(at, 1); }
    if (state.poison.has(productId)) {
      record(false);
      if (mode === "crash503") return cloudRunAnswer(503, CLOUD_RUN_CRASH_503);
      if (mode === "crash500") return cloudRunAnswer(500, CLOUD_RUN_MEMORY_500);
      throw transportError("reset");
    }
    if (state.badWhen?.({ w: meta.width!, h: meta.height! })) { record(false); throw new EnlargeBadInputError(400, 1); }
    switch (mode) {
      case "busy": record(false, false); throw new EnlargeBusyError(429, 1);
      case "noInstance": record(false, false); return cloudRunAnswer(500, CLOUD_RUN_NO_INSTANCE_500);
      case "down": record(false, false); throw transportError("refused");
      case "paused": case "unavailable": { record(false, false); const e = new EnlargeModelUnavailableError(1); e.ownBody = true; throw e; }
      case "badInput": record(false); throw new EnlargeBadInputError(400, 1);
      case "healthyButHangs": record(false); throw new EnlargeTimeoutError(480_000, 1);
      case "slow": clock.tick(10); break;
      default: break;
    }
    const f = mode === "wrongSize" ? 3 : upscalerFactor(id);
    record(true);
    const out = await sharp({ create: { width: meta.width! * f - state.shortBy, height: meta.height! * f, channels: 3, background: { r: 0, g: state.colour, b: 0 } } }).jpeg({ quality: 90 }).toBuffer();
    return { jpeg: out, ms: 90_000, model: f === 4 ? "swinir-x4" : "swinir-x2", attempts: 1 };
  });
  const probe = vi.fn<EnlargeProbe>(async (_upscaler, opts) => {
    state.probes++;
    if (state.probeMs) {
      const timeoutMs = opts?.timeoutMs ?? Infinity;
      await spend(Math.min(state.probeMs, timeoutMs));
      if (state.probeMs > timeoutMs) return "timeout";
    }
    if (state.probe) return state.probe;
    switch (state.mode) {
      case "down": case "paused": case "unavailable": return "absent";
      case "busy": case "noInstance": return "no_instance";
      case "probeTimesOut": return "timeout";
      case "saturated": return "busy";
      default: return "ok";
    }
  });
  return { call, probe, state, paid: (productId?: string) => state.calls.filter((c) => !productId || c.productId === productId).length };
}
export type FakeUpscale = ReturnType<typeof fakeUpscale>;

/** A world whose worker enlarges: the fake service, its probe, the clock, a publishable bucket. */
export function enlargeWorld(db: Db, options: { imageScale?: number; realRender?: boolean } = {}) {
  const w = fakeWorld(db, 0, { imageScale: options.imageScale ?? 0.5 });
  const clock = testClock();
  const service = fakeUpscale(clock);
  w.deps.now = clock.now;
  w.deps.enlarge = service.call;
  w.deps.enlargeProbe = service.probe;
  // The production QA ladder (deps.ts wires it), so the judges run their real repairs.
  w.deps.repairOwnDefects = repairOwnDefects;
  publishable(w);
  if (options.realRender !== false) w.deps.renderAllChannels = (p, m, channels, ctx) => renderAllChannels(p, m, channels, ctx);
  return { w, clock, service };
}
export type EnlargeWorld = ReturnType<typeof enlargeWorld>;

/** Generations on every object and a public bucket behind the real publish (stageCopyToPublic, fetch, delete). */
function publishable(w: FakeWorld) {
  const gens = new Map<string, number>();
  let generation = 100;
  const storage = w.deps.storage;
  const upload = storage.uploadBuffer;
  const crc = (buf: Buffer) => `${buf.length}-${buf.subarray(0, 64).toString("base64")}`;
  storage.uploadBuffer = (async (path: string, buf: Buffer, mime: string, opts?: { metadata?: Record<string, string> }) => { const uri = await upload(path, buf, mime, opts); gens.set(uri, ++generation); return uri; }) as typeof storage.uploadBuffer;
  storage.headObject = (async (uri: string) => {
    const buf = w.objects.get(uri), meta = w.metadata.get(uri);
    return buf ? { exists: true, size: buf.length, contentType: "image/jpeg", generation: String(gens.get(uri) ?? 1), crc32c: crc(buf), ...(meta ? { metadata: meta } : {}) } : { exists: false, size: null, contentType: null, generation: null, crc32c: null };
  }) as typeof storage.headObject;
  storage.stageCopyToPublic = (async (staging: string, objectPath: string, { ifGenerationMatch }: { ifGenerationMatch: number | string }) => {
    const dest = `gs://public/${objectPath}`, buf = w.objects.get(staging);
    if (!buf) throw new Error(`No object ${staging}`);
    if (String(ifGenerationMatch) !== String(gens.get(dest) ?? 0)) throw Object.assign(new Error("Precondition failed"), { code: 412 });
    w.objects.set(dest, buf); gens.set(dest, ++generation);
    return { generation: String(generation), crc32c: crc(buf) };
  }) as typeof storage.stageCopyToPublic;
  storage.deletePublicObject = (async (path: string) => { w.objects.delete(`gs://public/${path}`); gens.delete(`gs://public/${path}`); return true; }) as unknown as typeof storage.deletePublicObject;
  storage.setCustomTime = (async () => {}) as typeof storage.setCustomTime;
  w.deps.fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/public\//, ""), uri = `gs://public/${path}`, buf = w.objects.get(uri);
    return buf ? new Response(new Uint8Array(buf), { headers: { "content-type": "image/jpeg", "content-length": String(buf.length), "x-goog-generation": String(gens.get(uri)) } }) : new Response(null, { status: 404 });
  });
}

/** A batch with its pinned route (what Start records): x2 at `minScale`, x4 when `x4`. */
export async function seedEnlargeBatch(db: Db, w: FakeWorld, name: string, layout: number[][], options: { channels?: ChannelId[]; route?: EnlargementOption | null; corrupt?: number[] } = {}) {
  const s = await seedBatch(db, w, name, layout, { channels: options.channels ?? ["trendyol"], ...(options.corrupt ? { corrupt: options.corrupt } : {}) });
  const route = options.route === undefined ? { model: "swinir-x2", minScale: 1 } : options.route;
  if (route) await db.update(catalogBatches).set({ options: { ...s.batch.options, enlargement: route } }).where(eq(catalogBatches.id, s.batch.id));
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
  return { ...s, batch: batch! };
}

/**
 * One enlarge delivery under its Cloud Run request deadline (ENLARGE_DISPATCH_DEADLINE_SEC from now, or `killAfterMs`):
 * when the fake service's clock passes it mid-call or mid-probe, the request is killed there (504 `killed`) and the
 * handler never continues, as on Cloud Run.
 */
export async function deliverWithDeadline(e: { w: FakeWorld; clock: TestClock; service: FakeUpscale }, body: Record<string, unknown>, killAfterMs = 1_800_000): Promise<HandleResult> {
  const state = e.service.state;
  let killed!: () => void;
  const kill = new Promise<HandleResult>((resolve) => { killed = () => resolve({ httpStatus: 504, outcome: "killed" }); });
  state.killAt = e.clock.at() + killAfterMs; state.onKill = killed;
  try { return await Promise.race([handleEnlargeTask(e.w.deps, body), kill]); } finally { state.killAt = null; state.onKill = null; }
}

/** Delivers one queued task to its real handler. */
export async function deliver(w: FakeWorld, task: QueuedTask): Promise<HandleResult> {
  switch (task.route) {
    case "/tasks/catalog/chunk": return handleChunkTask(w.deps, task.body, { retryCount: task.retryCount });
    case "/tasks/catalog/enlarge": return handleEnlargeTask(w.deps, task.body);
    case "/tasks/catalog/publish": return handlePublishTask(w.deps, task.body);
    case "/tasks/catalog/finalize": return handleFinalizeTask(w.deps, task.body);
    default: return { httpStatus: 200, outcome: "ignored" };
  }
}
/**
 * The queue: delivers tasks in order until none is left or `max` deliveries; a 5xx answer goes back to the end (Cloud
 * Tasks retries it). `onDelivery` sees every answer. Returns the answers.
 */
export async function drain(w: FakeWorld, options: { max?: number; skip?: (task: QueuedTask) => boolean; onDelivery?: (task: QueuedTask, result: HandleResult) => Promise<void> | void; only?: { db: Db; batchId: string } } = {}): Promise<{ task: QueuedTask; result: HandleResult }[]> {
  const seen: { task: QueuedTask; result: HandleResult }[] = [];
  for (let n = 0; n < (options.max ?? 500) && w.tasks.length; n++) {
    const task = w.tasks.shift()!;
    if (options.skip?.(task)) continue;
    // The sweep is global (the test database is shared): tasks it sent for other tests' batches are dropped.
    if (options.only && (await batchOfTask(options.only.db, task)) !== options.only.batchId) continue;
    const result = await deliver(w, task);
    seen.push({ task, result });
    await options.onDelivery?.(task, result);
    if (result.httpStatus >= 500) { task.retryCount++; w.tasks.push(task); }
  }
  return seen;
}
/** The batch a queued task belongs to (a chunk task names its chunk). */
export async function batchOfTask(db: Db, task: QueuedTask): Promise<string | null> {
  if (typeof task.body.batchId === "string") return task.body.batchId;
  if (typeof task.body.chunkId !== "string") return null;
  const [chunk] = await db.select({ batchId: catalogChunks.batchId }).from(catalogChunks).where(eq(catalogChunks.id, task.body.chunkId));
  return chunk?.batchId ?? null;
}
/** Starts a batch's first chunks as the start route does (one task per chunk). */
export async function startChunks(db: Db, w: FakeWorld, chunkIds: string[]): Promise<void> {
  for (const id of chunkIds) { const t = await currentChunkTask(db, id); await w.deps.enqueue("/tasks/catalog/chunk", t, { taskId: `chunk-${id}-${String(t.step)}` }); }
}
/** One delivery of a chunk's current task (outside the queue). */
export async function deliverChunk(db: Db, w: FakeWorld, chunkId: string): Promise<HandleResult> {
  return handleChunkTask(w.deps, await currentChunkTask(db, chunkId));
}
/** The sweep at the clock's time. */
export function sweep(db: Db, w: FakeWorld, extra: { enlargementOff?: boolean } = {}): Promise<HandleResult> {
  return handleSweep({ db, releaseLocks, now: w.deps.now, enqueue: w.deps.enqueue, ...extra }, {});
}

export const rowsOf = (db: Db, batchId: string) => db.select().from(catalogEnlargements).where(eq(catalogEnlargements.batchId, batchId)).orderBy(catalogEnlargements.createdAt, catalogEnlargements.id);
export const outputsOf = (db: Db, batchId: string) => db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId)).orderBy(catalogOutputs.n, catalogOutputs.channel);
export const photosOf = (db: Db, batchId: string) => db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId)).orderBy(catalogSourceImages.n);
export const chunksOf = (db: Db, batchId: string) => db.select().from(catalogChunks).where(eq(catalogChunks.batchId, batchId)).orderBy(catalogChunks.index);
export const batchOf = async (db: Db, batchId: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)))[0]!;
export const upscaleCosts = (db: Db, batchId: string) => db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.batchId, batchId), eq(catalogCostEvents.kind, "upscale_call")));
export const enlargeTasks = (w: FakeWorld) => w.tasks.filter((t) => t.route === "/tasks/catalog/enlarge");
/** The enlarge task body of a row, as reconcile sends it. */
export const enlargeBody = (row: { id: string; batchId: string; productId: string }) => ({ batchId: row.batchId, productId: row.productId, enlargementId: row.id });
/** Delivers a row's enlarge task until it answers something other than a 503, at most `max` times. */
export async function enlargeUntilSettled(w: FakeWorld, row: { id: string; batchId: string; productId: string }, max = 40): Promise<HandleResult[]> {
  const out: HandleResult[] = [];
  for (let i = 0; i < max; i++) { const r = await handleEnlargeTask(w.deps, enlargeBody(row)); out.push(r); if (r.httpStatus !== 503) break; }
  return out;
}
/** Overwrites a stored object with wrong-size bytes under the right metadata (F58). */
export async function corruptObject(w: FakeWorld, uri: string): Promise<void> {
  w.objects.set(uri, await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer());
}
/** A matte with a box of opaque pixels `inset` px inside the frame (the rest transparent), as a PNG. */
export async function boxMattePng(width: number, height: number, inset: number): Promise<Buffer> {
  const alpha = Buffer.alloc(width * height, 0);
  for (let y = inset; y < height - inset; y++) alpha.fill(255, y * width + inset, y * width + width - inset);
  return sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/**
 * A second batch of the same products and photo bytes (pinned like the first), its matte chunk queued: what a brand
 * re-sending a product looks like.
 */
export async function seedSecondBatch(db: Db, w: FakeWorld, first: { batch: typeof catalogBatches.$inferSelect }, name: string) {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: first.batch.brandSlug, brandName: first.batch.brandName, name, isTest: true, createdBy: "t@opptra.com", status: "matting", productType: first.batch.productType, channels: first.batch.channels, startedAt: new Date(), options: first.batch.options, counts: first.batch.counts ?? EMPTY_BATCH_COUNTS }).returning();
  const photos = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, first.batch.id)).orderBy(catalogSourceImages.n);
  const productIds = [...new Set(photos.map((p) => p.productId))];
  for (const productId of productIds) {
    await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId, change: "updated" });
    await db.update(catalogProducts).set({ lockBatchId: batch!.id }).where(eq(catalogProducts.id, productId));
  }
  for (const photo of photos) {
    const rawUri = await w.deps.storage.uploadBuffer(photo.rawUri.replace(first.batch.id, batch!.id).replace(/^gs:\/\/assets\//, ""), w.objects.get(photo.rawUri)!, "image/jpeg");
    await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: photo.productId, n: photo.n, sha256: photo.sha256, originalName: photo.originalName, rawUri, mime: photo.mime, width: photo.width, height: photo.height });
  }
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "matte", status: "queued", attempt: 0, productIds }).returning();
  return { batch: batch!, chunks: [chunk!] };
}

/**
 * The operator's "Replace photo" as the web does it: the signed upload, the bytes, completeReplacement, then the new
 * one-photo matte chunk and any chunk the release unparked (direct ones) are sent.
 */
let replacements = 0;
/**
 * Each replacement is a different file: the same bytes uploaded twice for one shot of one batch hit the unique index
 * (product, n, sha256, batch) in completeReplacement, a known gap outside spec 18 (final check 2026-10-30).
 */
export async function replacePhoto(db: Db, w: FakeWorld, outputId: string, now: () => Date) {
  const k = replacements++;
  const bytes = await sharp({ create: { width: 640, height: 820, channels: 3, background: { r: 90 + (k % 120), g: 60 + (Math.floor(k / 120) % 120), b: 30 } } }).jpeg().toBuffer();
  const storage = { ...w.deps.storage, signedPutUrl: async () => "https://signed.test/put" } as unknown as Parameters<typeof startReplacement>[0]["storage"];
  const { uploadId } = await startReplacement({ db, storage, now }, { outputId, name: "new.jpg", size: bytes.length, mime: "image/jpeg" });
  const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, uploadId));
  await w.deps.storage.uploadBuffer(upload!.gcsUri!.replace(/^gs:\/\/assets\//, ""), bytes, "image/jpeg");
  const result = await completeReplacement({ db, storage, now }, { outputId, uploadId, actor: "op@opptra.com" });
  await enqueueChunk(w.deps.enqueue, { id: result.chunkId, stage: "matte", step: 0 });
  for (const chunk of result.unparked ?? []) if (chunk.direct) await tryEnqueueChunk(w.deps.enqueue, chunk, w.deps.log);
  return result;
}

/** A world whose photos are `width x height` with a centred opaque box of `box` px (the product), for the route tests. */
export function bigPhotos(e: EnlargeWorld, width: number, height: number, box: { w: number; h: number }) {
  e.w.deps.prepare = vi.fn(async () => ({ width, height, rgb: Buffer.alloc(width * height * 3, 128), alphaSource: null, background: { uniform: true, color: [255, 255, 255] as [number, number, number], stdev: 0 }, flags: [], sourceMime: "image/jpeg" })) as unknown as typeof e.w.deps.prepare;
  e.w.deps.matteFor = vi.fn(async () => {
    const alpha = Buffer.alloc(width * height, 0), x0 = Math.floor((width - box.w) / 2), y0 = Math.floor((height - box.h) / 2);
    for (let y = y0; y < y0 + box.h; y++) alpha.fill(255, y * width + x0, y * width + x0 + box.w);
    return { alpha, width, height, model: "fixture", ms: 12, source: "model" as const, target: "cpu" as const, sentLongSide: 800 };
  }) as unknown as typeof e.w.deps.matteFor;
}
