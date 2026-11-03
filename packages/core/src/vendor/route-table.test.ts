import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { vendorRouteChanges, vendorRoutes } from "../db/schema";
import { ensureSeedRoutes, killPrimary, loadRoutes, resetRouting, RouteChangeError, routerFor, setRoute } from "./route-table";
import { planRoutes } from "./router";
import { SEED_ROUTES } from "./routes";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({db, close} = await createTestDb()); }, 120_000);
afterAll(async () => close());
beforeEach(async () => { await db.delete(vendorRouteChanges); await db.delete(vendorRoutes); resetRouting(db); });

describe("M7-F2 route table", () => {
  it("seeds check-then-insert: a re-run adds nothing and keeps an admin's switch", async () => {
    await ensureSeedRoutes(db);
    await setRoute(db, SEED_ROUTES[0]!.id, {state: "off", changedBy: "admin@opptra.com", reason: "drill"});
    await ensureSeedRoutes(db);
    const rows = await loadRoutes(db);
    expect(rows).toHaveLength(SEED_ROUTES.length);
    expect(rows.find(r => r.id === SEED_ROUTES[0]!.id)!.state).toBe("off");
    const seeded = await db.select().from(vendorRouteChanges).where(eq(vendorRouteChanges.changedBy, "seed"));
    expect(seeded).toHaveLength(SEED_ROUTES.length);
  });
  it("the kill switch turns route 1 off and logs route.changed with who and why", async () => {
    await ensureSeedRoutes(db);
    const killed = await killPrimary(db, "judge.render", "admin@opptra.com", "monthly kill-the-primary drill");
    expect(killed).toMatchObject({rank: 1, state: "off", model: "google/gemini-2.5-flash-lite"});
    const [change] = await db.select().from(vendorRouteChanges).where(eq(vendorRouteChanges.toState, "off")).orderBy(asc(vendorRouteChanges.at));
    expect(change).toMatchObject({routeId: killed!.id, capability: "judge.render", fromState: "serving", toState: "off", changedBy: "admin@opptra.com", reason: "monthly kill-the-primary drill"});
    // The classifier's routes are separate: vision.read still has its route 1.
    expect((await loadRoutes(db, "vision.read")).every(r => r.state === "serving")).toBe(true);
    // Switched off again: the next serving route is now route 1.
    expect(await killPrimary(db, "judge.render", "admin@opptra.com", "second")).toMatchObject({rank: 2});
  });
  it("a brand-photo route cannot become serving without a written no-training position (R7); a change needs who and why", async () => {
    await ensureSeedRoutes(db);
    const id = SEED_ROUTES[2]!.id;
    await setRoute(db, id, {state: "off", changedBy: "admin@opptra.com", reason: "drill"});
    await expect(setRoute(db, id, {state: "serving", changedBy: "admin@opptra.com", reason: "back"})).rejects.toBeInstanceOf(RouteChangeError);
    await db.update(vendorRoutes).set({noTrainingTerms: "Vendor DPA section 4, no training on customer inputs (2026-11-03)"}).where(eq(vendorRoutes.id, id));
    expect(await setRoute(db, id, {state: "serving", changedBy: "admin@opptra.com", reason: "back"})).toMatchObject({state: "serving"});
    await expect(setRoute(db, id, {state: "off", changedBy: " ", reason: "x"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(setRoute(db, "no-such-route", {state: "off", changedBy: "a", reason: "b"})).rejects.toBeInstanceOf(RouteChangeError);
  });
  it("routerFor seeds on first read and picks up a switch after its cache window", async () => {
    let now = 0;
    const clock = {now: () => now};
    const first = await routerFor(db, clock);
    expect(planRoutes(first, "judge.render", []).map(r => r.rank)).toEqual([1, 2, 3]);
    await killPrimary(db, "judge.render", "admin@opptra.com", "drill");
    now += 1_000;
    expect(await routerFor(db, clock)).toBe(first);
    now += 30_000;
    const fresh = await routerFor(db, clock);
    expect(planRoutes(fresh, "judge.render", []).map(r => r.rank)).toEqual([2, 3]);
    expect(fresh.circuits).toBe(first.circuits);
  });
});
