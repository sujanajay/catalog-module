import { and, asc, eq, getTableColumns, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { vendorRouteChanges, vendorRoutes, type VendorRouteRow } from "../db/schema";
import { CircuitBreakers } from "./circuit";
import { createRouter, type Router } from "./router";
import { log } from "../log";
import { describeError } from "../retry";
import { BRAND_PHOTO_CAPABILITIES, hasNoTrainingPosition, routeCallable, SEED_ROUTES, type Capability, type RouteDef, type RouteState } from "./routes";

/** Who seeds the table, in `vendor_route_changes.changed_by`. */
export const SEED_ACTOR = "seed";
/** A route-state change (the kill switch, or the harness later) reaches every worker within this long. */
export const ROUTE_TABLE_TTL_MS = 30_000;

const toDef = (row: VendorRouteRow): RouteDef => ({id: row.id, capability: row.capability, rank: row.rank, adapter: row.adapter, model: row.model, paramsVersion: row.paramsVersion,
  priceUsd: row.priceUsd, rateLimitPerMin: row.rateLimitPerMin, region: row.region, licence: row.licence, noTrainingTerms: row.noTrainingTerms, state: row.state, dailyCapUsd: row.dailyCapUsd});

/** Check-then-insert the seed routes (SEED_ROUTES); an existing row is never overwritten, so an admin's switch stays. */
export async function ensureSeedRoutes(db: Db, seeds: readonly RouteDef[] = SEED_ROUTES): Promise<void> {
  for (const seed of seeds) {
    const inserted = await db.insert(vendorRoutes).values(seed).onConflictDoNothing().returning({id: vendorRoutes.id});
    if (inserted.length) await db.insert(vendorRouteChanges).values({routeId: seed.id, capability: seed.capability, fromState: null, toState: seed.state, fromRank: null, toRank: seed.rank, changedBy: SEED_ACTOR, reason: "seed route table (M7-F2-R2)"});
  }
}
/** True (database clock) when a route's kill-switch drill has run past its `restore_at`. */
const drillExpired = sql<boolean>`coalesce(${vendorRoutes.restoreAt} <= now(), false)`;
/**
 * The route table, ordered by capability and rank. A route whose drill has expired reads as its `restoreState` even
 * before the restore is written (restoreExpiredDrills), so a stuck "off" never outlives the drill.
 */
export async function loadRoutes(db: Db, capability?: Capability): Promise<RouteDef[]> {
  const rows = await loadRouteRows(db, capability);
  return rows.map(row => toDef(row.drillExpired && row.restoreState ? {...row, state: row.restoreState} : row));
}
/** The raw rows with their drill fields, for the operator's printout (catalog-route-switch). */
export async function loadRouteRows(db: Db, capability?: Capability): Promise<(VendorRouteRow & {drillExpired: boolean})[]> {
  return db.select({...getTableColumns(vendorRoutes), drillExpired}).from(vendorRoutes).where(capability ? eq(vendorRoutes.capability, capability) : undefined)
    .orderBy(asc(vendorRoutes.capability), asc(vendorRoutes.rank), asc(vendorRoutes.id));
}

/** One process's circuits, shared by every router it builds, so a refresh of the table keeps the circuit state. */
let processCircuits = new CircuitBreakers();
const cache = new WeakMap<Db, {at: number; router: Promise<Router>}>();
/**
 * The process's router for `db`: the table read at most every `ttlMs` (seeded once per process on first read), with
 * the process's circuit breakers. A failed read is not cached, so the next call reads again.
 */
export function routerFor(db: Db, options: {ttlMs?: number; now?: () => number} = {}): Promise<Router> {
  const now = (options.now ?? Date.now)(), hit = cache.get(db);
  if (hit && now - hit.at < (options.ttlMs ?? ROUTE_TABLE_TTL_MS)) return hit.router;
  const router = (async () => {
    if (!hit) await ensureSeedRoutes(db);
    // A failed restore write still routes right: loadRoutes reads an expired drill as restored.
    await restoreExpiredDrills(db).catch(error => log("WARNING", "kill-switch drill restore failed; the router reads the expired drill as restored", {error: describeError(error)}));
    return createRouter(await loadRoutes(db), processCircuits);
  })();
  cache.set(db, {at: now, router});
  router.catch(() => { if (cache.get(db)?.router === router) cache.delete(db); });
  return router;
}
/** Tests: forget the cached table and the circuit state. */
export function resetRouting(db?: Db): void {
  if (db) cache.delete(db);
  processCircuits = new CircuitBreakers();
}

export class RouteChangeError extends Error {}
export interface RouteChange {
  state?: RouteState; rank?: number;
  /** The written no-training position to record (document and date), as the owner decided it (M7-F2-R7). */
  noTrainingTerms?: string;
  /** M3-F2-R3: an overflow route's daily cap in USD (null removes it, so the route is never called again). */
  dailyCapUsd?: number | null;
  changedBy: string; reason: string; runId?: string | null;
}
/**
 * Change one route's state, rank, no-training position or overflow daily cap and log it as `route.changed` (M7 3.2) in one transaction.
 * A route that sends brand photos cannot be `serving` without a written no-training position (M7-F2-R7); with one on
 * file a switched-off route can be switched back on. A manual change ends a running kill-switch drill on that route
 * (its stored expiry is cleared, so the admin's state stays). Workers see the change within ROUTE_TABLE_TTL_MS.
 */
export async function setRoute(db: Db, id: string, change: RouteChange): Promise<RouteDef> {
  if (!change.changedBy.trim() || !change.reason.trim()) throw new RouteChangeError("A route change needs who made it and why.");
  return db.transaction(async tx => {
    const [row] = await tx.select().from(vendorRoutes).where(eq(vendorRoutes.id, id)).for("update");
    if (!row) throw new RouteChangeError(`No route ${id}.`);
    const state = change.state ?? row.state, rank = change.rank ?? row.rank, noTrainingTerms = change.noTrainingTerms?.trim() || row.noTrainingTerms;
    const dailyCapUsd = change.dailyCapUsd === undefined ? row.dailyCapUsd : change.dailyCapUsd;
    if (dailyCapUsd !== null && !(Number.isFinite(dailyCapUsd) && dailyCapUsd >= 0)) throw new RouteChangeError(`Route ${id}: the daily cap must be a number of USD, 0 or more.`);
    if (state === "serving" && BRAND_PHOTO_CAPABILITIES.includes(row.capability) && !hasNoTrainingPosition(noTrainingTerms))
      throw new RouteChangeError(`Route ${id} has no written no-training position, so it cannot serve a capability that sends brand photos.`);
    const [updated] = await tx.update(vendorRoutes).set({state, rank, noTrainingTerms, dailyCapUsd, restoreState: null, restoreAt: null}).where(eq(vendorRoutes.id, id)).returning();
    const notes = [...(noTrainingTerms !== row.noTrainingTerms ? [`no-training position recorded: ${noTrainingTerms}`] : []), ...(dailyCapUsd !== row.dailyCapUsd ? [`daily cap USD ${dailyCapUsd ?? "none"}`] : []),
      ...(row.restoreAt ? ["kill-switch drill ended by this change"] : [])];
    const reason = notes.length ? `${change.reason} (${notes.join("; ")})` : change.reason;
    await tx.insert(vendorRouteChanges).values({routeId: id, capability: row.capability, fromState: row.state, toState: state, fromRank: row.rank, toRank: rank, changedBy: change.changedBy, reason, runId: change.runId ?? null});
    return toDef(updated!);
  });
}
/**
 * The kill switch (M7-F2-R5): turn route 1 of a capability off (the lowest-ranked serving route). Returns the route
 * switched off, or null when the capability has no serving route.
 */
export async function killPrimary(db: Db, capability: Capability, changedBy: string, reason: string): Promise<RouteDef | null> {
  const [primary] = await db.select().from(vendorRoutes).where(and(eq(vendorRoutes.capability, capability), eq(vendorRoutes.state, "serving"))).orderBy(asc(vendorRoutes.rank), asc(vendorRoutes.id)).limit(1);
  return primary ? setRoute(db, primary.id, {state: "off", changedBy, reason}) : null;
}

/** Who writes the restore of a drill that ran past its expiry, in `vendor_route_changes.changed_by`. */
export const DRILL_EXPIRY_ACTOR = "drill-expiry";
/** The longest kill-switch drill, in minutes; the drill job's task timeout covers it. */
export const DRILL_MAX_MINUTES = 360;
export interface DrillStart { minutes: number; changedBy: string; reason: string; runId?: string | null }
export interface Drill { route: RouteDef; restoreAt: Date }
/**
 * The kill-switch drill (M7-F2-R5, R1 exit item 3): turn route 1 of a capability (its first callable route) off until
 * `minutes` from now, stored as `restore_at` on the route, so the router restores it at expiry even if the drill job
 * is stopped. Refused when a drill already runs on the capability, or when no other callable route would be left to
 * fall back to (the drill proves the fallback; it must not take the capability down).
 */
export async function startDrill(db: Db, capability: Capability, drill: DrillStart): Promise<Drill> {
  if (!drill.changedBy.trim() || !drill.reason.trim()) throw new RouteChangeError("A drill needs who runs it and why.");
  if (!Number.isInteger(drill.minutes) || drill.minutes < 1 || drill.minutes > DRILL_MAX_MINUTES)
    throw new RouteChangeError(`A drill lasts a whole number of minutes from 1 to ${DRILL_MAX_MINUTES}.`);
  return db.transaction(async tx => {
    const rows = await tx.select().from(vendorRoutes).where(eq(vendorRoutes.capability, capability)).orderBy(asc(vendorRoutes.rank), asc(vendorRoutes.id)).for("update");
    const running = rows.find(r => r.restoreAt);
    if (running) throw new RouteChangeError(`A drill already runs on ${running.id} until ${running.restoreAt!.toISOString()}.`);
    const callable = rows.filter(r => routeCallable(r));
    const primary = callable[0];
    if (!primary) throw new RouteChangeError(`${capability} has no serving route to turn off.`);
    if (callable.length < 2) throw new RouteChangeError(`${capability} has no other serving route to fall back to, so the drill would stop it.`);
    const [updated] = await tx.update(vendorRoutes).set({state: "off", restoreState: primary.state, restoreAt: sql`now() + make_interval(mins => ${drill.minutes})`})
      .where(eq(vendorRoutes.id, primary.id)).returning();
    const restoreAt = updated!.restoreAt!;
    await tx.insert(vendorRouteChanges).values({routeId: primary.id, capability, fromState: primary.state, toState: "off", fromRank: primary.rank, toRank: primary.rank,
      changedBy: drill.changedBy, reason: `${drill.reason} (kill-switch drill: back to ${primary.state} by ${restoreAt.toISOString()})`, runId: drill.runId ?? null});
    return {route: toDef(updated!), restoreAt};
  });
}
/**
 * End a drill on one route: back to its stored `restoreState`, expiry cleared, logged. Null when no drill runs on the
 * route (already restored at expiry, or ended by a manual change). With `onlyExpired` it ends only a drill past its
 * expiry (the router's restore).
 */
export async function endDrill(db: Db, id: string, end: {changedBy: string; reason: string; runId?: string | null; onlyExpired?: boolean}): Promise<RouteDef | null> {
  return db.transaction(async tx => {
    const [row] = await tx.select({...getTableColumns(vendorRoutes), drillExpired}).from(vendorRoutes).where(eq(vendorRoutes.id, id)).for("update");
    if (!row?.restoreAt || !row.restoreState || (end.onlyExpired && !row.drillExpired)) return null;
    const [updated] = await tx.update(vendorRoutes).set({state: row.restoreState, restoreState: null, restoreAt: null}).where(eq(vendorRoutes.id, id)).returning();
    await tx.insert(vendorRouteChanges).values({routeId: id, capability: row.capability, fromState: row.state, toState: row.restoreState, fromRank: row.rank, toRank: row.rank,
      changedBy: end.changedBy, reason: end.reason, runId: end.runId ?? null});
    return toDef(updated!);
  });
}
/** Write the restore of every drill past its expiry (each once, under a row lock); returns the restored routes. */
export async function restoreExpiredDrills(db: Db): Promise<RouteDef[]> {
  const due = await db.select({id: vendorRoutes.id}).from(vendorRoutes).where(and(isNotNull(vendorRoutes.restoreAt), drillExpired));
  const restored: RouteDef[] = [];
  for (const {id} of due) {
    const route = await endDrill(db, id, {changedBy: DRILL_EXPIRY_ACTOR, reason: "kill-switch drill expired; route restored", onlyExpired: true});
    if (route) restored.push(route);
  }
  return restored;
}
