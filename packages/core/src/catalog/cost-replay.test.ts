// R1 exit item 4 (review P2-1 of PR #185): the proof batch's cost, recomputed by the real reconciliation path from the
// live data of 2026-11-05. The fixture (fixtures/cost-replay-2026-11-05.json) holds Cloud Run billable instance time
// per minute (13:00-17:00Z) and every cost ledger row of 13:00-17:30Z, exported read only; it has no secrets and no
// personal data (component names, batch labels, times, durations, USD and Cloud Run shapes only).
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { catalogCostEvents } from "../db/schema";
import { reconcileDay, runResourceFrom, type BillableSample, type RunResource, type V2Item } from "./cost-reconcile";

interface Fixture {
  base: string;
  monitoringDerived: { usdA: number; productsA: number; usdPerProductA: number };
  components: string[];
  resources: { name: string; kind: "service" | "job"; region: string; labels: Record<string, string>; limits: Record<string, string>; cpuIdle: boolean; accelerator: string | null; gpuZonalRedundancyDisabled: boolean }[];
  minutes: { name: string; kind: "service" | "job"; region: string; points: [number, number][] }[];
  ledger: [number, "" | "A" | "B", number, number, number, 0 | 1][];
}
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "cost-replay-2026-11-05.json"), "utf8")) as Fixture;
const BASE = Date.parse(fixture.base);
const IDS = { A: "216e5b7d-2ebd-4589-8907-5a22fc8c9e66", B: "598bbc40-5a1e-491f-8af8-41ddf6597dd5" } as const;

/** The ledger row's kind, stage and engine as the live writers record them for its component. */
function shape(component: string): { kind: "llm_call" | "matte_call" | "upscale_call" | "compute" | "job"; stage: "qa" | "matte" | "upscale" | "render" | "system"; engine: string } {
  if (component === "openrouter") return { kind: "llm_call", stage: "qa", engine: "catalog_qa" };
  if (component === "catalog-matting-gpu") return { kind: "matte_call", stage: "matte", engine: "gpu" };
  if (component === "catalog-upscale-gpu") return { kind: "upscale_call", stage: "upscale", engine: "gpu" };
  if (component === "catalog-worker") return { kind: "compute", stage: "render", engine: "worker" };
  return { kind: "job", stage: "system", engine: component };
}

let db: Db, close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const [label, id] of Object.entries(IDS)) {
    await db.execute(sql`INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, created_by, started_at, finished_at)
      VALUES (${id}, 'vero-moda', 'Vero Moda', ${`replay ${label}`}, 'done', 'replay@example.com', '2026-11-05T15:30:30Z', '2026-11-05T15:56:07Z')`);
    await db.execute(sql`INSERT INTO catalog_batch_outcomes (batch_id, status, success, ended_at, products, products_with_links)
      VALUES (${id}, 'done', true, '2026-11-05T15:56:07Z', ${label === "A" ? 141 : 5}, ${label === "A" ? 141 : 5})`);
  }
  const rows = fixture.ledger.map(([c, batch, endMs, busyMs, usd, estimated]) => {
    const component = fixture.components[c]!;
    return { ...shape(component), component, batchId: batch ? IDS[batch] : null, at: new Date(BASE + endMs), ms: busyMs, usd, estimated: estimated === 1 };
  });
  for (let i = 0; i < rows.length; i += 500) await db.insert(catalogCostEvents).values(rows.slice(i, i + 500));
}, 120_000);
afterAll(async () => { await close(); });

it("batch 216e5b7d's cost from the live 2026-11-05 minutes and ledger is within 10% of the monitoring-derived spend", async () => {
  const resources: RunResource[] = fixture.resources.map((r) => {
    const template = { containers: [{ resources: { limits: r.limits, cpuIdle: r.cpuIdle } }], ...(r.accelerator ? { nodeSelector: { accelerator: r.accelerator } } : {}), gpuZonalRedundancyDisabled: r.gpuZonalRedundancyDisabled };
    return runResourceFrom(r.kind, r.region, { name: r.name, labels: r.labels, template: (r.kind === "job" ? { template } : template) as V2Item["template"] });
  });
  const samples: BillableSample[] = fixture.minutes.map((m) => ({
    name: m.name, kind: m.kind, region: m.region, seconds: m.points.reduce((s, [, v]) => s + v, 0),
    points: m.points.map(([minute, seconds]) => ({ endMs: BASE + minute * 60_000, seconds })),
  }));
  await reconcileDay(db, "2026-11-05", { samples, resources, provisional: false, now: new Date("2026-11-08T06:00:00Z") });
  const alloc = ((await db.execute(sql`SELECT batch_id, component, attributed_usd::float8 AS a, idle_usd::float8 AS i, shared_usd::float8 AS s
    FROM catalog_cost_allocations WHERE day = '2026-11-05'`)) as unknown as { rows: { batch_id: string; component: string; a: number; i: number; s: number }[] }).rows;
  // Like for like (M6 decision C5): the monitoring-derived figure has no shared database line.
  const gcpAndVendor = (id: string) => alloc.filter((r) => r.batch_id === id && r.component !== "ila-pg").reduce((sum, r) => sum + r.a + r.i, 0);
  const a = gcpAndVendor(IDS.A), perProduct = a / fixture.monitoringDerived.productsA;
  expect(Math.abs(perProduct / fixture.monitoringDerived.usdPerProductA - 1)).toBeLessThan(0.1);
  // The figure recorded in M6 decision C1 (USD 7.16 = 0.0508 per product), so a change to the rule shows here.
  expect(a).toBeCloseTo(7.16, 1);
  // Batch B (5 products, 15:40-15:44) gets its own small share, not A's idle tail.
  expect(gcpAndVendor(IDS.B)).toBeLessThan(0.1 * a);
  // The 13:00-14:57 deploy probes on the GPU services are idle with no batch, so A and B together stay below the window's billed GPU time.
  const gpu = alloc.filter((r) => r.component.endsWith("-gpu")).reduce((sum, r) => sum + r.a + r.i, 0);
  const billedGpu = ((await db.execute(sql`SELECT sum(billed_usd)::float8 AS b FROM catalog_cost_days WHERE day = '2026-11-05' AND component LIKE '%-gpu'`)) as unknown as { rows: { b: number }[] }).rows[0]!.b;
  expect(gpu).toBeLessThan(0.7 * billedGpu);
}, 120_000);
