/**
 * M3-S5: background removal behind the M7 vendor interface (M3-F2-R1 to R4, M7-F2). One photo's cut-out asks the
 * `image.matte` routes in this order (decision D8):
 *   1. the policy's models, then the other served models, on the GPU services (`matting-gpu`);
 *   2. the overflow vendor (`photoroom`), only when its route is serving, has a no-training position on file and its
 *      daily cap leaves room (shipped off);
 *   3. the same models on the CPU cut-out service (`matting-cpu`), today's fallback.
 * Every route honours the kill switch (`state`) and its circuit. When no route answers, the simple method
 * (floodFillMatte) is used as before and the photo carries `fallback_matte` (M1-F3 decides what is delivered).
 */
import sharp from "sharp";
import type { Matte, Prepared } from "./render";
import { floodFillMatte, matteFor, UnavailableError, UnknownMatteModelError, type MattingClient, type MatteOptions, type MattingTrace } from "./matte";
import { callRoutes, fallbackLogFields, type PlannedRoute, type RouteAttempt, type Router } from "../vendor/router";
import { isOverflowAdapter, routeCallable, routeId, type RouteAdapter, type RouteDef } from "../vendor/routes";
import { PHOTOROOM_MAX_SIDE, photoroomMatte, type PhotoroomDeps } from "../vendor/adapters/photoroom";
import type { OverflowGate } from "../vendor/overflow";

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
  /** The vendor adapters' HTTP client and env (tests pass fakes). */
  vendor?: PhotoroomDeps;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Call order tiers (D8): GPU, then the overflow vendor, then the CPU service. */
const TIER: Record<RouteAdapter, number> = {"matting-gpu": 0, photoroom: 1, "matting-cpu": 2, openrouter: 9, "upscale-gpu": 9, "upscale-cpu": 9};
const OWN_ADAPTERS = ["matting-gpu", "matting-cpu"] as const;

/**
 * The cut-out plan for one photo: preferred models first and then the other callable routes by rank, within each tier.
 * A preferred model the table has no row for (a policy naming a model the table does not know) is still asked on our own
 * services, so the per-category policy keeps working; it cannot be switched off from the table.
 */
export function planMatteRoutes(router: Router, preferred: readonly (string | null | undefined)[]): PlannedRoute[] {
  const rows = router.routes.filter(r => r.capability === "image.matte");
  const plan: PlannedRoute[] = [];
  const add = (route: PlannedRoute) => { if (!plan.some(p => p.id === route.id)) plan.push(route); };
  const pick = (r: RouteDef): PlannedRoute => ({id: r.id, capability: r.capability, rank: r.rank, adapter: r.adapter, model: r.model, fromTable: true});
  for (const model of preferred) {
    if (!model) continue;
    const modelRows = rows.filter(r => r.model === model);
    if (!modelRows.length) for (const adapter of OWN_ADAPTERS) add({id: routeId("image.matte", adapter, model), capability: "image.matte", rank: 0, adapter, model, fromTable: false});
    for (const row of modelRows) if (routeCallable(row)) add(pick(row));
  }
  for (const row of rows) if (routeCallable(row)) add(pick(row));
  return plan.filter(r => router.circuits.canCall(r.id)).map((r, i) => ({r, i})).sort((a, b) => TIER[a.r.adapter] - TIER[b.r.adapter] || a.i - b.i).map(({r}) => r);
}

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

/** One overflow attempt: the vendor on the photo's own pixels (lossless PNG, within its size limit), mask back to size. */
async function vendorAttempt(row: RouteDef, prepared: Prepared, routing: MatteRouting): Promise<RouteAttempt<Matte>> {
  const decision = await routing.overflow!.reserve(row);
  if (!decision.ok) {
    routing.log?.("catalog matte overflow refused", {route: row.id, reason: decision.reason, spentUsd: decision.spentUsd, capUsd: decision.capUsd});
    return {value: null, failure: {kind: "over_cap", status: null}, costUsd: 0, calls: 0};
  }
  const long = Math.max(prepared.width, prepared.height), fit = long > PHOTOROOM_MAX_SIDE ? PHOTOROOM_MAX_SIDE / long : 1;
  const sent = {width: Math.max(1, Math.round(prepared.width * fit)), height: Math.max(1, Math.round(prepared.height * fit))};
  let image = sharp(prepared.rgb, {raw: {width: prepared.width, height: prepared.height, channels: 3}});
  if (fit < 1) image = image.resize(sent.width, sent.height, {fit: "fill", kernel: "lanczos3"});
  const answer = await photoroomMatte(await image.png().toBuffer(), sent, row.priceUsd ?? 0, routing.vendor);
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
  const plan = planMatteRoutes(routing.router, routing.preferred).filter(r => !isOverflowAdapter(r.adapter) || routing.overflow);
  const rowOf = (id: string) => routing.router.routes.find(r => r.id === id)!;
  const answer = await callRoutes(plan, route => isOverflowAdapter(route.adapter) ? vendorAttempt(rowOf(route.id), prepared, routing) : ownAttempt(client, route, prepared, opts, trace), {router: routing.router, continueOn: () => true});
  const firstFailure = answer.tried.find(t => t.failure)?.failure ?? null;
  if (answer.tried.length > 1 || !answer.ok) routing.log?.("catalog matte route fallback", {...fallbackLogFields(plan, answer, routing.preferred.find(Boolean) ?? "default"), batchId: trace?.batchId, productId: trace?.productId});
  if (!answer.ok || !answer.output || !answer.route) return {...floodFillMatte(prepared), route: {routeId: null}};
  const route = answer.route;
  if (!isOverflowAdapter(route.adapter)) return {...answer.output, route: {routeId: route.id}};
  // M3-F2-R4: every overflow call is logged with its cost and the reason our own routes did not answer.
  const reason = `own routes unavailable (${firstFailure?.kind ?? "none callable"})`;
  routing.log?.("catalog matte overflow", {severity: "WARNING", route: route.id, usd: answer.costUsd, reason, batchId: trace?.batchId, productId: trace?.productId});
  return {...answer.output, route: {routeId: route.id, overflow: {engine: route.adapter, usd: answer.costUsd, estimated: true, reason}}};
}

/**
 * The worker's cut-out: `matteFor` (matte.ts) without routing (eval jobs, unit tests and the guard's model-specific
 * calls), or the routed cut-out when the delivery passes its route table.
 */
export async function routedMatteFor(prepared: Prepared, client: MattingClient | null, model?: string, opts: MatteOptions = {}, trace?: MattingTrace, routing?: MatteRouting): Promise<RoutedMatte> {
  if (!routing || !client) return matteFor(prepared, client, model, opts, trace);
  return matteThroughRoutes(prepared, client, {...routing, preferred: routing.preferred.length ? routing.preferred : [model]}, opts, trace);
}
