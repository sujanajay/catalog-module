// Spec 18 enlargement lifecycle (docs/plans/2026-10-29-spec-18-enlargement-lifecycle.md), the pure owner: identity,
// size arithmetic and routes, the one validator of a stored object, the SQL predicates, the park and unpark rules and
// the release. The worker's catalog/enlarge.ts is the I/O owner (reconcile, readiness, the enlarge task handler);
// nothing else reads catalog_enlargements or the enlarged objects to decide readiness.
//
// One row per (batch, photo, identity) a batch wants (migration 0006). An identity is the prepared pixels (pixel_hash:
// sha256 of prepared.rgb plus the size), the upscaler with its export hash and the effective scale (I1); the image
// always covers the whole prepared photo, so a matte change never changes it. Row states: queued, done, failed;
// `wanted` false is a released row (I7). Two counted budgets end an identity (I6): attempts (ENLARGE_TASK_MAX_ATTEMPTS)
// and unexplained failures while the service is up (ENLARGE_MAX_TIMEOUTS); delays never count and time is never a
// limit (I8).
//
// The park: a chunk with a wanted queued row of its photos waits at the render stage (status queued, task_name
// ENLARGING_TASK, dispatched_at set so the window and every older dispatch skip it). The settle that leaves no wanted
// queued row unparks it in the same transaction as its row write, under lockProductChunks (the lock the park takes
// first): a processing batch's window picks it up, any other live batch gets a direct enqueue (unparkSettledChunks).
import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, asc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogChunks, catalogEnlargements, type CatalogEnlargement } from "../../db/schema";
import { ENLARGE_DISPATCH_DEADLINE_SEC, enlargeTaskId, type EnlargeTaskBody, type enqueueTask } from "../../tasks";
import { LEGACY_UPSCALE_MIN_SCALE, upscaleConfigFromEnv, upscaleMaxPixels, UPSCALE_MODEL_VERSIONS, upscalerModel, type UpscaleFactor } from "../upscale";
// A cycle with dispatch.ts (which imports this module); PROCESSING_STATUSES is read only inside functions.
import { PROCESSING_STATUSES } from "./dispatch";

export { EnlargementNotReadyError } from "../upscale";

/** Counted upscaler failures on one input (I6): bad input, a refusal, the service's own error, a reply the validator refuses, a corrupt raw file. */
export const ENLARGE_TASK_MAX_ATTEMPTS = 8;
/** Counted unexplained failures (a timeout, a crash-shaped answer) while the re-probe did not prove the service absent (I6). */
export const ENLARGE_MAX_TIMEOUTS = 24;
/** Release events with `identity_changed` per (batch, photo) before the next mismatch is terminal (I6, F59). */
export const ENLARGE_MAX_IDENTITY_CHANGES = 3;
/** Consecutive health-probe timeouts after which the call is made without a probe (3.4 step 7, F57). */
export const ENLARGE_PROBE_TIMEOUTS_MAX = 3;
/** Sends of one row after which the stale re-send slows to ENLARGE_SEND_SLOW_MS and logs ERROR (3.8). Never a failure. */
export const ENLARGE_SEND_WARN = 20;
export const ENLARGE_SEND_SLOW_MS = 6 * 60 * 60_000;
/** The largest enlarged image the worker makes on any route, in output pixels (3.2; infra/lib/shape.sh ties it to WORKER_MEMORY). */
export const ENLARGE_MAX_OUTPUT_PIXELS = 64_000_000;
/** Source px of overlap between two tiles of the tile route (3.2). */
export const ENLARGE_TILE_OVERLAP = 64;
/** The slack on a photo's largest planned scale, so a ladder variant of nearly the same box still fits (3.2 neededScale). */
export const ENLARGE_NEED_SLACK = 1.05;
/**
 * A parked chunk whose batch saw no enlarge delivery this long has its wanted queued rows sent again (3.8). Every
 * enlarge delivery of the batch refreshes the progress_at of every parked chunk of the batch, so tasks waiting in the
 * paced lane are never re-sent while the lane moves. Never a failure: a re-send only.
 */
export const ENLARGE_STALE_MS = 60 * 60_000;
/** How long a delivery's in-flight claim on a row holds: the enlarge task's dispatch deadline. */
export const ENLARGE_CLAIM_MS = ENLARGE_DISPATCH_DEADLINE_SEC * 1000;
/** `task_name` of a chunk parked at the render stage until its photos' enlargements settle. */
export const ENLARGING_TASK = "enlarging";
/** The sentence of an identity that kept changing (F59); model-free. */
export const IDENTITY_UNSTABLE_SENTENCE = "This photo could not be prepared the same way twice.";

type Log = (message: string, fields?: Record<string, unknown>) => void;

/** What Start records on the batch (options.enlargement): the batch's pinned route (I9). */
export interface EnlargementOption {
  model: string;
  /** The x4 model above 2.0x, when configured. */
  x4Model?: string;
  /** The scale above which the batch's enlargements use the upscaler; absent (older batches) is 1.5. */
  minScale?: number;
}
/**
 * What Start records on the batch (options.enlargement) when the upscaler is on (`UPSCALE_MODEL` set and not "off"):
 * the batch's route for its whole life (I9), which also scopes the enlarged_without_upscaler invariant. Null when off.
 */
export function enlargementOptionFromEnv(env: NodeJS.ProcessEnv = process.env): EnlargementOption | null {
  const model = env.UPSCALE_MODEL?.trim();
  if (!model || model === "off") return null;
  const config = upscaleConfigFromEnv(env);
  return { model, ...(config.x4Model ? { x4Model: config.x4Model } : {}), minScale: config.minScale };
}
/**
 * The options Start writes on the batch (web Start, start.ts, and the load driver, catalog/load-start.ts): the
 * enlargement route pinned from the env when the upscaler is on, the options unchanged when it is off. One function so
 * every starter makes its batches the same way (a batch without options.enlargement takes the plain path).
 */
export function startedBatchOptions<O extends { enlargement?: EnlargementOption | null }>(options: O, env: NodeJS.ProcessEnv = process.env): O {
  const enlargement = enlargementOptionFromEnv(env);
  return enlargement ? { ...options, enlargement } : options;
}
/** A batch's pinned route (I9): options.enlargement, or null for a batch started before the stage (the plain path). */
export interface PinnedRoute { model: string; x4Model: string | null; minScale: number }
export function routeFor(batch: { options: { enlargement?: EnlargementOption | null } | null }): PinnedRoute | null {
  const e = batch.options?.enlargement;
  if (!e || typeof e !== "object" || !e.model) return null;
  return { model: e.model, x4Model: e.x4Model ?? null, minScale: typeof e.minScale === "number" ? e.minScale : LEGACY_UPSCALE_MIN_SCALE };
}

/** The upscaler identity id (I1): the upscalerId with the model's export hash, `swinir-x2+cpu@9f4a3f85`. */
export function upscalerIdentityId(upscalerId: string, exportHash: string = UPSCALE_MODEL_VERSIONS[upscalerModel(upscalerId)] ?? "unknown"): string {
  return `${upscalerId}@${exportHash}`;
}
const hex16 = (text: string | Buffer, ...more: (string | Buffer)[]): string => {
  const h = createHash("sha256").update(text);
  for (const m of more) h.update(m);
  return h.digest("hex").slice(0, 16);
};
/** The prepared pixel hash (I1): sha256 over the exact bytes the service receives plus `width x height`, 16 hex. */
export function pixelHashOf(rgb: Buffer, width: number, height: number): string {
  return hex16(rgb, `${width}x${height}`);
}
/** The identity hash (I1): sha256 of `pixel_hash|upscaler identity|scale`, 16 hex. */
export function identityOf(pixelHash: string, upscalerIdentity: string, scale: number): string {
  return hex16(`${pixelHash}|${upscalerIdentity}|${Number(scale.toFixed(3))}`);
}

/** The effective scale in thousandths (3.2): min(f, sqrt(ENLARGE_MAX_OUTPUT_PIXELS / P)) rounded down to 3 decimals. */
function scaleMilli(width: number, height: number, factor: number, maxOutput = ENLARGE_MAX_OUTPUT_PIXELS): number {
  const p = width * height, cap = maxOutput * 1_000_000;
  let s = Math.floor(Math.sqrt(maxOutput / p) * 1000);
  // Integer correction of the float square root: the largest s with s^2 x P <= maxOutput x 10^6.
  while (s > 0 && s * s * p > cap) s--;
  while ((s + 1) * (s + 1) * p <= cap) s++;
  return Math.min(factor * 1000, s);
}
/** The effective scale of a `width x height` photo at `factor` (3.2), never above the factor. */
export function effectiveScale(width: number, height: number, factor: number): number {
  return scaleMilli(width, height, factor) / 1000;
}
/**
 * The exact output size (3.2): the shrunk input `(floor(width x scale / f), floor(height x scale / f))` (the photo
 * itself at `scale = f`) enlarged by the model's integer factor. Integer arithmetic on the thousandths, so the size is
 * the same on every machine. `scale` never computes a size anywhere else; the render maps by out_w / width.
 */
export function enlargedDims(width: number, height: number, factor: number, scale: number): { shrunkW: number; shrunkH: number; outW: number; outH: number } {
  const milli = Math.round(scale * 1000);
  const shrunkW = milli >= factor * 1000 ? width : Math.floor((width * milli) / (factor * 1000));
  const shrunkH = milli >= factor * 1000 ? height : Math.floor((height * milli) / (factor * 1000));
  return { shrunkW, shrunkH, outW: shrunkW * factor, outH: shrunkH * factor };
}
export type EnlargementRouteKind = "direct" | "tiles" | "downscale" | "downscale_tiles" | "none";
export interface EnlargementRouteChoice { route: EnlargementRouteKind; scale: number; shrunkW: number; shrunkH: number; outW: number; outH: number }
/**
 * The route for one identity (3.2), in quality order: direct (one call), tiles (the photo above the model's per-call
 * cap: a grid of calls, stitched), downscale and downscale_tiles (the effective scale is below the factor because of
 * the output limit, and still meets the photo's need), or none (no route can make the output: a terminal size refusal
 * before any call). `neededScale` is the largest planned scale of the photo in this band times ENLARGE_NEED_SLACK.
 */
export function enlargementRouteFor(width: number, height: number, factor: UpscaleFactor, neededScale: number, env: NodeJS.ProcessEnv = process.env): EnlargementRouteChoice {
  const scale = effectiveScale(width, height, factor);
  const dims = enlargedDims(width, height, factor, scale);
  const cap = upscaleMaxPixels(factor, env);
  const fits = dims.shrunkW * dims.shrunkH <= cap;
  if (scale >= factor) return { route: fits ? "direct" : "tiles", scale, ...dims };
  if (scale + 1e-9 >= neededScale) return { route: fits ? "downscale" : "downscale_tiles", scale, ...dims };
  return { route: "none", scale, ...dims };
}
/** One tile of the tile route: its core (the pixels it contributes) and its extent (the core plus overlap), in shrunk-photo px. */
export interface EnlargeTile { index: number; x: number; y: number; w: number; h: number; coreX: number; coreY: number; coreW: number; coreH: number }
/**
 * The tile grid of a `w x h` (shrunk) photo above the per-call `cap` (3.2): strips along the longer side, the fewest
 * whose extent (core plus ENLARGE_TILE_OVERLAP on each inner side) is at most `cap` pixels. One tile when it fits.
 */
export function tilesFor(w: number, h: number, cap: number, overlap = ENLARGE_TILE_OVERLAP): EnlargeTile[] {
  const horizontal = w >= h, long = horizontal ? w : h, short = horizontal ? h : w;
  for (let n = 1; n <= long; n++) {
    const strips: EnlargeTile[] = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const c0 = Math.floor((i * long) / n), c1 = Math.floor(((i + 1) * long) / n);
      const e0 = Math.max(0, c0 - (i > 0 ? overlap : 0)), e1 = Math.min(long, c1 + (i < n - 1 ? overlap : 0));
      if ((e1 - e0) * short > cap) { ok = false; break; }
      strips.push(horizontal
        ? { index: i, x: e0, y: 0, w: e1 - e0, h: short, coreX: c0, coreY: 0, coreW: c1 - c0, coreH: short }
        : { index: i, x: 0, y: e0, w: short, h: e1 - e0, coreX: 0, coreY: c0, coreW: short, coreH: c1 - c0 });
    }
    if (ok) return strips;
  }
  throw new Error(`No tile grid fits ${w} x ${h} under ${cap} pixels.`);
}

/** Metadata keys on a stored enlargement (and each tile): the identity it was made for. */
export const ENLARGED_METADATA = { pixelHash: "pixelHash", upscaler: "upscaler", scale: "scale", identity: "identity", tile: "tile" } as const;
export function enlargedMetadata(row: Pick<CatalogEnlargement, "pixelHash" | "upscaler" | "scale" | "identityHash">, tile?: number): Record<string, string> {
  return { [ENLARGED_METADATA.pixelHash]: row.pixelHash, [ENLARGED_METADATA.upscaler]: row.upscaler, [ENLARGED_METADATA.scale]: String(Number(row.scale.toFixed(3))), [ENLARGED_METADATA.identity]: row.identityHash, ...(tile !== undefined ? { [ENLARGED_METADATA.tile]: String(tile) } : {}) };
}
export type ValidateResult = { ok: true } | { ok: false; reason: string };
/**
 * The one judge of a stored enlargement (3.3, N3): the handler on its own reply before the upload and on a head, and
 * primeReadiness before it primes, all call this, so they can never disagree. Accepts when the metadata names the
 * row's identity (and the tile's index), the JPEG decodes in full, and its size is exactly the row's `out_w x out_h`
 * (or the tile's expected size), never recomputed from the scale.
 */
export async function validateEnlargedObject(object: { bytes: Buffer; metadata?: Record<string, string> | undefined }, row: Pick<CatalogEnlargement, "identityHash" | "outW" | "outH">, tile?: { index: number; w: number; h: number }): Promise<ValidateResult> {
  const meta = object.metadata ?? {};
  if (meta[ENLARGED_METADATA.identity] !== row.identityHash) return { ok: false, reason: "the object names another identity" };
  if (tile && meta[ENLARGED_METADATA.tile] !== String(tile.index)) return { ok: false, reason: "the object names another tile" };
  const want = tile ? { w: tile.w, h: tile.h } : { w: row.outW, h: row.outH };
  try {
    const metadata = await sharp(object.bytes).metadata();
    if (metadata.width !== want.w || metadata.height !== want.h) return { ok: false, reason: `the object is ${metadata.width} x ${metadata.height}, not ${want.w} x ${want.h}` };
    // A full decode (shrink-on-load keeps it cheap); failOn "warning" refuses a truncated JPEG.
    await sharp(object.bytes, { failOn: "warning" }).resize(64, 64, { fit: "inside" }).raw().toBuffer();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `the object does not decode (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The photos of the current catalog_chunks row (in an UPDATE or SELECT of catalog_chunks): its products' photos, or
 * only its own photo list when it has one.
 */
function rowOfCurrentChunk(): SQL {
  return sql`${catalogEnlargements.batchId} = "catalog_chunks"."batch_id"
    AND ${catalogEnlargements.productId}::text IN (SELECT jsonb_array_elements_text("catalog_chunks"."product_ids"))
    AND ("catalog_chunks"."source_image_ids" IS NULL OR jsonb_array_length("catalog_chunks"."source_image_ids") = 0 OR "catalog_chunks"."source_image_ids" @> jsonb_build_array(${catalogEnlargements.sourceImageId}))`;
}
/** A wanted row still being made: the one definition of "queued" (I3). */
export function enlargementQueued(): SQL {
  return sql`${catalogEnlargements.wanted} AND ${catalogEnlargements.status} = 'queued'`;
}
/** A wanted row whose upscaler failed for good (or no route can make it): the only enlargement hold (I4). */
export function enlargementFailed(): SQL {
  return sql`${catalogEnlargements.wanted} AND ${catalogEnlargements.status} = 'failed'`;
}
/** True for the current catalog_chunks row while one of its photos has a wanted queued row: the park and unpark rule. */
export function wantedQueuedExists(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${catalogEnlargements} WHERE ${rowOfCurrentChunk()} AND ${enlargementQueued()})`;
}

export interface ChunkScope { batchId: string; productIds: string[]; sourceImageIds: string[] | null }
/** The wanted queued rows of `chunk` (its products' photos, or only its own photo list). */
export async function queuedEnlargementsOfChunk(db: Pick<Db, "select">, chunk: ChunkScope): Promise<CatalogEnlargement[]> {
  if (!chunk.productIds.length) return [];
  return db.select().from(catalogEnlargements)
    .where(and(eq(catalogEnlargements.batchId, chunk.batchId), inArray(catalogEnlargements.productId, chunk.productIds), enlargementQueued(),
      chunk.sourceImageIds?.length ? inArray(catalogEnlargements.sourceImageId, chunk.sourceImageIds) : undefined))
    .orderBy(asc(catalogEnlargements.id));
}

/** One row as its task needs it. */
export type EnlargementTaskRef = Pick<CatalogEnlargement, "id" | "batchId" | "productId" | "sends">;
/**
 * Sends one enlarge task per row with its current `sends` (enlargeTaskId): a repeat of the same send is deduplicated
 * by Cloud Tasks; only the stale re-send bumps `sends` (3.5 step 4). A failed send is logged and left to the parked
 * chunk's recovery (resendStaleEnlargements). Returns the number sent.
 */
export async function enqueueEnlargements(enqueue: typeof enqueueTask, rows: EnlargementTaskRef[], options: { bulk?: boolean; log: Log; chunkId?: string }): Promise<number> {
  let sent = 0;
  for (const row of rows) {
    const body: EnlargeTaskBody = { batchId: row.batchId, productId: row.productId, enlargementId: row.id };
    try { await enqueue("/tasks/catalog/enlarge", { ...body }, { taskId: enlargeTaskId(row.id, row.sends), ...(options.bulk ? { bulk: true } : {}) }); sent++; }
    catch (error) { options.log("enlarge dispatch failed", { severity: "WARNING", batchId: row.batchId, ...(options.chunkId ? { chunkId: options.chunkId } : {}), productId: row.productId, enlargementId: row.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return sent;
}

/**
 * Locks every chunk of the batch that holds the product, in id order (the same lock the park takes first), so a row
 * write and a park never miss each other. Lock order everywhere: product row (decisions) -> product chunks by id ->
 * enlargement rows by id.
 */
export async function lockProductChunks(tx: Pick<Db, "select">, batchId: string, productId: string): Promise<string[]> {
  const rows = await tx.select({ id: catalogChunks.id }).from(catalogChunks)
    .where(and(eq(catalogChunks.batchId, batchId), sql`${catalogChunks.productIds} @> jsonb_build_array(${productId}::text)`))
    .orderBy(asc(catalogChunks.id)).for("update");
  return rows.map((row) => row.id);
}

/** A chunk the unpark freed, with what its direct enqueue needs (`direct`: the batch is not processing). */
export interface UnparkedChunk { id: string; batchId: string; stage: string; step: number; direct: boolean }
/**
 * The one unpark rule (I8): the parked chunks in `chunkIds` (or every chunk of the batch when null) with no wanted
 * queued row left. On a processing batch they become ordinary waiting chunks (task_name and dispatched_at null), which
 * the window picks up; on any other live batch (done, publishing: an operator retry or replacement) dispatched_at is
 * set and the caller enqueues them directly (`direct`), the lost-task rule covering a failed send. A failed or
 * cancelled batch's chunks stay as they are. The settle calls it under lockProductChunks after its row write; the
 * recovery, decisions and the in-process runner call it as a safety net.
 */
export async function unparkSettledChunks(tx: Pick<Db, "select" | "update">, batchId: string, chunkIds: string[] | null, now: Date): Promise<UnparkedChunk[]> {
  if (chunkIds && !chunkIds.length) return [];
  const [batch] = await tx.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch || batch.status === "failed" || batch.status === "cancelled") return [];
  const processing = (PROCESSING_STATUSES as readonly string[]).includes(batch.status);
  const rows = await tx.update(catalogChunks).set({ taskName: null, dispatchedAt: processing ? null : now, progressAt: now })
    .where(and(eq(catalogChunks.batchId, batchId), chunkIds ? inArray(catalogChunks.id, chunkIds) : undefined, eq(catalogChunks.status, "queued"), eq(catalogChunks.taskName, ENLARGING_TASK), sql`NOT ${wantedQueuedExists()}`))
    .returning({ id: catalogChunks.id, batchId: catalogChunks.batchId, stage: catalogChunks.stage, step: catalogChunks.step });
  return rows.map((row) => ({ ...row, direct: !processing }));
}

/**
 * Releases rows (I7): `wanted=false`, status kept, so a parked chunk never waits on a row nobody wants and a terminal
 * row stays terminal when it is wanted again. Scoped to a batch and either photos or a product; `keepIds` are left
 * wanted (the reconcile's wanted set). `errorKind` records why (identity_changed, off, replaced, removed). Returns the
 * released rows.
 */
export async function releaseEnlargements(tx: Pick<Db, "update">, scope: { batchId: string; sourceImageIds?: string[]; productId?: string; keepIds?: string[]; onlyQueued?: boolean; errorKind?: string }, now: Date): Promise<Pick<CatalogEnlargement, "id" | "sourceImageId">[]> {
  if (scope.sourceImageIds && !scope.sourceImageIds.length) return [];
  return tx.update(catalogEnlargements).set({ wanted: false, updatedAt: now, ...(scope.errorKind ? { errorKind: scope.errorKind } : {}) })
    .where(and(eq(catalogEnlargements.batchId, scope.batchId), eq(catalogEnlargements.wanted, true),
      scope.sourceImageIds ? inArray(catalogEnlargements.sourceImageId, scope.sourceImageIds) : undefined,
      scope.productId ? eq(catalogEnlargements.productId, scope.productId) : undefined,
      scope.keepIds?.length ? notInArray(catalogEnlargements.id, scope.keepIds) : undefined,
      scope.onlyQueued ? eq(catalogEnlargements.status, "queued") : undefined))
    .returning({ id: catalogEnlargements.id, sourceImageId: catalogEnlargements.sourceImageId });
}
