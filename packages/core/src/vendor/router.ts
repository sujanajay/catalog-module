import { CircuitBreakers } from "./circuit";
import { routeCallable, routeId, type Capability, type RouteAdapter, type RouteDef } from "./routes";

/** A route the call will try: a table row, or the policy's own model when the table has no row for it. */
export interface PlannedRoute { id: string; capability: Capability; rank: number; adapter: RouteAdapter; model: string; fromTable: boolean }
/**
 * The live routing of one process: the route table (the kill switch is a route's `state`) and the circuit breakers.
 * Built by `routerFor` (route-table.ts) from the database; tests build one from rows with `createRouter`.
 */
export interface Router {
  readonly routes: readonly RouteDef[];
  readonly circuits: CircuitBreakers;
}
export function createRouter(routes: readonly RouteDef[], circuits = new CircuitBreakers()): Router {
  return {routes: [...routes].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)), circuits};
}

/**
 * The call order for one item (M7-F2-R2): the policy's preferred models first (the per-brand and per-category choice
 * of the eval suite, `model_policy`), then every other callable route of the capability by rank. A route is callable
 * only when it is `serving` and, for a capability that sends brand photos, has a written no-training position (R7,
 * `routeCallable`): a switched-off, retired or pending route is never called, even when the policy prefers its model,
 * and with a router a preferred model without a row is not called either. Routes whose circuit is open are left out.
 * Without a router the plan is the preferred models alone (unit tests and the eval job, which have no table).
 */
export function planRoutes(router: Router | undefined, capability: Capability, preferred: readonly (string | null | undefined)[]): PlannedRoute[] {
  const rows = router?.routes.filter(r => r.capability === capability) ?? [];
  const planned: PlannedRoute[] = [];
  const add = (route: PlannedRoute) => { if (!planned.some(p => p.id === route.id)) planned.push(route); };
  for (const model of preferred) {
    if (!model) continue;
    const modelRows = rows.filter(r => r.model === model);
    if (!router) add({id: routeId(capability, "openrouter", model), capability, rank: 0, adapter: "openrouter", model, fromTable: false});
    for (const row of modelRows) if (routeCallable(row)) add({...pick(row), fromTable: true});
  }
  for (const row of rows) if (routeCallable(row)) add({...pick(row), fromTable: true});
  return router ? planned.filter(route => router.circuits.canCall(route.id)) : planned;
}
const pick = ({id, capability, rank, adapter, model}: RouteDef) => ({id, capability, rank, adapter, model});

/** Why one route did not answer. `refusal` is a moderation refusal or an empty reply for this item. */
export interface RouteFailure { kind: string; status: number | null; refusal?: boolean }
/** One route's attempt, as an adapter returns it: an answer, or the failure, with what it cost. */
export interface RouteAttempt<T> { value: T | null; failure: RouteFailure | null; costUsd: number; calls: number; usage?: Record<string, unknown> }
/** The interface result (M7 3.3): the output, the route that gave it, cost, time, and the refusal or error. */
export interface CapabilityResult<T> {
  ok: boolean; output: T | null; route: PlannedRoute | null; routeId: string | null; costUsd: number; calls: number; seconds: number;
  refusal: boolean; error: RouteFailure | null;
  /** Every route asked, in order, with its failure (null for the one that answered). */
  tried: {route: PlannedRoute; failure: RouteFailure | null}[];
  usages: Record<string, unknown>[];
}
/**
 * Failures after which the next route is asked (M7-F2-R3): a rate limit or server error that outlasted its back-off,
 * no response (timeout, network), a reply that is still invalid after the JSON retry, the model gone at the vendor
 * (HTTP 404, `model_unavailable`), an image of the wrong size (M7-F2-R3, `wrong_size`), an overflow route over its
 * daily cap (`over_cap`), and a refusal or empty reply
 * (which moves to the next route for this item only). An auth or request error is not: every OpenRouter route shares
 * the key, so the next one would fail the same way.
 */
export const NEXT_ROUTE_KINDS = new Set(["rate_limit", "server", "no_response", "invalid_json", "model_unavailable", "empty_reply", "refusal", "wrong_size", "over_cap"]);
/**
 * Failures that count against a route's circuit. A refusal is about the item, not the route, so it does not; nor does
 * `over_cap` (an overflow route's daily cap is spent: the next route is asked, M3-F2-R3).
 */
export const CIRCUIT_KINDS = new Set(["rate_limit", "server", "no_response", "invalid_json", "model_unavailable", "wrong_size"]);

/**
 * Ask the planned routes in order until one answers (M7-F2-R1 and R3). `attempt` is the adapter call for one route;
 * `index` is 0 for the first route asked, so the caller can give only that one its full back-off and ask the later
 * ones once (fallback adds little time when a route fails fast). `continueOn` replaces NEXT_ROUTE_KINDS for
 * capabilities whose routes share no credential (the cut-out: own services and a vendor each with its own).
 */
export async function callRoutes<T>(plan: readonly PlannedRoute[], attempt: (route: PlannedRoute, index: number) => Promise<RouteAttempt<T>>,
  options: {router?: Router; now?: () => number; continueOn?: (failure: RouteFailure) => boolean} = {}): Promise<CapabilityResult<T>> {
  const now = options.now ?? Date.now, started = now();
  const tried: CapabilityResult<T>["tried"] = [], usages: Record<string, unknown>[] = [];
  let costUsd = 0, calls = 0;
  for (const [index, route] of plan.entries()) {
    const result = await attempt(route, index);
    costUsd += result.costUsd; calls += result.calls;
    if (result.usage) usages.push(result.usage);
    if (result.value !== null) {
      options.router?.circuits.success(route.id);
      tried.push({route, failure: null});
      return {ok: true, output: result.value, route, routeId: route.id, costUsd, calls, seconds: (now() - started) / 1000, refusal: false, error: null, tried, usages};
    }
    const failure = result.failure ?? {kind: "empty_reply", status: null};
    tried.push({route, failure});
    if (CIRCUIT_KINDS.has(failure.kind)) options.router?.circuits.failure(route.id);
    if (!(options.continueOn ?? (f => NEXT_ROUTE_KINDS.has(f.kind)))(failure)) break;
  }
  const last = tried.at(-1)?.failure ?? null;
  return {ok: false, output: null, route: null, routeId: null, costUsd, calls, seconds: (now() - started) / 1000,
    refusal: tried.some(t => t.failure?.refusal === true || t.failure?.kind === "empty_reply"), error: last ?? {kind: "no_route", status: null}, tried, usages};
}

/**
 * The WARNING fields of a call that needed more than one route or had none (logs only): the first route asked and why
 * it failed, the last one asked and its outcome, and every route tried in order.
 */
export function fallbackLogFields(plan: readonly PlannedRoute[], answer: CapabilityResult<unknown>, fallbackModel: string): Record<string, unknown> {
  const opener = answer.tried.find(t => t.failure)?.failure ?? null, last = answer.tried.at(-1);
  return {severity: "WARNING", model: plan[0]?.model ?? fallbackModel, fallbackModel: last?.route.model ?? null, kind: opener?.kind ?? null, status: opener?.status ?? null,
    fallbackKind: last?.failure?.kind ?? null, fallbackStatus: last?.failure?.status ?? null, calls: answer.calls, routes: answer.tried.map(t => ({route: t.route.id, kind: t.failure?.kind ?? "ok"}))};
}
