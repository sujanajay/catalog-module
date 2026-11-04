// M6-S6 (M6-F3-R5): the Ops reliability card and GET /api/catalog/ops/reliability, on PGlite with the real core reads.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchOutcomes, catalogBatchTouches, catalogIncidents } from "@catalog/core/db/schema";
import { openIncident, recordBatchOutcome, recordTouch } from "@catalog/core/catalog/reliability";
import type { Role } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { resetOpsCostCache, setCloudRunReadForTests } from "../lib/catalog/ops";
import { incidentDurationText, outcomeText, successRateLine, successRateText } from "../lib/catalog/ops-copy";
import OpsPage from "../app/catalog/ops/page";
import { GET } from "../app/api/catalog/ops/reliability/route";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), notFound: () => { throw new Error("not found"); } }));

const NOW = new Date();
const ago = (minutes: number) => new Date(+NOW - minutes * 60_000);
let db: Db, close: () => Promise<void>;
let role: Role = "admin";
beforeAll(async () => { ({ db, close } = await createTestDb()); setDbForTests(db); });
afterAll(async () => { setDbForTests(undefined); await close(); });
beforeEach(async () => {
  resetOpsCostCache();
  role = "admin";
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("DEV_USER_EMAIL", "admin@opptra.com");
  setUserDeps({ roleLookup: async () => role });
  setCloudRunReadForTests(async () => ({ trafficStatuses: [] }));
  await db.delete(catalogIncidents); await db.delete(catalogBatchTouches); await db.delete(catalogBatchOutcomes); await db.delete(catalogBatches);
});
afterEach(() => { resetUserDeps(); setCloudRunReadForTests(undefined); vi.unstubAllEnvs(); });

const render = async (page: Promise<ReactElement>) => renderToStaticMarkup(createElement(ViewerPreviewProvider, null, createElement(ToastProvider, null, await page)));

/** Two done batches, one clean and one with a stall resolved after 20 minutes. */
async function world() {
  const done = async (name: string, minutes: number) => (await db.insert(catalogBatches).values({ name, brandSlug: "uspa", brandName: "USPA", createdBy: "a@opptra.com", status: "done", startedAt: ago(minutes + 30), finishedAt: ago(minutes) }).returning())[0]!;
  const clean = await done("Clean drop", 100), slow = await done("Slow drop", 60);
  await openIncident(db, { kind: "stall", severity: "warning", batchId: slow.id, causeCode: "enlarge_wait", cause: "No progress: photos are waiting for the enlargement service.", startedAt: ago(85), resolvedAt: ago(65), dedupeKey: `stall:${slow.id}:x` });
  await recordBatchOutcome(db, clean.id, NOW);
  await recordBatchOutcome(db, slow.id, NOW);
  return { clean, slow };
}

describe("Ops reliability card (M6-F3-R5)", () => {
  it("shows the 7 and 30-day success rates, incidents by kind with cause and resolution, and the slowest batches", async () => {
    const { slow } = await world();
    const html = await render(OpsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Reliability");
    expect(html).toContain("Last 7 days: 50% (1 of 2 batches), under the 99% target");
    expect(html).toContain("Last 30 days: 50% (1 of 2 batches)");
    expect(html).toContain("<td>No progress</td><td>1</td><td>0</td><td>0</td>");
    expect(html).toContain("No progress: photos are waiting for the enlargement service. (resolved after 20 min)");
    expect(html).toContain(`href="/catalog/${slow.id}"`);
    expect(html).toContain("<td>30 min</td>");
  });

  it("serves the same numbers as JSON to admins only, and refuses a bad window", async () => {
    await world();
    const res = await GET(new Request("http://localhost/api/catalog/ops/reliability"));
    expect(res.status).toBe(200);
    const body = await res.json() as { rates: { days: number; successes: number; counted: number }[]; byKind: { kind: string; incidents: number }[] };
    expect(body.rates.map((r) => [r.days, r.successes, r.counted])).toEqual([[7, 1, 2], [30, 1, 2]]);
    expect(body.byKind).toEqual([expect.objectContaining({ kind: "stall", incidents: 1 })]);
    expect((await GET(new Request("http://localhost/api/catalog/ops/reliability?from=nope"))).status).toBe(400);
    expect((await GET(new Request(`http://localhost/api/catalog/ops/reliability?from=${NOW.toISOString()}&to=${ago(60).toISOString()}`))).status).toBe(400);
    role = "operator";
    expect((await GET(new Request("http://localhost/api/catalog/ops/reliability"))).status).toBe(403);
  });

  it("lists recent batches with their touches and incidents in plain words (review P2-4)", async () => {
    const { clean, slow } = await world();
    const test = (await db.insert(catalogBatches).values({ name: "Test drop", brandSlug: "uspa", brandName: "USPA", createdBy: "a@opptra.com", status: "done", isTest: true, startedAt: ago(50), finishedAt: ago(40) }).returning())[0]!;
    await recordTouch(db, { action: "decision", batchId: slow.id }, ago(62));
    await recordTouch(db, { action: "retry_photo", batchId: slow.id }, ago(61));
    await recordBatchOutcome(db, slow.id, NOW);
    await recordBatchOutcome(db, test.id, NOW);
    const html = await render(OpsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Recent batches");
    expect(html).toMatch(new RegExp(`href="/catalog/${slow.id}">Slow drop</a></td><td>USPA</td><td>.*?</td><td>No</td><td>2</td><td>1</td><td>A person stepped in</td>`));
    expect(html).toMatch(new RegExp(`href="/catalog/${clean.id}">Clean drop</a></td><td>USPA</td><td>.*?</td><td>Yes</td><td>0</td><td>0</td><td></td>`));
    expect(html).toContain("<td>test batch, not counted</td>");
  });

  it("never lets a browser or proxy keep the JSON, and reads a custom window fresh (review P2-5)", async () => {
    const { slow } = await world();
    const first = await GET(new Request("http://localhost/api/catalog/ops/reliability"));
    expect(first.headers.get("cache-control")).toBe("no-store");
    await recordTouch(db, { action: "decision", batchId: slow.id }, ago(1));
    await recordBatchOutcome(db, slow.id, NOW);
    const window = `from=${ago(24 * 60).toISOString()}&to=${new Date(+NOW + 60_000).toISOString()}`;
    const fresh = await GET(new Request(`http://localhost/api/catalog/ops/reliability?${window}`));
    expect(fresh.headers.get("cache-control")).toBe("no-store");
    const body = await fresh.json() as { batches: { batchId: string; touches: number }[] };
    expect(body.batches.find((b) => b.batchId === slow.id)?.touches).toBe(1);
    const again = await GET(new Request(`http://localhost/api/catalog/ops/reliability?${window}`));
    expect(((await again.json()) as typeof body).batches.find((b) => b.batchId === slow.id)?.touches).toBe(1);
  });

  it("words the rates and durations plainly", () => {
    expect(successRateText({ successes: 0, counted: 0, rate: null })).toBe("No batches finished");
    expect(successRateLine({ days: 7, successes: 99, counted: 100, rate: 0.99 }, 0.99)).toBe("Last 7 days: 99% (99 of 100 batches)");
    expect(successRateText({ successes: 1, counted: 1, rate: 1 })).toBe("100% (1 of 1 batch)");
    // Review 2 P3-A: a quick cancel after Start is not "never started".
    expect(outcomeText({ success: false, cause: "cancelled", isTest: false, excluded: true, started: true })).toBe("Cancelled; cancelled right after Start, not counted");
    expect(outcomeText({ success: false, cause: "cancelled", isTest: false, excluded: true, started: false })).toBe("Cancelled; never started, not counted");
    expect(incidentDurationText({ startedAt: ago(10), resolvedAt: null })).toBe("still open");
    expect(incidentDurationText({ startedAt: ago(10), resolvedAt: ago(10) })).toBe("one-off");
    expect(incidentDurationText({ startedAt: ago(200), resolvedAt: ago(10) })).toBe("resolved after 3 h 10 min");
  });
});
