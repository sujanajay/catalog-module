// M1-S4b upscaler outage deadline (docs/program/requirements/M1-intake.md D13; design .runs/2026-11-04-outage-deadline-plan.md
// section 8). An auto-decide batch whose photos wait on an upscaler service that has given no proof of health for the
// batch's deadline (6 h by default) finishes with plain renders delivered `provisional`; the improvement re-enlarges
// them later at the same URL (M1 F3 test 2). A saturated, backlogged or flapping service never trips it. The sweep
// also writes the upscaler_outage incidents (M6 F3 acceptance test 1: the upscaler stopped for 20 minutes).
// Tier 2 (PGlite + fakes), the spec 18 world. Enlarge deliveries are skipped while the service is down: the row is
// never re-delivered (the backlog case of the review), so only the sweep's own probe and recorded observations count.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchOutcomes, catalogEnlargements, catalogIncidents, catalogSettingsSnapshots, catalogUpscalerHealth } from "@catalog/core/db/schema";
import { autoDecideSnapshot } from "@catalog/core/catalog/auto-decide";
import { IMPROVE_FIRST_DELAY_MS } from "@catalog/core/catalog/improve";
import { OUTAGE_DEADLINE_KEY, readUpscalerHealth, STALL_INCIDENT_MS } from "@catalog/core/catalog/upscaler-health";
import type { UpscaleProbe } from "@catalog/core/catalog/enlarge";
import { batchOf, drain, enlargeBody, enlargeWorld, outputsOf, rowsOf, seedEnlargeBatch, startChunks, sweep, type EnlargeWorld, type ServiceMode } from "../../test/enlarge-world";
import type { QueuedTask } from "../../test/catalog-fakes";
import { handleEnlargeTask, observeUpscaler } from "./enlarge";
import { clearImproveProbeCache, IMPROVE_ROUTE } from "./improve";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
beforeEach(async () => { clearImproveProbeCache(); await db.delete(catalogUpscalerHealth); await db.delete(catalogIncidents).where(eq(catalogIncidents.kind, "upscaler_outage")); });
// The sweep is global and the database is shared: every batch of a finished test stops counting as live.
afterEach(async () => { await db.update(catalogBatches).set({ status: "cancelled" }).where(notInArray(catalogBatches.status, ["failed", "cancelled"])); });
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

const HOUR = 60;
const only = (s: { batch: { id: string } }) => ({ only: { db, batchId: s.batch.id } });
const isEnlarge = (t: QueuedTask) => t.route === "/tasks/catalog/enlarge";
const gpu = async () => (await readUpscalerHealth(db)).find((r) => r.service === "gpu");
const incidents = (cause: string) => db.select().from(catalogIncidents).where(and(eq(catalogIncidents.kind, "upscaler_outage"), eq(catalogIncidents.causeCode, cause)));
const batchIncidents = (batchId: string, cause: string) => db.select().from(catalogIncidents).where(and(eq(catalogIncidents.batchId, batchId), eq(catalogIncidents.causeCode, cause)));
const statuses = async (batchId: string) => (await rowsOf(db, batchId)).filter((r) => r.wanted).map((r) => r.status);

let snapshots = 0;
async function snapshotWith(value: number | null): Promise<string> {
  const id = `s4b-test-${snapshots++}`;
  await db.insert(catalogSettingsSnapshots).values({ id, createdBy: "t@opptra.com", data: { format: 1, defaults: {}, versions: value === null ? [] : [{ id: `${id}-v`, key: OUTAGE_DEADLINE_KEY, scope: {}, version: 1, value }], taxonomyRevision: 0 } });
  return id;
}

/**
 * A batch run up to its parked render with the service in `mode` (`down` by default): the enlarge tasks are dropped
 * (never delivered), so its rows wait queued. Auto-decide unless `auto` is false.
 */
async function waitingBatch(name: string, o: { auto?: boolean; mode?: ServiceMode; probe?: UpscaleProbe; snapshot?: string; layout?: number[][] } = {}) {
  const e = enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, o.layout ?? [[1]]);
  if (o.auto !== false) await db.update(catalogBatches).set({ options: { ...s.batch.options, autoDecide: await autoDecideSnapshot(db) } }).where(eq(catalogBatches.id, s.batch.id));
  if (o.snapshot) await db.update(catalogBatches).set({ settingsSnapshotId: o.snapshot }).where(eq(catalogBatches.id, s.batch.id));
  e.service.state.mode = o.mode ?? "down";
  e.service.state.probe = o.probe ?? null;
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  await drain(e.w, { ...only(s), skip: isEnlarge });
  expect(await statuses(s.batch.id)).toEqual(expect.arrayContaining(["queued"]));
  expect((await statuses(s.batch.id)).every((x) => x === "queued")).toBe(true);
  return { ...e, s };
}
/** Moves the clock and sweeps; enlarge tasks the sweep re-sends are dropped (the service is not reached). */
async function sweepAt(e: EnlargeWorld, minutes: number) {
  e.clock.tick(minutes);
  await sweep(db, e.w);
  e.w.tasks.splice(0, e.w.tasks.length, ...e.w.tasks.filter((t) => !isEnlarge(t)));
}
/** After the deadline: the batch runs to its end. */
async function finish(e: EnlargeWorld & { s: { batch: { id: string } } }) {
  await drain(e.w, { ...only(e.s), skip: isEnlarge });
  return batchOf(db, e.s.batch.id);
}
async function expectDeliveredProvisional(e: EnlargeWorld & { s: { batch: { id: string } } }, hours: number) {
  const rows = (await rowsOf(db, e.s.batch.id)).filter((r) => r.wanted);
  expect(rows.map((r) => [r.status, r.errorKind])).toEqual(rows.map(() => ["failed", "outage_deadline"]));
  expect(rows[0]!.error).toBe(`The enlargement service could not be reached for ${hours} ${hours === 1 ? "hour" : "hours"}, so this photo was delivered without enlargement.`);
  expect((await finish(e)).status).toBe("done");
  for (const o of await outputsOf(db, e.s.batch.id)) {
    expect(o).toMatchObject({ isLive: true });
    expect(o.flags).toEqual(expect.arrayContaining(["provisional", "enlargement_failed"]));
  }
}

describe("upscaler outage deadline (M1-S4b, M1 D13)", () => {
  it("A1, F3 test 2: the upscaler stopped during an auto-decide batch: it waits, then after 6 h finishes with plain renders delivered provisional; once the upscaler answers, they are improved at the same URL", async () => {
    const e = await waitingBatch("outage-a1");
    await sweepAt(e, 0);
    expect(await gpu()).toMatchObject({ unhealthySince: e.clock.now(), lastProbe: "absent" });
    await sweepAt(e, 6 * HOUR - 30);
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
    expect((await batchOf(db, e.s.batch.id)).status).not.toBe("done");
    await sweepAt(e, 31);
    await expectDeliveredProvisional(e, 6);
    const [before] = await outputsOf(db, e.s.batch.id);
    expect(await batchIncidents(e.s.batch.id, "outage_deadline")).toHaveLength(1);
    // The service is back: the improvement re-enlarges at the same public path with a new generation.
    e.service.state.mode = "ok";
    e.clock.tick(IMPROVE_FIRST_DELAY_MS / 60_000);
    await sweep(db, e.w);
    expect(e.w.tasks.filter((t) => t.route === IMPROVE_ROUTE && t.body.batchId === e.s.batch.id)).toHaveLength(1);
    await drain(e.w, only(e.s));
    const [after] = await outputsOf(db, e.s.batch.id);
    expect(after).toMatchObject({ id: before!.id, isLive: true, objectPath: before!.objectPath, publicUrl: before!.publicUrl });
    expect(after!.flags).toContain("upscaled");
    expect(after!.flags).not.toContain("provisional");
    expect(after!.generation).not.toBe(before!.generation);
    expect(await gpu()).toMatchObject({ unhealthySince: null });
  }, 600_000);

  for (const [label, mode, probe] of [["A2 hung (probes time out)", "probeTimesOut", null], ["A3 deleted service (404: unknown)", "down", "unknown"], ["C5 GPU stockout (no instance can start, owner decision)", "noInstance", null]] as const) {
    it(`${label}: an outage, so the batch finishes at the deadline`, async () => {
      const e = await waitingBatch(`outage-${mode}-${probe ?? "x"}`, { mode, ...(probe ? { probe } : {}) });
      await sweepAt(e, 0);
      await sweepAt(e, 6 * HOUR - 10);
      expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
      await sweepAt(e, 10);
      await expectDeliveredProvisional(e, 6);
    }, 300_000);
  }

  it("B1 backlog: a row never re-delivered is not an outage once the sweep's own probe answers ok", async () => {
    const e = await waitingBatch("outage-b1");
    await sweepAt(e, 0);
    e.service.state.mode = "ok";
    await sweepAt(e, 6 * HOUR + 1);
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
    expect(await gpu()).toMatchObject({ unhealthySince: null, lastProbe: "ok" });
  }, 300_000);

  it("B2: calls the service answered for other batches end the outage, even when the sweep's probe times out", async () => {
    const e = await waitingBatch("outage-b2", { probe: "timeout" });
    await sweepAt(e, 0);
    for (let m = 30; m <= 6 * HOUR + 60; m += 30) {
      e.clock.tick(30);
      await observeUpscaler(e.w.deps, "swinir-x2", "call_ok", e.clock.now());
      if (m % 60 === 0) await sweepAt(e, 0);
    }
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
    expect((await incidents("service_down")).length).toBe(0);
  }, 300_000);

  it("C1 saturated: probes and calls answer 429 for hours; never an outage, no incident", async () => {
    const e = await waitingBatch("outage-c1", { mode: "saturated" });
    for (let m = 0; m <= 7 * HOUR; m += 60) await sweepAt(e, m ? 60 : 0);
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
    expect(await gpu()).toMatchObject({ unhealthySince: null, lastProbe: "busy" });
    expect(await incidents("service_down")).toHaveLength(0);
  }, 300_000);

  it("C2 scale-up: no instance for 20 minutes, then ok; the clock is cleared and the photos keep waiting", async () => {
    const e = await waitingBatch("outage-c2", { mode: "noInstance" });
    await sweepAt(e, 0);
    await sweepAt(e, 10);
    e.service.state.mode = "ok";
    await sweepAt(e, 10);
    expect(await gpu()).toMatchObject({ unhealthySince: null });
    await sweepAt(e, 6 * HOUR);
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
  }, 300_000);

  it("D1 flap: one ok answer restarts the clock; the deadline counts from the next symptom", async () => {
    const e = await waitingBatch("outage-d1");
    await sweepAt(e, 0);
    await sweepAt(e, 5 * HOUR);
    e.service.state.mode = "ok";
    await sweepAt(e, 10);
    e.service.state.mode = "down";
    await sweepAt(e, 10);
    const restarted = e.clock.now();
    expect(await gpu()).toMatchObject({ unhealthySince: restarted });
    await sweepAt(e, 5 * HOUR);
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
    await sweepAt(e, HOUR);
    expect(await statuses(e.s.batch.id)).toEqual(["failed"]);
  }, 300_000);

  it("M6 F3 test 1, D4: the upscaler stopped for 20 minutes opens one service incident and one batch incident with a resolution time; the batch is not a success", async () => {
    const e = await waitingBatch("outage-f3-1", { auto: false });
    await sweepAt(e, 0);
    expect(await incidents("service_down")).toHaveLength(0);
    for (let i = 0; i < 4; i++) await sweepAt(e, 5);
    const open = await batchIncidents(e.s.batch.id, "enlarge_wait");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "upscaler_outage", resolvedAt: null, cause: "Photos are waiting because the enlargement service is not answering." });
    expect((await incidents("service_down")).filter((i) => !i.resolvedAt)).toHaveLength(1);
    // The upscaler is back: the next sweep's probe ends the outage and resolves both.
    e.service.state.mode = "ok";
    await sweepAt(e, 5);
    const [resolved] = await batchIncidents(e.s.batch.id, "enlarge_wait");
    expect(+resolved!.resolvedAt! - +resolved!.startedAt).toBe(25 * 60_000);
    expect((await incidents("service_down")).filter((i) => !i.resolvedAt)).toHaveLength(0);
    for (const row of (await rowsOf(db, e.s.batch.id)).filter((r) => r.status === "queued")) await handleEnlargeTask(e.w.deps, enlargeBody(row));
    expect((await finish(e)).status).toBe("done");
    await sweep(db, e.w);
    const [outcome] = await db.select().from(catalogBatchOutcomes).where(eq(catalogBatchOutcomes.batchId, e.s.batch.id));
    expect(outcome).toMatchObject({ success: false, incidents: 1, cause: "incident" });
    expect(STALL_INCIDENT_MS).toBe(10 * 60_000);
  }, 300_000);

  it("D5: a row held by a live delivery is left to it; the other rows of the batch fail", async () => {
    const e = await waitingBatch("outage-d5", { layout: [[2]] });
    await sweepAt(e, 0);
    await sweepAt(e, 6 * HOUR - 5);
    const [held] = await rowsOf(db, e.s.batch.id);
    e.clock.tick(5);
    await db.update(catalogEnlargements).set({ claimedAt: e.clock.now(), claimToken: "live" }).where(eq(catalogEnlargements.id, held!.id));
    await sweepAt(e, 1);
    const rows = await rowsOf(db, e.s.batch.id);
    expect(rows.find((r) => r.id === held!.id)).toMatchObject({ status: "queued", claimToken: "live" });
    expect(rows.filter((r) => r.id !== held!.id).map((r) => r.status)).toEqual(["failed"]);
    // A later delivery of a failed row makes no call and writes nothing.
    const failed = rows.find((r) => r.id !== held!.id)!;
    e.service.state.mode = "ok";
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(failed))).toMatchObject({ httpStatus: 200, outcome: "settled" });
    expect(e.service.paid()).toBe(0);
  }, 300_000);

  it("F1: a batch started before M1-S3 keeps spec 18's wait; the incidents still open", async () => {
    const e = await waitingBatch("outage-f1", { auto: false });
    await sweepAt(e, 0);
    await sweepAt(e, 7 * HOUR);
    expect(await statuses(e.s.batch.id)).toEqual(["queued"]);
    expect(await batchIncidents(e.s.batch.id, "outage_deadline")).toHaveLength(0);
    expect(await batchIncidents(e.s.batch.id, "enlarge_wait")).toHaveLength(1);
  }, 300_000);

  it("F2: with the upscaler switched off the rows are released, never failed by the deadline", async () => {
    const e = await waitingBatch("outage-f2");
    await sweepAt(e, 0);
    e.clock.tick(7 * HOUR);
    e.w.deps.enlarge = undefined;
    await sweep(db, e.w, { enlargementOff: true });
    const rows = await rowsOf(db, e.s.batch.id);
    expect(rows.some((r) => r.errorKind === "outage_deadline")).toBe(false);
    expect(rows.every((r) => !r.wanted)).toBe(true);
  }, 300_000);

  it("G1, G3, G4: the deadline is read from the batch's snapshot (2 h; 0 never; a snapshot without the key reads 6 h)", async () => {
    const two = await waitingBatch("outage-g1", { snapshot: await snapshotWith(2) });
    await sweepAt(two, 0);
    await sweepAt(two, 2 * HOUR - 10);
    expect(await statuses(two.s.batch.id)).toEqual(["queued"]);
    await sweepAt(two, 10);
    await expectDeliveredProvisional(two, 2);
    await db.update(catalogBatches).set({ status: "cancelled" }).where(ne(catalogBatches.status, "cancelled"));
    await db.delete(catalogUpscalerHealth);

    const never = await waitingBatch("outage-g3", { snapshot: await snapshotWith(0) });
    const old = await waitingBatch("outage-g4", { snapshot: await snapshotWith(null) });
    await sweepAt(never, 0);
    await sweepAt(never, 6 * HOUR - 10);
    expect(await statuses(old.s.batch.id)).toEqual(["queued"]);
    await sweepAt(never, 20);
    expect(await statuses(never.s.batch.id)).toEqual(["queued"]);
    expect(await statuses(old.s.batch.id)).toEqual(["failed"]);
    await sweepAt(never, 24 * HOUR);
    expect(await statuses(never.s.batch.id)).toEqual(["queued"]);
    expect(await batchIncidents(never.s.batch.id, "enlarge_wait")).toHaveLength(1);
  }, 600_000);
});

describe("upscaler health observations in the enlarge delivery (M1-S4b)", () => {
  it("a completed call is a proof stamped at its start; a 429 from a full fleet is a proof; a refused service is a symptom", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "outage-hooks", [[1]]);
    e.service.state.mode = "down";
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    await drain(e.w, { ...only(s), skip: isEnlarge });
    const [row] = await rowsOf(db, s.batch.id);
    const started = e.clock.now();
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 503 });
    expect(await gpu()).toMatchObject({ unhealthySince: started, lastProbe: "absent", lastSource: "probe" });
    e.clock.tick(1);
    e.service.state.mode = "busy";
    e.service.state.probe = "busy";
    const busyAt = e.clock.now();
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 503, outcome: "busy" });
    expect(await gpu()).toMatchObject({ unhealthySince: null, healthyAt: busyAt, lastSource: "call" });
    e.clock.tick(1);
    e.service.state.mode = "slow";
    e.service.state.probe = null;
    const callAt = e.clock.now();
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 200, outcome: "done" });
    // The slow call took 10 minutes; its proof is stamped when it was sent.
    expect(await gpu()).toMatchObject({ healthyAt: callAt, lastSource: "call" });
  }, 300_000);

  it("J1: a failed health write is one WARNING and never changes the delivery", async () => {
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "outage-j1", [[1]]);
    e.service.state.mode = "down";
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    await drain(e.w, { ...only(s), skip: isEnlarge });
    e.service.state.mode = "ok";
    const real = e.w.deps.db;
    e.w.deps.db = new Proxy(real, { get: (target, key) => key === "insert" ? (table: unknown) => { if (table === catalogUpscalerHealth) throw new Error("health table down"); return target.insert(table as never); } : Reflect.get(target, key) });
    const [row] = await rowsOf(db, s.batch.id);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row!))).toMatchObject({ httpStatus: 200, outcome: "done" });
    e.w.deps.db = real;
    const warnings = e.w.log.mock.calls.filter(([m]) => m === "upscaler health not recorded");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]![1]).toMatchObject({ severity: "WARNING", error: "health table down" });
  }, 300_000);
});
