// Tier 2 (PGlite + fakes): M6-F2-R3 (M6-S4). SIGTERM during a chunk delivery: the photo in hand finishes, no new photo
// starts, the delivery saves what it did and queues the rest (as at the end of its time budget); the next delivery on a
// live instance makes the rest, and no photo is matted twice.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogChunks, catalogCostEvents } from "@catalog/core/db/schema";
import { fakeWorld, seedBatch } from "../../test/catalog-fakes";
import { isDraining, resetDrain, startDrain } from "../drain";
import { currentChunkTask, handleChunkTask } from "./chunk";

let db: Db, close: () => Promise<void>;
const saved = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await close(); });
afterEach(() => resetDrain());

describe("chunk delivery on shutdown", () => {
  it("finishes the photo in hand, starts no other, hands off; the next delivery makes the rest", async () => {
    const w = fakeWorld(db);
    const { batch, chunks } = await seedBatch(db, w, "drain-chunk", [[3]]);
    const matte = w.deps.matteFor;
    w.deps.matteFor = (async (...args: Parameters<typeof matte>) => {
      if (!isDraining()) void startDrain();
      return matte(...args);
    }) as typeof matte;
    const first = await handleChunkTask(w.deps, await currentChunkTask(db, chunks[0]!.id));
    expect(first.httpStatus).toBe(200);
    expect(w.deliveries().at(-1)).toMatchObject({ outcome: "handed_off", photos: 1 });
    expect(matte).toHaveBeenCalledTimes(1);
    // The hand-off is queued for a live instance.
    expect(w.tasks.filter((t) => t.route === "/tasks/catalog/chunk")).toHaveLength(1);

    resetDrain();
    w.deps.matteFor = matte;
    for (let i = 0; i < 5 && w.deliveries().at(-1)?.outcome === "handed_off"; i++) await handleChunkTask(w.deps, await currentChunkTask(db, chunks[0]!.id));
    expect(matte).toHaveBeenCalledTimes(3);
    // One compute row per delivery, with its billable time.
    const compute = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, batch.id));
    const rows = compute.filter((c) => c.kind === "compute" && c.stage === "matte");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.billableMs).not.toBeNull();
  }, 120_000);

  it("a delivery cut off by a deploy before its first photo is never counted as a stall (review 2026-11-03)", async () => {
    const w = fakeWorld(db);
    const { chunks } = await seedBatch(db, w, "drain-stall", [[2]]);
    await startDrain();
    expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunks[0]!.id))).httpStatus).toBe(200);
    expect(w.deliveries().at(-1)).toMatchObject({ outcome: "handed_off", photos: 0 });
    resetDrain();
    // Three deploys in a row on the same chunk would fail it (CHUNK_MAX_STALLS) if each counted.
    let claimedStalls: number | null = null;
    const matte = w.deps.matteFor;
    w.deps.matteFor = (async (...args: Parameters<typeof matte>) => {
      claimedStalls ??= (await db.select({ stalls: catalogChunks.stalls }).from(catalogChunks).where(eq(catalogChunks.id, chunks[0]!.id)))[0]!.stalls;
      return matte(...args);
    }) as typeof matte;
    await handleChunkTask(w.deps, await currentChunkTask(db, chunks[0]!.id));
    expect(claimedStalls).toBe(0);
  }, 120_000);
});
