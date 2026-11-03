// Tier 2 (PGlite + fakes): M6-F1-R1/R2 (M6-S1), review 2026-11-03. A chunk delivery writes its compute row once:
// when a step after the final claim write throws (the stage advance, the next step's dispatch, finish, the progress
// refresh; here the line after the advance), the catch adds no second compute row for the same wall time.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogCostEvents } from "@catalog/core/db/schema";
import { fakeWorld, seedBatch } from "../../test/catalog-fakes";
import { currentChunkTask, handleChunkTask } from "./chunk";

let db: Db, close: () => Promise<void>;
const saved = { BUCKET: process.env.BUCKET, PUBLIC_BUCKET: process.env.PUBLIC_BUCKET };
beforeAll(async () => { process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await close(); });

describe("chunk compute row", () => {
  it("is written once when a step after the final write throws", async () => {
    const w = fakeWorld(db);
    const { batch, chunks } = await seedBatch(db, w, "ledger-once", [[1]]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The matte stage finishes and commits its compute row; a step after it then throws.
    const log = w.deps.log;
    w.deps.log = (message, fields) => { if (message === "chunk delivered") throw new Error("late failure"); log(message, fields); };
    const result = await handleChunkTask(w.deps, await currentChunkTask(db, chunks[0]!.id));
    expect(result.httpStatus).not.toBe(200);
    const compute = (await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, batch.id))).filter((r) => r.kind === "compute");
    expect(compute.map((r) => [r.stage, r.outcome])).toEqual([["matte", "ok"]]);
  }, 120_000);
});
