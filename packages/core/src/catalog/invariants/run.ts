// Runs every invariant (checks.ts), logs one line per check and keeps the latest numbers on the batches
// (spec 17 3.1.3 to 3.1.5). Called by the sweep every 10 minutes, by the catalog-invariants job on demand
// and by the load driver for its own batch. Read only, except the three counts keys it keeps on
// catalog_batches.counts (jsonb, no migration): silentOutputs, heldSiblings, slowestChunkMs.
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { LogFields, Severity } from "../../log";
import { CHECKS, type InvariantSeverity } from "./checks";

export type InvariantLog = (severity: Severity, message: string, fields?: LogFields) => void;
/** One batch's share of a check's violations; `test` is catalog_batches.is_test (a test batch, not delivered work). */
export interface InvariantBatch { batchId: string; test: boolean; violations: number }
/**
 * `sample` is up to SAMPLE_SIZE row ids (outputs or chunks, whatever the check counts), taken from the batches with
 * the most violations first, so it can all come from one batch; `batches` names the violating
 * batches, most violations first, up to BATCH_LIST_SIZE of `batchCount`, so a violation can be reported per batch and
 * told apart as test or delivered.
 */
export interface InvariantResult { id: string; severity: InvariantSeverity; violations: number; sample: string[]; batches: InvariantBatch[]; batchCount: number }
export interface InvariantRun { counts: Record<string, number>; results: InvariantResult[] }
/** The batch counts keys this run owns. */
export const INVARIANT_COUNT_KEYS = ["silentOutputs", "heldSiblings", "slowestChunkMs"] as const;
type CountKey = (typeof INVARIANT_COUNT_KEYS)[number];
export const SAMPLE_SIZE = 5;
export const BATCH_LIST_SIZE = 20;

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] => {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
};

/** Good outputs waiting with their held product, per ended batch (informational, never a violation). */
const heldSiblingsSql = () => sql`
  SELECT o.id, o.batch_id FROM catalog_outputs AS o
  JOIN catalog_batches AS b ON b.id = o.batch_id
  JOIN catalog_batch_products AS bp ON bp.batch_id = o.batch_id AND bp.product_id = o.product_id
  WHERE b.status IN ('done', 'failed') AND o.status = 'staged' AND o.decision IS NULL AND bp.change = 'pending_attention'`;

/**
 * Runs all checks; `batchId` scopes them (and the counts written) to one batch. One log line per check:
 * message "invariant", fields id, violations, sample (up to 5 row ids), batches (the violating batches with their
 * test flag and count, most first, up to 20), batchCount and severity; the line is written at the
 * check's severity when it is violated and at INFO when it holds. Each check runs once, grouped by batch, so
 * the per-batch silentOutputs count comes from the same query as the silent_outputs check.
 */
export async function runInvariants(db: Db, log: InvariantLog, now: Date, options: { batchId?: string } = {}): Promise<InvariantRun> {
  const batchId = options.batchId ?? null;
  const byBatch = async (query: SQL) => rowsOf(await db.execute(sql`SELECT s.batch_id, coalesce(b.is_test, false) AS is_test, count(*)::int AS n, (array_agg(s.id::text ORDER BY s.id))[1:${SAMPLE_SIZE}::int] AS sample
    FROM (${query}) AS s LEFT JOIN catalog_batches AS b ON b.id = s.batch_id
    WHERE ${batchId}::uuid IS NULL OR s.batch_id = ${batchId}::uuid GROUP BY s.batch_id, b.is_test ORDER BY count(*) DESC, s.batch_id`))
    .map(r => ({ batchId: String(r.batch_id), test: r.is_test === true, n: Number(r.n), sample: ((r.sample as string[] | null) ?? []).map(String) }));
  const counts: Record<string, number> = {}, results: InvariantResult[] = [];
  const per = new Map<string, Record<CountKey, number>>();
  const put = (id: string, key: CountKey, n: number) => { const v = per.get(id) ?? { silentOutputs: 0, heldSiblings: 0, slowestChunkMs: 0 }; v[key] = n; per.set(id, v); };
  for (const check of CHECKS) {
    const rows = await byBatch(check.sql(now));
    const violations = rows.reduce((sum, r) => sum + r.n, 0), sample = rows.flatMap(r => r.sample).slice(0, SAMPLE_SIZE);
    if (check.id === "silent_outputs") for (const r of rows) put(r.batchId, "silentOutputs", r.n);
    counts[check.id] = violations;
    const batches = rows.slice(0, BATCH_LIST_SIZE).map(r => ({ batchId: r.batchId, test: r.test, violations: r.n })), batchCount = rows.length;
    results.push({ id: check.id, severity: check.severity, violations, sample, batches, batchCount });
    log(violations ? check.severity : "INFO", "invariant", { id: check.id, violations, sample, batches, batchCount, severity: check.severity });
  }
  for (const r of await byBatch(heldSiblingsSql())) put(r.batchId, "heldSiblings", r.n);
  const slowest = sql`SELECT s.batch_id, max(s.ms)::bigint AS ms FROM (
      SELECT c.batch_id, (extract(epoch FROM ${now.toISOString()}::timestamptz - c.started_at) * 1000)::bigint AS ms FROM catalog_chunks AS c WHERE c.status = 'running' AND c.started_at IS NOT NULL
    ) AS s WHERE ${batchId}::uuid IS NULL OR s.batch_id = ${batchId}::uuid GROUP BY s.batch_id`;
  for (const r of rowsOf(await db.execute(slowest))) put(String(r.batch_id), "slowestChunkMs", Math.max(0, Number(r.ms)));
  await writeBatchCounts(db, batchId, per);
  return { counts, results };
}

/** Keeps silentOutputs, heldSiblings and slowestChunkMs per batch, and puts back 0 where a number went away. */
async function writeBatchCounts(db: Db, batchId: string | null, per: Map<string, Record<CountKey, number>>) {
  // Batches that still carry a non-zero number from an earlier run.
  const stored = rowsOf(await db.execute(sql`SELECT id, counts->'silentOutputs' AS "silentOutputs", counts->'heldSiblings' AS "heldSiblings", counts->'slowestChunkMs' AS "slowestChunkMs"
    FROM catalog_batches WHERE (${batchId}::uuid IS NULL OR id = ${batchId}::uuid)
      AND (coalesce((counts->>'silentOutputs')::numeric, 0) <> 0 OR coalesce((counts->>'heldSiblings')::numeric, 0) <> 0 OR coalesce((counts->>'slowestChunkMs')::numeric, 0) <> 0)`));
  const before = new Map(stored.map(r => [String(r.id), r]));
  for (const id of before.keys()) if (!per.has(id)) per.set(id, { silentOutputs: 0, heldSiblings: 0, slowestChunkMs: 0 });
  for (const [id, want] of per) {
    const had = before.get(id);
    if (had && INVARIANT_COUNT_KEYS.every(k => Number(had[k] ?? 0) === want[k])) continue;
    await db.execute(sql`UPDATE catalog_batches SET counts = counts || ${JSON.stringify(want)}::jsonb WHERE id = ${id}::uuid`);
  }
}
