// M1-S4b review fixes (PR #172): the health ledger under many writers at once, the sweep's bounded probe and deadline
// pass, and the outage deadline racing a delivery's settle on the same product. Runs on the TEST_PG_URL server when set
// (the CI "real Postgres tests" job: a pool of 4 connections, so the writes really overlap), else on PGlite (one
// connection: the same assertions, serialized). The deadline-versus-settle test needs two connections and runs only on
// real Postgres.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogChunks, catalogEnlargements, catalogIncidents, catalogProducts, catalogSourceImages, catalogUpscalerHealth } from "../db/schema";
import { createRealTestDb, createTestDb, TEST_PG_URL } from "../db/testing";
import { ENLARGING_TASK, lockProductChunks } from "./pipeline/enlargement";
import { applyOutageDeadline, assessUpscalerOutages, observationClass, readUpscalerHealth, recordUpscalerObservation, type OutageAssessment, type UpscalerObservation } from "./upscaler-health";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = TEST_PG_URL ? await createRealTestDb() : await createTestDb()); }, 120_000);
afterAll(async () => { await close(); });
beforeEach(async () => {
  await db.delete(catalogUpscalerHealth);
  await db.update(catalogBatches).set({ status: "cancelled" });
});

const T = Date.parse("2026-11-05T06:00:00Z");
const at = (minutes: number) => new Date(T + minutes * 60_000);
const KINDS: UpscalerObservation[] = ["ok", "busy", "call_ok", "call_busy", "absent", "timeout", "no_instance", "unknown"];
/** A small seeded generator, so a failing order can be replayed. */
function rng(seed: number) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

let n = 0;
/** A live batch with one parked chunk holding `products` products, each with one photo and one waiting row of `upscaler`. */
async function waitingRows(options: { products?: number; upscaler?: string; auto?: boolean; status?: "rendering" | "done" } = {}) {
  const k = n++;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name: `health-${k}`, isTest: true, createdBy: "t@opptra.com", status: options.status ?? "rendering", channels: ["trendyol"], startedAt: new Date(), options: (options.auto === false ? {} : { autoDecide: { rules: [] } }) as never }).returning();
  const products: string[] = [], rows: string[] = [];
  for (let p = 0; p < (options.products ?? 1); p++) {
    const key = `health-${k}-${p}`;
    const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: key, pathKey: key, identifier: key }).returning();
    const [source] = await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n: 1, sha256: key, originalName: `${key}.jpg`, rawUri: `gs://assets/${key}.jpg`, mime: "image/jpeg" }).returning();
    const [row] = await db.insert(catalogEnlargements).values({ batchId: batch!.id, productId: product!.id, sourceImageId: source!.id, upscaler: options.upscaler ?? "swinir-x2", factor: 2, scale: 2, outW: 100, outH: 100, route: "direct", pixelHash: key, identityHash: randomUUID() }).returning();
    products.push(product!.id); rows.push(row!.id);
  }
  await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "render", status: "queued", attempt: 0, productIds: products, taskName: ENLARGING_TASK, dispatchedAt: new Date() });
  return { batchId: batch!.id, products, rows };
}
const statusOf = async (id: string) => (await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, id)))[0]!;
const enqueue = (async () => "task") as never;
const outage = (minutesAgo: number, now: Date): OutageAssessment => ({ services: [{ service: "gpu", probe: "absent", since: new Date(+now - minutesAgo * 60_000), outage: true }], at: now });

describe("health ledger under concurrent writers (review P2-3)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: 60 writers at once with shuffled stamps keep the ledger's invariant`, async () => {
      const random = rng(seed);
      const writes = Array.from({ length: 60 }, () => ({ kind: KINDS[Math.floor(random() * KINDS.length)]!, minutes: Math.floor(random() * 120) }));
      await Promise.all(writes.map((w) => recordUpscalerObservation(db, { service: "gpu", kind: w.kind, at: at(w.minutes), upscaler: "swinir-x2" })));
      const [row] = await readUpscalerHealth(db);
      const proofs = writes.filter((w) => observationClass(w.kind) === "health").map((w) => w.minutes);
      const lastProof = proofs.length ? Math.max(...proofs) : -Infinity;
      const after = writes.filter((w) => observationClass(w.kind) === "unhealthy" && w.minutes > lastProof).map((w) => w.minutes);
      expect(row!.healthyAt).toEqual(proofs.length ? at(lastProof) : null);
      if (!after.length) expect(row!.unhealthySince).toBeNull();
      else {
        // A symptom newer than the latest proof, never earlier than the first such symptom (fail safe: never early).
        expect(after.map(at).map(Number)).toContain(+row!.unhealthySince!);
        expect(+row!.unhealthySince!).toBeGreaterThanOrEqual(+at(Math.min(...after)));
      }
    }, 60_000);
  }

  it("the same observations written one by one in stamp order give the exact first symptom after the last proof", async () => {
    const random = rng(9);
    const writes = Array.from({ length: 40 }, () => ({ kind: KINDS[Math.floor(random() * KINDS.length)]!, minutes: Math.floor(random() * 120) })).sort((a, b) => a.minutes - b.minutes);
    for (const w of writes) await recordUpscalerObservation(db, { service: "gpu", kind: w.kind, at: at(w.minutes), upscaler: "swinir-x2" });
    const proofs = writes.filter((w) => observationClass(w.kind) === "health").map((w) => w.minutes);
    const lastProof = proofs.length ? Math.max(...proofs) : -Infinity;
    const after = writes.filter((w) => observationClass(w.kind) === "unhealthy" && w.minutes > lastProof).map((w) => w.minutes);
    expect((await readUpscalerHealth(db))[0]!.unhealthySince).toEqual(after.length ? at(Math.min(...after)) : null);
  });
});

describe("the sweep's probe pass is bounded (review P2-1, P2-2)", () => {
  it("I1: both services are probed at once with the sweep's short timeout; a probe that never answers counts as a timeout", async () => {
    await waitingRows({ upscaler: "swinir-x2" });
    await waitingRows({ upscaler: "swinir-x2+cpu" });
    const timeouts: (number | undefined)[] = [];
    const started = Date.now();
    const a = await assessUpscalerOutages(db, (upscaler, opts) => { timeouts.push(opts?.timeoutMs); return upscaler.endsWith("+cpu") ? Promise.reject(new Error("boom")) : new Promise(() => {}); }, () => at(0), undefined, { timeoutMs: 50, graceMs: 50 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(timeouts).toEqual([50, 50]);
    expect(a.services.map((s) => [s.service, s.probe, s.outage]).sort()).toEqual([["cpu", "unknown", true], ["gpu", "timeout", true]]);
  });

  it("a busy (429) answer at the sweep is a proof: no outage", async () => {
    await waitingRows();
    await recordUpscalerObservation(db, { service: "gpu", kind: "no_instance", at: at(0), upscaler: "swinir-x2" });
    const a = await assessUpscalerOutages(db, async () => "busy", () => at(400));
    expect(a.services[0]).toMatchObject({ probe: "busy", since: null, outage: false });
  });

  it("the deadline pass stops starting products when its budget is spent and the next sweep finishes them", async () => {
    const b = await waitingRows({ products: 3 });
    const now = at(0);
    let wall = 0;
    const first = await applyOutageDeadline(db, enqueue, outage(7 * 60, now), now, undefined, { budgetMs: 10, wallClock: () => (wall += 20) });
    expect(first).toEqual([expect.objectContaining({ batchId: b.batchId, rows: 1 })]);
    expect((await Promise.all(b.rows.map(statusOf))).filter((r) => r.status === "failed")).toHaveLength(1);
    await applyOutageDeadline(db, enqueue, outage(7 * 60, now), now);
    expect((await Promise.all(b.rows.map(statusOf))).map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    // One deadline event per batch and outage, however many sweeps it took.
    expect(await db.select().from(catalogIncidents).where(eq(catalogIncidents.batchId, b.batchId))).toHaveLength(1);
  });
});

describe.skipIf(!TEST_PG_URL)("the deadline racing a delivery's settle (review P2-3, real Postgres)", () => {
  /** Waits (20 ms polls) until a session is blocked on a lock: the deadline is queued behind the settle's chunk locks. */
  async function lockWaiter(): Promise<void> {
    for (let i = 0; i < 500; i++) {
      const r = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
      if (Number((r as unknown as { rows: { n: number }[] }).rows[0]?.n) > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the deadline never waited for the settle's locks");
  }
  /** A settle on its own connection: takes the product's chunk locks, waits for `release`, writes `patch`, commits. */
  function settleHolding(batchId: string, productId: string, rowId: string, patch: Partial<typeof catalogEnlargements.$inferInsert>) {
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const done = db.transaction(async (tx) => {
      await lockProductChunks(tx as unknown as Db, batchId, productId);
      locked();
      await gate;
      await tx.update(catalogEnlargements).set(patch).where(eq(catalogEnlargements.id, rowId));
    });
    return { held, release, done };
  }

  it("a settle that made the photo wins: the deadline waits for its locks and then fails nothing", async () => {
    const b = await waitingRows();
    const settle = settleHolding(b.batchId, b.products[0]!, b.rows[0]!, { status: "done", uri: "gs://assets/made.jpg" });
    await settle.held;
    const now = at(0);
    const deadline = applyOutageDeadline(db, enqueue, outage(7 * 60, now), now);
    await lockWaiter();
    settle.release();
    const [, failed] = await Promise.all([settle.done, deadline]);
    expect(failed).toEqual([]);
    expect(await statusOf(b.rows[0]!)).toMatchObject({ status: "done" });
  });

  it("a settle that only delayed: the deadline fails the row once the settle commits, and unparks the chunk", async () => {
    const b = await waitingRows();
    const settle = settleHolding(b.batchId, b.products[0]!, b.rows[0]!, { delays: 1 });
    await settle.held;
    const now = at(0);
    const deadline = applyOutageDeadline(db, enqueue, outage(7 * 60, now), now);
    await lockWaiter();
    settle.release();
    const [, failed] = await Promise.all([settle.done, deadline]);
    expect(failed).toEqual([expect.objectContaining({ batchId: b.batchId, rows: 1 })]);
    expect(await statusOf(b.rows[0]!)).toMatchObject({ status: "failed", errorKind: "outage_deadline", delays: 1 });
    const [chunk] = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, b.batchId));
    expect(chunk!.taskName).toBeNull();
  });

  it("a claim committed while the deadline runs is respected: the claimed row is left to its delivery", async () => {
    const b = await waitingRows({ products: 2 });
    const settle = settleHolding(b.batchId, b.products[0]!, b.rows[0]!, { claimedAt: new Date(), claimToken: "live" });
    await settle.held;
    const now = new Date();
    const deadline = applyOutageDeadline(db, enqueue, outage(7 * 60, now), now);
    await lockWaiter();
    settle.release();
    await Promise.all([settle.done, deadline]);
    expect(await statusOf(b.rows[0]!)).toMatchObject({ status: "queued", claimToken: "live" });
    expect(await statusOf(b.rows[1]!)).toMatchObject({ status: "failed" });
  });
});
