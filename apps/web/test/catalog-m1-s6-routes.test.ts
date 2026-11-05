// Tier 2 (PGlite), M1-S6: more photos for a started batch make a linked follow-up batch (M1-F5-R2, POST /extend), and
// files dropped while a batch is collected are added to it (M1 D23). Cloud Tasks and storage signing are fakes.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandMaster, catalogBatches } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { FOLLOW_UP_NOT_STARTED } from "@catalog/core/catalog/follow-up";
import { POST as create } from "../app/api/catalog/batches/route";
import { POST as extend } from "../app/api/catalog/batches/[id]/extend/route";
import { POST as planUploads } from "../app/api/catalog/batches/[id]/uploads/route";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";

vi.mock(import("@catalog/core/tasks"), async (original) => ({ ...await original(), enqueueTask: vi.fn(async () => "test-task") }));
vi.mock("@catalog/core/storage", async (original) => ({ ...await original<typeof import("@catalog/core/storage")>(), signedPutUrl: vi.fn(async (path: string) => `https://upload.example/${path}`) }));

let db: Db;
let close: () => Promise<void>;
const request = (body?: unknown) => new Request("http://localhost/api/catalog", { method: "POST", ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const batchOf = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
async function newBatch() {
  const response = await create(request({ brandSlug: "test-brand", productType: "auto", name: "catalog-test m1-s6", autoStart: true, channels: ["noon", "styli"] }));
  return (await response.json() as { id: string }).id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb()); setDbForTests(db);
  await db.insert(brandMaster).values({ slug: "test-brand", name: "Test Brand", line: "softline", source: "manual" });
});
afterAll(async () => { setDbForTests(undefined); resetUserDeps(); vi.unstubAllEnvs(); await close(); });
beforeEach(() => {
  vi.stubEnv("SKIP_IAP", "1"); vi.stubEnv("DEV_USER_EMAIL", "operator@opptra.com"); vi.stubEnv("BUCKET", "test-assets");
  setUserDeps({ roleLookup: async () => "operator" });
});

describe("POST /extend (M1-F5-R2)", () => {
  it("answers a follow-up linked to the running batch, with its brand and channels, that starts by itself; the same one again", async () => {
    const parent = await newBatch();
    await db.update(catalogBatches).set({ status: "rendering", startedAt: new Date() }).where(eq(catalogBatches.id, parent));
    const response = await extend(request(), ctx(parent));
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; created: boolean };
    expect(body.created).toBe(true);
    const followUp = await batchOf(body.id);
    expect(followUp).toMatchObject({ parentBatchId: parent, status: "draft", brandSlug: "test-brand", isTest: true, createdBy: "operator@opptra.com" });
    expect(followUp.channels).toEqual(["noon", "styli"]);
    expect(followUp.options.autoStart).toBe(true);
    expect(await (await extend(request(), ctx(parent))).json()).toEqual({ id: body.id, created: false });
    // The follow-up takes files like any draft.
    expect((await planUploads(request({ files: [{ name: "A_1.jpg", size: 10, mime: "image/jpeg", relativePath: "more/A_1.jpg" }] }), ctx(body.id))).status).toBe(200);
  });

  it("refuses a batch that has not started (409, its own page takes the photos) and a viewer (403)", async () => {
    const draft = await newBatch();
    const refused = await extend(request(), ctx(draft));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: FOLLOW_UP_NOT_STARTED });
    setUserDeps({ roleLookup: async () => "viewer" });
    expect((await extend(request(), ctx(draft))).status).toBe(403);
  });
});

describe("files dropped while collecting (M1 D23)", () => {
  it("adds them to the collecting batch, which goes back to draft for its new hand-off", async () => {
    const id = await newBatch();
    await db.update(catalogBatches).set({ status: "ingesting", counts: { ...(await batchOf(id)).counts, ingestRun: "first" } }).where(eq(catalogBatches.id, id));
    const response = await planUploads(request({ files: [{ name: "B_1.jpg", size: 10, mime: "image/jpeg", relativePath: "second/B_1.jpg" }] }), ctx(id));
    expect(response.status).toBe(200);
    const batch = await batchOf(id);
    expect(batch.status).toBe("draft");
    expect(batch.counts).toMatchObject({ previewReady: false, ingestRun: null });
  });
});
