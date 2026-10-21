import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "./db/client";
import { catalogBatches, catalogCostEvents } from "./db/schema";
import { createTestDb } from "./db/testing";
import { COST_EVENT_WRITE_FAILED, costEventValues, recordCostEvent, recordCostEvents } from "./cost-events";

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
      sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine) values (${b.id}, 'anta', 'ingest', 'compute', 'worker')`,
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
