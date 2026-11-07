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

/**
 * M0-S4 (M0 F5-R4, decision D21): the graph export is stale when no run finished cleanly for this long. The export runs
 * once a day, so a fresh export is up to 24 hours old just before the next run; the 2 extra hours cover that run itself.
 */
export const EXPORT_STALE_HOURS = 26;
/**
 * M6-S2 (M6-F1-R4): the daily cost reconciliation (catalog-cost-reconcile, 06:00 UTC) is stale when its newest
 * catalog_cost_days row is older than this: a day between runs plus 6 hours for a slow or retried run.
 */
export const COST_RECONCILE_STALE_HOURS = 30;
/** M6-S2 (M6-F1-R10, M6 decision S6-8): an alert of the daily checks stays reported for this long after it was written. */
export const DAILY_ALERT_HOURS = 24;
/**
 * M0-S3 output_without_version: batches created in the last 14 days are checked (a batch stages new images within days;
 * an M1-S4 improvement runs within 72 hours of delivery), and outputs count from 30 minutes after the write path's first
 * output version (a rolling deploy's old revision may still stage a few without one).
 */
export const OUTPUT_VERSION_WINDOW_DAYS = 14;
export const OUTPUT_VERSION_GRACE_MIN = 30;
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
    sentence: "In a done or failed batch, every output held for the operator says why.",
    severity: "ERROR",
    // While a batch runs, the judge's flag leaves an output needs_attention with no reason until triage decides, after
    // the chunk's last photo (qa-stage.ts), so only a batch that has ended can break this.
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o
      JOIN catalog_batches AS b ON b.id = o.batch_id
      WHERE b.status IN ('done', 'failed') AND o.status = 'needs_attention' AND coalesce(btrim(o.reason), '') = ''`,
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
      WHERE b.status = 'done' AND c.status NOT IN ('done', 'failed')
        -- Work re-opened after the batch finished (Try again, an M1-S4 improvement) is expected; a stuck one shows in
        -- parked_chunk_quiet and enlargement_waiting_long.
        AND NOT (b.finished_at IS NOT NULL AND GREATEST(c.created_at, c.dispatched_at) > b.finished_at)`,
  },
  {
    id: "enlarged_without_upscaler",
    sentence: "In a batch made with the enlargement stage, no verified output is enlarged past the batch's upscaler threshold (1.0x since spec 18 quality, 1.5x before) without the upscaler (a plain resize never stands in).",
    severity: "ERROR",
    // M1-F3-R1: an auto-decide rule may deliver the plain render of a failed enlargement, flagged provisional (the
    // improvement task re-tries the enlargement later); like an operator "Use as is", that is not a silent fallback.
    // IS NOT DISTINCT FROM: with a null decision `=` gives null and NOT null drops the row, which hid every undecided
    // plain render (found in M1-S3).
    // Spec 18: batches started before the stage (no options.enlargement) kept the old silent fallback and are left as they are.
    // Spec 18 quality: the threshold is the one the batch was started with (options.enlargement.minScale, 1.0 since the
    // change); a batch from before it has none and keeps 1.5. The 1e-6 slack covers the real column's rounding.
    sql: () => sql`SELECT o.id, o.batch_id FROM catalog_outputs AS o JOIN catalog_batches AS b ON b.id = o.batch_id
      WHERE jsonb_typeof(b.options->'enlargement') = 'object' AND o.status = 'verified'
        AND o.scale > (CASE WHEN jsonb_typeof(b.options->'enlargement'->'minScale') = 'number'
          THEN (b.options->'enlargement'->>'minScale')::real ELSE ${LEGACY_UPSCALE_MIN_SCALE}::real END) + 1e-6
        AND NOT (o.flags @> '["upscaled"]'::jsonb)
        AND NOT (o.decision IS NOT DISTINCT FROM 'use_as_is' AND o.flags @> '["enlargement_failed"]'::jsonb)
        AND NOT (o.flags @> '["provisional", "enlargement_failed"]'::jsonb)`,
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
  {
    id: "graph_export_stale",
    sentence: "The catalog graph export to BigQuery (catalog_os) finished cleanly in the last 26 hours, once it has run at all.",
    severity: "WARNING",
    // One row (the latest run) when no run finished without an error inside the window and some run started before it,
    // so a first run gets its window and a job that was never set up is not reported. Not a batch's problem: batch_id null.
    sql: (now) => sql`SELECT r.id, NULL::uuid AS batch_id FROM (
        SELECT id FROM catalog_graph_export_runs ORDER BY started_at DESC, id DESC LIMIT 1
      ) AS r
      WHERE NOT EXISTS (SELECT 1 FROM catalog_graph_export_runs AS f
          WHERE f.finished_at IS NOT NULL AND f.error IS NULL AND f.finished_at > ${at(now)} - ${EXPORT_STALE_HOURS}::int * interval '1 hour')
        AND EXISTS (SELECT 1 FROM catalog_graph_export_runs AS o WHERE o.started_at <= ${at(now)} - ${EXPORT_STALE_HOURS}::int * interval '1 hour')`,
  },
  {
    id: "cost_reconcile_stale",
    sentence: "The daily cost check (catalog-cost-reconcile) finished a run in the last 30 hours, or the cost ledger is younger than that.",
    severity: "WARNING",
    // A run writes all its rows in one transaction at the end (the shared database line at least), so the newest
    // computed_at is the last run that finished; a run that fails part-way writes nothing. One row (the newest) when it
    // is too old. Before any run: one row (the oldest ledger row) once the ledger is older than 30 hours, so a job that
    // never ran or never finished is reported too. Not a batch's problem: batch_id null.
    sql: (now) => sql`SELECT d.id::text AS id, NULL::uuid AS batch_id FROM (
        SELECT id, computed_at FROM catalog_cost_days ORDER BY computed_at DESC, id DESC LIMIT 1
      ) AS d
      WHERE d.computed_at < ${at(now)} - ${COST_RECONCILE_STALE_HOURS}::int * interval '1 hour'
      UNION ALL
      SELECT e.id::text AS id, NULL::uuid AS batch_id FROM (
        SELECT id, at FROM catalog_cost_events ORDER BY at ASC, id ASC LIMIT 1
      ) AS e
      WHERE NOT EXISTS (SELECT 1 FROM catalog_cost_days)
        AND e.at < ${at(now)} - ${COST_RECONCILE_STALE_HOURS}::int * interval '1 hour'`,
  },
  {
    id: "daily_check_alert",
    sentence: "The daily checks (cost against the bill, labels and prices, the 7-day batch success rate) raised no alert in the last 24 hours.",
    severity: "WARNING",
    // The catalog-cost-reconcile job writes each alert once as an `alert` incident; this line carries them to email
    // (policy 16), because log alerts read Cloud Run services only, never jobs (infra/monitoring.sh).
    sql: (now) => sql`SELECT i.id, NULL::uuid AS batch_id FROM catalog_incidents AS i
      WHERE i.kind = 'alert' AND i.created_at > ${at(now)} - ${DAILY_ALERT_HOURS}::int * interval '1 hour'`,
  },
  {
    id: "output_without_version",
    sentence: "Every image staged or delivered since the graph write path shipped names its content version (M0-F2-R8).",
    severity: "ERROR",
    // "Since it shipped" (review 2 P2-1): the write path shipped at the first M3 version of the first batch it ran on.
    // Every output of a batch created at least OUTPUT_VERSION_GRACE_MIN after that is counted, whenever its row was made
    // (the matte stage makes the rows before any render writes a version), and in older batches every output row made
    // after it. Outputs a pre-M0-S3 revision staged (also during a rolling deploy) are not counted. Bounded for the
    // 10-minute sweep (review P2-3): the first batch is found by index probes over the small catalog_batches table (one
    // EXISTS per batch made before it), its first version by the batch_id index, and only outputs of batches created in
    // the last OUTPUT_VERSION_WINDOW_DAYS are read, through their batch_id index.
    sql: (now) => sql`WITH first_batch AS (
        SELECT b.id FROM catalog_batches AS b
        WHERE EXISTS (SELECT 1 FROM catalog_content_versions AS v WHERE v.batch_id = b.id AND v.producer = 'M3')
        ORDER BY b.created_at, b.id LIMIT 1
      ), shipped AS (
        SELECT min(v.created_at) + ${OUTPUT_VERSION_GRACE_MIN}::int * interval '1 minute' AS at
        FROM catalog_content_versions AS v JOIN first_batch AS f ON v.batch_id = f.id WHERE v.producer = 'M3'
      )
      SELECT o.id, o.batch_id FROM shipped AS s
      JOIN catalog_batches AS b ON b.created_at > ${at(now)} - ${OUTPUT_VERSION_WINDOW_DAYS}::int * interval '1 day'
      JOIN catalog_outputs AS o ON o.batch_id = b.id
      WHERE s.at IS NOT NULL AND (b.created_at >= s.at OR o.created_at >= s.at)
        AND o.content_version_id IS NULL AND o.staging_uri IS NOT NULL AND o.status IN ('staged', 'needs_attention', 'verified')`,
  },
];
