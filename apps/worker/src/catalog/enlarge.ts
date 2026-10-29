// Spec 18 H3: POST /tasks/catalog/enlarge, one photo's enlargement as its own task (body EnlargeTaskBody, task id
// enlarge-<sourceImageId>-<round>), queued by the matte stage (chunk.ts) on the enlarge lane of the batch's class.
// It makes the photo's x2 image once on the upscale service (enlargeViaService, catalog-upscale or the service
// UPSCALE_URL names) and stores it in the private bucket at enlargedPath (never public); the render primes it and
// never calls the service. States and the render gate: core catalog/pipeline/enlargement.ts.
// - The stored image is already there (same source and upscaler in its metadata): done, no call.
// - Another live delivery of the photo holds its in-flight claim (x2_claimed_at, ENLARGE_CLAIM_MS): 503, no attempt
//   counted, no call; the retry finds the stored image or the claim gone. The success write is guarded on x2_uri still
//   null, so a late second writer neither overwrites the photo nor writes a second cost row.
// - The configured upscaler (UPSCALE_MODEL) makes and names the image, also for a photo queued under another one.
// - A retryable failure (busy, timeout, a server error, a storage or decode hiccup) counts an attempt, records the
//   reason and answers 503, so Cloud Tasks retries with the lane's back-off.
// - The last attempt (ENLARGE_TASK_MAX_ATTEMPTS, counted in x2_attempts: only deliveries that reached this handler)
//   or a failure no retry can fix (a photo above UPSCALE_MAX_PIXELS, a refused image, a wrong-size answer) writes the
//   failure, logs ERROR "enlargement failed" and answers 200: the render then holds the photo's enlarged outputs with
//   `enlargement_failed`. A plain resize never stands in. X-CloudTasks-TaskRetryCount is not used: it also counts 429s
//   answered before the app ran (spec 17 G4), so a task the queue gives up on is left to the parked chunk's recovery,
//   which sends it again as the next round with x2_attempts kept (resendStaleEnlargements).
// Every write of the photo's state locks the chunks holding the product first and unparks the chunk whose last queued
// photo it settled, in the same transaction; the batch's window is topped up after it.
import sharp from "sharp";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { batchPrefix, enlargedPath } from "@catalog/core/catalog/naming";
import { enlargementNeeds, UnsupportedSourceError, type EnlargementShot, type Prepared } from "@catalog/core/catalog/render";
import { gpuUrlsFromEnv, isCpuUpscalerId, primeSourceX2, UPSCALE_FACTOR, upscaleUpload, type Upscaler } from "@catalog/core/catalog/upscale";
import { ENLARGE_TASK_MARGIN_MS, EnlargeError, enlargeTimeoutMs, enlargeViaService, type EnlargeDeps, type EnlargeResult } from "@catalog/core/catalog/enlarge";
import { ENLARGE_DISPATCH_DEADLINE_SEC } from "@catalog/core/tasks";
import { ENLARGE_CLAIM_MS, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, enqueueEnlargements, lockProductChunks, photoEnlargementState, unparkSettledChunks } from "@catalog/core/catalog/pipeline/enlargement";
import { positiveIntEnv } from "@catalog/core/concurrency";
import { recordCostEvents, type CostEventInput } from "@catalog/core/cost-events";
import { matteCallUsd } from "@catalog/core/catalog/cost";
import type { MattingTrace } from "@catalog/core/catalog/matte";
import type { HandleOptions, HandleResult } from "../server";
import { refreshBatchProgress, topUpWindow, type CatalogDeps } from "./deps";

/**
 * The service call the handler makes: one attempt, the x2 JPEG as the service answered it. `deadlineAt` (epoch ms) is
 * the delivery's own deadline: the delivery's start plus ENLARGE_DISPATCH_DEADLINE_SEC (its Cloud Tasks dispatch deadline),
 * less ENLARGE_TASK_MARGIN_MS for the settle; the attempt's timeout is clamped to it.
 */
export type EnlargeCall = (jpeg: Buffer, trace: MattingTrace, opts?: { deadlineAt?: number }) => Promise<EnlargeResult>;

/**
 * The largest photo (width x height) the upscale service takes (`UPSCALE_MAX_PIXELS`; infra/deploy.sh sets it for
 * catalog-upscale from infra/lib/shape.sh, sized so the largest photo fits the service timeout; unset, the service's
 * own default 24,000,000).
 */
const DEFAULT_UPSCALE_MAX_PIXELS = 24_000_000;
function upscaleMaxPixels(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.UPSCALE_MAX_PIXELS?.trim(), DEFAULT_UPSCALE_MAX_PIXELS);
}

/**
 * The worker's service call: the service UPSCALE_URL names (catalog-upscale, or the CPU cut-out service), else the
 * first GPU matting service, as the matting client picks it. One attempt per task delivery: the queue retries. The
 * attempt waits UPSCALE_TIMEOUT_S + 30 s (1740 s + 30 s when unset), clamped to the delivery's deadline. `deps` is for
 * tests (a fake fetch and token).
 */
export function workerEnlargeCall(model: string, env: NodeJS.ProcessEnv = process.env, deps: EnlargeDeps = {}): EnlargeCall {
  const url = env.UPSCALE_URL?.trim() || gpuUrlsFromEnv(env)[0] || "";
  return (jpeg, trace, opts = {}) => {
    if (!url) throw new EnlargeError("No upscale service is configured (UPSCALE_URL).", "rejected", null, false, 0);
    return enlargeViaService({ url, jpeg, model, timeoutMs: enlargeTimeoutMs(env), maxAttempts: 1, trace, ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}) }, deps);
  };
}

/**
 * Where a photo's derived files live: its batch prefix, or for an operator replacement (its raw copy sits under
 * <batch>/replacements-<upload>/) its own prefix, so a replaced shot never serves its matte or x2 image (chunk.ts).
 */
export function derivedPrefixFor(storage: CatalogDeps["storage"], prefix: string, source: { id: string; replacesId: string | null; rawUri: string }): string {
  const replacementRoot = storage.toGsUri(storage.getBucketName(), `${prefix}/replacements-`);
  return source.replacesId && source.rawUri.startsWith(replacementRoot) ? `${prefix}/replacements-${source.id}` : prefix;
}

/** Metadata on the stored x2 image: the photo it was made from and the upscaler that made it. */
export const X2_METADATA = { sourceSha256: "sourceSha256", upscaler: "upscaler" } as const;

/**
 * Spec 18 3.3.5, the render side: primes the upscaler's cache with the photo's stored x2 image, so every render of
 * this prepared photo (channels, auto-resolve) uses it without a service call. Without a stored image, or with one
 * that was made from other bytes (its `sourceSha256`), by another upscaler than the configured one (`x2_model` or the
 * object's `upscaler`), or is not exactly 2x the photo, nothing is primed and the render holds what needs it
 * (`enlargement_failed`). The render stage re-queues an image of another upscaler before it gets here
 * (requeueOtherUpscaler), so that case only arises when UPSCALE_MODEL changes during the render itself.
 */
export async function primeStoredEnlargement(deps: Pick<CatalogDeps, "upscaler" | "storage" | "log">, source: { id: string; sha256: string; x2Uri: string | null; x2Model: string | null }, p: Prepared): Promise<boolean> {
  if (!deps.upscaler || !source.x2Uri) return false;
  try {
    if (source.x2Model !== deps.upscaler.model) {
      deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, reason: "stored image was made by another upscaler" });
      return false;
    }
    const head = await deps.storage.headObject(source.x2Uri);
    if (head.metadata?.[X2_METADATA.sourceSha256] !== source.sha256 || head.metadata?.[X2_METADATA.upscaler] !== deps.upscaler.model) {
      deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, reason: !head.exists ? "stored image not found" : head.metadata?.[X2_METADATA.sourceSha256] !== source.sha256 ? "stored image was made from other bytes" : "stored image was made by another upscaler" });
      return false;
    }
    const primed = await primeSourceX2(deps.upscaler, p.rgb, p.width, (await deps.storage.downloadBuffer(source.x2Uri)).buf);
    if (!primed) deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, reason: "stored image is not 2x the photo" });
    return primed;
  } catch (error) {
    deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * A photo prepared from its raw copy, with its stored matte as alpha: what the render stage and the enlargement
 * decision both read for a shot cut out in an earlier delivery.
 */
export async function loadShotFromMatte(deps: Pick<CatalogDeps, "prepare" | "storage" | "matting">, source: { rawUri: string; originalName: string }, matteUri: string, trace: MattingTrace): Promise<{ p: Prepared; alpha: Buffer }> {
  const p = await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf, source.originalName, (b) => deps.matting.convert(b, trace));
  const alpha = await sharp((await deps.storage.downloadBuffer(matteUri)).buf).toColourspace("b-w").raw().toBuffer();
  return { p, alpha };
}

export interface QueueEnlargementsInput {
  upscaler: Upscaler;
  batch: Pick<typeof catalogBatches.$inferSelect, "id" | "channels">;
  product: Pick<typeof catalogProducts.$inferSelect, "id" | "productType">;
  /** The photos of the product this chunk holds. */
  sources: { id: string }[];
  /** The shots cut out in this delivery, by photo id (the others are loaded from their stored matte). */
  shots: Map<string, EnlargementShot>;
  matteModel: string;
  trace: MattingTrace;
  /** The chunk delivery's write under its claim. */
  write: <T>(fn: (db: CatalogDeps["db"]) => Promise<T>) => Promise<T>;
  bulk: boolean;
}

/**
 * Spec 18 3.3.4: once a product's photos are cut out, decides which need an x2 image (enlargementNeeds over every shot
 * of the product with a matte, as the render plans them) and queues their enlarge tasks (round 0, the batch's enlarge
 * lane). The photo is marked queued (x2_model) before its task is sent; a send that fails is left to the parked
 * chunk's recovery (ENLARGE_STALE_MS). A photo marked queued by an earlier delivery has its task sent again (the same
 * name, so Cloud Tasks keeps one).
 */
export async function queueEnlargements(deps: CatalogDeps, input: QueueEnlargementsInput): Promise<void> {
  const { upscaler, batch, product, sources, shots } = input;
  if (!sources.length) return;
  const rows = await deps.db.select().from(catalogSourceImages).where(inArray(catalogSourceImages.id, sources.map((s) => s.id)));
  const pending = new Set((await deps.db.select({ id: catalogOutputs.sourceImageId }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batch.id), eq(catalogOutputs.productId, product.id), eq(catalogOutputs.status, "pending")))).map((o) => o.id));
  const open = rows.filter((r) => pending.has(r.id) && r.matteUri && !r.x2Uri && !r.flags.includes("chart_image"));
  const send = open.filter((r) => photoEnlargementState(r) === "queued");
  const undecided = open.filter((r) => !r.x2Model);
  if (undecided.length) {
    // Every shot of the product with a matte takes part (fewer shots could only give a smaller canvas): this
    // delivery's in memory, the others from their stored matte (or the unchanged angle's earlier one).
    const all: { id: string; shot: EnlargementShot }[] = [];
    for (const row of rows) {
      const kept = shots.get(row.id);
      if (kept) { all.push({ id: row.id, shot: kept }); continue; }
      let matteUri = row.matteUri;
      if (!matteUri) { const [old] = await deps.db.select({ matteUri: catalogSourceImages.matteUri }).from(catalogSourceImages).where(and(eq(catalogSourceImages.productId, product.id), eq(catalogSourceImages.sha256, row.sha256), eq(catalogSourceImages.isCurrent, true))); matteUri = old?.matteUri ?? null; }
      if (!matteUri || row.flags.includes("chart_image")) continue;
      try {
        const { p, alpha } = await loadShotFromMatte(deps, row, matteUri, input.trace);
        all.push({ id: row.id, shot: { width: p.width, height: p.height, rgb: p.rgb, alpha, model: row.matteModel ?? input.matteModel } });
      } catch (error) { deps.log("catalog enlargement decision skipped a shot", { severity: "WARNING", batchId: batch.id, sourceImageId: row.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    const needs = enlargementNeeds(batch.channels, all.map((a) => a.shot), product.productType, upscaler.minScale);
    const needed = new Set(all.filter((_, i) => needs[i]).map((a) => a.id));
    const queue = undecided.filter((r) => needed.has(r.id));
    if (queue.length) await input.write(async (tx) => tx.update(catalogSourceImages).set({ x2Model: upscaler.model, x2Error: null }).where(and(inArray(catalogSourceImages.id, queue.map((r) => r.id)), isNull(catalogSourceImages.x2Model))));
    send.push(...queue);
  }
  await enqueueEnlargements(deps.enqueue, batch.id, send.map((r) => ({ id: r.id, productId: product.id })), 0, { log: deps.log, ...(input.bulk ? { bulk: true } : {}) });
  if (send.length) deps.log("catalog enlargement queued", { batchId: batch.id, productId: product.id, photos: send.length });
}

/** settle's answer when the photo write found the photo already done by another delivery. */
const SETTLED_ELSEWHERE = -1;
/** Failures no retry can fix: the photo is failed at once. */
class TerminalEnlargeFailure extends Error {}

export async function handleEnlargeTask(deps: CatalogDeps, body: Record<string, unknown>, opts: HandleOptions = {}): Promise<HandleResult> {
  const { batchId, productId, sourceImageId } = body;
  if (typeof batchId !== "string" || typeof productId !== "string" || typeof sourceImageId !== "string") return { httpStatus: 400, outcome: "batchId, productId and sourceImageId are required" };
  const started = +deps.now();
  const [photo] = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.id, sourceImageId), eq(catalogSourceImages.batchId, batchId), eq(catalogSourceImages.productId, productId)));
  const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const [product] = await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id, productId));
  if (!photo || !batch || !product) return { httpStatus: 200, outcome: "not_found" };
  const fields = { batchId, productId, sourceImageId, n: photo.n, round: body.round };
  const answer = (httpStatus: number, outcome: string, extra: Record<string, unknown> = {}): HandleResult => {
    deps.log("enlarge delivery", { ...fields, outcome, ms: +deps.now() - started, ...extra });
    return { httpStatus, outcome };
  };
  if (batch.status === "failed" || batch.status === "done") return answer(200, "stopped");
  // Cost rows of this delivery, written inside the settle that records the photo's state.
  const ledger: CostEventInput[] = [];
  // Already settled (a duplicate, or a round sent again): settle the gate again, which changes nothing or unparks.
  if (photoEnlargementState(photo) !== "queued") { await settle({}); return answer(200, "settled"); }
  const upscaler = deps.upscaler, call = deps.enlarge;
  // UPSCALE_MODEL was switched off after this photo was queued: no enlargement is wanted any more (the plain path).
  if (!upscaler || !call) { await settle({ x2Model: null }); return answer(200, "off"); }
  // The configured upscaler makes the image and names it (x2_model, the object's key and metadata), also for
  // a photo queued under another one before UPSCALE_MODEL changed, so the record and the bytes always agree.
  const upscalerId = upscaler.model;
  // This delivery holds the photo's in-flight claim (set below, cleared by its settle).
  let claimed = false;
  // Spec 18 3.3.4, lane-aware: a delivery shows the batch's enlarge lane is moving, so every parked chunk of the batch
  // counts it as progress (not only the chunks holding this product). Tasks still waiting in the paced FIFO behind this
  // one are then never sent again; ENLARGE_STALE_MS means "the batch's lane has been quiet that long".
  await deps.db.update(catalogChunks).set({ progressAt: deps.now() }).where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.taskName, ENLARGING_TASK)));
  try {
    const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
    const path = enlargedPath(derivedPrefixFor(deps.storage, prefix, photo), product.pathKey, photo.n, upscalerId), uri = deps.storage.toGsUri(deps.storage.getBucketName(), path);
    const head = await deps.storage.headObject(uri);
    if (head.exists && head.metadata?.[X2_METADATA.sourceSha256] === photo.sha256 && head.metadata?.[X2_METADATA.upscaler] === upscalerId) {
      if (await settle({ x2Uri: uri, x2Model: upscalerId, x2Error: null }) === SETTLED_ELSEWHERE) return answer(200, "settled");
      return answer(200, "done", { reused: true });
    }
    // The in-flight claim. One guarded row update (no chunk lock held): a second live delivery (Cloud Tasks
    // at least once, or a re-sent round landing beside the first) answers 503 without a call or an attempt counted.
    if (!(await claim())) {
      // Lost to a delivery that has stored the image meanwhile: settled, not in flight.
      const [now] = await deps.db.select({ x2Uri: catalogSourceImages.x2Uri }).from(catalogSourceImages).where(eq(catalogSourceImages.id, sourceImageId));
      if (now?.x2Uri) { await settle({}); return answer(200, "settled"); }
      return answer(503, "in_flight");
    }
    claimed = true;
    let p: Prepared;
    try { p = await deps.prepare((await deps.storage.downloadBuffer(photo.rawUri)).buf, photo.originalName, (b) => deps.matting.convert(b, { batchId, productId })); }
    catch (error) { if (error instanceof UnsupportedSourceError) throw new TerminalEnlargeFailure(error.message); throw error; }
    const limit = upscaleMaxPixels();
    if (p.width * p.height > limit) throw new TerminalEnlargeFailure(`The photo has ${p.width * p.height} pixels, above the ${limit} the upscale service takes.`);
    const t0 = +deps.now();
    let result: EnlargeResult;
    // The model-unavailable 503 is not terminal here: it counts an attempt and the queue retries with its back-off,
    // so a model still loading passes and a deploy problem holds the photo after ENLARGE_TASK_MAX_ATTEMPTS.
    const deadlineAt = started + ENLARGE_DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS;
    try { result = await call(await upscaleUpload(p.rgb, p.width, p.height), { batchId, productId }, { deadlineAt }); }
    catch (error) {
      if (error instanceof EnlargeError) {
        const ms = +deps.now() - t0;
        if (ms > 0 && error.kind !== "rejected") ledger.push(costRow(upscalerId, ms, "failed"));
        // A refused image never passes on a retry; a refused call (identity, route) may once the deploy is fixed.
        if (error.kind === "bad_input") throw new TerminalEnlargeFailure(error.message);
      }
      throw error;
    }
    ledger.push(costRow(upscalerId, result.ms, "ok"));
    const meta = await sharp(result.jpeg).metadata();
    if (meta.width !== p.width * UPSCALE_FACTOR || meta.height !== p.height * UPSCALE_FACTOR) {
      throw new TerminalEnlargeFailure(`The upscale service answered ${meta.width}x${meta.height} for a ${p.width}x${p.height} photo, not exactly 2x.`);
    }
    // The service's own JPEG (quality 95, 4:4:4), stored as it came.
    await deps.storage.uploadBuffer(path, result.jpeg, "image/jpeg", { metadata: { [X2_METADATA.sourceSha256]: photo.sha256, [X2_METADATA.upscaler]: upscalerId } });
    // Another delivery stored the image first (only after this one's claim lapsed): no second write, no second cost row.
    if (await settle({ x2Uri: uri, x2Model: upscalerId, x2Error: null, x2ClaimedAt: null }) === SETTLED_ELSEWHERE) return answer(200, "settled");
    deps.log("catalog upscale", { ...fields, upscaleMs: result.ms, attempts: photo.x2Attempts + 1 });
    return answer(200, "done");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const terminal = error instanceof TerminalEnlargeFailure;
    const attempts = await settle({ x2Error: reason.slice(0, 500), ...(claimed ? { x2ClaimedAt: null } : {}) }, terminal);
    // Another delivery stored the image meanwhile: nothing failed.
    if (attempts === SETTLED_ELSEWHERE) return answer(200, "settled");
    if (attempts >= ENLARGE_TASK_MAX_ATTEMPTS) {
      deps.log("enlargement failed", { severity: "ERROR", ...fields, attempts, retryCount: opts.retryCount ?? 0, model: upscalerId, error: reason });
      return answer(200, "failed");
    }
    deps.log("enlargement retry", { severity: "WARNING", ...fields, attempts, retryCount: opts.retryCount ?? 0, error: reason });
    return answer(503, "retry");
  }

  function costRow(engineId: string, ms: number, outcome: "ok" | "failed"): CostEventInput {
    const target = isCpuUpscalerId(engineId) ? "cpu" : "gpu";
    return { batchId: batch!.id, brandSlug: batch!.brandSlug, isTest: batch!.isTest, productId: photo!.productId, sourceImageId: photo!.id, stage: "upscale", kind: "upscale_call", engine: target, ms, ...matteCallUsd(target, ms), attempt: photo!.x2Attempts + 1, outcome, at: deps.now() };
  }

  /** Takes the photo's in-flight claim: free, or lapsed (its holder's delivery is past its deadline). */
  async function claim(): Promise<boolean> {
    const now = deps.now();
    const [row] = await deps.db.update(catalogSourceImages).set({ x2ClaimedAt: now })
      .where(and(eq(catalogSourceImages.id, sourceImageId as string), isNull(catalogSourceImages.x2Uri),
        or(isNull(catalogSourceImages.x2ClaimedAt), lt(catalogSourceImages.x2ClaimedAt, new Date(+now - ENLARGE_CLAIM_MS)))))
      .returning({ id: catalogSourceImages.id });
    return !!row;
  }

  /**
   * One write of the photo's state under the product's chunk locks, the cost rows of this delivery and the gate:
   * `patch` set (done: only while x2_uri is still null), or a failed attempt counted (`failure`: the reason in
   * `patch.x2Error`; `terminal` fails the photo at once). Returns the photo's attempts after the write
   * (SETTLED_ELSEWHERE when another delivery stored the image first: nothing written, the cost rows dropped). Then the
   * window is topped up and the progress kept.
   */
  async function settle(patch: Partial<Pick<typeof catalogSourceImages.$inferInsert, "x2Uri" | "x2Model" | "x2Error" | "x2ClaimedAt">>, terminal = false): Promise<number> {
    const failure = !("x2Uri" in patch) && "x2Error" in patch;
    const now = deps.now();
    const { attempts, unparked } = await deps.db.transaction(async (tx) => {
      const chunks = await lockProductChunks(tx as unknown as CatalogDeps["db"], batchId as string, productId as string);
      let attempts = photo!.x2Attempts;
      if (failure) {
        // Only deliveries that reached this handler count (never the queue's retry count, see the header).
        const next = terminal ? sql`${ENLARGE_TASK_MAX_ATTEMPTS}::int` : sql`LEAST(${ENLARGE_TASK_MAX_ATTEMPTS}::int, ${catalogSourceImages.x2Attempts} + 1)`;
        const [row] = await tx.update(catalogSourceImages).set({ ...patch, x2Attempts: next, x2Error: patch.x2Error ?? null }).where(and(eq(catalogSourceImages.id, sourceImageId as string), isNull(catalogSourceImages.x2Uri))).returning({ attempts: catalogSourceImages.x2Attempts });
        attempts = row?.attempts ?? SETTLED_ELSEWHERE;
      } else if ("x2Uri" in patch) {
        const [row] = await tx.update(catalogSourceImages).set(patch).where(and(eq(catalogSourceImages.id, sourceImageId as string), isNull(catalogSourceImages.x2Uri))).returning({ id: catalogSourceImages.id });
        if (!row) { ledger.splice(0); attempts = SETTLED_ELSEWHERE; }
      } else if (Object.keys(patch).length) {
        await tx.update(catalogSourceImages).set(patch).where(eq(catalogSourceImages.id, sourceImageId as string));
      }
      if (ledger.length) await recordCostEvents(tx as unknown as CatalogDeps["db"], ledger.splice(0), deps.log);
      return { attempts, unparked: await unparkSettledChunks(tx as unknown as CatalogDeps["db"], chunks, now) };
    });
    for (const chunkId of unparked) deps.log("chunk enlarged", { batchId, chunkId });
    if (unparked.length || !failure || attempts >= ENLARGE_TASK_MAX_ATTEMPTS) {
      await topUpWindow(deps, batchId as string);
      await refreshBatchProgress(deps.db, batchId as string, deps.now());
    }
    return attempts;
  }
}
