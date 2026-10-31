// Tier 2 (PGlite + fakes): T39, the spec 18 end-to-end queue test (plan section 6), on the model in
// test/enlarge-model.ts. T40, the lifecycle state machine on the same model, runs in enlarge.model.t40-<n>.test.ts.
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { catalogEnlargements, catalogOutputs } from "@catalog/core/db/schema";
import { ENLARGE_MAX_TIMEOUTS, ENLARGE_TASK_MAX_ATTEMPTS } from "@catalog/core/catalog/pipeline/enlargement";
import { batchOf, enlargeWorld, outputsOf, seedEnlargeBatch, startChunks, sweep } from "../../test/enlarge-world";
import { check, deliverNext, lcg, quiet, useModelDb, type Model } from "../../test/enlarge-model";

const getDb = useModelDb();

describe("T39: end to end through the queue", () => {
  it("the real render, one forced terminal product: zero silent outputs, every parked chunk's render queued once, the held product has enlargement_failed", async () => {
    const db = getDb();
    const e = enlargeWorld(db);
    const s = await seedEnlargeBatch(db, e.w, "t39", [[1, 1], [1]]);
    const terminal = s.chunks[0]!.productIds[1]!;
    e.service.state.mode = "crashOnThisInput";
    e.service.state.poison.add(terminal);
    const m: Model = { e, s, rnd: lcg(39), off: false, arm: { renderHang: false, callHang: false, callKill: false, uploadFail: false, complianceFail: false, productRemoved: false, jitter: false, enqueueFail: false }, broken: new Set(), inFlight: new Map(), trail: [] };
    await startChunks(db, e.w, s.chunks.map((c) => c.id));
    for (let hours = 0; hours <= 48; hours += 0.5) {
      for (let n = 0; n < 400 && (await deliverNext(m)); n++) await check(m);
      if (await quiet(s.batch.id, e)) break;
      e.clock.tick(30);
      await sweep(db, e.w);
    }
    expect((await batchOf(db, s.batch.id)).status).toBe("done");
    const outputs = await outputsOf(db, s.batch.id);
    // Zero silent: every output is upscaled, or held with enlargement_failed.
    for (const o of outputs) expect(o.flags.includes("upscaled") || (o.status === "needs_attention" && o.flags.includes("enlargement_failed")), `output ${o.id}`).toBe(true);
    const held = outputs.filter((o) => o.productId === terminal);
    expect(held.map((o) => [o.status, o.flags.includes("enlargement_failed")])).toEqual([["needs_attention", true]]);
    expect(outputs.filter((o) => o.productId !== terminal).every((o) => o.status === "verified")).toBe(true);
    const rows = await db.select().from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, s.batch.id), eq(catalogEnlargements.productId, terminal)));
    // A crash on this input with a healthy service is counted (3.4 step 9): terminal at a counter's cap.
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
    expect(rows[0]!.attempts === ENLARGE_TASK_MAX_ATTEMPTS || rows[0]!.timeouts === ENLARGE_MAX_TIMEOUTS).toBe(true);
    // Every parked chunk's render was queued once after its rows settled (one "chunk enlarged" per chunk).
    const enlarged = e.w.log.mock.calls.filter(([message]) => message === "chunk enlarged").map(([, fields]) => fields?.chunkId as string);
    for (const c of s.chunks) expect(enlarged.filter((id) => id === c.id).length, `chunk ${c.id}`).toBeLessThanOrEqual(1);
    const renders = e.w.enqueue.mock.calls.filter(([route, body]) => route === "/tasks/catalog/chunk" && body.stage === "render").map(([, body]) => body.chunkId as string);
    for (const c of s.chunks) expect(renders.filter((id) => id === c.id).length, `render tasks of chunk ${c.id}`).toBe(1);
    expect((await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.batch.id), isNull(catalogOutputs.decision), eq(catalogOutputs.status, "pending")))).length).toBe(0);
  }, 600_000);
});
