// Tier 2 (PGlite): the input routes of spec 14b F3 - DELETE uploads/[uploadId], PATCH and DELETE links/[uploadId] -
// and the routes of spec 14c - POST cancel and POST reopen.
// The F3 acceptance flows (paste then replace, remove then collect) are in catalog-wizard-routes.test.ts.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandMaster, catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { POST as create } from "../app/api/catalog/batches/route";
import { DELETE as removeLinks, PATCH as patchLinks } from "../app/api/catalog/batches/[id]/links/[uploadId]/route";
import { DELETE as removeUpload } from "../app/api/catalog/batches/[id]/uploads/[uploadId]/route";
import { POST as cancel } from "../app/api/catalog/batches/[id]/cancel/route";
import { POST as reopen } from "../app/api/catalog/batches/[id]/reopen/route";
import { POST as ingest } from "../app/api/catalog/batches/[id]/ingest/route";
import { POST as start } from "../app/api/catalog/batches/[id]/start/route";
import { PATCH as patchDetected } from "../app/api/catalog/batches/[id]/detected/route";
import { regroupBatch } from "../lib/catalog/uploads";
import { BATCH_CANCELLED, BATCH_COULD_NOT_START, BATCH_STILL_COLLECTING, INPUT_NOT_FOUND } from "../lib/catalog/batches";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { enqueueTask } from "@catalog/core/tasks";

vi.mock("@catalog/core/tasks", () => ({ enqueueTask: vi.fn(async () => "test-task") }));
// The paste readback opens the first links (spec 14b F2): a fake image host, so no network is used.
vi.mock("@catalog/core/safe-url", async (original) => ({
  ...await original<typeof import("@catalog/core/safe-url")>(),
  pinnedFetch: vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 206, headers: { "content-type": "image/jpeg" } })),
}));

let db: Db;
let close: () => Promise<void>;
const request = (method: string, body?: unknown) => new Request("http://localhost/api/catalog/batches", { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const ctx = (id: string, uploadId?: string) => ({ params: Promise.resolve({ id, ...(uploadId ? { uploadId } : {}) }) });
const STARTED = "This batch has already started. Make a new batch to add more photos.";

beforeAll(async () => {
  ({ db, close } = await createTestDb()); setDbForTests(db);
  await db.insert(brandMaster).values({ slug: "test-brand", name: "Test Brand", line: "softline", source: "manual" });
});
afterAll(async () => { setDbForTests(undefined); resetUserDeps(); vi.unstubAllEnvs(); await close(); });
beforeEach(() => {
  vi.stubEnv("SKIP_IAP", "1"); vi.stubEnv("DEV_USER_EMAIL", "operator@opptra.com");
  setUserDeps({ roleLookup: async () => "operator" });
});
async function newBatch() {
  const response = await create(request("POST", { brandSlug: "test-brand", productType: "auto", name: "catalog-test inputs" }));
  return (await response.json() as { id: string }).id;
}
async function addRow(batchId: string, kind: "image" | "url_list" | "google_sheet", status: "pending" | "uploaded" = "uploaded") {
  const [row] = await db.insert(catalogUploads).values({ batchId, kind, name: kind, status, sourceUrl: kind === "image" ? null : `https://8.8.8.8/${kind}_1.jpg` }).returning();
  return row!;
}
const statusOf = async (uploadId: string) => (await db.select().from(catalogUploads).where(eq(catalogUploads.id, uploadId)))[0]!.status;

describe("input routes (spec 14b F3)", () => {
  it("refuses a viewer before touching the row", async () => {
    const id = await newBatch(); const file = await addRow(id, "image"); const paste = await addRow(id, "url_list");
    setUserDeps({ roleLookup: async () => "viewer" });
    for (const response of [await removeUpload(request("DELETE"), ctx(id, file.id)), await removeLinks(request("DELETE"), ctx(id, paste.id)), await patchLinks(request("PATCH", { text: "https://8.8.8.8/A_1.jpg" }), ctx(id, paste.id))]) expect(response.status).toBe(403);
    expect(await statusOf(file.id)).toBe("uploaded"); expect(await statusOf(paste.id)).toBe("uploaded");
  });
  it("answers 400 for an incomplete input id and 404 for another batch's input or the wrong route family", async () => {
    const id = await newBatch(); const other = await newBatch();
    const file = await addRow(id, "image"); const paste = await addRow(id, "url_list"); const google = await addRow(id, "google_sheet");
    expect((await removeUpload(request("DELETE"), ctx(id, "not-a-uuid"))).status).toBe(400);
    for (const response of [
      await removeUpload(request("DELETE"), ctx(other, file.id)),
      await removeUpload(request("DELETE"), ctx(id, paste.id)),
      await removeLinks(request("DELETE"), ctx(id, file.id)),
      await patchLinks(request("PATCH", { text: "https://8.8.8.8/A_1.jpg" }), ctx(id, file.id)),
    ]) { expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: INPUT_NOT_FOUND }); }
    expect(await statusOf(file.id)).toBe("uploaded"); expect(await statusOf(paste.id)).toBe("uploaded");
    // A Google link is a links input too.
    expect((await removeLinks(request("DELETE"), ctx(id, google.id))).status).toBe(200);
    expect(await statusOf(google.id)).toBe("removed");
  });
  it("removes a pending file (a cut-off upload) and is idempotent", async () => {
    const id = await newBatch(); const cut = await addRow(id, "image", "pending");
    for (let i = 0; i < 2; i++) {
      const response = await removeUpload(request("DELETE"), ctx(id, cut.id));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ removed: true });
    }
    expect(await statusOf(cut.id)).toBe("removed");
  });
  it("refuses removing or replacing while the batch is collecting or started, with the sentence for its status", async () => {
    for (const [status, sentence] of [["ingesting", BATCH_STILL_COLLECTING], ["matting", STARTED]] as const) {
      const id = await newBatch(); const file = await addRow(id, "image"); const paste = await addRow(id, "url_list");
      await db.update(catalogBatches).set({ status, ...(status === "matting" ? { startedAt: new Date() } : {}) }).where(eq(catalogBatches.id, id));
      for (const response of [await removeUpload(request("DELETE"), ctx(id, file.id)), await removeLinks(request("DELETE"), ctx(id, paste.id)), await patchLinks(request("PATCH", { text: "https://8.8.8.8/A_1.jpg" }), ctx(id, paste.id))]) {
        expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: sentence });
      }
      expect(await statusOf(file.id)).toBe("uploaded"); expect(await statusOf(paste.id)).toBe("uploaded");
    }
  });
});

// Tier 2: POST cancel (spec 14c F4 part 2), POST reopen and the assertDraft sentences (spec 14c F8).
const batchRow = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
async function setStatus(id: string, values: Partial<typeof catalogBatches.$inferInsert>) {
  await db.update(catalogBatches).set(values).where(eq(catalogBatches.id, id));
}
const REASON = "No photos could be downloaded from the 2 links you pasted.";
describe("cancel (spec 14c F4 part 2)", () => {
  it("cancels a draft, a collecting batch and a batch that failed before Start, and refuses a started one with 409", async () => {
    const draft = await newBatch(); const collecting = await newBatch(); const failed = await newBatch(); const started = await newBatch();
    await setStatus(collecting, { status: "ingesting" });
    await setStatus(failed, { status: "failed", counts: { ...(await batchRow(failed)).counts, failReason: REASON } });
    await setStatus(started, { status: "matting", startedAt: new Date() });
    for (const id of [draft, collecting, failed]) {
      const response = await cancel(request("POST"), ctx(id));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ id, status: "cancelled" });
      expect((await batchRow(id)).status).toBe("cancelled");
    }
    const refused = await cancel(request("POST"), ctx(started));
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: STARTED });
    expect((await batchRow(started)).status).toBe("matting");
    // A batch that failed after Start is started: refused too.
    const late = await newBatch(); await setStatus(late, { status: "failed", startedAt: new Date() });
    expect((await cancel(request("POST"), ctx(late))).status).toBe(409);
  });
  it("answers the same when cancelled twice, keeps the counts, and refuses a viewer", async () => {
    const id = await newBatch(); await addRow(id, "url_list");
    await setStatus(id, { status: "ingesting", counts: { ...(await batchRow(id)).counts, collected: 3, collectTotal: 10, phase: "downloading" } });
    expect((await cancel(request("POST"), ctx(id))).status).toBe(200);
    expect((await cancel(request("POST"), ctx(id))).status).toBe(200);
    expect((await batchRow(id)).counts).toMatchObject({ collected: 3, collectTotal: 10, phase: "downloading" });
    const other = await newBatch();
    setUserDeps({ roleLookup: async () => "viewer" });
    expect((await cancel(request("POST"), ctx(other))).status).toBe(403);
    expect((await batchRow(other)).status).toBe("draft");
  });
  it("a cancelled batch is never handed to collecting again and refuses every change with its sentence", async () => {
    const id = await newBatch(); const file = await addRow(id, "image"); const paste = await addRow(id, "url_list");
    expect((await cancel(request("POST"), ctx(id))).status).toBe(200);
    for (const response of [
      await ingest(request("POST"), ctx(id)),
      await removeUpload(request("DELETE"), ctx(id, file.id)),
      await patchLinks(request("PATCH", { text: "https://8.8.8.8/A_1.jpg" }), ctx(id, paste.id)),
      await reopen(request("POST"), ctx(id)),
      await start(request("POST", { previewAt: new Date().toISOString() }), ctx(id)),
    ]) { expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: BATCH_CANCELLED }); }
    expect((await batchRow(id)).status).toBe("cancelled");
    expect(enqueueTask).not.toHaveBeenCalledWith("/tasks/catalog/ingest", expect.objectContaining({ batchId: id }), expect.anything());
  });
});
describe("web counts writes and the instant step 2 Continue (spec 14c F6 and F7 part 1)", () => {
  const claim = { token: "run-1:upload-1", until: new Date(Date.now() + 60_000).toISOString() };
  it("a step 2 Continue with nothing changed returns at once: no regroup, no upload change, no hand-off", async () => {
    const id = await newBatch(); const file = await addRow(id, "image");
    await db.update(catalogUploads).set({ status: "collected" }).where(eq(catalogUploads.id, file.id));
    const { options, counts } = await batchRow(id);
    await setStatus(id, { counts: { ...counts, previewReady: true, phase: "ready" } });
    vi.mocked(enqueueTask).mockClear();
    const same = await patchDetected(request("PATCH", { identifierMode: options.identifierMode, precedence: options.precedence, sheets: [] }), ctx(id));
    expect(same.status).toBe(200); expect(await same.json()).toEqual({ collecting: false });
    expect(enqueueTask).not.toHaveBeenCalled(); expect(await statusOf(file.id)).toBe("collected");
    expect((await batchRow(id)).counts.previewReady).toBe(true);
    // A changed answer regroups: the upload is read again and handed to collecting.
    const changed = await patchDetected(request("PATCH", { identifierMode: "folder", precedence: options.precedence, sheets: [] }), ctx(id));
    expect(await changed.json()).toEqual({ collecting: true });
    expect(enqueueTask).toHaveBeenCalledWith("/tasks/catalog/ingest", expect.objectContaining({ batchId: id, uploadId: file.id, run: expect.any(String) }), expect.anything());
    expect((await batchRow(id)).status).toBe("ingesting");
  });
  it("regroupBatch merges: phase and the other worker keys stay, previewReady and the placing lease are cleared", async () => {
    const id = await newBatch(); await addRow(id, "image");
    await setStatus(id, { counts: { ...(await batchRow(id)).counts, previewReady: true, phase: "ready", placed: 27, placeTotal: 27, placingClaim: claim, collected: 27, collectTotal: 27 } });
    await regroupBatch(id);
    expect((await batchRow(id)).counts).toMatchObject({ previewReady: false, phase: "ready", placed: 27, placeTotal: 27, placingClaim: null, collected: 27, collectTotal: 27 });
  });
  it("Try again keeps a live placing lease and clears the one a stalled batch left", async () => {
    const id = await newBatch(); const file = await addRow(id, "image");
    await setStatus(id, { status: "ingesting", updatedAt: new Date(), counts: { ...(await batchRow(id)).counts, phase: "placing", placingClaim: claim } });
    expect((await ingest(request("POST"), ctx(id))).status).toBe(200);
    expect((await batchRow(id)).counts).toMatchObject({ phase: "placing", placingClaim: claim });
    await setStatus(id, { updatedAt: new Date(Date.now() - 11 * 60_000) });
    await db.update(catalogUploads).set({ status: "uploaded" }).where(eq(catalogUploads.id, file.id));
    expect((await ingest(request("POST"), ctx(id))).status).toBe(200);
    expect((await batchRow(id)).counts).toMatchObject({ phase: "placing", placingClaim: null });
  });
});
describe("reopen and the assertDraft sentences (spec 14c F8)", () => {
  it("reopens a batch that failed before Start: draft, reason cleared, inputs kept, the old reason answered", async () => {
    const id = await newBatch(); const paste = await addRow(id, "url_list"); const file = await addRow(id, "image");
    await db.update(catalogUploads).set({ status: "failed" }).where(eq(catalogUploads.id, paste.id));
    await setStatus(id, { status: "failed", counts: { ...(await batchRow(id)).counts, failReason: REASON, previewReady: true, linkFailures: 2 } });
    const response = await reopen(request("POST"), ctx(id));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ id, status: "draft", failReason: REASON });
    const row = await batchRow(id);
    expect(row.status).toBe("draft"); expect(row.counts).toMatchObject({ failReason: null, previewReady: false, linkFailures: 2 });
    expect(await statusOf(paste.id)).toBe("failed"); expect(await statusOf(file.id)).toBe("uploaded");
    // A draft answers as it is.
    expect(await (await reopen(request("POST"), ctx(id))).json()).toEqual({ id, status: "draft", failReason: null });
  });
  it("refuses to reopen a batch that failed after Start, and a viewer", async () => {
    const id = await newBatch();
    await setStatus(id, { status: "failed", startedAt: new Date(), counts: { ...(await batchRow(id)).counts, failReason: REASON } });
    const refused = await reopen(request("POST"), ctx(id));
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: STARTED });
    expect((await batchRow(id)).status).toBe("failed");
    const never = await newBatch(); await setStatus(never, { status: "failed" });
    setUserDeps({ roleLookup: async () => "viewer" });
    expect((await reopen(request("POST"), ctx(never))).status).toBe(403);
    expect((await batchRow(never)).status).toBe("failed");
  });
  it("words the refusal of a change by the batch's status", async () => {
    const cases = [
      [{ status: "failed" }, "This batch could not start. Press Fix and continue to change its photos or links."],
      [{ status: "ingesting" }, "This batch is still collecting. Wait for it to finish, or press Try again if nothing has moved for 10 minutes."],
      [{ status: "rendering", startedAt: new Date() }, "This batch has already started. Make a new batch to add more photos."],
      [{ status: "cancelled" }, "This batch was cancelled. Make a new batch."],
    ] as const;
    expect(cases.map(([, s]) => s)).toEqual([BATCH_COULD_NOT_START, BATCH_STILL_COLLECTING, STARTED, BATCH_CANCELLED]);
    for (const [values, sentence] of cases) {
      const id = await newBatch(); const file = await addRow(id, "image");
      await setStatus(id, values);
      const response = await removeUpload(request("DELETE"), ctx(id, file.id));
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: sentence });
    }
  });
});
