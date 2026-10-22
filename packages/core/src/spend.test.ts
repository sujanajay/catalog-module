import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db/client";
import { catalogBatches, spendDays } from "./db/schema";
import { createTestDb } from "./db/testing";
import { checkCaps, dailyCapFromEnv, recordCost, sumSpendForDay } from "./spend";

let db: Db;
let close: () => Promise<void>;
let batchId: string;
let cappedBatchId: string;

const NOW = new Date("2026-10-02T12:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [b1] = await db
    .insert(catalogBatches)
    .values({ brandSlug: "uspa", brandName: "USPA", name: "Autumn", createdBy: "op@opptra.com" })
    .returning();
  const [b2] = await db
    .insert(catalogBatches)
    .values({
      brandSlug: "uspa",
      brandName: "USPA",
      name: "Capped",
      createdBy: "op@opptra.com",
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null, qaCapUsd: 1 },
    })
    .returning();
  batchId = b1!.id;
  cappedBatchId = b2!.id;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(spendDays);
});

describe("dailyCapFromEnv", () => {
  it("defaults to no cap and parses numbers", () => {
    expect(dailyCapFromEnv({})).toBe(Infinity);
    expect(dailyCapFromEnv({ DAILY_SPEND_CAP_USD: "2.5" })).toBe(2.5);
    expect(dailyCapFromEnv({ DAILY_SPEND_CAP_USD: "0" })).toBe(0);
  });

  it("falls back to the default for empty, invalid or negative values", () => {
    expect(dailyCapFromEnv({ DAILY_SPEND_CAP_USD: "" })).toBe(Infinity);
    expect(dailyCapFromEnv({ DAILY_SPEND_CAP_USD: "abc" })).toBe(Infinity);
    expect(dailyCapFromEnv({ DAILY_SPEND_CAP_USD: "-1" })).toBe(Infinity);
  });
});

describe("recordCost", () => {
  it("upserts per day, brand, engine and batch, adding cost and calls", async () => {
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: 0.25, day: NOW });
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: 0.5, calls: 3, day: NOW });
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: Number.NaN, day: NOW });
    const rows = await db.select().from(spendDays);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: "2026-10-02", brandSlug: "uspa", engine: "catalog_qa", costUsd: 0.75, calls: 5 });
    expect(await sumSpendForDay(db, "2026-10-02")).toBeCloseTo(0.75);
  });
});

describe("checkCaps", () => {
  it("is ok under both caps", async () => {
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: 0.5, day: NOW });
    expect(await checkCaps(db, { brandSlug: "uspa", batchId, env: {}, now: NOW })).toEqual({ ok: true });
  });

  it("refuses past the daily cap across all brands with a sentence and an action", async () => {
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: 6, day: NOW });
    await recordCost(db, { brandSlug: "penti", batchId, engine: "catalog_compute", costUsd: 3.8, day: NOW });
    expect(await checkCaps(db, { brandSlug: "uspa", batchId, env: { DAILY_SPEND_CAP_USD: "9.8" }, now: NOW })).toEqual({
      ok: false,
      reason:
        "Daily spend cap reached: $9.80 of $9.80 used this UTC day. Raise DAILY_SPEND_CAP_USD or wait for the cap to reset at midnight UTC.",
    });
  });

  it("only counts the current UTC day", async () => {
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: 50, day: new Date("2026-10-01T23:59:00Z") });
    expect((await checkCaps(db, { brandSlug: "uspa", batchId, env: { DAILY_SPEND_CAP_USD: "10" }, now: NOW })).ok).toBe(true);
  });

  it("has no daily cap when DAILY_SPEND_CAP_USD is not set", async () => {
    await recordCost(db, { brandSlug: "uspa", batchId, engine: "catalog_qa", costUsd: 500, day: NOW });
    expect(await checkCaps(db, { brandSlug: "uspa", batchId, env: {}, now: NOW })).toEqual({ ok: true });
  });

  it("refuses when the batch's QA total reaches options.qaCapUsd", async () => {
    await recordCost(db, { brandSlug: "uspa", batchId: cappedBatchId, engine: "catalog_compute", costUsd: 5, day: NOW });
    expect((await checkCaps(db, { brandSlug: "uspa", batchId: cappedBatchId, env: {}, now: NOW })).ok).toBe(true);
    await recordCost(db, { brandSlug: "uspa", batchId: cappedBatchId, engine: "catalog_qa", costUsd: 1, day: NOW });
    const r = await checkCaps(db, { brandSlug: "uspa", batchId: cappedBatchId, env: {}, now: NOW });
    expect(r).toEqual({
      ok: false,
      reason: 'Batch QA spend cap reached: $1.00 of $1.00 used by batch "Capped". Raise the batch\'s QA cap to check the remaining images.',
    });
  });
});
