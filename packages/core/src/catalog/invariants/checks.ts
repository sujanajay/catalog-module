// Invariants as a table, not as code (spec 17 3.1.3). Each check is a sentence about the data that must
// always be true and the SQL that returns the rows breaking it (zero rows = true). Every query returns the
// columns `id` (the offending row) and `batch_id` (its batch), so a run can be scoped to one batch.
// Adding a check is adding one object here; runInvariants (run.ts) runs, logs and counts every one.
import { sql, type SQL } from "drizzle-orm";
import { PROCESSING_STATUSES } from "../pipeline/dispatch";
import { LEGACY_UPSCALE_MIN_SCALE } from "../upscale";
import { ENLARGE_STALE_MS, ENLARGING_TASK } from "../pipeline/enlargement";

/** INFO (spec 18 lifecycle): a count for Ops, never a violation of the pipeline's rules. */
export type InvariantSeverity = "ERROR" | "WARNING" | "INFO";
/** Spec 18 lifecycle 3.8: a wanted enlargement queued this long is shown on Ops as waiting long (information only). */
export const ENLARGEMENT_WAITING_LONG_MS = 20 * 60 * 60_000;
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
    sentence: "In a batch made with the enlargement stage, no verified output is enlarged past the batch's upscaler threshold (1.0x since spec 18 quality, 1.5x before) without the upscaler (a plain resize never stands in).",
    severity: "ERROR",
    // Spec 18: batches started before the stage (no options.enlargement) kept the old silent fallback and are left as they are.
    // Spec 18 quality: the threshold is the one the batch was started with (options.enlargement.minScale, 1.0 since the
    // change); a batch from before it has none and keeps 1.5. The 1e-6 slack covers the real column's rounding.
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o JOIN catalog_batches AS b ON b.id = o.batch_id
      WHERE jsonb_typeof(b.options->'enlargement') = 'object' AND o.status = 'verified'
        AND o.scale > (CASE WHEN jsonb_typeof(b.options->'enlargement'->'minScale') = 'number'
          THEN (b.options->'enlargement'->>'minScale')::real ELSE ${LEGACY_UPSCALE_MIN_SCALE}::real END) + 1e-6
        AND NOT (o.flags @> '["upscaled"]'::jsonb)
        AND NOT (o.decision = 'use_as_is' AND o.flags @> '["enlargement_failed"]'::jsonb)`,
  },
  {
    id: "plain_accepted_outputs",
    sentence: "Outputs the operator chose to use as they are after the plain warning (a failed enlargement): counted, never an error.",
    severity: "INFO",
    // Spec 18 lifecycle 3.6, I5(a): the only way a plain image above the threshold is staged; enlarged_without_upscaler excludes these.
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o WHERE o.decision = 'use_as_is' AND o.flags @> '["enlargement_failed"]'::jsonb`,
  },
  {
    id: "parked_chunk_quiet",
    sentence: "No chunk waiting for its photos' enlargements has gone 2 hours without an enlarge delivery or a re-send (the recovery is not running).",
    severity: "WARNING",
    // Spec 18 lifecycle 3.8: every enlarge delivery of the batch and every stale re-send refresh progress_at, so this fires only when neither runs.
    sql: (now) => sql`SELECT c.id, c.batch_id FROM catalog_chunks AS c JOIN catalog_batches AS b ON b.id = c.batch_id
      WHERE b.status NOT IN ('failed', 'cancelled') AND c.status = 'queued' AND c.task_name = ${ENLARGING_TASK}
        AND coalesce(c.progress_at, c.created_at) < ${at(now)} - ${(2 * ENLARGE_STALE_MS) / 1000}::int * interval '1 second'`,
  },
  {
    id: "enlargement_waiting_long",
    sentence: "Enlargements still being made after 20 hours: information only (a long wait is normal, nothing fails for time).",
    severity: "INFO",
    sql: (now) => sql`SELECT e.id, e.batch_id FROM catalog_enlargements AS e JOIN catalog_batches AS b ON b.id = e.batch_id
      WHERE b.status NOT IN ('failed', 'cancelled') AND e.wanted AND e.status = 'queued'
        AND e.created_at < ${at(now)} - ${ENLARGEMENT_WAITING_LONG_MS / 1000}::int * interval '1 second'`,
  },
];
