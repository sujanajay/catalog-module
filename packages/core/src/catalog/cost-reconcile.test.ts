// M6-S2: the daily cost reconciliation (M6-F1-R4 to R6, R10). Pure pricing first, then Tier 2 (PGlite, the real
// migrations) for the day rows, allocations, alerts and the Ops card. Acceptance test 3: the monitoring estimate,
// marked estimated, within 10% of a hand calculation from billable_instance_time (the cost report method).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { changeSetting } from "../settings/store";
import { COST_DATABASE_SHARE_KEY, COST_DATABASE_USD_PER_DAY_KEY, DEFAULT_DATABASE_SHARE_PERCENT, DEFAULT_DATABASE_USD_PER_DAY } from "../settings/registry";
import {
  billedLines, costCard, cpuQuantity, googleCostReaders, instancePrice, memoryGiB, reconcileDay, runCostReconcile, runResourceFrom, samplesFrom, utcDay,
  type BillableSample, type CostReaders, type RunResource, type V2Item,
} from "./cost-reconcile";

// The live shapes and labels of 2026-11-05 (Cloud Run Admin API v2, read only), as the API returns them.
const svc = (name: string, labels: Record<string, string>, limits: Record<string, string>, extra: Record<string, unknown> = {}): V2Item =>
  ({ name: `projects/image-links-agent/locations/x/services/${name}`, labels, template: { containers: [{ resources: { limits, cpuIdle: true } }], ...extra } as V2Item["template"] });
const job = (name: string, labels: Record<string, string>, limits: Record<string, string>): V2Item =>
  ({ name: `projects/image-links-agent/locations/asia-south1/jobs/${name}`, labels, template: { template: { containers: [{ resources: { limits } }] } } as V2Item["template"] });
const L = (component: string, env = "live") => ({ app: "catalog", component, env });
const gpuSvc = (name: string, limits: Record<string, string>, accelerator: string): V2Item =>
  ({ name, labels: L(name), template: { containers: [{ resources: { limits } }], nodeSelector: { accelerator }, gpuZonalRedundancyDisabled: true } });

const RESOURCES: RunResource[] = [
  runResourceFrom("service", "asia-south1", svc("catalog-worker", L("catalog-worker"), { cpu: "4", memory: "4Gi" })),
  runResourceFrom("service", "asia-south1", svc("catalog-worker-preview", L("catalog-worker-preview", "preview"), { cpu: "4", memory: "4Gi" })),
  runResourceFrom("service", "asia-south1", svc("catalog-web", L("catalog-web"), { cpu: "1", memory: "1Gi" })),
  runResourceFrom("service", "asia-south1", svc("catalog-matting", L("catalog-matting"), { cpu: "4", memory: "16Gi" })),
  runResourceFrom("service", "asia-south1", svc("catalog-upscale", L("catalog-upscale"), { cpu: "4", memory: "8Gi" })),
  runResourceFrom("service", "asia-southeast1", gpuSvc("catalog-matting-gpu", { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" }, "nvidia-l4")),
  runResourceFrom("service", "asia-south2", gpuSvc("catalog-upscale-gpu", { cpu: "20", memory: "80Gi", "nvidia.com/gpu": "1" }, "nvidia-rtx-pro-6000")),
  runResourceFrom("job", "asia-south1", job("catalog-load", L("catalog-load", "test"), { cpu: "2", memory: "4Gi" })),
  runResourceFrom("job", "asia-south1", job("catalog-check-matting", L("catalog-check-matting", "test"), { cpu: "1", memory: "1Gi" })),
  runResourceFrom("job", "asia-south1", job("catalog-migrate", L("catalog-migrate"), { cpu: "1000m", memory: "512Mi" })),
  runResourceFrom("job", "asia-south1", job("catalog-test-cleanup", {}, { cpu: "2", memory: "4Gi" })),
  runResourceFrom("job", "asia-south1", job("competitor-pricing-job", { app: "competitor-pricing" }, { cpu: "1", memory: "512Mi" })),
];

// Cloud Monitoring billable_instance_time for 2026-11-03, summed per service or job (read only, 2026-11-05).
const SAMPLES_2026_11_03: BillableSample[] = [
  { name: "catalog-worker", kind: "service", region: "asia-south1", seconds: 120.6 },
  { name: "catalog-worker-preview", kind: "service", region: "asia-south1", seconds: 27952.71025755429 },
  { name: "catalog-web", kind: "service", region: "asia-south1", seconds: 92.91961119472437 },
  { name: "catalog-matting", kind: "service", region: "asia-south1", seconds: 1913.706669149022 },
  { name: "catalog-upscale", kind: "service", region: "asia-south1", seconds: 6519.410497133441 },
  { name: "catalog-matting-gpu", kind: "service", region: "asia-southeast1", seconds: 20784.72863594605 },
  { name: "catalog-upscale-gpu", kind: "service", region: "asia-south2", seconds: 8061.025772063526 },
  { name: "catalog-load", kind: "job", region: "asia-south1", seconds: 8065.142922781049 },
  { name: "catalog-check-matting", kind: "job", region: "asia-south1", seconds: 2419.2668617880004 },
  { name: "catalog-migrate", kind: "job", region: "asia-south1", seconds: 0.1489124286776335 },
  { name: "catalog-test-cleanup", kind: "job", region: "asia-south1", seconds: 1474.7925069039034 },
  { name: "competitor-pricing-job", kind: "job", region: "asia-south1", seconds: 126.47198441754767 },
];

// The hand calculation: the cost report's USD per second per service (.runs/2026-11-02-cost-and-quota.md section 1,
// catalog/cost.ts and job-cost.ts), written out here independently of the rate card.
const HAND_USD_PER_SECOND: Record<string, number> = {
  "catalog-worker": 4 * 0.000024 + 4 * 0.0000025, // 0.000106
  "catalog-worker-preview": 0.000106,
  "catalog-web": 0.000024 + 0.0000025,
  "catalog-matting": 0.000136,
  "catalog-upscale": 0.000116,
  "catalog-matting-gpu": 0.00034884,
  "catalog-upscale-gpu": 0.00106226,
  "catalog-load": 0.000044,
  "catalog-check-matting": 0.000018 + 0.000002,
  "catalog-migrate": 0.000018 + 0.5 * 0.000002,
  "catalog-test-cleanup": 0.000044,
};

describe("pricing (pure)", () => {
  it("reads Cloud Run quantities", () => {
    expect([cpuQuantity("4"), cpuQuantity("1000m"), cpuQuantity("250m"), cpuQuantity(undefined)]).toEqual([4, 1, 0.25, 0]);
    expect([memoryGiB("4Gi"), memoryGiB("512Mi"), memoryGiB("80Gi"), memoryGiB("bad")]).toEqual([4, 0.5, 80, 0]);
    expect(memoryGiB("2G")).toBeCloseTo(2e9 / 1024 ** 3, 9);
  });

  it("prices every live shape at the documented per-second rate, GPU services instance-based", () => {
    const byName = new Map(RESOURCES.map((r) => [r.name, r]));
    for (const [name, rate] of Object.entries(HAND_USD_PER_SECOND)) expect(instancePrice(byName.get(name)!)!.usdPerSecond, name).toBeCloseTo(rate, 12);
    expect(byName.get("catalog-worker")!.requestBased).toBe(true);
    expect(byName.get("catalog-upscale-gpu")!).toMatchObject({ requestBased: false, gpu: { type: "nvidia-rtx-pro-6000", count: 1, zonalRedundancy: false } });
    expect(byName.get("catalog-load")!.requestBased).toBe(false);
  });

  it("refuses to guess a price the card does not hold (another region, a zonal GPU)", () => {
    const worker = RESOURCES[0]!;
    expect(instancePrice({ ...worker, region: "us-central1" })).toBeNull();
    expect(instancePrice({ ...RESOURCES[5]!, gpu: { type: "nvidia-l4", count: 1, zonalRedundancy: true } })).toBeNull();
  });

  it("sums Cloud Monitoring series per service or job and skips other resource types", () => {
    expect(samplesFrom([
      { resource: { type: "cloud_run_revision", labels: { service_name: "catalog-web", location: "asia-south1" } }, points: [{ value: { doubleValue: 2 } }, { value: { doubleValue: 3.5 } }] },
      { resource: { type: "cloud_run_job", labels: { job_name: "catalog-load", location: "asia-south1" } }, points: [{ value: { int64Value: "7" } }] },
      { resource: { type: "gce_instance", labels: {} }, points: [{ value: { doubleValue: 9 } }] },
    ])).toEqual([{ name: "catalog-web", kind: "service", region: "asia-south1", seconds: 5.5 }, { name: "catalog-load", kind: "job", region: "asia-south1", seconds: 7 }]);
  });

  it("reads every page of the Admin API and Cloud Monitoring, one day aligned as one point per resource", async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.host === "run.googleapis.com") {
        if (u.pathname.endsWith("asia-south1/services") && !u.searchParams.get("pageToken")) return { services: [svc("catalog-web", L("catalog-web"), { cpu: "1", memory: "1Gi" })], nextPageToken: "p2" };
        if (u.pathname.endsWith("asia-south1/services")) return { services: [svc("catalog-worker", L("catalog-worker"), { cpu: "4", memory: "4Gi" })] };
        return {};
      }
      return u.searchParams.get("pageToken") ? { timeSeries: [{ resource: { type: "cloud_run_job", labels: { job_name: "catalog-load", location: "asia-south1" } }, points: [{ value: { doubleValue: 1 } }] }] }
        : { timeSeries: [], nextPageToken: "m2" };
    };
    const readers = googleCostReaders(get, "image-links-agent");
    expect((await readers.resources()).map((r) => r.name)).toEqual(["catalog-web", "catalog-worker"]);
    expect(urls.filter((u) => u.includes("run.googleapis.com"))).toHaveLength(7); // 3 regions x services and jobs, plus page 2
    const from = new Date("2026-11-03T00:00:00Z");
    expect(await readers.billableSeconds(from, new Date(+from + 86_400_000))).toEqual([{ name: "catalog-load", kind: "job", region: "asia-south1", seconds: 1 }]);
    const m = new URL(urls.find((u) => u.includes("monitoring"))!);
    expect(m.searchParams.get("filter")).toBe('metric.type="run.googleapis.com/container/billable_instance_time"');
    expect(m.searchParams.get("aggregation.alignmentPeriod")).toBe("86400s");
    expect(m.searchParams.getAll("aggregation.groupByFields")).toEqual(["resource.type", "resource.label.service_name", "resource.label.job_name", "resource.label.location"]);
  });
});

describe("M6-F1 acceptance test 3: the monitoring estimate before the export", () => {
  it("bills each catalog service and job within 10% of the hand calculation, marked estimated, other apps left out", () => {
    const { lines, alerts } = billedLines("2026-11-03", SAMPLES_2026_11_03, RESOURCES);
    expect(lines.map((l) => l.component).sort()).toEqual(Object.keys(HAND_USD_PER_SECOND).sort());
    let hand = 0, ours = 0;
    for (const line of lines) {
      const expected = SAMPLES_2026_11_03.find((s) => s.name === line.component)!.seconds * HAND_USD_PER_SECOND[line.component]!;
      expect(Math.abs(line.billedUsd - expected), line.component).toBeLessThanOrEqual(0.1 * expected);
      expect(line.estimated).toBe(true);
      hand += expected; ours += line.billedUsd;
    }
    expect(Math.abs(ours - hand) / hand).toBeLessThan(0.1);
    // The day's catalog Cloud Run cost by this method, preview and test included (worked through in the M6-S2 report).
    expect(ours).toBeGreaterThan(20.2);
    expect(ours).toBeLessThan(20.4);
    expect(lines.find((l) => l.component === "catalog-worker-preview")!.env).toBe("preview");
    expect(lines.find((l) => l.component === "catalog-load")!.env).toBe("test");
    expect(lines.find((l) => l.component === "catalog-test-cleanup")!.env).toBe("unlabelled");
    expect(alerts.map((a) => [a.code, a.component])).toEqual([["unlabelled", "catalog-test-cleanup"]]);
  });

  it("bills a catalog job that no longer exists at 0 with an unpriced alert", () => {
    const { lines, alerts } = billedLines("2026-11-03", [{ name: "catalog-gone", kind: "job", region: "asia-south1", seconds: 60 }], RESOURCES);
    expect(lines).toMatchObject([{ component: "catalog-gone", billedUsd: 0, env: "unlabelled" }]);
    expect(alerts.map((a) => a.code)).toEqual(["unpriced"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
let db: Db;
let close: () => Promise<void>;
const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;
const DAY = "2026-11-03";
const at = (hh: number) => new Date(`${DAY}T${String(hh).padStart(2, "0")}:00:00Z`);
const NOW = new Date("2026-11-04T06:00:00Z");

async function batch(name: string, opts: { brand?: string; isTest?: boolean; productsWithLinks?: number } = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, is_test, created_by, started_at, finished_at)
    VALUES (${id}, ${opts.brand ?? "uspa"}, ${opts.brand?.toUpperCase() ?? "USPA"}, ${name}, 'done', ${opts.isTest ?? false}, 'op@opptra.com', ${at(1).toISOString()}::timestamptz, ${at(20).toISOString()}::timestamptz)`);
  if (opts.productsWithLinks !== undefined) {
    await db.execute(sql`INSERT INTO catalog_batch_outcomes (batch_id, status, success, ended_at, products, products_with_links, is_test)
      VALUES (${id}, 'done', true, ${at(20).toISOString()}::timestamptz, ${opts.productsWithLinks}, ${opts.productsWithLinks}, ${opts.isTest ?? false})`);
  }
  return id;
}

async function ledger(row: { batchId: string | null; component: string | null; kind?: string; engine?: string; ms: number; usd: number; outcome?: string; at?: Date; billableMs?: number | null }) {
  await db.execute(sql`INSERT INTO catalog_cost_events (batch_id, brand_slug, stage, kind, engine, ms, usd, outcome, component, billable_ms, at)
    VALUES (${row.batchId}, ${row.batchId ? "uspa" : null}, 'upscale', ${row.kind ?? "upscale_call"}, ${row.engine ?? "gpu"}, ${row.ms}, ${row.usd}, ${row.outcome ?? "ok"},
      ${row.component}, ${row.billableMs ?? null}, ${(row.at ?? at(10)).toISOString()}::timestamptz)`);
}

const upscaleGpu = RESOURCES.find((r) => r.name === "catalog-upscale-gpu")!;
const workerRes = RESOURCES.find((r) => r.name === "catalog-worker")!;
const sample = (name: string, seconds: number): BillableSample => {
  const r = RESOURCES.find((x) => x.name === name)!;
  return { name, kind: r.kind, region: r.region, seconds };
};

beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

describe("reconcileDay", () => {
  it("F1 test 2: failed upscaler calls are attributed, and the day's idle is its own line spread over batches by busy seconds", async () => {
    const a = await batch("A", { productsWithLinks: 10 });
    const b = await batch("B", { productsWithLinks: 5 });
    // Batch A: 300 s of upscale calls, 60 s of them failed (the upscaler was killed mid-batch); batch B: 100 s.
    await ledger({ batchId: a, component: "catalog-upscale-gpu", ms: 240_000, usd: 240 * 0.00106226 });
    await ledger({ batchId: a, component: "catalog-upscale-gpu", ms: 60_000, usd: 60 * 0.00106226, outcome: "failed" });
    await ledger({ batchId: b, component: "catalog-upscale-gpu", ms: 100_000, usd: 100 * 0.00106226 });
    // Billed: 1000 s of instance time (start-ups, idle tails); the ledger explains 400 s.
    const result = await reconcileDay(db, DAY, { samples: [sample("catalog-upscale-gpu", 1000)], resources: [upscaleGpu], provisional: true, now: NOW });

    const line = result.lines.find((l) => l.component === "catalog-upscale-gpu")!;
    const rate = instancePrice(upscaleGpu)!.usdPerSecond;
    expect(line.billedUsd).toBeCloseTo(1000 * rate, 9);
    expect(line.attributedUsd).toBeCloseTo(400 * 0.00106226, 9);
    expect(line.idleUsd).toBeCloseTo(600 * 0.00106226, 9);
    expect(result.alerts).toEqual([]);

    const dayRows = await rows(sql`SELECT component, kind, env, source, billed_usd::float8 AS billed, attributed_usd::float8 AS attributed, idle_usd::float8 AS idle, estimated, provisional FROM catalog_cost_days WHERE day = ${DAY} ORDER BY component`);
    expect(dayRows.map((r) => r.component)).toEqual(["catalog-upscale-gpu", "ila-pg"]);
    expect(dayRows[0]).toMatchObject({ kind: "service", env: "live", source: "monitoring", estimated: true, provisional: true });
    const alloc = await rows(sql`SELECT batch_id, component, busy_ms::int AS busy, attributed_usd::float8 AS attributed, idle_usd::float8 AS idle, shared_usd::float8 AS shared FROM catalog_cost_allocations WHERE day = ${DAY}`);
    const of = (id: string, c: string) => alloc.find((r) => r.batch_id === id && r.component === c)!;
    expect(of(a, "catalog-upscale-gpu").busy).toBe(300_000);
    expect(of(a, "catalog-upscale-gpu").idle as number).toBeCloseTo(0.75 * line.idleUsd, 6);
    expect(of(b, "catalog-upscale-gpu").idle as number).toBeCloseTo(0.25 * line.idleUsd, 6);
    // The shared database line: the default day cost and share, spread by attributed cost (A 3x B).
    const shared = DEFAULT_DATABASE_USD_PER_DAY * DEFAULT_DATABASE_SHARE_PERCENT / 100;
    expect((of(a, "ila-pg").shared as number) + (of(b, "ila-pg").shared as number)).toBeCloseTo(shared, 6);
    expect(of(a, "ila-pg").shared as number).toBeCloseTo(0.75 * shared, 6);
    // R9: the batch outcome's true cost = attributed + idle + shared.
    const [outcome] = await rows(sql`SELECT true_cost_usd::float8 AS t FROM catalog_batch_outcomes WHERE batch_id = ${a}`);
    expect(outcome!.t as number).toBeCloseTo(300 * 0.00106226 + 0.75 * line.idleUsd + 0.75 * shared, 5);
  });

  it("a day with billed time and no batch keeps the whole amount as idle with no batch; old ledger rows find their component", async () => {
    // A pre-M6-S1 row (no component): a worker render with no batch.
    await ledger({ batchId: null, component: null, kind: "render", engine: "worker", ms: 10_000, usd: 0.001 });
    const result = await reconcileDay(db, DAY, { samples: [sample("catalog-worker", 600)], resources: [workerRes], provisional: false, now: NOW });
    expect(result.allocations).toBe(0);
    const card = await costCard(db, "2026-11-01", "2026-11-05");
    expect(card.days).toHaveLength(1);
    const d = card.days[0]!;
    expect(d.billedUsd).toBeCloseTo(600 * 0.000106, 9);
    expect(d.attributedUsd).toBeCloseTo(0.001, 9);
    expect(d.idleNoBatchUsd).toBeCloseTo(600 * 0.000106 - 0.001, 9);
    expect(d).toMatchObject({ provisional: false, estimated: true, closes: true });
  });

  it("R10: a ledger above the bill is an alert, written once however often the day is re-computed; a re-run replaces the day", async () => {
    const a = await batch("A");
    await ledger({ batchId: a, component: "catalog-worker", kind: "compute", engine: "worker", ms: 1_000_000, usd: 1 });
    const readers: CostReaders = { resources: async () => [workerRes], billableSeconds: async (from) => (from.toISOString().startsWith(DAY) ? [sample("catalog-worker", 600)] : []) };
    const first = await runCostReconcile(db, readers, { now: NOW, days: 1 });
    expect(first.newAlerts.map((x) => [x.code, x.component, x.day])).toEqual([["ledger_over", "catalog-worker", DAY]]);
    const line = first.days[0]!.lines.find((l) => l.component === "catalog-worker")!;
    expect(line.idleUsd).toBe(0);
    const second = await runCostReconcile(db, readers, { now: NOW, days: 1 });
    expect(second.alerts).toHaveLength(1);
    expect(second.newAlerts).toEqual([]);
    expect(await rows(sql`SELECT kind, cause_code FROM catalog_incidents`)).toEqual([{ kind: "alert", cause_code: "ledger_over" }]);
    expect((await rows(sql`SELECT count(*)::int AS n FROM catalog_cost_days WHERE day = ${DAY}`))[0]!.n).toBe(2);
    const card = await costCard(db, "2026-11-01", "2026-11-05");
    expect(card.days[0]!.closes).toBe(false);
    expect(card.alerts).toEqual([{ code: "ledger_over", count: 1 }]);
  });

  it("vendor calls are their own line at the vendor's reported cost; the shared line follows the admin settings", async () => {
    await changeSetting(db, { key: COST_DATABASE_USD_PER_DAY_KEY, value: 4 }, "admin@opptra.com");
    await changeSetting(db, { key: COST_DATABASE_SHARE_KEY, value: 50 }, "admin@opptra.com");
    const a = await batch("A", { productsWithLinks: 4 });
    await ledger({ batchId: a, component: "openrouter", kind: "llm_call", engine: "judge", ms: 1000, usd: 0.02 });
    const result = await reconcileDay(db, DAY, { samples: [], resources: [], provisional: true, now: NOW });
    expect(result.lines.find((l) => l.component === "openrouter")).toMatchObject({ kind: "vendor", billedUsd: 0.02, attributedUsd: 0.02, idleUsd: 0 });
    expect(result.lines.find((l) => l.component === "ila-pg")).toMatchObject({ kind: "shared", billedUsd: 4, sharedUsd: 2 });
    expect(result.alerts).toEqual([]);
    const card = await costCard(db, "2026-11-01", "2026-11-05");
    expect(card.days[0]).toMatchObject({ vendorUsd: 0.02, sharedUsd: 2, totalUsd: 2.02 });
    expect(card.batches).toMatchObject([{ batchId: a, productsWithLinks: 4, marginalUsd: 0.02 }]);
    expect(card.batches[0]!.truePerProductUsd!).toBeCloseTo(2.02 / 4, 9);
    expect(card.brands).toMatchObject([{ brandName: "USPA", batches: 1, productsWithLinks: 4 }]);
  });

  it("preview and test resources are reported apart from operator cost", async () => {
    await reconcileDay(db, DAY, { samples: SAMPLES_2026_11_03, resources: RESOURCES, provisional: true, now: NOW });
    const card = await costCard(db, "2026-11-01", "2026-11-05");
    const live = ["catalog-worker", "catalog-web", "catalog-matting", "catalog-upscale", "catalog-matting-gpu", "catalog-upscale-gpu", "catalog-migrate"]
      .reduce((s, c) => s + SAMPLES_2026_11_03.find((x) => x.name === c)!.seconds * HAND_USD_PER_SECOND[c]!, 0);
    expect(card.days[0]!.billedUsd).toBeCloseTo(live, 5);
    expect(card.apart.map((x) => x.env).sort()).toEqual(["preview", "test", "unlabelled"]);
  });
});

describe("runCostReconcile", () => {
  it("re-computes the last three complete UTC days, D-1 and D-2 provisional", async () => {
    const asked: string[] = [];
    const readers: CostReaders = { resources: async () => RESOURCES, billableSeconds: async (from) => { asked.push(from.toISOString().slice(0, 10)); return []; } };
    const result = await runCostReconcile(db, readers, { now: new Date("2026-11-05T06:00:00Z") });
    expect(asked).toEqual(["2026-11-04", "2026-11-03", "2026-11-02"]);
    expect(await rows(sql`SELECT day::text AS day, provisional FROM catalog_cost_days ORDER BY day`)).toEqual([
      { day: "2026-11-02", provisional: false }, { day: "2026-11-03", provisional: true }, { day: "2026-11-04", provisional: true }]);
    expect(result.newAlerts).toEqual([]);
    expect(utcDay(new Date("2026-11-05T00:00:01Z"), 1)).toBe("2026-11-04");
  });

  it("M6 decision S6-8: a 7-day batch success rate under 99% is an alert once a day", async () => {
    const id = await batch("A");
    await db.execute(sql`INSERT INTO catalog_batch_outcomes (batch_id, status, success, ended_at) VALUES (${id}, 'failed', false, ${new Date("2026-11-03T10:00:00Z").toISOString()}::timestamptz)`);
    const readers: CostReaders = { resources: async () => [], billableSeconds: async () => [] };
    const first = await runCostReconcile(db, readers, { now: NOW, days: 1 });
    expect(first.newAlerts.map((a) => a.code)).toEqual(["success_under_target"]);
    expect((await runCostReconcile(db, readers, { now: NOW, days: 1 })).newAlerts).toEqual([]);
  });
});
