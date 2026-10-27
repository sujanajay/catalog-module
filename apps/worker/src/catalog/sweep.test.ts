import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { releaseLocks } from "@catalog/core/catalog/products";
import { createTestDb } from "@catalog/core/db/testing";
import { DEFAULT_DRAFT_EXPIRY_DAYS, draftExpiryDaysFromEnv, handleSweep, SWEEP_ERROR, type ReleaseLocks } from "./sweep";
import { EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import type { BatchCounts } from "@catalog/core/catalog/types";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";

/** Tier 2 (PGlite): the real 0000_init.sql migration (via createTestDb) and the real releaseLocks. */
type Row = Record<string, unknown>;
const rows = async (db: Db, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

const NOW = new Date("2026-10-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

let db: Db;
let close: () => Promise<void>;

async function insertBatch(status: string, updatedHoursAgo: number): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, is_test, product_type, channels, options, counts, cost, created_by, updated_at)
    VALUES (${id}, 'uspa', 'USPA', ${`batch ${id.slice(0, 4)}`}, ${status}, true, 'auto', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            'test@opptra.com', ${hoursAgo(updatedHoursAgo)}::timestamptz)`);
  return id;
}

async function insertChunk(batchId: string, index: number, startedHoursAgo: number | null, finishedHoursAgo: number | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO catalog_chunks (id, batch_id, "index", stage, product_ids, status, started_at, finished_at)
    VALUES (${randomUUID()}, ${batchId}, ${index}, 'render', '[]'::jsonb, 'running',
            ${startedHoursAgo === null ? null : hoursAgo(startedHoursAgo)}::timestamptz,
            ${finishedHoursAgo === null ? null : hoursAgo(finishedHoursAgo)}::timestamptz)`);
}

async function insertLockedProducts(batchId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const key = `P${batchId.slice(0, 8)}${i}`;
    await db.execute(sql`
      INSERT INTO catalog_products (id, brand_slug, is_test, product_key, path_key, identifier, lock_batch_id)
      VALUES (${randomUUID()}, 'uspa', true, ${key.toUpperCase()}, ${key}, ${key}, ${batchId})`);
  }
}

async function batch(id: string): Promise<Row> {
  return (await rows(db, sql`SELECT status, error FROM catalog_batches WHERE id = ${id}`))[0]!;
}

async function locked(id: string): Promise<number> {
  return Number((await rows(db, sql`SELECT count(*)::int AS n FROM catalog_products WHERE lock_batch_id = ${id}`))[0]!.n);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

describe("handleSweep (PGlite)", () => {
  it("writes the sweep sentence to counts.failReason too, so the batch page shows the reason, and keeps the other counts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stale = await insertBatch("matting", 5);
    await db.execute(sql`UPDATE catalog_batches SET counts = ${JSON.stringify({ ...EMPTY_BATCH_COUNTS, outputs: 12, verified: 3 })}::jsonb WHERE id = ${stale}`);
    const fresh = await insertBatch("matting", 0.5);
    await handleSweep({ db, enqueue: vi.fn(async () => "task"), releaseLocks, now: () => NOW }, {});
    const [row] = await rows(db, sql`SELECT status, error, counts FROM catalog_batches WHERE id = ${stale}`);
    const counts = row!.counts as BatchCounts;
    expect(row).toMatchObject({ status: "failed", error: SWEEP_ERROR });
    expect(counts).toMatchObject({ failReason: "No progress for 2 hours. Start the batch again.", outputs: 12, verified: 3 });
    // What the batch page shows for it: the reason, not only "Start the batch again."
    expect(deriveBatchState({ status: "failed", counts }).text).toBe(SWEEP_ERROR);
    const [untouched] = await rows(db, sql`SELECT counts FROM catalog_batches WHERE id = ${fresh}`);
    expect(untouched!.counts).toEqual({});
  });

  it("fails a stale batch, releases its locks and logs one WARNING; fresh and idle batches are untouched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Stale: batch row and chunks all older than 2 hours.
    const stale = await insertBatch("rendering", 5);
    await insertChunk(stale, 0, 4, 3.5);
    await insertChunk(stale, 1, 3, null);
    await insertLockedProducts(stale, 3);
    // Fresh: old batch row, but a chunk started 30 minutes ago.
    const fresh = await insertBatch("matting", 5);
    await insertChunk(fresh, 0, 0.5, null);
    await insertLockedProducts(fresh, 2);
    // Not active: old drafts and finished batches are never swept.
    const draft = await insertBatch("draft", 48);
    const done = await insertBatch("done", 48);

    const r = await handleSweep({ db, enqueue:vi.fn(async()=>"task"), releaseLocks, now: () => NOW }, {});
    expect(r).toEqual({ httpStatus: 200, outcome: "swept:1" });

    expect(await batch(stale)).toEqual({ status: "failed", error: SWEEP_ERROR });
    expect(SWEEP_ERROR).toBe("No progress for 2 hours. Start the batch again.");
    expect(await locked(stale)).toBe(0);
    expect(await batch(fresh)).toEqual({ status: "matting", error: null });
    expect(await locked(fresh)).toBe(2);
    expect((await batch(draft)).status).toBe("draft");
    expect((await batch(done)).status).toBe("done");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ severity: "WARNING", batchId: stale, releasedProducts: 3 });
    // Log contract: the swept batch also logs "batch failed" at ERROR (the alert's filter), with its reason.
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({ severity: "ERROR", message: "batch failed", batchId: stale, reason: SWEEP_ERROR, cause: "swept", "logging.googleapis.com/labels": { app: "catalog", batchId: stale } });

    // Idempotent: a second run finds nothing.
    expect(await handleSweep({ db, enqueue:vi.fn(async()=>"task"), releaseLocks, now: () => NOW }, {})).toEqual({ httpStatus: 200, outcome: "swept:0" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses the batch's own updated_at when it has no chunks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const old = await insertBatch("ingesting", 3);
    const recent = await insertBatch("ingesting", 1);
    expect(await handleSweep({ db, enqueue:vi.fn(async()=>"task"), releaseLocks, now: () => NOW }, {})).toEqual({ httpStatus: 200, outcome: "swept:1" });
    expect((await batch(old)).status).toBe("failed");
    expect((await batch(recent)).status).toBe("ingesting");
  });

  it("ignores cancelled batches, however old (spec 14c F4 part 2)", async () => {
    const cancelled = await insertBatch("cancelled", 48);
    await db.execute(sql`UPDATE catalog_batches SET counts = '{"placingClaim":{"token":"t","until":"2026-10-17T00:00:00Z"},"finalizePending":true,"finalizeEnqueuedAt":0}'::jsonb WHERE id = ${cancelled}`);
    const enqueue = vi.fn(async () => "task");
    expect(await handleSweep({ db, enqueue, releaseLocks, now: () => NOW }, {})).toEqual({ httpStatus: 200, outcome: "swept:0" });
    expect(await batch(cancelled)).toEqual({ status: "cancelled", error: null });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rolls the status change back when releasing locks fails", async () => {
    const stale = await insertBatch("publishing", 5);
    await insertLockedProducts(stale, 1);
    const failing: ReleaseLocks = () => Promise.reject(new Error("locks unavailable"));
    await expect(handleSweep({ db, enqueue:vi.fn(async()=>"task"), releaseLocks: failing, now: () => NOW }, {})).rejects.toThrow("locks unavailable");
    expect((await batch(stale)).status).toBe("publishing");
    expect(await locked(stale)).toBe(1);
  });
});

it("does not count recovery enqueue intents as progress beyond the stale deadline",async()=>{
  vi.spyOn(console,"warn").mockImplementation(()=>undefined);
  const pending=await insertBatch("publishing",3);
  await db.execute(sql`UPDATE catalog_batches SET counts='{"finalizePending":true,"finalizeEnqueuedAt":0}'::jsonb WHERE id=${pending}`);
  const enqueue=vi.fn(async()=>"task");
  expect(await handleSweep({db,releaseLocks,enqueue,now:()=>NOW},{})).toEqual({httpStatus:200,outcome:"swept:1"});
  expect(enqueue).toHaveBeenCalledWith("/tasks/catalog/finalize",{batchId:pending},{});
  expect((await batch(pending)).status).toBe("failed");
  const abandoned=await insertBatch("rendering",1);
  await insertChunk(abandoned,0,0.5,null);
  await handleSweep({db,releaseLocks,enqueue,now:()=>NOW},{});
  expect((await batch(abandoned)).status).toBe("rendering");
  expect(await handleSweep({db,releaseLocks,enqueue,now:()=>new Date(+NOW+2*3600_000)},{})).toEqual({httpStatus:200,outcome:"swept:1"});
  expect((await batch(abandoned)).status).toBe("failed");
});

describe("draft expiry (spec 14d F12)", () => {
  const day = 24;
  const expiredOf = async (id: string) => (await rows(db, sql`SELECT status, options, updated_at FROM catalog_batches WHERE id = ${id}`))[0]!;

  it("cancels a 15-day draft with options.expired, keeps a 13-day one, leaves a cancelled one alone; the list reads Expired", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const old = await insertBatch("draft", 15 * day);
    const young = await insertBatch("draft", 13 * day);
    const cancelled = await insertBatch("cancelled", 20 * day);
    const r = await handleSweep({ db, enqueue: vi.fn(async () => "task"), releaseLocks, now: () => NOW }, {});
    expect(r).toEqual({ httpStatus: 200, outcome: "swept:0; expired:1" });

    const row = await expiredOf(old);
    expect(row).toMatchObject({ status: "cancelled", options: { expired: { at: NOW.toISOString(), days: DEFAULT_DRAFT_EXPIRY_DAYS } } });
    expect((await expiredOf(young)).status).toBe("draft");
    expect(await expiredOf(cancelled)).toMatchObject({ status: "cancelled", options: {} });
    const expired = (row.options as { expired: { days: number } }).expired;
    expect(deriveBatchState({ status: "cancelled", counts: EMPTY_BATCH_COUNTS, updatedAt: NOW, now: NOW, expired }).intake).toBe("Expired after 14 days with no activity");
    expect(info.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ message: "draft expired", batchId: old, days: 14 }));

    // Idempotent: the expired draft is no longer a draft.
    expect(await handleSweep({ db, enqueue: vi.fn(async () => "task"), releaseLocks, now: () => NOW }, {})).toEqual({ httpStatus: 200, outcome: "swept:0" });
  });

  it("DRAFT_EXPIRY_DAYS sets the days; a value that is not a whole number of at least 1 keeps 14", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(draftExpiryDaysFromEnv({ DRAFT_EXPIRY_DAYS: "3" })).toBe(3);
    for (const v of [undefined, "", "0", "-2", "1.5", "two"]) expect(draftExpiryDaysFromEnv({ DRAFT_EXPIRY_DAYS: v })).toBe(14);
    const fourDays = await insertBatch("draft", 4 * day);
    await handleSweep({ db, enqueue: vi.fn(async () => "task"), releaseLocks, now: () => NOW, draftExpiryDays: 3 }, {});
    expect(await expiredOf(fourDays)).toMatchObject({ status: "cancelled", options: { expired: { days: 3 } } });
  });

  it("expires drafts even when a recovery enqueue later in the same sweep throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const old = await insertBatch("draft", 15 * day);
    const pending = await insertBatch("publishing", 1);
    await db.execute(sql`UPDATE catalog_batches SET counts='{"finalizePending":true,"finalizeEnqueuedAt":0}'::jsonb WHERE id=${pending}`);
    const enqueue = vi.fn(async () => { throw new Error("queue unavailable"); });
    await expect(handleSweep({ db, enqueue, releaseLocks, now: () => NOW }, {})).rejects.toThrow("queue unavailable");
    expect((await expiredOf(old)).status).toBe("cancelled");
  });
});
