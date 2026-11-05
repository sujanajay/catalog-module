// M6-S2 (M6-F1-R4 to R6, R9): the Ops cost card and GET /api/catalog/ops/cost, on PGlite with the real core reads and
// a day the reconciliation computed from Cloud Monitoring samples (no Google call).
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchOutcomes, catalogCostAllocations, catalogCostDays, catalogCostEvents, catalogIncidents } from "@catalog/core/db/schema";
import { reconcileDay, runResourceFrom, utcDay } from "@catalog/core/catalog/cost-reconcile";
import type { Role } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { resetOpsCostCache, setCloudRunReadForTests } from "../lib/catalog/ops";
import { costCheckText, costPartWords } from "../lib/catalog/ops-copy";
import OpsPage from "../app/catalog/ops/page";
import { GET } from "../app/api/catalog/ops/cost/route";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), notFound: () => { throw new Error("not found"); } }));

const NOW = new Date();
const DAY = utcDay(NOW, 1);
let db: Db, close: () => Promise<void>;
let role: Role = "admin";
beforeAll(async () => { ({ db, close } = await createTestDb()); setDbForTests(db); });
afterAll(async () => { setDbForTests(undefined); await close(); });
beforeEach(async () => {
  resetOpsCostCache();
  role = "admin";
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("DEV_USER_EMAIL", "admin@opptra.com");
  vi.stubEnv("INR_PER_USD", "");
  setUserDeps({ roleLookup: async () => role });
  setCloudRunReadForTests(async () => ({ trafficStatuses: [] }));
  for (const t of [catalogCostAllocations, catalogCostDays, catalogCostEvents, catalogIncidents, catalogBatchOutcomes, catalogBatches]) await db.delete(t);
});
afterEach(() => { resetUserDeps(); setCloudRunReadForTests(undefined); vi.unstubAllEnvs(); });

const render = async (page: Promise<ReactElement>) => renderToStaticMarkup(createElement(ViewerPreviewProvider, null, createElement(ToastProvider, null, await page)));
const gpu = runResourceFrom("service", "asia-south2", { name: "catalog-upscale-gpu", labels: { app: "catalog", component: "catalog-upscale-gpu", env: "live" },
  template: { containers: [{ resources: { limits: { cpu: "20", memory: "80Gi", "nvidia.com/gpu": "1" } } }], nodeSelector: { accelerator: "nvidia-rtx-pro-6000" }, gpuZonalRedundancyDisabled: true } });
const preview = runResourceFrom("service", "asia-south1", { name: "catalog-worker-preview", labels: { app: "catalog", component: "catalog-worker-preview", env: "preview" },
  template: { containers: [{ resources: { limits: { cpu: "4", memory: "4Gi" }, cpuIdle: true } }] } });

/** Yesterday: one batch of 10 products whose upscale calls explain 400 of 1000 billed GPU seconds, and a preview run. */
async function world() {
  const [batch] = await db.insert(catalogBatches).values({ name: "Spring drop", brandSlug: "uspa", brandName: "USPA", createdBy: "a@opptra.com", status: "done", startedAt: new Date(`${DAY}T08:00:00Z`), finishedAt: new Date(`${DAY}T10:00:00Z`) }).returning();
  await db.insert(catalogBatchOutcomes).values({ batchId: batch!.id, status: "done", success: true, endedAt: new Date(`${DAY}T10:00:00Z`), products: 10, productsWithLinks: 10 });
  await db.execute(sql`INSERT INTO catalog_cost_events (batch_id, brand_slug, stage, kind, engine, ms, usd, component, at)
    VALUES (${batch!.id}, 'uspa', 'upscale', 'upscale_call', 'gpu', 400000, ${400 * 0.00106226}, 'catalog-upscale-gpu', ${`${DAY}T09:00:00Z`}::timestamptz)`);
  await reconcileDay(db, DAY, {
    samples: [{ name: "catalog-upscale-gpu", kind: "service", region: "asia-south2", seconds: 1000 }, { name: "catalog-worker-preview", kind: "service", region: "asia-south1", seconds: 3600 }],
    resources: [gpu, preview], provisional: true, now: NOW,
  });
  return batch!;
}

describe("Ops cost card (M6-F1-R4 to R6)", () => {
  it("shows the day's billed, recorded, idle and shared lines in plain words, preview apart, and the true cost per product", async () => {
    const batch = await world();
    const html = await render(OpsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Cost matched to Google Cloud");
    expect(html).toContain(`<td>${DAY}</td>`);
    expect(html).toContain("Adds up, may still change");
    expect(html).toContain("<td>enlargement (GPU)</td>");
    expect(html).toContain("<td>shared database (catalog share)</td>");
    expect(html).toContain("Not in the totals above: preview stack USD 0.3816");
    expect(html).toContain(`href="/catalog/${batch.id}">Spring drop</a></td><td>USPA</td><td>10</td>`);
    // Recorded only: 400 s x USD 0.00106226 / 10 products.
    expect(html).toContain("<td>USD 0.0425</td>");
    // Service names never reach the card as such, nor any vendor.
    expect(html).not.toContain("catalog-upscale-gpu");
    expect(html).not.toMatch(/openrouter/i);
  });

  it("says plainly when the daily check has not run", async () => {
    const html = await render(OpsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("The daily cost check has not run yet.");
  });

  it("serves the card as JSON to admins only, never cached, and refuses a bad window", async () => {
    const batch = await world();
    const res = await GET(new Request("http://localhost/api/catalog/ops/cost"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { days: { day: string; billedUsd: number; idleUsd: number }[]; batches: { batchId: string; trueUsd: number }[] };
    expect(body.days.map((d) => d.day)).toEqual([DAY]);
    expect(body.days[0]!.idleUsd).toBeCloseTo(600 * 0.00106226, 5);
    expect(body.batches[0]!.batchId).toBe(batch.id);
    const fresh = await GET(new Request(`http://localhost/api/catalog/ops/cost?from=${DAY}&to=${utcDay(NOW, 0)}`));
    expect(((await fresh.json()) as typeof body).days).toHaveLength(1);
    expect((await GET(new Request("http://localhost/api/catalog/ops/cost?from=nope"))).status).toBe(400);
    expect((await GET(new Request(`http://localhost/api/catalog/ops/cost?from=${utcDay(NOW, 0)}&to=${DAY}`))).status).toBe(400);
    role = "operator";
    expect((await GET(new Request("http://localhost/api/catalog/ops/cost"))).status).toBe(403);
  });

  it("words parts and checks plainly", () => {
    expect(costPartWords("catalog-worker-preview", "service")).toBe("worker (preview)");
    expect(costPartWords("catalog-load", "job")).toBe("background job: load");
    expect(costPartWords("catalog-graph-export", "job")).toBe("background job: graph export");
    expect(costPartWords("photoroom", "vendor")).toBe("cut-out overflow");
    expect(costPartWords("openrouter", "vendor")).toBe("quality checks (outside Google Cloud)");
    expect(costCheckText({ closes: false, provisional: false })).toBe("Record above the bill");
  });
});
