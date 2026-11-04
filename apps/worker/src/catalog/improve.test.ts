// M1-S4 (M1-F3-R4, R5; F3 test 2 in the shape spec 18 allows): an auto-decide batch whose upscaler could not enlarge a
// photo delivers the plain render `provisional` (M1-S3). Once the upscaler works again, the sweep sends an improvement
// task (`/tasks/catalog/improve`) for the slot; it re-makes the enlargement and republishes at the same public URL with a
// new object generation, and the `provisional` flag clears. Tries are bounded (3 over 72 hours, spaced); a try is
// counted only when the upscaler answers its health probe; a product another batch holds is left alone.
// Tier 2 (PGlite + fakes), the same world as the spec 18 operator tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { DIMENSION_FLAGS } from "@catalog/core/catalog/qa/judge";
import { retryEnlargement, RETRY_SUPERSEDED } from "@catalog/core/catalog/decisions";
import { autoDecideSnapshot } from "@catalog/core/catalog/auto-decide";
import { IMPROVE_FIRST_DELAY_MS, IMPROVE_MAX_TRIES, IMPROVE_SPACING_MS, IMPROVE_WINDOW_MS, improvementOf } from "@catalog/core/catalog/improve";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import { batchOf, drain, enlargeWorld, outputsOf, rowsOf, seedEnlargeBatch, seedSecondBatch, startChunks, sweep, type EnlargeWorld } from "../../test/enlarge-world";
import { clearImproveProbeCache, handleImproveTask, IMPROVE_RESEND_MS, IMPROVE_ROUTE } from "./improve";
import { enqueueFinalize } from "./deps";
import { FINALIZE_PARKED_WAIT_S, handleFinalizeTask } from "./finalize";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
beforeEach(() => clearImproveProbeCache());
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

const minutes = (ms: number) => ms / 60_000;
const only = (s: { batch: { id: string } }) => ({ only: { db, batchId: s.batch.id } });
const improveTasks = (e: EnlargeWorld, batchId: string) => e.w.tasks.filter((t) => t.route === IMPROVE_ROUTE && t.body.batchId === batchId);
const publicObject = (e: EnlargeWorld, objectPath: string) => e.w.objects.get(`gs://public/${objectPath}`);

/**
 * An auto-decide batch run to its end with the upscaler refusing every photo: each slot delivered as the plain render,
 * `provisional`, live at its stable public path.
 */
async function provisionalBatch(name: string, auto = true, channels: ("trendyol" | "noon")[] = ["trendyol"]) {
  const e = enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, [[1]], { channels });
  if (auto) await db.update(catalogBatches).set({ options: { ...s.batch.options, autoDecide: await autoDecideSnapshot(db) } }).where(eq(catalogBatches.id, s.batch.id));
  e.service.state.mode = "badInput";
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  await drain(e.w, only(s));
  e.service.state.mode = "ok";
  expect((await batchOf(db, s.batch.id)).status).toBe("done");
  const outs = await outputsOf(db, s.batch.id);
  return { ...e, s, outs };
}
/** The clock moved, then one sweep. */
async function sweepAfter(e: EnlargeWorld, ms: number) { e.clock.tick(minutes(ms)); await sweep(db, e.w); }

describe("improvement task (M1-F3-R4)", () => {
  it("F3 test 2: a plain render delivered provisional is enlarged when the upscaler works again and republished at the same URL; the flag clears", async () => {
    const e = await provisionalBatch("improve-ok");
    const [before] = e.outs;
    expect(before).toMatchObject({ status: "verified", isLive: true });
    expect(before!.flags).toEqual(expect.arrayContaining(["provisional", "enlargement_failed"]));
    const bytesBefore = publicObject(e, before!.objectPath)!;
    // Too early: the first try waits IMPROVE_FIRST_DELAY_MS after delivery.
    await sweep(db, e.w);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(1);
    await drain(e.w, only(e.s));
    const [after] = await outputsOf(db, e.s.batch.id);
    expect(after).toMatchObject({ id: before!.id, status: "verified", isLive: true, objectPath: before!.objectPath, publicUrl: before!.publicUrl });
    expect(after!.flags).toContain("upscaled");
    expect(after!.flags).not.toContain("provisional");
    expect(after!.flags).not.toContain("enlargement_failed");
    expect(after!.generation).not.toBe(before!.generation);
    expect(publicObject(e, after!.objectPath)!.equals(bytesBefore)).toBe(false);
    await sweep(db, e.w);
    expect(await improvementOf(db, e.s.batch.id, after!.sourceImageId)).toMatchObject({ tries: 1, improvedAt: expect.any(Date) });
    // The batch is done again with a fresh links sheet, and the product is free for the next batch.
    const batch = await batchOf(db, e.s.batch.id);
    expect(batch.status).toBe("done");
    expect(batch.sheetXlsxUri).toMatch(/links-v2/);
    expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id, after!.productId)))[0]!.lockBatchId).toBeNull();
    // Improved: never tried again.
    await sweepAfter(e, IMPROVE_SPACING_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
  }, 300_000);

  it("a try that fails again keeps the provisional link; tries are spaced and stop after IMPROVE_MAX_TRIES", async () => {
    const e = await provisionalBatch("improve-fails");
    const [before] = e.outs;
    e.service.state.mode = "badInput";
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    for (let n = 1; n <= IMPROVE_MAX_TRIES; n++) {
      expect(improveTasks(e, e.s.batch.id)).toHaveLength(1);
      await drain(e.w, only(e.s));
      const [o] = await outputsOf(db, e.s.batch.id);
      expect(o).toMatchObject({ status: "verified", isLive: true, objectPath: before!.objectPath });
      expect(o!.flags).toEqual(expect.arrayContaining(["provisional", "enlargement_failed"]));
      expect(await improvementOf(db, e.s.batch.id, o!.sourceImageId)).toMatchObject({ tries: n, improvedAt: null });
      // Not again before the spacing.
      await sweepAfter(e, IMPROVE_SPACING_MS / 2);
      expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
      await sweepAfter(e, IMPROVE_SPACING_MS / 2);
    }
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
  }, 600_000);

  it("a try is not counted while the upscaler does not answer its probe; the slot is tried when it does", async () => {
    const e = await provisionalBatch("improve-down");
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    const [task] = improveTasks(e, e.s.batch.id);
    e.service.state.mode = "down";
    expect(await handleImproveTask(e.w.deps, task!.body)).toMatchObject({ httpStatus: 200, outcome: "upscaler_unavailable" });
    const [o] = await outputsOf(db, e.s.batch.id);
    expect(o).toMatchObject({ status: "verified", isLive: true });
    // Not counted; the photo is only touched (looked at), so the next sweep's LIMIT starts with others (P3-4).
    expect(await improvementOf(db, e.s.batch.id, o!.sourceImageId)).toMatchObject({ tries: 0, lastTriedAt: null });
    e.service.state.mode = "ok";
    e.w.tasks.splice(0, e.w.tasks.length);
    await sweepAfter(e, IMPROVE_RESEND_MS);
    await drain(e.w, only(e.s));
    expect((await outputsOf(db, e.s.batch.id))[0]!.flags).not.toContain("provisional");
  }, 300_000);

  it("nothing is tried after the window, nor with the upscaler switched off", async () => {
    const e = await provisionalBatch("improve-late");
    await sweep(db, e.w, { enlargementOff: true });
    e.clock.tick(minutes(IMPROVE_FIRST_DELAY_MS));
    await sweep(db, e.w, { enlargementOff: true });
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
    await sweepAfter(e, IMPROVE_WINDOW_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
  }, 300_000);

  it("a product another batch holds is left alone (no reset, no try counted)", async () => {
    const e = await provisionalBatch("improve-busy");
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    const [task] = improveTasks(e, e.s.batch.id);
    const productId = e.outs[0]!.productId;
    const [other] = await db.insert(catalogBatches).values({ brandSlug: e.s.batch.brandSlug, brandName: "Other", name: "other", isTest: true, createdBy: "t@opptra.com", status: "matting", channels: ["trendyol"] }).returning();
    await db.update(catalogProducts).set({ lockBatchId: other!.id }).where(eq(catalogProducts.id, productId));
    expect(await handleImproveTask(e.w.deps, task!.body)).toMatchObject({ httpStatus: 200, outcome: "busy" });
    const [o] = await outputsOf(db, e.s.batch.id);
    expect(o).toMatchObject({ status: "verified", isLive: true });
    expect(await improvementOf(db, e.s.batch.id, o!.sourceImageId)).toBeNull();
    await db.update(catalogProducts).set({ lockBatchId: null }).where(eq(catalogProducts.id, productId));
  }, 300_000);

  it("a batch started before M1-S3 (held, not provisional) is never improved automatically", async () => {
    const e = await provisionalBatch("improve-held", false);
    expect(e.outs[0]).toMatchObject({ status: "needs_attention", isLive: false });
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
  }, 300_000);

  it("while an improvement runs, the done batch's re-opened chunk is not reported as a stuck chunk", async () => {
    const e = await provisionalBatch("improve-invariant");
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    const [task] = improveTasks(e, e.s.batch.id);
    expect(await handleImproveTask(e.w.deps, task!.body)).toMatchObject({ httpStatus: 200, outcome: "improving" });
    const [o] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, e.s.batch.id));
    expect(o!.status).toBe("pending");
    const run = await runInvariants(db, () => {}, e.clock.now(), { batchId: e.s.batch.id });
    expect(run.counts).toMatchObject({ done_batch_with_open_chunk: 0 });
    await drain(e.w, only(e.s));
  }, 300_000);
});

const productOf = async (id: string) => (await db.select().from(catalogProducts).where(eq(catalogProducts.id, id)))[0]!;
const pairOf = async (batchId: string, productId: string) => (await db.select().from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, batchId), eq(catalogBatchProducts.productId, productId))))[0]!;
const finalizeTasks = (e: EnlargeWorld, batchId: string) => e.w.tasks.filter((t) => t.route === "/tasks/catalog/finalize" && t.body.batchId === batchId);

describe("improvement review fixes (2026-11-04)", () => {
  it("P1: once a later batch publishes the product, the older batch's provisional slots are not improved (superseded) and Try again refuses", async () => {
    const e = await provisionalBatch("improve-superseded", true, ["trendyol", "noon"]);
    const productId = e.outs[0]!.productId;
    // A later batch on trendyol only publishes the product; the first batch's noon slot stays live and provisional.
    const second = await seedSecondBatch(db, e.w, e.s, "improve-superseded-2");
    await db.update(catalogBatches).set({ channels: ["trendyol"] }).where(eq(catalogBatches.id, second.batch.id));
    await startChunks(db, e.w, second.chunks.map((c) => c.id));
    await drain(e.w, only(second));
    expect((await batchOf(db, second.batch.id)).status).toBe("done");
    expect(await productOf(productId)).toMatchObject({ lastBatchId: second.batch.id, lockBatchId: null });
    const noon = (await outputsOf(db, e.s.batch.id)).find((o) => o.channel === "noon")!;
    expect(noon).toMatchObject({ isLive: true, status: "verified" });
    expect(noon.flags).toContain("provisional");
    const [trendyol] = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true), eq(catalogOutputs.channel, "trendyol")));
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
    // A task sent before the later batch published retires the candidate and re-makes nothing.
    expect(await handleImproveTask(e.w.deps, { batchId: e.s.batch.id, sourceImageId: noon.sourceImageId })).toMatchObject({ httpStatus: 200, outcome: "superseded" });
    expect(await improvementOf(db, e.s.batch.id, noon.sourceImageId)).toMatchObject({ tries: 0, endReason: "superseded", endedAt: expect.any(Date) });
    expect((await outputsOf(db, e.s.batch.id)).find((o) => o.channel === "noon")).toMatchObject({ status: "verified", isLive: true, generation: noon.generation });
    // The same shape through Try again (audit): refused, nothing re-made.
    await expect(retryEnlargement(db, e.w.deps.enqueue, { outputId: noon.id, actor: "t@opptra.com", now: e.clock.now() })).rejects.toThrow(RETRY_SUPERSEDED);
    expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, trendyol!.id)))[0]).toMatchObject({ isLive: true, generation: trendyol!.generation });
    expect(await productOf(productId)).toMatchObject({ lastBatchId: second.batch.id, lockBatchId: null });
  }, 600_000);

  it("P2-1: a try whose new render a rule drops puts the delivered provisional slot back; the photo stays a candidate", async () => {
    const e = await provisionalBatch("improve-dropped");
    const [before] = e.outs;
    const bytes = publicObject(e, before!.objectPath)!;
    const change = (await pairOf(e.s.batch.id, before!.productId)).change;
    // The batch's rule for a photo that could not be enlarged is now drop, and the upscaler refuses the photo again.
    const batch = await batchOf(db, e.s.batch.id);
    const rules = batch.options.autoDecide!.rules.map((r) => (r.cause === "not_enlarged" ? { ...r, action: "drop" as const } : r));
    await db.update(catalogBatches).set({ options: { ...batch.options, autoDecide: { rules } } }).where(eq(catalogBatches.id, batch.id));
    e.service.state.mode = "badInput";
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(1);
    await drain(e.w, only(e.s));
    const [after] = await outputsOf(db, e.s.batch.id);
    expect(after).toMatchObject({ id: before!.id, status: "verified", isLive: true, generation: before!.generation, publicUrl: before!.publicUrl, reason: before!.reason });
    expect(after!.flags).toEqual(before!.flags);
    expect(publicObject(e, after!.objectPath)!.equals(bytes)).toBe(true);
    expect((await pairOf(e.s.batch.id, before!.productId)).change).toBe(change);
    await sweep(db, e.w);
    expect(await improvementOf(db, e.s.batch.id, after!.sourceImageId)).toMatchObject({ tries: 1, improvedAt: null, previous: null, endedAt: null });
    await sweepAfter(e, IMPROVE_SPACING_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(1);
  }, 600_000);

  it("P2-1: an enlarged render that does not pass is never published over the link; the slot is put back and the photo retired as not_passed", async () => {
    const e = await provisionalBatch("improve-held-again");
    const [before] = e.outs;
    const bytes = publicObject(e, before!.objectPath)!;
    const judge = e.w.deps.judgeOutput;
    const low = Object.fromEntries(Object.entries(DIMENSION_FLAGS).filter(([, flag]) => flag === "product_removed").map(([d]) => [d, 20]));
    e.w.deps.judgeOutput = vi.fn(async (input, llm) => {
      const result = await judge(input, llm);
      return { ...result, verdict: "fail", flags: ["product_removed"] as never, scores: { ...result.scores, ...low } };
    }) as typeof judge;
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    await drain(e.w, only(e.s));
    e.w.deps.judgeOutput = judge;
    expect((await rowsOf(db, e.s.batch.id)).filter((r) => r.wanted).map((r) => r.status)).toContain("done");
    const [after] = await outputsOf(db, e.s.batch.id);
    expect(after).toMatchObject({ id: before!.id, status: "verified", isLive: true, generation: before!.generation });
    expect(after!.flags).toEqual(before!.flags);
    expect(publicObject(e, after!.objectPath)!.equals(bytes)).toBe(true);
    await sweep(db, e.w);
    expect(await improvementOf(db, e.s.batch.id, after!.sourceImageId)).toMatchObject({ tries: 1, improvedAt: null, endReason: "not_passed" });
    await sweepAfter(e, IMPROVE_SPACING_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
  }, 600_000);

  for (const via of ["improvement", "Try again"] as const) {
    it(`P2-2, P2-3 (${via}): a done batch whose re-made product is staged but not published waits (no sheet, lock kept); the re-queue backs off to 10 minutes`, async () => {
      const e = await provisionalBatch(via === "improvement" ? "improve-race-auto" : "improve-race-retry");
      const [o] = e.outs;
      const sheet = (await batchOf(db, e.s.batch.id)).sheetXlsxUri;
      if (via === "improvement") {
        await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
        expect(await handleImproveTask(e.w.deps, improveTasks(e, e.s.batch.id)[0]!.body)).toMatchObject({ outcome: "improving" });
      } else {
        await retryEnlargement(db, e.w.deps.enqueue, { outputId: o!.id, actor: "t@opptra.com", now: e.clock.now() });
        await enqueueFinalize(e.w.deps, e.s.batch.id, undefined, { reopen: true });
      }
      // The race: the re-made chunk is done and its output staged, the publish has not landed.
      await db.update(catalogChunks).set({ status: "done", taskName: null }).where(and(eq(catalogChunks.batchId, e.s.batch.id), eq(catalogChunks.status, "queued")));
      await db.update(catalogOutputs).set({ status: "staged" }).where(eq(catalogOutputs.id, o!.id));
      const waits: number[] = [];
      for (let n = 0; n < 7; n++) {
        e.w.tasks.splice(0, e.w.tasks.length);
        const at = +e.clock.now();
        expect(await handleFinalizeTask(e.w.deps, { batchId: e.s.batch.id })).toMatchObject({ outcome: "not_ready" });
        const [task] = finalizeTasks(e, e.s.batch.id);
        waits.push((+task!.notBefore! - at) / 1000);
        expect(await productOf(o!.productId)).toMatchObject({ lockBatchId: e.s.batch.id });
        expect((await batchOf(db, e.s.batch.id)).sheetXlsxUri).toBe(sheet);
      }
      expect(waits).toEqual([30, 60, 120, 240, 480, FINALIZE_PARKED_WAIT_S, FINALIZE_PARKED_WAIT_S]);
      // Leave nothing locked or staged for the shared sweep of later tests.
      await db.update(catalogOutputs).set({ status: "verified" }).where(eq(catalogOutputs.id, o!.id));
      await db.update(catalogProducts).set({ lockBatchId: null }).where(eq(catalogProducts.id, o!.productId));
    }, 300_000);
  }

});

/** Batch options with the rule for `not_enlarged` set to drop (a later rule change, for the restore tests). */
async function dropNotEnlarged(batchId: string) {
  const batch = await batchOf(db, batchId);
  const rules = batch.options.autoDecide!.rules.map((r) => (r.cause === "not_enlarged" ? { ...r, action: "drop" as const } : r));
  await db.update(catalogBatches).set({ options: { ...batch.options, autoDecide: { rules } } }).where(eq(catalogBatches.id, batchId));
}

describe("improvement review fixes, round 2 (2026-11-04)", () => {
  it("P1-A: Try again refuses when a batch drafted earlier but started later published the product (start order, not creation order)", async () => {
    const e = await provisionalBatch("rv2-a", true, ["trendyol", "noon"]);
    const productId = e.outs[0]!.productId;
    const second = await seedSecondBatch(db, e.w, e.s, "rv2-a-2");
    await db.update(catalogSourceImages).set({ sha256: "f".repeat(64) }).where(eq(catalogSourceImages.batchId, second.batch.id));
    // The later publisher was created (drafted) before the first batch, and started after it.
    await db.update(catalogBatches).set({ createdAt: new Date(+e.s.batch.createdAt - 60_000), startedAt: new Date(Math.max(Date.now(), +(e.s.batch.startedAt ?? e.s.batch.createdAt)) + 60_000), channels: ["trendyol"] }).where(eq(catalogBatches.id, second.batch.id));
    await startChunks(db, e.w, second.chunks.map((c) => c.id));
    await drain(e.w, only(second));
    expect((await batchOf(db, second.batch.id)).status).toBe("done");
    expect(await productOf(productId)).toMatchObject({ lastBatchId: second.batch.id, lockBatchId: null });
    const [trendyol] = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true), eq(catalogOutputs.channel, "trendyol")));
    expect(trendyol!.batchId).toBe(second.batch.id);
    const noon = (await outputsOf(db, e.s.batch.id)).find((o) => o.channel === "noon")!;
    await expect(retryEnlargement(db, e.w.deps.enqueue, { outputId: noon.id, actor: "t@opptra.com", now: e.clock.now() })).rejects.toThrow(RETRY_SUPERSEDED);
    await drain(e.w, only(e.s));
    expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, trendyol!.id)))[0]).toMatchObject({ isLive: true, generation: trendyol!.generation });
    expect(await productOf(productId)).toMatchObject({ lastBatchId: second.batch.id, lockBatchId: null });
    expect((await outputsOf(db, e.s.batch.id)).every((o) => o.status !== "pending")).toBe(true);
  }, 600_000);

  it("P2: Try again on an auto-decide provisional slot whose re-made slot a rule drops puts the delivered slot back", async () => {
    const e = await provisionalBatch("rv2-retry-drop");
    const [before] = e.outs;
    const bytes = publicObject(e, before!.objectPath)!;
    await dropNotEnlarged(e.s.batch.id);
    e.service.state.mode = "badInput";
    await retryEnlargement(db, e.w.deps.enqueue, { outputId: before!.id, actor: "t@opptra.com", now: e.clock.now() });
    await enqueueFinalize(e.w.deps, e.s.batch.id, undefined, { reopen: true });
    await drain(e.w, only(e.s));
    const [after] = await outputsOf(db, e.s.batch.id);
    expect(after).toMatchObject({ id: before!.id, status: "verified", isLive: true, generation: before!.generation });
    expect(after!.flags).toEqual(before!.flags);
    expect(publicObject(e, after!.objectPath)!.equals(bytes)).toBe(true);
    expect(await productOf(before!.productId)).toMatchObject({ lockBatchId: null });
  }, 600_000);
});

describe("improvement review fixes, round 3 (2026-11-04)", () => {
  it("P2-1: a product in a draft batch waiting for Start is not improved, so the try never blocks the operator's Start", async () => {
    const e = await provisionalBatch("rv3-draft");
    const [o] = e.outs;
    const [draft] = await db.insert(catalogBatches).values({ brandSlug: e.s.batch.brandSlug, brandName: "Draft", name: "rv3-draft-next", isTest: true, createdBy: "t@opptra.com", status: "draft", channels: ["trendyol"], counts: { ...e.s.batch.counts, previewReady: true } }).returning();
    await db.insert(catalogBatchProducts).values({ batchId: draft!.id, productId: o!.productId, change: "updated" });
    await sweepAfter(e, IMPROVE_FIRST_DELAY_MS);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(0);
    expect(await handleImproveTask(e.w.deps, { batchId: e.s.batch.id, sourceImageId: o!.sourceImageId })).toMatchObject({ outcome: "busy" });
    expect(await productOf(o!.productId)).toMatchObject({ lockBatchId: null });
    // The draft is started or dropped: the photo is a candidate again.
    await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, draft!.id));
    await sweepAfter(e, 10 * 60_000);
    expect(improveTasks(e, e.s.batch.id)).toHaveLength(1);
  }, 300_000);
});
