import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { vendorRouteChanges, vendorRoutes, type VendorRouteRow } from "../db/schema";
import { CircuitBreakers } from "./circuit";
import { createRouter, type Router } from "./router";
import { BRAND_PHOTO_CAPABILITIES, hasNoTrainingPosition, SEED_ROUTES, type Capability, type RouteDef, type RouteState } from "./routes";

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
export async function loadRoutes(db: Db, capability?: Capability): Promise<RouteDef[]> {
  const rows = await db.select().from(vendorRoutes).where(capability ? eq(vendorRoutes.capability, capability) : undefined).orderBy(asc(vendorRoutes.capability), asc(vendorRoutes.rank), asc(vendorRoutes.id));
  return rows.map(toDef);
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
 * file a switched-off route can be switched back on (the kill-switch drill's restore). Workers see the change within
 * ROUTE_TABLE_TTL_MS.
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
    const [updated] = await tx.update(vendorRoutes).set({state, rank, noTrainingTerms, dailyCapUsd}).where(eq(vendorRoutes.id, id)).returning();
    const notes = [...(noTrainingTerms !== row.noTrainingTerms ? [`no-training position recorded: ${noTrainingTerms}`] : []), ...(dailyCapUsd !== row.dailyCapUsd ? [`daily cap USD ${dailyCapUsd ?? "none"}`] : [])];
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
