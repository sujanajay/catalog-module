/**
 * M3-S5: background removal behind the M7 vendor interface (M3-F2-R1 to R4, M7-F2). One photo's cut-out asks the
 * `image.matte` routes in this order (decision D8):
 *   1. the policy's models, in policy order, on the GPU services (`matting-gpu`): first model, then second model;
 *   2. the overflow vendor (`photoroom`), only when its route is serving, has a no-training position on file and its
 *      daily cap leaves room (shipped off);
 *   3. the policy's models, in policy order, on the CPU cut-out service (`matting-cpu`), today's fallback.
 * Only policy models run (M3-F2-R1): a served model the policy did not choose is never asked. Within an own tier, a
 * service-level failure (busy after its retries, no connection, breaker open) skips that tier's other models, so a
 * busy GPU costs one model's busy retries, as before; a model-level failure (an answered 5xx, an unknown model) moves to
 * the policy's next model on the same service. Every route honours the kill switch (`state`) and its circuit. When no
 * route answers, the simple method (floodFillMatte) is used as before and the photo carries `fallback_matte`.
 */
import sharp from "sharp";
import type { Matte, Prepared } from "./render";
import { floodFillMatte, matteFor, UnavailableError, UnknownMatteModelError, type MattingClient, type MatteOptions, type MattingTrace } from "./matte";
import { callRoutes, fallbackLogFields, type PlannedRoute, type RouteAttempt, type Router } from "../vendor/router";
import { isOverflowAdapter, routeCallable, routeId, type RouteAdapter, type RouteDef } from "../vendor/routes";
import { PHOTOROOM_MAX_SIDE, photoroomMatte, type PhotoroomDeps } from "../vendor/adapters/photoroom";
import type { OverflowGate } from "../vendor/overflow";

/** One HTTP call to an overflow vendor, as the ledger records it (M3-F2-R4, M6-F1 ledger completeness). */
export interface VendorCall {
  routeId: string;
  /** The adapter: the ledger engine and the billed component. */
  engine: RouteAdapter;
  usd: number;
  estimated: boolean;
  outcome: "ok" | "failed" | "timeout";
  ms: number;
  reason: string;
}
/** The route that made a cut-out, and for an overflow call its cost and why it was needed (M3-F2-R4). */
export interface MatteRouteInfo {
  routeId: string | null;
  /** Set when the overflow vendor made it: the ledger engine (the adapter), the call's cost and the reason. */
  overflow?: {engine: RouteAdapter; usd: number; estimated: boolean; reason: string};
}
export type RoutedMatte = Matte & {route?: MatteRouteInfo};
export interface MatteRouting {
  router: Router;
  /** The product policy's models, first choice first (`model_policy`, M3-F2-R1). */
  preferred: readonly (string | null | undefined)[];
  /** Absent: no overflow route is ever called. */
  overflow?: OverflowGate;
  /**
   * Writes one vendor call to the cost ledger at once, before anything else can fail: every HTTP call to a vendor,
   * answered, refused, of the wrong size or timed out, reaches the ledger (and so the next cap check). Required for an
   * overflow route to be called.
   */
  record?: (call: VendorCall) => Promise<boolean>;
  /** The vendor adapters' HTTP client and env (tests pass fakes). */
  vendor?: PhotoroomDeps;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The cut-out plan for one photo (see the file comment): the policy's models on the GPU, every callable overflow route
 * by rank, the policy's models on the CPU. A policy model the table has no row for is still asked on our own services,
 * so the per-category policy keeps working; it cannot be switched off from the table.
 */
export function planMatteRoutes(router: Router, preferred: readonly (string | null | undefined)[]): PlannedRoute[] {
  const rows = router.routes.filter(r => r.capability === "image.matte");
  const models = [...new Set(preferred.filter((m): m is string => !!m))];
  const pick = (r: RouteDef): PlannedRoute => ({id: r.id, capability: r.capability, rank: r.rank, adapter: r.adapter, model: r.model, fromTable: true});
  const own = (adapter: "matting-gpu" | "matting-cpu"): PlannedRoute[] => models.flatMap(model => {
    const row = rows.find(r => r.adapter === adapter && r.model === model);
    if (!row) return rows.some(r => r.model === model) ? [] : [{id: routeId("image.matte", adapter, model), capability: "image.matte" as const, rank: 0, adapter, model, fromTable: false}];
    return routeCallable(row) ? [pick(row)] : [];
  });
  const vendors = rows.filter(r => isOverflowAdapter(r.adapter) && routeCallable(r)).sort((a, b) => a.rank - b.rank).map(pick);
  return [...own("matting-gpu"), ...vendors, ...own("matting-cpu")].filter(r => router.circuits.canCall(r.id));
}

/** A failure of the service itself (as opposed to one model on a service that answered): skip the tier's other models. */
const SERVICE_LEVEL = new Set(["rate_limit", "no_response"]);
/** One own-service attempt: the matting client on the route's target only. */
async function ownAttempt(client: MattingClient, route: PlannedRoute, prepared: Prepared, opts: MatteOptions, trace: MattingTrace | undefined): Promise<RouteAttempt<Matte>> {
  try {
    const matte = await client.matte(prepared, route.model, {...opts, targets: [route.adapter === "matting-gpu" ? "gpu" : "cpu"]}, trace);
    return {value: matte, failure: null, costUsd: 0, calls: 1};
  } catch (error) {
    if (error instanceof UnknownMatteModelError) return {value: null, failure: {kind: "model_unavailable", status: null}, costUsd: 0, calls: 0};
    if (error instanceof UnavailableError) return {value: null, failure: {kind: error.status === 429 ? "rate_limit" : (error.status ?? 0) >= 500 ? "server" : "no_response", status: error.status ?? null}, costUsd: 0, calls: 1};
    throw error;
  }
}

/**
 * One overflow attempt: the vendor on the photo's own pixels (lossless PNG, within its size limit), mask back to size.
 * No key: no reservation and no call. The call is recorded (`routing.record`) as soon as the vendor answers or the
 * request ends (also a refusal, a wrong size or a timeout), then the reservation is released once the row is written.
 */
async function vendorAttempt(row: RouteDef, prepared: Prepared, routing: MatteRouting, reason: () => string): Promise<RouteAttempt<Matte>> {
  if (!(routing.vendor?.env ?? process.env).PHOTOROOM_API_KEY?.trim()) return {value: null, failure: {kind: "no_key", status: null}, costUsd: 0, calls: 0};
  const decision = await routing.overflow!.reserve(row);
  if (!decision.ok) {
    routing.log?.("catalog matte overflow refused", {route: row.id, reason: decision.reason, spentUsd: decision.spentUsd, capUsd: decision.capUsd});
    return {value: null, failure: {kind: "over_cap", status: null}, costUsd: 0, calls: 0};
  }
  // A throw before the call is recorded keeps the reservation, so a call that may have been made still counts.
  const long = Math.max(prepared.width, prepared.height), fit = long > PHOTOROOM_MAX_SIDE ? PHOTOROOM_MAX_SIDE / long : 1;
  const sent = {width: Math.max(1, Math.round(prepared.width * fit)), height: Math.max(1, Math.round(prepared.height * fit))};
  let image = sharp(prepared.rgb, {raw: {width: prepared.width, height: prepared.height, channels: 3}});
  if (fit < 1) image = image.resize(sent.width, sent.height, {fit: "fill", kernel: "lanczos3"});
  const started = Date.now();
  const answer = await photoroomMatte(await image.png().toBuffer(), sent, row.priceUsd ?? 0, routing.vendor);
  let recorded = true;
  if (answer.calls) {
    const outcome = answer.value ? "ok" : answer.failure?.kind === "timeout" ? "timeout" : "failed";
    recorded = await routing.record!({routeId: row.id, engine: row.adapter, usd: answer.costUsd, estimated: true, outcome, ms: answer.value?.ms ?? Date.now() - started, reason: answer.value ? reason() : `${reason()}; vendor ${answer.failure?.kind ?? "failed"}`});
  }
  // Once the ledger counts the call, the reservation is released; an unrecorded call keeps counting through it.
  if (recorded) decision.release();
  if (!answer.value) return {...answer, value: null};
  const mask = answer.value;
  const alpha = fit < 1 ? await sharp(mask.alpha, {raw: {width: mask.width, height: mask.height, channels: 1}}).resize(prepared.width, prepared.height, {fit: "fill", kernel: "lanczos3"}).toColourspace("b-w").raw().toBuffer() : mask.alpha;
  return {...answer, value: {alpha, width: prepared.width, height: prepared.height, model: row.model, ms: mask.ms, source: "model", target: null, sentLongSide: Math.max(sent.width, sent.height)}};
}

/**
 * The photo's cut-out through the `image.matte` routes (see the file comment). A photo with its own transparency keeps
 * it (no call). Returns the matte with the route that made it; when every route fails, the simple method's matte
 * (which throws for a photo without a plain background, as before).
 */
export async function matteThroughRoutes(prepared: Prepared, client: MattingClient, routing: MatteRouting, opts: MatteOptions = {}, trace?: MattingTrace): Promise<RoutedMatte> {
  if (prepared.alphaSource) return {alpha: prepared.alphaSource, width: prepared.width, height: prepared.height, model: "alpha_source", ms: 0, source: "alpha_source", target: null, sentLongSide: null, route: {routeId: null}};
  const plan = planMatteRoutes(routing.router, routing.preferred).filter(r => !isOverflowAdapter(r.adapter) || (routing.overflow && routing.record));
  const rowOf = (id: string) => routing.router.routes.find(r => r.id === id)!;
  const down = new Set<RouteAdapter>();
  let firstFailure: string | null = null;
  const reason = () => `own routes unavailable (${firstFailure ?? "none callable"})`;
  const answer = await callRoutes(plan, async route => {
    if (down.has(route.adapter)) return {value: null, failure: {kind: "service_down", status: null}, costUsd: 0, calls: 0};
    const result = isOverflowAdapter(route.adapter) ? await vendorAttempt(rowOf(route.id), prepared, routing, reason) : await ownAttempt(client, route, prepared, opts, trace);
    if (result.failure) {
      firstFailure ??= result.failure.kind;
      if (!isOverflowAdapter(route.adapter) && SERVICE_LEVEL.has(result.failure.kind)) down.add(route.adapter);
    }
    return result;
  }, {router: routing.router, continueOn: () => true});
  if (answer.tried.length > 1 || !answer.ok) routing.log?.("catalog matte route fallback", {...fallbackLogFields(plan, answer, routing.preferred.find(Boolean) ?? "default"), batchId: trace?.batchId, productId: trace?.productId});
  if (!answer.ok || !answer.output || !answer.route) return {...floodFillMatte(prepared), route: {routeId: null}};
  const route = answer.route;
  if (!isOverflowAdapter(route.adapter)) return {...answer.output, route: {routeId: route.id}};
  // M3-F2-R4: every overflow call is logged with its cost and the reason our own routes did not answer.
  const usd = answer.costUsd;
  routing.log?.("catalog matte overflow", {severity: "WARNING", route: route.id, usd, reason: reason(), batchId: trace?.batchId, productId: trace?.productId});
  return {...answer.output, route: {routeId: route.id, overflow: {engine: route.adapter, usd, estimated: true, reason: reason()}}};
}

/**
 * The worker's cut-out: `matteFor` (matte.ts) without routing (eval jobs, unit tests and the guard's model-specific
 * calls), or the routed cut-out when the delivery passes its route table.
 */
export async function routedMatteFor(prepared: Prepared, client: MattingClient | null, model?: string, opts: MatteOptions = {}, trace?: MattingTrace, routing?: MatteRouting): Promise<RoutedMatte> {
  if (!routing || !client) return matteFor(prepared, client, model, opts, trace);
  return matteThroughRoutes(prepared, client, {...routing, preferred: routing.preferred.length ? routing.preferred : [model]}, opts, trace);
}
