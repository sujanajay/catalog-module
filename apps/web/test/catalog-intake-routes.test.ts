// Tier 2 (PGlite): the input routes of spec 14b F3 - DELETE uploads/[uploadId], PATCH and DELETE links/[uploadId].
// The F3 acceptance flows (paste then replace, remove then collect) are in catalog-wizard-routes.test.ts.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandMaster, catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { POST as create } from "../app/api/catalog/batches/route";
import { DELETE as removeLinks, PATCH as patchLinks } from "../app/api/catalog/batches/[id]/links/[uploadId]/route";
import { DELETE as removeUpload } from "../app/api/catalog/batches/[id]/uploads/[uploadId]/route";
import { INPUT_NOT_FOUND } from "../lib/catalog/batches";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";

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
  it("refuses removing or replacing while the batch is collecting or started, with the existing sentence", async () => {
    for (const status of ["ingesting", "matting"] as const) {
      const id = await newBatch(); const file = await addRow(id, "image"); const paste = await addRow(id, "url_list");
      await db.update(catalogBatches).set({ status }).where(eq(catalogBatches.id, id));
      for (const response of [await removeUpload(request("DELETE"), ctx(id, file.id)), await removeLinks(request("DELETE"), ctx(id, paste.id)), await patchLinks(request("PATCH", { text: "https://8.8.8.8/A_1.jpg" }), ctx(id, paste.id))]) {
        expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: STARTED });
      }
      expect(await statusOf(file.id)).toBe("uploaded"); expect(await statusOf(paste.id)).toBe("uploaded");
    }
  });
});
