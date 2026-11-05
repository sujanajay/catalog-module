// M1-F5 (M1-S6): drafts that carry on by themselves, and the ones that did not. The sweep (every 10 minutes) calls
// the three movers below; each is capped per batch, so a draft that keeps failing stops being moved and waits for a
// person, and orphanDrafts lists it on the Ops page with its reason (F5-R5).
//  - handOffIdleDrafts (F5-R1): a draft whose files all finished uploading but were never handed to collecting (the
//    tab closed in the second before the page hands them on) is handed on, with or without auto-start (review P2-1:
//    a draft with Wait pressed is collected too, and then waits for its Start button).
//  - rearmLostCountdowns (F5-R1): an auto-start draft that is collected but whose countdown task was lost (or whose
//    countdown was not queued) gets a new countdown. A countdown the auto-start task ended on purpose (a refusal that
//    is not "busy", counts.autoStartEnded) is not armed again: its Start button shows (review P2-4).
//  - resendGivenUpIntake (F5-R4): an intake that stopped after several failed tries (INGEST_STOPPED_TEXT, the
//    7bdee361 case) is re-sent instead of waiting for Fix and continue.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogUploads, type CatalogBatch } from "../db/schema";
import type { enqueueTask } from "../tasks";
import { mergeCounts } from "./counts";
import { log } from "../log";
import { handOff, INGEST_ROUTE, ingestTaskId, uploadedPage } from "./ingest/hand-off";
import { INGEST_STOPPED_TEXT } from "./ingest/index";
import { armAutoStart, AUTO_START_DELAY_SEC } from "./auto-start";

/** A draft nobody wrote to for this long is moved on by the sweep (the page itself hands on within a second). */
export const DRAFT_IDLE_MS = 10 * 60_000;
/** An intake that gave up is re-sent after this long (as M6-F2-R4's re-send of a stalled one). */
export const GIVEN_UP_RESEND_MS = 30 * 60_000;
/** At most this many sweep hand-offs, re-armed countdowns and re-sends per batch (each its own count). */
export const SWEEP_MOVES_MAX = 3;
/** F5-R5: a draft older than this with inputs and no start is an orphan. */
export const ORPHAN_AGE_MS = 24 * 60 * 60_000;

const autoStartOn = sql`coalesce((${catalogBatches.options}->>'autoStart')::boolean, false)`;
const previewReady = sql`coalesce((${catalogBatches.counts}->>'previewReady')::boolean, false)`;
const countOf = (key: "sweepHandOffs" | "sweepRearms" | "ingestResends") => sql`coalesce((${catalogBatches.counts}->>${key})::int, 0)`;
const notCleanedUp = sql`not coalesce((${catalogBatches.options}->>'cleanedUp')::boolean, false)`;

/**
 * Hands the batch's `uploaded` uploads to collecting under `run` (the paged hand-off of the web's Continue), or, when
 * every upload is already read, one collected upload, whose task groups and places again. Failure counts start at 0.
 */
async function handOnUploads(db: Db, enqueue: typeof enqueueTask, batchId: string, run: string, collectedId: string | null): Promise<number> {
  await db.update(catalogUploads).set({ ingestFailures: 0 }).where(and(eq(catalogUploads.batchId, batchId), gt(catalogUploads.ingestFailures, 0)));
  const page = await uploadedPage(db, batchId, null);
  if (page.ids.length) { await handOff(enqueue, batchId, run, page); return page.ids.length; }
  if (!collectedId) return 0;
  await enqueue(INGEST_ROUTE, { batchId, uploadId: collectedId, run }, { taskId: ingestTaskId(collectedId, run) });
  return 1;
}

/** What the movers and the Ops list need to know of a batch's live (not removed) uploads, counted in the database. */
export interface UploadSummary { pending: number; webOnly: boolean; uploaded: boolean; collected: string | null }

/**
 * The upload summary of some batches, by batch id (a batch with no live upload is absent). One aggregate row per batch
 * (review P2-2): a week-old folder drop of thousands of files is never loaded row by row on each sweep or Ops refresh.
 * `webOnly`: a Google Sheet or Drive folder link not read yet, which only the page reads (collectGoogleLink).
 */
async function uploadSummaries(db: Db, ids: string[]): Promise<Map<string, UploadSummary>> {
  const by = new Map<string, UploadSummary>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.select({
      batchId: catalogUploads.batchId,
      pending: sql<number>`(count(*) FILTER (WHERE ${catalogUploads.status} = 'pending'))::int`,
      webOnly: sql<boolean>`coalesce(bool_or(${catalogUploads.kind} IN ('google_sheet', 'drive_folder') AND ${catalogUploads.status} = 'uploaded' AND ${catalogUploads.gcsUri} IS NULL), false)`,
      uploaded: sql<boolean>`coalesce(bool_or(${catalogUploads.status} = 'uploaded'), false)`,
      collected: sql<string | null>`min(${catalogUploads.id}::text) FILTER (WHERE ${catalogUploads.status} = 'collected')`,
    }).from(catalogUploads).where(and(inArray(catalogUploads.batchId, ids.slice(i, i + 1000)), ne(catalogUploads.status, "removed"))).groupBy(catalogUploads.batchId);
    for (const r of rows) by.set(r.batchId, { pending: Number(r.pending), webOnly: r.webOnly === true, uploaded: r.uploaded === true, collected: r.collected ?? null });
  }
  return by;
}

/** F5-R1: see the file comment. Returns the batches handed on. */
export async function handOffIdleDrafts(db: Db, enqueue: typeof enqueueTask, now: Date): Promise<string[]> {
  const drafts = await db.select().from(catalogBatches).where(and(
    eq(catalogBatches.status, "draft"), isNull(catalogBatches.startedAt), sql`not ${previewReady}`,
    lt(catalogBatches.updatedAt, new Date(+now - DRAFT_IDLE_MS)), sql`${countOf("sweepHandOffs")} < ${SWEEP_MOVES_MAX}`,
    // Review P2-2: only drafts with something to hand on and nothing still uploading are summarised (an abandoned
    // upload waits for a person, and the Ops list names it).
    sql`EXISTS (SELECT 1 FROM ${catalogUploads} WHERE ${catalogUploads.batchId} = ${catalogBatches.id} AND ${catalogUploads.status} IN ('uploaded', 'collected'))`,
    sql`NOT EXISTS (SELECT 1 FROM ${catalogUploads} WHERE ${catalogUploads.batchId} = ${catalogBatches.id} AND ${catalogUploads.status} = 'pending')`,
  ));
  const uploads = await uploadSummaries(db, drafts.map((d) => d.id));
  const handed: string[] = [];
  for (const draft of drafts) {
    const live = uploads.get(draft.id);
    // Files still uploading (or abandoned part way) and links only the page can read wait for a person (F5-R5 lists them).
    if (!live || live.pending || live.webOnly) continue;
    const collected = live.collected;
    if (!live.uploaded && !collected) continue;
    const run = randomUUID();
    // Conditional: still an idle draft, so a write by the page or the worker since the read above wins.
    const [moved] = await db.update(catalogBatches)
      .set({ status: "ingesting", counts: mergeCounts({ previewReady: false, fixReason: null, ingestRun: run, autoStartAt: null, sweepHandOffs: (draft.counts.sweepHandOffs ?? 0) + 1 }) })
      .where(and(eq(catalogBatches.id, draft.id), eq(catalogBatches.status, "draft"), lt(catalogBatches.updatedAt, new Date(+now - DRAFT_IDLE_MS))))
      .returning({ id: catalogBatches.id });
    if (!moved) continue;
    try {
      const sent = await handOnUploads(db, enqueue, draft.id, run, collected);
      log("WARNING", "draft handed to collecting by the sweep", { batchId: draft.id, brandSlug: draft.brandSlug, run, uploads: sent });
      handed.push(draft.id);
    } catch (error) {
      // Nothing may have reached the queue: back to draft, so the next sweep (or the page) hands it on again.
      await db.update(catalogBatches).set({ status: "draft" }).where(and(eq(catalogBatches.id, draft.id), eq(catalogBatches.status, "ingesting"), sql`${catalogBatches.counts}->>'ingestRun' = ${run}`));
      log("ERROR", "sweep hand-off failed", { batchId: draft.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return handed;
}

/** F5-R1: see the file comment. Returns the batches whose countdown was armed again. */
export async function rearmLostCountdowns(db: Db, enqueue: typeof enqueueTask, now: Date): Promise<string[]> {
  const lostBefore = new Date(+now - DRAFT_IDLE_MS).toISOString();
  const drafts = await db.select({ id: catalogBatches.id, brandSlug: catalogBatches.brandSlug, counts: catalogBatches.counts }).from(catalogBatches).where(and(
    eq(catalogBatches.status, "draft"), isNull(catalogBatches.startedAt), sql`${autoStartOn}`, sql`${previewReady}`,
    sql`coalesce(${catalogBatches.counts}->>'phase', '') <> 'needs_input'`, sql`jsonb_array_length(${catalogBatches.channels}) > 0`,
    lt(catalogBatches.updatedAt, new Date(+now - DRAFT_IDLE_MS)), sql`${countOf("sweepRearms")} < ${SWEEP_MOVES_MAX}`,
    // No countdown, or one whose time passed long ago (its task was lost); a busy back-off runs at most 15 minutes ahead.
    sql`(${catalogBatches.counts}->>'autoStartAt' IS NULL OR ${catalogBatches.counts}->>'autoStartAt' < ${lostBefore})`,
    // Review P2-4: not a countdown the auto-start task ended on purpose (nothing usable, a changed draft): Start shows.
    sql`not coalesce((${catalogBatches.counts}->>'autoStartEnded')::boolean, false)`,
  ));
  const armed: string[] = [];
  for (const draft of drafts) {
    // Review P3: a draft that cannot be armed (the queue refused) does not stop the others in this sweep.
    try {
      await db.update(catalogBatches).set({ counts: mergeCounts({ sweepRearms: (draft.counts.sweepRearms ?? 0) + 1 }) }).where(eq(catalogBatches.id, draft.id));
      const at = await armAutoStart(db, enqueue, draft.id, AUTO_START_DELAY_SEC, now);
      if (!at) continue;
      log("WARNING", "auto-start armed again by the sweep", { batchId: draft.id, brandSlug: draft.brandSlug, at, lostAt: draft.counts.autoStartAt ?? null });
      armed.push(draft.id);
    } catch (error) {
      log("ERROR", "sweep could not arm auto-start again", { batchId: draft.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return armed;
}

/** F5-R4: see the file comment. Returns the batches whose intake was re-sent. */
export async function resendGivenUpIntake(db: Db, enqueue: typeof enqueueTask, now: Date): Promise<string[]> {
  const stopped = await db.select().from(catalogBatches).where(and(
    eq(catalogBatches.status, "failed"), isNull(catalogBatches.startedAt), sql`${catalogBatches.counts}->>'failReason' = ${INGEST_STOPPED_TEXT}`,
    lt(catalogBatches.updatedAt, new Date(+now - GIVEN_UP_RESEND_MS)), sql`${countOf("ingestResends")} < ${SWEEP_MOVES_MAX}`,
  ));
  const uploads = await uploadSummaries(db, stopped.map((b) => b.id));
  const sent: string[] = [];
  for (const batch of stopped) {
    const live = uploads.get(batch.id);
    const collected = live?.collected ?? null;
    if (!live || live.webOnly || (!live.uploaded && !collected)) continue;
    const run = randomUUID();
    // The failed batch goes back to collecting under a new run, with its reason cleared (the re-send is the retry).
    const [moved] = await db.update(catalogBatches)
      .set({ status: "ingesting", counts: mergeCounts({ failReason: null, fixReason: null, previewReady: false, placingClaim: null, phase: null, ingestRun: run, ingestResends: (batch.counts.ingestResends ?? 0) + 1 }) })
      .where(and(eq(catalogBatches.id, batch.id), eq(catalogBatches.status, "failed"), isNull(catalogBatches.startedAt), lt(catalogBatches.updatedAt, new Date(+now - GIVEN_UP_RESEND_MS))))
      .returning({ id: catalogBatches.id });
    if (!moved) continue;
    try {
      const handed = await handOnUploads(db, enqueue, batch.id, run, collected);
      log("WARNING", "intake re-sent after it gave up", { batchId: batch.id, brandSlug: batch.brandSlug, run, uploads: handed, resend: (batch.counts.ingestResends ?? 0) + 1 });
      sent.push(batch.id);
    } catch (error) {
      await db.update(catalogBatches).set({ status: "failed", counts: mergeCounts({ failReason: INGEST_STOPPED_TEXT }) })
        .where(and(eq(catalogBatches.id, batch.id), eq(catalogBatches.status, "ingesting"), sql`${catalogBatches.counts}->>'ingestRun' = ${run}`));
      log("ERROR", "intake re-send failed", { batchId: batch.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sent;
}

export interface OrphanDraft { id: string; name: string; brandName: string; createdBy: string; createdAt: Date; reason: string }

/** Why a draft with inputs has not started, in the Ops page's words (F5-R5). */
export function orphanReason(draft: Pick<CatalogBatch, "channels" | "options" | "counts">, uploads: Pick<UploadSummary, "pending" | "webOnly">): string {
  const pending = uploads.pending;
  if (pending) return `${pending} ${pending === 1 ? "file" : "files"} did not finish uploading.`;
  if (!draft.counts.previewReady) return uploads.webOnly ?"Its Google links were never collected. Open it and wait for the links to be read." : "Its files were never collected.";
  if (draft.counts.phase === "needs_input") return "Waiting for the photo column of its sheet.";
  if (!draft.channels.length) return "No channel was chosen.";
  if (draft.options.autoStart !== true) return "Waiting for Start (it does not start by itself).";
  if (draft.counts.autoStartAt) return "Waiting for products another batch is still making.";
  return "Auto-start stopped. Open it and press Start.";
}

/**
 * F5-R5: drafts older than ORPHAN_AGE_MS with inputs and no start, oldest first, each with its reason. Test batches
 * and cleaned-up ones are left out.
 */
export async function orphanDrafts(db: Db, now: Date): Promise<OrphanDraft[]> {
  const drafts = await db.select().from(catalogBatches).where(and(
    eq(catalogBatches.status, "draft"), isNull(catalogBatches.startedAt), eq(catalogBatches.isTest, false), notCleanedUp,
    lt(catalogBatches.createdAt, new Date(+now - ORPHAN_AGE_MS)),
  )).orderBy(asc(catalogBatches.createdAt));
  const uploads = await uploadSummaries(db, drafts.map((d) => d.id));
  return drafts.filter((d) => uploads.has(d.id)).map((d) => ({ id: d.id, name: d.name, brandName: d.brandName, createdBy: d.createdBy, createdAt: d.createdAt, reason: orphanReason(d, uploads.get(d.id)!) }));
}

/** The sweep runs every this often; the daily orphan count is logged by the run in the first window after 00:00 UTC. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;

/** F5-R5: the daily count (a log line a log-based metric can count), once a day; returns the count when logged. */
export async function logOrphanCount(db: Db, now: Date): Promise<number | null> {
  const sinceMidnight = +now - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (sinceMidnight >= SWEEP_INTERVAL_MS) return null;
  const orphans = await orphanDrafts(db, now);
  log(orphans.length ? "WARNING" : "INFO", "orphan drafts", { event: "orphan_drafts", count: orphans.length, batchIds: orphans.slice(0, 50).map((o) => o.id) });
  return orphans.length;
}
