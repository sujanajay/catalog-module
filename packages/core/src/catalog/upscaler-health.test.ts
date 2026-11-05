// M1-S4b upscaler health ledger (catalog/upscaler-health.ts): the classification, the two stamps' ordering rules
// (a stale proof never ends an outage, a stale symptom never starts one, a flap restarts the clock), the sweep's probe
// pass and the per-batch deadline from the settings snapshot. The deadline and incidents on real batches are in
// apps/worker/src/catalog/outage-deadline.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogSettingsSnapshots, catalogUpscalerHealth } from "../db/schema";
import { createTestDb } from "../db/testing";
import { SETTING_DEFS } from "../settings/registry";
import { assessUpscalerOutages, deadlineHoursFor, observationClass, OUTAGE_DEADLINE_KEY, outageDeadlineSentence, readUpscalerHealth, recordUpscalerObservation, serviceOf, type UpscalerObservation } from "./upscaler-health";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });
beforeEach(async () => { await db.delete(catalogUpscalerHealth); });

const T = Date.parse("2026-11-05T06:00:00Z");
const at = (minutes: number) => new Date(T + minutes * 60_000);
const observe = (kind: UpscalerObservation, minutes: number, service: "gpu" | "cpu" = "gpu") => recordUpscalerObservation(db, { service, kind, at: at(minutes), upscaler: service === "gpu" ? "swinir-x2" : "swinir-x2+cpu" });
const gpu = async () => (await readUpscalerHealth(db)).find((r) => r.service === "gpu");

describe("upscaler health ledger (M1-S4b)", () => {
  it("proofs of health are ok and busy probes and answered calls; every other probe answer is a symptom", () => {
    expect((["ok", "busy", "call_ok", "call_busy"] as const).map(observationClass)).toEqual(["health", "health", "health", "health"]);
    expect((["absent", "timeout", "no_instance", "unknown"] as const).map(observationClass)).toEqual(["unhealthy", "unhealthy", "unhealthy", "unhealthy"]);
    expect([serviceOf("swinir-x2"), serviceOf("swinir-x4"), serviceOf("swinir-x2+cpu")]).toEqual(["gpu", "gpu", "cpu"]);
  });

  it("a symptom starts the clock once; later symptoms keep its start; a newer proof clears it", async () => {
    await observe("ok", 0);
    await observe("absent", 5);
    await observe("timeout", 30);
    expect(await gpu()).toMatchObject({ unhealthySince: at(5), healthyAt: at(0), lastProbe: "timeout", lastProbeAt: at(30) });
    await observe("call_ok", 40);
    expect(await gpu()).toMatchObject({ unhealthySince: null, healthyAt: at(40), lastSource: "call" });
  });

  it("D2: a call that started before the outage and answered after it does not end the outage", async () => {
    await observe("absent", 10);
    await observe("call_ok", 9);
    expect(await gpu()).toMatchObject({ unhealthySince: at(10), healthyAt: at(9) });
  });

  it("D3: a symptom stamped before the latest proof never starts an outage", async () => {
    await observe("call_ok", 11);
    await observe("absent", 10);
    expect(await gpu()).toMatchObject({ unhealthySince: null, healthyAt: at(11) });
    // The latest probe answer stays the newest one by stamp.
    await observe("ok", 12);
    await observe("absent", 10);
    expect(await gpu()).toMatchObject({ lastProbe: "ok", lastProbeAt: at(12), unhealthySince: null });
  });

  it("D1: a flap ends the outage and the next symptom starts a new clock", async () => {
    await observe("absent", 0);
    await observe("ok", 300);
    await observe("absent", 310);
    expect(await gpu()).toMatchObject({ unhealthySince: at(310), healthyAt: at(300) });
  });

  it("the services have one clock each (CPU symptoms never move the GPU clock)", async () => {
    await observe("absent", 0, "cpu");
    await observe("ok", 1, "gpu");
    const rows = await readUpscalerHealth(db);
    expect(rows.find((r) => r.service === "cpu")).toMatchObject({ unhealthySince: at(0) });
    expect(rows.find((r) => r.service === "gpu")).toMatchObject({ unhealthySince: null });
  });

  it("I2 (review P2-1): an outage on a service no photo waits on is closed without a probe, so an idle GPU is never woken", async () => {
    await observe("absent", 0);
    const asked: string[] = [];
    const a = await assessUpscalerOutages(db, async (upscaler) => { asked.push(upscaler); return "absent"; }, () => at(400));
    expect(asked).toEqual([]);
    expect(a.services).toEqual([]);
    expect(await gpu()).toMatchObject({ unhealthySince: null, lastSymptomAt: null });
  });

  it("writers finishing out of order: a proof that ends an outage hands on a newer symptom instead of losing it", async () => {
    await observe("absent", 3);
    await observe("absent", 10);
    await observe("call_ok", 5);
    expect(await gpu()).toMatchObject({ healthyAt: at(5), unhealthySince: at(10) });
    // An earlier symptom that arrives late moves the start earlier, never before the latest proof.
    await observe("timeout", 7);
    expect(await gpu()).toMatchObject({ unhealthySince: at(7) });
    await observe("timeout", 4);
    expect(await gpu()).toMatchObject({ unhealthySince: at(7) });
  });

  it("the deadline comes from the batch's settings snapshot; no snapshot or a snapshot without the key reads the default 6", async () => {
    expect(SETTING_DEFS.find((d) => d.key === OUTAGE_DEADLINE_KEY)).toMatchObject({ default: 6, inUse: true });
    expect(await deadlineHoursFor(db, { settingsSnapshotId: null })).toBe(6);
    const snap = async (id: string, data: object) => { await db.insert(catalogSettingsSnapshots).values({ id, data: { format: 1, defaults: {}, versions: [], taxonomyRevision: 0, ...data } as never, createdBy: "t@opptra.com" }); return id; };
    const two = await snap("s4b-two", { versions: [{ id: "v1", key: OUTAGE_DEADLINE_KEY, scope: {}, version: 1, value: 2 }] });
    const zero = await snap("s4b-zero", { defaults: { [OUTAGE_DEADLINE_KEY]: 0 } });
    const before = await snap("s4b-before", {});
    expect(await deadlineHoursFor(db, { settingsSnapshotId: two })).toBe(2);
    expect(await deadlineHoursFor(db, { settingsSnapshotId: zero })).toBe(0);
    expect(await deadlineHoursFor(db, { settingsSnapshotId: before })).toBe(6);
    expect(await deadlineHoursFor(db, { settingsSnapshotId: "gone" })).toBe(6);
  });

  it("the sentence is model-free and counts hours", () => {
    expect(outageDeadlineSentence(6)).toBe("The enlargement service could not be reached for 6 hours, so this photo was delivered without enlargement.");
    expect(outageDeadlineSentence(1)).toContain("for 1 hour,");
  });
});
