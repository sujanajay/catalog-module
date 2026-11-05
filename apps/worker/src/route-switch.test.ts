// The catalog-route-switch job's commands (R1 exit item 3): set, the drill's restore on batch completion, on time and
// on a stop signal, and the env parsing. PGlite; no cloud calls.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, EMPTY_BATCH_COUNTS, vendorRouteChanges, vendorRoutes } from "@catalog/core/db/schema";
import { ensureSeedRoutes, loadRouteRows, RouteChangeError, resetRouting } from "@catalog/core/vendor/route-table";
import { SEED_ROUTES } from "@catalog/core/vendor/routes";
import { parseRouteSwitchEnv, runRouteSwitch, type RouteSwitchDeps } from "./route-switch";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => close());
beforeEach(async () => { await db.delete(vendorRouteChanges); await db.delete(vendorRoutes); resetRouting(db); await ensureSeedRoutes(db); });

const ADMIN = "admin@opptra.com";
const JUDGE_1 = SEED_ROUTES.find(r => r.capability === "judge.render" && r.rank === 1)!.id;
const judge1 = async () => (await loadRouteRows(db, "judge.render"))[0]!;
const lastChange = async () => (await db.select().from(vendorRouteChanges).where(eq(vendorRouteChanges.routeId, JUDGE_1)).orderBy(asc(vendorRouteChanges.at))).at(-1)!;

/** A fake clock whose sleep advances it and runs `onSleep` (the world moving while the drill waits). */
function harness(onSleep: (sleeps: number) => Promise<void> | void = () => {}) {
  let now = Date.now(), sleeps = 0;
  const lines: string[] = [];
  const deps: RouteSwitchDeps = { db, print: line => lines.push(line), now: () => now, pollMs: 30_000,
    sleep: async ms => { now += ms; sleeps += 1; await onSleep(sleeps); } };
  return { deps, lines, sleeps: () => sleeps };
}
async function batch(status: "qa" | "done" = "qa") {
  const [row] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: "drill", isTest: true, createdBy: "test@opptra.com", status, channels: ["noon"], counts: { ...EMPTY_BATCH_COUNTS } }).returning();
  return row!.id;
}

describe("catalog-route-switch", () => {
  it("set: turns a named route off and on, logs reason and actor, prints before and after", async () => {
    const { deps, lines } = harness();
    await runRouteSwitch({ command: "set", routeId: JUDGE_1, state: "off", reason: "vendor outage", actor: ADMIN }, deps);
    expect(await judge1()).toMatchObject({ state: "off" });
    expect(await lastChange()).toMatchObject({ fromState: "serving", toState: "off", changedBy: ADMIN, reason: "vendor outage" });
    expect(lines[0]).toBe("Before:");
    expect(lines).toContain(`  judge.render rank 1 ${JUDGE_1}: serving`);
    expect(lines).toContain("After:");
    expect(lines.at(-3)).toBe(`  judge.render rank 1 ${JUDGE_1}: off`);
    await runRouteSwitch({ command: "set", routeId: JUDGE_1, state: "serving", reason: "vendor back", actor: ADMIN }, deps);
    expect(await judge1()).toMatchObject({ state: "serving" });
    await expect(runRouteSwitch({ command: "set", routeId: "no-such-route", state: "off", reason: "x", actor: ADMIN }, deps)).rejects.toBeInstanceOf(RouteChangeError);
  });

  it("drill: route 1 is off while the batch runs and is restored as soon as the batch finishes", async () => {
    const batchId = await batch();
    let offDuringDrill = false;
    const { deps, lines, sleeps } = harness(async n => {
      if (n === 1) offDuringDrill = (await judge1()).state === "off";
      if (n === 3) await db.update(catalogBatches).set({ status: "done" }).where(eq(catalogBatches.id, batchId));
    });
    await runRouteSwitch({ command: "drill", capability: "judge.render", minutes: 60, batchId, reason: "R1 exit item 3", actor: ADMIN }, deps);
    expect(offDuringDrill).toBe(true);
    expect(sleeps()).toBe(3);
    expect(await judge1()).toMatchObject({ state: "serving", restoreAt: null });
    expect(await lastChange()).toMatchObject({ fromState: "off", toState: "serving", changedBy: ADMIN, reason: `kill-switch drill ended: batch ${batchId} is done` });
    expect(lines.some(l => l.startsWith(`Drill ended (batch ${batchId} is done)`))).toBe(true);
  });

  it("drill: without a batch it restores when the minutes run out", async () => {
    const { deps, sleeps } = harness();
    await runRouteSwitch({ command: "drill", capability: "judge.render", minutes: 2, reason: "short drill", actor: ADMIN }, deps);
    // 2 minutes of 30 s polls, plus at most one short last wait (the expiry is stamped by the database clock).
    expect(sleeps()).toBeGreaterThanOrEqual(4);
    expect(sleeps()).toBeLessThanOrEqual(5);
    expect(await judge1()).toMatchObject({ state: "serving", restoreAt: null });
    expect((await lastChange()).reason).toBe("kill-switch drill ended: drill time is up");
  });

  it("drill: a stop signal restores route 1 at once", async () => {
    const stop = new AbortController();
    const { deps } = harness(n => { if (n === 1) stop.abort(); });
    await runRouteSwitch({ command: "drill", capability: "judge.render", minutes: 60, reason: "stopped drill", actor: ADMIN }, { ...deps, signal: stop.signal });
    expect(await judge1()).toMatchObject({ state: "serving", restoreAt: null });
    expect((await lastChange()).reason).toBe("kill-switch drill ended: the drill job was stopped");
  });

  it("drill: refuses an unknown or finished batch without touching the routes", async () => {
    const { deps } = harness();
    await expect(runRouteSwitch({ command: "drill", capability: "judge.render", minutes: 5, batchId: "00000000-0000-4000-8000-000000000000", reason: "x", actor: ADMIN }, deps)).rejects.toThrow(/No batch/);
    await expect(runRouteSwitch({ command: "drill", capability: "judge.render", minutes: 5, batchId: await batch("done"), reason: "x", actor: ADMIN }, deps)).rejects.toThrow(/already done/);
    expect(await judge1()).toMatchObject({ state: "serving", restoreAt: null });
  });

  it("parses the job's environment and refuses a change without who and why", () => {
    expect(parseRouteSwitchEnv({})).toEqual({ command: "show" });
    expect(parseRouteSwitchEnv({ ROUTE_COMMAND: "set", ROUTE_ID: JUDGE_1, ROUTE_STATE: "off", ROUTE_REASON: " outage ", ROUTE_ACTOR: ADMIN }))
      .toEqual({ command: "set", routeId: JUDGE_1, state: "off", reason: "outage", actor: ADMIN });
    expect(parseRouteSwitchEnv({ ROUTE_COMMAND: "drill", DRILL_CAPABILITY: "vision.read", DRILL_MINUTES: "45", DRILL_BATCH: "00000000-0000-4000-8000-000000000000", ROUTE_REASON: "r", ROUTE_ACTOR: ADMIN }))
      .toEqual({ command: "drill", capability: "vision.read", minutes: 45, batchId: "00000000-0000-4000-8000-000000000000", reason: "r", actor: ADMIN });
    expect(() => parseRouteSwitchEnv({ ROUTE_COMMAND: "set", ROUTE_ID: JUDGE_1, ROUTE_STATE: "off", ROUTE_ACTOR: ADMIN })).toThrow(/ROUTE_REASON/);
    expect(() => parseRouteSwitchEnv({ ROUTE_COMMAND: "set", ROUTE_ID: JUDGE_1, ROUTE_STATE: "retired", ROUTE_REASON: "r", ROUTE_ACTOR: ADMIN })).toThrow(/ROUTE_STATE/);
    expect(() => parseRouteSwitchEnv({ ROUTE_COMMAND: "drill", DRILL_CAPABILITY: "judge.fake", DRILL_MINUTES: "5", ROUTE_REASON: "r", ROUTE_ACTOR: ADMIN })).toThrow(/DRILL_CAPABILITY/);
    expect(() => parseRouteSwitchEnv({ ROUTE_COMMAND: "drill", DRILL_CAPABILITY: "judge.render", DRILL_MINUTES: "5", DRILL_BATCH: "abc", ROUTE_REASON: "r", ROUTE_ACTOR: ADMIN })).toThrow(/DRILL_BATCH/);
    expect(() => parseRouteSwitchEnv({ ROUTE_COMMAND: "delete" })).toThrow(/show, set or drill/);
  });
});
