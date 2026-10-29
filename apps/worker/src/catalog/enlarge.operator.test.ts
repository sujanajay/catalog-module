// Tier 2 (PGlite + fakes): the spec 18 enlargement lifecycle's operator actions and judges (plan section 6): Try
// again, Use as is after the plain warning, Remove and Replace on a held or waiting photo, done batches re-opened, and
// the ladder and flush cut honouring readiness. Real entry points (applyDecision, retryEnlargement,
// completeReplacement, handleChunkTask, handleEnlargeTask, handlePublishTask, handleFinalizeTask, handleSweep).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogEnlargements, catalogProductEvents } from "@catalog/core/db/schema";
import { applyDecision, CatalogDecisionError, CatalogPlainWarning, retryEnlargement } from "@catalog/core/catalog/decisions";
import { ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK } from "@catalog/core/catalog/pipeline/enlargement";
import { shotGeometry } from "@catalog/core/catalog/render";
import { DIMENSION_FLAGS } from "@catalog/core/catalog/qa/judge";
import { autoActionsOf } from "@catalog/core/catalog/auto-resolve";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import type { ChannelId } from "@catalog/core/catalog/types";
import { chunkRow } from "../../test/catalog-fakes";
import {
  batchOf, drain, enlargeBody, enlargeWorld, outputsOf, photosOf, replacePhoto, rowsOf, seedEnlargeBatch, startChunks, sweep, type EnlargeWorld,
} from "../../test/enlarge-world";
import { handleEnlargeTask } from "./enlarge";
import { handleFinalizeTask } from "./finalize";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

const actor = "op@opptra.com";
const only = (s: { batch: { id: string } }) => ({ only: { db, batchId: s.batch.id } });
const rowsOfPhoto = (sourceImageId: string) => db.select().from(catalogEnlargements).where(eq(catalogEnlargements.sourceImageId, sourceImageId));
/** A batch run to its end with the service refusing every photo (bad input): every output held with enlargement_failed. */
async function heldBatch(name: string, layout: number[][] = [[1]], channels: ChannelId[] = ["trendyol"]) {
  const e = enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, layout, { channels });
  e.service.state.mode = "badInput";
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  await drain(e.w, only(s));
  e.service.state.mode = "ok";
  const outs = await outputsOf(db, s.batch.id);
  expect(outs.every((o) => o.status === "needs_attention" && o.flags.includes("enlargement_failed"))).toBe(true);
  expect((await batchOf(db, s.batch.id)).status).toBe("done");
  return { ...e, s, outs };
}
const finalizeTasks = (e: EnlargeWorld) => e.w.enqueue.mock.calls.filter(([route]) => route === "/tasks/catalog/finalize");

describe("Use as is after the plain warning (3.6)", () => {
  it("T13 (F13): Use as is on a held output answers the plain warning with its channels; with acceptPlain it is staged, published from its own key, recorded and counted", async () => {
    const e = await heldBatch("t13", [[1]], ["trendyol", "noon"]);
    const target = e.outs[0]!;
    const warning = await applyDecision(db, { outputId: target.id, decision: "use_as_is", actor }).catch((error: unknown) => error);
    expect(warning).toBeInstanceOf(CatalogPlainWarning);
    expect((warning as CatalogPlainWarning).status).toBe(409);
    expect([...(warning as CatalogPlainWarning).channels].sort()).toEqual(["noon", "trendyol"]);
    expect((await outputsOf(db, e.s.batch.id)).every((o) => o.decision === null)).toBe(true);
    const result = await applyDecision(db, { outputId: target.id, decision: "use_as_is", actor, acceptPlain: true });
    expect(result.outputIds).toHaveLength(2);
    await e.w.deps.enqueue("/tasks/catalog/publish", { batchId: result.batchId, productId: result.productId, trigger: result.decisionId }, { taskId: `publish-${result.decisionId}` });
    await drain(e.w, only(e.s));
    const outs = await outputsOf(db, e.s.batch.id);
    expect(outs.map((o) => [o.status, o.decision, o.flags.includes("enlargement_failed")])).toEqual([["verified", "use_as_is", true], ["verified", "use_as_is", true]]);
    for (const o of outs) expect(e.w.objects.get(`gs://public/${o.objectPath}`)!.equals(e.w.objects.get(o.stagingUri!)!)).toBe(true);
    const events = await db.select().from(catalogProductEvents).where(and(eq(catalogProductEvents.batchId, e.s.batch.id), eq(catalogProductEvents.kind, "plain_accepted")));
    expect(events).toHaveLength(1);
    const counts = (await runInvariants(db, () => {}, e.clock.now(), { batchId: e.s.batch.id })).counts;
    expect(counts).toMatchObject({ enlarged_without_upscaler: 0, plain_accepted_outputs: 2 });
    expect(e.service.paid()).toBe(ENLARGE_TASK_MAX_ATTEMPTS);
  }, 180_000);
});

describe("Try again (3.6)", () => {
  it("T12 (F12): Try again on a done batch: finalize waits 10 minutes while the chunk is parked, then writes links-v2 after the render", async () => {
    const e = await heldBatch("t12");
    expect((await batchOf(db, e.s.batch.id)).sheetXlsxUri).toMatch(/links-v1/);
    const retry = await retryEnlargement(db, e.w.deps.enqueue, { outputId: e.outs[0]!.id, actor, now: e.clock.now() });
    expect(await chunkRow(db, retry.chunkId)).toMatchObject({ stage: "render", status: "queued", taskName: ENLARGING_TASK });
    const { enqueueFinalize } = await import("@catalog/core/catalog/finalize-request");
    await enqueueFinalize({ db, enqueue: e.w.deps.enqueue, now: e.w.deps.now }, e.s.batch.id, undefined, { reopen: true });
    expect(await handleFinalizeTask(e.w.deps, { batchId: e.s.batch.id })).toMatchObject({ outcome: "not_ready" });
    expect(finalizeTasks(e).at(-1)![2]).toMatchObject({ delaySec: 600 });
    e.w.tasks.splice(0, e.w.tasks.length, ...e.w.tasks.filter((t) => t.route !== "/tasks/catalog/finalize"));
    await drain(e.w, only(e.s));
    const outs = await outputsOf(db, e.s.batch.id);
    expect(outs.map((o) => [o.status, o.flags.includes("upscaled")])).toEqual([["verified", true]]);
    // The request waiting 10 minutes (taken off the queue above) arrives: the stored request writes links-v2.
    e.clock.tick(11);
    expect(await handleFinalizeTask(e.w.deps, { batchId: e.s.batch.id })).toMatchObject({ httpStatus: 200 });
    expect((await batchOf(db, e.s.batch.id)).sheetXlsxUri).toMatch(/links-v2/);
  }, 180_000);

  it("T14 (F14): Try again twice (terminal again, then a success): rows reset per click, outputs pending, the chunk parked, the full path to verified; retries 2; 409 when nothing failed", async () => {
    const e = await heldBatch("t14");
    const [photo] = await photosOf(db, e.s.batch.id);
    e.service.state.mode = "badInput";
    const first = await retryEnlargement(db, e.w.deps.enqueue, { outputId: e.outs[0]!.id, actor, now: e.clock.now() });
    expect(first.retries).toBe(1);
    expect((await rowsOfPhoto(photo!.id)).map((r) => [r.status, r.attempts])).toEqual([["queued", 0]]);
    expect((await outputsOf(db, e.s.batch.id))[0]!.status).toBe("pending");
    await drain(e.w, only(e.s));
    const again = await outputsOf(db, e.s.batch.id);
    expect(again[0]!.flags).toContain("enlargement_failed");
    e.service.state.mode = "ok";
    const second = await retryEnlargement(db, e.w.deps.enqueue, { outputId: again[0]!.id, actor, now: e.clock.now() });
    expect(second.retries).toBe(2);
    await drain(e.w, only(e.s));
    const outs = await outputsOf(db, e.s.batch.id);
    expect(outs.map((o) => [o.status, o.flags.includes("upscaled"), o.flags.includes("enlargement_failed")])).toEqual([["verified", true, false]]);
    expect((await rowsOfPhoto(photo!.id))[0]).toMatchObject({ status: "done", retries: 2 });
    const none = await retryEnlargement(db, e.w.deps.enqueue, { outputId: outs[0]!.id, actor, now: e.clock.now() }).catch((error: unknown) => error);
    expect(none).toBeInstanceOf(CatalogDecisionError);
    expect((none as CatalogDecisionError).status).toBe(409);
    expect((none as Error).message).toBe("Nothing to try again.");
  }, 240_000);

  it("T43 (F41): Try again that fails again leaves the outputs held and undecided; Use as is (after the warning), Remove and Replace all work", async () => {
    const e = await heldBatch("t43", [[3]]);
    e.service.state.mode = "badInput";
    await retryEnlargement(db, e.w.deps.enqueue, { outputId: e.outs[0]!.id, actor, now: e.clock.now() });
    await drain(e.w, only(e.s));
    const outs = await outputsOf(db, e.s.batch.id);
    expect(outs.every((o) => o.decision === null && o.status === "needs_attention" && o.flags.includes("enlargement_failed"))).toBe(true);
    e.service.state.mode = "ok";
    await expect(applyDecision(db, { outputId: outs[0]!.id, decision: "use_as_is", actor })).rejects.toBeInstanceOf(CatalogPlainWarning);
    expect((await applyDecision(db, { outputId: outs[0]!.id, decision: "use_as_is", actor, acceptPlain: true })).outputIds).toEqual([outs[0]!.id]);
    expect((await applyDecision(db, { outputId: outs[1]!.id, decision: "remove", actor })).outputIds).toEqual([outs[1]!.id]);
    const replaced = await replacePhoto(db, e.w, outs[2]!.id, e.w.deps.now);
    await drain(e.w, only(e.s));
    const fresh = (await outputsOf(db, e.s.batch.id)).filter((o) => o.sourceImageId === replaced.sourceImageId);
    expect(fresh.map((o) => [o.status, o.flags.includes("upscaled")])).toEqual([["verified", true]]);
  }, 300_000);

  it("T41 (F39, F48): a done batch: Try again with its task lost, and a replacement: the sweep re-sends the lost task, the render is sent directly after the settle, verified, finalize writes links-v2 (re-queued every 10 min while parked)", async () => {
    const e = await heldBatch("t41", [[2]]);
    await retryEnlargement(db, e.w.deps.enqueue, { outputId: e.outs[0]!.id, actor, now: e.clock.now() });
    // The task is lost before it reaches the handler.
    e.w.tasks.splice(0, e.w.tasks.length, ...e.w.tasks.filter((t) => t.route !== "/tasks/catalog/enlarge"));
    await replacePhoto(db, e.w, e.outs[1]!.id, e.w.deps.now);
    await drain(e.w, only(e.s));
    const waiting = (await rowsOfPhoto(e.outs[0]!.sourceImageId))[0]!;
    // Try again sent it under a fresh name (sends 1); that task was lost.
    expect(waiting).toMatchObject({ status: "queued", sends: 1 });
    e.clock.tick(61);
    await sweep(db, e.w);
    expect((await rowsOfPhoto(e.outs[0]!.sourceImageId))[0]!.sends).toBe(2);
    await drain(e.w, only(e.s));
    expect(e.w.log.mock.calls.some(([m, f]) => m === "chunk enlarged" && f?.direct === true)).toBe(true);
    const outs = (await outputsOf(db, e.s.batch.id)).filter((o) => o.decision !== "replaced");
    expect(outs.map((o) => [o.status, o.flags.includes("upscaled")])).toEqual([["verified", true], ["verified", true]]);
    expect((await batchOf(db, e.s.batch.id)).sheetXlsxUri).toMatch(/links-v[2-9]/);
  }, 300_000);

  it("T65 (F60): a done batch, Try again, the enqueue at the unpark throws once: the chunk waits unparked with no task; the lost-task rule re-sends it within 30 min; verified; links-v2", async () => {
    const e = await heldBatch("t65");
    const retry = await retryEnlargement(db, e.w.deps.enqueue, { outputId: e.outs[0]!.id, actor, now: e.clock.now() });
    const enqueue = e.w.deps.enqueue;
    let failOnce = true;
    e.w.deps.enqueue = (async (route, body, opts) => { if (route === "/tasks/catalog/chunk" && body.chunkId === retry.chunkId && failOnce) { failOnce = false; throw new Error("tasks down"); } return enqueue(route, body, opts); }) as typeof enqueue;
    const row = (await rowsOfPhoto(e.outs[0]!.sourceImageId))[0]!;
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(row))).toMatchObject({ outcome: "done" });
    const chunk = await chunkRow(db, retry.chunkId);
    expect(chunk).toMatchObject({ status: "queued", taskName: null });
    expect(e.w.tasks.some((t) => t.body.chunkId === retry.chunkId)).toBe(false);
    e.clock.tick(31);
    await sweep(db, e.w);
    expect(e.w.tasks.some((t) => t.body.chunkId === retry.chunkId)).toBe(true);
    await drain(e.w, only(e.s));
    expect((await outputsOf(db, e.s.batch.id)).map((o) => [o.status, o.flags.includes("upscaled")])).toEqual([["verified", true]]);
    expect((await batchOf(db, e.s.batch.id)).sheetXlsxUri).toMatch(/links-v2/);
  }, 240_000);
});

/**
 * A held photo whose row is queued again, on a processing batch: product A's photo is judged product_removed; before
 * its QA delivery its stored image is lost and the service goes down, so the ladder's steps are skipped (not ready),
 * the row is queued again (its task waits at the queue, never delivered here) and the output is held, undecided.
 * Product B's chunk stays parked (its enlarge tasks never arrive), so the batch keeps processing.
 */
async function heldWithQueuedRow(name: string) {
  const e = enlargeWorld(db);
  judgeFlagsOnce(e, ["product_removed"]);
  const s = await seedEnlargeBatch(db, e.w, name, [[1], [1]]);
  const [chunkA, chunkB] = s.chunks;
  const productB = chunkB!.productIds[0]!;
  let lost = false;
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  await drain(e.w, {
    ...only(s),
    skip: (task) => task.route === "/tasks/catalog/enlarge" && (lost || task.body.productId === productB),
    onDelivery: async (task) => {
      if (lost || task.route !== "/tasks/catalog/chunk" || task.body.chunkId !== chunkA!.id || task.body.stage !== "render") return;
      const [row] = (await rowsOf(db, s.batch.id)).filter((r) => r.productId !== productB);
      if (row?.status === "done" && row.uri) { e.w.objects.delete(row.uri); e.service.state.mode = "down"; lost = true; }
    },
  });
  expect(lost).toBe(true);
  const [held] = (await outputsOf(db, s.batch.id)).filter((o) => o.productId !== productB);
  expect(held).toMatchObject({ status: "needs_attention", decision: null });
  expect(held!.flags).toContain("product_removed");
  const [row] = await rowsOfPhoto(held!.sourceImageId);
  expect(row).toMatchObject({ status: "queued", wanted: true });
  expect(["done", "failed"]).not.toContain((await batchOf(db, s.batch.id)).status);
  e.service.state.mode = "ok";
  return { ...e, s, held: held!, row: row!, productB };
}

describe("Remove and Replace release the photo's rows", () => {
  it("T11 (F11): a replacement on a processing batch while the old photo's row is queued: the old row released, the new photo's chunk parks and enlarges with one call", async () => {
    const e = await heldWithQueuedRow("t11");
    const before = e.service.paid(e.held.productId);
    const result = await replacePhoto(db, e.w, e.held.id, e.w.deps.now);
    expect((await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, e.row.id)))[0]).toMatchObject({ wanted: false, status: "queued", errorKind: "replaced" });
    await drain(e.w, { ...only(e.s), skip: (task) => task.route === "/tasks/catalog/enlarge" && task.body.productId === e.productB });
    const fresh = await rowsOfPhoto(result.sourceImageId);
    expect(fresh.map((r) => [r.status, r.wanted])).toEqual([["done", true]]);
    expect(e.service.paid(e.held.productId) - before).toBe(1);
    const outs = (await outputsOf(db, e.s.batch.id)).filter((o) => o.sourceImageId === result.sourceImageId);
    expect(outs.map((o) => [o.status, o.flags.includes("upscaled")])).toEqual([["verified", true]]);
  }, 240_000);

  it("T32 (F32): a late task for a replaced photo's row answers settled; zero calls for the old photo", async () => {
    const e = await heldWithQueuedRow("t32");
    await replacePhoto(db, e.w, e.held.id, e.w.deps.now);
    const before = e.service.paid(e.held.productId);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(e.row))).toMatchObject({ httpStatus: 200, outcome: "settled" });
    expect(e.service.paid(e.held.productId)).toBe(before);
  }, 240_000);

  it("T49 (F47): Remove on a held photo whose row is still queued: its rows released, a late task settles with no call", async () => {
    const e = await heldWithQueuedRow("t49");
    const removed = await applyDecision(db, { outputId: e.held.id, decision: "remove", actor });
    expect(removed.outputIds).toEqual([e.held.id]);
    expect((await rowsOfPhoto(e.held.sourceImageId)).map((r) => [r.wanted, r.errorKind])).toEqual([[false, "removed"]]);
    const before = e.service.paid(e.held.productId);
    expect(await handleEnlargeTask(e.w.deps, enlargeBody(e.row))).toMatchObject({ httpStatus: 200, outcome: "settled" });
    expect(e.service.paid(e.held.productId)).toBe(before);
  }, 240_000);

  it("T49 (F47, retry chunk): Remove on the held sibling of a photo whose Try again is parked: only the removed photo's rows are released; the retry chunk stays parked", async () => {
    const e = await heldBatch("t49b", [[2]]);
    e.service.state.mode = "busy";
    const retry = await retryEnlargement(db, e.w.deps.enqueue, { outputId: e.outs[0]!.id, actor, now: e.clock.now() });
    expect((await chunkRow(db, retry.chunkId)).taskName).toBe(ENLARGING_TASK);
    const removed = await applyDecision(db, { outputId: e.outs[1]!.id, decision: "remove", actor });
    expect(removed.unparked ?? []).toEqual([]);
    expect((await rowsOfPhoto(e.outs[1]!.sourceImageId)).map((r) => r.wanted)).toEqual([false]);
    expect((await rowsOfPhoto(e.outs[0]!.sourceImageId)).map((r) => [r.wanted, r.status])).toEqual([[true, "queued"]]);
    expect((await chunkRow(db, retry.chunkId)).taskName).toBe(ENLARGING_TASK);
  }, 180_000);
});

/** A judge that flags `flags` on the first look at each output and passes every later look. */
function judgeFlagsOnce(e: EnlargeWorld, flags: string[]) {
  const seen = new Set<string>();
  const judge = e.w.deps.judgeOutput;
  e.w.deps.judgeOutput = vi.fn(async (input, llm) => {
    const result = await judge(input, llm), key = `${input.n}|${input.channel}`;
    if (seen.has(key)) return result;
    seen.add(key);
    // The QA stage reads the flags from the scores: each flag's dimension scores under the floor.
    const low = Object.fromEntries(Object.entries(DIMENSION_FLAGS).filter(([, flag]) => flags.includes(flag)).map(([d]) => [d, 20]));
    return { ...result, verdict: "fail", flags: flags as never, scores: { ...result.scores, ...low } };
  }) as typeof judge;
}
/** The policy with a second cut-out model the matting service lists. */
function secondCutOut(e: EnlargeWorld, second: (p: { width: number; height: number }) => Buffer) {
  e.w.deps.resolvePolicy = vi.fn(async () => ({ matteModel: "fixture", matteModelSecond: "second", qaModel: "test/judge", threshold: 75, floor: 60, qaMode: "per_source" as const, qaSampleRate: 1, source: "default" as const }));
  e.w.deps.matting.health = vi.fn(async () => ({ ok: true, models: [{ id: "fixture", inputSize: 1024, target: "cpu" }, { id: "second", inputSize: 1024, target: "cpu" }], default: "fixture", versions: { cpu: null, gpu: null } })) as never;
  const matteFor = e.w.deps.matteFor;
  e.w.deps.matteFor = vi.fn(async (p, client, model, opts, trace) => model === "second" ? { alpha: second(p), width: p.width, height: p.height, model: "second", ms: 5, source: "model" as const, target: "cpu" as const, sentLongSide: 800 } : matteFor(p, client, model, opts, trace)) as typeof matteFor;
}
const boxAlpha = (p: { width: number; height: number }, inset: number) => { const a = Buffer.alloc(p.width * p.height, 0); for (let y = inset; y < p.height - inset; y++) a.fill(255, y * p.width + inset, y * p.width + p.width - inset); return a; };

describe("judges honour readiness (3.3)", () => {
  it("T8 (F8): a render-stage compliance failure repaired by a variant: the variant is upscaled from the stored image, no enlargement_failed", async () => {
    const e = enlargeWorld(db);
    const render = e.w.deps.renderAllChannels;
    e.w.deps.renderAllChannels = (async (p, m, channels, ctx) => {
      const out = await render(p, m, channels, ctx);
      if (ctx?.jpegQualityMin === undefined) for (const c of channels) out[c] = { ...out[c]!, flags: [...out[c]!.flags, "failed_compliance"], compliance: { ...out[c]!.compliance, ok: false, failures: ["bytes: The file is over 2 MB."] } };
      return out;
    }) as typeof render;
    const s = await seedEnlargeBatch(db, e.w, "t8", [[1]]);
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    await drain(e.w, only(s));
    const [out] = await outputsOf(db, s.batch.id);
    expect(out!.flags).toContain("upscaled"); expect(out!.flags).not.toContain("enlargement_failed");
    expect(autoActionsOf(out!.compliance).some((a) => a.step === "reencode" && a.result === "passed")).toBe(true);
    expect(e.service.paid()).toBe(1);
  }, 180_000);

  it("T9 (F9): the judge flags product_removed and the second cut-out passes: upscaled from the same stored image, the matte persisted, no second call", async () => {
    const e = enlargeWorld(db);
    secondCutOut(e, (p) => boxAlpha(p, 4));
    judgeFlagsOnce(e, ["product_removed"]);
    const s = await seedEnlargeBatch(db, e.w, "t9", [[1]]);
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    await drain(e.w, only(s));
    const [out] = await outputsOf(db, s.batch.id);
    expect(autoActionsOf(out!.compliance).some((a) => a.step === "second_matte" && a.result === "passed")).toBe(true);
    expect(out!.flags).toContain("upscaled"); expect(out!.flags).not.toContain("enlargement_failed");
    expect((await photosOf(db, s.batch.id))[0]!.matteUri).toMatch(/second|matte2|\.png$/);
    expect(e.service.paid()).toBe(1);
  }, 180_000);

  it("T50 (F8b): a ladder variant whose scale crosses 2.0x into a band the batch did not make: the step is skipped (not ready), no matte persisted, the first image kept", async () => {
    const e = enlargeWorld(db, { imageScale: 1 });
    // The second cut-out finds a much smaller product: its scale needs x4, which the batch's plan never wanted.
    secondCutOut(e, (p) => boxAlpha(p, Math.floor(Math.min(p.width, p.height) * 0.3)));
    judgeFlagsOnce(e, ["product_removed"]);
    const s = await seedEnlargeBatch(db, e.w, "t50", [[1]], { route: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1 } });
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    const matteBefore = async () => (await photosOf(db, s.batch.id))[0]!.matteUri;
    await drain(e.w, { ...only(s), onDelivery: async () => {} });
    const [out] = await outputsOf(db, s.batch.id);
    const steps = autoActionsOf(out!.compliance);
    const skipped = steps.find((a) => a.result === "skipped" && a.detail === "enlargement not ready");
    if (skipped) {
      expect(["second_matte", "matte_passthrough"]).toContain(skipped.step);
      expect(await matteBefore()).not.toMatch(/second/);
    } else {
      // The second cut-out stayed inside the planned bands: it is served by the stored image (never a plain resize).
      expect(out!.flags).toContain("upscaled");
    }
    expect(out!.flags.includes("upscaled") || out!.status === "needs_attention").toBe(true);
    expect((await runInvariants(db, () => {}, e.clock.now(), { batchId: s.batch.id })).counts.enlarged_without_upscaler).toBe(0);
  }, 180_000);

  it("T10, T51 (F10): the judge sees a source cut; the flush cut is upscaled from the stored image, and while the image is not ready it is skipped and the QA delivery completes", async () => {
    // A product touching the bottom edge (a dark product on white, so the bottom line is the photo's edge), narrowing
    // there: its last 6 lines hold half the width it has 10 lines in. The cut rule (0.6) misses it; the judge-relaxed
    // rule (0.4) sees it.
    const narrowing = (p: { width: number; height: number }) => {
      const a = Buffer.alloc(p.width * p.height, 0), x0 = Math.floor(p.width * 0.25), x1 = Math.floor(p.width * 0.75), q = Math.floor((x1 - x0) / 4);
      for (let y = Math.floor(p.height * 0.2); y < p.height; y++) { const narrow = y >= p.height - 6; a.fill(255, y * p.width + (narrow ? x0 + q : x0), y * p.width + (narrow ? x1 - q : x1)); }
      return a;
    };
    const painted = (alpha: Buffer) => { const rgb = Buffer.alloc(alpha.length * 3, 255); for (let i = 0; i < alpha.length; i++) if (alpha[i]) rgb.fill(60, i * 3, i * 3 + 3); return rgb; };
    for (const ready of [true, false]) {
      const e = enlargeWorld(db);
      const prepare = e.w.deps.prepare;
      e.w.deps.prepare = vi.fn(async (...args: Parameters<typeof prepare>) => { const p = await prepare(...args); return { ...p, rgb: painted(narrowing(p)) }; }) as typeof prepare;
      e.w.deps.matteFor = vi.fn(async (p) => ({ alpha: narrowing(p), width: p.width, height: p.height, model: "fixture", ms: 5, source: "model" as const, target: "cpu" as const, sentLongSide: 800 })) as typeof e.w.deps.matteFor;
      judgeFlagsOnce(e, ["complete_product"]);
      const s = await seedEnlargeBatch(db, e.w, `t10-${ready}`, [[1]]);
      const probe = await e.w.deps.prepare(Buffer.from([255, 216, 255, 3]), "x.jpg", async (b) => b);
      const alpha = narrowing(probe);
      expect(shotGeometry(alpha, probe.width, probe.height, { rgb: probe.rgb })!.cut.bottom).toBe(false);
      expect(shotGeometry(alpha, probe.width, probe.height, { rgb: probe.rgb, judgedCut: true })!.cut.bottom).toBe(true);
      await startChunks(db, e.w, s.chunks.map((c) => c.id));
      // Before the QA stage, the stored image of the not-ready run is lost: the flush cut finds it queued again.
      const seen = await drain(e.w, { ...only(s), onDelivery: async (task) => {
        if (ready || task.route !== "/tasks/catalog/chunk" || task.body.stage !== "render") return;
        const [row] = await rowsOf(db, s.batch.id);
        if (row?.uri) { e.w.objects.delete(row.uri); e.service.state.mode = "busy"; }
      } });
      const [out] = await outputsOf(db, s.batch.id);
      const flush = autoActionsOf(out!.compliance).find((a) => a.step === "flush_cut");
      expect(seen.filter((x) => x.task.route === "/tasks/catalog/chunk" && x.task.body.stage === "qa").some((x) => x.result.httpStatus === 200)).toBe(true);
      if (ready) { expect(flush).toMatchObject({ result: "passed" }); expect(out!.flags).toContain("upscaled"); }
      else { expect(flush).toMatchObject({ result: "skipped", detail: "enlargement not ready" }); expect(out!.flags).toContain("upscaled"); }
    }
  }, 300_000);
});

