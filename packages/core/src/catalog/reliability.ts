// M6-S6 batch success tracking (docs/program/requirements/M6-reliability-cost.md M6-F3). The only writer of
// catalog_batch_outcomes, catalog_incidents, catalog_batch_touches and catalog_revisions, and the reads of the Ops
// reliability card.
// - Incidents (F3-R2) are found by the sweep every 10 minutes (syncIncidents): a batch with no progress (a stall, the
//   one incident with a resolution time), a failed batch, a chunk that gave up after its retries, an ERROR invariant.
//   Writes are keyed (dedupe_key), so a repeated sweep writes nothing twice.
// - Touches (F3-R3) are written by the web API layer after an operator write that counts (TOUCH_ACTIONS) succeeded.
// - Outcomes (F3-R1) are written at finalize and refreshed by the sweep for batches that ended in the last 24 hours,
//   so a failed or cancelled batch, and an incident or touch that lands after finalize, are counted.
// No function here throws into its caller's work: the callers wrap them (finalize, the sweep, the API routes).
import { and, count, countDistinct, desc, eq, gte, inArray, isNotNull, isNull, min, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  BATCH_OUTCOME_STATUSES,
  catalogBatches,
  catalogBatchOutcomes,
  catalogBatchProducts,
  catalogBatchTouches,
  catalogIncidents,
  catalogOutputs,
  catalogRevisions,
  type BatchOutcomeStatus,
  type IncidentKind,
  type IncidentSeverity,
  type TouchAction,
} from "../db/schema";
import { isBulkBatch } from "./pipeline/dispatch";
import { ENLARGING_TASK } from "./pipeline/enlargement";
import { CPU_UPSCALER_SUFFIX } from "./upscale";
import type { InvariantResult } from "./invariants/run";

/** A processing batch with no progress for this long has a stall incident (the M6 section 5 "taking longer" point). */
export const STALL_INCIDENT_MS = 10 * 60_000;
/** A collecting batch gets longer: grouping a large intake can run for minutes without a row moving (the re-send point). */
export const INGEST_STALL_INCIDENT_MS = 30 * 60_000;
/** A cancel this soon after start is a mistake, not a failure: recorded and left out of the rate (M6-F3 edge cases). */
export const QUICK_CANCEL_MS = 10 * 60_000;
/** How far back the sweep looks for failed batches and chunks, and for outcomes to refresh. */
export const SCAN_WINDOW_MS = 24 * 60 * 60_000;
/** At most this many rows per scan and sweep (the sweep runs every 10 minutes; a backlog drains over a few runs). */
export const SCAN_LIMIT = 100;
/** The success target (M6-F3 admin configuration default 99%); the card marks a rate under it. */
export const SUCCESS_TARGET = 0.99;
/** The windows of the success rate (M6-F3-R5). */
export const RATE_WINDOWS_DAYS = [7, 30] as const;
/** How many recent batch outcomes the card lists, with their touches and incidents (M6-F3 acceptance test 1). */
export const RECENT_OUTCOMES = 15;
/** The batch statuses the stall check looks at (the sweep's SWEEPABLE_STATUSES). */
export const STALL_STATUSES = ["ingesting", "matting", "rendering", "qa", "publishing"] as const;
const DAY_MS = 86_400_000;
const CAUSE_MAX = 500;

type Row = Record<string, unknown>;
function rowsOf(result: unknown): Row[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}
const dateOf = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

export interface IncidentInput {
  kind: IncidentKind;
  severity: IncidentSeverity;
  batchId: string | null;
  causeCode: string;
  cause: string;
  startedAt: Date;
  /** Set for a one-off event (written already resolved); absent for a state incident that the sweep resolves. */
  resolvedAt?: Date;
  dedupeKey: string;
  detail?: Record<string, unknown>;
}

/**
 * Writes one incident unless its key is taken (ON CONFLICT DO NOTHING). `repeat_of` is the latest earlier incident of
 * the same kind and cause code. Returns the new id, or null when the incident was already there.
 */
export async function openIncident(db: Db, input: IncidentInput): Promise<string | null> {
  const prior = sql`(SELECT p.id FROM catalog_incidents AS p WHERE p.kind = ${input.kind} AND p.cause_code = ${input.causeCode}
    AND p.started_at <= ${input.startedAt.toISOString()}::timestamptz AND p.dedupe_key <> ${input.dedupeKey}
    ORDER BY p.started_at DESC LIMIT 1)`;
  const [row] = await db.insert(catalogIncidents).values({
    kind: input.kind, severity: input.severity, batchId: input.batchId, causeCode: input.causeCode,
    cause: input.cause.slice(0, CAUSE_MAX), startedAt: input.startedAt, resolvedAt: input.resolvedAt ?? null,
    dedupeKey: input.dedupeKey, detail: input.detail ?? null, repeatOf: prior,
  }).onConflictDoNothing({ target: catalogIncidents.dedupeKey }).returning({ id: catalogIncidents.id });
  return row?.id ?? null;
}

/** Resolves open incidents at `now`; the id is appended to each key so the next incident of the same subject can open. */
export async function resolveIncidents(db: Db, ids: readonly string[], now: Date): Promise<number> {
  if (!ids.length) return 0;
  const done = await db.update(catalogIncidents)
    .set({ resolvedAt: now, dedupeKey: sql`${catalogIncidents.dedupeKey} || ':' || ${catalogIncidents.id}::text` })
    .where(and(inArray(catalogIncidents.id, [...ids]), isNull(catalogIncidents.resolvedAt)))
    .returning({ id: catalogIncidents.id });
  return done.length;
}

export const stallKey = (batchId: string) => `stall:${batchId}`;
export const batchFailedKey = (batchId: string, run: string) => `batch_failed:${batchId}:${run}`;
/** Keyed by the finish time: a chunk retried after an attempt reset that gives up again is a second event. */
export const chunkGaveUpKey = (chunkId: string, finishedAt: Date) => `chunk_gave_up:${chunkId}:${+finishedAt}`;
export const invariantKey = (checkId: string, batchId: string | null) => `invariant:${checkId}:${batchId ?? "none"}`;

/** The run a failure belongs to: a started batch fails once; before Start each hand-off (Fix and continue) is a new run. */
export function failedRun(batch: { startedAt: Date | null; counts: unknown }): string {
  if (batch.startedAt) return "started";
  const run = (batch.counts as { ingestRun?: unknown } | null)?.ingestRun;
  return typeof run === "string" && run ? run : "intake";
}

const STALL_SENTENCES: Record<string, string> = {
  enlarge_wait: "No progress: photos are waiting for the enlargement service.",
  ingest_stalled: "No progress while collecting the files.",
  no_progress: "No progress on any photo.",
};

/**
 * The open stall incidents of batches that moved again (or ended) are resolved; batches with none open get one.
 *
 * Progress is completed work, never a retry (review P1-1): the batch's start, its chunks' start and finish, the photo
 * progress stamp of a chunk that is not parked on an enlargement (enlarge.ts refreshLaneProgress stamps parked chunks on
 * every delivery, also one that fails because the upscaler is down), its enlargements asked for (a photo reached the
 * enlarge step) and settled, and its finalize
 * (a re-check part hands on with a new `finalizeEnqueuedAt`; a live finalize claim is progress now). The batch row's
 * `updated_at` counts only while collecting, where the intake writes are the only signal; after Start, writes such as
 * the progress counts move it without any work done (review 2 P1-R). A parked batch queued behind other batches'
 * enlargements that settle is waiting its turn, not stalled: the latest settled enlargement on the same lane (operator
 * or bulk, isBulkBatch) and the same upscaler service (CPU or GPU) as one of its waiting rows counts as its progress,
 * so a GPU outage is not hidden by CPU rows or the other lane moving (review 2 P2-A).
 */
async function syncStalls(db: Db, now: Date): Promise<{ opened: number; resolved: number }> {
  const statuses = sql.join(STALL_STATUSES.map((s) => sql`${s}`), sql`, `);
  const ms = (key: string) => sql`CASE WHEN coalesce(b.counts->>${key}, '') ~ '^[0-9]+$' THEN (b.counts->>${key})::numeric END`;
  const batches = rowsOf(await db.execute(sql`
    SELECT b.id, b.status, b.is_test, b.name, b.counts,
      -- No work signal at all (a row with no start, chunk or photo): its own updated_at, so it still stalls.
      COALESCE(GREATEST(CASE WHEN b.status = 'ingesting' THEN b.updated_at END, b.started_at,
        (SELECT max(GREATEST(c.started_at, c.finished_at,
            CASE WHEN c.status = 'queued' AND c.task_name = ${ENLARGING_TASK} THEN NULL ELSE c.progress_at END))
          FROM catalog_chunks AS c WHERE c.batch_id = b.id),
        (SELECT max(GREATEST(e.created_at, CASE WHEN e.status IN ('done', 'failed') THEN e.updated_at END)) FROM catalog_enlargements AS e WHERE e.batch_id = b.id),
        to_timestamp(${ms("finalizeEnqueuedAt")} / 1000.0)
      ), b.updated_at) AS progress_at,
      coalesce(${ms("finalizeClaimUntil")} > ${+now}, false) AS finalizing,
      EXISTS (SELECT 1 FROM catalog_chunks AS c WHERE c.batch_id = b.id AND c.status = 'queued' AND c.task_name = ${ENLARGING_TASK}) AS parked
    FROM catalog_batches AS b WHERE b.status IN (${statuses})`));
  // Per batch and upscaler service (CPU ids end in "+cpu"): its latest settled row, and whether a row still waits.
  const cpu = sql`(e.upscaler LIKE ${`%${CPU_UPSCALER_SUFFIX}`})`;
  const services = rowsOf(await db.execute(sql`
    SELECT e.batch_id, ${cpu} AS cpu, max(e.updated_at) FILTER (WHERE e.status IN ('done', 'failed')) AS settled_at,
      bool_or(e.status NOT IN ('done', 'failed')) AS waiting
    FROM catalog_enlargements AS e INNER JOIN catalog_batches AS b ON b.id = e.batch_id
    WHERE b.status IN (${statuses}) GROUP BY 1, 2`));
  type ClassFields = Parameters<typeof isBulkBatch>[0];
  const bulk = new Map(batches.map((b) => [String(b.id), isBulkBatch({ isTest: b.is_test === true, name: String(b.name ?? ""), counts: (b.counts ?? null) as ClassFields["counts"] })]));
  const laneOf = (batchId: string, isCpu: unknown) => `${bulk.get(batchId) ? "bulk" : "operator"}:${isCpu === true ? "cpu" : "gpu"}`;
  const laneSettled = new Map<string, number>();
  for (const s of services) {
    const at = dateOf(s.settled_at ?? null), lane = laneOf(String(s.batch_id), s.cpu);
    if (at && +at > (laneSettled.get(lane) ?? 0)) laneSettled.set(lane, +at);
  }
  const stalled = new Set<string>();
  let opened = 0;
  for (const b of batches) {
    const id = String(b.id), ownProgress = dateOf(b.progress_at);
    if (!ownProgress || b.finalizing === true) continue;
    const parked = b.parked === true;
    const lanes = parked ? services.filter((s) => String(s.batch_id) === id && s.waiting === true).map((s) => laneSettled.get(laneOf(id, s.cpu)) ?? 0) : [];
    const progressAt = new Date(Math.max(+ownProgress, ...lanes));
    const ingesting = b.status === "ingesting";
    if (+now - +progressAt < (ingesting ? INGEST_STALL_INCIDENT_MS : STALL_INCIDENT_MS)) continue;
    stalled.add(id);
    const code = parked ? "enlarge_wait" : ingesting ? "ingest_stalled" : "no_progress";
    if (await openIncident(db, { kind: "stall", severity: "warning", batchId: id, causeCode: code, cause: STALL_SENTENCES[code]!, startedAt: ownProgress, dedupeKey: stallKey(id), detail: { status: b.status } })) opened++;
  }
  const open = await db.select({ id: catalogIncidents.id, batchId: catalogIncidents.batchId }).from(catalogIncidents)
    .where(and(eq(catalogIncidents.kind, "stall"), isNull(catalogIncidents.resolvedAt)));
  const resolved = await resolveIncidents(db, open.filter((o) => !o.batchId || !stalled.has(o.batchId)).map((o) => o.id), now);
  return { opened, resolved };
}

/** One open incident per ERROR check and batch while it is violated; resolved on the first run that finds it clean. */
async function syncInvariants(db: Db, results: readonly InvariantResult[], now: Date): Promise<{ opened: number; resolved: number }> {
  const current = new Set<string>();
  let opened = 0;
  for (const r of results) {
    if (r.severity !== "ERROR" || r.violations <= 0) continue;
    const subjects = r.batches.length ? r.batches.map((b) => ({ batchId: b.batchId, violations: b.violations })) : [{ batchId: null, violations: r.violations }];
    for (const s of subjects) {
      const key = invariantKey(r.id, s.batchId);
      current.add(key);
      if (await openIncident(db, { kind: "invariant", severity: "error", batchId: s.batchId, causeCode: r.id, cause: `Check ${r.id} found ${s.violations} problem${s.violations === 1 ? "" : "s"}.`, startedAt: now, dedupeKey: key, detail: { violations: s.violations, sample: r.sample } })) opened++;
    }
  }
  const open = await db.select({ id: catalogIncidents.id, key: catalogIncidents.dedupeKey }).from(catalogIncidents)
    .where(and(eq(catalogIncidents.kind, "invariant"), isNull(catalogIncidents.resolvedAt)));
  const resolved = await resolveIncidents(db, open.filter((o) => !current.has(o.key)).map((o) => o.id), now);
  return { opened, resolved };
}

/** Failed batches and chunks that gave up in the scan window, each one event written already resolved. */
async function recordFailures(db: Db, now: Date): Promise<number> {
  const since = new Date(+now - SCAN_WINDOW_MS);
  let opened = 0;
  const batches = await db.select({ id: catalogBatches.id, error: catalogBatches.error, startedAt: catalogBatches.startedAt, updatedAt: catalogBatches.updatedAt, counts: catalogBatches.counts })
    .from(catalogBatches).where(and(eq(catalogBatches.status, "failed"), gte(catalogBatches.updatedAt, since))).orderBy(desc(catalogBatches.updatedAt)).limit(SCAN_LIMIT);
  for (const b of batches) {
    const run = failedRun(b);
    if (await openIncident(db, { kind: "batch_failed", severity: "error", batchId: b.id, causeCode: b.startedAt ? "failed_after_start" : "failed_before_start", cause: b.error ?? "The batch stopped.", startedAt: b.updatedAt, resolvedAt: b.updatedAt, dedupeKey: batchFailedKey(b.id, run) })) opened++;
  }
  const chunks = rowsOf(await db.execute(sql`
    SELECT c.id, c.batch_id, c.stage, c.attempt, c.error, c.finished_at FROM catalog_chunks AS c
    WHERE c.status = 'failed' AND c.finished_at >= ${since.toISOString()}::timestamptz ORDER BY c.finished_at DESC LIMIT ${SCAN_LIMIT}`));
  for (const c of chunks) {
    const at = dateOf(c.finished_at) ?? now;
    if (await openIncident(db, { kind: "chunk_gave_up", severity: "error", batchId: String(c.batch_id), causeCode: String(c.stage), cause: c.error ? String(c.error) : "A group of photos stopped after repeated errors.", startedAt: at, resolvedAt: at, dedupeKey: chunkGaveUpKey(String(c.id), at), detail: { attempt: Number(c.attempt) } })) opened++;
  }
  return opened;
}

export interface IncidentSync { opened: number; resolved: number }

/**
 * The sweep's incident pass (M6-F3-R2): stalls, failed batches and chunks, and (when the run's results are given) the
 * ERROR invariants. Each part is independent; a part that throws is reported in `errors` and the rest still run.
 */
export async function syncIncidents(db: Db, now: Date, options: { invariants?: readonly InvariantResult[] } = {}): Promise<IncidentSync & { errors: string[] }> {
  const out = { opened: 0, resolved: 0, errors: [] as string[] };
  const parts: [string, () => Promise<Partial<IncidentSync> | number>][] = [
    ["stalls", () => syncStalls(db, now)],
    ["failures", () => recordFailures(db, now)],
    ...(options.invariants ? [["invariants", () => syncInvariants(db, options.invariants!, now)] as [string, () => Promise<IncidentSync>]] : []),
  ];
  for (const [name, run] of parts) {
    try {
      const r = await run();
      if (typeof r === "number") out.opened += r;
      else { out.opened += r.opened ?? 0; out.resolved += r.resolved ?? 0; }
    } catch (error) {
      out.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

/** M6-F3-R3: one touch. `outputId` alone finds its batch. Returns false when the batch or output does not exist. */
export async function recordTouch(db: Db, touch: { action: TouchAction; batchId?: string; outputId?: string }, now: Date = new Date()): Promise<boolean> {
  let batchId = touch.batchId ?? null;
  if (!batchId && touch.outputId) {
    const [output] = await db.select({ batchId: catalogOutputs.batchId }).from(catalogOutputs).where(eq(catalogOutputs.id, touch.outputId));
    batchId = output?.batchId ?? null;
  }
  if (!batchId) return false;
  const [batch] = await db.select({ id: catalogBatches.id }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) return false;
  await db.insert(catalogBatchTouches).values({ batchId, outputId: touch.outputId ?? null, action: touch.action, at: now });
  return true;
}

/** M6-F3-R1 `deploy_overlap`: a revision registers itself when its instance starts; a second start is a no-op. */
export async function registerRevision(db: Db, service: string, revision: string, now: Date = new Date()): Promise<void> {
  await db.insert(catalogRevisions).values({ revision, service, firstSeenAt: now }).onConflictDoNothing({ target: catalogRevisions.revision });
}

let ownRevisionRegistered = false;
/**
 * Registers this process's Cloud Run revision (K_REVISION, K_SERVICE) once per process; no-op off Cloud Run. Never
 * throws: a failed write is passed to `onError` once and not tried again in this process (no log flood on a hot path).
 */
export async function registerOwnRevision(db: () => Db, env: NodeJS.ProcessEnv = process.env, onError: (error: unknown) => void = () => undefined): Promise<void> {
  if (ownRevisionRegistered || !env.K_REVISION) return;
  ownRevisionRegistered = true;
  try { await registerRevision(db(), env.K_SERVICE ?? "unknown", env.K_REVISION); }
  catch (error) { onError(error); }
}

export type BatchOutcome = typeof catalogBatchOutcomes.$inferSelect;

/**
 * Writes (or rewrites) the outcome row of a batch that reached an end. A cancelled batch that was never handed on (an
 * expired draft) gets none. `links_ready_at` keeps the first time the batch was done; `true_cost_usd` is left to the
 * reconciliation. Returns the row written, or null.
 */
export async function recordBatchOutcome(db: Db, batchId: string, now: Date = new Date()): Promise<BatchOutcome | null> {
  const [b] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!b || !(BATCH_OUTCOME_STATUSES as readonly string[]).includes(b.status)) return null;
  const status = b.status as BatchOutcomeStatus;
  // A draft never handed on, and any draft the sweep expired (handed on or not), is not a batch run: no row.
  if (status === "cancelled" && ((b.options as { expired?: unknown }).expired || (!b.startedAt && !(b.counts as { ingestRun?: unknown }).ingestRun))) return null;
  const [existing] = await db.select({ linksReadyAt: catalogBatchOutcomes.linksReadyAt }).from(catalogBatchOutcomes).where(eq(catalogBatchOutcomes.batchId, batchId));
  const [touches] = await db.select({ n: count() }).from(catalogBatchTouches).where(eq(catalogBatchTouches.batchId, batchId));
  const [incidents] = await db.select({ n: count() }).from(catalogIncidents).where(eq(catalogIncidents.batchId, batchId));
  const [products] = await db.select({ n: count() }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId));
  const [links] = await db.select({ n: countDistinct(catalogOutputs.productId), first: min(catalogOutputs.publishedAt) }).from(catalogOutputs)
    .where(and(eq(catalogOutputs.batchId, batchId), isNotNull(catalogOutputs.publishedAt)));
  const start = b.startedAt ?? b.createdAt;
  const endedAt = status === "done" ? (b.finishedAt ?? now) : b.updatedAt;
  const linksReadyAt = status === "done" ? (existing?.linksReadyAt ?? b.finishedAt ?? now) : (existing?.linksReadyAt ?? null);
  const [overlap] = await db.select({ n: count() }).from(catalogRevisions)
    .where(sql`${catalogRevisions.firstSeenAt} > ${start.toISOString()}::timestamptz AND ${catalogRevisions.firstSeenAt} <= ${endedAt.toISOString()}::timestamptz`);
  const touchCount = Number(touches?.n ?? 0), incidentCount = Number(incidents?.n ?? 0);
  const success = status === "done" && touchCount === 0 && incidentCount === 0;
  const row = {
    batchId, status, success,
    cause: success ? null : status !== "done" ? status : touchCount ? "touched" : "incident",
    isTest: b.isTest,
    // Out of the rate (review P2-1): a batch that never started (intake failed or cancelled before Start), and a cancel
    // within QUICK_CANCEL_MS of start.
    excluded: !b.startedAt || (status === "cancelled" && +endedAt - +start <= QUICK_CANCEL_MS),
    startedAt: b.startedAt, firstLinksAt: dateOf(links?.first ?? null), linksReadyAt, endedAt,
    durationMs: linksReadyAt && b.startedAt ? Math.max(0, +linksReadyAt - +b.startedAt) : null,
    touches: touchCount, incidents: incidentCount, deployOverlap: Number(overlap?.n ?? 0) > 0,
    products: Number(products?.n ?? 0), productsWithLinks: Number(links?.n ?? 0), recordedAt: now,
  };
  const { batchId: _key, ...update } = row;
  const [written] = await db.insert(catalogBatchOutcomes).values(row).onConflictDoUpdate({ target: catalogBatchOutcomes.batchId, set: update }).returning();
  return written ?? null;
}

/**
 * The sweep's outcome pass: a batch that ended (or moved) in the scan window is written again only when it has no row
 * yet, or the batch, its touches or its incidents changed after the row was recorded (review P3-3: a quiet sweep reads
 * one query and writes nothing). Returns the count written.
 */
export async function refreshOutcomes(db: Db, now: Date): Promise<number> {
  const statuses = sql.join(BATCH_OUTCOME_STATUSES.map((s) => sql`${s}`), sql`, `);
  const ended = rowsOf(await db.execute(sql`
    SELECT b.id FROM catalog_batches AS b LEFT JOIN catalog_batch_outcomes AS o ON o.batch_id = b.id
    WHERE b.status IN (${statuses}) AND b.updated_at >= ${new Date(+now - SCAN_WINDOW_MS).toISOString()}::timestamptz
      AND (o.batch_id IS NULL OR o.status <> b.status OR b.updated_at > o.recorded_at
        OR EXISTS (SELECT 1 FROM catalog_batch_touches AS t WHERE t.batch_id = b.id AND t.at > o.recorded_at)
        OR EXISTS (SELECT 1 FROM catalog_incidents AS i WHERE i.batch_id = b.id AND (i.created_at > o.recorded_at OR i.resolved_at > o.recorded_at)))
    ORDER BY b.updated_at DESC LIMIT ${SCAN_LIMIT}`));
  let written = 0;
  for (const b of ended) if (await recordBatchOutcome(db, String(b.id), now)) written++;
  return written;
}

// ---------------------------------------------------------------------------
// Reads for the Ops reliability card and GET /api/catalog/ops/reliability (M6-F3-R5)
// ---------------------------------------------------------------------------

export interface SuccessRate { days: number; successes: number; counted: number; rate: number | null }
export interface IncidentKindCount { kind: IncidentKind; incidents: number; repeats: number; open: number }
export interface IncidentLine { id: string; kind: IncidentKind; causeCode: string; cause: string; batchId: string | null; batchName: string | null; startedAt: Date; resolvedAt: Date | null; repeat: boolean }
export interface RecentOutcome { batchId: string; name: string; brandName: string; endedAt: Date; success: boolean; cause: string | null; touches: number; incidents: number; isTest: boolean; excluded: boolean; started: boolean }
export interface SlowBatch { batchId: string; name: string; brandName: string; durationMs: number; endedAt: Date; success: boolean }
export interface ReliabilitySummary {
  rates: SuccessRate[]; target: number; byKind: IncidentKindCount[]; recent: IncidentLine[]; slowest: SlowBatch[];
  /** The latest RECENT_OUTCOMES batches that ended in the window, test batches included and marked (review P2-4). */
  batches: RecentOutcome[];
  deploys: { batches: number; successes: number }; from: Date; to: Date;
}

/** The success rate over outcomes that ended in [from, to): test batches and quick cancels left out (M6-F3-R4). */
export async function successRate(db: Db, from: Date, to: Date): Promise<{ successes: number; counted: number; rate: number | null }> {
  const [r] = await db.select({ counted: count(), successes: sql<string>`count(*) FILTER (WHERE ${catalogBatchOutcomes.success})` }).from(catalogBatchOutcomes)
    .where(and(eq(catalogBatchOutcomes.isTest, false), eq(catalogBatchOutcomes.excluded, false), gte(catalogBatchOutcomes.endedAt, from), sql`${catalogBatchOutcomes.endedAt} < ${to.toISOString()}::timestamptz`));
  const counted = Number(r?.counted ?? 0), successes = Number(r?.successes ?? 0);
  return { successes, counted, rate: counted ? successes / counted : null };
}

/**
 * The card: 7 and 30-day success rates ending at `to`, incidents by kind with repeats and still open, the latest 10
 * incidents, the 5 slowest batches and the batches a deploy overlapped, all in [from, to) (default the last 30 days).
 */
export async function reliabilitySummary(db: Db, to: Date = new Date(), from: Date = new Date(+to - 30 * DAY_MS)): Promise<ReliabilitySummary> {
  const rates: SuccessRate[] = [];
  for (const days of RATE_WINDOWS_DAYS) rates.push({ days, ...(await successRate(db, new Date(+to - days * DAY_MS), to)) });
  const inWindow = and(gte(catalogIncidents.startedAt, from), sql`${catalogIncidents.startedAt} < ${to.toISOString()}::timestamptz`);
  const kinds = await db.select({ kind: catalogIncidents.kind, incidents: count(), repeats: count(catalogIncidents.repeatOf), open: sql<string>`count(*) FILTER (WHERE ${catalogIncidents.resolvedAt} IS NULL)` })
    .from(catalogIncidents).where(inWindow).groupBy(catalogIncidents.kind).orderBy(desc(count()));
  const recent = await db.select({ id: catalogIncidents.id, kind: catalogIncidents.kind, causeCode: catalogIncidents.causeCode, cause: catalogIncidents.cause, batchId: catalogIncidents.batchId, batchName: catalogBatches.name, startedAt: catalogIncidents.startedAt, resolvedAt: catalogIncidents.resolvedAt, repeatOf: catalogIncidents.repeatOf })
    .from(catalogIncidents).leftJoin(catalogBatches, eq(catalogBatches.id, catalogIncidents.batchId)).where(inWindow).orderBy(desc(catalogIncidents.startedAt)).limit(10);
  const outcomesInWindow = and(eq(catalogBatchOutcomes.isTest, false), gte(catalogBatchOutcomes.endedAt, from), sql`${catalogBatchOutcomes.endedAt} < ${to.toISOString()}::timestamptz`);
  const slowest = await db.select({ batchId: catalogBatchOutcomes.batchId, name: catalogBatches.name, brandName: catalogBatches.brandName, durationMs: catalogBatchOutcomes.durationMs, endedAt: catalogBatchOutcomes.endedAt, success: catalogBatchOutcomes.success })
    .from(catalogBatchOutcomes).innerJoin(catalogBatches, eq(catalogBatches.id, catalogBatchOutcomes.batchId))
    .where(and(outcomesInWindow, isNotNull(catalogBatchOutcomes.durationMs))).orderBy(desc(catalogBatchOutcomes.durationMs)).limit(5);
  const batches = await db.select({ batchId: catalogBatchOutcomes.batchId, name: catalogBatches.name, brandName: catalogBatches.brandName, endedAt: catalogBatchOutcomes.endedAt, success: catalogBatchOutcomes.success, cause: catalogBatchOutcomes.cause, touches: catalogBatchOutcomes.touches, incidents: catalogBatchOutcomes.incidents, isTest: catalogBatchOutcomes.isTest, excluded: catalogBatchOutcomes.excluded, started: sql<boolean>`${catalogBatches.startedAt} IS NOT NULL` })
    .from(catalogBatchOutcomes).innerJoin(catalogBatches, eq(catalogBatches.id, catalogBatchOutcomes.batchId))
    .where(and(gte(catalogBatchOutcomes.endedAt, from), sql`${catalogBatchOutcomes.endedAt} < ${to.toISOString()}::timestamptz`)).orderBy(desc(catalogBatchOutcomes.endedAt)).limit(RECENT_OUTCOMES);
  const [deploys] = await db.select({ batches: count(), successes: sql<string>`count(*) FILTER (WHERE ${catalogBatchOutcomes.success})` }).from(catalogBatchOutcomes)
    .where(and(outcomesInWindow, eq(catalogBatchOutcomes.excluded, false), eq(catalogBatchOutcomes.deployOverlap, true)));
  return {
    rates, target: SUCCESS_TARGET, from, to,
    byKind: kinds.map((k) => ({ kind: k.kind, incidents: Number(k.incidents), repeats: Number(k.repeats), open: Number(k.open) })),
    recent: recent.map(({ repeatOf, ...r }) => ({ ...r, repeat: repeatOf !== null })),
    slowest: slowest.map((s) => ({ ...s, durationMs: Number(s.durationMs) })),
    batches,
    deploys: { batches: Number(deploys?.batches ?? 0), successes: Number(deploys?.successes ?? 0) },
  };
}
