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
  allocateIdle, billedLines, costCard, cpuQuantity, dayLedger, googleCostReaders, IDLE_LEAD_MS, IDLE_TAIL_MS, instancePrice, ledgerDay, instanceUsdPerMs, memoryGiB, reconcileDay, runCostReconcile, runResourceFrom, samplesFrom, utcDay,
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

  it("reads every page of the Admin API and Cloud Monitoring, the day aligned per minute", async () => {
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
    // Per minute (M6 decision C1): idle is placed on the minute it was billed in.
    expect(m.searchParams.get("aggregation.alignmentPeriod")).toBe("60s");
    expect(m.searchParams.getAll("aggregation.groupByFields")).toEqual(["resource.type", "resource.label.service_name", "resource.label.revision_name", "resource.label.job_name", "resource.label.location"]);
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
    await ledger({ batchId: a, component: "catalog-upscale-gpu", ms: 240_000, usd: 240 * 0.00106226, at: at(8) });
    await ledger({ batchId: a, component: "catalog-upscale-gpu", ms: 60_000, usd: 60 * 0.00106226, outcome: "failed", at: at(9) });
    await ledger({ batchId: b, component: "catalog-upscale-gpu", ms: 100_000, usd: 100 * 0.00106226, at: at(10) });
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

describe("review fixes of PR #173", () => {
  it("P2-1: four upscaler calls at once on one GPU instance cost one instance's time, shared by the calls", async () => {
    const rate = instancePrice(upscaleGpu)!.usdPerSecond;
    const a = await batch("A"), b = await batch("B");
    // The upscaler serves 4 requests at once. Four 4 s calls (3 for A, 1 for B, one of A's failed) each priced at the full
    // instance rate, over the same 4 s: 16 ledger-seconds against 4 s of instance time.
    for (const [id, outcome] of [[a, "ok"], [a, "ok"], [a, "failed"], [b, "ok"]] as const) {
      await ledger({ batchId: id, component: "catalog-upscale-gpu", ms: 4000, usd: 4 * rate, outcome, at: at(10) });
    }
    const result = await reconcileDay(db, DAY, { samples: [sample("catalog-upscale-gpu", 10)], resources: [upscaleGpu], provisional: true, now: NOW });
    const line = result.lines.find((l) => l.component === "catalog-upscale-gpu")!;
    expect(line.attributedUsd).toBeCloseTo(4 * rate, 9);
    expect(line.idleUsd).toBeCloseTo(6 * rate, 9);
    expect(result.alerts).toEqual([]);
    const alloc = await rows(sql`SELECT batch_id, busy_ms::int AS busy, attributed_usd::float8 AS attributed FROM catalog_cost_allocations WHERE day = ${DAY} AND component = 'catalog-upscale-gpu'`);
    const of = (id: string) => alloc.find((r) => r.batch_id === id)!;
    expect(of(a).attributed as number).toBeCloseTo(3 * rate, 6);
    expect(of(b).attributed as number).toBeCloseTo(rate, 6);
    expect([of(a).busy, of(b).busy]).toEqual([12_000, 4000]);
  });

  it("P2-1: rows priced at a part of an instance keep their cost while they fit in one; a partial overlap is shared only where it overlaps", () => {
    const cap = new Map([["c", 1]]); // USD per ms of one instance
    const e = (batchId: string, endMs: number, busyMs: number, usdPerMs: number) => ({ component: "c", batchId, endMs, busyMs, usd: busyMs * usdPerMs, estimated: false });
    // Two quarter-instance rows at once: under the cap, unchanged.
    expect(dayLedger([e("a", 100, 100, 0.25), e("b", 100, 100, 0.25)], 0, 1000, cap).map((r) => r.usd)).toEqual([25, 25]);
    // Two full-instance rows overlapping for 50 ms of their 100: the overlap is split, the rest stays whole.
    const [x, y] = dayLedger([e("a", 100, 100, 1), e("b", 150, 100, 1)], 0, 1000, cap);
    expect([x!.usd, y!.usd]).toEqual([75, 75]);
    // No known instance price (an unpriced shape): no cap.
    expect(dayLedger([e("a", 100, 100, 1), e("b", 100, 100, 1)], 0, 1000, new Map()).map((r) => r.usd)).toEqual([100, 100]);
    expect(instanceUsdPerMs([upscaleGpu]).get("catalog-upscale-gpu")).toBeCloseTo(instancePrice(upscaleGpu)!.usdPerSecond / 1000, 15);
  });

  it("P2-3: work that crosses midnight UTC counts on each day by the part that ran in it, so neither day raises a false alert", async () => {
    const loadJob = runResourceFrom("job", "asia-south1", job("catalog-recheck", L("catalog-recheck"), { cpu: "2", memory: "4Gi" }));
    const rate = instancePrice(loadJob)!.usdPerSecond;
    const a = await batch("A");
    // A 30-minute job run from 23:45 to 00:15 UTC, recorded when it ended (on the next day).
    await ledger({ batchId: a, component: "catalog-recheck", kind: "job", engine: "job", ms: 1_800_000, billableMs: 1_800_000, usd: 1800 * rate, at: new Date("2026-11-04T00:15:00Z") });
    const billed = (seconds: number): BillableSample[] => [{ name: "catalog-recheck", kind: "job", region: "asia-south1", seconds }];
    const d = await reconcileDay(db, DAY, { samples: billed(900), resources: [loadJob], provisional: true, now: NOW });
    const next = await reconcileDay(db, "2026-11-04", { samples: billed(900), resources: [loadJob], provisional: true, now: NOW });
    for (const r of [d, next]) {
      const line = r.lines.find((l) => l.component === "catalog-recheck")!;
      expect(line.attributedUsd, r.day).toBeCloseTo(900 * rate, 9);
      expect(line.idleUsd, r.day).toBeCloseTo(0, 9);
      expect(r.alerts, r.day).toEqual([]);
    }
    const busy = await rows(sql`SELECT day::text AS day, busy_ms::int AS busy FROM catalog_cost_allocations WHERE component = 'catalog-recheck' ORDER BY day`);
    expect(busy).toEqual([{ day: DAY, busy: 900_000 }, { day: "2026-11-04", busy: 900_000 }]);
  });

  it("P2-2: a run that fails part-way writes no day, records one run_failed alert per UTC day and throws", async () => {
    let calls = 0;
    const readers: CostReaders = {
      resources: async () => RESOURCES,
      billableSeconds: async () => { if (++calls === 2) throw new Error("Cloud Monitoring timed out"); return [sample("catalog-web", 10)]; },
    };
    await expect(runCostReconcile(db, readers, { now: NOW })).rejects.toThrow("Cloud Monitoring timed out");
    expect(await rows(sql`SELECT count(*)::int AS n FROM catalog_cost_days`)).toEqual([{ n: 0 }]);
    calls = 0;
    await expect(runCostReconcile(db, readers, { now: NOW })).rejects.toThrow();
    expect(await rows(sql`SELECT kind, cause_code, detail->>'day' AS day FROM catalog_incidents`)).toEqual([{ kind: "alert", cause_code: "run_failed", day: "2026-11-04" }]);
    // A later run that finishes writes every day at once.
    calls = 10;
    await runCostReconcile(db, readers, { now: NOW });
    expect(await rows(sql`SELECT count(DISTINCT day)::int AS n, count(DISTINCT computed_at)::int AS t FROM catalog_cost_days`)).toEqual([{ n: 3, t: 1 }]);
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

// ---------------------------------------------------------------------------------------------------------------------
// R1 exit item 4 (M6 decision C1): idle by the minute, to the batches working around it
// ---------------------------------------------------------------------------------------------------------------------

const MIN = 60_000;
const t = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);
/** Billed points (USD per minute in `seconds`, as billedLines hands them to allocateIdle), one per minute in [from, to). */
const billedMinutes = (from: string, to: string, usdPerMinute: number) => {
  const out = [];
  for (let m = t(from); m < t(to); m += MIN) out.push({ endMs: m + MIN, seconds: usdPerMinute });
  return out;
};
const seg = (batchId: string | null, from: string, to: string, usd: number) => ({ component: "c", batchId, endMs: t(to), busyMs: t(to) - t(from), usd, estimated: false });
/** The work of `events` by the minute, as planDay hands it to allocateIdle (no instance cap). */
const work = (events: ReturnType<typeof seg>[]) => ledgerDay(events, t("00:00"), t("00:00") + 86_400_000, new Map()).minutes.get("c");

describe("R1 exit item 4: idle by the minute (decision C1)", () => {
  it("keeps Cloud Monitoring's minutes on each sample", () => {
    const [s] = samplesFrom([{ resource: { type: "cloud_run_revision", labels: { service_name: "catalog-upscale-gpu", location: "asia-south2" } },
      points: [{ interval: { endTime: "2026-11-03T10:01:00Z" }, value: { doubleValue: 50 } }, { interval: { endTime: "2026-11-03T10:02:00Z" }, value: { doubleValue: 0 } }, { interval: { endTime: "2026-11-03T10:03:00Z" }, value: { doubleValue: 120 } }] }]);
    expect(s).toEqual({ name: "catalog-upscale-gpu", kind: "service", region: "asia-south2", seconds: 170,
      points: [{ endMs: Date.parse("2026-11-03T10:01:00Z"), seconds: 50 }, { endMs: Date.parse("2026-11-03T10:03:00Z"), seconds: 120 }] });
  });

  it("gives an idle tail (up to 15 min) and a start-up (up to 5 min) to the batch whose work they surround; idle far from any work has no batch", () => {
    expect([IDLE_TAIL_MS, IDLE_LEAD_MS]).toEqual([15 * MIN, 5 * MIN]);
    // One instance at USD 1 a minute. A deploy probe kept it up 08:00-08:30 (no ledger rows). Batch A's calls ran
    // 10:00-10:10 (USD 4 recorded); the instance started at 09:58 and stayed up until 10:20. Batch B's calls ran
    // 12:00-12:05 (USD 1); the instance was up from 11:30 (a slow start) to 12:05.
    const billed = [...billedMinutes("08:00", "08:30", 1), ...billedMinutes("09:58", "10:20", 1), ...billedMinutes("11:30", "12:05", 1)];
    const segments = [seg("A", "10:00", "10:10", 4), seg("B", "12:00", "12:05", 1)];
    const idle = (30 + 22 + 35) - 5;
    const out = allocateIdle(idle, billed, work(segments), t("00:00"), t("00:00") + 86_400_000)!;
    // A: its 10 work minutes (1 - 0.4 each), the 2 start-up minutes and the 10-minute tail = 6 + 2 + 10.
    expect(out.get("A")).toBeCloseTo(18, 9);
    // B: its 5 work minutes (1 - 0.2 each) and the 5 minutes before them (11:55-12:00); 11:30-11:55 has no work within 5 min.
    expect(out.get("B")).toBeCloseTo(4 + 5, 9);
    // The probe (30) and B's early start (25) stay idle with no batch.
    expect(idle - out.get("A")! - out.get("B")!).toBeCloseTo(55, 9);
  });

  it("shares a minute by the busy ms in its window, counts work with no batch, and scales the minutes to the day's idle", () => {
    const billed = billedMinutes("10:00", "10:10", 1);
    // A works 10:00-10:04 (4 min), B 10:04-10:05 (1 min), a sweep with no batch 10:05-10:06; each row recorded at 0.
    const segments = [seg("A", "10:00", "10:04", 0), seg("B", "10:04", "10:05", 0), seg(null, "10:05", "10:06", 0)];
    const out = allocateIdle(5, billed, work(segments), t("00:00"), t("00:00") + 86_400_000)!;
    // Every minute's window holds all the work (4 : 1 : 1); 10 minutes of idle scaled to the day line's 5.
    expect(out.get("A")).toBeCloseTo(5 * 4 / 6, 9);
    expect(out.get("B")).toBeCloseTo(5 * 1 / 6, 9);
    expect(out.has("")).toBe(false);
    // No minutes (a sample from a reader without them), or nothing idle: the caller spreads over the day.
    expect(allocateIdle(5, [], work(segments), t("00:00"), t("00:00") + 86_400_000)).toBeNull();
    expect(allocateIdle(0, billed, work(segments), t("00:00"), t("00:00") + 86_400_000)).toBeNull();
  });

  it("the 216e5b7d shape: a morning deploy probe on the GPU upscaler is not charged to the afternoon batches; the outcome keeps the recorded and true cost", async () => {
    const rate = instancePrice(upscaleGpu)!.usdPerSecond;
    const a = await batch("A", { productsWithLinks: 141 }), b = await batch("B", { productsWithLinks: 5 });
    // A: 300 calls of 3 s from 15:34 to 15:50 (one instance, USD at the full instance rate). B: 30 calls 15:40-15:44.
    for (let i = 0; i < 300; i++) await ledger({ batchId: a, component: "catalog-upscale-gpu", ms: 3000, usd: 3 * rate, at: new Date(t("15:34") + i * 3200) });
    for (let i = 0; i < 30; i++) await ledger({ batchId: b, component: "catalog-upscale-gpu", ms: 2000, usd: 2 * rate, at: new Date(t("15:40") + i * 8000) });
    // Billed: the probe 13:00-14:57 at one instance, then the batches 15:31-16:01 at two instances (the 10-minute tail).
    const minutes = [...billedMinutes("13:00", "14:57", 60), ...billedMinutes("15:31", "16:01", 120)];
    const sampled: BillableSample = { ...sample("catalog-upscale-gpu", minutes.reduce((s, p) => s + p.seconds, 0)), points: minutes };
    const result = await reconcileDay(db, DAY, { samples: [sampled], resources: [upscaleGpu], provisional: true, now: NOW });
    const line = result.lines.find((l) => l.component === "catalog-upscale-gpu")!;
    const probeUsd = 117 * 60 * rate, batchWindowUsd = 30 * 120 * rate;
    expect(line.billedUsd).toBeCloseTo(probeUsd + batchWindowUsd, 6);
    const alloc = await rows(sql`SELECT batch_id, attributed_usd::float8 AS attributed, idle_usd::float8 AS idle FROM catalog_cost_allocations WHERE day = ${DAY} AND component = 'catalog-upscale-gpu'`);
    const of = (id: string) => alloc.find((r) => r.batch_id === id)!;
    const both = (of(a).attributed as number) + (of(a).idle as number) + (of(b).attributed as number) + (of(b).idle as number);
    // The two batches carry the afternoon window's instance time, never the probe: the day rule gave them both.
    expect(both).toBeCloseTo(batchWindowUsd, 4); // the table keeps 6 decimals per row
    expect(of(a).idle as number).toBeGreaterThan(10 * (of(b).idle as number));
    // The outcome: true cost = attributed + idle + shared.
    const [o] = await rows(sql`SELECT true_cost_usd::float8 AS t FROM catalog_batch_outcomes WHERE batch_id = ${a}`);
    const shared = await rows(sql`SELECT shared_usd::float8 AS s FROM catalog_cost_allocations WHERE day = ${DAY} AND batch_id = ${a} AND component = 'ila-pg'`);
    expect(o!.t as number).toBeCloseTo((of(a).attributed as number) + (of(a).idle as number) + (shared[0]!.s as number), 5);
  });
});
