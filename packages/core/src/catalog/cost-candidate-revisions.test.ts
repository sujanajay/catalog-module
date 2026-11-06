// R1 exit finding 4 (M6 decision C6): a deploy's no-traffic candidate running next to a batch is the deploy's cost. The
// fixture is the shape of 2026-11-06: a GPU service's live revision serves a batch while a candidate of the next
// revision runs its probes on the same service; Cloud Monitoring reads them as two series. PGlite, the real migrations.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogTrafficShifts } from "../db/schema";
import { createTestDb } from "../db/testing";
import { recordTrafficShift } from "./reliability";
import type { TrafficEntry } from "./traffic-sync";
import { runCostReconcile, billedLines, googleCostReaders, reconcileDay, runResourceFrom, samplesFrom, trafficHistory, waitingForTraffic, type BillableSample, type MonitoringSeries, type RunResource } from "./cost-reconcile";

const DAY = "2026-11-10";
const SERVICE = "catalog-upscale-gpu", LIVE = `${SERVICE}-00030-liv`, CANDIDATE = `${SERVICE}-00031-can`, FAILED = `${SERVICE}-00032-bad`;
const RESOURCE: RunResource = { name: SERVICE, kind: "service", region: "asia-south2", labels: { app: "catalog", component: SERVICE, env: "live" }, cpu: 20, memoryGiB: 80, gpu: { type: "nvidia-rtx-pro-6000", count: 1, zonalRedundancy: false }, requestBased: false, liveRevisions: [CANDIDATE] };
const min = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);
const sample = (revision: string | undefined, from: string, minutes: number, perMinute = 60): BillableSample => {
  const points = Array.from({ length: minutes }, (_, i) => ({ endMs: min(from) + (i + 1) * 60_000, seconds: perMinute }));
  return { name: SERVICE, kind: "service", region: "asia-south2", seconds: perMinute * minutes, points, ...(revision ? { revision } : {}) };
};
const USD_PER_S = 0.00043826 + 20 * 0.0000216 + 80 * 0.0000024;

describe("waitingForTraffic", () => {
  const history = trafficHistory(
    [{ service: SERVICE, revision: LIVE, atMs: min("01:00") }, { service: SERVICE, revision: CANDIDATE, atMs: min("11:00") }],
    [{ liveRevisions: ["catalog-upscale-gpu-00099-now"] }],
  );
  it("a revision waits until its first shift, and one that never shifted waits for good", () => {
    expect(waitingForTraffic(history, SERVICE, CANDIDATE, min("10:30"))).toBe(true);
    expect(waitingForTraffic(history, SERVICE, CANDIDATE, min("11:00"))).toBe(true); // the minute ending at the shift
    expect(waitingForTraffic(history, SERVICE, CANDIDATE, min("11:01"))).toBe(false);
    expect(waitingForTraffic(history, SERVICE, FAILED, min("12:00"))).toBe(true);
  });
  it("a revision that lost traffic keeps counting: its idle tail follows its last work", () => {
    expect(waitingForTraffic(history, SERVICE, LIVE, min("11:10"))).toBe(false);
  });
  it("counts as serving when nothing is known: before the service's first record, another service, no revision name", () => {
    expect(waitingForTraffic(history, SERVICE, FAILED, min("00:30"))).toBe(false);
    expect(waitingForTraffic(history, "catalog-worker", "catalog-worker-00001-abc", min("12:00"))).toBe(false);
    expect(waitingForTraffic(history, SERVICE, undefined, min("12:00"))).toBe(false);
    expect(waitingForTraffic(undefined, SERVICE, FAILED, min("12:00"))).toBe(false);
  });
  it("a revision serving now with a lost shift record is never taken for a candidate", () => {
    expect(waitingForTraffic(history, SERVICE, "catalog-upscale-gpu-00099-now", min("12:00"))).toBe(false);
  });
});

describe("reading Cloud Monitoring per revision", () => {
  it("asks for the revision and keeps each revision's minutes apart", async () => {
    const urls: string[] = [];
    const point = (endTime: string, doubleValue: number) => ({ interval: { endTime }, value: { doubleValue } });
    const series: MonitoringSeries[] = [
      { resource: { type: "cloud_run_revision", labels: { service_name: SERVICE, revision_name: LIVE, location: "asia-south2" } }, points: [point(`${DAY}T10:01:00Z`, 60)] },
      { resource: { type: "cloud_run_revision", labels: { service_name: SERVICE, revision_name: CANDIDATE, location: "asia-south2" } }, points: [point(`${DAY}T10:01:00Z`, 30)] },
      { resource: { type: "cloud_run_job", labels: { job_name: "catalog-migrate", location: "asia-south1" } }, points: [point(`${DAY}T10:01:00Z`, 10)] },
    ];
    const readers = googleCostReaders(async (url) => { urls.push(url); return { timeSeries: series }; }, "image-links-agent");
    const samples = await readers.billableSeconds(new Date(`${DAY}T00:00:00Z`), new Date("2026-11-11T00:00:00Z"));
    expect(new URL(urls[0]!).searchParams.getAll("aggregation.groupByFields")).toContain("resource.label.revision_name");
    expect(samples.map((s) => [s.name, s.revision, s.seconds])).toEqual([[SERVICE, LIVE, 60], [SERVICE, CANDIDATE, 30], ["catalog-migrate", undefined, 10]]);
    expect(samplesFrom(series)).toEqual(samples);
  });

  it("the Cloud Run list names the serving revisions", () => {
    const item = { name: `projects/p/locations/x/services/${SERVICE}`, trafficStatuses: [{ revision: LIVE, percent: 100 }, { revision: CANDIDATE, percent: 0 }] };
    expect(runResourceFrom("service", "asia-south2", item).liveRevisions).toEqual([LIVE]);
    expect(runResourceFrom("service", "asia-south2", { name: item.name, trafficStatuses: [{ percent: 100 }], latestReadyRevision: `projects/p/locations/x/services/${SERVICE}/revisions/${CANDIDATE}` }).liveRevisions).toEqual([CANDIDATE]);
    expect(runResourceFrom("service", "asia-south2", { name: item.name }).liveRevisions).toBeUndefined();
  });

  it("revisions add up to one line per service, with one alert and the candidate time apart", () => {
    const history = trafficHistory([{ service: SERVICE, revision: LIVE, atMs: min("01:00") }], []);
    const { lines, alerts, minutes, noTrafficUsd } = billedLines(DAY, [sample(LIVE, "10:00", 10), sample(FAILED, "10:00", 5)], [RESOURCE], history);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.billableSeconds).toBe(900);
    expect(lines[0]!.billedUsd).toBeCloseTo(900 * USD_PER_S, 6);
    expect(lines[0]!.detail[SERVICE]).toMatchObject({ seconds: 900, noTrafficSeconds: 300 });
    expect(noTrafficUsd.get(SERVICE)).toBeCloseTo(300 * USD_PER_S, 6);
    expect(minutes.get(SERVICE)).toHaveLength(10);
    expect(alerts).toEqual([]);
    const gone = billedLines(DAY, [sample(LIVE, "10:00", 1), sample(FAILED, "10:00", 1)], []);
    expect(gone.alerts.filter((a) => a.code === "unpriced").map((a) => a.detail)).toEqual([{ seconds: 120 }]);
  });
});

describe("a candidate revision overlapping a batch", () => {
  let db: Db, close: () => Promise<void>, batch: string;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    batch = randomUUID();
    await db.execute(sql`INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, created_by, started_at, finished_at)
      VALUES (${batch}, 'b', 'B', 'n', 'done', 'x@example.com', ${`${DAY}T10:00:00Z`}::timestamptz, ${`${DAY}T10:30:00Z`}::timestamptz)`);
    // The batch works on the service from 10:00 to 10:30: three calls of 200 s, so every minute has work around it.
    for (const end of ["10:05", "10:15", "10:25"]) {
      await db.execute(sql`INSERT INTO catalog_cost_events (at, brand_slug, batch_id, kind, stage, engine, ms, billable_ms, usd, estimated, component, is_test)
        VALUES (${`${DAY}T${end}:00Z`}::timestamptz, 'b', ${batch}, 'upscale_call', 'upscale', 'gpu', 200000, 200000, ${200 * USD_PER_S}, true, ${SERVICE}, false)`);
    }
    await db.insert(catalogTrafficShifts).values({ service: SERVICE, revision: LIVE, shiftedAt: new Date(`${DAY}T01:00:00Z`) });
  });
  afterEach(async () => { await close(); });

  const allocation = async () => {
    const { rows } = (await db.execute(sql`SELECT attributed_usd::float8 AS attributed, idle_usd::float8 AS idle FROM catalog_cost_allocations WHERE batch_id = ${batch} AND component = ${SERVICE}`)) as unknown as { rows: { attributed: number; idle: number }[] };
    return rows[0]!;
  };
  const dayLine = async () => {
    const { rows } = (await db.execute(sql`SELECT billed_usd::float8 AS billed, idle_usd::float8 AS idle FROM catalog_cost_days WHERE day = ${DAY} AND component = ${SERVICE}`)) as unknown as { rows: { billed: number; idle: number }[] };
    return rows[0]!;
  };
  const LIVE_SECONDS = 1800, CANDIDATE_SECONDS = 1800;

  it("a candidate that never took traffic costs the batch nothing, and the day's bill still holds it", async () => {
    const samples = [sample(LIVE, "10:00", 30), sample(FAILED, "10:00", 30)];
    await reconcileDay(db, DAY, { samples, resources: [RESOURCE], provisional: true, now: new Date("2026-11-11T06:00:00Z") });
    const a = await allocation();
    expect(a.attributed).toBeCloseTo(600 * USD_PER_S, 6);
    expect(a.idle).toBeCloseTo((LIVE_SECONDS - 600) * USD_PER_S, 6);
    const line = await dayLine();
    expect(line.billed).toBeCloseTo((LIVE_SECONDS + CANDIDATE_SECONDS) * USD_PER_S, 6);
    expect(line.idle).toBeCloseTo((LIVE_SECONDS + CANDIDATE_SECONDS - 600) * USD_PER_S, 6);
    const { rows } = (await db.execute(sql`SELECT coalesce(sum(attributed_usd + idle_usd), 0)::float8 AS usd FROM catalog_cost_allocations WHERE batch_id = ${batch}`)) as unknown as { rows: { usd: number }[] };
    expect(rows[0]!.usd).toBeCloseTo(LIVE_SECONDS * USD_PER_S, 6);
  });

  it("a candidate's time counts on the batch only from its shift on", async () => {
    await db.insert(catalogTrafficShifts).values({ service: SERVICE, revision: CANDIDATE, shiftedAt: new Date(`${DAY}T10:20:00Z`) });
    const samples = [sample(LIVE, "10:00", 20), sample(CANDIDATE, "10:00", 30)];
    await reconcileDay(db, DAY, { samples, resources: [RESOURCE], provisional: true, now: new Date("2026-11-11T06:00:00Z") });
    // 20 minutes on the live revision and 10 on the new one after its shift; its first 20 minutes are the deploy's.
    expect((await allocation()).idle).toBeCloseTo((30 * 60 - 600) * USD_PER_S, 6);
    expect((await dayLine()).billed).toBeCloseTo(50 * 60 * USD_PER_S, 6);
  });

  it("review of PR #188: a lost record of a replaced revision keeps its batch's idle, and says so", async () => {
    // X served the batch and was replaced later that day, and its shift record was lost. FAILED is a real candidate.
    const X = `${SERVICE}-00033-xxx`;
    const result = await reconcileDay(db, DAY, { samples: [sample(FAILED, "09:00", 5), sample(X, "10:00", 30)], resources: [RESOURCE], provisional: true, now: new Date("2026-11-11T06:00:00Z") });
    const a = await allocation();
    expect(a.idle).toBeCloseTo(1200 * USD_PER_S, 6);
    expect(a.idle).toBeCloseTo(1.275, 2);
    expect(a.attributed).toBeCloseTo(600 * USD_PER_S, 6);
    const { rows } = (await db.execute(sql`SELECT detail FROM catalog_cost_days WHERE day = ${DAY} AND component = ${SERVICE}`)) as unknown as { rows: { detail: Record<string, { noTrafficSeconds?: number }> }[] };
    expect(rows[0]!.detail[SERVICE]!.noTrafficSeconds).toBeCloseTo(300, 6);
    const alerts = result.alerts.filter((x) => x.code === "traffic_shift_missing");
    expect(alerts.map((x) => [x.component, x.detail])).toEqual([[SERVICE, { revisions: [X] }]]);
  });

  it("a candidate beside the serving revision is never taken for a lost record, even with work in the same minutes", async () => {
    const result = await reconcileDay(db, DAY, { samples: [sample(LIVE, "10:00", 30), sample(FAILED, "10:00", 30)], resources: [RESOURCE], provisional: true, now: new Date("2026-11-11T06:00:00Z") });
    expect(result.alerts.filter((x) => x.code === "traffic_shift_missing")).toEqual([]);
  });

  it("a serving revision with no record raises the alert too; a re-run's repair ends it", async () => {
    const live = { ...RESOURCE, liveRevisions: [CANDIDATE] };
    const args = { samples: [sample(CANDIDATE, "10:00", 30)], resources: [live], provisional: true, now: new Date("2026-11-11T06:00:00Z") };
    expect((await reconcileDay(db, DAY, args)).alerts.map((x) => x.code)).toContain("traffic_shift_missing");
    await recordTrafficShift(db, { service: SERVICE, revision: CANDIDATE, at: new Date(`${DAY}T09:00:00Z`) });
    expect((await reconcileDay(db, DAY, args)).alerts.map((x) => x.code)).not.toContain("traffic_shift_missing");
  });

  describe("the daily run fills records from the audit log first", () => {
    // Review round 2, P3-1: all of X's work ends inside the old revision's idle tail, so the fail-safe alone cannot see it.
    const X = `${SERVICE}-00034-xxx`;
    const samples = [sample(LIVE, "09:57", 33), sample(X, "10:05", 25)];
    const run = (trafficAudit?: () => Promise<TrafficEntry[]>) => runCostReconcile(db, {
      resources: async () => [RESOURCE],
      billableSeconds: async (from) => (from.toISOString().startsWith(DAY) ? samples : []),
      ...(trafficAudit ? { trafficAudit } : {}),
    }, { now: new Date("2026-11-11T06:00:00Z"), days: 1 });

    it("the narrow gap: the lost move comes back, so the batch keeps X's idle", async () => {
      await run(async () => [{ service: SERVICE, atMs: min("10:05"), serving: [X] }]);
      const { rows } = (await db.execute(sql`SELECT count(*)::int AS n FROM catalog_traffic_shifts WHERE revision = ${X} AND shifted_at = ${new Date(min("10:05")).toISOString()}::timestamptz`)) as unknown as { rows: { n: number }[] };
      expect(rows[0]!.n).toBe(1);
      expect((await allocation()).idle).toBeCloseTo((58 * 60 - 600) * USD_PER_S, 6);
    });

    it("the same day with no audit read shows the gap the sync closes: X is taken for a candidate, with no alert", async () => {
      const result = await run();
      expect((await allocation()).idle).toBeCloseTo((33 * 60 - 600) * USD_PER_S, 6);
      expect(result.alerts.filter((x) => x.code === "traffic_shift_missing")).toEqual([]);
    });

    it("an unreadable audit log still closes the day and raises the alert", async () => {
      const result = await run(async () => { throw new Error("403 from logging"); });
      expect(result.days).toHaveLength(1);
      expect(result.alerts.find((x) => x.code === "traffic_shift_missing" && x.component === null)?.text).toContain("403 from logging");
    });

    it("a serving revision with no time at all raises the alert and counts as serving", async () => {
      const result = await runCostReconcile(db, { resources: async () => [{ ...RESOURCE, liveRevisions: [X] }], billableSeconds: async () => [], trafficAudit: async () => [] }, { now: new Date("2026-11-11T06:00:00Z"), days: 1 });
      expect(result.alerts.find((x) => x.code === "traffic_shift_missing" && x.component === null)?.detail).toEqual({ revisions: [X] });
    });
  });

  it("the same day read per service, or before any shift was recorded, keeps the old rule", async () => {
    await reconcileDay(db, DAY, { samples: [sample(undefined, "10:00", 30, 120)], resources: [RESOURCE], provisional: true, now: new Date("2026-11-11T06:00:00Z") });
    expect((await allocation()).idle).toBeCloseTo((3600 - 600) * USD_PER_S, 6);
  });
});

describe("the recorded history of 2026-11-06 (migration 0028)", () => {
  it("names the revisions that served batch 84a5a30a and not the forced deploy's candidates", async () => {
    const { db, close } = await createTestDb();
    try {
      const { rows } = (await db.execute(sql`SELECT service, revision, shifted_at FROM catalog_traffic_shifts`)) as unknown as { rows: { service: string; revision: string; shifted_at: string }[] };
      const history = trafficHistory(rows.map((r) => ({ service: r.service, revision: r.revision, atMs: +new Date(r.shifted_at) })), []);
      const during = Date.parse("2026-11-06T04:30:00Z"), later = Date.parse("2026-11-06T05:00:00Z");
      for (const [service, revision] of [["catalog-worker", "catalog-worker-00080-qaz"], ["catalog-upscale-gpu", "catalog-upscale-gpu-00024-teq"], ["catalog-matting-gpu", "catalog-matting-gpu-00074-duz"], ["catalog-matting", "catalog-matting-00081-dew"]] as const) {
        expect(waitingForTraffic(history, service, revision, during)).toBe(false);
      }
      for (const [service, revision] of [["catalog-upscale-gpu", "catalog-upscale-gpu-00027-jed"], ["catalog-matting-gpu", "catalog-matting-gpu-00077-nuq"], ["catalog-upscale", "catalog-upscale-00047-mey"], ["catalog-matting", "catalog-matting-00084-mey"]] as const) {
        expect(waitingForTraffic(history, service, revision, during)).toBe(true);
      }
      for (const [service, revision] of [["catalog-upscale-gpu", "catalog-upscale-gpu-00028-vot"], ["catalog-matting-gpu", "catalog-matting-gpu-00078-qut"], ["catalog-upscale", "catalog-upscale-00048-ruj"], ["catalog-matting", "catalog-matting-00085-naz"]] as const) {
        expect(waitingForTraffic(history, service, revision, later)).toBe(true);
      }
    } finally { await close(); }
  });
});
