// Spec 17 3.1.3: every invariant with a PGlite fixture that violates it and one that satisfies it, the
// log line contract, the batch scope and the counts kept on catalog_batches.counts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogEnlargements, catalogOutputs, catalogProducts, catalogSourceImages } from "../../db/schema";
import { ENLARGING_TASK } from "../pipeline/enlargement";
import type { BatchStatus, ChangeKind, OutputStatus } from "../types";
import { CHECKS } from "./checks";
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
  it("the table has the five checks of spec 17, spec 18's enlargement check and the lifecycle's three, with their severities", () => {
    expect(CHECKS.map(c => [c.id, c.severity])).toEqual([["silent_outputs", "ERROR"], ["held_without_reason", "ERROR"], ["stale_running_chunk", "WARNING"], ["slow_chunk", "WARNING"], ["done_batch_with_open_chunk", "ERROR"], ["enlarged_without_upscaler", "ERROR"],
      ["plain_accepted_outputs", "INFO"], ["parked_chunk_quiet", "WARNING"], ["enlargement_waiting_long", "INFO"]]);
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
