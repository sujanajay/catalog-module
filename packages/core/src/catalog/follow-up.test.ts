import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { catalogBatches, DEFAULT_BATCH_OPTIONS } from "../db/schema";
import { batchLinks, FOLLOW_UP_CANCELLED, FOLLOW_UP_NOT_STARTED, followUpBatch, FollowUpRefused, followUpName } from "./follow-up";
import { armAutoStart } from "./auto-start";

// M1-F5-R2 (M1-S6): adding photos to a started batch makes a linked follow-up batch that starts by itself.
let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 180_000);
afterAll(async () => { await close?.(); });

async function batch(over: Partial<typeof catalogBatches.$inferInsert> = {}) {
  const [b] = await db.insert(catalogBatches).values({
    brandSlug: "vero-moda", brandName: "Vero Moda", name: "AW26", createdBy: "Op@Example.com", status: "matting", startedAt: new Date(),
    channels: ["noon", "namshi"], productType: "footwear",
    options: { ...DEFAULT_BATCH_OPTIONS, identifierMode: "folder", perRoot: false, newestSameProduct: false, sheetColumns: { identifier: 0, images: [1] }, autoDecide: [] as never },
    ...over,
  }).returning();
  return b!;
}
const read = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;

describe("followUpBatch", () => {
  it("makes a draft linked to the running batch with its brand, channels, type and grouping, auto-start on", async () => {
    const parent = await batch();
    const made = await followUpBatch(db, parent.id, "op@example.com");
    expect(made.created).toBe(true);
    const f = await read(made.id);
    expect(f).toMatchObject({ parentBatchId: parent.id, status: "draft", startedAt: null, brandSlug: "vero-moda", brandName: "Vero Moda", productType: "footwear", isTest: false, name: followUpName("AW26"), createdBy: "op@example.com" });
    expect(f.channels).toEqual(["noon", "namshi"]);
    // The parent's grouping choices, not its sheet columns or what Start wrote (auto-decide rules).
    expect(f.options).toEqual({ ...DEFAULT_BATCH_OPTIONS, identifierMode: "folder", perRoot: false, newestSameProduct: false, autoStart: true });
    // Once collected, it arms its own countdown like any one-page batch (M1-F2-R6).
    await db.update(catalogBatches).set({ counts: { ...f.counts, previewReady: true } }).where(eq(catalogBatches.id, f.id));
    expect(await armAutoStart(db, async () => "t", f.id, 10, new Date())).not.toBeNull();
  });

  it("gives the same person their open follow-up again, and another person their own", async () => {
    const parent = await batch();
    const first = await followUpBatch(db, parent.id, "op@example.com");
    expect(await followUpBatch(db, parent.id, "OP@example.com")).toEqual({ id: first.id, created: false });
    // Still open while it is collecting.
    await db.update(catalogBatches).set({ status: "ingesting" }).where(eq(catalogBatches.id, first.id));
    expect((await followUpBatch(db, parent.id, "op@example.com")).id).toBe(first.id);
    const other = await followUpBatch(db, parent.id, "lead@example.com");
    expect(other.created).toBe(true);
    expect(other.id).not.toBe(first.id);
    // Once the follow-up started, more photos make a new one.
    await db.update(catalogBatches).set({ status: "matting", startedAt: new Date() }).where(eq(catalogBatches.id, first.id));
    const next = await followUpBatch(db, parent.id, "op@example.com");
    expect(next.created).toBe(true);
    expect((await read(next.id)).parentBatchId).toBe(parent.id);
  });

  it("two adds at once make one follow-up", async () => {
    const parent = await batch();
    const [a, b] = await Promise.all([followUpBatch(db, parent.id, "op@example.com"), followUpBatch(db, parent.id, "op@example.com")]);
    expect(a.id).toBe(b.id);
    expect((await db.select().from(catalogBatches).where(eq(catalogBatches.parentBatchId, parent.id))).length).toBe(1);
  });

  it("adds to a finished batch too, and keeps a test batch a test batch", async () => {
    const parent = await batch({ status: "done", finishedAt: new Date(), name: "catalog-test AW26", isTest: true });
    const f = await read((await followUpBatch(db, parent.id, "op@example.com")).id);
    expect(f.isTest).toBe(true);
    expect(f.name.startsWith("catalog-test")).toBe(true);
  });

  it("refuses a batch that has not started, one cancelled before it started, and one that does not exist", async () => {
    for (const status of ["draft", "ingesting"] as const) {
      const p = await batch({ status, startedAt: null });
      await expect(followUpBatch(db, p.id, "op@example.com")).rejects.toMatchObject({ status: 409, message: FOLLOW_UP_NOT_STARTED });
    }
    const cancelled = await batch({ status: "cancelled", startedAt: null });
    await expect(followUpBatch(db, cancelled.id, "op@example.com")).rejects.toMatchObject({ status: 409, message: FOLLOW_UP_CANCELLED });
    await expect(followUpBatch(db, "00000000-0000-4000-8000-000000000000", "op@example.com")).rejects.toBeInstanceOf(FollowUpRefused);
  });
});

describe("batchLinks", () => {
  it("names the batch a follow-up adds to, and the follow-ups of a batch (not cancelled ones)", async () => {
    const parent = await batch();
    const a = await followUpBatch(db, parent.id, "op@example.com");
    const b = await followUpBatch(db, parent.id, "lead@example.com");
    await db.update(catalogBatches).set({ status: "cancelled" }).where(eq(catalogBatches.id, b.id));
    const links = await batchLinks(db, parent);
    expect(links.parent).toBeNull();
    expect(links.followUps.map((f) => f.id)).toEqual([a.id]);
    expect((await batchLinks(db, await read(a.id))).parent).toEqual({ id: parent.id, name: "AW26" });
  });

  it("a deleted parent leaves its follow-up standing, unlinked (ON DELETE SET NULL)", async () => {
    const parent = await batch();
    const f = await followUpBatch(db, parent.id, "op@example.com");
    await db.delete(catalogBatches).where(eq(catalogBatches.id, parent.id));
    expect((await read(f.id)).parentBatchId).toBeNull();
  });
});
