// M1-S4 (M1-F3-R4, R5; F3 test 2 in the shape spec 18 allows): an auto-decide batch whose upscaler could not enlarge a
// photo delivers the plain render `provisional` (M1-S3). Once the upscaler works again, the sweep sends an improvement
// task (`/tasks/catalog/improve`) for the slot; it re-makes the enlargement and republishes at the same public URL with a
// new object generation, and the `provisional` flag clears. Tries are bounded (3 over 72 hours, spaced); a try is
// counted only when the upscaler answers its health probe; a product another batch holds is left alone.
// Tier 2 (PGlite + fakes), the same world as the spec 18 operator tests.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogOutputs, catalogProducts } from "@catalog/core/db/schema";
import { autoDecideSnapshot } from "@catalog/core/catalog/auto-decide";
import { IMPROVE_FIRST_DELAY_MS, IMPROVE_MAX_TRIES, IMPROVE_SPACING_MS, IMPROVE_WINDOW_MS, improvementOf } from "@catalog/core/catalog/improve";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import { batchOf, drain, enlargeWorld, outputsOf, seedEnlargeBatch, startChunks, sweep, type EnlargeWorld } from "../../test/enlarge-world";
import { handleImproveTask, IMPROVE_RESEND_MS, IMPROVE_ROUTE } from "./improve";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

const minutes = (ms: number) => ms / 60_000;
const only = (s: { batch: { id: string } }) => ({ only: { db, batchId: s.batch.id } });
const improveTasks = (e: EnlargeWorld, batchId: string) => e.w.tasks.filter((t) => t.route === IMPROVE_ROUTE && t.body.batchId === batchId);
const publicObject = (e: EnlargeWorld, objectPath: string) => e.w.objects.get(`gs://public/${objectPath}`);

/**
 * An auto-decide batch run to its end with the upscaler refusing every photo: each slot delivered as the plain render,
 * `provisional`, live at its stable public path.
 */
async function provisionalBatch(name: string, auto = true) {
  const e = enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, [[1]], { channels: ["trendyol"] });
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
    expect(await improvementOf(db, e.s.batch.id, o!.sourceImageId)).toBeNull();
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
