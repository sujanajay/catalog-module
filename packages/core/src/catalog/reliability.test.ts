// Tier 2 (PGlite, the real migrations): M6-S6 batch outcomes, incidents and touches (M6-F3 acceptance tests 1 and 2).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import type { InvariantResult } from "./invariants/run";
import { recordBatchOutcome, recordTouch, refreshOutcomes, registerRevision, reliabilitySummary, successRate, syncIncidents } from "./reliability";

type Row = Record<string, unknown>;
let db: Db;
let close: () => Promise<void>;
const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

const T0 = new Date("2026-11-04T08:00:00Z");
const at = (minutes: number) => new Date(+T0 + minutes * 60_000);

async function batch(fields: { status: string; startedAt?: Date | null; finishedAt?: Date | null; updatedAt?: Date; isTest?: boolean; createdAt?: Date; counts?: Record<string, unknown>; error?: string | null }): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, is_test, created_by, channels, counts, error, created_at, started_at, finished_at, updated_at)
    VALUES (${id}, 'uspa', 'USPA', ${`batch ${id.slice(0, 4)}`}, ${fields.status}, ${fields.isTest ?? false}, 'op@opptra.com', '["noon"]'::jsonb,
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
  await db.execute(sql`INSERT INTO catalog_outputs (id, batch_id, product_id, source_image_id, channel, n, canvas_w, canvas_h, scale, placed_x, placed_y, render_key, object_path, public_url, status, is_live, published_at)
    VALUES (${outputId}, ${batchId}, ${productId}, ${sourceId}, 'noon', 1, 1, 1, 1, 0, 0, 'k', 'catalog-test/x.jpg', 'https://x/catalog-test/x.jpg', 'verified', ${publishedAt !== null}, ${publishedAt?.toISOString() ?? null}::timestamptz)`);
  return { productId, sourceId, outputId };
}

async function chunk(batchId: string, fields: { status: string; taskName?: string | null; progressAt?: Date | null; startedAt?: Date | null; finishedAt?: Date | null; attempt?: number; error?: string | null; index?: number }): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO catalog_chunks (id, batch_id, "index", stage, product_ids, status, task_name, started_at, finished_at, progress_at, attempt, error)
    VALUES (${id}, ${batchId}, ${fields.index ?? 0}, 'render', '[]'::jsonb, ${fields.status}, ${fields.taskName ?? null}, ${fields.startedAt?.toISOString() ?? null}::timestamptz,
      ${fields.finishedAt?.toISOString() ?? null}::timestamptz, ${fields.progressAt?.toISOString() ?? null}::timestamptz, ${fields.attempt ?? 1}, ${fields.error ?? null})`);
  return id;
}

const incidents = (batchId?: string) => rows(batchId
  ? sql`SELECT * FROM catalog_incidents WHERE batch_id = ${batchId} ORDER BY started_at`
  : sql`SELECT * FROM catalog_incidents ORDER BY started_at`);

beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

// The stall part of acceptance test 1 (an upscaler stopped for 20 minutes) moved to the M1-S4b outage slice with stall
// detection (M6 decision S6-20); here a group of photos that gave up after its retries is the incident.
describe("M6-F3 acceptance test 1: a clean batch, one Try again, and one with an incident", () => {
  it("records success, touches 1 and one incident with its cause and time", async () => {
    // Clean: done at +30, nothing touched.
    const clean = await batch({ status: "done", startedAt: T0, finishedAt: at(30) });
    await output(clean, at(20));
    // Try again once on a photo, then done.
    const retried = await batch({ status: "done", startedAt: T0, finishedAt: at(40) });
    const r = await output(retried, at(35));
    expect(await recordTouch(db, { action: "retry_photo", outputId: r.outputId }, at(25))).toBe(true);
    // A group of photos gives up after its retries at +20; the batch still finishes at +45.
    const stopped = await batch({ status: "rendering", startedAt: T0, updatedAt: at(20) });
    await output(stopped, null);
    await chunk(stopped, { status: "failed", startedAt: at(1), finishedAt: at(20), attempt: 3, error: "The photo service failed 3 times." });
    expect((await syncIncidents(db, at(30))).opened).toBe(1);
    expect((await syncIncidents(db, at(40))).opened).toBe(0);
    await db.execute(sql`UPDATE catalog_outputs SET published_at = ${at(42).toISOString()}::timestamptz WHERE batch_id = ${stopped}`);
    await db.execute(sql`UPDATE catalog_batches SET status = 'done', finished_at = ${at(45).toISOString()}::timestamptz, updated_at = ${at(45).toISOString()}::timestamptz WHERE id = ${stopped}`);
    const [gaveUp] = await incidents(stopped);
    expect(gaveUp).toMatchObject({ kind: "chunk_gave_up", severity: "error", cause_code: "render" });
    expect(new Date(String(gaveUp!.resolved_at)).toISOString()).toBe(at(20).toISOString());

    const outcomes = { clean: await recordBatchOutcome(db, clean, at(50)), retried: await recordBatchOutcome(db, retried, at(50)), stopped: await recordBatchOutcome(db, stopped, at(50)) };
    expect(outcomes.clean).toMatchObject({ status: "done", success: true, cause: null, touches: 0, incidents: 0, products: 1, productsWithLinks: 1, durationMs: 30 * 60_000 });
    expect(outcomes.clean!.firstLinksAt!.toISOString()).toBe(at(20).toISOString());
    expect(outcomes.clean!.linksReadyAt!.toISOString()).toBe(at(30).toISOString());
    expect(outcomes.retried).toMatchObject({ success: false, cause: "touched", touches: 1, incidents: 0 });
    expect(outcomes.stopped).toMatchObject({ success: false, cause: "incident", touches: 0, incidents: 1 });

    const summary = await reliabilitySummary(db, at(60));
    expect(summary.rates.map((r) => [r.days, r.successes, r.counted])).toEqual([[7, 1, 3], [30, 1, 3]]);
    expect(summary.byKind).toEqual([{ kind: "chunk_gave_up", incidents: 1, repeats: 0, open: 0 }]);
    expect(summary.recent[0]).toMatchObject({ kind: "chunk_gave_up", causeCode: "render", batchId: stopped, repeat: false });
    expect(summary.recent[0]!.resolvedAt!.toISOString()).toBe(at(20).toISOString());
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
  it("writes each failed batch and chunk once, already resolved, a later one of the same cause as a repeat, and no stall", async () => {
    const failed = await batch({ status: "failed", startedAt: T0, updatedAt: at(30), error: "No progress for 2 hours. Start the batch again." });
    const gaveUp = await batch({ status: "rendering", startedAt: T0, updatedAt: at(55) });
    await chunk(gaveUp, { status: "failed", finishedAt: at(50), attempt: 3, error: "The photo service failed 3 times." });
    await chunk(gaveUp, { status: "running", startedAt: at(55), index: 1 });
    expect((await syncIncidents(db, at(60))).opened).toBe(2);
    expect((await syncIncidents(db, at(61))).opened).toBe(0);
    const [f] = await incidents(failed), [c] = await incidents(gaveUp);
    expect(f).toMatchObject({ kind: "batch_failed", cause_code: "failed_after_start", cause: "No progress for 2 hours. Start the batch again." });
    expect(f!.resolved_at).not.toBeNull();
    expect(c).toMatchObject({ kind: "chunk_gave_up", cause_code: "render", cause: "The photo service failed 3 times." });

    // A second chunk of the same stage gives up later: a repeat of the first.
    await chunk(gaveUp, { status: "failed", finishedAt: at(70), attempt: 3, index: 2 });
    await syncIncidents(db, at(75));
    const both = await incidents(gaveUp);
    expect(both).toHaveLength(2);
    expect(both[1]).toMatchObject({ kind: "chunk_gave_up", repeat_of: both[0]!.id });

    // Stalls are not detected here any more (M6 decision S6-20, M1-S4b): a batch quiet for 2 hours opens nothing.
    const quiet = await batch({ status: "rendering", startedAt: T0, updatedAt: at(0) });
    await syncIncidents(db, at(120));
    expect(await incidents(quiet)).toEqual([]);
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

    // Review 2 P3-B: a quick cancel the same release overlapped is not in the release-overlap line; it is marked as one.
    const quick = await batch({ status: "cancelled", startedAt: at(5), finishedAt: at(13), updatedAt: at(13) });
    expect(await recordBatchOutcome(db, quick, at(14))).toMatchObject({ deployOverlap: true, excluded: true });
    const summary = await reliabilitySummary(db, at(120));
    expect(summary.deploys).toEqual({ batches: 1, successes: 1 });
    expect(summary.batches.find((o) => o.batchId === quick)).toMatchObject({ excluded: true, started: true });

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

describe("an outcome is honest about what was left out (R1 exit 2 findings 1 and 5)", () => {

  it("is not a success when grouping left products out, and counts them in the products total", async () => {
    const id = await batch({ status: "done", finishedAt: at(30), counts: { productsLeftOut: 91 } });
    await output(id, at(5));
    expect(await recordBatchOutcome(db, id, at(31))).toMatchObject({ success: false, cause: "input_left_out", products: 92, productsWithLinks: 1 });
  });

  it("a person stepping in stays the first cause", async () => {
    const id = await batch({ status: "done", finishedAt: at(30), counts: { productsLeftOut: 1 } });
    await output(id, at(5));
    await recordTouch(db, { action: "retry_photo", batchId: id }, at(10));
    expect(await recordBatchOutcome(db, id, at(31))).toMatchObject({ success: false, cause: "touched" });
  });

  it("is not a success when an upload could not be read at all", async () => {
    const id = await batch({ status: "done", finishedAt: at(30), counts: { uploadsNotRead: 1 } });
    await output(id, at(5));
    expect(await recordBatchOutcome(db, id, at(31))).toMatchObject({ success: false, cause: "input_left_out", products: 1 });
  });

  it("is not a success when a file was not used", async () => {
    const id = await batch({ status: "done", finishedAt: at(30), counts: { filesLeftOut: 2 } });
    await output(id, at(5));
    expect(await recordBatchOutcome(db, id, at(31))).toMatchObject({ success: false, cause: "input_left_out", products: 1 });
  });

  it("counts unchanged products that keep their earlier live links, as the digest does, and not a list row without photos", async () => {
    const first = await batch({ status: "done", finishedAt: at(10) });
    const { productId } = await output(first, at(5));
    const next = await batch({ status: "done", finishedAt: at(30), startedAt: at(20) });
    await db.execute(sql`INSERT INTO catalog_batch_products (batch_id, product_id, change) VALUES (${next}, ${productId}, 'unchanged')`);
    await output(next, at(25));
    const noPhotos = await output(first, at(6));
    await db.execute(sql`INSERT INTO catalog_batch_products (batch_id, product_id, change, link_status) VALUES (${next}, ${noPhotos.productId}, 'unchanged', 'missing_images')`);
    expect(await recordBatchOutcome(db, next, at(31))).toMatchObject({ success: true, products: 3, productsWithLinks: 2 });
  });
});
