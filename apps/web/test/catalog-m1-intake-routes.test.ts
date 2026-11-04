// Tier 2 (PGlite), M1-S1: per-root grouping options (M1-F1-R2) and the Supabase folder paste kind
// (M1-F1-R4), including M1-F1 acceptance test 2 at the route level: a Supabase folder link and a
// Google Sheet pasted together are both read, and the sheet's columns are detected without step 2.
// Google and Supabase are fakes; nothing leaves the process and nothing is written to Supabase.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandMaster, catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import type { SheetsLike } from "@catalog/core/catalog/ingest/types";
import type { SupabaseStorageLike } from "@catalog/core/catalog/ingest/supabase-folder";
import { SUPABASE_OFF } from "@catalog/core/catalog/ingest/supabase-folder";
import { POST as create } from "../app/api/catalog/batches/route";
import { POST as addLinks } from "../app/api/catalog/batches/[id]/links/route";
import { PATCH as patchDetected } from "../app/api/catalog/batches/[id]/detected/route";
import { pasteEntries } from "../components/catalog/paste-check";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";

vi.mock(import("@catalog/core/tasks"), async (original) => ({ ...await original(), enqueueTask: vi.fn(async () => "test-task") }));
// Image links are sampled at paste time: a fake host answers each with the first bytes of a jpeg.
vi.mock("@catalog/core/safe-url", async (original) => ({
  ...await original<typeof import("@catalog/core/safe-url")>(),
  pinnedFetch: vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 206, headers: { "content-type": "image/jpeg" } })),
}));
vi.mock("../lib/catalog/uploads", async (original) => ({ ...await original<typeof import("../lib/catalog/uploads")>(), regroupBatch: vi.fn(async () => undefined) }));

const SUPA = "https://projref.supabase.co";
const FOLDER = `${SUPA}/storage/v1/object/public/softlines/anta`;
const SHEET = "https://docs.google.com/spreadsheets/d/1aBcD_efGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0";
const GRID = [
  ["Option Id", "Name", "Image 1", "Image 2"],
  ["STY-1-BLK", "Sneaker", `${FOLDER}/STY-1-BLK/1.jpg`, `${FOLDER}/STY-1-BLK/2.jpg`],
  ["STY-2-WHT", "Sneaker", `${FOLDER}/STY-2-WHT/1.jpg`, ""],
];
const sheets: SheetsLike = {
  spreadsheets: {
    async get() { return { data: { properties: { title: "Anta links" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] } }; },
    values: { async get() { return { data: { values: GRID } }; } },
  },
};
vi.mock("@catalog/core/catalog/ingest/google-sheet", async (original) => ({
  ...await original<typeof import("@catalog/core/catalog/ingest/google-sheet")>(),
  googleClients: vi.fn(async () => ({ sheets, drive: {} })),
}));

const fakeSupabase: SupabaseStorageLike = {
  origin: SUPA,
  async isPublic() { return true; },
  async list(_bucket, prefix) {
    const code = { anta: "ZSKU", uspa: "USKU" }[prefix];
    if (code) return [1, 2].map((n) => ({ name: `${code}${n}`, id: null, metadata: null }));
    return ["front.jpg", "back.jpg"].map((name) => ({ name, id: `${prefix}/${name}`, metadata: { size: 80_000 } }));
  },
};
let supabaseOn = true;
vi.mock("../lib/catalog/supabase", async (original) => ({
  ...await original<typeof import("../lib/catalog/supabase")>(),
  supabaseClient: vi.fn(() => (supabaseOn ? fakeSupabase : null)),
}));

let db: Db;
let close: () => Promise<void>;
const request = (method: string, body?: unknown) => new Request("http://localhost/api/catalog/batches", { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const batchOf = async (id: string) => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, id)))[0]!;
const uploadsOf = (id: string) => db.select().from(catalogUploads).where(eq(catalogUploads.batchId, id));

beforeAll(async () => {
  ({ db, close } = await createTestDb()); setDbForTests(db);
  await db.insert(brandMaster).values({ slug: "test-brand", name: "Test Brand", line: "softline", source: "manual" });
});
afterAll(async () => { setDbForTests(undefined); resetUserDeps(); vi.unstubAllEnvs(); await close(); });
beforeEach(() => {
  supabaseOn = true;
  vi.stubEnv("SKIP_IAP", "1"); vi.stubEnv("DEV_USER_EMAIL", "operator@opptra.com");
  setUserDeps({ roleLookup: async () => "operator" });
});
async function newBatch() {
  const response = await create(request("POST", { brandSlug: "test-brand", productType: "auto", name: "catalog-test m1" }));
  return (await response.json() as { id: string }).id;
}
async function paste(id: string, text: string) {
  const answers: Record<string, unknown>[] = [];
  for (const entry of pasteEntries(text, supabaseOn)) {
    const r = await addLinks(request("POST", { text: entry }), ctx(id));
    expect(r.status).toBe(200);
    answers.push(await r.json() as Record<string, unknown>);
  }
  return answers;
}

describe("per-root grouping options (M1-F1-R2)", () => {
  it("a new batch groups per root; step 2 can force one mode and switch back", async () => {
    const id = await newBatch();
    expect((await batchOf(id)).options).toMatchObject({ identifierMode: "filename", perRoot: true });
    expect((await patchDetected(request("PATCH", { identifierMode: "folder", perRoot: false, precedence: "uploads_then_links", sheets: [] }), ctx(id))).status).toBe(200);
    expect((await batchOf(id)).options).toMatchObject({ identifierMode: "folder", perRoot: false });
    expect((await patchDetected(request("PATCH", { perRoot: true, precedence: "uploads_then_links", sheets: [] }), ctx(id))).status).toBe(200);
    expect((await batchOf(id)).options).toMatchObject({ perRoot: true });
    // An API caller that sends a different mode without perRoot (as before M1) gets that mode for the whole batch.
    expect((await patchDetected(request("PATCH", { identifierMode: "filename" }), ctx(id))).status).toBe(200);
    expect((await batchOf(id)).options.perRoot).toBe(false);
    expect((await patchDetected(request("PATCH", { perRoot: "yes" }), ctx(id))).status).toBe(400);
  });

  it("M1-F2-R7: \"Use only the newest photo of each product\" is on by default and can be turned off and on", async () => {
    const id = await newBatch();
    expect((await batchOf(id)).options.newestSameProduct).toBeUndefined();
    expect((await patchDetected(request("PATCH", { newestSameProduct: false, precedence: "uploads_then_links", sheets: [] }), ctx(id))).status).toBe(200);
    expect((await batchOf(id)).options.newestSameProduct).toBe(false);
    expect((await patchDetected(request("PATCH", { newestSameProduct: true }), ctx(id))).status).toBe(200);
    expect((await batchOf(id)).options.newestSameProduct).toBe(true);
    expect((await patchDetected(request("PATCH", { newestSameProduct: "no" }), ctx(id))).status).toBe(400);
  });
});

describe("Supabase folder paste (M1-F1-R4) and M1-F1 acceptance test 2", () => {
  it("a Supabase folder link and a Google Sheet pasted together are both read; the sheet's columns are detected", async () => {
    const id = await newBatch();
    const answers = await paste(id, `${FOLDER}\n${SHEET}`);
    expect(answers.map((a) => [a.kind, a.access])).toEqual([["supabase_folder", "ok"], ["google_sheet", "ok"]]);
    expect(answers[0]).toMatchObject({ pill: "4 photos", summary: "Supabase folder softlines/anta: 4 photos in 2 folders, grouped by folder name." });

    const rows = await uploadsOf(id);
    const supa = rows.find((u) => u.name === "Supabase folder softlines/anta")!;
    expect(supa).toMatchObject({ kind: "url_list", status: "uploaded", error: null });
    expect(supa.sourceUrl!.split("\n")).toEqual([
      `ZSKU1\t${FOLDER}/ZSKU1/back.jpg`, `ZSKU1\t${FOLDER}/ZSKU1/front.jpg`, `ZSKU2\t${FOLDER}/ZSKU2/back.jpg`, `ZSKU2\t${FOLDER}/ZSKU2/front.jpg`,
    ]);
    expect(supa.detected).toMatchObject({ supabaseFolder: { url: FOLDER, mode: "folder" } });
    // The sheet is read at paste time: identifier and image columns found with no step 2 answer.
    const sheet = rows.find((u) => u.kind === "google_sheet")!;
    expect(sheet.status).toBe("uploaded");
    expect(sheet.detected).toMatchObject({ identifierColumn: 0, urlColumns: [2, 3] });
  });

  it("pasting the same folder again updates its row, and plain image links keep their own row", async () => {
    const id = await newBatch();
    await paste(id, FOLDER);
    await paste(id, FOLDER);
    expect((await uploadsOf(id)).filter((u) => u.kind === "url_list")).toHaveLength(1);
    const rows = await uploadsOf(id);
    expect(rows[0]!.detected).toMatchObject({ supabaseFolder: { url: FOLDER } });
  });

  it("pasting the same folder in another spelling (slash, query, signed) still updates its one row (review #7)", async () => {
    const id = await newBatch();
    await paste(id, FOLDER);
    await paste(id, `${FOLDER}/?x=1`);
    await paste(id, `${SUPA}/storage/v1/object/sign/softlines/anta?token=abc.def`);
    const rows = (await uploadsOf(id)).filter((u) => u.kind === "url_list");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detected).toMatchObject({ supabaseFolder: { url: FOLDER } });
    expect(JSON.stringify(rows[0]!.detected)).not.toContain("token");
  });

  it("every folder link in one text is read, and the image links beside them are kept (review #4)", async () => {
    const id = await newBatch();
    const r = await addLinks(request("POST", { text: `${FOLDER}
${SUPA}/storage/v1/object/public/softlines/uspa
https://img.example.com/ABC1_1.jpg` }), ctx(id));
    expect(r.status).toBe(200);
    const answer = await r.json() as { kind: string; others?: { kind: string; access: string }[] };
    expect([answer.kind, ...(answer.others ?? []).map((o) => o.kind)]).toEqual(["supabase_folder", "supabase_folder", "url_list"]);
    const rows = await uploadsOf(id);
    expect(rows.map((u) => u.name).sort()).toEqual(["Image links", "Supabase folder softlines/anta", "Supabase folder softlines/uspa"]);
    expect(rows.find((u) => u.name === "Image links")!.sourceUrl!.trim()).toBe("https://img.example.com/ABC1_1.jpg");
  });

  it("with the paste kind off, Supabase links are image links exactly as before: no failed row (review #1)", async () => {
    supabaseOn = false;
    const id = await newBatch();
    const spaced = `${FOLDER}/My Photo 1.jpg`;
    const answers = await paste(id, `${spaced}
${FOLDER}/ABC1_1.jpg
${FOLDER}/noext`);
    expect(answers.map((a) => [a.kind, a.access])).toEqual([["url_list", "ok"]]);
    const rows = await uploadsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "url_list", name: "Image links", status: "uploaded", error: null });
    expect(rows.some((u) => u.error === SUPABASE_OFF)).toBe(false);
  });

  it("with the paste kind on, a Supabase photo link with a space stays an image link (review #1)", async () => {
    const id = await newBatch();
    const answers = await paste(id, `${FOLDER}/My Photo 1.jpg`);
    expect(answers.map((a) => a.kind)).toEqual(["url_list"]);
    expect((await uploadsOf(id))[0]).toMatchObject({ kind: "url_list", name: "Image links", status: "uploaded" });
  });
});

describe("supabaseClient (the admin switch)", () => {
  it("is off without the URL and key, or when switched off", async () => {
    const { supabaseClient: real } = await vi.importActual<typeof import("../lib/catalog/supabase")>("../lib/catalog/supabase");
    const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
    expect(real(env({}))).toBeNull();
    expect(real(env({ SUPABASE_URL: SUPA, SUPABASE_SERVICE_KEY: "k", SUPABASE_FOLDER_PASTE: "off" }))).toBeNull();
    expect(real(env({ SUPABASE_URL: SUPA, SUPABASE_SERVICE_KEY: "k" }))?.origin).toBe(SUPA);
  });
});
