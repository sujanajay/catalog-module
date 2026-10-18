import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { catalogBatches, catalogUploads, type CatalogUpload } from "../../db/schema";
import { createTestDb } from "../../db/testing";
import {
  GOOGLE_POLICY_BLOCKED, SHEET_NO_ACCESS, collectGoogleSheetOnWeb, googleAccessError, googleSheetAdapter, parseSheetGid, parseSpreadsheetId,
} from "./google-sheet";
import { linksSheetAdapter } from "./links-sheet";
import type { CollectInput, IngestDeps, SheetsLike } from "./types";

const SUPA = "https://scbaqsxhzeouxqnijoex.supabase.co/storage/v1/object/public/softlines/styli";
const ID = "1aBcD_efGhIjKlMnOpQrStUvWxYz0123456789";
const LINK = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=777`;
const GRID: string[][] = [
  ["Kids 1 Option Sneaker"],
  ["Option ID", "Product Name", "Image 1", "Image 2"],
  ["STY-1-BLK", "Sneaker", `${SUPA}/STY-1-BLK/STY-1-BLK_1.jpeg`, `${SUPA}/STY-1-BLK/STY-1-BLK_2.jpeg`],
  ["STY-2-WHT", "Sneaker", `${SUPA}/STY-2-WHT/STY-2-WHT_1.jpeg`, ""],
];

/** Fake Sheets client: two tabs; records every call. */
function fakeSheets(fail?: unknown) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const sheets: SheetsLike = {
    spreadsheets: {
      async get(params) {
        calls.push({ op: "get", params });
        if (fail) throw fail;
        return { data: { properties: { title: "Styli - Kids 1 Option Sneaker" }, sheets: [{ properties: { sheetId: 0, title: "Notes" } }, { properties: { sheetId: 777, title: "Kids' list" } }] } };
      },
      values: {
        async get(params) {
          calls.push({ op: "values", params });
          return { data: { values: params.range === "'Kids'' list'" ? GRID : [["wrong tab"]] } };
        },
      },
    },
  };
  return { sheets, calls };
}

function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const storage = {
    uploadBuffer: async (path: string, buf: Buffer) => (objects.set(`gs://bucket/${path}`, buf), `gs://bucket/${path}`),
    downloadBuffer: async (gsUri: string) => ({ buf: objects.get(gsUri)!, mime: "text/csv" }),
    listObjects: async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
  } as unknown as IngestDeps["storage"];
  return { storage, objects };
}

const gaxios = (status: number, message: string, reason?: string) =>
  Object.assign(new Error(message), { status, response: { status, data: { error: { code: status, message, errors: reason ? [{ reason }] : [] } } } });

function input(upload: Partial<CatalogUpload>, deps: Partial<IngestDeps>): CollectInput {
  return {
    batchId: "b1", brandSlug: "styli", prefix: "catalog-test/styli/b1",
    upload: { id: "u1", kind: "google_sheet", name: "Google Sheet", sourceUrl: LINK, gcsUri: null, detected: null, ...upload } as CatalogUpload,
    options: { identifierMode: "sheet_column", precedence: "uploads_then_links", sheetColumns: null },
    deps: { storage: fakeStorage().storage, fetch: async () => { throw new Error("no fetch"); }, ...deps },
  };
}

describe("parseSpreadsheetId / parseSheetGid", () => {
  it("reads the id and the tab", () => {
    expect(parseSpreadsheetId(LINK)).toBe(ID);
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/u/0/d/${ID}/view?usp=sharing`)).toBe(ID);
    expect(parseSpreadsheetId("https://drive.google.com/drive/folders/1xY")).toBeNull();
    expect(parseSheetGid(LINK)).toBe(777);
    expect(parseSheetGid(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=5#gid=5`)).toBe(5);
    expect(parseSheetGid(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toBeNull();
  });
});

describe("googleAccessError", () => {
  it("maps 403 and 404 to the share sentence and domain policy to the block sentence", () => {
    expect(googleAccessError(gaxios(403, "The caller does not have permission"), "sheet")).toBe(SHEET_NO_ACCESS);
    expect(googleAccessError(gaxios(404, "Requested entity was not found."), "sheet")).toBe(SHEET_NO_ACCESS);
    expect(googleAccessError(gaxios(403, "Forbidden", "cannotShareOutsideDomain"), "sheet")).toBe(GOOGLE_POLICY_BLOCKED);
    expect(googleAccessError(gaxios(403, "Blocked by domain policy"), "folder")).toBe(GOOGLE_POLICY_BLOCKED);
    expect(googleAccessError(gaxios(500, "Internal"), "sheet")).toBeNull();
  });
});

describe("collectGoogleSheetOnWeb and googleSheetAdapter", () => {
  it("reads the #gid tab, writes it as <title>.csv under uploads/<uploadId>/ and reads back like a links sheet", async () => {
    const { sheets, calls } = fakeSheets();
    const { storage, objects } = fakeStorage();
    const result = await collectGoogleSheetOnWeb(input({}, { sheets, storage }));
    expect(calls).toEqual([
      { op: "get", params: { spreadsheetId: ID, fields: "properties.title,sheets.properties(sheetId,title)" } },
      { op: "values", params: { spreadsheetId: ID, range: "'Kids'' list'" } },
    ]);
    expect(result).toMatchObject({
      kind: "google_sheet", title: "Styli - Kids 1 Option Sneaker", rows: 2, headerRow: 2, identifierColumn: 0, urlColumns: [2, 3],
      message: 'Google Sheet "Styli - Kids 1 Option Sneaker", 2 rows, 2 image columns found.',
    });
    const csvUri = "gs://bucket/catalog-test/styli/b1/uploads/u1/Styli_-_Kids_1_Option_Sneaker.csv";
    expect([...objects.keys()]).toEqual([csvUri]);

    // Worker side, without gcs_uri set: finds the csv by listing (BUCKET from the env).
    vi.stubEnv("BUCKET", "bucket");
    const items = await googleSheetAdapter.collect(input({ detected: result as unknown as Record<string, unknown> }, { storage }));
    vi.unstubAllEnvs();
    expect(items.map((i) => [i.identifier, i.n, i.origin])).toEqual([["STY-1-BLK", 1, "google_sheet"], ["STY-1-BLK", 2, "google_sheet"], ["STY-2-WHT", 1, "google_sheet"]]);

    // The same rows dropped as an xlsx give the same items.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Kids' list");
    GRID.forEach((r) => ws.addRow(r));
    objects.set("gs://bucket/x.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    const dropped = await linksSheetAdapter.collect(input({ kind: "sheet", name: "kids.xlsx", gcsUri: "gs://bucket/x.xlsx" }, { storage }));
    const strip = (xs: typeof items) => xs.map(({ origin: _o, ...rest }) => rest);
    expect(strip(items)).toEqual(strip(dropped));
  });

  it("returns the share sentence on 403 and the block sentence on a domain-policy 403, writing nothing", async () => {
    for (const [err, sentence] of [[gaxios(403, "The caller does not have permission"), SHEET_NO_ACCESS], [gaxios(403, "Forbidden", "cannotShareOutsideDomain"), GOOGLE_POLICY_BLOCKED]] as const) {
      const { storage, objects } = fakeStorage();
      expect(await collectGoogleSheetOnWeb(input({}, { sheets: fakeSheets(err).sheets, storage }))).toEqual({ kind: "google_sheet", error: sentence });
      expect(objects.size).toBe(0);
    }
  });

  it("rethrows errors that are not about access", async () => {
    await expect(collectGoogleSheetOnWeb(input({}, { sheets: fakeSheets(gaxios(500, "backend error")).sheets }))).rejects.toThrow("backend error");
  });

  describe("with a db", () => {
    let t: Awaited<ReturnType<typeof createTestDb>>;
    // PGlite can take a while to start while the other test files run in parallel.
    beforeAll(async () => {
      t = await createTestDb();
    }, 120_000);
    afterAll(async () => t.close());

    async function newUpload(): Promise<CatalogUpload> {
      const [b] = await t.db.insert(catalogBatches).values({ brandSlug: "styli", brandName: "Styli", name: "g", isTest: true, createdBy: "t" }).returning();
      const [u] = await t.db.insert(catalogUploads).values({ batchId: b!.id, kind: "google_sheet", name: "Google Sheet", sourceUrl: LINK }).returning();
      return u!;
    }

    it("writes detected, status, gcs_uri on success and error on no access", async () => {
      const ok = await newUpload();
      const { storage } = fakeStorage();
      await collectGoogleSheetOnWeb({ ...input(ok, { sheets: fakeSheets().sheets, storage }), upload: ok }, t.db);
      const [row] = await t.db.select().from(catalogUploads).where(eq(catalogUploads.id, ok.id));
      expect(row).toMatchObject({ status: "uploaded", error: null, gcsUri: `gs://bucket/catalog-test/styli/b1/uploads/${ok.id}/Styli_-_Kids_1_Option_Sneaker.csv` });
      expect(row!.detected).toMatchObject({ kind: "google_sheet", rows: 2 });

      const denied = await newUpload();
      await collectGoogleSheetOnWeb({ ...input(denied, { sheets: fakeSheets(gaxios(404, "not found")).sheets }), upload: denied }, t.db);
      const [row2] = await t.db.select().from(catalogUploads).where(eq(catalogUploads.id, denied.id));
      expect(row2).toMatchObject({ status: "failed", error: SHEET_NO_ACCESS, gcsUri: null, detected: { kind: "google_sheet", message: SHEET_NO_ACCESS } });
    });
  });
});
