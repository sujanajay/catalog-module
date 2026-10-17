import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { handleSweep, SWEEP_ERROR, type ReleaseLocks } from "./sweep";

/**
 * Tier 2 (PGlite). Uses the real migration when it already creates the catalog tables; until
 * workstream C's 0000_init.sql is merged, it creates a minimal stand-in for the columns the sweep
 * reads and writes (names and types as in spec 02 "Database").
 */
const FALLBACK_DDL = [
  sql`CREATE TABLE catalog_batches (
    id uuid PRIMARY KEY, brand_slug text NOT NULL, brand_name text NOT NULL, name text NOT NULL,
    status text NOT NULL DEFAULT 'draft', is_test boolean NOT NULL DEFAULT false, product_type text NOT NULL DEFAULT 'auto',
    channels jsonb NOT NULL, options jsonb NOT NULL, counts jsonb NOT NULL, cost jsonb NOT NULL,
    error text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz, finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`,
  sql`CREATE TABLE catalog_chunks (
    id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES catalog_batches(id) ON DELETE CASCADE, "index" integer NOT NULL,
    stage text NOT NULL, product_ids jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
    started_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  sql`CREATE TABLE catalog_products (
    id uuid PRIMARY KEY, brand_slug text NOT NULL, is_test boolean NOT NULL, product_key text NOT NULL,
    path_key text NOT NULL, identifier text NOT NULL, lock_batch_id uuid REFERENCES catalog_batches(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
];

type Row = Record<string, unknown>;
const rows = async (db: Db, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

/** Test stand-in with the contract of `releaseLocks` from products.ts (workstream C). */
const releaseLocks: ReleaseLocks = async (db, batchId) =>
  (await rows(db, sql`UPDATE catalog_products SET lock_batch_id = NULL WHERE lock_batch_id = ${batchId} RETURNING id`)).length;

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
  const exists = await rows(db, sql`SELECT to_regclass('public.catalog_batches') AS t`);
  if (exists[0]?.t === null) for (const stmt of FALLBACK_DDL) await db.execute(stmt);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

describe("handleSweep (PGlite)", () => {
  it("fails a stale batch, releases its locks and logs one WARNING; fresh and idle batches are untouched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

    const r = await handleSweep({ db, releaseLocks, now: () => NOW }, {});
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

    // Idempotent: a second run finds nothing.
    expect(await handleSweep({ db, releaseLocks, now: () => NOW }, {})).toEqual({ httpStatus: 200, outcome: "swept:0" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses the batch's own updated_at when it has no chunks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const old = await insertBatch("ingesting", 3);
    const recent = await insertBatch("ingesting", 1);
    expect(await handleSweep({ db, releaseLocks, now: () => NOW }, {})).toEqual({ httpStatus: 200, outcome: "swept:1" });
    expect((await batch(old)).status).toBe("failed");
    expect((await batch(recent)).status).toBe("ingesting");
  });

  it("rolls the status change back when releasing locks fails", async () => {
    const stale = await insertBatch("publishing", 5);
    await insertLockedProducts(stale, 1);
    const failing: ReleaseLocks = () => Promise.reject(new Error("locks unavailable"));
    await expect(handleSweep({ db, releaseLocks: failing, now: () => NOW }, {})).rejects.toThrow("locks unavailable");
    expect((await batch(stale)).status).toBe("publishing");
    expect(await locked(stale)).toBe(1);
  });
});
