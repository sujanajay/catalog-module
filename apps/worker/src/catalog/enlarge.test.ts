// Tier 2 (PGlite + fakes): spec 18 H3, the durable enlargement stage. The matte stage queues one enlarge task per photo
// the render may enlarge past the threshold and parks the chunk; each task makes and stores the photo's x2 image once
// (or fails it after the attempts), and the last one settles the gate, which queues the render. The service is a fake.
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogChunks, catalogCostEvents, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { batchPrefix, enlargedPath } from "@catalog/core/catalog/naming";
import type { Prepared } from "@catalog/core/catalog/render";
import { sourceX2, storedUpscaler, upscalerId } from "@catalog/core/catalog/upscale";
import { classifyOutputs } from "@catalog/core/catalog/load/classify";
import { ENLARGEMENT_FAILED_SENTENCE } from "@catalog/core/catalog/types";
import { DEFAULT_UPSCALE_TIMEOUT_S, ENLARGE_CLIENT_MARGIN_MS, ENLARGE_TASK_MARGIN_MS, EnlargeBadInputError, EnlargeBusyError } from "@catalog/core/catalog/enlarge";
import { ENLARGE_STALE_MS, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK } from "@catalog/core/catalog/pipeline/enlargement";
import { resendStaleEnlargements } from "@catalog/core/catalog/pipeline/dispatch";
import { DISPATCH_DEADLINE_SEC, enlargeTaskId } from "@catalog/core/tasks";
import { currentChunkTask, deliverChunkToEnd, handleChunkTask } from "./chunk";
import { handleEnlargeTask, type EnlargeCall, primeStoredEnlargement, workerEnlargeCall } from "./enlarge";
import { chunkRow, fakeWorld, seedBatch, type FakeWorld } from "../../test/catalog-fakes";

let db: Db, close: () => Promise<void>;
const bucketEnv = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const [key, value] of Object.entries(bucketEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await close(); });

const ID = upscalerId("swinir-x2", "cpu");
/** A fake upscale service: a JPEG of `factor` times the uploaded image, or the next queued failure. */
function fakeService(factor = 2) {
  const failures: Error[] = [];
  const call = vi.fn<EnlargeCall>(async (jpeg) => {
    const next = failures.shift();
    if (next) throw next;
    const meta = await sharp(jpeg).metadata();
    return { jpeg: await sharp({ create: { width: meta.width! * factor, height: meta.height! * factor, channels: 3, background: { r: 0, g: 200, b: 0 } } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer(), ms: 90_000, model: "swinir-x2", attempts: 1 };
  });
  return { call, failures };
}
/** A world whose render enlarges: Trendyol (1200 x 1800, fixed) takes the fake 600 x 800-ish photos past 1.5x. */
function enlargingWorld(factor = 2) {
  const w = fakeWorld(db, 1, { imageScale: 0.5 }), service = fakeService(factor);
  w.deps.upscaler = storedUpscaler(ID, 1.5);
  w.deps.enlarge = service.call;
  return { w, service };
}
const photosOf = (batchId: string) => db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId)).orderBy(catalogSourceImages.n);
const enlargeTasks = (w: FakeWorld) => w.tasks.filter((t) => t.route === "/tasks/catalog/enlarge");
const chunkTasks = (w: FakeWorld, chunkId: string) => w.tasks.filter((t) => t.route === "/tasks/catalog/chunk" && t.body.chunkId === chunkId);
async function matteStage(w: FakeWorld, name: string, channels: ("trendyol" | "noon")[] = ["trendyol"], shots = 2) {
  const s = await seedBatch(db, w, name, [[shots]], { channels });
  expect((await handleChunkTask(w.deps, await currentChunkTask(db, s.chunks[0]!.id))).httpStatus).toBe(200);
  return s;
}
const pathKeyOf = async (productId: string) => (await db.select().from(catalogProducts).where(eq(catalogProducts.id, productId)))[0]!.pathKey;
const bodyOf = (w: FakeWorld, sourceImageId: string) => enlargeTasks(w).find((t) => t.body.sourceImageId === sourceImageId)!.body;

describe("spec 18 H3: the matte stage queues enlargements and parks the chunk", () => {
  it("queues one task per photo that needs it (round 0, the operator lane) and parks the chunk with no task and no slot", async () => {
    const { w } = enlargingWorld();
    const s = await matteStage(w, "h3-park");
    const photos = await photosOf(s.batch.id);
    expect(photos.map((p) => p.x2Model)).toEqual([ID, ID]);
    expect(enlargeTasks(w).map((t) => [t.taskId, t.bulk, t.body])).toEqual(photos.map((p) => [enlargeTaskId(p.id, 0), false, { batchId: s.batch.id, productId: p.productId, sourceImageId: p.id, round: 0 }]));
    const chunk = await chunkRow(db, s.chunks[0]!.id);
    expect(chunk).toMatchObject({ stage: "render", status: "queued", taskName: ENLARGING_TASK, dispatchedAt: null });
    expect(chunkTasks(w, chunk.id).filter((t) => t.body.stage === "render")).toEqual([]);
    expect(w.deliveries().at(-1)).toMatchObject({ outcome: "enlarging" });
    // A copy of a chunk task meets the parked chunk: it never claims it.
    expect((await handleChunkTask(w.deps, { chunkId: chunk.id, stage: "render", step: chunk.step })).outcome).toBe("duplicate");
    expect((await chunkRow(db, chunk.id)).taskName).toBe(ENLARGING_TASK);
  }, 60_000);

  it("a photo no channel enlarges past the threshold and the upscaler off queue nothing and advance as before", async () => {
    // 1800 x 2400 photos: Trendyol's 1200 x 1800 needs no enlargement.
    const w = fakeWorld(db, 1, { imageScale: 3 });
    w.deps.upscaler = storedUpscaler(ID, 1.5); w.deps.enlarge = fakeService().call;
    const s = await matteStage(w, "h3-large");
    expect(enlargeTasks(w)).toEqual([]);
    expect((await photosOf(s.batch.id)).map((p) => p.x2Model)).toEqual([null, null]);
    expect(await chunkRow(db, s.chunks[0]!.id)).toMatchObject({ stage: "render", taskName: null });
    const off = fakeWorld(db, 1, { imageScale: 0.5 });
    const t = await matteStage(off, "h3-off");
    expect(enlargeTasks(off)).toEqual([]);
    expect(await chunkRow(db, t.chunks[0]!.id)).toMatchObject({ stage: "render", taskName: null });
  }, 60_000);
});

describe("spec 18 H3: the enlarge task", () => {
  it("stores the x2 image privately with its source and upscaler, writes the cost row, and the last photo queues the render", async () => {
    const { w, service } = enlargingWorld();
    const s = await matteStage(w, "h3-done");
    const [one, two] = await photosOf(s.batch.id);
    expect(await handleEnlargeTask(w.deps, bodyOf(w, one!.id))).toMatchObject({ httpStatus: 200, outcome: "done" });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBe(ENLARGING_TASK);
    expect(await handleEnlargeTask(w.deps, bodyOf(w, two!.id))).toMatchObject({ httpStatus: 200, outcome: "done" });
    expect(service.call).toHaveBeenCalledTimes(2);
    // The call gets the delivery's own deadline: its start plus the dispatch deadline, less the client margin.
    const left = service.call.mock.calls[0]![2]!.deadlineAt! - Date.now(), budget = DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS;
    expect(left).toBeLessThanOrEqual(budget);
    expect(left).toBeGreaterThan(budget - 60_000);
    const photos = await photosOf(s.batch.id);
    for (const p of photos) {
      const path = enlargedPath(batchPrefix("test_brand", s.batch.id, true), await pathKeyOf(p.productId), p.n);
      expect(p).toMatchObject({ x2Uri: `gs://assets/${path}`, x2Model: ID, x2Error: null });
      expect(path).toMatch(/^catalog-test\/test_brand\/.+\/derived\/.+\.x2\.jpg$/);
      expect(w.metadata.get(p.x2Uri!)).toEqual({ sourceSha256: p.sha256, upscaler: ID });
      const meta = await sharp(w.objects.get(p.x2Uri!)!).metadata();
      expect(meta.width).toBeGreaterThan(0);
    }
    const ledger = await db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.batchId, s.batch.id), eq(catalogCostEvents.kind, "upscale_call")));
    expect(ledger.map((r) => [r.stage, r.engine, r.ms, r.outcome])).toEqual([["upscale", "cpu", 90_000, "ok"], ["upscale", "cpu", 90_000, "ok"]]);
    const chunk = await chunkRow(db, s.chunks[0]!.id);
    expect(chunk).toMatchObject({ stage: "render", taskName: null });
    expect(chunk.dispatchedAt).not.toBeNull();
    expect(chunkTasks(w, chunk.id).at(-1)!.body).toMatchObject({ stage: "render", step: chunk.step });
    const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
    expect(batch!.counts).toMatchObject({ enlargeTotal: 2, enlargeDone: 2, enlargeFailed: 0 });
    // A duplicate delivery: nothing is called or written again.
    expect(await handleEnlargeTask(w.deps, bodyOf(w, one!.id))).toMatchObject({ httpStatus: 200, outcome: "settled" });
    expect(service.call).toHaveBeenCalledTimes(2);
    // The render stage primes the stored images: the x2 objects are read, no service is called.
    const reads = vi.spyOn(w.deps.storage, "downloadBuffer");
    expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunk.id))).httpStatus).toBe(200);
    expect(reads.mock.calls.map(([uri]) => uri)).toEqual(expect.arrayContaining(photos.map((p) => p.x2Uri)));
    expect(service.call).toHaveBeenCalledTimes(2);
    // A stored image made from other bytes counts as missing: nothing is primed (the render holds what needs it).
    expect(await primeStoredEnlargement(w.deps, { id: photos[0]!.id, sha256: "other", x2Uri: photos[0]!.x2Uri }, {} as Prepared)).toBe(false);
  }, 60_000);

  it("a stored image already there (a lost answer) is reused without a call; one from another upscaler is made again", async () => {
    const { w, service } = enlargingWorld();
    const s = await matteStage(w, "h3-head", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    const uri = `gs://assets/${enlargedPath(batchPrefix("test_brand", s.batch.id, true), await pathKeyOf(photo!.productId), photo!.n)}`;
    w.objects.set(uri, Buffer.from("old")); w.metadata.set(uri, { sourceSha256: photo!.sha256, upscaler: "realesrgan-x2plus" });
    expect(await handleEnlargeTask(w.deps, bodyOf(w, photo!.id))).toMatchObject({ outcome: "done" });
    expect(service.call).toHaveBeenCalledTimes(1);
    const t = await matteStage(w, "h3-head-reuse", ["trendyol"], 1);
    const [again] = await photosOf(t.batch.id);
    const uri2 = `gs://assets/${enlargedPath(batchPrefix("test_brand", t.batch.id, true), await pathKeyOf(again!.productId), again!.n)}`;
    w.objects.set(uri2, Buffer.from("kept")); w.metadata.set(uri2, { sourceSha256: again!.sha256, upscaler: ID });
    expect(await handleEnlargeTask(w.deps, bodyOf(w, again!.id))).toMatchObject({ outcome: "done" });
    expect(service.call).toHaveBeenCalledTimes(1);
    expect((await photosOf(t.batch.id))[0]!.x2Uri).toBe(uri2);
  }, 60_000);

  it("a busy service is retried by the queue (503, one attempt counted), then the next attempt stores the image", async () => {
    const { w, service } = enlargingWorld();
    const s = await matteStage(w, "h3-retry", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    service.failures.push(new EnlargeBusyError(503, 1));
    expect(await handleEnlargeTask(w.deps, bodyOf(w, photo!.id), { retryCount: 0 })).toMatchObject({ httpStatus: 503, outcome: "retry" });
    expect((await photosOf(s.batch.id))[0]).toMatchObject({ x2Uri: null, x2Attempts: 1, x2Error: "The enlargement service is busy (503)." });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBe(ENLARGING_TASK);
    expect(w.log).toHaveBeenCalledWith("enlargement retry", expect.objectContaining({ severity: "WARNING", attempts: 1 }));
    expect(await handleEnlargeTask(w.deps, bodyOf(w, photo!.id), { retryCount: 1 })).toMatchObject({ httpStatus: 200, outcome: "done" });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBeNull();
  }, 60_000);

  it("eight failed attempts fail the photo for good: ERROR \"enlargement failed\", 200, and the gate settles", async () => {
    const { w, service } = enlargingWorld();
    const s = await matteStage(w, "h3-fail", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    for (let i = 0; i < ENLARGE_TASK_MAX_ATTEMPTS; i++) service.failures.push(new EnlargeBusyError(429, 1));
    const answers = [];
    for (let retryCount = 0; retryCount < ENLARGE_TASK_MAX_ATTEMPTS; retryCount++) answers.push((await handleEnlargeTask(w.deps, bodyOf(w, photo!.id), { retryCount })).httpStatus);
    expect(answers).toEqual([...Array(ENLARGE_TASK_MAX_ATTEMPTS - 1).fill(503), 200]);
    expect((await photosOf(s.batch.id))[0]).toMatchObject({ x2Uri: null, x2Attempts: ENLARGE_TASK_MAX_ATTEMPTS, x2Model: ID });
    const errors = w.log.mock.calls.filter(([m, f]) => m === "enlargement failed" && f?.severity === "ERROR");
    expect(errors).toHaveLength(1);
    expect(await chunkRow(db, s.chunks[0]!.id)).toMatchObject({ taskName: null, stage: "render" });
    const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, s.batch.id));
    expect(batch!.counts).toMatchObject({ enlargeTotal: 1, enlargeDone: 0, enlargeFailed: 1 });
    // The failed calls cost service time: each wrote a failed ledger row.
    const ledger = await db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.batchId, s.batch.id), eq(catalogCostEvents.kind, "upscale_call")));
    expect(ledger.every((r) => r.outcome === "failed")).toBe(true);
  }, 60_000);

  it("only deliveries that reached the handler count: a high X-CloudTasks-TaskRetryCount (429s before the app) never fails a photo early", async () => {
    const { w, service } = enlargingWorld();
    const s = await matteStage(w, "h3-header", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    for (let i = 0; i < ENLARGE_TASK_MAX_ATTEMPTS; i++) service.failures.push(new EnlargeBusyError(503, 1));
    // The queue's last attempt by its own count, but the first that reached this handler: 503, one attempt counted.
    expect(await handleEnlargeTask(w.deps, bodyOf(w, photo!.id), { retryCount: ENLARGE_TASK_MAX_ATTEMPTS - 1 })).toMatchObject({ httpStatus: 503, outcome: "retry" });
    expect((await photosOf(s.batch.id))[0]).toMatchObject({ x2Attempts: 1, x2Uri: null });
    // The queue gave up on that task: the photo stays queued and the parked chunk stays parked for its recovery,
    // which sends the next round with the attempts kept (below, eight real attempts in all before the failure).
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBe(ENLARGING_TASK);
    const answers: number[] = [];
    for (let round = 1; round < ENLARGE_TASK_MAX_ATTEMPTS; round++) answers.push((await handleEnlargeTask(w.deps, { ...bodyOf(w, photo!.id), round }, { retryCount: 50 + round })).httpStatus);
    expect(answers).toEqual([...Array(ENLARGE_TASK_MAX_ATTEMPTS - 2).fill(503), 200]);
    expect(service.call).toHaveBeenCalledTimes(ENLARGE_TASK_MAX_ATTEMPTS);
    expect((await photosOf(s.batch.id))[0]!.x2Attempts).toBe(ENLARGE_TASK_MAX_ATTEMPTS);
  }, 60_000);

  it("on the default env (no UPSCALE_TIMEOUT_S) the worker's call reaches the service once, its timeout clamped below the delivery's deadline", async () => {
    const { w } = enlargingWorld();
    const s = await matteStage(w, "h3-default-env", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    // The real client of the worker (workerEnlargeCall) with an env that names only the service, against a fake fetch.
    const seen: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      const meta = await sharp(Buffer.from(init!.body as Uint8Array)).metadata();
      const jpeg = await sharp({ create: { width: meta.width! * 2, height: meta.height! * 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
      return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg", "x-upscale-ms": "5000" } });
    }) as unknown as typeof globalThis.fetch;
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      // The delivery started 5 s before the call (reads, download, prepare): the old guard then made no call at all.
      const started = Date.now() - 5_000;
      let first = true;
      w.deps.now = () => { if (first) { first = false; return new Date(started); } return new Date(); };
      w.deps.enlarge = workerEnlargeCall("swinir-x2", { UPSCALE_URL: "http://localhost:8099" }, { fetch, idToken: async () => "t" });
      expect(await handleEnlargeTask(w.deps, bodyOf(w, photo!.id))).toMatchObject({ httpStatus: 200, outcome: "done" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(seen[0]).toBe("http://localhost:8099/upscale?model=swinir-x2&scale=2");
      const timeoutMs = timeouts.mock.calls.map(([ms]) => ms).at(-1)!;
      expect(timeoutMs).toBeLessThan(DEFAULT_UPSCALE_TIMEOUT_S * 1000 + ENLARGE_CLIENT_MARGIN_MS);
      expect(Date.now() + timeoutMs).toBeLessThanOrEqual(started + DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS + 1_000);
    } finally { timeouts.mockRestore(); }
    expect((await photosOf(s.batch.id))[0]!.x2Uri).not.toBeNull();
  }, 60_000);

  it("lane-aware recovery: a delivery for one product refreshes every parked chunk of the batch, so paced tasks are not sent twice", async () => {
    const { w } = enlargingWorld();
    const s = await seedBatch(db, w, "h3-lane", [[1], [1], [1]], { channels: ["trendyol"] });
    for (const chunk of s.chunks) expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunk.id))).httpStatus).toBe(200);
    for (const chunk of s.chunks) expect((await chunkRow(db, chunk.id)).taskName).toBe(ENLARGING_TASK);
    const old = new Date(Date.now() - ENLARGE_STALE_MS + 60_000);
    await db.update(catalogChunks).set({ progressAt: old }).where(eq(catalogChunks.batchId, s.batch.id));
    // Product A's task reaches the worker; the tasks of B and C still wait in the paced lane.
    const a = s.chunks[0]!.productIds[0]!, photoA = (await photosOf(s.batch.id)).find((p) => p.productId === a)!;
    const before = Date.now();
    expect(await handleEnlargeTask(w.deps, bodyOf(w, photoA.id))).toMatchObject({ outcome: "done" });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBeNull();
    for (const chunk of s.chunks.slice(1)) {
      const row = await chunkRow(db, chunk.id);
      expect(row.taskName).toBe(ENLARGING_TASK);
      expect(+row.progressAt!).toBeGreaterThanOrEqual(before);
    }
    // Two minutes later (past where the old progress would have been stale): nothing is sent again.
    const sent = enlargeTasks(w).length;
    expect(await resendStaleEnlargements(db, w.deps.enqueue, s.batch.id, { now: new Date(Date.now() + 2 * 60_000) })).toBe(0);
    // Once the batch's lane was quiet for ENLARGE_STALE_MS, the two waiting photos are sent as the next round.
    expect(await resendStaleEnlargements(db, w.deps.enqueue, s.batch.id, { now: new Date(Date.now() + ENLARGE_STALE_MS + 60_000) })).toBe(2);
    expect(enlargeTasks(w).length).toBe(sent + 2);
  }, 60_000);

  it("failures no retry fixes fail at once: a refused image, a photo above UPSCALE_MAX_PIXELS (no call), a wrong-size answer", async () => {
    const bad = enlargingWorld();
    const a = await matteStage(bad.w, "h3-bad", ["trendyol"], 1);
    bad.service.failures.push(new EnlargeBadInputError(400, 1));
    expect(await handleEnlargeTask(bad.w.deps, bodyOf(bad.w, (await photosOf(a.batch.id))[0]!.id))).toMatchObject({ httpStatus: 200, outcome: "failed" });
    const big = enlargingWorld();
    const b = await matteStage(big.w, "h3-big", ["trendyol"], 1);
    vi.stubEnv("UPSCALE_MAX_PIXELS", "1000");
    try { expect(await handleEnlargeTask(big.w.deps, bodyOf(big.w, (await photosOf(b.batch.id))[0]!.id))).toMatchObject({ httpStatus: 200, outcome: "failed" }); }
    finally { vi.unstubAllEnvs(); }
    expect(big.service.call).not.toHaveBeenCalled();
    expect((await photosOf(b.batch.id))[0]!.x2Error).toMatch(/above the 1000 the upscale service takes/);
    const odd = enlargingWorld(3);
    const c = await matteStage(odd.w, "h3-odd", ["trendyol"], 1);
    expect(await handleEnlargeTask(odd.w.deps, bodyOf(odd.w, (await photosOf(c.batch.id))[0]!.id))).toMatchObject({ httpStatus: 200, outcome: "failed" });
    expect((await photosOf(c.batch.id))[0]).toMatchObject({ x2Uri: null, x2Attempts: ENLARGE_TASK_MAX_ATTEMPTS });
    for (const s of [a, b, c]) expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBeNull();
  }, 60_000);

  it("two deliveries of the same photo at once settle the gate once", async () => {
    const { w } = enlargingWorld();
    const s = await matteStage(w, "h3-race", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    const results = await Promise.all([handleEnlargeTask(w.deps, bodyOf(w, photo!.id)), handleEnlargeTask(w.deps, { ...bodyOf(w, photo!.id), round: 1 })]);
    expect(results.map((r) => r.httpStatus)).toEqual([200, 200]);
    expect(w.log.mock.calls.filter(([m]) => m === "chunk enlarged")).toHaveLength(1);
    expect(chunkTasks(w, s.chunks[0]!.id).filter((t) => t.body.stage === "render")).toHaveLength(1);
  }, 60_000);

  it("with the upscaler switched off, a queued photo is settled as not needed and the chunk goes on with the plain path", async () => {
    const { w } = enlargingWorld();
    const s = await matteStage(w, "h3-switched-off", ["trendyol"], 1);
    const [photo] = await photosOf(s.batch.id);
    w.deps.upscaler = null; delete w.deps.enlarge;
    expect(await handleEnlargeTask(w.deps, bodyOf(w, photo!.id))).toMatchObject({ httpStatus: 200, outcome: "off" });
    expect((await photosOf(s.batch.id))[0]).toMatchObject({ x2Model: null, x2Uri: null });
    expect((await chunkRow(db, s.chunks[0]!.id)).taskName).toBeNull();
  }, 60_000);

  it("in process (evals, real runs): deliverChunkToEnd runs the parked chunk's enlarge tasks and finishes the chunk", async () => {
    const { w, service } = enlargingWorld();
    const s = await seedBatch(db, w, "h3-in-process", [[2]], { channels: ["trendyol"] });
    await deliverChunkToEnd(w.deps, s.chunks[0]!.id, async (deliver) => { await deliver(); });
    expect(service.call).toHaveBeenCalledTimes(2);
    expect((await chunkRow(db, s.chunks[0]!.id)).status).toBe("done");
    expect((await photosOf(s.batch.id)).every((p) => p.x2Uri)).toBe(true);
    expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id, s.chunks[0]!.id)))[0]!.taskName).toBeNull();
  }, 60_000);
});

describe("spec 18 section 7: a batch through the queue with one forced terminal failure", () => {
  it("every enlargement settles before its render, each parked chunk's render is queued once, the failed product is held with enlargement_failed and nothing is silent", async () => {
    const { w } = enlargingWorld();
    const s = await seedBatch(db, w, "h3-section-7", [[2, 1], [2]], { channels: ["trendyol"] });
    const failing = s.chunks[0]!.productIds[1]!;
    // The service fails every call for one product (busy, so each photo goes through all its attempts).
    const ok = w.deps.enlarge!;
    w.deps.enlarge = vi.fn<EnlargeCall>(async (jpeg, trace) => { if (trace.productId === failing) throw new EnlargeBusyError(503, 1); return ok(jpeg, trace); });
    // The fake render stands in for renderSource's decision: the photo's primed x2 image, or the hold.
    const base = w.deps.renderAllChannels;
    w.deps.renderAllChannels = async (p, m, channels, ctx) => {
      const out = await base(p, m, channels, ctx), x2 = await sourceX2(w.deps.upscaler!, p.rgb, p.width).result;
      for (const ch of channels) { out[ch]!.flags = [...out[ch]!.flags, x2 ? "upscaled" : "enlargement_failed"]; if (!x2) out[ch]!.notes = [ENLARGEMENT_FAILED_SENTENCE]; }
      return out;
    };
    const renderedEarly: string[] = [];
    const deliverChunk = async (body: Record<string, unknown>) => {
      if (body.stage === "render") {
        const chunk = await chunkRow(db, body.chunkId as string);
        const waiting = (await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, s.batch.id))).filter((x) => chunk.productIds.includes(x.productId) && x.x2Model && !x.x2Uri && x.x2Attempts < ENLARGE_TASK_MAX_ATTEMPTS);
        if (waiting.length) renderedEarly.push(chunk.id);
      }
      return handleChunkTask(w.deps, body);
    };
    // Start: the window takes both chunks; then drain the queue in order, a 503 goes to the back with its retry count.
    const { dispatchChunks } = await import("@catalog/core/catalog/pipeline/dispatch");
    await dispatchChunks(db, w.deps.enqueue, s.batch.id, { window: 2 });
    for (let i = 0, guard = 0; i < w.tasks.length && guard < 400; i++, guard++) {
      const task = w.tasks[i]!;
      if (task.route === "/tasks/catalog/chunk") await deliverChunk(task.body);
      else if (task.route === "/tasks/catalog/enlarge") {
        const r = await handleEnlargeTask(w.deps, task.body, { retryCount: task.retryCount });
        if (r.httpStatus === 503) w.tasks.push({ ...task, retryCount: task.retryCount + 1 });
      }
    }
    expect(renderedEarly).toEqual([]);
    for (const chunk of s.chunks) {
      expect((await chunkRow(db, chunk.id)).status).toBe("done");
      expect(w.tasks.filter((t) => t.route === "/tasks/catalog/chunk" && t.body.chunkId === chunk.id && t.body.stage === "render")).toHaveLength(1);
    }
    const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
    const held = outputs.filter((o) => o.productId === failing), made = outputs.filter((o) => o.productId !== failing);
    expect(held.map((o) => [o.status, o.flags.includes("enlargement_failed"), (o.reason ?? "").includes("could not be enlarged")])).toEqual([["needs_attention", true, true]]);
    expect(made.every((o) => o.status === "staged" && o.flags.includes("upscaled"))).toBe(true);
    expect(w.log.mock.calls.filter(([m, f]) => m === "enlargement failed" && f?.severity === "ERROR")).toHaveLength(1);
    const c = classifyOutputs(outputs.map((o) => ({ ...o, status: o.status === "staged" ? "verified" : o.status })), new Set([failing]));
    expect(c.silent).toEqual([]);
  }, 120_000);
});
