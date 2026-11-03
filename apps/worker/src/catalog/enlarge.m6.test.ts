// Tier 2 (PGlite + the enlarge world fakes): M6 on the enlargement handler.
// - M6-F1 acceptance test 2 (M6-S1): the upscaler is killed mid-batch; every paid call it took is in the ledger, the
//   failed ones with outcome `failed`, each naming the service that answered.
// - M6-F2-R3 (M6-S4): SIGTERM while a call runs gives the call's count back, releases the claim, writes a `killed` cost
//   row and answers 503 (the queue re-sends); the re-sent delivery makes the image. Never a counted failure.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogEnlargements } from "@catalog/core/db/schema";
import { deliverChunk, enlargeBody, enlargeUntilSettled, enlargeWorld, rowsOf, seedEnlargeBatch, upscaleCosts } from "../../test/enlarge-world";
import { resetDrain, startDrain } from "../drain";
import { handleEnlargeTask } from "./enlarge";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4", "K_SERVICE"];
beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  Object.assign(process.env, { BUCKET: "assets", PUBLIC_BUCKET: "public", UPSCALE_MAX_PIXELS: "8000000", UPSCALE_MAX_PIXELS_X4: "6400000", K_SERVICE: "catalog-worker" });
  ({ db, close } = await createTestDb());
}, 120_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });
afterEach(() => resetDrain());

async function parked(name: string, layout: number[][]) {
  const e = enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, layout, { channels: ["trendyol"] });
  for (const c of s.chunks) expect(await deliverChunk(db, e.w, c.id)).toMatchObject({ httpStatus: 200 });
  return { ...e, s, rows: await rowsOf(db, s.batch.id) };
}
const rowNow = async (id: string) => (await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.id, id)))[0]!;

describe("M6-F1 test 2: the upscaler killed mid-batch", () => {
  it("every paid call is a ledger row: the made ones ok, the ones the killed instance took failed, each with its component", async () => {
    const e = await parked("m6-killed", [[1], [1], [1]]);
    const [first, second, third] = e.rows;
    expect((await enlargeUntilSettled(e.w, first!)).at(-1)).toMatchObject({ outcome: "done" });
    // The instance dies mid-batch: the calls in flight get Cloud Run's bodiless 503 (a killed instance), then resets.
    e.service.state.mode = "crash503";
    e.service.state.poison.add(second!.productId);
    await handleEnlargeTask(e.w.deps, enlargeBody(second!));
    e.service.state.poison.add(third!.productId);
    e.service.state.mode = "ok";
    await handleEnlargeTask(e.w.deps, enlargeBody(third!));
    const costs = await upscaleCosts(db, e.s.batch.id);
    expect(costs).toHaveLength(e.service.paid());
    expect(costs.map((c) => c.outcome).sort()).toEqual(["failed", "failed", "ok"]);
    for (const c of costs) expect(c.component).toMatch(/^catalog-(matting|upscale)/);
    expect(await rowNow(second!.id)).toMatchObject({ status: "queued" });
  }, 240_000);
});

describe("M6-F2-R3: SIGTERM during an enlargement call", () => {
  it("gives the count back, releases the claim, writes a killed row and answers 503; the re-send makes the image", async () => {
    const e = await parked("m6-drain", [[1]]);
    const row = e.rows[0]!;
    let release!: () => void;
    e.service.state.hold = new Promise<void>((r) => { release = r; });
    const delivery = handleEnlargeTask(e.w.deps, enlargeBody(row));
    while (!e.service.call.mock.calls.length) await new Promise((r) => setTimeout(r, 5));
    expect((await rowNow(row.id)).timeouts).toBe(1);
    await startDrain();
    release();
    expect(await delivery).toMatchObject({ httpStatus: 503, outcome: "draining" });
    expect(await rowNow(row.id)).toMatchObject({ status: "queued", attempts: 0, timeouts: 0, callStartedAt: null });
    expect((await upscaleCosts(db, e.s.batch.id)).map((c) => c.outcome)).toEqual(["killed"]);
    // A live instance takes the re-sent task.
    resetDrain();
    expect((await enlargeUntilSettled(e.w, row)).at(-1)).toMatchObject({ outcome: "done" });
    expect(await rowNow(row.id)).toMatchObject({ status: "done", attempts: 0 });
    expect((await upscaleCosts(db, e.s.batch.id)).map((c) => c.outcome).sort()).toEqual(["killed", "ok"]);
  }, 120_000);
});
