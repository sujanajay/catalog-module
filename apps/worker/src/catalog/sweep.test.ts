import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { releaseLocks } from "@catalog/core/catalog/products";
import { createTestDb } from "@catalog/core/db/testing";
import { handleSweep, SWEEP_ERROR, type ReleaseLocks } from "./sweep";

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
