/**
 * M3-F2-R3 and R4: the daily cap of an overflow vendor route. A route on an overflow adapter (routes.ts
 * OVERFLOW_ADAPTERS) is called only while today's spend (UTC day) plus this call's price stays within its
 * `dailyCapUsd`; a route without a cap is never called. Today's spend is the cost ledger's rows of that engine and kind
 * (every overflow call is recorded there with its cost), plus this process's calls whose rows may not be flushed yet.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogCostEvents, type CostKind } from "../db/schema";
import type { Capability, RouteDef } from "./routes";

/** The ledger kind a capability's calls are recorded under. */
export const CAPABILITY_COST_KIND: Partial<Record<Capability, CostKind>> = {"image.matte": "matte_call", "image.upscale": "upscale_call"};
/**
 * How long a call reserved in this process counts besides the ledger: a delivery flushes its rows at its next claim
 * write, well inside this window. Counting a flushed call twice for a while only stops overflow earlier, never later.
 */
export const OVERFLOW_RESERVATION_MS = 15 * 60_000;

export type OverflowDecision = {ok: true; spentUsd: number; capUsd: number} | {ok: false; reason: "no_cap" | "over_cap"; spentUsd: number; capUsd: number | null};
export interface OverflowGate {
  /** Reserve one call of `route` (its list price) when today's spend leaves room; the reservation is the decision. */
  reserve(route: Pick<RouteDef, "id" | "capability" | "adapter" | "priceUsd" | "dailyCapUsd">): Promise<OverflowDecision>;
}
const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The worker's gate: the ledger for today's recorded spend, a process tally for calls not yet recorded. */
export function ledgerOverflowGate(db: Db, options: {now?: () => Date} = {}): OverflowGate {
  const now = options.now ?? (() => new Date());
  const reserved: {routeId: string; at: number; usd: number}[] = [];
  // One reservation at a time, so parallel photos of this process cannot both take the last room under the cap.
  let turn: Promise<unknown> = Promise.resolve();
  return {
    reserve(route) {
      const decide = async (): Promise<OverflowDecision> => {
        const cap = route.dailyCapUsd, price = route.priceUsd ?? 0, at = now(), kind = CAPABILITY_COST_KIND[route.capability];
        const fresh = reserved.filter(r => +at - r.at < OVERFLOW_RESERVATION_MS);
        reserved.splice(0, reserved.length, ...fresh);
        const pending = fresh.filter(r => r.routeId === route.id).reduce((sum, r) => sum + r.usd, 0);
        const [row] = kind ? await db.select({usd: sql<string>`coalesce(sum(${catalogCostEvents.usd}), 0)`}).from(catalogCostEvents)
          .where(and(eq(catalogCostEvents.engine, route.adapter), eq(catalogCostEvents.kind, kind), gte(catalogCostEvents.at, dayStart(at)))) : [];
        const spentUsd = Number(row?.usd ?? 0) + pending;
        if (cap === null || cap === undefined) return {ok: false, reason: "no_cap", spentUsd, capUsd: null};
        if (spentUsd + price > cap + 1e-9) return {ok: false, reason: "over_cap", spentUsd, capUsd: cap};
        reserved.push({routeId: route.id, at: +at, usd: price});
        return {ok: true, spentUsd, capUsd: cap};
      };
      const result = turn.then(decide, decide);
      turn = result.catch(() => {});
      return result;
    },
  };
}
