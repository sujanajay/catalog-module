// Spec 18 enlargement lifecycle (docs/plans/2026-10-29-spec-18-enlargement-lifecycle.md), the worker side of the one
// owner module (core catalog/pipeline/enlargement.ts holds the table, the identity, the predicates and the unpark).
// - reconcileEnlargements (3.5): per product, the batch's wanted identities (one row per photo, upscaler and scale in
//   catalog_enlargements) from its pinned route; rows no longer wanted are released (never deleted); in mode "queue"
//   the wanted queued rows get their enlarge task (the same task id on a repeat).
// - primeReadiness (3.3): per prepared photo, the tri-state every render honours: a `done` row's object (accepted by
//   the one validator) is primed, a `failed` row marks the photo terminal (the render holds it with
//   enlargement_failed), an upscaler the batch does not want is marked unwanted; a missing object is queued again.
// - handleEnlargeTask (3.4): POST /tasks/catalog/enlarge, one row per task (enlarge-<id>-<sends>). It makes the
//   row's object once on the upscale service (direct, tiles, downscale or both), with a health probe before the call
//   and a re-probe after an unexplained failure, and settles the row under the product's chunk locks. Outages delay
//   (503, the queue's back-off, no count); failures count (8 attempts, 24 unexplained failures while the service is
//   up); only a positively proven absence is a delay after a paid call (3.10).
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogEnlargements, catalogOutputs, catalogProducts, catalogSourceImages, type CatalogEnlargement } from "@catalog/core/db/schema";
import { enlargedPath, enlargedTilePath, enlargementPrefix } from "@catalog/core/catalog/naming";
import { CHANNELS } from "@catalog/core/catalog/channels";
import { enlargementPlan, UnsupportedSourceError, type EnlargementShot, type Prepared } from "@catalog/core/catalog/render";
import { EnlargementNotReadyError, gpuUrlsFromEnv, isCpuUpscalerId, upscaleTargetFromEnv, markEnlargementTerminal, markEnlargementUnwanted, primeSourceX2, storedUpscaler, upscaleMaxPixels, upscalerFactor, upscalerId, upscalerModel, upscaleUpload, UPSCALE_MODEL_VERSIONS, type UpscaleFactor, type Upscaler } from "@catalog/core/catalog/upscale";
import { ENLARGE_TASK_MARGIN_MS, EnlargeError, enlargeTimeoutMs, enlargeViaService, probeUpscaleHealth, type EnlargeDeps, type EnlargeResult, type UpscaleProbe } from "@catalog/core/catalog/enlarge";
import { ENLARGE_DISPATCH_DEADLINE_SEC } from "@catalog/core/tasks";
import {
  ENLARGE_CLAIM_MS, ENLARGE_MAX_IDENTITY_CHANGES, ENLARGE_MAX_TIMEOUTS, ENLARGE_NEED_SLACK, ENLARGE_PROBE_TIMEOUTS_MAX, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK,
  IDENTITY_UNSTABLE_SENTENCE, enlargedMetadata, enlargementRouteFor, enqueueEnlargements, identityOf, lockProductChunks, pixelHashOf, releaseEnlargements, routeFor, tilesFor,
  unparkSettledChunks, upscalerIdentityId, validateEnlargedObject, type EnlargeTile, type PinnedRoute, type UnparkedChunk,
} from "@catalog/core/catalog/pipeline/enlargement";
import { isBulkBatch, tryEnqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import { recordCostEvents, type CostEventInput } from "@catalog/core/cost-events";
import { upscaleCallUsd } from "@catalog/core/catalog/cost";
import type { MattingTrace } from "@catalog/core/catalog/matte";
import type { HandleOptions, HandleResult } from "../server";
import { refreshBatchProgress, topUpWindow, type CatalogDeps } from "./deps";

/**
 * The service call the handler makes: one attempt, the upscaled JPEG as the service answered it. `deadlineAt` (epoch
 * ms) is the delivery's own deadline: the delivery's start plus ENLARGE_DISPATCH_DEADLINE_SEC (its Cloud Tasks dispatch
 * deadline), less ENLARGE_TASK_MARGIN_MS for the settle; the attempt's timeout is clamped to it. `upscaler` is the
 * upscalerId of the row (its model and scale go to the service).
 */
export type EnlargeCall = (jpeg: Buffer, trace: MattingTrace, opts?: { deadlineAt?: number; upscaler?: string }) => Promise<EnlargeResult>;
/** The handler's health probe of the upscale service for one upscalerId (3.4 steps 7 and 9). */
export type EnlargeProbe = (upscaler: string, opts?: { timeoutMs?: number }) => Promise<UpscaleProbe>;

/**
 * The worker's service call: the service UPSCALE_URL names (catalog-upscale, or the CPU cut-out service), else the
 * first GPU matting service, as the matting client picks it. Spec 18 GPU upscaler: the call goes where the row's
 * upscaler id is made (upscaleRouteFor): a `+cpu` id to UPSCALE_URL, any other id to UPSCALE_GPU_URL
 * (catalog-upscale-gpu), with that service's own timeout. One attempt per task delivery: the queue retries. The
 * attempt waits the service's timeout + 30 s, clamped to the delivery's deadline. The model and scale come from the
 * call's upscaler id (`opts.upscaler`), else `model`. `deps` is for tests (a fake fetch and token).
 */
export function workerEnlargeCall(model: string = process.env.UPSCALE_MODEL?.trim() || "swinir-x2", env: NodeJS.ProcessEnv = process.env, deps: EnlargeDeps = {}): EnlargeCall {
  return (jpeg, trace, opts = {}) => {
    const id = opts.upscaler ?? model, route = upscaleRouteFor(id, env);
    if (!route.url) throw new EnlargeError(`No upscale service is configured for ${isCpuUpscalerId(id) ? "UPSCALE_URL" : "UPSCALE_GPU_URL"}.`, "rejected", null, false, 0);
    return enlargeViaService({ url: route.url, jpeg, model: upscalerModel(id), scale: upscalerFactor(id), timeoutMs: enlargeTimeoutMs(route.env), maxAttempts: 1, trace, ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}) }, deps);
  };
}
const upscaleUrl = (env: NodeJS.ProcessEnv): string => env.UPSCALE_URL?.trim() || gpuUrlsFromEnv(env)[0] || "";
/**
 * Spec 18 GPU upscaler: the service that makes (and the env that times) an upscaler id. A `+cpu` id goes to UPSCALE_URL
 * with UPSCALE_TIMEOUT_S and UPSCALE_COLD_START_S. Any other id is a GPU image: UPSCALE_GPU_URL (catalog-upscale-gpu)
 * with UPSCALE_GPU_TIMEOUT_S and UPSCALE_GPU_COLD_START_S; without one, UPSCALE_URL only when that is itself a GPU
 * service (spec 11, UPSCALE_SERVICE=gpu), else no URL: a GPU id is never made on a CPU service, its row waits
 * ("absent") until a worker that knows the GPU service takes it.
 */
export function upscaleRouteFor(id: string, env: NodeJS.ProcessEnv = process.env): { url: string; env: NodeJS.ProcessEnv } {
  if (isCpuUpscalerId(id)) return { url: upscaleUrl(env), env };
  const gpu = env.UPSCALE_GPU_URL?.trim().replace(/\/+$/, "");
  if (gpu) return { url: gpu, env: { ...env, UPSCALE_TIMEOUT_S: env.UPSCALE_GPU_TIMEOUT_S?.trim() || undefined, UPSCALE_COLD_START_S: env.UPSCALE_GPU_COLD_START_S?.trim() || undefined } };
  return { url: upscaleTargetFromEnv(env) === "gpu" ? upscaleUrl(env) : "", env };
}
/** The measured cold start of the upscale service (infra/lib/shape.sh UPSCALE_COLD_START_S), 120 s until measured. */
export const DEFAULT_UPSCALE_COLD_START_S = 120;
/** The probe's timeout (3.4 step 7): the cold start plus 60 s, so a scale-to-zero start passes. */
export function upscaleProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.UPSCALE_COLD_START_S);
  return ((Number.isFinite(s) && s > 0 ? s : DEFAULT_UPSCALE_COLD_START_S) + 60) * 1000;
}
/** The worker's probe: GET <upscale>/health for the row's model, on the row's service (upscaleRouteFor). */
export function workerEnlargeProbe(env: NodeJS.ProcessEnv = process.env, deps: EnlargeDeps = {}): EnlargeProbe {
  // The timeout is the cold start's, or the time the caller's delivery has left when that is shorter (3.10).
  return async (upscaler, opts = {}) => {
    const route = upscaleRouteFor(upscaler, env);
    return route.url ? probeUpscaleHealth({ url: route.url, model: upscalerModel(upscaler), timeoutMs: Math.min(upscaleProbeTimeoutMs(route.env), opts.timeoutMs ?? Infinity) }, deps) : "absent";
  };
}

/**
 * Where a photo's derived files live: its batch prefix, or for an operator replacement (its raw copy sits under
 * <batch>/replacements-<upload>/) its own prefix, so a replaced shot never serves its matte or enlargement (chunk.ts).
 */
export function derivedPrefixFor(storage: CatalogDeps["storage"], prefix: string, source: { id: string; replacesId: string | null; rawUri: string }): string {
  const replacementRoot = storage.toGsUri(storage.getBucketName(), `${prefix}/replacements-`);
  return source.replacesId && source.rawUri.startsWith(replacementRoot) ? `${prefix}/replacements-${source.id}` : prefix;
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

/** The render's stored upscalers, one object per (upscalerId, threshold), so every delivery shares their readiness cache. */
const storedUpscalers = new Map<string, Upscaler>();
function sharedStoredUpscaler(id: string, minScale: number): Upscaler {
  const key = `${id}|${minScale}`;
  let upscaler = storedUpscalers.get(key);
  if (!upscaler) { upscaler = storedUpscaler(id, minScale); storedUpscalers.set(key, upscaler); }
  return upscaler;
}
/** A batch's enlargement on this worker: its pinned route (I9) and the render's stored upscalers for it. */
export interface BatchEnlargement { route: PinnedRoute; x2: Upscaler; x4: Upscaler | null }
/**
 * The batch's enlargement as this worker serves it: null when the batch was started before the stage (no recorded
 * route: the plain path, F1) or the worker's rollback switch is on (UPSCALE_MODEL=off: no `enlarge` call, F34).
 * The route is the batch's, never the worker's env (F2, F3); the upscalerIds carry the service target (`+cpu`), the
 * batch's pinned GPU target included.
 */
export function batchEnlargement(deps: Pick<CatalogDeps, "enlarge" | "matting">, batch: Pick<typeof catalogBatches.$inferSelect, "options">): BatchEnlargement | null {
  if (!deps.enlarge) return null;
  const route = routeFor(batch);
  if (!route) return null;
  // Spec 18 GPU upscaler: a batch pinned to the GPU upscaler at Start keeps it; any other keeps the worker's UPSCALE_URL
  // target, so changing UPSCALE_TARGET never moves a running batch between CPU and GPU images.
  const target = route.target === "gpu" ? "gpu" : deps.matting.upscaleTarget;
  return { route, x2: sharedStoredUpscaler(upscalerId(route.model, target), route.minScale), x4: route.x4Model ? sharedStoredUpscaler(upscalerId(route.x4Model, target), route.minScale) : null };
}
/** The upscaler identity (I1) of an upscalerId on this worker: the id with its model's export hash. */
export function identityIdOf(deps: Pick<CatalogDeps, "exportHashes">, id: string): string {
  const model = upscalerModel(id);
  return upscalerIdentityId(id, deps.exportHashes?.[model] ?? UPSCALE_MODEL_VERSIONS[model] ?? "unknown");
}

type SourceRow = typeof catalogSourceImages.$inferSelect;
/** One photo of the product with its prepared pixels and its matte (the reconcile's input). */
export interface PhotoShot { source: SourceRow; p: Prepared; alpha: Buffer; matteModel: string }
type NewRow = typeof catalogEnlargements.$inferInsert;
/** A model-free sentence for a photo no route can enlarge enough (3.2 route `none`). */
export function noRouteSentence(channels: readonly string[]): string {
  const labels = channels.map((c) => (CHANNELS as Record<string, { label: string } | undefined>)[c]?.label ?? c);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0] ?? "this marketplace";
  return `This photo is too large to enlarge as much as ${list} needs.`;
}
/**
 * The batch's wanted identities for these photos (3.2, 3.5 step 2): enlargementPlan over every shot of the product
 * (the render's superset), one row per photo and needed band, from the photo's prepared pixels, the band's upscaler
 * (x4 above 2.0x when the route has one) and the route's effective scale. Only `wanted` photos get rows (those with
 * an undecided output still to make or judge). A route `none` row is born `failed` with the size sentence (no call).
 */
export function wantedRows(deps: Pick<CatalogDeps, "exportHashes">, be: BatchEnlargement, batch: Pick<typeof catalogBatches.$inferSelect, "id" | "channels">, product: Pick<typeof catalogProducts.$inferSelect, "id" | "productType">, shots: PhotoShot[], wanted: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): NewRow[] {
  const shapes: EnlargementShot[] = shots.map((s) => ({ width: s.p.width, height: s.p.height, rgb: s.p.rgb, alpha: s.alpha, model: s.matteModel }));
  const plan = enlargementPlan(batch.channels, shapes, product.productType, be.route.minScale, !!be.x4);
  const rows: NewRow[] = [];
  for (const [i, shot] of shots.entries()) {
    if (!wanted.has(shot.source.id) || shot.source.flags.includes("chart_image") || !plan[i]!.length) continue;
    const { p } = shot, pixelHash = pixelHashOf(p.rgb, p.width, p.height);
    for (const need of plan[i]!) {
      const upscaler = need.factor === 4 && be.x4 ? be.x4 : be.x2, factor = upscalerFactor(upscaler.model) as UpscaleFactor;
      const choice = enlargementRouteFor(p.width, p.height, factor, need.maxScale * ENLARGE_NEED_SLACK, env);
      const none = choice.route === "none";
      rows.push({ batchId: batch.id, productId: product.id, sourceImageId: shot.source.id, upscaler: upscaler.model, factor, scale: choice.scale, outW: choice.outW, outH: choice.outH, route: choice.route,
        pixelHash, identityHash: identityOf(pixelHash, identityIdOf(deps, upscaler.model), choice.scale),
        ...(none ? { status: "failed" as const, error: noRouteSentence(need.channels), errorKind: "no_route" } : {}) });
    }
  }
  return rows;
}

export interface ReconcileInput {
  be: BatchEnlargement;
  batch: Pick<typeof catalogBatches.$inferSelect, "id" | "channels" | "brandSlug" | "isTest" | "counts" | "name">;
  product: Pick<typeof catalogProducts.$inferSelect, "id" | "productType">;
  /** Every photo of the product with a matte this delivery can read (the plan's superset). */
  shots: PhotoShot[];
  /** The photos this reconcile owns: their rows not in the wanted set are released (the chunk's photos and those they replace). */
  scope: string[];
  /** The photos that want an enlargement (an undecided output still to make or judge). */
  wanted: ReadonlySet<string>;
  /** "queue" writes and sends; "check" only reads. */
  mode: "queue" | "check";
  /** The delivery's write (under its chunk claim). */
  write: <T>(fn: (db: CatalogDeps["db"]) => Promise<T>) => Promise<T>;
  chunkId?: string;
}
export interface ReconcileResult { rows: CatalogEnlargement[]; queued: boolean; terminal: number }
/**
 * Spec 18 lifecycle 3.5: brings the product's rows to the batch's wanted set. Upserts the wanted rows (`wanted=true`,
 * status and counters untouched when the row exists: a failed row stays terminal, a done row is reused, F44; a
 * released queued row wanted again gets `sends+1`, a fresh task name, because its earlier task may have run and
 * Cloud Tasks refuses a used name), releases every other wanted row of the photos in `scope` that are no longer wanted
 * or were prepared here (a replaced photo, an identity no longer planned; a wanted photo not prepared keeps its rows) and, in
 * mode "queue", sends the task of every wanted queued row with its current `sends` (Cloud Tasks deduplicates a
 * repeat). Returns the wanted rows as they are now.
 */
export async function reconcileEnlargements(deps: CatalogDeps, input: ReconcileInput): Promise<ReconcileResult> {
  const { be, batch, product } = input;
  const target = wantedRows(deps, be, batch, product, input.shots, input.wanted);
  const now = deps.now();
  let rows: CatalogEnlargement[];
  if (input.mode === "check") {
    rows = target.length ? await deps.db.select().from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, batch.id), inArray(catalogEnlargements.identityHash, target.map((r) => r.identityHash)), inArray(catalogEnlargements.sourceImageId, target.map((r) => r.sourceImageId)))) : [];
    rows = rows.filter((r) => target.some((t) => t.sourceImageId === r.sourceImageId && t.identityHash === r.identityHash));
  } else {
    rows = await input.write(async (tx) => {
      // I6 (final check 2026-10-30): a photo that already had ENLARGE_MAX_IDENTITY_CHANGES release events in this batch
      // gets no new identity to make: a new row is born failed with the same sentence the handler writes, so a
      // prepare with three or more different results cannot cycle park, settle, render forever.
      const photos = [...new Set(target.map((r) => r.sourceImageId))];
      const sums = photos.length ? await tx.select({ id: catalogEnlargements.sourceImageId, n: sql<number>`coalesce(sum(${catalogEnlargements.identityReleases}), 0)::int` }).from(catalogEnlargements)
        .where(and(eq(catalogEnlargements.batchId, batch.id), inArray(catalogEnlargements.sourceImageId, photos))).groupBy(catalogEnlargements.sourceImageId) : [];
      const unstable = new Set(sums.filter((x) => x.n >= ENLARGE_MAX_IDENTITY_CHANGES).map((x) => x.id));
      const values = target.map((r) => ({ ...r, ...(unstable.has(r.sourceImageId) && r.status !== "failed" ? { status: "failed" as const, error: IDENTITY_UNSTABLE_SENTENCE, errorKind: "identity_unstable" } : {}), createdAt: now, updatedAt: now }));
      const kept = target.length ? await tx.insert(catalogEnlargements).values(values).onConflictDoUpdate({ target: [catalogEnlargements.batchId, catalogEnlargements.sourceImageId, catalogEnlargements.identityHash], set: { wanted: true, updatedAt: now, sends: sql`CASE WHEN NOT ${catalogEnlargements.wanted} AND ${catalogEnlargements.status} = 'queued' THEN ${catalogEnlargements.sends} + 1 ELSE ${catalogEnlargements.sends} END` } }).returning() : [];
      // A photo this delivery did not prepare (nothing of it to render, its matte unreadable) has no fresh plan: its
      // rows stay as they are while it still wants an image (a held photo keeps its failed row for Try again).
      const releasable = input.scope.filter((id) => !input.wanted.has(id) || input.shots.some((shot) => shot.source.id === id));
      const released = await releaseEnlargements(tx, { batchId: batch.id, productId: product.id, sourceImageIds: releasable, keepIds: kept.map((r) => r.id) }, now);
      if (released.length) deps.log("enlargement released", { batchId: batch.id, productId: product.id, rows: released.length, reason: "not_wanted" });
      return kept;
    });
    const queued = rows.filter((r) => r.status === "queued");
    if (queued.length) {
      await enqueueEnlargements(deps.enqueue, queued, { log: deps.log, ...(input.chunkId ? { chunkId: input.chunkId } : {}), ...(isBulkBatch(batch) ? { bulk: true } : {}) });
      deps.log("catalog enlargement queued", { batchId: batch.id, productId: product.id, rows: queued.length });
    }
  }
  return { rows, queued: rows.some((r) => r.status === "queued"), terminal: rows.filter((r) => r.status === "failed").length };
}

/**
 * Spec 18 lifecycle 3.3, the render side: for each prepared photo and each upscaler of the batch's route, sets the
 * readiness every render of this prepared photo honours. A `done` row's object, accepted by validateEnlargedObject (the
 * handler's judge too), is primed; a `failed` row marks the photo terminal (the render holds it); an upscaler with no
 * wanted row is unwanted (a render that needs it is not ready, never a silent plain resize). A done row whose object is
 * gone goes back to `queued` (counters kept) and is sent in the same pass (F30); one the validator refuses goes back too
 * and the handler counts the attempt when it finds it (terminal at the attempts cap, F58); either way `sends+1`, a fresh task name. A storage error throws EnlargementNotReadyError
 * (transient: the delivery answers 503 and retries). Returns whether any row is queued (the caller parks).
 */
export async function primeReadiness(deps: CatalogDeps, input: { be: BatchEnlargement; batch: ReconcileInput["batch"]; photos: { source: SourceRow; p: Prepared }[]; rows: CatalogEnlargement[]; write: ReconcileInput["write"]; chunkId?: string }): Promise<{ queued: boolean }> {
  const { be } = input;
  const resend: CatalogEnlargement[] = [];
  let queued = false;
  for (const { source, p } of input.photos) {
    for (const upscaler of [be.x2, be.x4]) {
      if (!upscaler) continue;
      const row = input.rows.find((r) => r.sourceImageId === source.id && r.upscaler === upscaler.model && r.wanted);
      if (!row) { markEnlargementUnwanted(upscaler, p.rgb); continue; }
      if (row.status === "failed") { markEnlargementTerminal(upscaler, p.rgb, row.error ?? "The enlargement failed."); continue; }
      if (row.status === "queued") { queued = true; continue; }
      let head: Awaited<ReturnType<CatalogDeps["storage"]["headObject"]>>, bytes: Buffer | null = null;
      try {
        head = await deps.storage.headObject(row.uri!);
        if (head.exists) bytes = (await deps.storage.downloadBuffer(row.uri!)).buf;
      } catch (error) {
        throw new EnlargementNotReadyError(`The stored enlargement could not be read: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const verdict = bytes ? await validateEnlargedObject({ bytes, metadata: head.metadata }, row) : { ok: false as const, reason: "missing" };
      if (verdict.ok) { primeSourceX2(upscaler, p.rgb, p.width, bytes!, { w: row.outW, h: row.outH }); continue; }
      // Missing: queued again with its counters (F30). Refused: queued again and made again (F58); the handler finds the
      // refused object at its key and counts the one attempt there (final check 2026-10-30: counted once, not twice).
      const missing = !bytes;
      const [back] = await input.write((tx) => tx.update(catalogEnlargements).set(missing
        ? { status: "queued", sends: sql`${catalogEnlargements.sends} + 1`, updatedAt: deps.now() }
        : { status: "queued", sends: sql`${catalogEnlargements.sends} + 1`, error: `The stored enlargement was refused: ${verdict.reason}.`, errorKind: "invalid_object", updatedAt: deps.now() })
        .where(and(eq(catalogEnlargements.id, row.id), eq(catalogEnlargements.status, "done"))).returning());
      deps.log("catalog enlargement missing", { severity: "WARNING", batchId: row.batchId, sourceImageId: source.id, enlargementId: row.id, reason: missing ? "stored object not found" : verdict.reason });
      if (back?.status === "failed") { markEnlargementTerminal(upscaler, p.rgb, back.error ?? "The enlargement failed."); deps.log("enlargement failed", { severity: "ERROR", batchId: row.batchId, enlargementId: row.id, sourceImageId: source.id, attempts: back.attempts, error: back.error }); continue; }
      if (back) resend.push(back);
      queued = true;
    }
  }
  if (resend.length) await enqueueEnlargements(deps.enqueue, resend, { log: deps.log, ...(input.chunkId ? { chunkId: input.chunkId } : {}), ...(isBulkBatch(input.batch) ? { bulk: true } : {}) });
  return { queued };
}

/** After a settle: enqueue the chunks it unparked on a batch that is not processing, top up a processing batch's window. */
export async function afterUnpark(deps: Pick<CatalogDeps, "db" | "enqueue" | "now" | "log" | "chunkWindow">, batch: Parameters<typeof isBulkBatch>[0] & { id: string }, unparked: UnparkedChunk[], progress = true): Promise<void> {
  for (const chunk of unparked) {
    deps.log("chunk enlarged", { batchId: batch.id, chunkId: chunk.id, direct: chunk.direct });
    // A failed send leaves the chunk queued with dispatched_at set: the sweep's lost-task rule sends it (F60).
    if (chunk.direct) await tryEnqueueChunk(deps.enqueue, chunk, deps.log, {}, isBulkBatch(batch));
  }
  if (unparked.some((c) => !c.direct) || progress) await topUpWindow(deps, batch.id);
  if (progress) await refreshBatchProgress(deps.db, batch.id, deps.now());
}

/** How long one delivery keeps making tiles (3.2 tile route): at least one tile, then while the next fits before its deadline. */
export const ENLARGE_TILE_BUDGET_MS = (ENLARGE_DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS) / 2;
/** What every step after the call leaves for the settle before the delivery's request ends (re-probe, upload). */
export const ENLARGE_SETTLE_RESERVE_MS = 10_000;
/** The shortest re-probe worth making; with less time left the failure keeps its count (a re-probe timeout proves nothing). */
export const ENLARGE_REPROBE_FLOOR_MS = 2_000;
/** Upload tries of one made image within a delivery (the bytes were paid for). */
export const ENLARGE_UPLOAD_TRIES = 3;
/** A failure of the call, and what it proves (3.4 step 9). */
type Failure = { kind: "counted" | "unexplained" | "delay"; reason: string; errorKind: string; ms: number };

/**
 * Images a call made whose upload failed (final check 2026-10-30): kept in this worker's memory, so a later delivery of
 * the same row on this instance uploads them without another paid call. Keyed by the object URI (a tile has its own);
 * at most ENLARGE_MADE_CACHE_BYTES, oldest dropped first. Lost on a restart, which only costs one more counted call.
 */
const madeImages = new Map<string, Buffer>();
export const ENLARGE_MADE_CACHE_BYTES = 256 * 1024 * 1024;
function keepMade(uri: string, bytes: Buffer): void {
  madeImages.delete(uri);
  madeImages.set(uri, bytes);
  let total = [...madeImages.values()].reduce((t, b) => t + b.length, 0);
  for (const [k, b] of madeImages) { if (total <= ENLARGE_MADE_CACHE_BYTES) break; madeImages.delete(k); total -= b.length; }
}
/** For tests: forget the made images. */
export function clearMadeImages(): void { madeImages.clear(); }

/** The HTTP status or numeric code a storage or matting error carries, when it has one. */
function statusOf(error: unknown): number | null {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    for (const key of ["status", "code", "statusCode"] as const) {
      const v = (e as Record<string, unknown>)[key];
      if (typeof v === "number" && v >= 100 && v < 600) return v;
    }
  }
  const rejected = /\((4\d\d)\)/.exec(error instanceof Error ? error.message : "");
  return rejected && /rejected/i.test((error as Error).message) ? Number(rejected[1]) : null;
}
/**
 * 3.4 step 4: a dependency failure that is a wait (a 5xx, 408, 429, a connection error, a timeout: no status at all),
 * or one that will not pass by waiting (another 4xx: a permission removed, a refused request), which counts.
 */
export function isTransientDependencyError(error: unknown): boolean {
  const status = statusOf(error);
  return status === null || status >= 500 || status === 408 || status === 429;
}

export async function handleEnlargeTask(deps: CatalogDeps, body: Record<string, unknown>, _opts: HandleOptions = {}): Promise<HandleResult> {
  const { batchId, productId, enlargementId } = body;
  // A task in the earlier H3 shape ({sourceImageId, round}): nothing to make; 200 so the queue drops it (2026-10-30).
  if (typeof batchId === "string" && typeof enlargementId !== "string" && typeof body.sourceImageId === "string") return { httpStatus: 200, outcome: "stale_format" };
  if (typeof batchId !== "string" || typeof productId !== "string" || typeof enlargementId !== "string") return { httpStatus: 400, outcome: "batchId, productId and enlargementId are required" };
  const started = +deps.now();
  // The delivery's own end (its Cloud Tasks dispatch deadline and the worker's request timeout): every step after the
  // call is clamped to it, so the delivery answers before it is killed.
  const requestEnd = started + ENLARGE_DISPATCH_DEADLINE_SEC * 1000;
  // This delivery's cost rows (written by its settle) and its claim token.
  const ledger: CostEventInput[] = [];
  let token: string | null = null;
  // True between the write that counted this delivery's call (timeouts + 1, before the call) and its settle.
  let pending = false;
  const [row] = await deps.db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, enlargementId));
  const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const answer = (httpStatus: number, outcome: string, extra: Record<string, unknown> = {}): HandleResult => {
    deps.log("enlarge delivery", { batchId, productId, enlargementId, ...(row ? { sourceImageId: row.sourceImageId, upscaler: row.upscaler, route: row.route } : {}), outcome, ms: +deps.now() - started, ...extra });
    return { httpStatus, outcome };
  };
  if (!batch) return answer(200, "not_found");
  if (batch.status === "failed" || batch.status === "cancelled") return answer(200, "stopped");
  // Step 1: a row that is gone, settled or released: nothing to make; the unpark is checked again (safety net).
  if (!row || row.batchId !== batchId || row.status !== "queued" || !row.wanted) {
    await settle(null);
    return answer(200, "settled");
  }
  // Step 2: the rollback switch. The product's queued rows are released and its chunks unparked: the plain path.
  if (!deps.enlarge) {
    const now = deps.now();
    const unparked = await deps.db.transaction(async (tx) => {
      const chunks = await lockProductChunks(tx as unknown as CatalogDeps["db"], batchId, productId);
      await releaseEnlargements(tx as unknown as CatalogDeps["db"], { batchId, productId, onlyQueued: true, errorKind: "off" }, now);
      return unparkSettledChunks(tx as unknown as CatalogDeps["db"], batchId, chunks, now);
    });
    await afterUnpark(deps, batch, unparked);
    return answer(200, "off");
  }
  const call = deps.enlarge;
  const probeService: EnlargeProbe = deps.enlargeProbe ?? (async () => "ok" as const);
  // Step 3: any delivery shows the enlarge lane is moving (final check 2026-10-30: the lane, not the batch; the stale
  // re-send waits for a quiet hour of the lane, so a batch queued behind another is never re-sent while it moves).
  await refreshLaneProgress(deps, batch);
  const [source] = await deps.db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, row.sourceImageId));
  const [product] = await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id, productId));
  if (!source || !product) return await count("attempts", "The photo of this enlargement no longer exists.", "bad_source");
  const trace: MattingTrace = { batchId, productId };
  const f = row.factor as UpscaleFactor;
  const key = enlargedPath(enlargementPrefix(batch.brandSlug, batch.isTest), product.pathKey, source.n, row.upscaler, row.scale, row.identityHash);
  const uri = deps.storage.toGsUri(deps.storage.getBucketName(), key);
  const fields = { sourceImageId: row.sourceImageId, upscaler: row.upscaler, route: row.route };

  // Step 4: the photo as the render prepares it. A dependency down is a delay; a raw file gone or undecodable counts.
  const prepared = await preparePhoto(source);
  if (!("rgb" in prepared)) return prepared;
  const p = prepared;
  if (pixelHashOf(p.rgb, p.width, p.height) !== row.pixelHash) return await identityChanged();

  // Step 5: an object of this identity already stored (a crash after the upload, a second batch of the photo).
  const existing = await readValid(uri, undefined);
  if (existing === "valid") return await done();
  if (existing === "error") return await delay("storage head failed", "unavailable");
  if (existing === "invalid") {
    // F58: one counted attempt, then the make below overwrites it (terminal at the cap).
    const written = await bump("attempts", "The stored enlargement was refused by the check.", "invalid_object", false);
    if (!written) return answer(200, "settled");
    if (written.status === "failed") return terminal(written, "invalid_object");
    Object.assign(row, written);
  }
  // Step 6: the claim; a live claim of another delivery is a delay (F15). Re-read the object under the claim.
  token = randomUUID();
  const now = deps.now();
  const [claimed] = await deps.db.update(catalogEnlargements).set({ claimedAt: now, claimToken: token })
    .where(and(eq(catalogEnlargements.id, row.id), eq(catalogEnlargements.status, "queued"), or(isNull(catalogEnlargements.claimedAt), lt(catalogEnlargements.claimedAt, new Date(+now - ENLARGE_CLAIM_MS))))).returning();
  if (!claimed) { token = null; return await delay("another delivery holds the claim", "in_flight"); }
  Object.assign(row, claimed);
  // 3.10 (final check 2026-10-30): a call an earlier delivery started and never settled (its request was killed at the
  // deadline, its worker died) was counted before it was made; its cost row is written now, and at the cap the row is
  // terminal without another call.
  if (claimed.callStartedAt) {
    const lostMs = Math.max(0, Math.min(+now - +claimed.callStartedAt, ENLARGE_DISPATCH_DEADLINE_SEC * 1000));
    // Written at once with the mark cleared (one transaction), so this delivery dying too never loses or repeats it.
    const lost = costRow(lostMs, "failed");
    await deps.db.transaction(async (tx) => {
      const [cleared] = await tx.update(catalogEnlargements).set({ callStartedAt: null }).where(and(eq(catalogEnlargements.id, row.id), eq(catalogEnlargements.claimToken, token!))).returning({ id: catalogEnlargements.id });
      if (cleared) await recordCostEvents(tx as unknown as CatalogDeps["db"], [lost], deps.log);
    });
    deps.log("enlargement call lost", { severity: "WARNING", batchId, productId, enlargementId, ...fields, timeouts: claimed.timeouts, startedAt: claimed.callStartedAt });
  }
  if (claimed.timeouts >= ENLARGE_MAX_TIMEOUTS) return await count("timeouts", "the call did not finish before its delivery ended", "deadline", true);
  if ((await readValid(uri, undefined)) === "valid") return await done();
  // Step 7: the probe (the cold start fits its timeout); 3 probe timeouts in a row make the call without one (F57).
  // Any other answer resets the count (3.4 step 7: consecutive timeouts).
  const forced = claimed.probeTimeouts >= ENLARGE_PROBE_TIMEOUTS_MAX;
  if (!forced) {
    const probe = await probeService(row.upscaler, { timeoutMs: Math.max(ENLARGE_REPROBE_FLOOR_MS, requestEnd - ENLARGE_TASK_MARGIN_MS - +deps.now()) });
    if (probe === "timeout") return await delay("the health probe timed out", "probe_timeout", { probeTimeout: true });
    if (probe === "absent" || probe === "no_instance") return await delay(`the upscale service is ${probe === "absent" ? "not available" : "starting no instance"}`, probe === "absent" ? "unavailable" : "busy", { resetProbe: true });
  }
  // Step 8: the route, from the row's exact sizes and the caps as they are now (F6: a lowered cap re-routes to tiles).
  const shrunkW = row.outW / f, shrunkH = row.outH / f;
  const deadlineAt = requestEnd - ENLARGE_TASK_MARGIN_MS;
  let shrunk: Buffer;
  try { shrunk = shrunkW === p.width && shrunkH === p.height ? p.rgb : await sharp(p.rgb, { raw: { width: p.width, height: p.height, channels: 3 } }).resize(shrunkW, shrunkH, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer(); }
  catch (error) { return await count("attempts", `The photo could not be reduced for the output limit: ${message(error)}`, "bad_source"); }
  const cap = upscaleMaxPixels(f);
  try {
    if (shrunkW * shrunkH <= cap) {
      const made = await makeOne(uri, () => upscaleUpload(shrunk, shrunkW, shrunkH), undefined);
      if ("lost" in made) return answer(200, "settled");
      if ("failure" in made) return await failed(made.failure);
      if (!(await store(key, uri, made.jpeg, enlargedMetadata(row)))) return await count("timeouts", "the made image could not be stored", "upload");
      deps.log("catalog upscale", { batchId, productId, ...fields, photo: `${p.width}x${p.height}`, out: `${row.outW}x${row.outH}`, upscaleMs: made.ms });
      return await done();
    }
    // Tile route: strips of the shrunk photo, each its own object, so a later delivery resumes (F50); at least one tile
    // per delivery (F62); `more_tiles` is a delay with progress.
    const tiles = tilesFor(shrunkW, shrunkH, cap);
    const tileBudget = deps.enlargeTileBudgetMs ?? ENLARGE_TILE_BUDGET_MS;
    let made = 0, last = 0;
    const tileImages: Buffer[] = [];
    for (const tile of tiles) {
      const tileKey = enlargedTilePath(key, tile.index), tileUri = deps.storage.toGsUri(deps.storage.getBucketName(), tileKey);
      const expect = { index: tile.index, w: tile.w * f, h: tile.h * f };
      const stored = await readValid(tileUri, expect);
      if (stored === "error") return await delay("storage head failed", "unavailable");
      if (stored === "valid") { tileImages.push((await deps.storage.downloadBuffer(tileUri)).buf); continue; }
      if (made > 0 && (+deps.now() - started + last >= tileBudget || +deps.now() + last > deadlineAt)) return await moreTiles(tiles.length);
      const t0 = +deps.now();
      const reply = await makeOne(tileUri, () => upscaleUpload(shrunk, shrunkW, shrunkH, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }), tile.index, expect);
      if ("lost" in reply) return answer(200, "settled");
      if ("failure" in reply) return await failed({ ...reply.failure, reason: `tile ${tile.index + 1} of ${tiles.length}: ${reply.failure.reason}` });
      if (!(await store(tileKey, tileUri, reply.jpeg, enlargedMetadata(row, tile.index)))) return await count("timeouts", `tile ${tile.index + 1} of ${tiles.length} could not be stored`, "upload");
      tileImages.push(reply.jpeg);
      made++; last = +deps.now() - t0;
      // The tile is made and stored: its counted call is given back (progress, not a failure).
      await deps.db.update(catalogEnlargements).set({ tilesDone: sql`GREATEST(${catalogEnlargements.tilesDone}, ${tile.index + 1})`, ...refund(), callStartedAt: null })
        .where(and(eq(catalogEnlargements.id, row.id), eq(catalogEnlargements.claimToken, token)));
    }
    let stitched: Buffer;
    try { stitched = await stitch(tiles, tileImages, f, row.outW, row.outH); }
    catch (error) { return await count("attempts", `The tiles could not be joined: ${message(error)}`, "invalid_reply"); }
    const verdict = await validateEnlargedObject({ bytes: stitched, metadata: enlargedMetadata(row) }, row);
    if (!verdict.ok) return await count("attempts", `The joined tiles were refused by the check: ${verdict.reason}.`, "invalid_reply");
    if (!(await store(key, uri, stitched, enlargedMetadata(row)))) return await delay("storage upload of the joined tiles", "unavailable");
    deps.log("catalog upscale", { batchId, productId, ...fields, photo: `${p.width}x${p.height}`, out: `${row.outW}x${row.outH}`, tiles: tiles.length });
    return await done(tiles.length);
  } catch (error) {
    // Anything unexpected after a counted call keeps its count (3.10: a paid call never repeats uncounted).
    if (pending) return await count("timeouts", `unexpected: ${message(error)}`, "unexplained");
    throw error;
  }

  /** Step 4: the photo as the render prepares it. A dependency down is a delay; a raw file gone or undecodable, or a refusal that waiting cannot change, counts (F61). */
  async function preparePhoto(photo: SourceRow): Promise<Prepared | HandleResult> {
    const dependency = (what: string, error: unknown) => isTransientDependencyError(error)
      ? delay(`${what}: ${message(error)}`, "unavailable")
      : count("attempts", `The photo could not be read (${what}): ${message(error)}`, "bad_source");
    let head;
    try { head = await deps.storage.headObject(photo.rawUri); } catch (error) { return dependency("storage", error); }
    if (!head.exists) return count("attempts", "The photo's file no longer exists.", "bad_source");
    let raw: Buffer;
    try { raw = (await deps.storage.downloadBuffer(photo.rawUri)).buf; } catch (error) { return dependency("storage", error); }
    let convertFailed: unknown = null;
    try { return await deps.prepare(raw, photo.originalName, async (b) => { try { return await deps.matting.convert(b, trace); } catch (error) { convertFailed = error; throw error; } }); }
    catch (error) {
      if (convertFailed) return dependency("convert", convertFailed);
      return count("attempts", error instanceof UnsupportedSourceError ? "The photo's file could not be decoded." : `The photo could not be prepared: ${message(error)}`, "bad_source");
    }
  }
  /**
   * One service call, counted before it is made (3.10, final check 2026-10-30): `timeouts + 1` and the call's start are
   * written first, under the claim, so a delivery that never reaches its settle (killed at its deadline, its worker
   * gone, an exception) has already counted it. Its settle gives the count back on a success, a counted kind (which
   * counts an attempt instead) or positive proof that no instance handled it. An image an earlier delivery made and
   * could not store is uploaded from memory instead, with no call. `lost`: the claim is gone (another delivery owns
   * the row now), no call made. A reply the validator refuses is a counted failure.
   */
  async function makeOne(objectUri: string, upload: () => Promise<Buffer>, tile: number | undefined, expect?: { index: number; w: number; h: number }): Promise<{ jpeg: Buffer; ms: number } | { failure: Failure } | { lost: true }> {
    const kept = madeImages.get(objectUri);
    if (kept) { madeImages.delete(objectUri); return { jpeg: kept, ms: 0 }; }
    const jpeg = await upload();
    const [counted] = await deps.db.update(catalogEnlargements).set({ timeouts: sql`${catalogEnlargements.timeouts} + 1`, callStartedAt: deps.now(), ...(forced ? {} : { probeTimeouts: 0 }), updatedAt: deps.now() }).where(guard()).returning();
    if (!counted) return { lost: true };
    pending = true;
    row!.timeouts = counted.timeouts;
    const t0 = +deps.now();
    let result: EnlargeResult;
    try {
      result = await call(jpeg, trace, { deadlineAt, upscaler: row!.upscaler });
    } catch (error) {
      const ms = +deps.now() - t0;
      if (!(error instanceof EnlargeError) || error.kind !== "rejected") ledger.push(costRow(ms, "failed", tile));
      return { failure: classify(error, ms) };
    }
    ledger.push(costRow(result.ms, "ok", tile));
    const verdict = await validateEnlargedObject({ bytes: result.jpeg, metadata: enlargedMetadata(row!, tile) }, row!, expect);
    if (!verdict.ok) return { failure: { kind: "counted", reason: `The upscale service answered ${tile === undefined ? "an image" : `tile ${tile + 1}`} the check refused: ${verdict.reason}.`, errorKind: "invalid_reply", ms: result.ms } };
    return { jpeg: result.jpeg, ms: result.ms };
  }
  /**
   * What a failed call proves (3.4 step 9): the service's own answers about this input count an attempt; Cloud Run's
   * own refusal (429, its no-instance 500 or 503), the service's own 503 body, refused or DNS prove no instance did any
   * work (a delay); everything else (a timeout, a reset, a 5xx without the service's body: an instance killed by this
   * input) is unexplained.
   */
  function classify(error: unknown, ms: number): Failure {
    const reason = message(error);
    if (!(error instanceof EnlargeError)) return { kind: "unexplained", reason, errorKind: "unexplained", ms };
    if (error.kind === "bad_input" || error.kind === "rejected") return { kind: "counted", reason, errorKind: error.kind, ms };
    if (error.kind === "server" && error.ownBody) return { kind: "counted", reason, errorKind: "server", ms };
    if (error.kind === "busy") return { kind: "delay", reason, errorKind: "busy", ms };
    if (error.kind === "unavailable" && error.ownBody) return { kind: "delay", reason, errorKind: "unavailable", ms };
    if (error.transport === "refused" || error.transport === "dns") return { kind: "delay", reason, errorKind: "unavailable", ms };
    return { kind: "unexplained", reason, errorKind: error.kind === "timeout" ? "timeout" : "unexplained", ms };
  }
  /**
   * A failed call: counted kinds count an attempt (the call's count given back); a proven non-handling is a delay (given
   * back), forced or not; an unexplained failure keeps its count unless a re-probe, clamped to the time the delivery has
   * left, positively proves the service absent (refused, DNS, its own 503). A re-probe that answers anything but a
   * timeout resets the probe-timeout count.
   */
  async function failed(failure: Failure): Promise<HandleResult> {
    if (failure.kind === "counted") return count("attempts", failure.reason, failure.errorKind);
    if (failure.kind === "delay") return delay(failure.reason, failure.errorKind);
    const left = requestEnd - ENLARGE_SETTLE_RESERVE_MS - +deps.now();
    const probe: UpscaleProbe = left >= ENLARGE_REPROBE_FLOOR_MS ? await probeService(row!.upscaler, { timeoutMs: left }) : "timeout";
    if (probe === "absent") return delay(`${failure.reason} (the service is not available)`, "unavailable", { resetProbe: true });
    return count("timeouts", `${failure.reason} (the service answered ${probe} after it)`, failure.errorKind === "busy" ? "unexplained" : failure.errorKind, false, probe !== "timeout");
  }
  /**
   * Uploads a made image, a few tries within the time the delivery has left; false when it could not (its bytes kept in
   * this worker's memory for the next delivery, so that one stores them without another call).
   */
  async function store(objectKey: string, objectUri: string, bytes: Buffer, metadata: Record<string, string>): Promise<boolean> {
    let last: unknown = null;
    for (let i = 0; i < ENLARGE_UPLOAD_TRIES; i++) {
      const left = requestEnd - ENLARGE_SETTLE_RESERVE_MS - +deps.now();
      if (left <= 0) break;
      try { await within(deps.storage.uploadBuffer(objectKey, bytes, "image/jpeg", { metadata }), left); return true; }
      catch (error) { last = error; }
      if (i + 1 < ENLARGE_UPLOAD_TRIES) await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(200 * (i + 1));
    }
    keepMade(objectUri, bytes);
    deps.log("enlargement upload failed", { severity: "WARNING", batchId, productId, enlargementId, ...fields, error: message(last ?? "no time left") });
    return false;
  }
  /** Reads an object of this identity: valid (the one validator accepts it), invalid, missing, or a storage error. */
  async function readValid(objectUri: string, tile: { index: number; w: number; h: number } | undefined): Promise<"valid" | "invalid" | "missing" | "error"> {
    try {
      const head = await deps.storage.headObject(objectUri);
      if (!head.exists) return "missing";
      const bytes = (await deps.storage.downloadBuffer(objectUri)).buf;
      return (await validateEnlargedObject({ bytes, metadata: head.metadata }, row!, tile)).ok ? "valid" : "invalid";
    } catch { return "error"; }
  }
  function costRow(ms: number, outcome: "ok" | "failed", _tile?: number): CostEventInput {
    const target = isCpuUpscalerId(row!.upscaler) ? "cpu" : "gpu";
    return { batchId: batch!.id, brandSlug: batch!.brandSlug, isTest: batch!.isTest, productId: productId as string, sourceImageId: row!.sourceImageId, stage: "upscale", kind: "upscale_call", engine: target, ms, ...upscaleCallUsd(target, ms), attempt: row!.attempts + row!.timeouts + 1, outcome, at: deps.now() };
  }
  /** The guard of a write: the claim when held, else the row still queued. */
  function guard() {
    return and(eq(catalogEnlargements.id, row!.id), eq(catalogEnlargements.status, "queued"), token ? eq(catalogEnlargements.claimToken, token) : undefined);
  }
  function unclaim() { return token ? { claimedAt: null, claimToken: null, callStartedAt: null } : {}; }
  /** Gives back this delivery's counted call (a success, a counted kind, a proven non-handling). */
  function refund(): Record<string, unknown> {
    if (!pending) return {};
    pending = false;
    return { timeouts: sql`GREATEST(${catalogEnlargements.timeouts} - 1, 0)` };
  }
  async function done(tilesDone = 0): Promise<HandleResult> {
    // Step 5 found the object an earlier delivery stored and never settled (its worker died after the upload): that
    // delivery's call is written as a cost row now, once its claim has lapsed (a live claim's own settle writes it).
    const lapsed = !row!.claimedAt || +row!.claimedAt < +deps.now() - ENLARGE_CLAIM_MS;
    const lost = !token && row!.callStartedAt && lapsed ? { callStartedAt: null } : {};
    if (!token && row!.callStartedAt && lapsed) ledger.push(costRow(Math.max(0, Math.min(+deps.now() - +row!.callStartedAt, ENLARGE_DISPATCH_DEADLINE_SEC * 1000)), "ok"));
    const written = await settle({ status: "done", uri, tilesDone, error: null, errorKind: null, probeTimeouts: 0, ...lost, ...refund(), ...unclaim(), updatedAt: deps.now() });
    if (!written) return answer(200, "settled");
    return answer(200, "done", tilesDone ? { tiles: tilesDone } : {});
  }
  async function moreTiles(total: number): Promise<HandleResult> {
    await settle({ delays: sql`${catalogEnlargements.delays} + 1`, probeTimeouts: 0, ...refund(), ...unclaim(), updatedAt: deps.now() });
    return answer(503, "more_tiles", { tiles: total });
  }
  async function delay(reason: string, kind: string, opts: { probeTimeout?: boolean; resetProbe?: boolean } = {}): Promise<HandleResult> {
    if (row && row.status === "queued") await settle({ delays: sql`${catalogEnlargements.delays} + 1`, ...(opts.probeTimeout ? { probeTimeouts: sql`LEAST(${catalogEnlargements.probeTimeouts} + 1, ${ENLARGE_PROBE_TIMEOUTS_MAX})` } : opts.resetProbe ? { probeTimeouts: 0 } : {}), ...refund(), ...unclaim(), updatedAt: deps.now() }, false);
    return answer(503, kind, { reason });
  }
  /**
   * A counted failure: `attempts` (cap ENLARGE_TASK_MAX_ATTEMPTS) or `timeouts` (cap ENLARGE_MAX_TIMEOUTS); at the cap
   * the row is `failed` with its sentence and an ERROR line; below it 503, the queue retries.
   */
  async function count(counter: "attempts" | "timeouts", reason: string, errorKind: string, lostCall = false, resetProbe = false): Promise<HandleResult> {
    const written = await bump(counter, reason, errorKind, true, lostCall, resetProbe);
    if (!written) return answer(200, "settled");
    if (written.status === "failed") return terminal(written, errorKind);
    deps.log("enlargement retry", { severity: "WARNING", batchId, productId, enlargementId, ...fields, counter, attempts: written.attempts, timeouts: written.timeouts, error: reason });
    return answer(503, "retry", { counter, errorKind });
  }
  /**
   * One counted failure written (the claim released when `release`); null when the guard missed. A `timeouts` failure
   * of this delivery's call was counted before the call (pending), and one of a lost earlier call (`already`) when
   * that call started, so neither adds again; an `attempts` failure gives the call's count back.
   */
  async function bump(counter: "attempts" | "timeouts", reason: string, errorKind: string, release: boolean, already = false, resetProbe = false): Promise<CatalogEnlargement | null> {
    const column = counter === "attempts" ? catalogEnlargements.attempts : catalogEnlargements.timeouts;
    const max = counter === "attempts" ? ENLARGE_TASK_MAX_ATTEMPTS : ENLARGE_MAX_TIMEOUTS;
    const sentence = counter === "attempts" ? reason : `The enlargement did not finish ${max} times. Last: ${reason}`;
    const counted = counter === "timeouts" && (pending || already);
    const given = counter === "attempts" ? refund() : {};
    pending = false;
    const next = counted ? sql`${column}` : sql`${column} + 1`;
    return settle({ ...(counted ? {} : { [counter]: next }), ...given, ...(resetProbe ? { probeTimeouts: 0 } : {}), status: sql`CASE WHEN ${next} >= ${max} THEN 'failed' ELSE 'queued' END`, error: sql`CASE WHEN ${next} >= ${max} THEN ${sentence.slice(0, 500)}::text ELSE ${reason.slice(0, 500)}::text END`, errorKind, ...(release ? unclaim() : {}), updatedAt: deps.now() });
  }
  function terminal(written: CatalogEnlargement, errorKind: string): HandleResult {
    deps.log("enlargement failed", { severity: "ERROR", batchId, productId, enlargementId, ...fields, attempts: written.attempts, timeouts: written.timeouts, errorKind, error: written.error });
    return answer(200, "failed", { errorKind });
  }
  /**
   * The prepared pixels differ from the row's (F43, F59): the row is released (`identity_changed`, one release event)
   * and the product's chunks unparked, so the render-stage reconcile wants the new identity; when the photo already
   * had ENLARGE_MAX_IDENTITY_CHANGES release events in this batch, the row fails with its own sentence instead.
   */
  async function identityChanged(): Promise<HandleResult> {
    const [sum] = await deps.db.select({ n: sql<number>`coalesce(sum(${catalogEnlargements.identityReleases}), 0)::int` }).from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, batchId as string), eq(catalogEnlargements.sourceImageId, row!.sourceImageId)));
    if ((sum?.n ?? 0) >= ENLARGE_MAX_IDENTITY_CHANGES) {
      const written = await settle({ status: "failed", error: IDENTITY_UNSTABLE_SENTENCE, errorKind: "identity_unstable", updatedAt: deps.now() });
      if (written) deps.log("enlargement failed", { severity: "ERROR", batchId, productId, enlargementId, ...fields, errorKind: "identity_unstable", error: IDENTITY_UNSTABLE_SENTENCE });
      return answer(200, written ? "failed" : "settled", { errorKind: "identity_unstable" });
    }
    await settle({ wanted: false, identityReleases: sql`${catalogEnlargements.identityReleases} + 1`, errorKind: "identity_changed", updatedAt: deps.now() });
    deps.log("enlargement released", { batchId, productId, enlargementId, ...fields, reason: "identity_changed" });
    return answer(200, "released", { reason: "identity_changed" });
  }
  /**
   * One write of the row under the product's chunk locks (id order), with this delivery's cost rows (written even
   * when the guard misses: the calls were made), then the unpark of every chunk with no wanted queued row left, and
   * after the commit the direct enqueue (batch not processing) or the window top-up, and the batch progress. `patch`
   * null only re-checks the unpark. Returns the written row, or null when the guard missed.
   */
  async function settle(patch: Record<string, unknown> | null, progress = true): Promise<CatalogEnlargement | null> {
    const at = deps.now();
    const { written, unparked } = await deps.db.transaction(async (tx) => {
      const db = tx as unknown as CatalogDeps["db"];
      const chunks = await lockProductChunks(db, batchId as string, productId as string);
      const [written] = patch && row ? await db.update(catalogEnlargements).set(patch as Partial<CatalogEnlargement>).where(guard()).returning() : [];
      if (ledger.length) await recordCostEvents(db, ledger.splice(0), deps.log);
      return { written: written ?? null, unparked: await unparkSettledChunks(db, batchId as string, chunks, at) };
    });
    if (unparked.length || (progress && patch)) await afterUnpark(deps, batch!, unparked, progress && !!patch);
    return written;
  }
}

/** `work`, or a timeout error after `ms` (the work itself may still finish; its result is then ignored). */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * 3.8 step 3 per lane (final check 2026-10-30): an enlarge delivery refreshes `progress_at` of every parked chunk of
 * every live batch on the same enlarge lane (operator or bulk, isBulkBatch), not only its own batch: tasks of a batch
 * queued behind another are moving with the lane, so the stale re-send (dispatch.ts) re-sends only when the lane itself
 * has been quiet for ENLARGE_STALE_MS.
 */
export async function refreshLaneProgress(deps: Pick<CatalogDeps, "db" | "now">, batch: Parameters<typeof isBulkBatch>[0] & { id: string }): Promise<void> {
  const parked = and(eq(catalogChunks.taskName, ENLARGING_TASK), eq(catalogChunks.status, "queued"));
  const live = await deps.db.selectDistinct({ id: catalogBatches.id, isTest: catalogBatches.isTest, name: catalogBatches.name, counts: catalogBatches.counts })
    .from(catalogBatches).innerJoin(catalogChunks, eq(catalogChunks.batchId, catalogBatches.id))
    .where(and(parked, notInArray(catalogBatches.status, ["failed", "cancelled"])));
  const lane = isBulkBatch(batch);
  const ids = [...new Set([batch.id, ...live.filter((b) => isBulkBatch(b) === lane).map((b) => b.id)])];
  await deps.db.update(catalogChunks).set({ progressAt: deps.now() }).where(and(parked, inArray(catalogChunks.batchId, ids)));
}

/** Joins the tiles' cores into the whole enlarged image (the overlap is cut away), as one JPEG like the service's. */
async function stitch(tiles: EnlargeTile[], images: Buffer[], f: number, outW: number, outH: number): Promise<Buffer> {
  const out = Buffer.alloc(outW * outH * 3);
  for (const [i, tile] of tiles.entries()) {
    const left = (tile.coreX - tile.x) * f, top = (tile.coreY - tile.y) * f, w = tile.coreW * f, h = tile.coreH * f;
    const core = await sharp(images[i]!).removeAlpha().toColourspace("srgb").extract({ left, top, width: w, height: h }).raw().toBuffer();
    for (let y = 0; y < h; y++) core.copy(out, ((tile.coreY * f + y) * outW + tile.coreX * f) * 3, y * w * 3, (y + 1) * w * 3);
  }
  return sharp(out, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The batch's wanted rows of one photo made from these exact pixels (the input of primeReadiness for a photo prepared again). */
export async function wantedRowsOfPixels(db: CatalogDeps["db"], batchId: string, sourceImageId: string, pixelHash: string): Promise<CatalogEnlargement[]> {
  return db.select().from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, batchId), eq(catalogEnlargements.sourceImageId, sourceImageId), eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.pixelHash, pixelHash)));
}
/** The photos of a product in this batch whose outputs still want an image (undecided, to make or judge). */
export async function photosWantingEnlargement(db: CatalogDeps["db"], batchId: string, productId: string): Promise<Set<string>> {
  const rows = await db.select({ id: catalogOutputs.sourceImageId }).from(catalogOutputs)
    .where(and(eq(catalogOutputs.batchId, batchId), eq(catalogOutputs.productId, productId), isNull(catalogOutputs.decision), inArray(catalogOutputs.status, ["pending", "staged", "needs_attention"])));
  return new Set(rows.map((r) => r.id));
}
/** True while a photo of the product in this chunk's scope has a wanted queued row (the render's cheap check, F63). */
export async function productHasQueuedEnlargement(db: CatalogDeps["db"], batchId: string, productId: string, sourceImageIds: string[] | null): Promise<boolean> {
  const [hit] = await db.select({ id: catalogEnlargements.id }).from(catalogEnlargements)
    .where(and(eq(catalogEnlargements.batchId, batchId), eq(catalogEnlargements.productId, productId), eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.status, "queued"), sourceImageIds?.length ? inArray(catalogEnlargements.sourceImageId, sourceImageIds) : undefined)).limit(1);
  return !!hit;
}
