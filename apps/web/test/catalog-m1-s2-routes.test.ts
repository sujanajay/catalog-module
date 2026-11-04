// Tier 2 (PGlite), M1-S2: the one-page New batch's routes. Brand inference from dropped names (M1-F2-R3), default
// channels and autoStart on create (R4, R6, R9), and Wait (hold-start, R6). Cloud Tasks is a fake.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandMaster, catalogBatches, skuMap } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { SLICE_CHANNELS } from "@catalog/core/catalog/intake-defaults";
import { POST as create } from "../app/api/catalog/batches/route";
import { POST as infer } from "../app/api/catalog/brands/infer/route";
import { POST as holdStart } from "../app/api/catalog/batches/[id]/hold-start/route";
import { PATCH as patchBatch } from "../app/api/catalog/batches/[id]/route";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";

vi.mock(import("@catalog/core/tasks"), async (original) => ({ ...await original(), enqueueTask: vi.fn(async () => "test-task") }));

let db: Db;
let close: () => Promise<void>;
const request = (body?: unknown) => new Request("http://localhost/api/catalog", { method: "POST", ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const batchOf = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
async function newBatch(extra: Record<string, unknown> = {}) {
  const response = await create(request({ brandSlug: "test-brand", productType: "auto", name: "catalog-test m1-s2", ...extra }));
  return { status: response.status, body: await response.json() as { id: string; error?: string } };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb()); setDbForTests(db);
  await db.insert(brandMaster).values({ slug: "test-brand", name: "Test Brand", line: "softline", source: "manual" });
  await db.insert(skuMap).values([1, 2, 3].map((n) => ({ opptraSku: `TB${n}`, brand: "test-brand", brandSlug: "test-brand", line: "softline", optionKey: `TB${n}000BLACK`, optionIdStyleColor: `TB${n}000BLACK`, source: "manual" })) as never);
});
afterAll(async () => { setDbForTests(undefined); resetUserDeps(); vi.unstubAllEnvs(); await close(); });
beforeEach(() => {
  vi.stubEnv("SKIP_IAP", "1"); vi.stubEnv("DEV_USER_EMAIL", "operator@opptra.com");
  setUserDeps({ roleLookup: async () => "operator" });
});

describe("brand inference (M1-F2-R3)", () => {
  it("answers the brand of dropped names, or null when it must be asked", async () => {
    const known = await infer(request({ paths: ["AW26/TB1-000-BLACK_1.jpg", "AW26/TB2000BLACK_1.jpg", "AW26/TB3000BLACK_2.jpg"] }));
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ brandSlug: "test-brand", brandName: "Test Brand", resolved: 3, total: 3, channels: [...SLICE_CHANNELS], channelSource: "slice" });
    const unknown = await infer(request({ paths: ["IMG_0001.jpg"] }));
    expect(await unknown.json()).toMatchObject({ brandSlug: null, resolved: 0, total: 1 });
  });

  it("refuses a body without a list of names", async () => {
    expect((await infer(request({ paths: "x" }))).status).toBe(400);
  });
});

describe("create with autoStart (M1-F2-R4, R6, R9)", () => {
  it("an API batch keeps its explicit Start: no channels and no autoStart (R9)", async () => {
    const { body } = await newBatch();
    const batch = await batchOf(body.id);
    expect(batch.channels).toEqual([]);
    expect(batch.options.autoStart).toBeUndefined();
  });

  it("autoStart: true gives the brand's default channels and turns auto-start on", async () => {
    const { body } = await newBatch({ autoStart: true });
    const batch = await batchOf(body.id);
    expect(batch.channels).toEqual([...SLICE_CHANNELS]);
    expect(batch.options.autoStart).toBe(true);
  });

  it("channels given on create are kept", async () => {
    const { body } = await newBatch({ autoStart: true, channels: ["noon", "noon", "amazon"] });
    expect((await batchOf(body.id)).channels).toEqual(["noon", "amazon"]);
  });

  it("refuses a malformed autoStart or channel", async () => {
    expect((await newBatch({ autoStart: "yes" })).status).toBe(400);
    expect((await newBatch({ channels: ["ebay"] })).status).toBe(400);
  });
});

describe("Wait (hold-start, M1-F2-R6)", () => {
  it("turns auto-start off and keeps the draft", async () => {
    const { body } = await newBatch({ autoStart: true });
    await db.update(catalogBatches).set({ counts: { ...(await batchOf(body.id)).counts, autoStartAt: "2026-11-04T10:00:10.000Z" } }).where(eq(catalogBatches.id, body.id));
    const r = await holdStart(request(), ctx(body.id));
    expect(r.status).toBe(200);
    const batch = await batchOf(body.id);
    expect(batch).toMatchObject({ status: "draft", options: { autoStart: false }, counts: { autoStartAt: null } });
  });

  it("answers 409 with the not-a-draft sentence for a batch that is no longer a draft", async () => {
    const { body } = await newBatch({ autoStart: true });
    await db.update(catalogBatches).set({ status: "matting", startedAt: new Date() }).where(eq(catalogBatches.id, body.id));
    const r = await holdStart(request(), ctx(body.id));
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toBe("This batch has already started. Make a new batch to add more photos.");
  });
});

describe("channels while collecting (M1-F2-R4)", () => {
  it("stay editable while the files are collected; other changes still need a draft", async () => {
    const { body } = await newBatch({ autoStart: true });
    await db.update(catalogBatches).set({ status: "ingesting" }).where(eq(catalogBatches.id, body.id));
    const patch = (value: unknown) => patchBatch(new Request("http://localhost/api/catalog", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }), ctx(body.id));
    expect((await patch({ channels: ["noon"] })).status).toBe(200);
    expect((await batchOf(body.id)).channels).toEqual(["noon"]);
    expect((await patch({ channels: ["noon"], name: "catalog-test other" })).status).toBe(409);
    await db.update(catalogBatches).set({ status: "matting", startedAt: new Date() }).where(eq(catalogBatches.id, body.id));
    expect((await patch({ channels: ["namshi"] })).status).toBe(409);
  });
});
