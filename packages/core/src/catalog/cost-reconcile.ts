// M6-S2: the daily cost reconciliation (docs/program/requirements/M6-reliability-cost.md M6-F1-R4 to R6, R10; build
// decisions in section 12). Run by the Cloud Run job catalog-cost-reconcile (apps/worker/src/catalog-cost-reconcile.ts,
// infra/catalog-cost-reconcile.sh) every day at 06:00 UTC for the last RECONCILE_DAYS complete UTC days.
//
// Per day and component:
//   billed      Cloud Monitoring run.googleapis.com/container/billable_instance_time of the Cloud Run service or job
//               times the list price of its current shape (source `monitoring`, always `estimated`): the cost report's
//               method (.runs/2026-11-02-cost-and-quota.md). M6-S3 switches the source to the billing export.
//   attributed  the cost ledger's rows of that component and day (catalog_cost_events), by the part of each row that
//               ran in the day and capped at one instance where rows overlap (dayLedger).
//   idle        billed minus attributed, never negative; a ledger above the bill by more than 1% is an alert (R10).
// Shared lines (R6): the shared Cloud SQL instance ila-pg at an admin-set cost per day and catalog share (settings
// cost.database_usd_per_day, cost.database_catalog_share_percent). Vendors off the GCP bill (OpenRouter, an overflow
// vendor) are billed as the ledger recorded them until vendor invoices arrive (M6-S3).
// Allocations (R5): each component's idle, minute by minute, to the batches whose work ran from 15 minutes before to 5
// minutes after that minute (allocateIdle, M6 decision C1; by busy seconds over the day when a sample has no minutes),
// the shared lines by their attributed cost; idle no batch explains is "idle, no batch". The batch outcome's
// true_cost_usd is the sum.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatchOutcomes, catalogCostAllocations, catalogCostDays, type CostEnv, type CostLineKind } from "../db/schema";
import { OPENROUTER_COMPONENT } from "../cost-events";
import { log } from "../log";
import { COST_DATABASE_SHARE_KEY, COST_DATABASE_USD_PER_DAY_KEY } from "../settings/registry";
import { currentValue } from "../settings/store";
import { OVERFLOW_ADAPTERS } from "../vendor/routes";
import { openIncident, SUCCESS_TARGET, successRate } from "./reliability";
import { pushAll } from "../arrays";

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
/** Complete UTC days each run re-computes: D-1 and D-2 provisional, D-3 final (M6-F1-R8 shape). */
export const RECONCILE_DAYS = 3;
/** A backfill run may go back this far (Cloud Monitoring keeps Cloud Run metrics for six weeks). */
export const MAX_RECONCILE_DAYS = 42;
/** R10: the ledger may exceed the bill by this share (and by OVER_MIN_USD) before it is an alert. */
export const OVER_TOLERANCE = 0.01;
export const OVER_MIN_USD = 0.01;
/** The regions the catalog runs Cloud Run in (AGENTS.md; the GPU matting and GPU upscale regions). */
export const COST_REGIONS = ["asia-south1", "asia-southeast1", "asia-south2"] as const;
export const BILLABLE_METRIC = "run.googleapis.com/container/billable_instance_time";
/** The shared Cloud SQL line's component name. */
export const DATABASE_COMPONENT = "ila-pg";

// ---------------------------------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Cloud Run list prices in USD per second, by region and billing mode (CPU per vCPU-second, memory per GiB-second) and
 * by GPU (per GPU-second, no zonal redundancy). Sources: cloud.google.com/run/pricing and the Billing price catalog as
 * documented in catalog/cost.ts and job-cost.ts; every rate here was checked against the billing export's effective
 * rate for 2026-11-03 (cost / usage amount, 95.23 INR per USD) and matched to 3 significant figures: asia-south1
 * request-based CPU 0.000024 and memory 0.0000025, asia-south1 jobs (instance-based) CPU 0.000018 and memory 0.000002,
 * asia-southeast1 and asia-south2 instance-based CPU 0.0000216 and memory 0.0000024, NVIDIA L4 0.00022404, RTX PRO 6000
 * 0.00043826. A shape this card does not price is billed 0 with an `unpriced` alert, never guessed.
 */
export const CPU_MEMORY_RATES: Readonly<Record<string, { cpu: number; memoryGiB: number }>> = {
  "asia-south1|request": { cpu: 0.000024, memoryGiB: 0.0000025 },
  "asia-south1|instance": { cpu: 0.000018, memoryGiB: 0.000002 },
  "asia-southeast1|instance": { cpu: 0.0000216, memoryGiB: 0.0000024 },
  "asia-south2|instance": { cpu: 0.0000216, memoryGiB: 0.0000024 },
};
export const GPU_RATES: Readonly<Record<string, number>> = {
  "asia-southeast1|nvidia-l4|non-zonal": 0.00022404,
  "asia-south2|nvidia-rtx-pro-6000|non-zonal": 0.00043826,
};

/** A Cloud Run service or job as the Admin API v2 lists it, reduced to what pricing needs. */
export interface RunResource {
  name: string;
  kind: "service" | "job";
  region: string;
  labels: Record<string, string>;
  cpu: number;
  memoryGiB: number;
  gpu: { type: string; count: number; zonalRedundancy: boolean } | null;
  /** Request-based billing (CPU only while a request runs): a service with cpuIdle. Jobs and GPU services never are. */
  requestBased: boolean;
}

export interface Price { usdPerSecond: number; rates: Record<string, number | string> }

/** USD per billable instance-second of `r` at its shape, or null when the rate card has no price for it. */
export function instancePrice(r: RunResource): Price | null {
  const mode = r.requestBased ? "request" : "instance";
  const base = CPU_MEMORY_RATES[`${r.region}|${mode}`];
  if (!base || !(r.cpu > 0) || !(r.memoryGiB > 0)) return null;
  let gpu = 0;
  if (r.gpu && r.gpu.count > 0) {
    const rate = GPU_RATES[`${r.region}|${r.gpu.type}|${r.gpu.zonalRedundancy ? "zonal" : "non-zonal"}`];
    if (rate === undefined) return null;
    gpu = rate * r.gpu.count;
  }
  const usdPerSecond = r.cpu * base.cpu + r.memoryGiB * base.memoryGiB + gpu;
  return {
    usdPerSecond,
    rates: { mode, cpu: r.cpu, memoryGiB: r.memoryGiB, cpuUsdPerSecond: base.cpu, memoryUsdPerGiBSecond: base.memoryGiB, ...(r.gpu ? { gpu: r.gpu.type, gpuUsdPerSecond: gpu } : {}) },
  };
}

/** Kubernetes-style quantities as Cloud Run returns them: cpu "4", "1000m"; memory "4Gi", "512Mi", "2G". */
export function cpuQuantity(value: unknown): number {
  const s = String(value ?? "").trim();
  const n = s.endsWith("m") ? Number(s.slice(0, -1)) / 1000 : Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
export function memoryGiB(value: unknown): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(value ?? "").trim());
  if (!m) return 0;
  const unit = { Ki: 1024, Mi: 1024 ** 2, Gi: GIB, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2] ?? ""] ?? 1;
  return (Number(m[1]) * unit) / GIB;
}

interface V2Container { resources?: { limits?: Record<string, string>; cpuIdle?: boolean } }
interface V2Template { containers?: V2Container[]; nodeSelector?: { accelerator?: string }; gpuZonalRedundancyDisabled?: boolean }
/** One item of `services` or `jobs` from run.googleapis.com/v2/projects/<p>/locations/<region>/<kind>. */
export interface V2Item { name: string; labels?: Record<string, string>; template?: V2Template & { template?: V2Template } }

export function runResourceFrom(kind: "service" | "job", region: string, item: V2Item): RunResource {
  const template = (kind === "job" ? item.template?.template : item.template) ?? {};
  const limits = template.containers?.[0]?.resources?.limits ?? {};
  const gpuCount = Number(limits["nvidia.com/gpu"] ?? 0);
  const gpu = gpuCount > 0 ? { type: template.nodeSelector?.accelerator ?? "unknown", count: gpuCount, zonalRedundancy: template.gpuZonalRedundancyDisabled !== true } : null;
  return {
    name: item.name.split("/").pop() ?? item.name, kind, region, labels: item.labels ?? {},
    cpu: cpuQuantity(limits.cpu), memoryGiB: memoryGiB(limits.memory), gpu,
    requestBased: kind === "service" && !gpu && template.containers?.[0]?.resources?.cpuIdle === true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers (Cloud Run Admin API and Cloud Monitoring, read only)
// ---------------------------------------------------------------------------------------------------------------------

/** One minute of billable instance time: the minute ending at `endMs`. */
export interface BillablePoint { endMs: number; seconds: number }
/**
 * Billable instance seconds of one service or job over a day, and (from Cloud Monitoring) the same time per minute, so
 * idle time can be given to the batches that ran around it (allocateIdle, M6 decision C1).
 */
export interface BillableSample { name: string; kind: "service" | "job"; region: string; seconds: number; points?: readonly BillablePoint[] }

export interface CostReaders {
  resources(): Promise<RunResource[]>;
  billableSeconds(from: Date, to: Date): Promise<BillableSample[]>;
}

/** A GET of a Google API URL that returns its JSON body (google-auth-library's client.request in the job). */
export type GoogleGet = (url: string) => Promise<unknown>;

export function googleCostReaders(get: GoogleGet, project: string): CostReaders {
  return {
    async resources() {
      const out: RunResource[] = [];
      for (const region of COST_REGIONS) {
        for (const kind of ["service", "job"] as const) {
          let pageToken = "";
          do {
            const q = new URLSearchParams({ pageSize: "100" });
            if (pageToken) q.set("pageToken", pageToken);
            const body = (await get(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/${kind}s?${q}`)) as Record<string, unknown> & { nextPageToken?: string };
            for (const item of (body[`${kind}s`] as V2Item[] | undefined) ?? []) out.push(runResourceFrom(kind, region, item));
            pageToken = body.nextPageToken ?? "";
          } while (pageToken);
        }
      }
      return out;
    },
    async billableSeconds(from, to) {
      const out: BillableSample[] = [];
      let pageToken = "";
      do {
        const q = new URLSearchParams({
          filter: `metric.type="${BILLABLE_METRIC}"`,
          "interval.startTime": from.toISOString(), "interval.endTime": to.toISOString(),
          "aggregation.alignmentPeriod": `${IDLE_BUCKET_MS / 1000}s`,
          "aggregation.perSeriesAligner": "ALIGN_SUM", "aggregation.crossSeriesReducer": "REDUCE_SUM",
        });
        for (const g of ["resource.type", "resource.label.service_name", "resource.label.job_name", "resource.label.location"]) q.append("aggregation.groupByFields", g);
        if (pageToken) q.set("pageToken", pageToken);
        const body = (await get(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`)) as { timeSeries?: MonitoringSeries[]; nextPageToken?: string };
        pushAll(out, samplesFrom(body.timeSeries ?? []));
        pageToken = body.nextPageToken ?? "";
      } while (pageToken);
      return out;
    },
  };
}

export interface MonitoringSeries {
  resource: { type: string; labels: Record<string, string> };
  points?: { interval?: { endTime?: string }; value: { doubleValue?: number; int64Value?: string } }[];
}

/** One sample per Cloud Run revision group or job: the points of the window summed, and kept per minute. */
export function samplesFrom(series: readonly MonitoringSeries[]): BillableSample[] {
  const out: BillableSample[] = [];
  for (const s of series) {
    const kind = s.resource.type === "cloud_run_job" ? "job" : s.resource.type === "cloud_run_revision" ? "service" : null;
    const name = kind === "job" ? s.resource.labels.job_name : s.resource.labels.service_name;
    if (!kind || !name) continue;
    const value = (p: NonNullable<MonitoringSeries["points"]>[number]) => Number(p.value.doubleValue ?? p.value.int64Value ?? 0);
    const seconds = (s.points ?? []).reduce((sum, p) => sum + value(p), 0);
    const points = (s.points ?? []).flatMap((p) => (p.interval?.endTime && value(p) > 0 ? [{ endMs: Date.parse(p.interval.endTime), seconds: value(p) }] : []));
    out.push({ name, kind, region: s.resource.labels.location ?? "", seconds, ...(points.length ? { points } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The day's lines
// ---------------------------------------------------------------------------------------------------------------------

export type CostAlertCode = "ledger_over" | "unlabelled" | "unpriced" | "success_under_target" | "run_failed";
export interface CostAlert { code: CostAlertCode; day: string; component: string | null; text: string; detail?: Record<string, unknown> }

export interface CostLine {
  component: string; kind: CostLineKind; region: string | null; env: CostEnv;
  billableSeconds: number | null; billedUsd: number; attributedUsd: number; idleUsd: number; sharedUsd: number;
  estimated: boolean; detail: Record<string, unknown>;
}

const ENVS: readonly CostEnv[] = ["live", "preview", "test"];
const isCatalog = (r: Pick<RunResource, "name" | "labels">) => r.labels.app === "catalog" || r.name.startsWith("catalog-");
const labelled = (r: RunResource) => r.labels.app === "catalog" && !!r.labels.component && ENVS.includes(r.labels.env as CostEnv);

/**
 * The billed lines of a day from Cloud Monitoring samples and the current Cloud Run shapes: one line per catalog service
 * or job (by its `component` label, else its name), other apps in the project left out. An unlabelled catalog
 * resource is reported as env `unlabelled`; a sample whose shape has no price (or whose resource is gone) is billed 0.
 */
export function billedLines(day: string, samples: readonly BillableSample[], resources: readonly RunResource[]): { lines: CostLine[]; alerts: CostAlert[]; minutes: Map<string, BillablePoint[]> } {
  const byKey = new Map(resources.map((r) => [`${r.kind}|${r.region}|${r.name}`, r]));
  const lines = new Map<string, CostLine>();
  /** Per component, billed USD per minute (each point's `seconds` holds USD here). */
  const minutes = new Map<string, BillablePoint[]>();
  const alerts: CostAlert[] = [];
  for (const s of samples) {
    const r = byKey.get(`${s.kind}|${s.region}|${s.name}`);
    if (!(r ? isCatalog(r) : s.name.startsWith("catalog-"))) continue;
    const ok = r ? labelled(r) : false;
    const component = ok ? r!.labels.component! : s.name;
    const env: CostEnv = ok ? (r!.labels.env as CostEnv) : "unlabelled";
    const price = r ? instancePrice(r) : null;
    if (r && !ok) alerts.push({ code: "unlabelled", day, component, text: `The Cloud Run ${s.kind} ${s.name} has no app, component and env labels, so its cost is shown as unlabelled.` });
    if (!price) alerts.push({ code: "unpriced", day, component, text: r ? `No list price for the shape of ${s.name} (${s.region}); its ${Math.round(s.seconds)} s are billed 0 until the bill is read.` : `${s.name} (${s.region}) ran ${Math.round(s.seconds)} s but no longer exists, so its shape and price are unknown.`, detail: { seconds: s.seconds } });
    const key = component;
    const line = lines.get(key) ?? { component, kind: s.kind, region: s.region, env, billableSeconds: 0, billedUsd: 0, attributedUsd: 0, idleUsd: 0, sharedUsd: 0, estimated: true, detail: {} };
    line.billableSeconds = (line.billableSeconds ?? 0) + s.seconds;
    line.billedUsd += price ? s.seconds * price.usdPerSecond : 0;
    line.detail = { ...line.detail, [s.name]: { seconds: s.seconds, ...(price ? { usdPerSecond: price.usdPerSecond, ...price.rates } : { unpriced: true }) } };
    lines.set(key, line);
    if (price && s.points) pushAll(minutes.get(key) ?? minutes.set(key, []).get(key)!, s.points.map((p) => ({ endMs: p.endMs, seconds: p.seconds * price.usdPerSecond })));
  }
  return { lines: [...lines.values()], alerts, minutes };
}

/** Vendor components off the GCP bill (M6-F1-R7): OpenRouter and the overflow adapters. */
export const VENDOR_COMPONENTS: readonly string[] = [OPENROUTER_COMPONENT, ...OVERFLOW_ADAPTERS];

/**
 * The ledger's component of a row: its `component` (M6-S1), else for rows written before M6-S1 the component the
 * same rules give (costComponent in cost-events.ts) with the live services of that time.
 */
const ledgerComponent = sql<string>`coalesce(component, CASE
  WHEN kind = 'llm_call' THEN ${OPENROUTER_COMPONENT}
  WHEN kind = 'matte_call' AND engine = 'gpu' THEN 'catalog-matting-gpu'
  WHEN kind = 'matte_call' AND engine = 'cpu' THEN 'catalog-matting'
  WHEN kind = 'upscale_call' AND engine = 'gpu' THEN 'catalog-upscale-gpu'
  WHEN kind = 'upscale_call' AND engine = 'cpu' THEN 'catalog-upscale'
  ELSE 'catalog-worker' END)`;

/** One ledger row as the reconciliation reads it: it ended at `endMs` (the row's `at`) after `busyMs` of work. */
export interface LedgerEvent { component: string; batchId: string | null; endMs: number; busyMs: number; usd: number; estimated: boolean }
/** The day's ledger per component and batch: busy ms inside the day, and USD after the instance cap. */
export interface LedgerRow { component: string; batchId: string | null; busyMs: number; usd: number; estimated: boolean }

/** Ledger rows that can touch [from, to): ending in it, or ending up to a day later (work that crossed midnight UTC). */
async function ledgerEvents(db: Db, from: Date, to: Date): Promise<LedgerEvent[]> {
  const rows = (await db.execute(sql`SELECT ${ledgerComponent} AS component, batch_id, (extract(epoch FROM at) * 1000)::float8 AS end_ms,
      coalesce(billable_ms, ms)::bigint AS busy_ms, usd::float8 AS usd, estimated
    FROM catalog_cost_events WHERE at >= ${from.toISOString()}::timestamptz AND at < ${new Date(+to + DAY_MS).toISOString()}::timestamptz`)) as unknown as { rows: Record<string, unknown>[] };
  return rows.rows.map((r) => ({ component: String(r.component), batchId: (r.batch_id as string | null) ?? null, endMs: Number(r.end_ms), busyMs: Number(r.busy_ms ?? 0), usd: Number(r.usd ?? 0), estimated: r.estimated === true }));
}

/** The list price per ms of one instance of each catalog component (by its `component` label, else its name). */
export function instanceUsdPerMs(resources: readonly RunResource[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of resources) {
    if (!isCatalog(r)) continue;
    const price = instancePrice(r);
    if (!price) continue;
    const component = labelled(r) ? r.labels.component! : r.name;
    out.set(component, Math.max(out.get(component) ?? 0, price.usdPerSecond / 1000));
  }
  return out;
}

/**
 * The day [fromMs, toMs) of the ledger, per component and batch (review fixes of PR #173):
 * - Midnight: a row covers [endMs - busyMs, endMs] and counts only the part inside the day, at its own rate (usd / busy
 *   ms). Monitoring splits instance time by the minute, so work that crosses midnight UTC is split the same way.
 * - Instance cap: rows of one component that run at the same time (the GPU upscaler serves 4 calls at once, each priced
 *   at the full instance rate) cannot together cost more than one instance at that moment. In each stretch of time
 *   where their summed rate is above the component's instance price, each row is scaled down in proportion. Rows priced
 *   at a part of an instance (the worker's per-chunk rows) keep their cost while they fit in one instance. With more
 *   than one instance running this under-counts, which shows as idle, never as a false ledger_over alert.
 * Vendor rows and rows without busy time count whole on the day they ended.
 */
export function dayLedger(events: readonly LedgerEvent[], fromMs: number, toMs: number, instancePerMs: ReadonlyMap<string, number>): LedgerRow[] {
  return ledgerDay(events, fromMs, toMs, instancePerMs).rows;
}

/** A stretch of one ledger row's work inside the day, at its cost after the instance cap. */
export interface LedgerSegment { component: string; batchId: string | null; start: number; end: number; usd: number }

/** dayLedger's rows, plus every timed stretch of work (for the per-minute idle allocation). */
export function ledgerDay(events: readonly LedgerEvent[], fromMs: number, toMs: number, instancePerMs: ReadonlyMap<string, number>): { rows: LedgerRow[]; segments: LedgerSegment[] } {
  const out = new Map<string, LedgerRow>();
  const segments: LedgerSegment[] = [];
  const add = (e: LedgerEvent, busyMs: number, usd: number) => {
    const key = `${e.component}|${e.batchId ?? ""}`;
    const row = out.get(key) ?? { component: e.component, batchId: e.batchId, busyMs: 0, usd: 0, estimated: false };
    row.busyMs += busyMs; row.usd += usd; row.estimated ||= e.estimated;
    out.set(key, row);
  };
  interface Span { start: number; end: number; rate: number; usd: number; e: LedgerEvent }
  const timed = new Map<string, Span[]>();
  for (const e of events) {
    if (VENDOR_COMPONENTS.includes(e.component) || !(e.busyMs > 0)) {
      if (e.endMs >= fromMs && e.endMs < toMs) add(e, Math.max(0, e.busyMs), e.usd);
      continue;
    }
    const start = Math.max(fromMs, e.endMs - e.busyMs), end = Math.min(toMs, e.endMs);
    if (end <= start) continue;
    const spans = timed.get(e.component) ?? [];
    spans.push({ start, end, rate: e.usd / e.busyMs, usd: 0, e });
    timed.set(e.component, spans);
  }
  for (const [component, spans] of timed) {
    const cap = instancePerMs.get(component);
    const points = spans.flatMap((s, i) => [{ t: s.start, i, on: true }, { t: s.end, i, on: false }]).sort((a, b) => a.t - b.t);
    const active = new Set<number>();
    let prev = points[0]?.t ?? 0;
    for (const p of points) {
      if (p.t > prev && active.size) {
        const length = p.t - prev;
        let sum = 0;
        for (const i of active) sum += spans[i]!.rate;
        const scale = cap !== undefined && sum > cap ? cap / sum : 1;
        for (const i of active) {
          const usd = spans[i]!.rate * length * scale;
          spans[i]!.usd += usd;
          segments.push({ component, batchId: spans[i]!.e.batchId, start: prev, end: p.t, usd });
        }
      }
      prev = p.t;
      if (p.on) active.add(p.i); else active.delete(p.i);
    }
    for (const s of spans) add(s.e, s.end - s.start, s.usd);
  }
  return { rows: [...out.values()], segments };
}

// ---------------------------------------------------------------------------------------------------------------------
// Idle by the minute (M6 decision C1, R1 exit item 4)
// ---------------------------------------------------------------------------------------------------------------------

/** Monitoring is read per minute; idle is placed on these minutes. */
export const IDLE_BUCKET_MS = 60_000;
/**
 * Idle in a minute belongs to the work around it. Cloud Run keeps an instance idle up to 15 minutes after its last
 * request (10 for GPU services) and bills an instance-based service for all of it, and an instance starts before its
 * first request is served (a GPU model loads for a minute or more). So a minute's idle goes to the work that ran from
 * IDLE_TAIL_MS before the minute to IDLE_LEAD_MS after it.
 */
export const IDLE_TAIL_MS = 15 * 60_000;
export const IDLE_LEAD_MS = 5 * 60_000;

/**
 * Splits one component's idle over the batches whose work explains it (M6 decision C1). Per minute: idle = billed minus
 * recorded work (never negative), shared by the busy ms of each batch (and of work with no batch) in [minute start -
 * IDLE_TAIL_MS, minute end + IDLE_LEAD_MS]; a minute with no work in that window is idle with no batch. The minutes are
 * then scaled so they add up to the day line's idle, so the day still closes. Returns USD per batch id, or null when
 * there are no minutes to place idle by (the caller then spreads it over the day by busy seconds).
 */
export function allocateIdle(idleUsd: number, billed: readonly BillablePoint[], segments: readonly LedgerSegment[], fromMs: number, toMs: number): Map<string, number> | null {
  const n = Math.ceil((toMs - fromMs) / IDLE_BUCKET_MS);
  if (!(idleUsd > 0) || !billed.length || n <= 0) return null;
  const at = (t: number) => Math.min(n - 1, Math.max(0, Math.floor((t - fromMs) / IDLE_BUCKET_MS)));
  const billedUsd = new Float64Array(n), workUsd = new Float64Array(n);
  for (const p of billed) billedUsd[at(p.endMs - 1)]! += p.seconds;
  // Busy ms per minute per batch ("" = work with no batch), then prefix sums for the windows.
  const busy = new Map<string, Float64Array>();
  for (const s of segments) {
    if (!(s.end > s.start)) continue;
    const key = s.batchId ?? "";
    const row = busy.get(key) ?? busy.set(key, new Float64Array(n)).get(key)!;
    const rate = s.usd / (s.end - s.start);
    for (let i = at(s.start); i <= at(s.end - 1); i++) {
      const lo = Math.max(s.start, fromMs + i * IDLE_BUCKET_MS), hi = Math.min(s.end, fromMs + (i + 1) * IDLE_BUCKET_MS);
      if (hi <= lo) continue;
      row[i]! += hi - lo;
      workUsd[i]! += rate * (hi - lo);
    }
  }
  const prefix: [string, Float64Array][] = [];
  for (const [key, row] of busy) {
    const p = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) p[i + 1] = p[i]! + row[i]!;
    prefix.push([key, p]);
  }
  const tail = Math.ceil(IDLE_TAIL_MS / IDLE_BUCKET_MS), lead = Math.ceil(IDLE_LEAD_MS / IDLE_BUCKET_MS);
  const out = new Map<string, number>();
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const idle = billedUsd[i]! - workUsd[i]!;
    if (!(idle > 0)) continue;
    placed += idle;
    const lo = Math.max(0, i - tail), hi = Math.min(n, i + lead + 1);
    let total = 0;
    const weights: [string, number][] = [];
    for (const [key, p] of prefix) {
      const w = p[hi]! - p[lo]!;
      if (w > 0) { weights.push([key, w]); total += w; }
    }
    if (!(total > 0)) continue; // idle with no batch
    for (const [key, w] of weights) if (key) out.set(key, (out.get(key) ?? 0) + (idle * w) / total);
  }
  if (!(placed > 0)) return null;
  const scale = idleUsd / placed;
  for (const [key, usd] of out) out.set(key, usd * scale);
  return out;
}

export interface DayResult { day: string; lines: CostLine[]; allocations: number; alerts: CostAlert[]; batches: string[] }

/** Splits `amount` over `weights` in proportion (equal shares when every weight is 0). */
function spread(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (total > 0 ? (amount * w) / total : amount / weights.length));
}

interface Allocation { component: string; batchId: string; busyMs: number; attributedUsd: number; idleUsd: number; sharedUsd: number }
interface DayPlan { result: DayResult; provisional: boolean; allocations: Allocation[] }

/** Computes one UTC day (`YYYY-MM-DD`) without writing it. */
async function planDay(db: Db, day: string, input: { samples: readonly BillableSample[]; resources: readonly RunResource[]; provisional: boolean }): Promise<DayPlan> {
  const from = new Date(`${day}T00:00:00Z`), to = new Date(+from + DAY_MS);
  const { lines: billed, alerts, minutes } = billedLines(day, input.samples, input.resources);
  const { rows: ledger, segments } = ledgerDay(await ledgerEvents(db, from, to), +from, +to, instanceUsdPerMs(input.resources));
  const lines = new Map(billed.map((l) => [l.component, l]));
  // Attributed per component (summed over its env lines: a component name is one env in practice).
  const attributed = new Map<string, { usd: number; estimated: boolean }>();
  for (const r of ledger) {
    const a = attributed.get(r.component) ?? { usd: 0, estimated: false };
    attributed.set(r.component, { usd: a.usd + r.usd, estimated: a.estimated || r.estimated });
  }
  for (const [component, a] of attributed) {
    const line = lines.get(component);
    if (line) { line.attributedUsd = a.usd; continue; }
    const vendor = VENDOR_COMPONENTS.includes(component);
    // A vendor is billed as recorded; a GCP component with ledger rows and no billed instance time is an over-count.
    lines.set(component, { component, kind: vendor ? "vendor" : "service", region: null, env: "live", billableSeconds: vendor ? null : 0, billedUsd: vendor ? a.usd : 0, attributedUsd: a.usd, idleUsd: 0, sharedUsd: 0, estimated: vendor ? a.estimated : true, detail: vendor ? { vendorReported: true } : {} });
  }
  for (const line of lines.values()) {
    line.idleUsd = Math.max(0, line.billedUsd - line.attributedUsd);
    const over = line.attributedUsd - line.billedUsd;
    if (over > OVER_MIN_USD && over > OVER_TOLERANCE * line.billedUsd) {
      alerts.push({ code: "ledger_over", day, component: line.component, text: `The ledger holds USD ${line.attributedUsd.toFixed(4)} for ${line.component} against USD ${line.billedUsd.toFixed(4)} billed: it counts more than was billed.`, detail: { billedUsd: line.billedUsd, attributedUsd: line.attributedUsd } });
    }
  }
  // The shared database line (R6).
  const dbUsd = Number(await currentValue<number>(db, COST_DATABASE_USD_PER_DAY_KEY));
  const share = Number(await currentValue<number>(db, COST_DATABASE_SHARE_KEY)) / 100;
  const shared: CostLine = { component: DATABASE_COMPONENT, kind: "shared", region: "asia-south1", env: "live", billableSeconds: null, billedUsd: dbUsd, attributedUsd: 0, idleUsd: 0, sharedUsd: dbUsd * share, estimated: true, detail: { usdPerDay: dbUsd, sharePercent: share * 100, rule: "admin setting" } };
  const all = [...lines.values(), shared];

  // Allocations (R5): idle by the minute to the batches working around it (decision C1), or by busy seconds over the
  // day when there is no per-minute time; shared by attributed cost over all the day's batches.
  const perBatch = new Map<string, Allocation>();
  const batchRows = ledger.filter((r) => r.batchId !== null);
  for (const r of batchRows) perBatch.set(`${r.batchId}|${r.component}`, { component: r.component, batchId: r.batchId!, busyMs: r.busyMs, attributedUsd: r.usd, idleUsd: 0, sharedUsd: 0 });
  for (const line of lines.values()) {
    if (line.idleUsd <= 0) continue;
    const rows = [...perBatch.values()].filter((a) => a.component === line.component);
    if (!rows.length) continue; // idle, no batch
    const byMinute = allocateIdle(line.idleUsd, minutes.get(line.component) ?? [], segments.filter((s) => s.component === line.component), +from, +to);
    if (byMinute) {
      for (const a of rows) a.idleUsd = byMinute.get(a.batchId) ?? 0;
      continue;
    }
    const busy = rows.map((a) => a.busyMs);
    spread(line.idleUsd, busy.some((b) => b > 0) ? busy : rows.map((a) => a.attributedUsd)).forEach((usd, i) => { rows[i]!.idleUsd = usd; });
  }
  const batchIds = [...new Set(batchRows.map((r) => r.batchId!))];
  if (batchIds.length && shared.sharedUsd > 0) {
    const weights = batchIds.map((id) => batchRows.filter((r) => r.batchId === id).reduce((s, r) => s + r.usd, 0));
    spread(shared.sharedUsd, weights).forEach((usd, i) => perBatch.set(`${batchIds[i]}|${DATABASE_COMPONENT}`, { component: DATABASE_COMPONENT, batchId: batchIds[i]!, busyMs: 0, attributedUsd: 0, idleUsd: 0, sharedUsd: usd }));
  }

  return { result: { day, lines: all, allocations: perBatch.size, alerts, batches: batchIds }, provisional: input.provisional, allocations: [...perBatch.values()] };
}

/**
 * Replaces the planned days' monitoring rows and allocations, then rewrites the true cost of every batch that has (or
 * had, before this write) allocations on those days. Runs inside the caller's transaction.
 */
async function writeDays(tx: Db, plans: readonly DayPlan[], now: Date): Promise<void> {
  const days = plans.map((p) => p.result.day);
  if (!days.length) return;
  const before = await tx.selectDistinct({ batchId: catalogCostAllocations.batchId }).from(catalogCostAllocations).where(inArray(catalogCostAllocations.day, days));
  await tx.delete(catalogCostDays).where(and(inArray(catalogCostDays.day, days), eq(catalogCostDays.source, "monitoring")));
  await tx.delete(catalogCostAllocations).where(inArray(catalogCostAllocations.day, days));
  for (const { result: { day, lines }, provisional, allocations } of plans) {
    if (lines.length) {
      await tx.insert(catalogCostDays).values(lines.map((l) => ({
        day, component: l.component, kind: l.kind, region: l.region, env: l.env, source: "monitoring" as const, billableSeconds: l.billableSeconds,
        billedUsd: l.billedUsd, creditsUsd: 0, attributedUsd: l.attributedUsd, idleUsd: l.idleUsd, sharedUsd: l.sharedUsd,
        estimated: l.estimated, provisional, detail: l.detail, computedAt: now,
      })));
    }
    if (allocations.length) await tx.insert(catalogCostAllocations).values(allocations.map((a) => ({ day, source: "monitoring" as const, ...a, computedAt: now })));
  }
  const batchIds = [...new Set([...before.map((r) => r.batchId), ...plans.flatMap((p) => p.result.batches)])];
  if (batchIds.length) {
    // M6-F1-R9: the batch's true cost so far, every reconciled day summed (attributed + idle + shared).
    await tx.update(catalogBatchOutcomes).set({
      trueCostUsd: sql`(SELECT coalesce(sum(a.attributed_usd + a.idle_usd + a.shared_usd), 0) FROM catalog_cost_allocations AS a WHERE a.batch_id = ${catalogBatchOutcomes.batchId})`,
      // The ledger total again: rows that landed after the outcome was written (the finalize's own compute row).
      recordedCostUsd: sql`(SELECT coalesce(sum(e.usd), 0) FROM catalog_cost_events AS e WHERE e.batch_id = ${catalogBatchOutcomes.batchId})`,
    }).where(inArray(catalogBatchOutcomes.batchId, batchIds));
  }
}

/** Computes one UTC day and replaces its monitoring rows and allocations in one transaction. */
export async function reconcileDay(db: Db, day: string, input: { samples: readonly BillableSample[]; resources: readonly RunResource[]; provisional: boolean; now: Date }): Promise<DayResult> {
  const plan = await planDay(db, day, input);
  await db.transaction(async (tx) => writeDays(tx as unknown as Db, [plan], input.now));
  return plan.result;
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

/** `YYYY-MM-DD` of the UTC day `n` days before `now`'s day. */
export function utcDay(now: Date, n: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - n * DAY_MS);
  return d.toISOString().slice(0, 10);
}

export interface RunResult { days: DayResult[]; alerts: CostAlert[]; newAlerts: CostAlert[] }

/** Writes an alert once as an `alert` incident (keyed by code, day and component); true when this call wrote it. */
async function writeAlert(db: Db, a: CostAlert, now: Date): Promise<boolean> {
  const id = await openIncident(db, {
    kind: "alert", severity: "warning", batchId: null, causeCode: a.code, cause: a.text, startedAt: now, resolvedAt: now,
    dedupeKey: `alert:${a.code}:${a.day}:${a.component ?? "none"}`, detail: { day: a.day, component: a.component, ...a.detail },
  });
  return id !== null;
}

/**
 * Re-computes the last `days` complete UTC days (D-1 first), D-1 and D-2 provisional. Each alert is written once as an
 * `alert` incident (keyed by code, day and component, so a re-run of the same day writes nothing new); `newAlerts`
 * are the ones written by this run, which the job logs. Also the daily success-rate check (M6
 * decision S6-8): the 7-day batch success rate under the target is an alert once a day.
 *
 * All or nothing (review fix of PR #173): every day, allocation and alert is written in one transaction at the end, so
 * the newest computed_at is always a run that finished (the sweep's cost_reconcile_stale check reads it). A run that
 * fails part-way writes no rows, records a `run_failed` alert (once per UTC day; emailed through daily_check_alert)
 * when the database still answers, and throws.
 */
export async function runCostReconcile(db: Db, readers: CostReaders, options: { now?: Date; days?: number } = {}): Promise<RunResult> {
  const now = options.now ?? new Date();
  const count = Math.min(MAX_RECONCILE_DAYS, Math.max(1, Math.floor(options.days ?? RECONCILE_DAYS)));
  try {
    const resources = await readers.resources();
    const plans: DayPlan[] = [];
    for (let n = 1; n <= count; n++) {
      const day = utcDay(now, n);
      const from = new Date(`${day}T00:00:00Z`);
      const samples = await readers.billableSeconds(from, new Date(+from + DAY_MS));
      plans.push(await planDay(db, day, { samples, resources, provisional: n <= 2 }));
    }
    const days = plans.map((p) => p.result);
    const alerts = days.flatMap((d) => d.alerts);
    const rate = await successRate(db, new Date(+now - 7 * DAY_MS), now);
    if (rate.rate !== null && rate.rate < SUCCESS_TARGET) {
      alerts.push({ code: "success_under_target", day: utcDay(now, 0), component: null, text: `${rate.successes} of ${rate.counted} batches in the last 7 days finished with links and no person stepping in, under the ${Math.round(SUCCESS_TARGET * 100)}% target.`, detail: rate });
    }
    const newAlerts: CostAlert[] = [];
    await db.transaction(async (tx) => {
      await writeDays(tx as unknown as Db, plans, now);
      for (const a of alerts) if (await writeAlert(tx as unknown as Db, a, now)) newAlerts.push(a);
    });
    return { days, alerts, newAlerts };
  } catch (error) {
    const failed: CostAlert = { code: "run_failed", day: utcDay(now, 0), component: null, text: `The daily cost check failed and wrote nothing: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
    try { await writeAlert(db, failed, now); } catch { /* the database is the failure: cost_reconcile_stale reports it */ }
    throw error;
  }
}

/**
 * Logs a run's outcome: one INFO line per day and one `daily check failed` ERROR line per new alert. The email goes
 * through the sweep's daily_check_alert invariant (policy 16), because log alerts never read Cloud Run jobs.
 */
export function logRun(result: RunResult): void {
  for (const d of result.days) {
    const sum = (k: "billedUsd" | "attributedUsd" | "idleUsd" | "sharedUsd") => Number(d.lines.filter((l) => l.env === "live").reduce((s, l) => s + l[k], 0).toFixed(6));
    log("INFO", "cost reconciled", { day: d.day, lines: d.lines.length, allocations: d.allocations, batches: d.batches.length, liveBilledUsd: sum("billedUsd"), liveAttributedUsd: sum("attributedUsd"), liveIdleUsd: sum("idleUsd"), sharedUsd: sum("sharedUsd") });
  }
  for (const a of result.newAlerts) log("ERROR", "daily check failed", { check: a.code, day: a.day, component: a.component, cause: a.text });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Ops cost card (read only)
// ---------------------------------------------------------------------------------------------------------------------

/** One UTC day of operator cost: live components, the catalog's shared lines and vendors. */
export interface CostDayLine {
  day: string; billedUsd: number; attributedUsd: number; idleUsd: number; idleNoBatchUsd: number; sharedUsd: number; vendorUsd: number;
  /** billed + shared + vendor: what the day cost the catalog. */
  totalUsd: number;
  provisional: boolean; estimated: boolean;
  /** R10 arithmetic check: ledger plus idle equals billed within 1% on every live line (no over-count). */
  closes: boolean;
  computedAt: Date;
}
export interface CostComponentLine { component: string; kind: CostLineKind; env: CostEnv; billableSeconds: number; billedUsd: number; attributedUsd: number; idleUsd: number; sharedUsd: number }
export interface CostBatchLine {
  batchId: string; name: string; brandName: string; isTest: boolean; productsWithLinks: number | null;
  /** Attributed + idle + shared over every reconciled day; `marginalUsd` attributed only. */
  trueUsd: number; marginalUsd: number; truePerProductUsd: number | null; marginalPerProductUsd: number | null;
}
export interface CostBrandLine { brandName: string; batches: number; productsWithLinks: number; trueUsd: number; truePerProductUsd: number | null }
export interface CostCard {
  from: string; to: string; days: CostDayLine[]; components: CostComponentLine[];
  /** Preview, test and unlabelled resources: reported apart, never in operator cost. */
  apart: { env: CostEnv; billedUsd: number }[];
  batches: CostBatchLine[]; brands: CostBrandLine[];
  alerts: { code: string; count: number }[];
}
export const COST_CARD_BATCHES = 15;

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => ((r as { rows?: Row[] }).rows ?? []);
const num = (v: unknown) => Number(v ?? 0);
const perProduct = (usd: number, n: number | null) => (n && n > 0 ? usd / n : null);

/** The cost card for UTC days [from, to) (`YYYY-MM-DD`): days newest first, totals per component, batches, brands. */
export async function costCard(db: Db, from: string, to: string): Promise<CostCard> {
  const inDays = sql`d.day >= ${from}::date AND d.day < ${to}::date`;
  const live = sql`d.kind IN ('service', 'job') AND d.env = 'live'`;
  const dayRows = rowsOf(await db.execute(sql`
    SELECT d.day::text AS day,
      sum(d.billed_usd) FILTER (WHERE ${live})::float8 AS billed,
      sum(d.attributed_usd) FILTER (WHERE ${live})::float8 AS attributed,
      sum(d.idle_usd) FILTER (WHERE ${live})::float8 AS idle,
      sum(d.shared_usd) FILTER (WHERE d.kind = 'shared')::float8 AS shared,
      sum(d.billed_usd) FILTER (WHERE d.kind = 'vendor')::float8 AS vendor,
      bool_or(d.provisional) AS provisional, bool_or(d.estimated) AS estimated, max(d.computed_at) AS computed_at,
      bool_and(d.attributed_usd <= d.billed_usd * ${1 + OVER_TOLERANCE} + ${OVER_MIN_USD}) FILTER (WHERE ${live}) AS closes,
      (SELECT coalesce(sum(a.idle_usd), 0) FROM catalog_cost_allocations AS a JOIN catalog_cost_days AS x
         ON x.day = a.day AND x.component = a.component AND x.env = 'live' AND x.source = a.source AND x.kind IN ('service', 'job')
       WHERE a.day = d.day)::float8 AS idle_allocated
    FROM catalog_cost_days AS d WHERE ${inDays} AND d.source = 'monitoring'
    GROUP BY d.day ORDER BY d.day DESC`));
  const days: CostDayLine[] = dayRows.map((r) => {
    const billed = num(r.billed), shared = num(r.shared), vendor = num(r.vendor), idle = num(r.idle);
    return {
      day: String(r.day), billedUsd: billed, attributedUsd: num(r.attributed), idleUsd: idle, idleNoBatchUsd: Math.max(0, idle - num(r.idle_allocated)),
      sharedUsd: shared, vendorUsd: vendor, totalUsd: billed + shared + vendor, provisional: r.provisional === true, estimated: r.estimated === true,
      closes: r.closes !== false, computedAt: r.computed_at instanceof Date ? r.computed_at : new Date(String(r.computed_at)),
    };
  });
  const compRows = rowsOf(await db.execute(sql`
    SELECT d.component, d.kind, d.env, sum(coalesce(d.billable_seconds, 0))::float8 AS seconds, sum(d.billed_usd)::float8 AS billed,
      sum(d.attributed_usd)::float8 AS attributed, sum(d.idle_usd)::float8 AS idle, sum(d.shared_usd)::float8 AS shared
    FROM catalog_cost_days AS d WHERE ${inDays} AND d.source = 'monitoring'
    GROUP BY 1, 2, 3 ORDER BY 5 DESC, 1`));
  const components: CostComponentLine[] = compRows.map((r) => ({
    component: String(r.component), kind: r.kind as CostLineKind, env: r.env as CostEnv, billableSeconds: num(r.seconds),
    billedUsd: num(r.billed), attributedUsd: num(r.attributed), idleUsd: num(r.idle), sharedUsd: num(r.shared),
  }));
  const apart = (["preview", "test", "unlabelled"] as const)
    .map((env) => ({ env, billedUsd: components.filter((c) => c.env === env).reduce((s, c) => s + c.billedUsd, 0) }))
    .filter((a) => a.billedUsd > 0);
  const batchRows = rowsOf(await db.execute(sql`
    SELECT a.batch_id, b.name, b.brand_name, b.is_test, o.products_with_links,
      sum(a.attributed_usd + a.idle_usd + a.shared_usd)::float8 AS true_usd, sum(a.attributed_usd)::float8 AS marginal_usd
    FROM catalog_cost_allocations AS a JOIN catalog_batches AS b ON b.id = a.batch_id
      LEFT JOIN catalog_batch_outcomes AS o ON o.batch_id = a.batch_id
    WHERE a.batch_id IN (SELECT DISTINCT x.batch_id FROM catalog_cost_allocations AS x WHERE x.day >= ${from}::date AND x.day < ${to}::date)
    GROUP BY a.batch_id, b.name, b.brand_name, b.is_test, o.products_with_links
    ORDER BY max(a.day) DESC, 6 DESC`));
  const all = batchRows.map((r): CostBatchLine => {
    const n = r.products_with_links === null || r.products_with_links === undefined ? null : num(r.products_with_links);
    const trueUsd = num(r.true_usd), marginalUsd = num(r.marginal_usd);
    return {
      batchId: String(r.batch_id), name: String(r.name), brandName: String(r.brand_name), isTest: r.is_test === true, productsWithLinks: n,
      trueUsd, marginalUsd, truePerProductUsd: perProduct(trueUsd, n), marginalPerProductUsd: perProduct(marginalUsd, n),
    };
  });
  const brands = new Map<string, CostBrandLine>();
  for (const b of all) {
    if (b.isTest) continue;
    const x = brands.get(b.brandName) ?? { brandName: b.brandName, batches: 0, productsWithLinks: 0, trueUsd: 0, truePerProductUsd: null };
    x.batches += 1;
    x.productsWithLinks += b.productsWithLinks ?? 0;
    x.trueUsd += b.trueUsd;
    x.truePerProductUsd = perProduct(x.trueUsd, x.productsWithLinks);
    brands.set(b.brandName, x);
  }
  const alertRows = rowsOf(await db.execute(sql`SELECT cause_code, count(*)::int AS n FROM catalog_incidents
    WHERE kind = 'alert' AND detail->>'day' >= ${from} AND detail->>'day' < ${to} GROUP BY 1 ORDER BY 2 DESC, 1`));
  return {
    from, to, days, components, apart, batches: all.slice(0, COST_CARD_BATCHES),
    brands: [...brands.values()].sort((a, b) => b.trueUsd - a.trueUsd),
    alerts: alertRows.map((r) => ({ code: String(r.cause_code), count: num(r.n) })),
  };
}

