// R1 exit finding 4 (review P2-3 of PR #188): batch 84a5a30a's cost, recomputed by the real reconciliation path from the
// live data of 2026-11-06 and the shifts seeded by migration 0028. The fixture (fixtures/cost-replay-2026-11-06.json) holds
// Cloud Run billable instance time per revision and minute and every cost ledger row of the day, exported read only at
// 06:14Z; it has no secrets and no personal data (component and revision names, batch labels, times, durations, USD and
// Cloud Run shapes only).
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogCostEvents } from "../db/schema";
import { createTestDb } from "../db/testing";
import { reconcileDay, runResourceFrom, type BillableSample, type DayResult, type RunResource, type V2Item } from "./cost-reconcile";

interface Fixture {
  base: string;
  monitoringDerivedA: number;
  otherBatches: number;
  components: string[];
  kinds: string[];
  engines: string[];
  resources: { kind: "service" | "job"; region: string; item: V2Item }[];
  minutes: { name: string; kind: "service" | "job"; region: string; revision?: string; points: [number, number][] }[];
  ledger: [number, string, number, number, number, number, 0 | 1, number][];
}
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "cost-replay-2026-11-06.json"), "utf8")) as Fixture;
const BASE = Date.parse(fixture.base), DAY = "2026-11-06";
const A = "84a5a30a-db54-433a-a26f-fc46697a95d2", B = "ffa92dbf-ee2a-4daa-9713-2de6e488c14e";
const others = Array.from({ length: fixture.otherBatches }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const idOf = (label: string) => (label === "" ? null : label === "A" ? A : label === "B" ? B : others[Number(label.slice(1))]!);
const stage = (kind: string) => (kind === "llm_call" ? "qa" : kind === "matte_call" ? "matte" : kind === "upscale_call" ? "upscale" : kind === "compute" ? "render" : "system");

const resources: RunResource[] = fixture.resources.map((r) => runResourceFrom(r.kind, r.region, r.item));
const perRevision: BillableSample[] = fixture.minutes.map((m) => ({
  name: m.name, kind: m.kind, region: m.region, ...(m.revision ? { revision: m.revision } : {}),
  seconds: m.points.reduce((t, p) => t + p[1], 0), points: m.points.map(([offset, seconds]) => ({ endMs: BASE + offset, seconds })),
}));
/** The old read: one series per service. */
function perService(): BillableSample[] {
  const merged = new Map<string, BillableSample & { points: { endMs: number; seconds: number }[] }>();
  for (const s of perRevision) {
    const key = `${s.kind}|${s.region}|${s.name}`;
    const m = merged.get(key) ?? merged.set(key, { name: s.name, kind: s.kind, region: s.region, seconds: 0, points: [] }).get(key)!;
    m.seconds += s.seconds;
    m.points.push(...(s.points ?? []));
  }
  return [...merged.values()];
}

let db: Db, close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const id of [A, B, ...others]) {
    await db.execute(sql`INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, created_by) VALUES (${id}, 'replay', 'Replay', ${id}, 'done', 'replay@example.com')`);
    await db.execute(sql`INSERT INTO catalog_batch_outcomes (batch_id, status, success, ended_at) VALUES (${id}, 'done', true, '2026-11-06T05:00:00Z')`);
  }
  const rows = fixture.ledger.map(([c, label, k, offset, busyMs, usd, estimated, e]) => {
    const kind = fixture.kinds[k]!;
    return { component: fixture.components[c]!, batchId: idOf(label), kind: kind as "compute", stage: stage(kind) as "render", engine: fixture.engines[e]!, at: new Date(BASE + offset), ms: busyMs, billableMs: busyMs, usd, estimated: estimated === 1 };
  });
  for (let i = 0; i < rows.length; i += 500) await db.insert(catalogCostEvents).values(rows.slice(i, i + 500));
}, 240_000);
afterAll(async () => { await close(); });

const reconcile = (samples: readonly BillableSample[]): Promise<DayResult> =>
  reconcileDay(db, DAY, { samples, resources, provisional: true, now: new Date("2026-11-07T06:00:00Z") });
/** A batch's cost without the shared Cloud SQL line, which monitoring cannot see (M6 decision C5). */
async function batchUsd(id: string): Promise<number> {
  const { rows } = (await db.execute(sql`SELECT coalesce(sum(attributed_usd + idle_usd + shared_usd), 0)::float8 AS usd FROM catalog_cost_allocations
    WHERE day = ${DAY} AND batch_id = ${id} AND component <> 'ila-pg'`)) as unknown as { rows: { usd: number }[] };
  return rows[0]!.usd;
}

describe("replay of 2026-11-06", () => {
  it("read per service the deploy's candidates land on the batch: USD 18.73, +20.5% against monitoring", async () => {
    await reconcile(perService());
    expect(Math.abs(await batchUsd(A) - 18.73)).toBeLessThan(0.05);
  }, 120_000);

  it("read per revision batch 84a5a30a comes out at USD 15.46 against monitoring's 15.54, and nothing is presumed", async () => {
    const result = await reconcile(perRevision);
    const usd = await batchUsd(A);
    expect(Math.abs(usd - 15.46)).toBeLessThan(0.05);
    expect(Math.abs(usd - fixture.monitoringDerivedA) / fixture.monitoringDerivedA).toBeLessThan(0.02);
    expect(Math.abs(await batchUsd(B) - 0.585)).toBeLessThan(0.02);
    // Every revision of the day has its record, so the fail-safe must stay silent on real data.
    expect(result.alerts.filter((a) => a.code === "traffic_shift_missing")).toEqual([]);
  }, 120_000);
});
