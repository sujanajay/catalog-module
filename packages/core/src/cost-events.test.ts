import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "./db/client";
import { catalogBatches, catalogCostEvents } from "./db/schema";
import { createTestDb } from "./db/testing";
import { COST_EVENT_WRITE_FAILED, costComponent, costEventValues, ownComponent, recordCostEvent, recordCostEvents } from "./cost-events";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); });
afterAll(async () => { await close(); });

async function batch(name: string) {
  const [row] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "t" }).returning();
  return row!;
}

describe("cost ledger writes", () => {
  it("writes a row with its ids, money and tokens, and cleans bad numbers", async () => {
    const b = await batch("ledger-row");
    expect(await recordCostEvent(db, { batchId: b.id, brandSlug: "anta", isTest: true, stage: "qa", kind: "llm_call", engine: "test/judge", ms: 1234.6, usd: 0.000139, promptTokens: 2911, completionTokens: 160, outcome: "ok", attempt: 1 })).toBe(true);
    const [row] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b.id));
    expect(row).toMatchObject({ brandSlug: "anta", isTest: true, stage: "qa", kind: "llm_call", engine: "test/judge", ms: 1235, promptTokens: 2911, completionTokens: 160, outcome: "ok", attempt: 1, estimated: false, channel: null, outputId: null });
    expect(Number(row!.usd)).toBeCloseTo(0.000139, 9);
    expect(costEventValues({ batchId: b.id, brandSlug: "anta", isTest: false, stage: "matte", kind: "matte_call", engine: "cpu", ms: NaN, usd: -1, promptTokens: Infinity })).toMatchObject({ ms: 0, usd: 0, promptTokens: 0, completionTokens: 0, outcome: "ok" });
  });

  it("keeps eight decimals so a sub-cent judge call is not rounded to 0", async () => {
    const b = await batch("ledger-precision");
    await recordCostEvent(db, { batchId: b.id, brandSlug: "anta", isTest: true, stage: "qa", kind: "llm_call", engine: "m", usd: 0.00000123 });
    const [row] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b.id));
    expect(Number(row!.usd)).toBeCloseTo(0.00000123, 10);
  });

  it("a failing insert inside a transaction is caught in its savepoint and the surrounding write still commits", async () => {
    const b = await batch("ledger-savepoint"), log = vi.fn();
    await db.transaction(async (tx) => {
      await tx.update(catalogBatches).set({ name: "renamed" }).where(eq(catalogBatches.id, b.id));
      // An unknown batch id violates the foreign key; the row must not poison the outer transaction.
      const ok = await recordCostEvents(tx as unknown as Db, [{ batchId: "00000000-0000-0000-0000-000000000000", brandSlug: "anta", isTest: true, stage: "qa", kind: "llm_call", engine: "m" }], log);
      expect(ok).toBe(false);
      await tx.update(catalogBatches).set({ brandName: "After" }).where(eq(catalogBatches.id, b.id));
    });
    const [after] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, b.id));
    expect(after).toMatchObject({ name: "renamed", brandName: "After" });
    expect(log).toHaveBeenCalledWith(COST_EVENT_WRITE_FAILED, expect.objectContaining({ severity: "ERROR", batchId: "00000000-0000-0000-0000-000000000000", rows: 1 }));
    expect(await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b.id))).toHaveLength(0);
  });

  it("rejects values outside the stage, kind, outcome and channel lists at the database", async () => {
    const b = await batch("ledger-enums");
    for (const bad of [
      sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine) values (${b.id}, 'anta', 'intake', 'compute', 'worker')`,
      sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine) values (${b.id}, 'anta', 'matte', 'gpu_call', 'gpu')`,
      sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, outcome) values (${b.id}, 'anta', 'matte', 'compute', 'worker', 'skipped')`,
      sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, channel) values (${b.id}, 'anta', 'render', 'render', 'worker', 'flipkart')`,
    ]) await expect(db.execute(bad)).rejects.toThrow();
    await db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, channel) values (${b.id}, 'anta', 'render', 'render', 'worker', 'noon')`);
  });

  it("goes with its batch when the batch is deleted", async () => {
    const b = await batch("ledger-cascade");
    await recordCostEvent(db, { batchId: b.id, brandSlug: "anta", isTest: true, stage: "publish", kind: "compute", engine: "worker" });
    await db.delete(catalogBatches).where(eq(catalogBatches.id, b.id));
    expect(await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b.id))).toHaveLength(0);
  });
});

// M6-F1 (M6-S1): every row names the Cloud Run service or job (or the vendor) its money went to, rows of no batch are
// allowed, and the new stage, kind and outcome values are accepted.
describe("cost ledger completeness", () => {
  const MATTING = { MATTING_URL: "https://catalog-matting-x.run.app", MATTING_GPU_URL: "https://catalog-matting-gpu-x.run.app" };

  it("names the component: the vendor for a judge call, the answering service for matte and upscale calls, else itself", () => {
    const worker = { K_SERVICE: "catalog-worker", ...MATTING };
    expect(ownComponent({ K_SERVICE: "catalog-worker" })).toBe("catalog-worker");
    expect(ownComponent({ CLOUD_RUN_JOB: "catalog-migrate" })).toBe("catalog-migrate");
    expect(ownComponent({})).toBeNull();
    expect(costComponent({ kind: "llm_call", engine: "m" }, worker)).toBe("openrouter");
    expect(costComponent({ kind: "matte_call", engine: "gpu" }, worker)).toBe("catalog-matting-gpu");
    expect(costComponent({ kind: "matte_call", engine: "cpu" }, worker)).toBe("catalog-matting");
    // M3-S5 (review P2-3): an overflow vendor's call is billed to that vendor, never to the worker.
    expect(costComponent({ kind: "matte_call", engine: "photoroom" }, worker)).toBe("photoroom");
    expect(costComponent({ kind: "upscale_call", engine: "photoroom" }, worker)).toBe("photoroom");
    expect(costComponent({ kind: "upscale_call", engine: "cpu" }, worker)).toBe("catalog-matting");
    expect(costComponent({ kind: "upscale_call", engine: "cpu" }, { ...worker, UPSCALE_URL: "https://catalog-upscale-x.run.app" })).toBe("catalog-upscale");
    expect(costComponent({ kind: "upscale_call", engine: "gpu" }, worker)).toBe("catalog-matting-gpu");
    expect(costComponent({ kind: "upscale_call", engine: "gpu" }, { ...worker, UPSCALE_GPU_URL: "https://catalog-upscale-gpu-x.run.app" })).toBe("catalog-upscale-gpu");
    expect(costComponent({ kind: "compute", engine: "worker" }, worker)).toBe("catalog-worker");
    expect(costComponent({ kind: "compute", engine: "worker", component: "catalog-web" }, worker)).toBe("catalog-web");
  });

  it("writes a row of no batch (no brand either) with its component and billable time", async () => {
    expect(await recordCostEvent(db, { batchId: null, brandSlug: "ignored", isTest: false, stage: "system", kind: "job", engine: "job", component: "catalog-migrate", ms: 4000, billableMs: 4000, usd: 0.000176, estimated: true })).toBe(true);
    const [row] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.component, "catalog-migrate"));
    expect(row).toMatchObject({ batchId: null, brandSlug: null, stage: "system", kind: "job", billableMs: 4000, estimated: true, contentVersionId: null });
  });

  it("accepts the new stages, kinds and outcomes", async () => {
    const b = await batch("ledger-new-values");
    for (const [stage, kind, outcome] of [["ingest", "compute", "ok"], ["system", "job", "failed"], ["upscale", "wait", "ok"], ["upscale", "upscale_call", "timeout"], ["upscale", "upscale_call", "killed"], ["matte", "compute", "duplicate"]] as const) {
      expect(await recordCostEvent(db, { batchId: b.id, brandSlug: "anta", isTest: true, stage, kind, engine: "worker", outcome })).toBe(true);
    }
    expect(await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b.id))).toHaveLength(6);
  });
});
