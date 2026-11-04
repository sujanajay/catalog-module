// Tier 2 (PGlite, the real migrations): M6-S6 batch outcomes, incidents and touches (M6-F3 acceptance tests 1 and 2).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import type { InvariantResult } from "./invariants/run";
import { ENLARGING_TASK } from "./pipeline/enlargement";
import {
  INGEST_STALL_INCIDENT_MS, recordBatchOutcome, recordTouch, refreshOutcomes, registerRevision, reliabilitySummary,
  STALL_INCIDENT_MS, successRate, syncIncidents,
} from "./reliability";

type Row = Record<string, unknown>;
let db: Db;
let close: () => Promise<void>;
const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

const T0 = new Date("2026-11-04T08:00:00Z");
const at = (minutes: number) => new Date(+T0 + minutes * 60_000);

async function batch(fields: { status: string; startedAt?: Date | null; finishedAt?: Date | null; updatedAt?: Date; isTest?: boolean; createdAt?: Date; counts?: Record<string, unknown>; error?: string | null }): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, is_test, created_by, counts, error, created_at, started_at, finished_at, updated_at)
    VALUES (${id}, 'uspa', 'USPA', ${`batch ${id.slice(0, 4)}`}, ${fields.status}, ${fields.isTest ?? false}, 'op@opptra.com',
      ${JSON.stringify(fields.counts ?? {})}::jsonb, ${fields.error ?? null},
      ${(fields.createdAt ?? fields.startedAt ?? T0).toISOString()}::timestamptz,
      ${fields.startedAt === undefined ? T0.toISOString() : fields.startedAt?.toISOString() ?? null}::timestamptz,
      ${fields.finishedAt?.toISOString() ?? null}::timestamptz, ${(fields.updatedAt ?? fields.finishedAt ?? T0).toISOString()}::timestamptz)`);
  return id;
}

/** A product with one photo and one output, published at `publishedAt` (null: not published). */
async function output(batchId: string, publishedAt: Date | null): Promise<{ productId: string; sourceId: string; outputId: string }> {
  const productId = randomUUID(), sourceId = randomUUID(), outputId = randomUUID(), key = `P${productId.slice(0, 8)}`;
  await db.execute(sql`INSERT INTO catalog_products (id, brand_slug, is_test, product_key, path_key, identifier) VALUES (${productId}, 'uspa', false, ${key.toUpperCase()}, ${key}, ${key})`);
  await db.execute(sql`INSERT INTO catalog_batch_products (batch_id, product_id, change) VALUES (${batchId}, ${productId}, 'new')`);
  await db.execute(sql`INSERT INTO catalog_source_images (id, batch_id, product_id, n, sha256, original_name, raw_uri, mime) VALUES (${sourceId}, ${batchId}, ${productId}, 1, ${key}, 'x.jpg', 'gs://a/x.jpg', 'image/jpeg')`);
  await db.execute(sql`INSERT INTO catalog_outputs (id, batch_id, product_id, source_image_id, channel, n, canvas_w, canvas_h, scale, placed_x, placed_y, render_key, object_path, public_url, status, published_at)
    VALUES (${outputId}, ${batchId}, ${productId}, ${sourceId}, 'noon', 1, 1, 1, 1, 0, 0, 'k', 'catalog-test/x.jpg', 'https://x/catalog-test/x.jpg', 'verified', ${publishedAt?.toISOString() ?? null}::timestamptz)`);
  return { productId, sourceId, outputId };
}

async function chunk(batchId: string, fields: { status: string; taskName?: string | null; progressAt?: Date | null; startedAt?: Date | null; finishedAt?: Date | null; attempt?: number; error?: string | null }): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO catalog_chunks (id, batch_id, "index", stage, product_ids, status, task_name, started_at, finished_at, progress_at, attempt, error)
    VALUES (${id}, ${batchId}, 0, 'render', '[]'::jsonb, ${fields.status}, ${fields.taskName ?? null}, ${fields.startedAt?.toISOString() ?? null}::timestamptz,
      ${fields.finishedAt?.toISOString() ?? null}::timestamptz, ${fields.progressAt?.toISOString() ?? null}::timestamptz, ${fields.attempt ?? 1}, ${fields.error ?? null})`);
  return id;
}

async function enlargement(batchId: string, ids: { productId: string; sourceId: string }, status: string, updatedAt: Date): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO catalog_enlargements (id, batch_id, product_id, source_image_id, upscaler, factor, scale, out_w, out_h, route, pixel_hash, identity_hash, status, updated_at)
    VALUES (${id}, ${batchId}, ${ids.productId}, ${ids.sourceId}, 'u', 2, 2, 10, 10, 'direct', 'p', ${id}, ${status}, ${updatedAt.toISOString()}::timestamptz)`);
  return id;
}

const incidents = (batchId?: string) => rows(batchId
  ? sql`SELECT * FROM catalog_incidents WHERE batch_id = ${batchId} ORDER BY started_at`
  : sql`SELECT * FROM catalog_incidents ORDER BY started_at`);

beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

describe("M6-F3 acceptance test 1: a clean batch, one Try again, and an upscaler stopped for 20 minutes", () => {
  it("records success, touches 1 and one stall incident with its cause and resolution time", async () => {
    // Clean: done at +30, nothing touched.
    const clean = await batch({ status: "done", startedAt: T0, finishedAt: at(30) });
    await output(clean, at(20));
    // Try again once on a photo, then done.
    const retried = await batch({ status: "done", startedAt: T0, finishedAt: at(40) });
    const r = await output(retried, at(35));
    expect(await recordTouch(db, { action: "retry_photo", outputId: r.outputId }, at(25))).toBe(true);
    // The upscaler stops at +5: the batch's only chunk is parked on an enlargement and nothing settles.
    const stopped = await batch({ status: "rendering", startedAt: T0, updatedAt: at(5) });
    const s = await output(stopped, null);
    const parked = await chunk(stopped, { status: "queued", taskName: ENLARGING_TASK, startedAt: at(1), progressAt: at(5) });
    const e = await enlargement(stopped, s, "queued", at(24));

    // Sweeps at +10 (5 minutes quiet: nothing) and +20 (15 minutes quiet: one stall), +30 (still one).
    expect((await syncIncidents(db, at(10))).opened).toBe(0);
    expect((await syncIncidents(db, at(20))).opened).toBe(1);
    expect((await syncIncidents(db, at(30))).opened).toBe(0);
    let [stall] = await incidents(stopped);
    expect(stall).toMatchObject({ kind: "stall", severity: "warning", cause_code: "enlarge_wait", resolved_at: null });
    expect(new Date(String(stall!.started_at)).toISOString()).toBe(at(5).toISOString());

    // The upscaler is back at +25: the enlargement settles, the chunk finishes, the batch is done at +45.
    await db.execute(sql`UPDATE catalog_enlargements SET status = 'done', updated_at = ${at(32).toISOString()}::timestamptz WHERE id = ${e}`);
    await db.execute(sql`UPDATE catalog_chunks SET status = 'done', finished_at = ${at(40).toISOString()}::timestamptz WHERE id = ${parked}`);
    expect((await syncIncidents(db, at(40))).resolved).toBe(1);
    await db.execute(sql`UPDATE catalog_outputs SET published_at = ${at(42).toISOString()}::timestamptz WHERE batch_id = ${stopped}`);
    await db.execute(sql`UPDATE catalog_batches SET status = 'done', finished_at = ${at(45).toISOString()}::timestamptz, updated_at = ${at(45).toISOString()}::timestamptz WHERE id = ${stopped}`);
    [stall] = await incidents(stopped);
    expect(new Date(String(stall!.resolved_at)).toISOString()).toBe(at(40).toISOString());

    const outcomes = { clean: await recordBatchOutcome(db, clean, at(50)), retried: await recordBatchOutcome(db, retried, at(50)), stopped: await recordBatchOutcome(db, stopped, at(50)) };
    expect(outcomes.clean).toMatchObject({ status: "done", success: true, cause: null, touches: 0, incidents: 0, products: 1, productsWithLinks: 1, durationMs: 30 * 60_000 });
    expect(outcomes.clean!.firstLinksAt!.toISOString()).toBe(at(20).toISOString());
    expect(outcomes.clean!.linksReadyAt!.toISOString()).toBe(at(30).toISOString());
    expect(outcomes.retried).toMatchObject({ success: false, cause: "touched", touches: 1, incidents: 0 });
    expect(outcomes.stopped).toMatchObject({ success: false, cause: "incident", touches: 0, incidents: 1 });

    const summary = await reliabilitySummary(db, at(60));
    expect(summary.rates.map((r) => [r.days, r.successes, r.counted])).toEqual([[7, 1, 3], [30, 1, 3]]);
    expect(summary.byKind).toEqual([{ kind: "stall", incidents: 1, repeats: 0, open: 0 }]);
    expect(summary.recent[0]).toMatchObject({ kind: "stall", causeCode: "enlarge_wait", batchId: stopped, repeat: false });
    expect(summary.recent[0]!.resolvedAt!.toISOString()).toBe(at(40).toISOString());
  });
});

describe("M6-F3 acceptance test 2: the 7-day rate equals a hand count of catalog_batch_outcomes", () => {
  it("counts non-test, non-excluded outcomes that ended in the window", async () => {
    const now = new Date(+T0 + 10 * 86_400_000);
    const day = (d: number) => new Date(+now - d * 86_400_000);
    for (const [d, touched] of [[1, false], [2, true], [6, false], [8, false]] as const) {
      const id = await batch({ status: "done", startedAt: day(d), finishedAt: day(d) });
      if (touched) await recordTouch(db, { action: "decision", batchId: id }, day(d));
      await recordBatchOutcome(db, id, now);
    }
    await recordBatchOutcome(db, await batch({ status: "done", startedAt: day(1), finishedAt: day(1), isTest: true }), now);
    // Cancelled 5 minutes after start: recorded, left out of the rate.
    const quick = await batch({ status: "cancelled", startedAt: day(3), updatedAt: new Date(+day(3) + 5 * 60_000) });
    expect(await recordBatchOutcome(db, quick, now)).toMatchObject({ status: "cancelled", success: false, cause: "cancelled", excluded: true });
    // Failed after start: counted.
    await recordBatchOutcome(db, await batch({ status: "failed", startedAt: day(4), updatedAt: day(4) }), now);

    const [hand] = await rows(sql`SELECT count(*) FILTER (WHERE success)::int AS ok, count(*)::int AS n FROM catalog_batch_outcomes
      WHERE NOT is_test AND NOT excluded AND ended_at >= ${day(7).toISOString()}::timestamptz AND ended_at < ${now.toISOString()}::timestamptz`);
    const rate = await successRate(db, day(7), now);
    expect([rate.successes, rate.counted]).toEqual([hand!.ok, hand!.n]);
    expect([rate.successes, rate.counted]).toEqual([2, 4]);
    expect(rate.rate).toBe(0.5);
  });
});

describe("incidents", () => {
  it("writes each failed batch and chunk once, already resolved, and a later stall of the same cause as a repeat", async () => {
    const failed = await batch({ status: "failed", startedAt: T0, updatedAt: at(30), error: "No progress for 2 hours. Start the batch again." });
    const gaveUp = await batch({ status: "rendering", startedAt: T0, updatedAt: at(55) });
    await chunk(gaveUp, { status: "failed", finishedAt: at(50), attempt: 3, error: "The photo service failed 3 times." });
    expect((await syncIncidents(db, at(60))).opened).toBe(2);
    expect((await syncIncidents(db, at(61))).opened).toBe(0);
    const [f] = await incidents(failed), [c] = await incidents(gaveUp);
    expect(f).toMatchObject({ kind: "batch_failed", cause_code: "failed_after_start", cause: "No progress for 2 hours. Start the batch again." });
    expect(f!.resolved_at).not.toBeNull();
    expect(c).toMatchObject({ kind: "chunk_gave_up", cause_code: "render", cause: "The photo service failed 3 times." });

    // Two stalls of one batch, apart: the second is a repeat of the first and opens only after the first resolved.
    const slow = await batch({ status: "rendering", startedAt: T0, updatedAt: at(0) });
    await syncIncidents(db, new Date(+at(0) + STALL_INCIDENT_MS));
    await db.execute(sql`UPDATE catalog_batches SET updated_at = ${at(20).toISOString()}::timestamptz WHERE id = ${slow}`);
    await syncIncidents(db, at(21));
    await syncIncidents(db, new Date(+at(20) + STALL_INCIDENT_MS + 60_000));
    const stalls = await incidents(slow);
    expect(stalls).toHaveLength(2);
    expect(stalls[0]!.resolved_at).not.toBeNull();
    expect(stalls[1]).toMatchObject({ cause_code: "no_progress", repeat_of: stalls[0]!.id, resolved_at: null });
  });

  it("raises no stall while a long finalize works: a live claim or a re-check part handed on (review P2-2)", async () => {
    // Every chunk done at +0; the batch publishes while the finalize re-checks links for 40 minutes.
    const claimed = await batch({ status: "publishing", startedAt: at(-60), updatedAt: at(0), counts: { finalizeClaimUntil: +at(45) } });
    await chunk(claimed, { status: "done", startedAt: at(-30), finishedAt: at(0) });
    const handedOn = await batch({ status: "publishing", startedAt: at(-60), updatedAt: at(0), counts: { finalizeEnqueuedAt: +at(35) } });
    await chunk(handedOn, { status: "done", startedAt: at(-30), finishedAt: at(0) });
    const quiet = await batch({ status: "publishing", startedAt: at(-60), updatedAt: at(0), counts: { finalizeClaimUntil: +at(20) } });
    await chunk(quiet, { status: "done", startedAt: at(-30), finishedAt: at(0) });
    await syncIncidents(db, at(40));
    expect(await incidents(claimed)).toEqual([]);
    expect(await incidents(handedOn)).toEqual([]);
    // A finalize whose claim lapsed 20 minutes ago with nothing since is a stall.
    expect(await incidents(quiet)).toMatchObject([{ kind: "stall", cause_code: "no_progress" }]);
  });

  it("gives a collecting batch 30 minutes before a stall", async () => {
    const collecting = await batch({ status: "ingesting", startedAt: null, updatedAt: T0 });
    await syncIncidents(db, new Date(+T0 + STALL_INCIDENT_MS + 60_000));
    expect(await incidents(collecting)).toHaveLength(0);
    await syncIncidents(db, new Date(+T0 + INGEST_STALL_INCIDENT_MS));
    expect(await incidents(collecting)).toMatchObject([{ kind: "stall", cause_code: "ingest_stalled" }]);
  });

  it("opens an incident per ERROR invariant and batch while violated and resolves it on the first clean run", async () => {
    const b = await batch({ status: "done", startedAt: T0, finishedAt: at(10) });
    const violated: InvariantResult[] = [
      { id: "silent_outputs", severity: "ERROR", violations: 2, sample: [], batches: [{ batchId: b, test: false, violations: 2 }], batchCount: 1 },
      { id: "slow_chunk", severity: "WARNING", violations: 5, sample: [], batches: [], batchCount: 0 },
    ];
    await syncIncidents(db, at(20), { invariants: violated });
    await syncIncidents(db, at(30), { invariants: violated });
    expect(await incidents(b)).toMatchObject([{ kind: "invariant", severity: "error", cause_code: "silent_outputs", resolved_at: null }]);
    // A sweep whose invariants run failed passes no results: nothing is resolved.
    await syncIncidents(db, at(35));
    expect((await incidents(b))[0]!.resolved_at).toBeNull();
    await syncIncidents(db, at(40), { invariants: [{ ...violated[0]!, violations: 0, batches: [] }] });
    expect(new Date(String((await incidents(b))[0]!.resolved_at)).toISOString()).toBe(at(40).toISOString());
  });
});

describe("outcomes", () => {
  it("marks a batch a deploy overlapped, keeps the first links-ready time, and skips a draft that expired", async () => {
    await registerRevision(db, "catalog-worker", "catalog-worker-00001-old", at(-60));
    const b = await batch({ status: "done", startedAt: T0, finishedAt: at(30) });
    expect(await recordBatchOutcome(db, b, at(31))).toMatchObject({ deployOverlap: false });
    await registerRevision(db, "catalog-worker", "catalog-worker-00002-new", at(10));
    await registerRevision(db, "catalog-worker", "catalog-worker-00002-new", at(12));
    expect(await recordBatchOutcome(db, b, at(32))).toMatchObject({ deployOverlap: true });
    // Re-opened and finalized again later: links were ready at the first finish.
    await db.execute(sql`UPDATE catalog_batches SET finished_at = ${at(90).toISOString()}::timestamptz WHERE id = ${b}`);
    expect((await recordBatchOutcome(db, b, at(91)))!.linksReadyAt!.toISOString()).toBe(at(30).toISOString());

    const expired = await batch({ status: "cancelled", startedAt: null, updatedAt: at(1) });
    expect(await recordBatchOutcome(db, expired, at(2))).toBeNull();
    const collecting = await batch({ status: "ingesting", startedAt: null });
    expect(await recordBatchOutcome(db, collecting, at(2))).toBeNull();
  });

  it("leaves batches that never started out of the rate, and writes no row for an expired draft (review P2-1)", async () => {
    const now = at(60 * 24 * 3);
    // Collected (Continue ran), then abandoned: the sweep's draft expiry cancels it days later.
    const expired = await batch({ status: "cancelled", startedAt: null, createdAt: at(0), updatedAt: now, counts: { ingestRun: "r1" } });
    await db.execute(sql`UPDATE catalog_batches SET options = '{"expired":{"at":"x","days":14}}'::jsonb WHERE id = ${expired}`);
    expect(await recordBatchOutcome(db, expired, now)).toBeNull();
    // Collected, then cancelled by the operator an hour later, before Start; and an intake that failed before Start.
    const cancelled = await batch({ status: "cancelled", startedAt: null, createdAt: at(0), updatedAt: at(60), counts: { ingestRun: "r2" } });
    const intakeFailed = await batch({ status: "failed", startedAt: null, createdAt: at(0), updatedAt: at(30), counts: { ingestRun: "r3" } });
    expect(await recordBatchOutcome(db, cancelled, now)).toMatchObject({ success: false, cause: "cancelled", excluded: true });
    expect(await recordBatchOutcome(db, intakeFailed, now)).toMatchObject({ success: false, cause: "failed", excluded: true });
    // A started batch that failed still counts.
    const started = await batch({ status: "failed", startedAt: at(10), updatedAt: at(100) });
    expect(await recordBatchOutcome(db, started, now)).toMatchObject({ excluded: false });
    expect(await successRate(db, at(-1), now)).toMatchObject({ successes: 0, counted: 1 });
  });

  it("refreshes every batch that ended in the last 24 hours (a failed batch, an incident after finalize)", async () => {
    const failed = await batch({ status: "failed", startedAt: T0, updatedAt: at(30) });
    const cancelledBeforeStart = await batch({ status: "cancelled", startedAt: null, updatedAt: at(40), counts: { ingestRun: "r1" } });
    const old = await batch({ status: "done", startedAt: T0, finishedAt: at(-3000) });
    expect(await refreshOutcomes(db, at(60))).toBe(2);
    const written = await rows(sql`SELECT batch_id, status, cause FROM catalog_batch_outcomes ORDER BY status`);
    expect(written).toEqual([{ batch_id: cancelledBeforeStart, status: "cancelled", cause: "cancelled" }, { batch_id: failed, status: "failed", cause: "failed" }]);
    expect(written.some((w) => w.batch_id === old)).toBe(false);
    // Review P3-3: a quiet sweep rewrites nothing; a touch or an incident after the row was recorded rewrites that batch.
    expect(await refreshOutcomes(db, at(70))).toBe(0);
    await recordTouch(db, { action: "cancel", batchId: cancelledBeforeStart }, at(75));
    expect(await refreshOutcomes(db, at(80))).toBe(1);
    expect(await rows(sql`SELECT touches FROM catalog_batch_outcomes WHERE batch_id = ${cancelledBeforeStart}`)).toEqual([{ touches: 1 }]);
  });

  it("records a touch by output id, and none for an unknown output", async () => {
    const b = await batch({ status: "done", startedAt: T0, finishedAt: at(30) });
    const o = await output(b, at(10));
    expect(await recordTouch(db, { action: "decision", outputId: o.outputId }, at(31))).toBe(true);
    expect(await recordTouch(db, { action: "decision", outputId: randomUUID() }, at(31))).toBe(false);
    expect(await rows(sql`SELECT batch_id, output_id, action FROM catalog_batch_touches`)).toEqual([{ batch_id: b, output_id: o.outputId, action: "decision" }]);
  });
});
