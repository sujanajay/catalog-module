// Spec 17 3.1.3: every invariant with a PGlite fixture that violates it and one that satisfies it, the
// log line contract, the batch scope and the counts kept on catalog_batches.counts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogCostDays, catalogEnlargements, catalogGraphExportRuns, catalogOutputs, catalogProducts, catalogSourceImages } from "../../db/schema";
import { recordAsset, recordVersion, sha256Hex } from "../../graph";
import { ENLARGING_TASK } from "../pipeline/enlargement";
import type { BatchStatus, ChangeKind, OutputStatus } from "../types";
import { CHECKS, COST_RECONCILE_STALE_HOURS, DAILY_ALERT_HOURS, EXPORT_STALE_HOURS } from "./checks";
import { BATCH_LIST_SIZE, runInvariants } from "./run";
import { classifyOutputs } from "../load/classify";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });
beforeEach(async () => {
  await db.delete(catalogEnlargements); await db.delete(catalogChunks); await db.delete(catalogOutputs); await db.delete(catalogSourceImages); await db.delete(catalogBatchProducts); await db.delete(catalogProducts); await db.delete(catalogBatches);
});

const NOW = new Date("2026-10-28T12:00:00Z");
const ago = (min: number) => new Date(+NOW - min * 60_000);
let seq = 0;

async function batch(status: BatchStatus, isTest = true) {
  const [b] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test", name: `b${++seq}`, status, isTest, createdBy: "t@opptra.com", channels: ["noon"] }).returning();
  return b!;
}
async function product(batchId: string, change: ChangeKind) {
  const key = `p${++seq}`;
  const [p] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: key, pathKey: key, identifier: key }).returning();
  await db.insert(catalogBatchProducts).values({ batchId, productId: p!.id, change });
  const [s] = await db.insert(catalogSourceImages).values({ batchId, productId: p!.id, n: 1, sha256: key, originalName: `${key}.jpg`, rawUri: `gs://a/${key}.jpg`, mime: "image/jpeg" }).returning();
  return { id: p!.id, sourceId: s!.id };
}
async function output(batchId: string, p: { id: string; sourceId: string }, status: OutputStatus, extra: { reason?: string | null; decision?: "use_as_is" | null } = {}) {
  const n = ++seq, path = `catalog-test/x/${n}.jpg`;
  const [o] = await db.insert(catalogOutputs).values({ batchId, productId: p.id, sourceImageId: p.sourceId, channel: "noon", n, canvasW: 1, canvasH: 1, scale: 1, placedX: 0, placedY: 0, renderKey: `k${n}`, objectPath: path, publicUrl: `https://x/${path}`, status, reason: extra.reason ?? null, decision: extra.decision ?? null }).returning();
  return o!;
}
async function chunk(batchId: string, v: { status: "queued" | "running" | "done" | "failed"; startedMin?: number; finishedMin?: number; leaseMin?: number }) {
  const [c] = await db.insert(catalogChunks).values({ batchId, index: ++seq, stage: "matte", productIds: [], status: v.status, startedAt: v.startedMin === undefined ? null : ago(v.startedMin), finishedAt: v.finishedMin === undefined ? null : ago(v.finishedMin), leaseUntil: v.leaseMin === undefined ? null : ago(v.leaseMin) }).returning();
  return c!;
}
const run = (batchId?: string) => runInvariants(db, vi.fn(), NOW, batchId ? { batchId } : {});

describe("invariant checks", () => {
  it("the table has the five checks of spec 17, spec 18's enlargement check, the lifecycle's three , M0-S4's export freshness, M6-S2's cost check freshness and daily alerts and M0-S3's output versions, with their severities", () => {
    expect(CHECKS.map(c => [c.id, c.severity])).toEqual([["silent_outputs", "ERROR"], ["held_without_reason", "ERROR"], ["stale_running_chunk", "WARNING"], ["slow_chunk", "WARNING"], ["done_batch_with_open_chunk", "ERROR"], ["enlarged_without_upscaler", "ERROR"],
      ["plain_accepted_outputs", "INFO"], ["parked_chunk_quiet", "WARNING"], ["enlargement_waiting_long", "INFO"], ["graph_export_stale", "WARNING"], ["cost_reconcile_stale", "WARNING"], ["daily_check_alert", "WARNING"], ["output_without_version", "ERROR"]]);
    for (const c of CHECKS) expect(c.sentence.length).toBeGreaterThan(20);
  });

  it("silent_outputs: a pending or unheld staged output in a done batch violates; held siblings, decided outputs and running batches do not", async () => {
    const done = await batch("done"), running = await batch("publishing");
    const lost = await product(done.id, "new"), held = await product(done.id, "pending_attention");
    const pending = await output(done.id, lost, "pending");
    const staged = await output(done.id, lost, "staged");
    await output(done.id, lost, "staged", { decision: "use_as_is" });
    await output(done.id, held, "staged");
    await output(done.id, held, "needs_attention", { reason: "Check the edge." });
    await output(running.id, await product(running.id, "new"), "pending");
    const r = await run();
    expect(r.counts.silent_outputs).toBe(2);
    expect(r.results.find(x => x.id === "silent_outputs")!.sample.sort()).toEqual([pending.id, staged.id].sort());
    await db.update(catalogOutputs).set({ status: "verified" }).where(eq(catalogOutputs.productId, lost.id));
    expect((await run()).counts.silent_outputs).toBe(0);
  });

  it("silent_outputs also covers a failed batch and an output failed without a reason", async () => {
    const failed = await batch("failed");
    const p = await product(failed.id, "new");
    await output(failed.id, p, "pending");
    await output(failed.id, p, "failed", { reason: " " });
    await output(failed.id, p, "failed", { reason: "Storage refused the copy" });
    expect((await run()).counts.silent_outputs).toBe(2);
  });

  it("silent_outputs and the load driver's classifyOutputs find the same silent outputs on the same rows", async () => {
    const b = await batch("done");
    const plain = await product(b.id, "new"), held = await product(b.id, "pending_attention");
    for (const [p, status, extra] of [
      [plain, "pending", {}], [plain, "staged", {}], [plain, "staged", { decision: "use_as_is" }], [plain, "failed", {}], [plain, "failed", { reason: "x" }],
      [plain, "verified", {}], [plain, "skipped", {}], [held, "staged", {}], [held, "staged", { decision: "use_as_is" }], [held, "needs_attention", { reason: "Check." }], [held, "pending", {}],
    ] as const) await output(b.id, p, status, extra);
    const rows = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, b.id));
    const classified = classifyOutputs(rows, new Set([held.id]));
    const r = await run(b.id);
    expect(r.counts.silent_outputs).toBe(classified.silent.length);
    expect(r.results.find(x => x.id === "silent_outputs")!.sample.sort()).toEqual(classified.silent.map(x => x.id).sort());
  });

  it("held_without_reason: a needs_attention output with an empty reason violates; one with a reason does not", async () => {
    const b = await batch("done"), p = await product(b.id, "pending_attention");
    await output(b.id, p, "needs_attention", { reason: "Check the edge." });
    expect((await run()).counts.held_without_reason).toBe(0);
    await output(b.id, p, "needs_attention", { reason: "  " });
    await output(b.id, p, "needs_attention");
    expect((await run()).counts.held_without_reason).toBe(2);
  });

  it("stale_running_chunk: a running chunk whose lease ended more than 5 minutes ago violates; a live or just-lapsed lease does not", async () => {
    const b = await batch("matting");
    await chunk(b.id, { status: "running", startedMin: 20, leaseMin: -2 });
    await chunk(b.id, { status: "running", startedMin: 20, leaseMin: 4 });
    await chunk(b.id, { status: "done", startedMin: 20, finishedMin: 10, leaseMin: 30 });
    expect((await run()).counts.stale_running_chunk).toBe(0);
    const stale = await chunk(b.id, { status: "running", startedMin: 20, leaseMin: 6 });
    const r = await run();
    expect(r.counts.stale_running_chunk).toBe(1);
    expect(r.results.find(x => x.id === "stale_running_chunk")!.sample).toEqual([stale.id]);
  });

  it("slow_chunk: running more than 3 x the batch median and more than 10 minutes violates; either alone does not", async () => {
    const b = await batch("matting");
    for (let i = 0; i < 3; i++) await chunk(b.id, { status: "done", startedMin: 60, finishedMin: 56 }); // median 4 min
    await chunk(b.id, { status: "running", startedMin: 11 }); // 11 min < 12 min (3 x median)
    const quick = await batch("matting");
    await chunk(quick.id, { status: "done", startedMin: 30, finishedMin: 29 }); // median 1 min
    await chunk(quick.id, { status: "running", startedMin: 9 }); // 9 x median but under 10 minutes
    const swept = await batch("failed"); // a swept batch's abandoned running chunk is not slow work
    await chunk(swept.id, { status: "done", startedMin: 60, finishedMin: 59 });
    await chunk(swept.id, { status: "running", startedMin: 50, leaseMin: 40 });
    const r0 = await run();
    expect([r0.counts.slow_chunk, r0.counts.stale_running_chunk]).toEqual([0, 0]);
    const slow = await chunk(b.id, { status: "running", startedMin: 13 });
    const r = await run();
    expect(r.counts.slow_chunk).toBe(1);
    expect(r.results.find(x => x.id === "slow_chunk")!.sample).toEqual([slow.id]);
  });

  it("done_batch_with_open_chunk: a done batch with a queued or running chunk violates; done and failed chunks do not", async () => {
    const b = await batch("done");
    await chunk(b.id, { status: "done", startedMin: 5, finishedMin: 4 });
    await chunk(b.id, { status: "failed", startedMin: 5, finishedMin: 4 });
    expect((await run()).counts.done_batch_with_open_chunk).toBe(0);
    await chunk(b.id, { status: "queued" });
    expect((await run()).counts.done_batch_with_open_chunk).toBe(1);
  });

  it("done_batch_with_open_chunk: work re-opened after the batch finished (Try again, an M1-S4 improvement) is not a violation; an older open chunk still is", async () => {
    const b = await batch("done");
    await db.update(catalogBatches).set({ finishedAt: ago(60) }).where(eq(catalogBatches.id, b.id));
    const reopened = await chunk(b.id, { status: "queued" });
    await db.update(catalogChunks).set({ dispatchedAt: ago(5) }).where(eq(catalogChunks.id, reopened.id));
    await db.update(catalogChunks).set({ createdAt: ago(90) }).where(eq(catalogChunks.id, reopened.id));
    expect((await run(b.id)).counts.done_batch_with_open_chunk).toBe(0);
    const stuck = await chunk(b.id, { status: "running" });
    await db.update(catalogChunks).set({ createdAt: ago(120), dispatchedAt: ago(120) }).where(eq(catalogChunks.id, stuck.id));
    expect((await run(b.id)).counts.done_batch_with_open_chunk).toBe(1);
  });

  it("enlarged_without_upscaler: a verified output enlarged past 1.5x without `upscaled` in a batch with the stage violates; upscaled, held, small and older batches do not", async () => {
    const withStage = await batch("done");
    await db.update(catalogBatches).set({ options: { ...withStage.options, enlargement: { model: "swinir-x2" } } }).where(eq(catalogBatches.id, withStage.id));
    const p = await product(withStage.id, "new");
    const enlarged = async (status: OutputStatus, scale: number, flags: string[]) => {
      const o = await output(withStage.id, p, status, status === "needs_attention" ? { reason: "This photo could not be enlarged." } : {});
      await db.update(catalogOutputs).set({ scale, flags: flags as typeof o.flags }).where(eq(catalogOutputs.id, o.id));
      return o;
    };
    const plain = await enlarged("verified", 2.25, []);
    await enlarged("verified", 2.25, ["upscaled"]);
    await enlarged("needs_attention", 2.25, ["enlargement_failed"]);
    await enlarged("verified", 1.5, []);
    // An older batch (started before the stage) made with the silent fallback is ignored.
    const older = await batch("done"), q = await product(older.id, "new");
    const old = await output(older.id, q, "verified");
    await db.update(catalogOutputs).set({ scale: 3 }).where(eq(catalogOutputs.id, old.id));
    const r = await run();
    expect(r.counts.enlarged_without_upscaler).toBe(1);
    expect(r.results.find(x => x.id === "enlarged_without_upscaler")!.sample).toEqual([plain.id]);
    await db.update(catalogOutputs).set({ flags: ["upscaled"] }).where(eq(catalogOutputs.id, plain.id));
    expect((await run()).counts.enlarged_without_upscaler).toBe(0);
  });

  it("T57: plain_accepted_outputs counts outputs used as they are after the plain warning, which enlarged_without_upscaler then excludes; each fires only on its fixture", async () => {
    const b = await batch("done");
    await db.update(catalogBatches).set({ options: { ...b.options, enlargement: { model: "swinir-x2", minScale: 1 } } }).where(eq(catalogBatches.id, b.id));
    const p = await product(b.id, "new");
    const accepted = await output(b.id, p, "verified", { decision: "use_as_is" }), silent = await output(b.id, p, "verified");
    await db.update(catalogOutputs).set({ scale: 2, flags: ["enlargement_failed"] }).where(eq(catalogOutputs.id, accepted.id));
    await db.update(catalogOutputs).set({ scale: 2, flags: [] }).where(eq(catalogOutputs.id, silent.id));
    const r = await run();
    expect(r.counts.plain_accepted_outputs).toBe(1);
    expect(r.results.find(x => x.id === "plain_accepted_outputs")!.sample).toEqual([accepted.id]);
    expect(r.results.find(x => x.id === "enlarged_without_upscaler")!.sample).toEqual([silent.id]);
    expect([r.counts.parked_chunk_quiet, r.counts.enlargement_waiting_long]).toEqual([0, 0]);
  });

  it("M1-F3-R1: a plain render of a failed enlargement that an auto-decide rule delivered (provisional) is not a silent fallback", async () => {
    const b = await batch("done");
    await db.update(catalogBatches).set({ options: { ...b.options, enlargement: { model: "swinir-x2", minScale: 1 } } }).where(eq(catalogBatches.id, b.id));
    const p = await product(b.id, "new");
    const provisional = await output(b.id, p, "verified"), silent = await output(b.id, p, "verified");
    await db.update(catalogOutputs).set({ scale: 2, flags: ["enlargement_failed", "provisional"] }).where(eq(catalogOutputs.id, provisional.id));
    await db.update(catalogOutputs).set({ scale: 2, flags: ["enlargement_failed"] }).where(eq(catalogOutputs.id, silent.id));
    expect((await run()).results.find(x => x.id === "enlarged_without_upscaler")!.sample).toEqual([silent.id]);
  });

  it("T57: parked_chunk_quiet fires on a parked chunk quiet for 2 h of a live batch; enlargement_waiting_long on a wanted queued row older than 20 h", async () => {
    const b = await batch("rendering"), p = await product(b.id, "new"), cancelled = await batch("cancelled");
    const [quiet] = await db.insert(catalogChunks).values({ batchId: b.id, index: ++seq, stage: "render", status: "queued", productIds: [p.id], taskName: ENLARGING_TASK, dispatchedAt: ago(200), progressAt: ago(121) }).returning();
    await db.insert(catalogChunks).values({ batchId: b.id, index: ++seq, stage: "render", status: "queued", productIds: [p.id], taskName: ENLARGING_TASK, dispatchedAt: ago(200), progressAt: ago(119) });
    await db.insert(catalogChunks).values({ batchId: cancelled.id, index: ++seq, stage: "render", status: "queued", productIds: [], taskName: ENLARGING_TASK, dispatchedAt: ago(500), progressAt: ago(500) });
    const row = (identityHash: string, createdMin: number, extra: Partial<typeof catalogEnlargements.$inferInsert> = {}) => db.insert(catalogEnlargements).values({ batchId: b.id, productId: p.id, sourceImageId: p.sourceId, upscaler: "u@h", factor: 2, scale: 2, outW: 2, outH: 2, route: "direct", pixelHash: "p", identityHash, createdAt: ago(createdMin), ...extra }).returning();
    const [long] = await row("a", 21 * 60);
    await row("b", 19 * 60);
    await row("c", 21 * 60, { status: "done" });
    await row("d", 21 * 60, { wanted: false });
    const r = await run();
    expect(r.results.find(x => x.id === "parked_chunk_quiet")!.sample).toEqual([quiet!.id]);
    expect(r.results.find(x => x.id === "enlargement_waiting_long")!.sample).toEqual([long!.id]);
  });

  it("enlarged_without_upscaler, spec 18 quality: a batch started at the 1.0x threshold violates at 1.2x without `upscaled`; 1.0x exactly and a 1.2x hold do not", async () => {
    const b = await batch("done");
    await db.update(catalogBatches).set({ options: { ...b.options, enlargement: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 } } }).where(eq(catalogBatches.id, b.id));
    const p = await product(b.id, "new");
    const enlarged = async (status: OutputStatus, scale: number, flags: string[]) => {
      const o = await output(b.id, p, status, status === "needs_attention" ? { reason: "This photo could not be enlarged." } : {});
      await db.update(catalogOutputs).set({ scale, flags: flags as typeof o.flags }).where(eq(catalogOutputs.id, o.id));
      return o;
    };
    const plain = await enlarged("verified", 1.2, []);
    await enlarged("verified", 1.2, ["upscaled"]);
    await enlarged("needs_attention", 1.2, ["enlargement_failed"]);
    await enlarged("verified", 1, []);
    await enlarged("verified", 0.6, []);
    const r = await run();
    expect(r.counts.enlarged_without_upscaler).toBe(1);
    expect(r.results.find(x => x.id === "enlarged_without_upscaler")!.sample).toEqual([plain.id]);
  });

  it("M0-S4: graph_export_stale fires when no export finished cleanly in the last 26 hours, once a run is older than that; never before the first run", async () => {
    await db.delete(catalogGraphExportRuns);
    const h = (hours: number) => ago(hours * 60);
    const stale = async () => (await run()).counts.graph_export_stale;
    expect(EXPORT_STALE_HOURS).toBe(26);
    // No export has ever run (the job is not set up yet): nothing to report.
    expect(await stale()).toBe(0);
    // A first run that is still going, or failed, within the window: not stale yet.
    const [first] = await db.insert(catalogGraphExportRuns).values({ startedAt: h(2), error: "BigQuery said no" }).returning();
    expect(await stale()).toBe(0);
    // Its window has passed with no clean finish: stale, reported on the latest run.
    await db.update(catalogGraphExportRuns).set({ startedAt: h(27) });
    expect(await stale()).toBe(1);
    // Not a batch's problem: the log line names no batch id (review P3-2).
    expect((await run()).results.find((x) => x.id === "graph_export_stale")!.batches).toEqual([{ batchId: null, test: false, violations: 1 }]);
    // A clean run 25 hours ago keeps it fresh (a daily run plus its own time).
    await db.insert(catalogGraphExportRuns).values({ startedAt: h(25.2), finishedAt: h(25) });
    expect(await stale()).toBe(0);
    // That run is now 27 hours old and the newer run failed: stale again, whichever run is latest.
    await db.update(catalogGraphExportRuns).set({ startedAt: h(27.2), finishedAt: h(27) }).where(isNull(catalogGraphExportRuns.error));
    await db.delete(catalogGraphExportRuns).where(eq(catalogGraphExportRuns.id, first!.id));
    await db.insert(catalogGraphExportRuns).values({ startedAt: h(3), error: "BigQuery said no" });
    expect(await stale()).toBe(1);
    await db.delete(catalogGraphExportRuns);
  });

  it("M0-S3: output_without_version fires on a staged or delivered image with no version in a batch the write path ran on; older outputs and other batches do not", async () => {
    const count = async () => (await run()).counts.output_without_version;
    const b = await batch("done"), old = await batch("done");
    const p = await product(b.id, "new"), q = await product(old.id, "new");
    const staged = async (batchId: string, pr: typeof p, at: Date) => {
      const o = await output(batchId, pr, "verified");
      await db.update(catalogOutputs).set({ stagingUri: `gs://assets/s/${o.id}.jpg`, createdAt: at }).where(eq(catalogOutputs.id, o.id));
      return o;
    };
    const before = await staged(b.id, p, ago(120));
    await staged(old.id, q, ago(60));
    // No output version in either batch yet: an older worker made them.
    expect(await count()).toBe(0);
    const hash = sha256Hex(new TextEncoder().encode("inv-version"));
    await recordAsset(db, { sha256: hash, uri: "gs://assets/s/v.jpg", mime: "image/jpeg" });
    const v = await recordVersion(db, { optionId: null, scope: "noon", component: "image", source: "cleanup", aiGenerated: false, producer: "M3", producerRef: "inv-out", assetSha256: hash, batchId: b.id, isTest: true, createdBy: "t" });
    // Within the grace after the first version (a rolling deploy's old revision): not counted yet.
    const after = await staged(b.id, p, new Date(Date.now() + 60_000));
    expect(await count()).toBe(0);
    await db.update(catalogOutputs).set({ createdAt: new Date(Date.now() + 31 * 60_000) }).where(eq(catalogOutputs.id, after.id));
    const r = await run();
    expect(r.counts.output_without_version).toBe(1);
    expect(r.results.find((x) => x.id === "output_without_version")!.sample).toEqual([after.id]);
    // A batch older than the window is not scanned.
    await db.update(catalogBatches).set({ createdAt: new Date(+NOW - 15 * 86_400_000) }).where(eq(catalogBatches.id, b.id));
    expect(await count()).toBe(0);
    await db.update(catalogBatches).set({ createdAt: NOW }).where(eq(catalogBatches.id, b.id));
    expect(await count()).toBe(1);
    await db.update(catalogOutputs).set({ contentVersionId: v.versionId }).where(eq(catalogOutputs.id, after.id));
    expect(await count()).toBe(0);
    expect(before.id).not.toBe(after.id);
  });

  it("M6-S2: cost_reconcile_stale fires when the newest cost row is older than 30 hours, or no run finished while the ledger is older than that", async () => {
    const stale = async () => (await run()).counts.cost_reconcile_stale;
    expect(COST_RECONCILE_STALE_HOURS).toBe(30);
    expect(await stale()).toBe(0);
    // Review fix: no successful run recorded at all. A ledger younger than 30 hours is not yet late; an older one is.
    const ledger = (hours: number) => db.execute(sql`INSERT INTO catalog_cost_events (stage, kind, engine, at) VALUES ('system', 'job', 'job', ${ago(hours * 60).toISOString()}::timestamptz)`);
    await ledger(29);
    expect(await stale()).toBe(0);
    await ledger(31);
    expect(await stale()).toBe(1);
    const row = (hours: number, day: string) => ({ day, component: "ila-pg", kind: "shared" as const, env: "live" as const, source: "monitoring" as const, computedAt: ago(hours * 60) });
    await db.insert(catalogCostDays).values(row(31, "2026-10-01"));
    expect(await stale()).toBe(1);
    expect((await run()).results.find((x) => x.id === "cost_reconcile_stale")!.batches).toEqual([{ batchId: null, test: false, violations: 1 }]);
    await db.insert(catalogCostDays).values(row(29, "2026-10-02"));
    expect(await stale()).toBe(0);
    await db.delete(catalogCostDays);
    await db.execute(sql`DELETE FROM catalog_cost_events`);
  });

  it("M6-S2: daily_check_alert counts the alerts the daily job wrote in the last 24 hours", async () => {
    const alerts = async () => (await run()).counts.daily_check_alert;
    expect(DAILY_ALERT_HOURS).toBe(24);
    expect(await alerts()).toBe(0);
    const incident = (hours: number, key: string) => db.execute(sql`INSERT INTO catalog_incidents (kind, severity, cause_code, cause, started_at, resolved_at, dedupe_key, created_at)
      VALUES ('alert', 'warning', 'ledger_over', 'over', ${ago(hours * 60).toISOString()}::timestamptz, ${ago(hours * 60).toISOString()}::timestamptz, ${key}, ${ago(hours * 60).toISOString()}::timestamptz)`);
    await incident(25, "alert:old");
    expect(await alerts()).toBe(0);
    await incident(2, "alert:new");
    expect(await alerts()).toBe(1);
    await db.execute(sql`DELETE FROM catalog_incidents`);
  });
});

describe("runInvariants", () => {
  it("logs one line per check with id, violations, sample and severity, at the check's severity only when violated", async () => {
    const b = await batch("done"), p = await product(b.id, "new");
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await output(b.id, p, "pending")).id);
    const log = vi.fn();
    await runInvariants(db, log, NOW);
    expect(log).toHaveBeenCalledTimes(CHECKS.length);
    const silent = log.mock.calls.find(([, , f]) => f.id === "silent_outputs")!;
    expect(silent[0]).toBe("ERROR");
    expect(silent[1]).toBe("invariant");
    expect(silent[2]).toMatchObject({ id: "silent_outputs", violations: 7, severity: "ERROR" });
    expect(silent[2].sample).toHaveLength(5);
    for (const id of silent[2].sample) expect(ids).toContain(id);
    expect(silent[2]).toMatchObject({ batches: [{ batchId: b.id, test: true, violations: 7 }], batchCount: 1 });
    const ok = log.mock.calls.find(([, , f]) => f.id === "slow_chunk")!;
    expect(ok).toEqual(["INFO", "invariant", { id: "slow_chunk", violations: 0, sample: [], batches: [], batchCount: 0, severity: "WARNING" }]);
  });

  it("names the violating batches per check, most violations first, with the test flag so delivered work stands out", async () => {
    const delivered = await batch("done", false), test = await batch("done");
    const dp = await product(delivered.id, "new"), tp = await product(test.id, "new");
    await output(delivered.id, dp, "pending");
    for (let i = 0; i < 3; i++) await output(test.id, tp, "pending");
    const working = await batch("matting", false);
    const stale = await chunk(working.id, { status: "running", startedMin: 20, leaseMin: 10 });
    const log = vi.fn();
    const r = await runInvariants(db, log, NOW);
    const silent = r.results.find(x => x.id === "silent_outputs")!;
    expect(silent).toMatchObject({ violations: 4, batchCount: 2, batches: [{ batchId: test.id, test: true, violations: 3 }, { batchId: delivered.id, test: false, violations: 1 }] });
    expect(r.results.find(x => x.id === "stale_running_chunk")).toMatchObject({ sample: [stale.id], batches: [{ batchId: working.id, test: false, violations: 1 }], batchCount: 1 });
    expect(log.mock.calls.find(([, , f]) => f.id === "silent_outputs")![2].batches).toEqual(silent.batches);
    // The grouping by batch keeps each batch's own silentOutputs count.
    const counts = async (id: string) => (await db.select({ counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!.counts as unknown as Record<string, number>;
    expect(await counts(test.id)).toMatchObject({ silentOutputs: 3 });
    expect(await counts(delivered.id)).toMatchObject({ silentOutputs: 1 });
    // Scoped to one batch, only that batch is named.
    expect((await run(delivered.id)).results.find(x => x.id === "silent_outputs")).toMatchObject({ violations: 1, batches: [{ batchId: delivered.id, test: false, violations: 1 }], batchCount: 1 });
  });

  it("lists at most BATCH_LIST_SIZE batches and still counts them all", async () => {
    let last = "";
    for (let i = 0; i < BATCH_LIST_SIZE + 2; i++) { const b = await batch("done"); await output(b.id, await product(b.id, "new"), "pending"); last = b.id; }
    // The last batch created gets a second violation: it is listed first however the ids sort, never cut.
    const p = (await db.select({ id: catalogBatchProducts.productId }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, last)))[0]!.id;
    const src = (await db.select({ id: catalogSourceImages.id }).from(catalogSourceImages).where(eq(catalogSourceImages.batchId, last)))[0]!.id;
    await output(last, { id: p, sourceId: src }, "pending");
    const silent = (await run()).results.find(x => x.id === "silent_outputs")!;
    expect(silent.violations).toBe(BATCH_LIST_SIZE + 3);
    expect(silent.batchCount).toBe(BATCH_LIST_SIZE + 2);
    expect(silent.batches).toHaveLength(BATCH_LIST_SIZE);
    expect(silent.batches[0]).toEqual({ batchId: last, test: true, violations: 2 });
  });

  it("scopes to one batch and keeps silentOutputs, heldSiblings and slowestChunkMs on its counts, back to 0 when fixed", async () => {
    const mine = await batch("done"), other = await batch("done");
    const lost = await product(mine.id, "new"), held = await product(mine.id, "pending_attention");
    await output(mine.id, lost, "pending");
    await output(mine.id, held, "staged"); await output(mine.id, held, "staged");
    await output(other.id, await product(other.id, "new"), "pending");
    expect((await run(mine.id)).counts.silent_outputs).toBe(1);
    const read = async (id: string) => (await db.select({ counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!.counts as unknown as Record<string, unknown>;
    expect(await read(mine.id)).toMatchObject({ silentOutputs: 1, heldSiblings: 2, slowestChunkMs: 0 });
    expect((await read(other.id)).silentOutputs).toBeUndefined();
    await db.update(catalogOutputs).set({ status: "verified" }).where(eq(catalogOutputs.productId, lost.id));
    await run();
    expect(await read(mine.id)).toMatchObject({ silentOutputs: 0, heldSiblings: 2 });
    expect(await read(other.id)).toMatchObject({ silentOutputs: 1 });
  });

  it("keeps the slowest running chunk's age on its batch and puts every number back to 0 once it goes away", async () => {
    const read = async (id: string) => (await db.select({ counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!.counts as unknown as Record<string, number>;
    const b = await batch("rendering");
    await chunk(b.id, { status: "running", startedMin: 7 });
    await chunk(b.id, { status: "running", startedMin: 3 });
    await run();
    expect((await read(b.id)).slowestChunkMs).toBe(7 * 60_000);
    const lost = await batch("done");
    await output(lost.id, await product(lost.id, "new"), "pending");
    await run();
    expect((await read(lost.id)).silentOutputs).toBe(1);
    await db.update(catalogChunks).set({ status: "done", finishedAt: NOW }).where(eq(catalogChunks.batchId, b.id));
    await db.update(catalogOutputs).set({ status: "verified" }).where(eq(catalogOutputs.batchId, lost.id));
    await run();
    expect(await read(b.id)).toMatchObject({ slowestChunkMs: 0, silentOutputs: 0, heldSiblings: 0 });
    expect(await read(lost.id)).toMatchObject({ silentOutputs: 0, heldSiblings: 0, slowestChunkMs: 0 });
  });
});
