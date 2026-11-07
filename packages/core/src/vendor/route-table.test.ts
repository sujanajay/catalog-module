import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, asc, eq, sql } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { modelPolicy, vendorRouteChanges, vendorRoutes } from "../db/schema";
import { DRILL_EXPIRY_ACTOR, DRILL_MAX_MINUTES, endDrill, ensureSeedRoutes, killPrimary, loadRouteRows, loadRoutes, resetRouting, restoreExpiredDrills, RouteChangeError, routerFor, setRoute, startDrill } from "./route-table";
import { createRouter, planRoutes } from "./router";
import { IMAGE_SEED_ROUTES, NO_TRAINING_PENDING, OPENROUTER_NO_TRAINING_POSITION, OWN_SERVICE_NO_TRAINING_POSITION, PHOTOROOM_MATTE_MODEL, routeId, SEED_ROUTES } from "./routes";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({db, close} = await createTestDb()); }, 120_000);
afterAll(async () => close());
beforeEach(async () => { await db.delete(vendorRouteChanges); await db.delete(vendorRoutes); resetRouting(db); });

const ADMIN = "admin@opptra.com";
const JUDGES = {first: "anthropic/claude-haiku-5.5", second: "google/gemini-3.8-flash", retired: "google/gemini-2.5-flash-lite", qwen: "qwen/qwen3-vl-30b-a3b-instruct"};
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
    expect(planRoutes(await routerFor(db), "judge.render", [JUDGES.first]).map(r => r.rank)).toEqual([1, 2]);
    expect(planRoutes(await routerFor(db), "vision.read", []).map(r => r.rank)).toEqual([1, 2, 3]);
  });
  it("R7 stays enforced: a pending or blank position is refused as serving by setRoute and by the database itself", async () => {
    await ensureSeedRoutes(db);
    const id = SEED_ROUTES[0]!.id;
    await setRoute(db, id, {state: "registered", noTrainingTerms: NO_TRAINING_PENDING, changedBy: ADMIN, reason: "position withdrawn"});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([2]);
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
    expect(killed).toMatchObject({rank: 1, state: "off", model: JUDGES.first});
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
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([2]);
    expect(await setRoute(db, killed!.id, {state: "serving", changedBy: ADMIN, reason: "drill over"})).toMatchObject({state: "serving", rank: 1});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([1, 2]);
    const id = killed!.id;
    await expect(setRoute(db, id, {state: "off", changedBy: " ", reason: "x"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(setRoute(db, "no-such-route", {state: "off", changedBy: "a", reason: "b"})).rejects.toBeInstanceOf(RouteChangeError);
  });
  it("routerFor seeds on first read and picks up a switch after its cache window", async () => {
    await recordPositions();
    let now = 0;
    const clock = {now: () => now};
    const first = await routerFor(db, clock);
    expect(planRoutes(first, "judge.render", []).map(r => r.rank)).toEqual([1, 2]);
    await killPrimary(db, "judge.render", "admin@opptra.com", "drill");
    now += 1_000;
    expect(await routerFor(db, clock)).toBe(first);
    now += 30_000;
    const fresh = await routerFor(db, clock);
    expect(planRoutes(fresh, "judge.render", []).map(r => r.rank)).toEqual([2]);
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

describe("R1 exit item 3: the kill-switch drill with a stored expiry (M7-F2-R5)", () => {
  const JUDGE_1 = () => SEED_ROUTES.find(r => r.capability === "judge.render" && r.rank === 1)!.id;
  /** Move a running drill's expiry into the past, as if its minutes had run out. */
  const expire = (id: string) => db.execute(sql`update vendor_routes set restore_at = now() - interval '1 minute' where id = ${id}`);
  const changes = (id: string) => db.select().from(vendorRouteChanges).where(eq(vendorRouteChanges.routeId, id)).orderBy(asc(vendorRouteChanges.at));

  it("turns route 1 off with a stored expiry and logs who, why and until when", async () => {
    await recordPositions();
    const drill = await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "R1 drill", runId: "drill-1"});
    expect(drill.route).toMatchObject({id: JUDGE_1(), rank: 1, state: "off"});
    const minutes = (drill.restoreAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30.5);
    const [row] = await loadRouteRows(db, "judge.render");
    expect(row).toMatchObject({id: JUDGE_1(), state: "off", restoreState: "serving", drillExpired: false});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([2]);
    expect((await changes(JUDGE_1())).at(-1)).toMatchObject({fromState: "serving", toState: "off", changedBy: ADMIN, runId: "drill-1", reason: expect.stringMatching(/^R1 drill \(kill-switch drill [0-9a-f-]{36}: back to serving by /)});
  });
  it("refuses a second drill, a bad length, a missing who or why, and a drill with no route left to fall back to", async () => {
    await recordPositions();
    await expect(startDrill(db, "judge.render", {minutes: 0, changedBy: ADMIN, reason: "x"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(startDrill(db, "judge.render", {minutes: DRILL_MAX_MINUTES + 1, changedBy: ADMIN, reason: "x"})).rejects.toBeInstanceOf(RouteChangeError);
    await expect(startDrill(db, "judge.render", {minutes: 5, changedBy: " ", reason: "x"})).rejects.toBeInstanceOf(RouteChangeError);
    await startDrill(db, "judge.render", {minutes: 5, changedBy: ADMIN, reason: "first"});
    await expect(startDrill(db, "judge.render", {minutes: 5, changedBy: ADMIN, reason: "second"})).rejects.toThrow(/already runs/);
    const visionRoutes = (await loadRoutes(db, "vision.read")).slice(1);
    for (const r of visionRoutes) await setRoute(db, r.id, {state: "off", changedBy: ADMIN, reason: "only route 1 left"});
    await expect(startDrill(db, "vision.read", {minutes: 5, changedBy: ADMIN, reason: "x"})).rejects.toThrow(/no other serving route/);
    expect((await loadRoutes(db, "vision.read"))[0]!.state).toBe("serving");
  });
  it("restore: ending the drill puts route 1 back once; a second end is a no-op", async () => {
    await recordPositions();
    await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "drill"});
    expect(await endDrill(db, JUDGE_1(), {changedBy: ADMIN, reason: "batch done"})).toMatchObject({state: "serving", rank: 1});
    expect(await endDrill(db, JUDGE_1(), {changedBy: ADMIN, reason: "again"})).toBeNull();
    const [row] = await loadRouteRows(db, "judge.render");
    expect(row).toMatchObject({state: "serving", restoreState: null, restoreAt: null});
    expect((await changes(JUDGE_1())).at(-1)).toMatchObject({fromState: "off", toState: "serving", changedBy: ADMIN, reason: "batch done"});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([1, 2]);
  });
  it("expiry: the router reads an expired drill as restored and writes the restore once, with no drill job running", async () => {
    await recordPositions();
    await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "drill"});
    // Not yet expired: the router-side restore leaves it alone.
    expect(await endDrill(db, JUDGE_1(), {changedBy: DRILL_EXPIRY_ACTOR, reason: "early", onlyExpired: true})).toBeNull();
    await expire(JUDGE_1());
    // Read side: even before any restore is written, the table reads route 1 as serving.
    expect((await loadRoutes(db, "judge.render"))[0]).toMatchObject({rank: 1, state: "serving"});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([1, 2]);
    // routerFor wrote the restore, logged by drill-expiry; a second pass finds nothing to do.
    const [row] = await loadRouteRows(db, "judge.render");
    expect(row).toMatchObject({state: "serving", restoreState: null, restoreAt: null});
    expect((await changes(JUDGE_1())).filter(c => c.changedBy === DRILL_EXPIRY_ACTOR)).toHaveLength(1);
    expect(await restoreExpiredDrills(db)).toEqual([]);
    // The drill job's own late restore is then a no-op.
    expect(await endDrill(db, JUDGE_1(), {changedBy: ADMIN, reason: "late"})).toBeNull();
  });
  it("a manual set during a drill ends it: the admin's state stays past the old expiry", async () => {
    await recordPositions();
    await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "drill"});
    await setRoute(db, JUDGE_1(), {state: "off", changedBy: ADMIN, reason: "real outage, keep it off"});
    expect(await restoreExpiredDrills(db)).toEqual([]);
    const [row] = await loadRouteRows(db, "judge.render");
    expect(row).toMatchObject({state: "off", restoreAt: null});
    expect((await changes(JUDGE_1())).at(-1)!.reason).toBe("real outage, keep it off (kill-switch drill ended by this change)");
  });
  it("a rank, cap or position change during a drill keeps the drill, so route 1 still comes back (review P2-2)", async () => {
    await recordPositions();
    const drill = await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "drill"});
    await setRoute(db, JUDGE_1(), {rank: 4, changedBy: ADMIN, reason: "reorder"});
    await setRoute(db, JUDGE_1(), {noTrainingTerms: "test: vendor terms section 5 (2026-11-06)", changedBy: ADMIN, reason: "new position"});
    expect((await loadRouteRows(db, "judge.render")).find(r => r.id === JUDGE_1())).toMatchObject({state: "off", rank: 4, drillId: drill.drillId, restoreState: "serving"});
    await expire(JUDGE_1());
    expect(await restoreExpiredDrills(db)).toEqual([expect.objectContaining({id: JUDGE_1(), state: "serving", rank: 4})]);
  });
  it("a change after expiry but before the restore restores first, then applies (review P2-2)", async () => {
    await recordPositions();
    await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "drill"});
    await expire(JUDGE_1());
    expect(await setRoute(db, JUDGE_1(), {dailyCapUsd: null, changedBy: ADMIN, reason: "cap"})).toMatchObject({state: "serving"});
    expect((await changes(JUDGE_1())).map(c => c.changedBy).slice(-2)).toEqual([DRILL_EXPIRY_ACTOR, ADMIN]);
  });
  it("an expired drill nobody restored does not block the next one (review P3-1)", async () => {
    await recordPositions();
    await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "first"});
    await expire(JUDGE_1());
    const second = await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "second"});
    expect(second.route.id).toBe(JUDGE_1());
    expect((await changes(JUDGE_1())).map(c => `${c.changedBy}:${c.toState}`).slice(-3)).toEqual([`${ADMIN}:off`, `${DRILL_EXPIRY_ACTOR}:serving`, `${ADMIN}:off`]);
  });
  it("a late drill job never ends someone else's drill (review P3-2)", async () => {
    await recordPositions();
    const first = await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "first"});
    await expire(JUDGE_1());
    await restoreExpiredDrills(db);
    const second = await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "second"});
    expect(await endDrill(db, JUDGE_1(), {changedBy: ADMIN, reason: "late first job", drillId: first.drillId})).toBeNull();
    expect((await loadRouteRows(db, "judge.render"))[0]).toMatchObject({state: "off", drillId: second.drillId});
    expect(await endDrill(db, JUDGE_1(), {changedBy: ADMIN, reason: "second job", drillId: second.drillId})).toMatchObject({state: "serving"});
  });
  it("drills a named route (the batch's own judge), and refuses one outside the capability or not serving", async () => {
    await recordPositions();
    const second = SEED_ROUTES.find(r => r.capability === "judge.render" && r.rank === 2)!.id;
    const drill = await startDrill(db, "judge.render", {minutes: 10, routeId: second, changedBy: ADMIN, reason: "batch judge"});
    expect(drill.route).toMatchObject({id: second, state: "off"});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", []).map(r => r.rank)).toEqual([1]);
    await endDrill(db, second, {changedBy: ADMIN, reason: "done", drillId: drill.drillId});
    await expect(startDrill(db, "vision.read", {minutes: 10, routeId: second, changedBy: ADMIN, reason: "x"})).rejects.toThrow(/No vision.read route/);
    await setRoute(db, second, {state: "off", changedBy: ADMIN, reason: "off"});
    await expect(startDrill(db, "judge.render", {minutes: 10, routeId: second, changedBy: ADMIN, reason: "x"})).rejects.toThrow(/no serving route/);
  });
  it("the database refuses a half-set drill (restore state without expiry)", async () => {
    await recordPositions();
    await expect(db.execute(sql`update vendor_routes set restore_state = 'serving' where id = ${JUDGE_1()}`)).rejects.toThrow();
    await expect(db.execute(sql`update vendor_routes set restore_state = 'bogus', restore_at = now(), drill_id = 'd' where id = ${JUDGE_1()}`)).rejects.toThrow();
  });
});

describe("M1 D43: the judge chain", () => {
  const judgeRows = (rows: readonly {capability: string; model: string}[]) => rows.filter(r => r.capability === "judge.render").map(r => r.model);
  it("the seeds judge with the two models that passed the exam; the classifier keeps its own chain", () => {
    expect(judgeRows(SEED_ROUTES)).toEqual([JUDGES.first, JUDGES.second]);
    expect(SEED_ROUTES.filter(r => r.capability === "vision.read").map(r => r.model)).toEqual([JUDGES.retired, JUDGES.first, JUDGES.qwen]);
  });
  it("Qwen, retired on evidence, cannot come back as a judge by a typed switch; the classifier still reads with it", () => {
    const row = {...SEED_ROUTES.find(r => r.capability === "judge.render")!, id: routeId("judge.render", "openrouter", JUDGES.qwen), model: JUDGES.qwen, rank: 1};
    expect(planRoutes(createRouter([row]), "judge.render", [JUDGES.qwen])).toEqual([]);
    expect(planRoutes(undefined, "judge.render", [JUDGES.qwen])).toEqual([]);
    expect(planRoutes(undefined, "vision.read", [JUDGES.qwen]).map(r => r.model)).toEqual([JUDGES.qwen]);
  });
  it("a model measured to pass every defect can never judge: not from a serving row, not named by a policy, not without a table", () => {
    const row = {...SEED_ROUTES.find(r => r.capability === "judge.render")!, id: routeId("judge.render", "openrouter", JUDGES.retired), model: JUDGES.retired, rank: 1};
    const router = createRouter([row, ...SEED_ROUTES.filter(r => r.capability === "judge.render").map(r => ({...r, rank: r.rank + 1}))]);
    expect(planRoutes(router, "judge.render", [JUDGES.retired, JUDGES.retired]).map(r => r.model)).toEqual([JUDGES.first, JUDGES.second]);
    expect(planRoutes(undefined, "judge.render", [JUDGES.retired, JUDGES.second]).map(r => r.model)).toEqual([JUDGES.second]);
    expect(planRoutes(undefined, "judge.render", [JUDGES.retired])).toEqual([]);
    expect(planRoutes(undefined, "vision.read", [JUDGES.retired]).map(r => r.model)).toEqual([JUDGES.retired]);
  });
  it("a kill-switch drill on the first judge falls to the second judge and to nothing else", async () => {
    await recordPositions();
    await startDrill(db, "judge.render", {minutes: 30, changedBy: ADMIN, reason: "drill"});
    expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", [JUDGES.first, JUDGES.second]).map(r => r.model)).toEqual([JUDGES.second]);
  });
  it("a drill that would leave no judge is refused", async () => {
    await recordPositions();
    await setRoute(db, routeId("judge.render", "openrouter", JUDGES.second), {state: "off", changedBy: ADMIN, reason: "only the first left"});
    await expect(startDrill(db, "judge.render", {minutes: 5, changedBy: ADMIN, reason: "x"})).rejects.toThrow(/no other serving route/);
  });

  describe("migration 0030 on a table that has the old chain", () => {
    const statements = readFileSync(new URL("../../drizzle/0030_judge_routes.sql", import.meta.url), "utf8").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
    const migrate = async () => { for (const statement of statements) await db.execute(sql.raw(statement)); };
    const oldRow = (capability: "judge.render" | "vision.read", rank: number, model: string) => ({...SEED_ROUTES.find(r => r.capability === "vision.read")!, id: routeId(capability, "openrouter", model), capability, rank, model, priceUsd: 0.0004});
    const seedOld = async () => {
      for (const capability of ["judge.render", "vision.read"] as const) for (const [i, model] of [JUDGES.retired, JUDGES.first, JUDGES.qwen].entries()) await db.insert(vendorRoutes).values(oldRow(capability, i + 1, model));
    };
    const judges = async () => (await loadRouteRows(db, "judge.render")).map(r => [r.model, r.rank, r.state]);
    const AFTER = [[JUDGES.first, 1, "serving"], [JUDGES.second, 2, "serving"], [JUDGES.retired, 9, "retired"], [JUDGES.qwen, 10, "retired"]];
    beforeEach(async () => { await db.delete(modelPolicy); });

    it("retires the old judges, orders the two new ones, logs every change, and does not touch the classifier", async () => {
      await seedOld();
      await migrate();
      expect(await judges()).toEqual(AFTER);
      expect((await loadRouteRows(db, "vision.read")).map(r => [r.model, r.rank, r.state])).toEqual([[JUDGES.retired, 1, "serving"], [JUDGES.first, 2, "serving"], [JUDGES.qwen, 3, "serving"]]);
      const log = await db.select().from(vendorRouteChanges).where(eq(vendorRouteChanges.changedBy, "migration 0030"));
      expect(log.map(c => c.routeId).sort()).toEqual([JUDGES.first, JUDGES.second, JUDGES.retired, JUDGES.qwen].map(m => routeId("judge.render", "openrouter", m)).sort());
      expect(planRoutes(await routerFor(db, {ttlMs: 0}), "judge.render", [JUDGES.retired, JUDGES.first]).map(r => r.model)).toEqual([JUDGES.first, JUDGES.second]);
    });
    it("runs again harmlessly, and the seed then adds nothing and revives nothing", async () => {
      await seedOld();
      await migrate();
      const logged = (await db.select().from(vendorRouteChanges)).length;
      await migrate();
      expect(await judges()).toEqual(AFTER);
      expect(await db.select().from(vendorRouteChanges)).toHaveLength(logged);
      await ensureSeedRoutes(db);
      expect((await judges()).slice(0, 4)).toEqual(AFTER);
    });
    it("a drill running on the old first judge cannot bring it back", async () => {
      await seedOld();
      await db.execute(sql`update vendor_routes set state = 'off', restore_state = 'serving', restore_at = now() + interval '30 minutes', drill_id = 'd' where id = ${routeId("judge.render", "openrouter", JUDGES.retired)}`);
      await migrate();
      expect(await judges()).toEqual(AFTER);
      expect(await restoreExpiredDrills(db)).toEqual([]);
    });
    it("moves every policy row that names the old first judge and keeps one that names another", async () => {
      const row = (brandSlug: string, qaModel: string, qaModelSecond: string | null) => ({brandSlug, category: "other" as const, matteModel: "test/matte", threshold: 75, floor: 60, source: "default" as const, qaModel, qaModelSecond});
      await db.insert(modelPolicy).values([row("a", JUDGES.retired, JUDGES.first), row("b", JUDGES.first, JUDGES.retired), row("c", "some/other-judge", null)]);
      await migrate();
      const after = await db.select().from(modelPolicy);
      const of = (brand: string) => after.find(r => r.brandSlug === brand)!;
      expect(of("a")).toMatchObject({qaModel: JUDGES.first, qaModelSecond: JUDGES.second});
      expect(of("b")).toMatchObject({qaModel: JUDGES.first, qaModelSecond: JUDGES.second});
      expect(of("c")).toMatchObject({qaModel: "some/other-judge", qaModelSecond: null});
    });
  });
});
