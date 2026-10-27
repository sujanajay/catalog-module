// Merge-only writes to catalog_batches.counts and the placing lease (spec 14c F6).
//
// Every write to `counts` while a batch may be `ingesting` changes only the keys it names
// (`counts = counts || patch`), so a web write never loses a worker key (phase, placingClaim, rate)
// and the reverse. Use these as the value of `counts` in an UPDATE of catalog_batches.
import { sql, type SQL } from "drizzle-orm";
import { catalogBatches } from "../db/schema";
import type { BatchCounts, IntakePhase, PlacingClaim } from "./types";

/** How many progress samples `counts.rate` keeps. */
export const RATE_SAMPLES = 5;
/**
 * A new sample within this long of the one before the last replaces the last instead of being added,
 * so samples stay about this far apart however often deliveries write, and RATE_SAMPLES of them span
 * more than the 20 s `intakeTimeText` needs.
 */
export const RATE_SAMPLE_GAP_MS = 10_000;
/**
 * How long a placing claim lasts without renewal: longer than the 900 s Cloud Tasks deadline, so a live
 * delivery never loses its lease, and short enough that a dead one is taken over well within an hour.
 */
export const PLACING_LEASE_MS = 20 * 60_000;

/** `counts || patch`: only the named keys change. Keys whose value is `undefined` are left as they are. */
export function mergeCounts(patch: Partial<BatchCounts>): SQL {
  return sql`${catalogBatches.counts} || ${JSON.stringify(patch)}::jsonb`;
}

/** The counts key whose value is a phase's done count, read after the patch is merged. */
export type DoneKey = "collected" | "placed";

/**
 * A merge-only write that also records progress: `patch` is merged, `phase` is set, and a sample
 * `{ at, phase, done }` is added to `rate`. When the stored phase differs, `rate` restarts with this
 * sample (the worker clears `rate` whenever it changes phase). `done` is a number, or the key to read
 * from the row after the patch (for example "collected" after `bumpCollected` in an earlier statement).
 * At most RATE_SAMPLES samples are kept; a sample within RATE_SAMPLE_GAP_MS of the one before the last
 * replaces the last.
 */
export function progressCounts(patch: Partial<BatchCounts>, progress: { phase: IntakePhase; done: number | DoneKey; at: Date }): SQL {
  const counts = catalogBatches.counts;
  const merged = sql`(${counts} || ${JSON.stringify(patch)}::jsonb)`;
  const done = typeof progress.done === "number"
    ? sql`${Math.max(0, Math.round(progress.done))}::int`
    : sql`COALESCE((${merged}->>${sql.raw(`'${progress.done === "placed" ? "placed" : "collected"}'`)})::int, 0)`;
  const at = progress.at.toISOString();
  const sample = sql`jsonb_build_array(jsonb_build_object('at', ${at}::text, 'phase', ${progress.phase}::text, 'done', ${done}))`;
  const prev = sql`(CASE WHEN jsonb_typeof(${counts}->'rate') = 'array' THEN ${counts}->'rate' ELSE '[]'::jsonb END)`;
  const keepLast = (arr: SQL) => sql`(SELECT COALESCE(jsonb_agg(e ORDER BY i), '[]'::jsonb) FROM jsonb_array_elements(${arr}) WITH ORDINALITY AS t(e, i) WHERE i > jsonb_array_length(${arr}) - ${sql.raw(String(RATE_SAMPLES))})`;
  const rate = sql`(CASE
    WHEN ${counts}->>'phase' IS DISTINCT FROM ${progress.phase}::text THEN ${sample}
    WHEN jsonb_array_length(${prev}) >= 2 AND ${at}::timestamptz - (${prev}->-2->>'at')::timestamptz < ${sql.raw(`interval '${RATE_SAMPLE_GAP_MS} milliseconds'`)} THEN (${prev} - -1) || ${sample}
    ELSE ${keepLast(sql`(${prev} || ${sample})`)}
  END)`;
  return sql`${merged} || jsonb_build_object('phase', ${progress.phase}::text, 'rate', ${rate})`;
}

/** The token of the delivery that claims placing: the same task retried presents the same token. */
export function placingToken(run: string, uploadId: string): string {
  return `${run}:${uploadId}`;
}
/** A new or renewed claim for `token`, running PLACING_LEASE_MS from `now`. */
export function placingClaim(token: string, now: Date): PlacingClaim {
  return { token, until: new Date(now.getTime() + PLACING_LEASE_MS).toISOString() };
}
/** Whether a claim read from counts is still running at `now`. */
export function placingLeaseLive(claim: PlacingClaim | null | undefined, now: Date): boolean {
  return !!claim && new Date(claim.until).getTime() >= now.getTime();
}
/** Whether `token` holds a live claim: a delivery that does not does nothing. */
export function placingLeaseHeldBy(claim: PlacingClaim | null | undefined, token: string, now: Date): boolean {
  return placingLeaseLive(claim, now) && claim!.token === token;
}
/** WHERE condition: no claim (absent or null) or one that ran out before `now`. Combine with `status = 'ingesting'`. */
export function placingLeaseFree(now: Date): SQL {
  const claim = sql`${catalogBatches.counts}->'placingClaim'`;
  return sql`(COALESCE(jsonb_typeof(${claim}), 'null') = 'null' OR (${claim}->>'until')::timestamptz < ${now.toISOString()}::timestamptz)`;
}
/**
 * WHERE condition: the stored claim carries `token`, whether or not it ran out (another delivery that
 * took over a lapsed lease has its own token). Guards the worker's final writes (spec 14c F4 part 2).
 */
export function placingLeaseHeld(token: string): SQL {
  return sql`(${catalogBatches.counts}->'placingClaim'->>'token') = ${token}::text`;
}
