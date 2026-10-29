// Spec 18 H3: POST /tasks/catalog/enlarge, one photo's enlargement as its own task (body EnlargeTaskBody, task id
// enlarge-<sourceImageId>-<round>), queued by the matte stage (chunk.ts) on the enlarge lane of the batch's class.
// It makes the photo's x2 image once on the upscale service (enlargeViaService, catalog-upscale or the service
// UPSCALE_URL names) and stores it in the private bucket at enlargedPath (never public); the render primes it and
// never calls the service. States and the render gate: core catalog/pipeline/enlargement.ts.
// - The stored image is already there (same source and upscaler in its metadata): done, no call.
// - A retryable failure (busy, timeout, a server error, a storage or decode hiccup) counts an attempt, records the
//   reason and answers 503, so Cloud Tasks retries with the lane's back-off.
// - The last attempt (ENLARGE_TASK_MAX_ATTEMPTS, by x2_attempts or X-CloudTasks-TaskRetryCount, whichever is higher)
//   or a failure no retry can fix (a photo above UPSCALE_MAX_PIXELS, a refused image, a wrong-size answer) writes the
//   failure, logs ERROR "enlargement failed" and answers 200: the render then holds the photo's enlarged outputs with
//   `enlargement_failed`. A plain resize never stands in.
// Every write of the photo's state locks the chunks holding the product first and unparks the chunk whose last queued
// photo it settled, in the same transaction; the batch's window is topped up after it.
import sharp from "sharp";
import { and, eq, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { batchPrefix, enlargedPath } from "@catalog/core/catalog/naming";
import { UnsupportedSourceError, type Prepared } from "@catalog/core/catalog/render";
import { isCpuUpscalerId, primeSourceX2, UPSCALE_FACTOR, upscaleUpload } from "@catalog/core/catalog/upscale";
import { EnlargeError, enlargeTimeoutMs, enlargeViaService, type EnlargeResult } from "@catalog/core/catalog/enlarge";
import { ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, lockProductChunks, photoEnlargementState, unparkSettledChunks } from "@catalog/core/catalog/pipeline/enlargement";
import { dispatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { recordCostEvents, type CostEventInput } from "@catalog/core/cost-events";
import { matteCallUsd } from "@catalog/core/catalog/cost";
import type { MattingTrace } from "@catalog/core/catalog/matte";
import type { HandleOptions, HandleResult } from "../server";
import { refreshBatchProgress, type CatalogDeps } from "./deps";

/** The service call the handler makes: one attempt, the x2 JPEG as the service answered it. */
export type EnlargeCall = (jpeg: Buffer, trace: MattingTrace) => Promise<EnlargeResult>;

/** The largest photo (width x height) the upscale service takes (`UPSCALE_MAX_PIXELS`, its default 24,000,000). */
export const DEFAULT_UPSCALE_MAX_PIXELS = 24_000_000;
export function upscaleMaxPixels(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UPSCALE_MAX_PIXELS?.trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_UPSCALE_MAX_PIXELS;
}

/**
 * The worker's service call: the service UPSCALE_URL names (catalog-upscale, or the CPU cut-out service), else the
 * first GPU matting service, as the matting client picks it. One attempt per task delivery: the queue retries.
 */
export function workerEnlargeCall(model: string, env: NodeJS.ProcessEnv = process.env): EnlargeCall {
  const gpu = (env.MATTING_GPU_URLS?.trim() ? env.MATTING_GPU_URLS.split(",") : [env.MATTING_GPU_URL ?? ""]).map((u) => u.trim()).find(Boolean) ?? "";
  const url = env.UPSCALE_URL?.trim() || gpu;
  return (jpeg, trace) => {
    if (!url) throw new EnlargeError("No upscale service is configured (UPSCALE_URL).", "rejected", null, false, 0);
    return enlargeViaService({ url, jpeg, model, timeoutMs: enlargeTimeoutMs(env), maxAttempts: 1, trace });
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
 * that is not exactly 2x the photo, nothing is primed and the render holds what needs it (`enlargement_failed`).
 */
export async function primeStoredEnlargement(deps: Pick<CatalogDeps, "upscaler" | "storage" | "log">, source: { id: string; x2Uri: string | null }, p: Prepared): Promise<boolean> {
  if (!deps.upscaler || !source.x2Uri) return false;
  try {
    const primed = await primeSourceX2(deps.upscaler, p.rgb, p.width, (await deps.storage.downloadBuffer(source.x2Uri)).buf);
    if (!primed) deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, reason: "stored image is not 2x the photo" });
    return primed;
  } catch (error) {
    deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** settle's answer when the failure write found the photo already done by another delivery. */
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
  const id = photo.x2Model ?? upscaler.model;
  // The parked chunk waits on this photo: an attempt is progress, so its recovery does not send the task again.
  await deps.db.update(catalogChunks).set({ progressAt: deps.now() }).where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.taskName, ENLARGING_TASK), sql`${catalogChunks.productIds} @> jsonb_build_array(${productId}::text)`));
  try {
    const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
    const path = enlargedPath(derivedPrefixFor(deps.storage, prefix, photo), product.pathKey, photo.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(), path);
    const head = await deps.storage.headObject(uri);
    if (head.exists && head.metadata?.[X2_METADATA.sourceSha256] === photo.sha256 && head.metadata?.[X2_METADATA.upscaler] === id) {
      await settle({ x2Uri: uri, x2Model: id, x2Error: null });
      return answer(200, "done", { reused: true });
    }
    let p: Prepared;
    try { p = await deps.prepare((await deps.storage.downloadBuffer(photo.rawUri)).buf, photo.originalName, (b) => deps.matting.convert(b, { batchId, productId })); }
    catch (error) { if (error instanceof UnsupportedSourceError) throw new TerminalEnlargeFailure(error.message); throw error; }
    const limit = upscaleMaxPixels();
    if (p.width * p.height > limit) throw new TerminalEnlargeFailure(`The photo has ${p.width * p.height} pixels, above the ${limit} the upscale service takes.`);
    const t0 = +deps.now();
    let result: EnlargeResult;
    try { result = await call(await upscaleUpload(p.rgb, p.width, p.height), { batchId, productId }); }
    catch (error) {
      if (error instanceof EnlargeError) {
        const ms = +deps.now() - t0;
        if (ms > 0 && error.kind !== "rejected") ledger.push(costRow(id, ms, "failed"));
        // A refused image never passes on a retry; a refused call (identity, route) may once the deploy is fixed.
        if (error.kind === "bad_input") throw new TerminalEnlargeFailure(error.message);
      }
      throw error;
    }
    ledger.push(costRow(id, result.ms, "ok"));
    const meta = await sharp(result.jpeg).metadata();
    if (meta.width !== p.width * UPSCALE_FACTOR || meta.height !== p.height * UPSCALE_FACTOR) {
      throw new TerminalEnlargeFailure(`The upscale service answered ${meta.width}x${meta.height} for a ${p.width}x${p.height} photo, not exactly 2x.`);
    }
    // The service's own JPEG (quality 95, 4:4:4), stored as it came.
    await deps.storage.uploadBuffer(path, result.jpeg, "image/jpeg", { metadata: { [X2_METADATA.sourceSha256]: photo.sha256, [X2_METADATA.upscaler]: id } });
    await settle({ x2Uri: uri, x2Model: id, x2Error: null });
    deps.log("catalog upscale", { ...fields, upscaleMs: result.ms, attempts: photo.x2Attempts + 1 });
    return answer(200, "done");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const terminal = error instanceof TerminalEnlargeFailure;
    const attempts = await settle({ x2Error: reason.slice(0, 500) }, terminal);
    // Another delivery stored the image meanwhile: nothing failed.
    if (attempts === SETTLED_ELSEWHERE) return answer(200, "settled");
    if (attempts >= ENLARGE_TASK_MAX_ATTEMPTS) {
      deps.log("enlargement failed", { severity: "ERROR", ...fields, attempts, retryCount: opts.retryCount ?? 0, model: id, error: reason });
      return answer(200, "failed");
    }
    deps.log("enlargement retry", { severity: "WARNING", ...fields, attempts, retryCount: opts.retryCount ?? 0, error: reason });
    return answer(503, "retry");
  }

  function costRow(engineId: string, ms: number, outcome: "ok" | "failed"): CostEventInput {
    const target = isCpuUpscalerId(engineId) ? "cpu" : "gpu";
    return { batchId: batch!.id, brandSlug: batch!.brandSlug, isTest: batch!.isTest, productId: photo!.productId, sourceImageId: photo!.id, stage: "upscale", kind: "upscale_call", engine: target, ms, ...matteCallUsd(target, ms), attempt: photo!.x2Attempts + 1, outcome, at: deps.now() };
  }

  /**
   * One write of the photo's state under the product's chunk locks, the cost rows of this delivery and the gate:
   * `patch` set (done), or a failed attempt counted (`failure`: the reason in `patch.x2Error`; `terminal` fails the
   * photo at once). Returns the photo's attempts after the write (SETTLED_ELSEWHERE when another delivery stored the
   * image first). Then the window is topped up and the progress kept.
   */
  async function settle(patch: Partial<Pick<typeof catalogSourceImages.$inferInsert, "x2Uri" | "x2Model" | "x2Error">>, terminal = false): Promise<number> {
    const failure = !("x2Uri" in patch) && "x2Error" in patch;
    const now = deps.now(), retries = (opts.retryCount ?? 0) + 1;
    const { attempts, unparked } = await deps.db.transaction(async (tx) => {
      const chunks = await lockProductChunks(tx as unknown as CatalogDeps["db"], batchId as string, productId as string);
      let attempts = photo!.x2Attempts;
      if (failure) {
        const next = terminal ? sql`${ENLARGE_TASK_MAX_ATTEMPTS}::int` : sql`LEAST(${ENLARGE_TASK_MAX_ATTEMPTS}::int, GREATEST(${catalogSourceImages.x2Attempts} + 1, ${retries}::int))`;
        const [row] = await tx.update(catalogSourceImages).set({ x2Attempts: next, x2Error: patch.x2Error ?? null }).where(and(eq(catalogSourceImages.id, sourceImageId as string), sql`${catalogSourceImages.x2Uri} IS NULL`)).returning({ attempts: catalogSourceImages.x2Attempts });
        attempts = row?.attempts ?? SETTLED_ELSEWHERE;
      } else if (Object.keys(patch).length) {
        await tx.update(catalogSourceImages).set(patch).where(eq(catalogSourceImages.id, sourceImageId as string));
      }
      if (ledger.length) await recordCostEvents(tx as unknown as CatalogDeps["db"], ledger.splice(0), deps.log);
      return { attempts, unparked: await unparkSettledChunks(tx as unknown as CatalogDeps["db"], chunks, now) };
    });
    for (const chunkId of unparked) deps.log("chunk enlarged", { batchId, chunkId });
    if (unparked.length || !failure || attempts >= ENLARGE_TASK_MAX_ATTEMPTS) {
      await dispatchChunks(deps.db, deps.enqueue, batchId as string, { now: deps.now(), log: deps.log, ...(deps.chunkWindow ? { window: deps.chunkWindow } : {}) });
      await refreshBatchProgress(deps.db, batchId as string, deps.now());
    }
    return attempts;
  }
}
