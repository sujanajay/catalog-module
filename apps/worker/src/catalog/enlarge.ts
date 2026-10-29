// Spec 18 H3: POST /tasks/catalog/enlarge, one photo's enlargement as its own task (body EnlargeTaskBody, task id
// enlarge-<sourceImageId>-<round>), queued by the matte stage (chunk.ts) on the enlarge lane of the batch's class.
// It makes the photo's upscaled images once on the upscale service (enlargeViaService, catalog-upscale or the service
// UPSCALE_URL names) and stores them in the private bucket at enlargedPath (never public); the render primes them and
// never calls the service. States and the render gate: core catalog/pipeline/enlargement.ts.
// Spec 18 quality: the photo's job (x2_model) names one image per model it needs, the x2 image (enlargements up to
// 2.0x) and the x4 image (above 2.0x). Each delivery makes at most one image (one service call, so one call always has
// the whole delivery deadline); when another image of the job is still missing it answers 503 "next_image" without
// counting an attempt, and the queue's retry makes the next one. The upscaler sees only the product's region of the
// photo (shotEnlargementRegion: the product box plus a margin, from the photo's own matte), recorded on the object as
// `region`, so the render cuts each channel's crop out of it at exactly the right place.
// - Every image of the job is already there (same source and upscaler in its metadata): done, no call.
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
import { batchPrefix, enlargedPath, enlargedSibling } from "@catalog/core/catalog/naming";
import { enlargementFactors, shotEnlargementRegion, UnsupportedSourceError, type EnlargementShot, type Prepared } from "@catalog/core/catalog/render";
import { formatRegion, gpuUrlsFromEnv, isCpuUpscalerId, parseRegion, primeSourceX2, upscaleMaxPixels, upscalerFactor, upscalerModel, upscaleUpload, type EnlargeRegion, type Upscaler } from "@catalog/core/catalog/upscale";
import { ENLARGE_TASK_MARGIN_MS, EnlargeError, enlargeTimeoutMs, enlargeViaService, type EnlargeDeps, type EnlargeResult } from "@catalog/core/catalog/enlarge";
import { ENLARGE_DISPATCH_DEADLINE_SEC } from "@catalog/core/tasks";
import { ENLARGE_CLAIM_MS, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, enlargementJob, enqueueEnlargements, jobForRoute, jobOnRoute, jobUpscalers, lockProductChunks, photoEnlargementState, unparkSettledChunks, type EnlargementRoute } from "@catalog/core/catalog/pipeline/enlargement";
import { recordCostEvents, type CostEventInput } from "@catalog/core/cost-events";
import { matteCallUsd } from "@catalog/core/catalog/cost";
import type { MattingTrace } from "@catalog/core/catalog/matte";
import type { HandleOptions, HandleResult } from "../server";
import { refreshBatchProgress, topUpWindow, type CatalogDeps } from "./deps";

/**
 * The service call the handler makes: one attempt, the upscaled JPEG as the service answered it. `deadlineAt` (epoch
 * ms) is the delivery's own deadline: the delivery's start plus ENLARGE_DISPATCH_DEADLINE_SEC (its Cloud Tasks dispatch
 * deadline), less ENLARGE_TASK_MARGIN_MS for the settle; the attempt's timeout is clamped to it. `upscaler` is the
 * upscalerId of the image to make (its model and scale go to the service; default the configured UPSCALE_MODEL).
 */
export type EnlargeCall = (jpeg: Buffer, trace: MattingTrace, opts?: { deadlineAt?: number; upscaler?: string }) => Promise<EnlargeResult>;

/** The longest side a JPEG answer may have (services/matting/app.py UPSCALE_MAX_OUTPUT_SIDE). */
const UPSCALE_MAX_OUTPUT_SIDE = 65_500;

/**
 * The worker's service call: the service UPSCALE_URL names (catalog-upscale, or the CPU cut-out service), else the
 * first GPU matting service, as the matting client picks it. One attempt per task delivery: the queue retries. The
 * attempt waits UPSCALE_TIMEOUT_S + 30 s (1740 s + 30 s when unset), clamped to the delivery's deadline. The model and
 * scale come from the call's upscaler id (`opts.upscaler`), else `model` (default UPSCALE_MODEL). `deps` is for tests (a
 * fake fetch and token).
 */
export function workerEnlargeCall(model: string = process.env.UPSCALE_MODEL?.trim() || "swinir-x2", env: NodeJS.ProcessEnv = process.env, deps: EnlargeDeps = {}): EnlargeCall {
  const url = env.UPSCALE_URL?.trim() || gpuUrlsFromEnv(env)[0] || "";
  return (jpeg, trace, opts = {}) => {
    if (!url) throw new EnlargeError("No upscale service is configured (UPSCALE_URL).", "rejected", null, false, 0);
    const id = opts.upscaler ?? model;
    return enlargeViaService({ url, jpeg, model: upscalerModel(id), scale: upscalerFactor(id), timeoutMs: enlargeTimeoutMs(env), maxAttempts: 1, trace, ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}) }, deps);
  };
}

/** Spec 18 quality: the configured route (the x2 and x4 upscalerIds) of the worker's upscalers. */
export function routeOf(deps: Pick<CatalogDeps, "upscaler" | "upscalerX4">): EnlargementRoute | null {
  return deps.upscaler ? { x2: deps.upscaler.model, x4: deps.upscalerX4?.model ?? null } : null;
}

/**
 * Where a photo's derived files live: its batch prefix, or for an operator replacement (its raw copy sits under
 * <batch>/replacements-<upload>/) its own prefix, so a replaced shot never serves its matte or x2 image (chunk.ts).
 */
export function derivedPrefixFor(storage: CatalogDeps["storage"], prefix: string, source: { id: string; replacesId: string | null; rawUri: string }): string {
  const replacementRoot = storage.toGsUri(storage.getBucketName(), `${prefix}/replacements-`);
  return source.replacesId && source.rawUri.startsWith(replacementRoot) ? `${prefix}/replacements-${source.id}` : prefix;
}

/**
 * Metadata on a stored image: the photo it was made from, the upscaler that made it and (spec 18 quality) the region
 * of the prepared photo it was made from ("x,y,w,h"; absent on images made from the whole photo before) and the cut-out
 * that region was read from (`matte`: the photo's matte_uri then, empty for none).
 */
export const X2_METADATA = { sourceSha256: "sourceSha256", upscaler: "upscaler", region: "region", matte: "matte" } as const;

/**
 * The region of the prepared photo `p` its enlarge task sends (spec 18 quality, crop before upscaling): the product's
 * box plus a margin from the photo's own matte (`alpha`, cut out by `matteModel`), or the whole photo without a matte
 * or without a product in it. The one computation the enlarge task and the render's check share, so they always agree.
 */
export function photoRegion(p: Pick<Prepared, "width" | "height" | "rgb">, alpha: Buffer | null, matteModel: string | null, productType: Parameters<typeof shotEnlargementRegion>[1]): EnlargeRegion {
  const whole = { x: 0, y: 0, w: p.width, h: p.height };
  if (!alpha || alpha.length !== p.width * p.height) return whole;
  return shotEnlargementRegion({ width: p.width, height: p.height, rgb: p.rgb, alpha, model: matteModel ?? "" }, productType) ?? whole;
}

/**
 * 2026-10-29 review P1-1: whether a stored image is still the one the photo needs. "ok": made from these bytes
 * (`sha256`) by this upscaler, and either from the whole photo (no region, or a region that is the whole photo, which
 * holds every crop of any cut-out) or from the cut-out the photo has now (`matteUri`) and, when `region` is given,
 * exactly the region that cut-out gives. "stale": an object made for something else (another photo, upscaler,
 * cut-out or region), which a new enlargement replaces. "missing": no object.
 */
export type StoredImageState = "ok" | "stale" | "missing";
export function storedImageState(head: { exists: boolean; metadata?: Record<string, string> | undefined }, expect: { sha256: string; upscaler: string; matteUri: string | null; width: number; height: number; region?: EnlargeRegion }): StoredImageState {
  if (!head.exists) return "missing";
  const meta = head.metadata ?? {};
  if (meta[X2_METADATA.sourceSha256] !== expect.sha256 || meta[X2_METADATA.upscaler] !== expect.upscaler) return "stale";
  const text = meta[X2_METADATA.region];
  if (!text) return "ok";
  const region = parseRegion(text);
  if (!region) return "stale";
  if (region.x === 0 && region.y === 0 && region.w === expect.width && region.h === expect.height) return "ok";
  if ((meta[X2_METADATA.matte] ?? "") !== (expect.matteUri ?? "")) return "stale";
  return !expect.region || formatRegion(region) === formatRegion(expect.region) ? "ok" : "stale";
}
/** A job settled with one image made and another failed for good (2026-10-29 review P2-5): x2_uri set, with the failure. */
export const partlyFailed = (row: { x2Uri: string | null; x2Error: string | null; x2Attempts: number }): boolean =>
  !!row.x2Uri && !!row.x2Error && row.x2Attempts >= ENLARGE_TASK_MAX_ATTEMPTS;

/** The stored image of each upscaler of the photo's job, beside x2_uri (the first one's object). */
export function jobImageUris(x2Uri: string, x2Model: string | null): { upscaler: string; uri: string }[] {
  const ids = jobUpscalers(x2Model);
  if (!ids.length) return [];
  const first = { upscaler: ids[0]!, factor: upscalerFactor(ids[0]!) };
  return ids.flatMap((id) => {
    const uri = id === first.upscaler ? x2Uri : enlargedSibling(x2Uri, first, { upscaler: id, factor: upscalerFactor(id) });
    return uri ? [{ upscaler: id, uri }] : [];
  });
}

/**
 * Spec 18 3.3.5, the render side: primes the upscalers' caches with the photo's stored images (spec 18 quality: one
 * per model of its job, x2 and x4), so every render of this prepared photo (channels, auto-resolve) uses them without a
 * service call. An image that is missing, was made from other bytes (its `sourceSha256`), by another upscaler than the
 * configured ones (`x2_model` or the object's `upscaler`), from a region outside the photo, or is not exactly its
 * model's scale times its region, is not primed, and the render holds what needs it (`enlargement_failed`). The render
 * stage re-queues a job of another upscaler before it gets here (requeueEnlargementGaps), so that case only arises when
 * UPSCALE_MODEL or UPSCALE_MODEL_X4 changes during the render itself. True when every image of the job was primed.
 */
export async function primeStoredEnlargement(deps: Pick<CatalogDeps, "upscaler" | "upscalerX4" | "storage" | "log">, source: { id: string; sha256: string; x2Uri: string | null; x2Model: string | null; matteUri: string | null }, p: Prepared): Promise<boolean> {
  const route = routeOf(deps);
  if (!route || !source.x2Uri) return false;
  if (!jobOnRoute(source.x2Model, route)) {
    deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, reason: "stored image was made by another upscaler" });
    return false;
  }
  const images = jobImageUris(source.x2Uri, source.x2Model);
  let primedAll = images.length === jobUpscalers(source.x2Model).length;
  for (const { upscaler: id, uri } of images) {
    const upscaler = id === deps.upscaler!.model ? deps.upscaler! : deps.upscalerX4!;
    try {
      const head = await deps.storage.headObject(uri);
      // An image cut for another matte (the ladder replaced the photo's cut-out since) is never used: its region may
      // miss the new crops, and the render's check (enlargementGaps) makes it again.
      if (storedImageState(head, { sha256: source.sha256, upscaler: id, matteUri: source.matteUri, width: p.width, height: p.height }) !== "ok") {
        deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, upscaler: id, reason: !head.exists ? "stored image not found" : head.metadata?.[X2_METADATA.sourceSha256] !== source.sha256 ? "stored image was made from other bytes" : head.metadata?.[X2_METADATA.upscaler] !== id ? "stored image was made by another upscaler" : "stored image was made for another cut-out" });
        primedAll = false;
        continue;
      }
      const regionText = head.metadata?.[X2_METADATA.region];
      const region = regionText ? parseRegion(regionText) : null;
      const primed = (!regionText || region) && await primeSourceX2(upscaler, p.rgb, p.width, (await deps.storage.downloadBuffer(uri)).buf, region);
      if (!primed) { deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, upscaler: id, reason: "stored image does not match the photo's region at the model's scale" }); primedAll = false; }
    } catch (error) {
      deps.log("catalog enlargement missing", { severity: "WARNING", sourceImageId: source.id, upscaler: id, error: error instanceof Error ? error.message : String(error) });
      primedAll = false;
    }
  }
  return primedAll;
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
  /** Spec 18 quality: the x4 upscaler, when configured (deps.upscalerX4). */
  upscalerX4?: Upscaler | null;
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
 * Spec 18 3.3.4: once a product's photos are cut out, decides which need an upscaled image and which (spec 18 quality:
 * enlargementFactors over every shot of the product with a matte, as the render plans them: the x2 image for channels
 * up to 2.0x, the x4 image above) and queues their enlarge tasks (round 0, the batch's enlarge lane). The photo is
 * marked queued (x2_model, the job: one upscalerId per image) before its task is sent; a send that fails is left to
 * the parked chunk's recovery (ENLARGE_STALE_MS). A photo marked queued by an earlier delivery has its task sent again
 * (the same name, so Cloud Tasks keeps one).
 */
export async function queueEnlargements(deps: CatalogDeps, input: QueueEnlargementsInput): Promise<void> {
  const { upscaler, batch, product, sources, shots } = input;
  const route: EnlargementRoute = { x2: upscaler.model, x4: input.upscalerX4?.model ?? null };
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
    const factors = enlargementFactors(batch.channels, all.map((a) => a.shot), product.productType, upscaler.minScale, !!route.x4);
    const jobs = new Map(all.flatMap((a, i) => { const job = enlargementJob(factors[i]!, route); return job ? [[a.id, job] as const] : []; }));
    const queue = undecided.filter((r) => jobs.has(r.id));
    if (queue.length) await input.write(async (tx) => {
      for (const r of queue) await tx.update(catalogSourceImages).set({ x2Model: jobs.get(r.id)!, x2Error: null }).where(and(eq(catalogSourceImages.id, r.id), isNull(catalogSourceImages.x2Model)));
    });
    send.push(...queue);
  }
  await enqueueEnlargements(deps.enqueue, batch.id, send.map((r) => ({ id: r.id, productId: product.id })), 0, { log: deps.log, ...(input.bulk ? { bulk: true } : {}) });
  if (send.length) deps.log("catalog enlargement queued", { batchId: batch.id, productId: product.id, photos: send.length });
}

/**
 * A photo whose enlargement the render would need and does not have (enlargementGaps): its job now (`from`, the
 * x2_model value) and the job it needs (`to`). `reason`: "not_queued" (no job, or one without an image a channel
 * needs: the matte stage ran on another build, threshold or x4 route), "another_upscaler" (a job of other upscalers),
 * "stale_image" (a stored image cut for another matte or region, or gone), "queued" (still queued, its task lost).
 */
export interface EnlargementGap { id: string; productId: string; from: string | null; to: string; reason: "not_queued" | "another_upscaler" | "stale_image" | "queued" }
type SourceRow = typeof catalogSourceImages.$inferSelect;

/**
 * 2026-10-29 review P1-1 and P1-2, the render's check before it renders a product: every photo with a pending output
 * gets exactly the images the render will need, with the configured upscalers and threshold (deps.upscaler,
 * deps.upscalerX4) and its matte as it is now. The decision is the matte stage's (enlargementFactors over every shot of
 * the product with a matte, the same superset), so a batch whose matte stage ran on another build, threshold or x4
 * route, or whose cut-out the ladder replaced, is queued again rather than held. Only a job that failed for good is
 * left to the render's hold (`enlargement_failed`): a true terminal failure, never a gap a re-run could close. A
 * job that already has every image it needs, each cut from the photo's current region, is no gap, so a photo is
 * re-queued at most once per change.
 */
export async function enlargementGaps(deps: CatalogDeps, input: { batch: Pick<typeof catalogBatches.$inferSelect, "id" | "channels">; product: Pick<typeof catalogProducts.$inferSelect, "id" | "productType">; sources: SourceRow[]; trace: MattingTrace }): Promise<EnlargementGap[]> {
  const route = routeOf(deps);
  const { batch, product, sources } = input;
  if (!route || !deps.upscaler || !sources.length) return [];
  const pending = new Set((await deps.db.select({ id: catalogOutputs.sourceImageId }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batch.id), eq(catalogOutputs.productId, product.id), eq(catalogOutputs.status, "pending")))).map((o) => o.id));
  if (!sources.some((s) => pending.has(s.id))) return [];
  // Every shot of the product with a matte, as the matte stage reads them (an unchanged angle by its earlier matte).
  const shots: { row: SourceRow; shot: EnlargementShot; p: Prepared; alpha: Buffer }[] = [];
  for (const row of sources) {
    if (row.flags.includes("chart_image")) continue;
    let matteUri = row.matteUri;
    if (!matteUri) { const [old] = await deps.db.select({ matteUri: catalogSourceImages.matteUri }).from(catalogSourceImages).where(and(eq(catalogSourceImages.productId, product.id), eq(catalogSourceImages.sha256, row.sha256), eq(catalogSourceImages.isCurrent, true))); matteUri = old?.matteUri ?? null; }
    if (!matteUri) continue;
    try {
      const { p, alpha } = await loadShotFromMatte(deps, row, matteUri, input.trace);
      shots.push({ row, p, alpha, shot: { width: p.width, height: p.height, rgb: p.rgb, alpha, model: row.matteModel ?? "" } });
    } catch (error) { deps.log("catalog enlargement check skipped a shot", { severity: "WARNING", batchId: batch.id, sourceImageId: row.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const factors = enlargementFactors(batch.channels, shots.map((s) => s.shot), product.productType, deps.upscaler.minScale, !!route.x4);
  const gaps: EnlargementGap[] = [];
  for (const [i, { row, p, alpha }] of shots.entries()) {
    const need = enlargementJob(factors[i]!, route);
    // The render fails a photo without its own matte; a photo the render does not enlarge needs nothing.
    if (!need || !pending.has(row.id) || !row.matteUri) continue;
    const gap = (reason: EnlargementGap["reason"], to = need) => gaps.push({ id: row.id, productId: row.productId, from: row.x2Model, to, reason });
    const ids = jobUpscalers(row.x2Model), needed = jobUpscalers(need);
    if (!jobOnRoute(row.x2Model, route)) { gap(row.x2Model ? "another_upscaler" : "not_queued"); continue; }
    if (!needed.every((id) => ids.includes(id))) { gap("not_queued"); continue; }
    const state = photoEnlargementState(row);
    if (state === "queued") { gap("queued", row.x2Model!); continue; }
    if (state !== "done") continue;
    const region = photoRegion(p, alpha, row.matteModel, product.productType);
    const states = [];
    for (const { upscaler, uri } of jobImageUris(row.x2Uri!, row.x2Model)) {
      if (!needed.includes(upscaler)) continue;
      states.push(storedImageState(await deps.storage.headObject(uri), { sha256: row.sha256, upscaler, matteUri: row.matteUri, width: p.width, height: p.height, region }));
    }
    // A job that ended with one image failed for good keeps its hold for that image (a true terminal failure).
    if (states.includes("stale") || (states.includes("missing") && !partlyFailed(row))) gap("stale_image");
  }
  return gaps;
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
  const route = routeOf(deps), call = deps.enlarge;
  // UPSCALE_MODEL was switched off after this photo was queued: no enlargement is wanted any more (the plain path).
  if (!route || !call) { await settle({ x2Model: null }); return answer(200, "off"); }
  // The configured upscalers make the images and name them (x2_model, the objects' keys and metadata), also for a
  // photo queued under other ones before UPSCALE_MODEL or UPSCALE_MODEL_X4 changed (each image keeps its factor), so
  // the record and the bytes always agree.
  const job = jobOnRoute(photo.x2Model, route) ? photo.x2Model! : jobForRoute(photo.x2Model, route) ?? route.x2;
  const ids = jobUpscalers(job);
  // This delivery holds the photo's in-flight claim (set below, cleared by its settle).
  let claimed = false;
  // The job's images (one per upscaler) and how many of them are stored for the photo as it is now.
  let images: { id: string; path: string; uri: string }[] = [], stored = 0;
  // Spec 18 3.3.4, lane-aware: a delivery shows the batch's enlarge lane is moving, so every parked chunk of the batch
  // counts it as progress (not only the chunks holding this product). Tasks still waiting in the paced FIFO behind this
  // one are then never sent again; ENLARGE_STALE_MS means "the batch's lane has been quiet that long".
  await deps.db.update(catalogChunks).set({ progressAt: deps.now() }).where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.taskName, ENLARGING_TASK)));
  try {
    const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest), derived = derivedPrefixFor(deps.storage, prefix, photo);
    images = ids.map((id) => { const path = enlargedPath(derived, product.pathKey, photo.n, id, upscalerFactor(id)); return { id, path, uri: deps.storage.toGsUri(deps.storage.getBucketName(), path) }; });
    // The photo and its matte first: a stored image counts only when it was cut from the region this matte gives now
    // (2026-10-29 review P1-1: after the ladder replaced the cut-out, a retry never reuses the old region's image).
    let p: Prepared, alpha: Buffer | null = null;
    try {
      if (photo.matteUri) ({ p, alpha } = await loadShotFromMatte(deps, photo, photo.matteUri, { batchId, productId }));
      else p = await deps.prepare((await deps.storage.downloadBuffer(photo.rawUri)).buf, photo.originalName, (b) => deps.matting.convert(b, { batchId, productId }));
    }
    catch (error) { if (error instanceof UnsupportedSourceError) throw new TerminalEnlargeFailure(error.message); throw error; }
    // Spec 18 quality: only the product's region (its box plus a margin) goes to the upscaler; the whole photo when the
    // matte finds no product (the render fails that shot anyway) or is not stored.
    const region = photoRegion(p, alpha, photo.matteModel, product.productType);
    const expected = { sha256: photo.sha256, matteUri: photo.matteUri, width: p.width, height: p.height, region };
    const missingImages = async () => {
      const out: typeof images = [];
      for (const image of images) if (storedImageState(await deps.storage.headObject(image.uri), { ...expected, upscaler: image.id }) !== "ok") out.push(image);
      return out;
    };
    let missing = await missingImages();
    if (!missing.length) {
      if (await settle({ x2Uri: images[0]!.uri, x2Model: job, x2Error: null }) === SETTLED_ELSEWHERE) return answer(200, "settled");
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
    // 2026-10-29 review P2-3: the images again, under the claim. A delivery that read them before another one stored
    // its image and released the claim (the next_image hand-off) would otherwise make that image a second time.
    missing = await missingImages();
    if (!missing.length) {
      if (await settle({ x2Uri: images[0]!.uri, x2Model: job, x2Error: null, x2ClaimedAt: null }) === SETTLED_ELSEWHERE) return answer(200, "settled");
      return answer(200, "done", { reused: true });
    }
    const target = missing[0]!, upscalerId = target.id, factor = upscalerFactor(upscalerId);
    stored = images.filter((image) => !missing.includes(image)).length;
    // 2026-10-29 review P1-3: each model's own cap (its own time per pixel against the timeout).
    const limit = upscaleMaxPixels(factor);
    if (region.w * region.h > limit) throw new TerminalEnlargeFailure(`The photo's product region has ${region.w * region.h} pixels, above the ${limit} the upscale service takes for a ${factor}x enlargement.`);
    if (Math.max(region.w, region.h) * factor > UPSCALE_MAX_OUTPUT_SIDE) throw new TerminalEnlargeFailure(`The photo's product region is ${region.w}x${region.h}; ${factor}x of it is more than a JPEG holds.`);
    const t0 = +deps.now();
    let result: EnlargeResult;
    // The model-unavailable 503 is not terminal here: it counts an attempt and the queue retries with its back-off,
    // so a model still loading passes and a deploy problem holds the photo after ENLARGE_TASK_MAX_ATTEMPTS.
    const deadlineAt = started + ENLARGE_DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS;
    try { result = await call(await upscaleUpload(p.rgb, p.width, p.height, region), { batchId, productId }, { deadlineAt, upscaler: upscalerId }); }
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
    if (meta.width !== region.w * factor || meta.height !== region.h * factor) {
      throw new TerminalEnlargeFailure(`The upscale service answered ${meta.width}x${meta.height} for a ${region.w}x${region.h} region, not exactly ${factor}x.`);
    }
    // The service's own JPEG (quality 95, 4:4:4), stored as it came, with the region it was made from.
    await deps.storage.uploadBuffer(target.path, result.jpeg, "image/jpeg", { metadata: { [X2_METADATA.sourceSha256]: photo.sha256, [X2_METADATA.upscaler]: upscalerId, [X2_METADATA.region]: formatRegion(region), [X2_METADATA.matte]: photo.matteUri ?? "" } });
    stored++;
    deps.log("catalog upscale", { ...fields, upscaler: upscalerId, region: formatRegion(region), photo: `${p.width}x${p.height}`, upscaleMs: result.ms, attempts: photo.x2Attempts + 1 });
    // Spec 18 quality: another image of the job is still missing. The claim goes and the queue's retry makes it (one
    // service call per delivery); no attempt is counted, since nothing failed.
    if (missing.length > 1) {
      if (await settle({ x2Model: job, x2ClaimedAt: null }) === SETTLED_ELSEWHERE) return answer(200, "settled");
      return answer(503, "next_image", { upscaler: upscalerId, remaining: missing.length - 1 });
    }
    // Another delivery stored the job first (only after this one's claim lapsed): no second write, no second cost row.
    if (await settle({ x2Uri: images[0]!.uri, x2Model: job, x2Error: null, x2ClaimedAt: null }) === SETTLED_ELSEWHERE) return answer(200, "settled");
    return answer(200, "done");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const terminal = error instanceof TerminalEnlargeFailure;
    // 2026-10-29 review P2-5: when this failure ends the job while another of its images is stored (the x4 image after
    // the x2 one), the job settles with the stored one too (x2_uri, partlyFailed), so the render makes every output
    // that image serves and holds only the ones that needed the failed image.
    const attempts = await settle({ x2Error: reason.slice(0, 500), ...(claimed ? { x2ClaimedAt: null } : {}) }, terminal, stored > 0 ? images[0]!.uri : undefined);
    // Another delivery stored the image meanwhile: nothing failed.
    if (attempts === SETTLED_ELSEWHERE) return answer(200, "settled");
    if (attempts >= ENLARGE_TASK_MAX_ATTEMPTS) {
      deps.log("enlargement failed", { severity: "ERROR", ...fields, attempts, retryCount: opts.retryCount ?? 0, model: job, error: reason, ...(stored > 0 ? { partial: true } : {}) });
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
  async function settle(patch: Partial<Pick<typeof catalogSourceImages.$inferInsert, "x2Uri" | "x2Model" | "x2Error" | "x2ClaimedAt">>, terminal = false, partialUri?: string): Promise<number> {
    const failure = !("x2Uri" in patch) && "x2Error" in patch;
    // A partial write (spec 18 quality: one image of the job stored, another still missing) is guarded like a done one.
    const partial = !failure && !("x2Uri" in patch) && "x2ClaimedAt" in patch;
    const now = deps.now();
    const { attempts, unparked } = await deps.db.transaction(async (tx) => {
      const chunks = await lockProductChunks(tx as unknown as CatalogDeps["db"], batchId as string, productId as string);
      let attempts = photo!.x2Attempts;
      if (failure) {
        // Only deliveries that reached this handler count (never the queue's retry count, see the header).
        const next = terminal ? sql`${ENLARGE_TASK_MAX_ATTEMPTS}::int` : sql`LEAST(${ENLARGE_TASK_MAX_ATTEMPTS}::int, ${catalogSourceImages.x2Attempts} + 1)`;
        const [row] = await tx.update(catalogSourceImages).set({ ...patch, x2Attempts: next, x2Error: patch.x2Error ?? null }).where(and(eq(catalogSourceImages.id, sourceImageId as string), isNull(catalogSourceImages.x2Uri))).returning({ attempts: catalogSourceImages.x2Attempts });
        attempts = row?.attempts ?? SETTLED_ELSEWHERE;
        // The job is over with an image stored: settled with it (partlyFailed), in the same write as the gate.
        if (partialUri && attempts >= ENLARGE_TASK_MAX_ATTEMPTS) await tx.update(catalogSourceImages).set({ x2Uri: partialUri, x2Model: job }).where(and(eq(catalogSourceImages.id, sourceImageId as string), isNull(catalogSourceImages.x2Uri)));
      } else if ("x2Uri" in patch || partial) {
        const [row] = await tx.update(catalogSourceImages).set(patch).where(and(eq(catalogSourceImages.id, sourceImageId as string), isNull(catalogSourceImages.x2Uri))).returning({ id: catalogSourceImages.id });
        if (!row) { ledger.splice(0); attempts = SETTLED_ELSEWHERE; }
      } else if (Object.keys(patch).length) {
        await tx.update(catalogSourceImages).set(patch).where(eq(catalogSourceImages.id, sourceImageId as string));
      }
      if (ledger.length) await recordCostEvents(tx as unknown as CatalogDeps["db"], ledger.splice(0), deps.log);
      return { attempts, unparked: await unparkSettledChunks(tx as unknown as CatalogDeps["db"], chunks, now) };
    });
    for (const chunkId of unparked) deps.log("chunk enlarged", { batchId, chunkId });
    if (unparked.length || (!failure && !partial) || attempts >= ENLARGE_TASK_MAX_ATTEMPTS) {
      await topUpWindow(deps, batchId as string);
      await refreshBatchProgress(deps.db, batchId as string, deps.now());
    }
    return attempts;
  }
}
