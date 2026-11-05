// R1 exit item 4, review fixes of PR #185: the per-minute idle allocation keeps bounded memory at a 25k-row batch day
// (P2-2) and gives idle just after or before midnight UTC to the work across the boundary (P3-3). Pure functions, no
// database.
import { describe, expect, it } from "vitest";
import { allocateIdle, IDLE_BUCKET_MS, IDLE_LEAD_MS, IDLE_TAIL_MS, ledgerDay, type BillablePoint, type LedgerEvent } from "./cost-reconcile";

const DAY = Date.parse("2026-11-05T00:00:00Z"), NEXT = DAY + 86_400_000, MIN = IDLE_BUCKET_MS;
const DAY_MINUTES = 1440, WIDE_MINUTES = DAY_MINUTES + (IDLE_TAIL_MS + IDLE_LEAD_MS) / MIN;
const billedEveryMinute = (from: number, to: number, usd: number): BillablePoint[] =>
  Array.from({ length: Math.round((to - from) / MIN) }, (_, i) => ({ endMs: from + (i + 1) * MIN, seconds: usd }));

describe("P2-2: memory at a 25k-row batch day", () => {
  it("keeps one array per batch and component however many ledger rows the day has", () => {
    // A heavy day: 4 batches of 25,000 products, about 5 timed calls per product on two components (500,000 rows), with
    // up to 8 calls at once per component. Each batch runs 5 hours.
    const batches = ["a", "b", "c", "d"], components = ["catalog-upscale-gpu", "catalog-worker"];
    const events: LedgerEvent[] = [];
    for (const [k, batchId] of batches.entries()) {
      const start = DAY + k * 5 * 3_600_000;
      for (let i = 0; i < 62_500; i++) {
        for (const component of components) {
          const endMs = start + Math.floor((i * 5 * 3_600_000) / 62_500) + 2000;
          events.push({ component, batchId, endMs, busyMs: 2000, usd: 0.0005, estimated: false });
        }
      }
    }
    expect(events.length).toBe(500_000);
    const heapBefore = process.memoryUsage().heapUsed, t = performance.now();
    const { rows, minutes } = ledgerDay(events, DAY, NEXT, new Map(components.map((c) => [c, 0.0005 / 2000 * 8])));
    const results = components.map((c) => allocateIdle(10, billedEveryMinute(DAY, DAY + 20 * 3_600_000, 0.2), minutes.get(c), DAY, NEXT));
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore, ms = performance.now() - t;
    console.log(`500k ledger rows: ${Math.round(ms)} ms, heap growth ${Math.round(heapGrowth / 1e6)} MB`);
    // What is kept is fixed-size: per component one work array of the day's minutes, per batch one busy array of the
    // widened day's minutes; nothing per ledger row or per stretch of work.
    expect(rows.length).toBe(batches.length * components.length);
    for (const c of components) {
      const m = minutes.get(c)!;
      expect(m.workUsd.length).toBe(DAY_MINUTES);
      expect([...m.busyMs.keys()].sort()).toEqual(batches);
      for (const a of m.busyMs.values()) expect(a.length).toBe(WIDE_MINUTES);
    }
    for (const r of results) expect([...r!.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(10, 6);
    // The reconcile job has 1 GiB; the rows themselves are about 100 MB of this run. Generous bound for a GC-timed number.
    expect(heapGrowth).toBeLessThan(400e6);
  }, 120_000);
});

describe("P3-3: idle across midnight UTC", () => {
  it("gives idle just after midnight to the work before it, and idle just before the next midnight to the work after it", () => {
    const events: LedgerEvent[] = [
      // Batch "late": busy 23:50-23:58 the day before; the instance idles on into the day until 00:10.
      { component: "c", batchId: "late", endMs: DAY - 2 * MIN, busyMs: 8 * MIN, usd: 0.08, estimated: false },
      // Batch "early": a call from 00:02 the next day; its instance started at 23:57.
      { component: "c", batchId: "early", endMs: NEXT + 3 * MIN, busyMs: MIN, usd: 0.01, estimated: false },
    ];
    const { rows, minutes } = ledgerDay(events, DAY, NEXT, new Map());
    // Neither batch has work inside the day, so neither has a ledger row: only idle.
    expect(rows).toEqual([]);
    const billed = [...billedEveryMinute(DAY, DAY + 10 * MIN, 0.01), ...billedEveryMinute(NEXT - 3 * MIN, NEXT, 0.01)];
    const idle = allocateIdle(0.13, billed, minutes.get("c"), DAY, NEXT)!;
    expect(idle.get("late")).toBeCloseTo(0.1, 6);
    expect(idle.get("early")).toBeCloseTo(0.03, 6);
  });
});
