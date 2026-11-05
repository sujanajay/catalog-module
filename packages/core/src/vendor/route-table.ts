import { randomUUID } from "node:crypto";
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
 * file a switched-off route can be switched back on. A kill-switch drill on the route: an expired one is restored
 * first; a running one ends only when this change sets the state (the admin's state then stays past the old expiry),
 * and stays in force for any other change (rank, position, cap), so its restore still comes. Workers see the change
 * within ROUTE_TABLE_TTL_MS.
 */
export async function setRoute(db: Db, id: string, change: RouteChange): Promise<RouteDef> {
  if (!change.changedBy.trim() || !change.reason.trim()) throw new RouteChangeError("A route change needs who made it and why.");
  await endDrill(db, id, {changedBy: DRILL_EXPIRY_ACTOR, reason: DRILL_EXPIRED_REASON, onlyExpired: true});
  return db.transaction(async tx => {
    const [row] = await tx.select().from(vendorRoutes).where(eq(vendorRoutes.id, id)).for("update");
    if (!row) throw new RouteChangeError(`No route ${id}.`);
    const state = change.state ?? row.state, rank = change.rank ?? row.rank, noTrainingTerms = change.noTrainingTerms?.trim() || row.noTrainingTerms;
    const dailyCapUsd = change.dailyCapUsd === undefined ? row.dailyCapUsd : change.dailyCapUsd;
    if (dailyCapUsd !== null && !(Number.isFinite(dailyCapUsd) && dailyCapUsd >= 0)) throw new RouteChangeError(`Route ${id}: the daily cap must be a number of USD, 0 or more.`);
    if (state === "serving" && BRAND_PHOTO_CAPABILITIES.includes(row.capability) && !hasNoTrainingPosition(noTrainingTerms))
      throw new RouteChangeError(`Route ${id} has no written no-training position, so it cannot serve a capability that sends brand photos.`);
    const endsDrill = !!row.drillId && change.state !== undefined;
    const [updated] = await tx.update(vendorRoutes).set({state, rank, noTrainingTerms, dailyCapUsd, ...(endsDrill ? NO_DRILL : {})}).where(eq(vendorRoutes.id, id)).returning();
    const notes = [...(noTrainingTerms !== row.noTrainingTerms ? [`no-training position recorded: ${noTrainingTerms}`] : []), ...(dailyCapUsd !== row.dailyCapUsd ? [`daily cap USD ${dailyCapUsd ?? "none"}`] : []),
      ...(endsDrill ? ["kill-switch drill ended by this change"] : [])];
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
const DRILL_EXPIRED_REASON = "kill-switch drill expired; route restored";
const NO_DRILL = {restoreState: null, restoreAt: null, drillId: null} as const;
/** The longest kill-switch drill, in minutes; the drill job's task timeout covers it. */
export const DRILL_MAX_MINUTES = 360;
export interface DrillStart {
  minutes: number; changedBy: string; reason: string; runId?: string | null;
  /** The route to turn off (it must be callable in this capability); default the capability's first callable route. */
  routeId?: string;
}
export interface Drill { route: RouteDef; restoreAt: Date; drillId: string }
/**
 * The kill-switch drill (M7-F2-R5, R1 exit item 3): turn one route of a capability off (default its first callable
 * route) until `minutes` from now. The drill is recorded on the route (`drill_id`, `restore_state`, `restore_at`), so
 * the router restores it at expiry even if the drill job is stopped, and only that drill or its expiry ends it. A
 * drill past its expiry that nobody restored yet is restored first. Refused when a drill still runs on the capability,
 * or when no other callable route would be left to fall back to (the drill proves the fallback; it must not take the
 * capability down).
 */
export async function startDrill(db: Db, capability: Capability, drill: DrillStart): Promise<Drill> {
  if (!drill.changedBy.trim() || !drill.reason.trim()) throw new RouteChangeError("A drill needs who runs it and why.");
  if (!Number.isInteger(drill.minutes) || drill.minutes < 1 || drill.minutes > DRILL_MAX_MINUTES)
    throw new RouteChangeError(`A drill lasts a whole number of minutes from 1 to ${DRILL_MAX_MINUTES}.`);
  await restoreExpiredDrills(db, capability);
  return db.transaction(async tx => {
    const rows = await tx.select().from(vendorRoutes).where(eq(vendorRoutes.capability, capability)).orderBy(asc(vendorRoutes.rank), asc(vendorRoutes.id)).for("update");
    const running = rows.find(r => r.drillId);
    if (running) throw new RouteChangeError(`A drill already runs on ${running.id} until ${running.restoreAt!.toISOString()}.`);
    const callable = rows.filter(r => routeCallable(r));
    const target = drill.routeId ? rows.find(r => r.id === drill.routeId) : callable[0];
    if (drill.routeId && !target) throw new RouteChangeError(`No ${capability} route ${drill.routeId}.`);
    if (!target || !routeCallable(target)) throw new RouteChangeError(`${drill.routeId ?? capability} has no serving route to turn off.`);
    if (!callable.some(r => r.id !== target.id)) throw new RouteChangeError(`${capability} has no other serving route to fall back to, so the drill would stop it.`);
    const drillId = randomUUID();
    const [updated] = await tx.update(vendorRoutes).set({state: "off", restoreState: target.state, restoreAt: sql`now() + make_interval(mins => ${drill.minutes})`, drillId})
      .where(eq(vendorRoutes.id, target.id)).returning();
    const restoreAt = updated!.restoreAt!;
    await tx.insert(vendorRouteChanges).values({routeId: target.id, capability, fromState: target.state, toState: "off", fromRank: target.rank, toRank: target.rank,
      changedBy: drill.changedBy, reason: `${drill.reason} (kill-switch drill ${drillId}: back to ${target.state} by ${restoreAt.toISOString()})`, runId: drill.runId ?? null});
    return {route: toDef(updated!), restoreAt, drillId};
  });
}
/**
 * End a drill on one route: back to its stored `restoreState` (or `registered` when the route lost its no-training
 * position meanwhile, so the R7 rule still holds), drill record cleared, logged. Null when no drill runs on the route,
 * or when `drillId` is given and another drill runs there (a late drill job never ends someone else's drill). With
 * `onlyExpired` it ends only a drill past its expiry (the router's restore).
 */
export async function endDrill(db: Db, id: string, end: {changedBy: string; reason: string; runId?: string | null; drillId?: string; onlyExpired?: boolean}): Promise<RouteDef | null> {
  return db.transaction(async tx => {
    const [row] = await tx.select({...getTableColumns(vendorRoutes), drillExpired}).from(vendorRoutes).where(eq(vendorRoutes.id, id)).for("update");
    if (!row?.drillId || !row.restoreState || (end.drillId && row.drillId !== end.drillId) || (end.onlyExpired && !row.drillExpired)) return null;
    const state = row.restoreState === "serving" && !routeCallable({...row, state: "serving"}) ? "registered" : row.restoreState;
    const [updated] = await tx.update(vendorRoutes).set({state, ...NO_DRILL}).where(eq(vendorRoutes.id, id)).returning();
    const reason = state === row.restoreState ? end.reason : `${end.reason} (registered, not serving: no written no-training position on file)`;
    await tx.insert(vendorRouteChanges).values({routeId: id, capability: row.capability, fromState: row.state, toState: state, fromRank: row.rank, toRank: row.rank,
      changedBy: end.changedBy, reason, runId: end.runId ?? null});
    return toDef(updated!);
  });
}
/** Write the restore of every drill past its expiry (each once, under a row lock); returns the restored routes. */
export async function restoreExpiredDrills(db: Db, capability?: Capability): Promise<RouteDef[]> {
  const due = await db.select({id: vendorRoutes.id}).from(vendorRoutes)
    .where(and(isNotNull(vendorRoutes.drillId), drillExpired, capability ? eq(vendorRoutes.capability, capability) : undefined));
  const restored: RouteDef[] = [];
  for (const {id} of due) {
    const route = await endDrill(db, id, {changedBy: DRILL_EXPIRY_ACTOR, reason: DRILL_EXPIRED_REASON, onlyExpired: true});
    if (route) restored.push(route);
  }
  return restored;
}
