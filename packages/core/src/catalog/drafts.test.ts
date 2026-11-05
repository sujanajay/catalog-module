import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { catalogBatches, catalogUploads, DEFAULT_BATCH_OPTIONS, EMPTY_BATCH_COUNTS } from "../db/schema";
import type { BatchCounts } from "./types";
import { DRAFT_IDLE_MS, handOffIdleDrafts, logOrphanCount, ORPHAN_AGE_MS, orphanDrafts, orphanReason, rearmLostCountdowns, resendGivenUpIntake, SWEEP_MOVES_MAX } from "./drafts";
import { INGEST_STOPPED_TEXT } from "./ingest/index";
import { INGEST_ROUTE } from "./ingest/hand-off";
import { AUTO_START_ROUTE } from "./auto-start";

// M1-F5-R1, R4 and R5 (M1-S6): drafts carry on by themselves; the ones that cannot are counted and listed.
let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 180_000);
afterAll(async () => { await close?.(); });

const NOW = new Date("2026-11-05T10:05:00.000Z");
const ago = (ms: number) => new Date(+NOW - ms);
type Upload = { status: "pending" | "uploaded" | "collected" | "failed" | "removed"; kind?: "image" | "google_sheet" | "url_list"; gcsUri?: string | null };

async function draft(over: { autoStart?: boolean; status?: "draft" | "failed" | "ingesting" | "matting"; counts?: Partial<BatchCounts>; idleMs?: number; createdMs?: number; channels?: string[]; isTest?: boolean; uploads?: Upload[] } = {}) {
  const [b] = await db.insert(catalogBatches).values({
    brandSlug: "vero-moda", brandName: "Vero Moda", name: "AW26", createdBy: "op@example.com", status: over.status ?? "draft", isTest: over.isTest ?? false,
    channels: (over.channels ?? ["noon"]) as never,
    options: { ...DEFAULT_BATCH_OPTIONS, ...(over.autoStart === false ? {} : { autoStart: true }) },
    counts: { ...EMPTY_BATCH_COUNTS, ...over.counts },
  }).returning();
  for (const u of over.uploads ?? [{ status: "uploaded" }]) {
    await db.insert(catalogUploads).values({ batchId: b!.id, kind: u.kind ?? "image", name: "a.jpg", status: u.status, gcsUri: u.gcsUri === undefined ? "gs://b/a.jpg" : u.gcsUri, ingestFailures: 2 });
  }
  // Written last, with SQL, so the times are the test's (drizzle's update sets updated_at to now).
  await db.execute(sql`UPDATE catalog_batches SET updated_at = ${ago(over.idleMs ?? DRAFT_IDLE_MS + 60_000).toISOString()}::timestamptz, created_at = ${ago(over.createdMs ?? DRAFT_IDLE_MS + 60_000).toISOString()}::timestamptz WHERE id = ${b!.id}`);
  return b!;
}
const read = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
const uploadsOf = async (id: string) => db.select().from(catalogUploads).where(eq(catalogUploads.batchId, id));
const enqueueMock = () => vi.fn(async (_route: string, _body: Record<string, unknown>, _opts?: unknown) => "task");
const reset = async () => { await db.delete(catalogBatches); };

describe("handOffIdleDrafts (F5-R1: the tab closed before the files were handed to collecting)", () => {
  it("hands an idle auto-start draft's uploaded files to collecting under a new run", async () => {
    await reset();
    const b = await draft({ uploads: [{ status: "uploaded" }, { status: "uploaded" }, { status: "removed" }] });
    const enqueue = enqueueMock();
    expect(await handOffIdleDrafts(db, enqueue, NOW)).toEqual([b.id]);
    const after = await read(b.id);
    expect(after.status).toBe("ingesting");
    expect(after.counts.sweepHandOffs).toBe(1);
    const run = after.counts.ingestRun!;
    expect(run).toBeTruthy();
    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const call of enqueue.mock.calls) expect(call[0]).toBe(INGEST_ROUTE);
    expect(enqueue.mock.calls.map((c) => c[1].run)).toEqual([run, run]);
    // A new run starts every upload's failure count at 0 (M6-F2-R4).
    expect((await uploadsOf(b.id)).every((u) => u.ingestFailures === 0)).toBe(true);
    // A second sweep finds nothing: the batch is collecting.
    expect(await handOffIdleDrafts(db, enqueueMock(), NOW)).toEqual([]);
  });

  it("hands one collected upload when every file is already read (an input removed during the last run)", async () => {
    await reset();
    const b = await draft({ uploads: [{ status: "collected" }, { status: "collected" }] });
    const enqueue = enqueueMock();
    expect(await handOffIdleDrafts(db, enqueue, NOW)).toEqual([b.id]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("leaves drafts a person is still working on, or that only a person can move on", async () => {
    await reset();
    const kept = [
      await draft({ idleMs: DRAFT_IDLE_MS - 60_000 }), // written to a minute ago (the page is open)
      await draft({ counts: { previewReady: true } }), // already collected (rearmLostCountdowns' job)
      await draft({ uploads: [{ status: "uploaded" }, { status: "pending" }] }), // a file did not finish uploading
      await draft({ uploads: [{ status: "uploaded", kind: "google_sheet", gcsUri: null }] }), // a Google link only the web reads
      await draft({ uploads: [{ status: "removed" }] }), // no inputs
      await draft({ uploads: [{ status: "failed" }] }), // nothing to read
      await draft({ counts: { sweepHandOffs: SWEEP_MOVES_MAX } }), // moved on too often already
      await draft({ status: "matting" }), // not a draft
    ];
    const enqueue = enqueueMock();
    expect(await handOffIdleDrafts(db, enqueue, NOW)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    for (const b of kept) expect((await read(b.id)).status).toBe(b.status);
  });

  it("hands on a draft with Wait pressed too (review P2-1); it is collected and then waits for its Start button", async () => {
    await reset();
    const b = await draft({ autoStart: false });
    const enqueue = enqueueMock();
    expect(await handOffIdleDrafts(db, enqueue, NOW)).toEqual([b.id]);
    const after = await read(b.id);
    expect(after.status).toBe("ingesting");
    expect(after.options.autoStart).not.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("puts the draft back when nothing could be queued", async () => {
    await reset();
    const b = await draft();
    const enqueue = vi.fn(async () => { throw new Error("queue down"); });
    expect(await handOffIdleDrafts(db, enqueue, NOW)).toEqual([]);
    expect((await read(b.id)).status).toBe("draft");
  });
});

describe("rearmLostCountdowns (F5-R1: collected, but the countdown never ran)", () => {
  it("arms a collected auto-start draft with no countdown, or one whose countdown passed long ago", async () => {
    await reset();
    const none = await draft({ counts: { previewReady: true, autoStartAt: null } });
    const lost = await draft({ counts: { previewReady: true, autoStartAt: ago(DRAFT_IDLE_MS + 60_000).toISOString() } });
    const enqueue = enqueueMock();
    expect((await rearmLostCountdowns(db, enqueue, NOW)).sort()).toEqual([none.id, lost.id].sort());
    for (const id of [none.id, lost.id]) {
      const after = await read(id);
      expect(after.counts.autoStartAt).toBe(new Date(+NOW + 10_000).toISOString());
      expect(after.counts.sweepRearms).toBe(1);
    }
    expect(enqueue.mock.calls.every((c) => c[0] === AUTO_START_ROUTE)).toBe(true);
  });

  it("leaves a running busy back-off, a sheet waiting for its column, no channel, Wait, and a draft re-armed too often", async () => {
    await reset();
    await draft({ counts: { previewReady: true, autoStartAt: new Date(+NOW + 600_000).toISOString() } });
    await draft({ counts: { previewReady: true, phase: "needs_input" } });
    await draft({ counts: { previewReady: true }, channels: [] });
    await draft({ counts: { previewReady: true }, autoStart: false });
    await draft({ counts: { previewReady: true, sweepRearms: SWEEP_MOVES_MAX } });
    await draft({ counts: { previewReady: true }, idleMs: 60_000 });
    // Review P2-4: a countdown the auto-start task ended on purpose (nothing usable): its Start button shows instead.
    await draft({ counts: { previewReady: true, autoStartAt: null, autoStartEnded: true } });
    const enqueue = enqueueMock();
    expect(await rearmLostCountdowns(db, enqueue, NOW)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("arms the other drafts when the queue refuses one (review P3)", async () => {
    await reset();
    const first = await draft({ counts: { previewReady: true, autoStartAt: null } });
    const second = await draft({ counts: { previewReady: true, autoStartAt: null } });
    let calls = 0;
    const enqueue = vi.fn(async () => { if (++calls === 1) throw new Error("queue down"); return "task"; });
    const armed = await rearmLostCountdowns(db, enqueue, NOW);
    expect(armed).toHaveLength(1);
    expect([first.id, second.id]).toContain(armed[0]);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe("resendGivenUpIntake (F5-R4: the 7bdee361 case)", () => {
  it("re-sends an intake that stopped after several tries, under a new run, keeping nothing of the failure", async () => {
    await reset();
    const b = await draft({ status: "failed", counts: { failReason: INGEST_STOPPED_TEXT }, idleMs: 31 * 60_000, uploads: [{ status: "collected" }, { status: "uploaded" }] });
    const enqueue = enqueueMock();
    expect(await resendGivenUpIntake(db, enqueue, NOW)).toEqual([b.id]);
    const after = await read(b.id);
    expect(after.status).toBe("ingesting");
    expect(after.counts.failReason).toBeNull();
    expect(after.counts.ingestResends).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![1]).toMatchObject({ batchId: b.id, run: after.counts.ingestRun });
  });

  it("leaves other failures, recent ones, started batches and one re-sent too often", async () => {
    await reset();
    await draft({ status: "failed", counts: { failReason: "No photos were found in what you uploaded." }, idleMs: 31 * 60_000 });
    await draft({ status: "failed", counts: { failReason: INGEST_STOPPED_TEXT }, idleMs: 5 * 60_000 });
    await draft({ status: "failed", counts: { failReason: INGEST_STOPPED_TEXT, ingestResends: SWEEP_MOVES_MAX }, idleMs: 31 * 60_000 });
    const started = await draft({ status: "failed", counts: { failReason: INGEST_STOPPED_TEXT }, idleMs: 31 * 60_000 });
    await db.execute(sql`UPDATE catalog_batches SET started_at = now(), updated_at = ${ago(31 * 60_000).toISOString()}::timestamptz WHERE id = ${started.id}`);
    const enqueue = enqueueMock();
    expect(await resendGivenUpIntake(db, enqueue, NOW)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("orphanDrafts and the daily count (F5-R5)", () => {
  it("lists drafts older than 24 h with inputs and no start, each with its reason", async () => {
    await reset();
    const old = ORPHAN_AGE_MS + 60_000;
    const pending = await draft({ createdMs: old, uploads: [{ status: "uploaded" }, { status: "pending" }, { status: "pending" }] });
    const waiting = await draft({ createdMs: old, autoStart: false, counts: { previewReady: true } });
    const busy = await draft({ createdMs: old, counts: { previewReady: true, autoStartAt: new Date(+NOW + 60_000).toISOString() } });
    await draft({ createdMs: ORPHAN_AGE_MS - 60_000 }); // younger than a day
    await draft({ createdMs: old, uploads: [{ status: "removed" }] }); // no inputs
    await draft({ createdMs: old, isTest: true }); // a test batch
    await draft({ createdMs: old, status: "matting" }); // started
    const list = await orphanDrafts(db, NOW);
    expect(list.map((o) => [o.id, o.reason])).toEqual([
      [pending.id, "2 files did not finish uploading."],
      [waiting.id, "Waiting for Start (it does not start by itself)."],
      [busy.id, "Waiting for products another batch is still making."],
    ]);
  });

  it("logs the count once a day, in the first sweep after midnight UTC", async () => {
    // The next midnight: the draft younger than a day then is older than a day too.
    expect(await logOrphanCount(db, new Date("2026-11-06T00:04:00.000Z"))).toBe(4);
    expect(await logOrphanCount(db, new Date("2026-11-06T00:14:00.000Z"))).toBeNull();
    expect(await logOrphanCount(db, NOW)).toBeNull();
  });
});

describe("Ops words for a draft stuck reading a Supabase folder (R1 review P2-2)", () => {
  it("names the folder, not a file upload; a file still uploading is named first", () => {
    const d = { channels: [], options: DEFAULT_BATCH_OPTIONS, counts: EMPTY_BATCH_COUNTS };
    expect(orphanReason(d, { pending: 0, readingFolders: 1, webOnly: false })).toBe("A Supabase folder was not finished reading. Open the batch and paste the folder link again.");
    expect(orphanReason(d, { pending: 2, readingFolders: 1, webOnly: false })).toBe("2 files did not finish uploading.");
  });

  it("counts a reading folder apart from file uploads, and the idle sweep still leaves that draft alone", async () => {
    const reading = await draft({ createdMs: ORPHAN_AGE_MS + 60 * 60_000, idleMs: DRAFT_IDLE_MS + 60_000, uploads: [{ status: "uploaded" }, { status: "pending", kind: "url_list" }] });
    expect((await orphanDrafts(db, NOW)).find((o) => o.id === reading.id)?.reason).toBe("A Supabase folder was not finished reading. Open the batch and paste the folder link again.");
    expect(await handOffIdleDrafts(db, vi.fn(async () => "t"), NOW)).not.toContain(reading.id);
  });
});
