// Reads for the admin Ops page and the batch page's Details additions. Read only, and every query is
// bounded so the page cannot load the shared db-f1-micro (25 connections, web pool 2):
// - active batches: the batch statuses in flight, at most ACTIVE_LIMIT rows; chunk counts and ledger
//   totals for those batches only, through the batch_id indexes;
// - failures: the last 24 hours, at most FAILURE_LIMIT rows each;
// - cost: the core ledger queries (packages/core/src/catalog/cost-report.ts); no money SQL lives here.
// The page refreshes every 30 s. Only the active batches and failures are read on every refresh (their
// cost so far kept STAGE_TTL_MS); the cost sections are kept for COST_TTL_MS per web instance
// (rememberCost), run in a read-only transaction with a statement timeout, and lifetime brand totals are
// read only when asked for.
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks } from "@catalog/core/db/schema";
import type { BatchStatus } from "@catalog/core/catalog/types";
import { batchCostAttribution, batchCostByEngine, batchCostByStage, brandCostTotals, dayCostTotals, BRAND_REPORT_DAYS } from "@catalog/core/catalog/cost-report";
import { db, type Db } from "../db";
import { log } from "@catalog/core/log";
import { withoutModelNames } from "./redact";
import { ACTIVE_STATUSES, type ChunkCount } from "./ops-copy";

export const ACTIVE_LIMIT = 10;
export const FAILURE_LIMIT = 20;
export const RECENT_BATCH_LIMIT = 20;
export const FAILURE_WINDOW_MS = 24 * 60 * 60_000;
export const COST_TTL_MS = 5 * 60_000;
export const STAGE_TTL_MS = 60_000;

export interface ActiveBatch {
  id: string; name: string; brandName: string; status: (typeof ACTIVE_STATUSES)[number]; isTest: boolean;
  startedAt: Date | null; createdAt: Date; chunks: ChunkCount[]; usd: number;
}

/** Chunk counts per (batch, stage, status) for the given batches: one grouped query on the batch_id index. */
async function chunkCounts(conn: Db, batchIds: string[]): Promise<Map<string, ChunkCount[]>> {
  const out = new Map<string, ChunkCount[]>();
  if (!batchIds.length) return out;
  const rows = await conn
    .select({ batchId: catalogChunks.batchId, stage: catalogChunks.stage, status: catalogChunks.status, chunks: sql<string>`count(*)` })
    .from(catalogChunks)
    .where(inArray(catalogChunks.batchId, batchIds))
    .groupBy(catalogChunks.batchId, catalogChunks.stage, catalogChunks.status);
  for (const r of rows) {
    const list = out.get(r.batchId) ?? [];
    list.push({ stage: r.stage, status: r.status, chunks: Number(r.chunks) });
    out.set(r.batchId, list);
  }
  return out;
}

/** Batches in flight, the most recently moved first, with chunk progress and the running ledger total. */
export async function activeBatches(conn: Db = db(), now: Date = new Date()): Promise<ActiveBatch[]> {
  const batches = await conn
    .select({ id: catalogBatches.id, name: catalogBatches.name, brandName: catalogBatches.brandName, status: catalogBatches.status, isTest: catalogBatches.isTest, startedAt: catalogBatches.startedAt, createdAt: catalogBatches.createdAt })
    .from(catalogBatches)
    .where(inArray(catalogBatches.status, [...ACTIVE_STATUSES]))
    .orderBy(desc(catalogBatches.updatedAt))
    .limit(ACTIVE_LIMIT);
  const counts = await chunkCounts(conn, batches.map((b) => b.id));
  const out: ActiveBatch[] = [];
  // One small per-batch ledger query each (at most ACTIVE_LIMIT, kept STAGE_TTL_MS), in sequence so the page holds one connection.
  for (const b of batches) {
    const stages = await batchStageCost(b.id, conn, now);
    out.push({ ...b, status: b.status as ActiveBatch["status"], chunks: counts.get(b.id) ?? [], usd: stages.reduce((sum, s) => sum + s.usd, 0) });
  }
  return out;
}

export interface FailedBatch { id: string; name: string; brandName: string; status: BatchStatus; reason: string; at: Date }
export interface FailedChunk { batchId: string; batchName: string; index: number; stage: ChunkCount["stage"]; error: string | null; at: Date | null }

const clean = (text: string | null) => (text ? withoutModelNames(text) : text);

/**
 * Failures in the last 24 hours: batches that failed (or carry an error sentence) and chunks that gave
 * up after repeated errors. A batch whose chunk failed in the window is either still active or moved
 * after that failure, so the chunk query only looks inside those batches (batch_id index).
 */
export async function recentFailures(conn: Db = db(), now: Date = new Date()): Promise<{ batches: FailedBatch[]; chunks: FailedChunk[] }> {
  const since = new Date(+now - FAILURE_WINDOW_MS);
  const batchRows = await conn
    .select({ id: catalogBatches.id, name: catalogBatches.name, brandName: catalogBatches.brandName, status: catalogBatches.status, error: catalogBatches.error, failReason: sql<string | null>`${catalogBatches.counts}->>'failReason'`, at: catalogBatches.updatedAt })
    .from(catalogBatches)
    .where(and(gte(catalogBatches.updatedAt, since), or(eq(catalogBatches.status, "failed"), isNotNull(catalogBatches.error))))
    .orderBy(desc(catalogBatches.updatedAt))
    .limit(FAILURE_LIMIT);
  const chunkRows = await conn
    .select({ batchId: catalogChunks.batchId, batchName: catalogBatches.name, index: catalogChunks.index, stage: catalogChunks.stage, error: catalogChunks.error, at: catalogChunks.finishedAt })
    .from(catalogChunks)
    .innerJoin(catalogBatches, eq(catalogBatches.id, catalogChunks.batchId))
    .where(and(
      eq(catalogChunks.status, "failed"),
      gte(catalogChunks.finishedAt, since),
      or(gte(catalogBatches.updatedAt, since), inArray(catalogBatches.status, [...ACTIVE_STATUSES])),
    ))
    .orderBy(desc(catalogChunks.finishedAt))
    .limit(FAILURE_LIMIT);
  return {
    batches: batchRows.map((b) => ({ id: b.id, name: b.name, brandName: b.brandName, status: b.status, reason: clean(b.failReason ?? b.error) ?? "No reason was recorded.", at: b.at })),
    chunks: chunkRows.map((c) => ({ ...c, error: clean(c.error) })),
  };
}

/** The latest batches, for the batch picker in the cost section. */
export async function recentBatches(conn: Db = db()) {
  return conn.select({ id: catalogBatches.id, name: catalogBatches.name, brandName: catalogBatches.brandName })
    .from(catalogBatches).orderBy(desc(catalogBatches.createdAt)).limit(RECENT_BATCH_LIMIT);
}

/** One batch's chunk progress and its last chunk that gave up, for the Details tab. */
export async function batchChunkSummary(batchId: string, conn: Db = db()): Promise<{ counts: ChunkCount[]; lastFailed: Omit<FailedChunk, "batchName"> | null }> {
  const counts = (await chunkCounts(conn, [batchId])).get(batchId) ?? [];
  if (!counts.some((c) => c.status === "failed")) return { counts, lastFailed: null };
  const [last] = await conn
    .select({ batchId: catalogChunks.batchId, index: catalogChunks.index, stage: catalogChunks.stage, error: catalogChunks.error, at: catalogChunks.finishedAt })
    .from(catalogChunks)
    .where(and(eq(catalogChunks.batchId, batchId), eq(catalogChunks.status, "failed")))
    .orderBy(sql`${catalogChunks.finishedAt} desc nulls last`)
    .limit(1);
  return { counts, lastFailed: last ? { ...last, error: clean(last.error) } : null };
}

// Cost reads are kept per web instance so the 30 s Ops refresh and the 5 s batch page refresh do not
// re-run them: the report sections for COST_TTL_MS, a batch's cost by stage for STAGE_TTL_MS.
const remembered = new Map<string, { until: number; value: Promise<unknown> }>();
export const CACHE_MAX_ENTRIES = 50;
function rememberCost<T>(key: string, now: number, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const hit = remembered.get(key);
  if (hit && hit.until > now) return hit.value as Promise<T>;
  for (const [k, entry] of remembered) if (entry.until <= now) remembered.delete(k);
  remembered.delete(key);
  // Map keeps insertion order, so the first key is the oldest entry.
  while (remembered.size >= CACHE_MAX_ENTRIES) remembered.delete(remembered.keys().next().value!);
  const value = read();
  const entry = { until: now + ttlMs, value };
  remembered.set(key, entry);
  value.catch(() => { if (remembered.get(key) === entry) remembered.delete(key); });
  return value;
}
/** Tests only: forget the remembered cost reads. */
export function resetOpsCostCache(): void {
  remembered.clear();
}
/** Tests only: how many cost reads are remembered. */
export function opsCostCacheSize(): number {
  return remembered.size;
}

/** A batch's cost by stage (the batch page's full-cost line, the Ops page's cost so far), kept STAGE_TTL_MS. */
export function batchStageCost(batchId: string, conn: Db = db(), now: Date = new Date()) {
  return rememberCost(`stages:${batchId}`, +now, STAGE_TTL_MS, () => batchCostByStage(conn, batchId));
}

export const REPORT_STATEMENT_TIMEOUT = "10s";
/**
 * Runs report queries in one short read-only transaction whose statements stop after
 * REPORT_STATEMENT_TIMEOUT, so a slow aggregate can never hold the shared database.
 */
async function reportRead<T>(conn: Db, read: (tx: Db) => Promise<T>): Promise<T> {
  return conn.transaction(async (tx) => {
    await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${REPORT_STATEMENT_TIMEOUT}'`));
    return read(tx as unknown as Db);
  });
}

/** A report read that did not finish (statement timeout or any other failure): the page shows a plain sentence. */
export type Report<T> = { ok: true; value: T } | { ok: false };
async function report<T>(what: string, read: () => Promise<T>): Promise<Report<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    log("WARNING", "ops report read failed", { what, error: error instanceof Error ? error.message : String(error) });
    return { ok: false };
  }
}

/** Last 30 days per brand and per UTC day (kept for COST_TTL_MS). */
export function costOverview(conn: Db = db(), now: Date = new Date()) {
  return report("overview", () => rememberCost("overview", +now, COST_TTL_MS, () => reportRead(conn, async (tx) => {
    const since = new Date(+now - BRAND_REPORT_DAYS * 86_400_000);
    const brands = await brandCostTotals(tx, { since });
    const days = await dayCostTotals(tx, { days: BRAND_REPORT_DAYS, now });
    return { brands, days, readAt: now };
  })));
}

/** Lifetime per brand: reads the whole ledger, so only on demand (never on the refresh path); kept for COST_TTL_MS. */
export function lifetimeBrandCost(conn: Db = db(), now: Date = new Date()) {
  return report("lifetime", () => rememberCost("lifetime", +now, COST_TTL_MS, () => reportRead(conn, (tx) => brandCostTotals(tx))));
}

/** One batch's cost by stage, by engine and by channel, its top 10 products and images (kept for COST_TTL_MS). */
export function batchCostDetail(batchId: string, conn: Db = db(), now: Date = new Date()) {
  return report("batch", () => rememberCost(`batch:${batchId}`, +now, COST_TTL_MS, () => reportRead(conn, async (tx) => {
    const [batch] = await tx.select({ id: catalogBatches.id, name: catalogBatches.name, brandName: catalogBatches.brandName }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
    if (!batch) return null;
    const stages = await batchCostByStage(tx, batchId);
    const engines = await batchCostByEngine(tx, batchId);
    const attribution = await batchCostAttribution(tx, batchId, { top: 10 });
    return { batch, stages, engines, attribution, readAt: now };
  })));
}
