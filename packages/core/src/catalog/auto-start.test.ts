import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { catalogBatches, DEFAULT_BATCH_OPTIONS, EMPTY_BATCH_COUNTS } from "../db/schema";
import { armAutoStart, AUTO_START_BUSY_MAX_SEC, AUTO_START_BUSY_RETRY_SEC, AUTO_START_DELAY_SEC, AUTO_START_ROUTE, busyRetryDelaySec, holdAutoStart } from "./auto-start";
import { AUTO_START_ACTOR, runAutoStart, startDraftBatch, StartRefused } from "./pipeline/start";

// M1-F2-R6, R7 and R9 (M1-S2): the countdown runs on the server; Wait turns it off; start blockers are rules.
let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 180_000);
afterAll(async () => { await close?.(); });

const NOW = new Date("2026-11-04T10:00:00.000Z");
async function draft(over: { autoStart?: boolean; previewReady?: boolean; status?: "draft" | "ingesting"; channels?: string[] } = {}) {
  const [b] = await db.insert(catalogBatches).values({
    brandSlug: "vero-moda", brandName: "Vero Moda", name: "AW26", createdBy: "op@example.com", status: over.status ?? "draft",
    channels: (over.channels ?? ["noon"]) as never,
    options: { ...DEFAULT_BATCH_OPTIONS, ...(over.autoStart === undefined ? {} : { autoStart: over.autoStart }) },
    counts: { ...EMPTY_BATCH_COUNTS, previewReady: over.previewReady ?? true },
  }).returning();
  return b!;
}
const read = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
const deps = () => ({ storage: {} as never, enqueue: vi.fn(async () => "task"), now: () => NOW });

describe("arming the countdown (R6)", () => {
  it("arms a ready draft made with autoStart: writes autoStartAt and queues the task with the 10 s delay", async () => {
    const b = await draft({ autoStart: true });
    const enqueue = vi.fn(async () => "task");
    const at = await armAutoStart(db, enqueue, b.id, AUTO_START_DELAY_SEC, NOW);
    expect(AUTO_START_DELAY_SEC).toBe(10);
    expect(at).toBe("2026-11-04T10:00:10.000Z");
    expect((await read(b.id)).counts.autoStartAt).toBe(at);
    expect(enqueue).toHaveBeenCalledWith(AUTO_START_ROUTE, { batchId: b.id, at }, { delaySec: 10, taskId: `auto-start-${b.id}-${Date.parse(at!)}` });
  });

  it("does not arm a batch without autoStart (API and load driver, R9), one not ready, or one collecting", async () => {
    const enqueue = vi.fn(async () => "task");
    for (const b of [await draft(), await draft({ autoStart: false }), await draft({ autoStart: true, previewReady: false }), await draft({ autoStart: true, status: "ingesting" })]) {
      expect(await armAutoStart(db, enqueue, b.id, 10, NOW)).toBeNull();
      expect((await read(b.id)).counts.autoStartAt ?? null).toBeNull();
    }
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("Wait (hold-start)", () => {
  it("turns auto-start off and clears the countdown; the armed task then does nothing", async () => {
    const b = await draft({ autoStart: true });
    const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    expect(await holdAutoStart(db, b.id)).toBe(true);
    const held = await read(b.id);
    expect(held.options.autoStart).toBe(false);
    expect(held.counts.autoStartAt).toBeNull();
    expect(held.status).toBe("draft");
    const start = vi.fn();
    expect(await runAutoStart(db, deps(), { batchId: b.id, at }, start as never)).toMatch(/^noop/);
    expect(start).not.toHaveBeenCalled();
  });

  it("is refused for a batch that is not a draft", async () => {
    const b = await draft({ autoStart: true, status: "ingesting" });
    expect(await holdAutoStart(db, b.id)).toBe(false);
  });
});

describe("the auto-start task", () => {
  it("starts the draft it armed", async () => {
    const b = await draft({ autoStart: true });
    const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    const start = vi.fn(async () => ({ id: b.id, status: "matting" }));
    const d = deps();
    expect(await runAutoStart(db, d, { batchId: b.id, at }, start)).toBe("started");
    expect(start).toHaveBeenCalledWith(db, d, b.id, NOW.toISOString(), { by: AUTO_START_ACTOR, autoStart: { at } });
  });

  it("does nothing for an older countdown (more files were dropped) or while collecting", async () => {
    const b = await draft({ autoStart: true });
    const first = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, new Date(NOW.getTime() + 5000));
    const start = vi.fn();
    expect(await runAutoStart(db, deps(), { batchId: b.id, at: first }, start as never)).toMatch(/newer countdown/);
    await db.update(catalogBatches).set({ status: "ingesting" }).where(eq(catalogBatches.id, b.id));
    expect(await runAutoStart(db, deps(), { batchId: b.id, at: first }, start as never)).toMatch(/^noop/);
    expect(start).not.toHaveBeenCalled();
  });

  it("R7: products held by another running batch make it try again after AUTO_START_BUSY_RETRY_SEC", async () => {
    const b = await draft({ autoStart: true });
    const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    const d = deps();
    const start = vi.fn(async () => { throw new StartRefused(409, "X is still being processed in batch Y.", "busy"); });
    expect(await runAutoStart(db, d, { batchId: b.id, at }, start)).toMatch(/^waiting/);
    const next = new Date(NOW.getTime() + AUTO_START_BUSY_RETRY_SEC * 1000).toISOString();
    expect((await read(b.id)).counts.autoStartAt).toBe(next);
    expect(d.enqueue).toHaveBeenCalledWith(AUTO_START_ROUTE, { batchId: b.id, at: next, busyRetries: 1, busySince: NOW.toISOString() }, expect.objectContaining({ delaySec: AUTO_START_BUSY_RETRY_SEC }));
  });

  it("R7 (M1 D21): the busy retry backs off from 60 s, doubling to 15 min, and a wait past an hour is logged", async () => {
    expect([0, 1, 2, 3, 4, 5, 30].map(busyRetryDelaySec)).toEqual([60, 120, 240, 480, 900, 900, 900]);
    expect(AUTO_START_BUSY_MAX_SEC).toBe(900);
    const b = await draft({ autoStart: true });
    const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    const since = new Date(NOW.getTime() - 61 * 60 * 1000).toISOString();
    const d = deps();
    const start = vi.fn(async () => { throw new StartRefused(409, "X is still being processed in batch Y.", "busy"); });
    const write = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runAutoStart(db, d, { batchId: b.id, at, busyRetries: 4, busySince: since }, start)).toMatch(/^waiting/);
      expect(write.mock.calls.map((c) => String(c[0])).some((line) => line.includes("auto-start still waiting for locked products"))).toBe(true);
    } finally { write.mockRestore(); }
    const next = new Date(NOW.getTime() + 900 * 1000).toISOString();
    expect(d.enqueue).toHaveBeenCalledWith(AUTO_START_ROUTE, { batchId: b.id, at: next, busyRetries: 5, busySince: since }, expect.objectContaining({ delaySec: 900 }));
  });

  it("any other refusal ends this countdown and leaves the Start button (the draft stays)", async () => {
    const b = await draft({ autoStart: true, channels: [] });
    const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    expect(await runAutoStart(db, deps(), { batchId: b.id, at })).toMatch(/^not started: Choose at least one marketplace/);
    const after = await read(b.id);
    expect(after.status).toBe("draft");
    expect(after.counts.autoStartAt).toBeNull();
    // Review P2-4: marked as ended on purpose, so the sweep does not arm it again; the next countdown clears the mark.
    expect(after.counts.autoStartEnded).toBe(true);
    await db.update(catalogBatches).set({ channels: ["noon"] }).where(eq(catalogBatches.id, b.id));
    expect(await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW)).toBeTruthy();
    expect((await read(b.id)).counts.autoStartEnded).toBeNull();
  });
});

describe("Wait against an auto-start in flight (P1, M1-F2-R6)", () => {
  it("Wait after the task's own checks but before Start: the batch is not started or failed, and the task is a no-op", async () => {
    // A draft with no photos: without the guard, Start would go on and mark it failed (no_photos) after Wait.
    const b = await draft({ autoStart: true });
    const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
    const start = async (...args: Parameters<typeof startDraftBatch>) => { expect(await holdAutoStart(db, b.id)).toBe(true); return startDraftBatch(...args); };
    expect(await runAutoStart(db, deps(), { batchId: b.id, at }, start)).toMatch(/^noop: Auto-start was turned off with Wait/);
    const after = await read(b.id);
    expect(after).toMatchObject({ status: "draft", startedAt: null });
    expect(after.options.autoStart).toBe(false);
  });

  it("a manual Start (no countdown) still starts a held draft", async () => {
    const b = await draft({ autoStart: true });
    await holdAutoStart(db, b.id);
    // It goes past the auto-start guard to the next rule (no photos here).
    await expect(startDraftBatch(db, deps(), b.id, new Date(Date.now() + 60_000).toISOString(), { by: "test" })).rejects.toMatchObject({ kind: "no_photos" });
  });
});

describe("arming when the queue is down (P2)", () => {
  it("clears the countdown when the task cannot be queued, so the page shows Start, not a countdown stuck at 1 s", async () => {
    const b = await draft({ autoStart: true });
    const write = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(armAutoStart(db, vi.fn(async () => { throw new Error("queue down"); }), b.id, 10, NOW)).rejects.toThrow("queue down");
    } finally { write.mockRestore(); }
    expect((await read(b.id)).counts.autoStartAt).toBeNull();
    expect((await read(b.id)).options.autoStart).toBe(true);
  });
});

describe("startDraftBatch refusals", () => {
  it("names a draft with no photos as failed (kind no_photos)", async () => {
    const b = await draft();
    const err = await startDraftBatch(db, deps(), b.id, new Date(Date.now() + 60_000).toISOString(), { by: "test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartRefused);
    expect(err).toMatchObject({ status: 400, kind: "no_photos" });
    expect((await read(b.id)).status).toBe("failed");
  });
});
