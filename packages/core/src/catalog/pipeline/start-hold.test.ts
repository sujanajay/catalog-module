// P1 (M1-F2-R6): Wait pressed while an auto-start is building its preview, before Start's transaction locks the batch.
// buildPreview is replaced so the Wait lands exactly there; the locked re-check must see it and not start.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/testing";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS, EMPTY_BATCH_COUNTS } from "../../db/schema";
import { armAutoStart, holdAutoStart } from "../auto-start";

const hook = vi.hoisted(() => ({ during: async () => {} }));
vi.mock(import("../ingest/index"), async (original) => ({
  ...await original(),
  buildPreview: vi.fn(async () => { await hook.during(); return { overwrite: { newProducts: 1, existingProducts: [] } } as never; }),
}));
const { runAutoStart, startDraftBatch } = await import("./start");

let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 180_000);
afterAll(async () => { await close?.(); });
const NOW = new Date("2026-11-04T10:00:00.000Z");

async function startableDraft() {
  const [b] = await db.insert(catalogBatches).values({
    brandSlug: "vero-moda", brandName: "Vero Moda", name: "AW26", createdBy: "op@example.com", status: "draft", channels: ["noon"] as never,
    options: { ...DEFAULT_BATCH_OPTIONS, autoStart: true }, counts: { ...EMPTY_BATCH_COUNTS, previewReady: true },
  }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "vero-moda", productKey: `VM${b!.id.slice(0, 8)}`, pathKey: `vm${b!.id.slice(0, 8)}`, identifier: `VM${b!.id.slice(0, 8)}` }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: b!.id, productId: product!.id, change: "new" });
  await db.insert(catalogSourceImages).values({ productId: product!.id, batchId: b!.id, n: 1, sha256: "a".repeat(64), originalName: "x_1.jpg", rawUri: "gs://raw/catalog-test/x_1.jpg", mime: "image/jpeg" });
  return b!;
}
const read = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;

it("Wait during the auto-start's preview: the locked re-check sees it; the batch stays a held draft with no chunks", async () => {
  const b = await startableDraft();
  const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
  hook.during = async () => { expect(await holdAutoStart(db, b.id)).toBe(true); };
  const enqueue = vi.fn(async () => "task");
  expect(await runAutoStart(db, { storage: {} as never, enqueue, now: () => new Date() }, { batchId: b.id, at })).toMatch(/^noop: Auto-start was turned off with Wait/);
  const after = await read(b.id);
  expect(after).toMatchObject({ status: "draft", startedAt: null });
  expect(after.options.autoStart).toBe(false);
  expect(await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, b.id))).toEqual([]);
});

it("with no Wait the same draft starts (the test draft is startable)", async () => {
  const b = await startableDraft();
  const at = (await armAutoStart(db, vi.fn(async () => "t"), b.id, 10, NOW))!;
  hook.during = async () => {};
  const enqueue = vi.fn(async () => "task");
  expect(await runAutoStart(db, { storage: {} as never, enqueue, now: () => new Date() }, { batchId: b.id, at })).toBe("started");
  expect((await read(b.id)).status).toBe("matting");
});

it("a second Start that loses to the first says the batch started, not that files changed (P3)", async () => {
  const b = await startableDraft();
  hook.during = async () => {};
  const deps = { storage: {} as never, enqueue: vi.fn(async () => "task") };
  const previewAt = new Date(Date.now() + 60_000).toISOString();
  hook.during = async () => { hook.during = async () => {}; await startDraftBatch(db, deps, b.id, previewAt); };
  await expect(startDraftBatch(db, deps, b.id, previewAt)).rejects.toMatchObject({ kind: "not_draft", message: "This batch has already started. Open its progress page." });
});
