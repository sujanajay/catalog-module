// Invariants as a table, not as code (spec 17 3.1.3). Each check is a sentence about the data that must
// always be true and the SQL that returns the rows breaking it (zero rows = true). Every query returns the
// columns `id` (the offending row) and `batch_id` (its batch), so a run can be scoped to one batch.
// Adding a check is adding one object here; runInvariants (run.ts) runs, logs and counts every one.
import { sql, type SQL } from "drizzle-orm";
import { PROCESSING_STATUSES } from "../pipeline/dispatch";
import { DEFAULT_UPSCALE_MIN_SCALE } from "../upscale";

export type InvariantSeverity = "ERROR" | "WARNING";
export interface InvariantCheck {
  id: string;
  sentence: string;
  severity: InvariantSeverity;
  /** Rows that violate the sentence at `now`, with the columns id and batch_id. */
  sql: (now: Date) => SQL;
}

/** A running chunk whose lease ended more than this long ago should have been recovered by the sweep. */
export const STALE_LEASE_MS = 5 * 60_000;
/** A running chunk is slow when it ran longer than SLOW_CHUNK_FACTOR x its batch's median finished chunk and SLOW_CHUNK_MIN_MS. */
export const SLOW_CHUNK_FACTOR = 3;
export const SLOW_CHUNK_MIN_MS = 10 * 60_000;

const at = (now: Date) => sql`${now.toISOString()}::timestamptz`;

/** Chunk checks look only at batches still processing; a swept or cancelled batch's abandoned chunk is not slow work. */
const processing = sql.join(PROCESSING_STATUSES.map(s => sql`${s}`), sql`, `);

export const CHECKS: readonly InvariantCheck[] = [
  {
    id: "silent_outputs",
    sentence: "A done or failed batch has no output left pending, no output failed without a reason, and no output staged without a decision unless its product is held for the operator.",
    severity: "ERROR",
    // Kept in step with classifyOutputs (load/classify.ts); a parity test runs both on the same rows.
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o
      JOIN catalog_batches AS b ON b.id = o.batch_id
      LEFT JOIN catalog_batch_products AS bp ON bp.batch_id = o.batch_id AND bp.product_id = o.product_id
      WHERE b.status IN ('done', 'failed')
        AND (o.status = 'pending'
          OR (o.status = 'failed' AND coalesce(btrim(o.reason), '') = '')
          OR (o.status = 'staged' AND o.decision IS NULL AND coalesce(bp.change, '') <> 'pending_attention'))`,
  },
  {
    id: "held_without_reason",
    sentence: "Every output held for the operator says why.",
    severity: "ERROR",
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o WHERE o.status = 'needs_attention' AND coalesce(btrim(o.reason), '') = ''`,
  },
  {
    id: "stale_running_chunk",
    sentence: "No running chunk has a lease that ended more than 5 minutes ago (the sweep recovers it).",
    severity: "WARNING",
    sql: (now) => sql`SELECT c.id, c.batch_id FROM catalog_chunks AS c JOIN catalog_batches AS b ON b.id = c.batch_id
      WHERE b.status IN (${processing}) AND c.status = 'running' AND c.lease_until < ${at(now)} - ${STALE_LEASE_MS / 1000}::int * interval '1 second'`,
  },
  {
    id: "slow_chunk",
    sentence: "No running chunk has run longer than 3 times its batch's median finished chunk and more than 10 minutes.",
    severity: "WARNING",
    sql: (now) => sql`SELECT c.id, c.batch_id FROM catalog_chunks AS c
      JOIN (
        SELECT f.batch_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f.finished_at - f.started_at)) AS median_s
        FROM catalog_chunks AS f
        WHERE f.status = 'done' AND f.started_at IS NOT NULL AND f.finished_at IS NOT NULL
        GROUP BY f.batch_id
      ) AS m ON m.batch_id = c.batch_id
      JOIN catalog_batches AS b ON b.id = c.batch_id
      WHERE b.status IN (${processing}) AND c.status = 'running' AND c.started_at IS NOT NULL
        AND extract(epoch FROM ${at(now)} - c.started_at) > greatest(${SLOW_CHUNK_FACTOR}::numeric * m.median_s, ${SLOW_CHUNK_MIN_MS / 1000}::numeric)`,
  },
  {
    id: "done_batch_with_open_chunk",
    sentence: "A done batch has every chunk done or failed.",
    severity: "ERROR",
    sql: () => sql`SELECT c.id, c.batch_id FROM catalog_chunks AS c JOIN catalog_batches AS b ON b.id = c.batch_id
      WHERE b.status = 'done' AND c.status NOT IN ('done', 'failed')`,
  },
  {
    id: "enlarged_without_upscaler",
    sentence: "In a batch made with the enlargement stage, no verified output is enlarged more than 1.5x without the upscaler (a plain resize never stands in).",
    severity: "ERROR",
    // Spec 18: batches started before the stage (no options.enlargement) kept the old silent fallback and are left as they are.
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o JOIN catalog_batches AS b ON b.id = o.batch_id
      WHERE jsonb_typeof(b.options->'enlargement') = 'object' AND o.status = 'verified'
        AND o.scale > ${DEFAULT_UPSCALE_MIN_SCALE}::real AND NOT (o.flags @> '["upscaled"]'::jsonb)`,
  },
];
