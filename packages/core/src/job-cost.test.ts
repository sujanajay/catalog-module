// M6-F1-R3 (M6-S1): a Cloud Run job run writes one `job` row with its billable seconds and its job name; nothing is
// written outside Cloud Run.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./db/client";
import { catalogBatches, catalogCostEvents } from "./db/schema";
import { createTestDb } from "./db/testing";
import { DEFAULT_JOB_USD_PER_SECOND, jobUsdPerSecond, recordJobRun } from "./job-cost";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); });
afterAll(async () => { await close(); });

describe("job run rows", () => {
  it("prices a second at the job shape, or at JOB_USD_PER_SECOND", () => {
    expect(jobUsdPerSecond({})).toBe(DEFAULT_JOB_USD_PER_SECOND);
    expect(jobUsdPerSecond({ JOB_USD_PER_SECOND: "0.0001" })).toBe(0.0001);
    expect(jobUsdPerSecond({ JOB_USD_PER_SECOND: "nope" })).toBe(DEFAULT_JOB_USD_PER_SECOND);
  });

  it("writes nothing outside a Cloud Run job", async () => {
    expect(await recordJobRun(db, { startedAt: 0, now: 1000, outcome: "ok", env: {} })).toBe(false);
  });

  it("writes a row of no batch with the job name, billable time and an estimated price", async () => {
    expect(await recordJobRun(db, { startedAt: 1000, now: 61_000, outcome: "failed", env: { CLOUD_RUN_JOB: "catalog-migrate" } })).toBe(true);
    const [row] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.component, "catalog-migrate"));
    expect(row).toMatchObject({ batchId: null, brandSlug: null, isTest: false, stage: "system", kind: "job", engine: "job", ms: 60_000, billableMs: 60_000, estimated: true, outcome: "failed" });
    expect(Number(row!.usd)).toBeCloseTo(60 * DEFAULT_JOB_USD_PER_SECOND, 8);
  });

  it("puts the row on the batch the run belongs to, and marks a test run", async () => {
    const [b] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: "job-row", isTest: false, createdBy: "t" }).returning();
    await recordJobRun(db, { startedAt: 0, now: 2000, outcome: "ok", batchId: b!.id, env: { CLOUD_RUN_JOB: "catalog-recheck" } });
    await recordJobRun(db, { startedAt: 0, now: 2000, outcome: "ok", isTest: true, env: { CLOUD_RUN_JOB: "catalog-test-smoke" } });
    const [onBatch] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.component, "catalog-recheck"));
    expect(onBatch).toMatchObject({ batchId: b!.id, brandSlug: "anta", isTest: false });
    const [test] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.component, "catalog-test-smoke"));
    expect(test).toMatchObject({ batchId: null, isTest: true });
  });
});
