// P1 (M1-F2-R6): Wait pressed while an auto-start is building its preview, before Start's transaction locks the batch.
// buildPreview is replaced so the Wait lands exactly there; the locked re-check must see it and not start.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/testing";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS, EMPTY_BATCH_COUNTS } from "../../db/schema";
import { armAutoStart, holdAutoStart } from "../auto-start";
import { seedTaxonomy } from "../../analyze/taxonomy-seed";
import { seedChannelRules } from "../rules/seed";
import { publishChannelChange } from "../channel-rules-testing";

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
  hook.during = async () => { expect((await holdAutoStart(db, b.id)).held).toBe(true); };
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
  hook.during = async () => { hook.during = async () => {}; await startDraftBatch(db, deps, b.id, previewAt, { by: "test" }); };
  await expect(startDraftBatch(db, deps, b.id, previewAt, { by: "test" })).rejects.toMatchObject({ kind: "not_draft", message: "This batch has already started. Open its progress page." });
});

it("M5-S3: Start pins the ruleset version published at that moment and writes its snapshot file; a later publish leaves the batch on it", async () => {
  const before = await startableDraft();
  hook.during = async () => {};
  const files = new Map<string, Buffer>();
  const storage = {
    getBucketName: () => "assets",
    headObject: async (uri: string) => ({ exists: files.has(uri) }),
    uploadBuffer: async (path: string, buf: Buffer) => { files.set(`gs://assets/${path}`, buf); return `gs://assets/${path}`; },
  };
  // Nothing published yet: the batch pins nothing and reads the latest as it goes, as before M5-S3.
  await startDraftBatch(db, { storage: storage as never, enqueue: vi.fn(async () => "task") }, before.id, new Date(Date.now() + 60_000).toISOString(), { by: "test" });
  expect((await read(before.id)).rulesetVersion).toBeNull();
  await seedTaxonomy(db);
  await seedChannelRules(db);
  const b = await startableDraft();
  await startDraftBatch(db, { storage: storage as never, enqueue: vi.fn(async () => "task") }, b.id, new Date(Date.now() + 60_000).toISOString(), { by: "test" });
  expect((await read(b.id)).rulesetVersion).toBe(2);
  expect([...files.keys()]).toEqual(["gs://assets/rules/snapshots/v2.json"]);
  const published = await publishChannelChange(db, "noon", { background: "#F5F5F5" });
  expect((await read(b.id)).rulesetVersion).toBe(2);
  const next = await startableDraft();
  await startDraftBatch(db, { storage: storage as never, enqueue: vi.fn(async () => "task") }, next.id, new Date(Date.now() + 60_000).toISOString(), { by: "test" });
  expect((await read(next.id)).rulesetVersion).toBe(published);
}, 180_000);
