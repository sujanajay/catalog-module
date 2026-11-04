import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { vendorRouteChanges, vendorRoutes } from "../db/schema";
import { ensureSeedRoutes, killPrimary, loadRoutes, resetRouting, RouteChangeError, routerFor, setRoute } from "./route-table";
import { planRoutes } from "./router";
import { IMAGE_SEED_ROUTES, NO_TRAINING_PENDING, OPENROUTER_NO_TRAINING_POSITION, OWN_SERVICE_NO_TRAINING_POSITION, PHOTOROOM_MATTE_MODEL, routeId, SEED_ROUTES } from "./routes";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({db, close} = await createTestDb()); }, 120_000);
afterAll(async () => close());
beforeEach(async () => { await db.delete(vendorRouteChanges); await db.delete(vendorRoutes); resetRouting(db); });

const ADMIN = "admin@opptra.com";
/** The owner's decision, recorded as data: a written position on every judge and reader route, then serving. */
async function recordPositions() {
  await ensureSeedRoutes(db);
  for (const seed of SEED_ROUTES) await setRoute(db, seed.id, {noTrainingTerms: "test: vendor terms section 4 (2026-11-03)", state: "serving", changedBy: ADMIN, reason: "owner decision"});
}
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
  it("seeds every OpenRouter route serving with the owner's recorded no-training position (R7, decision 2026-11-03)", async () => {
    await ensureSeedRoutes(db);
    expect((await loadRoutes(db)).filter(r => r.adapter === "openrouter").every(r => r.state === "serving" && r.noTrainingTerms === OPENROUTER_NO_TRAINING_POSITION)).toBe(true);
    expect(planRoutes(await routerFor(db), "judge.render", ["google/gemini-2.5-flash-lite"]).map(r => r.rank)).toEqual([1, 2, 3]);
    expect(planRoutes(await routerFor(db), "vision.read", []).map(r => r.rank)).toEqual([1, 2, 3]);
  });
  it("R7 stays enforced: a pending or blank position is refused as serving by setRoute and by the database itself", async () => {
    await ensureSeedRoutes(db);
    const id = SEED_ROUTES[0]!.id;
    await setRoute(db, id, {state: "registered", noTrainingTerms: NO_TRAINING_PENDING, changedBy: ADMIN, reason: "position withdrawn"});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([2, 3]);
    await expect(setRoute(db, id, {state: "serving", changedBy: ADMIN, reason: "on"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(setRoute(db, id, {state: "serving", noTrainingTerms: "Pending legal", changedBy: ADMIN, reason: "on"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(db.execute(sql`update vendor_routes set state = 'serving' where id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`update vendor_routes set no_training_terms = ' ' where id = ${SEED_ROUTES[1]!.id}`)).rejects.toThrow();
  });
  it("recording the owner's position is a data change that switches the route on, logged with the position", async () => {
    await ensureSeedRoutes(db);
    for (const seed of SEED_ROUTES) await setRoute(db, seed.id, {state: "registered", noTrainingTerms: NO_TRAINING_PENDING, changedBy: ADMIN, reason: "awaiting decision"});
    await recordPositions();
    expect((await loadRoutes(db)).filter(r => r.adapter === "openrouter").every(r => r.state === "serving" && r.noTrainingTerms!.startsWith("test:"))).toBe(true);
    const [change] = await db.select().from(vendorRouteChanges).where(and(eq(vendorRouteChanges.toState, "serving"), eq(vendorRouteChanges.reason, "owner decision (no-training position recorded: test: vendor terms section 4 (2026-11-03))"))).limit(1);
    expect(change).toMatchObject({fromState: "registered", changedBy: ADMIN});
    expect(change!.reason).toMatch(/no-training position recorded: test: vendor terms/);
  });
  it("the kill switch turns route 1 off and logs route.changed with who and why", async () => {
    await recordPositions();
    const killed = await killPrimary(db, "judge.render", "admin@opptra.com", "monthly kill-the-primary drill");
    expect(killed).toMatchObject({rank: 1, state: "off", model: "google/gemini-2.5-flash-lite"});
    const [change] = await db.select().from(vendorRouteChanges).where(and(eq(vendorRouteChanges.toState, "off"), eq(vendorRouteChanges.changedBy, "admin@opptra.com"))).orderBy(asc(vendorRouteChanges.at));
    expect(change).toMatchObject({routeId: killed!.id, capability: "judge.render", fromState: "serving", toState: "off", changedBy: "admin@opptra.com", reason: "monthly kill-the-primary drill"});
    // The classifier's routes are separate: vision.read still has its route 1.
    expect((await loadRoutes(db, "vision.read")).every(r => r.state === "serving")).toBe(true);
    // Switched off again: the next serving route is now route 1.
    expect(await killPrimary(db, "judge.render", "admin@opptra.com", "second")).toMatchObject({rank: 2});
  });
  it("a killed route can be switched back on (the drill's restore); a change needs who and why", async () => {
    await recordPositions();
    const killed = await killPrimary(db, "judge.render", ADMIN, "monthly drill");
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([2, 3]);
    expect(await setRoute(db, killed!.id, {state: "serving", changedBy: ADMIN, reason: "drill over"})).toMatchObject({state: "serving", rank: 1});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([1, 2, 3]);
    const id = killed!.id;
    await expect(setRoute(db, id, {state: "off", changedBy: " ", reason: "x"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(setRoute(db, "no-such-route", {state: "off", changedBy: "a", reason: "b"})).rejects.toBeInstanceOf(RouteChangeError);
  });
  it("routerFor seeds on first read and picks up a switch after its cache window", async () => {
    await recordPositions();
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

describe("M3-S5 image routes and the overflow switch (M3-F2-R3)", () => {
  const VENDOR = routeId("image.matte", "photoroom", PHOTOROOM_MATTE_MODEL);
  it("seeds the cut-out and enlargement routes: own services serving with their position, the vendor off and pending", async () => {
    await ensureSeedRoutes(db);
    const rows = await loadRoutes(db);
    expect(rows.filter(r => r.adapter === "matting-gpu" || r.adapter === "matting-cpu" || r.adapter === "upscale-gpu").every(r => r.state === "serving" && r.noTrainingTerms === OWN_SERVICE_NO_TRAINING_POSITION)).toBe(true);
    expect(rows.filter(r => r.adapter === "photoroom")).toEqual(IMAGE_SEED_ROUTES.filter(r => r.adapter === "photoroom").map(r => expect.objectContaining({id: r.id, state: "off", noTrainingTerms: NO_TRAINING_PENDING, dailyCapUsd: null})));
  });
  it("switching overflow on is a logged data change: the position, serving and a daily cap; the database refuses it without a position", async () => {
    await ensureSeedRoutes(db);
    await expect(setRoute(db, VENDOR, {state: "serving", dailyCapUsd: 1, changedBy: ADMIN, reason: "overflow on"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(db.execute(sql`update vendor_routes set state = 'serving' where id = ${VENDOR}`)).rejects.toThrow();
    await expect(setRoute(db, VENDOR, {dailyCapUsd: -1, changedBy: ADMIN, reason: "bad cap"})).rejects.toBeInstanceOf(RouteChangeError);
    const on = await setRoute(db, VENDOR, {state: "serving", noTrainingTerms: "test: vendor DPA section 7 (2031-01-01)", dailyCapUsd: 1, changedBy: ADMIN, reason: "overflow on for the test account"});
    expect(on).toMatchObject({state: "serving", dailyCapUsd: 1});
    const [change] = await db.select().from(vendorRouteChanges).where(and(eq(vendorRouteChanges.routeId, VENDOR), eq(vendorRouteChanges.toState, "serving")));
    expect(change!.reason).toMatch(/overflow on for the test account \(no-training position recorded: test: vendor DPA.*; daily cap USD 1\)/);
    expect((await setRoute(db, VENDOR, {dailyCapUsd: null, changedBy: ADMIN, reason: "cap removed"})).dailyCapUsd).toBeNull();
  });
});
