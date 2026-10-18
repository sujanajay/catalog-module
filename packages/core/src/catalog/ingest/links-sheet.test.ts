import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { CatalogUpload } from "../../db/schema";
import {
  CANNOT_READ_IDENTIFIER, columnLetter, detectColumns, linksSheetAdapter, normalizeHeader, readLinksSheet, readSheetTable,
  sheetTableFromRows, type SheetSourceItem, type SheetTable,
} from "./links-sheet";
import { fetchSourceUrl } from "./url-list";
import type { CollectInput, IngestDeps } from "./types";

const FIXTURES = new URL("../../../test-fixtures/catalog/ingest-b/", import.meta.url);
const SUPA = "https://scbaqsxhzeouxqnijoex.supabase.co/storage/v1/object/public/softlines/anta";
const img = (id: string, n: number) => `${SUPA}/${id}/${id}_${n}.jpeg`;

async function xlsx(rows: unknown[][], sheetName = "Sheet1"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const table = (grid: string[][], title = "links.xlsx"): SheetTable => sheetTableFromRows(title, grid);
const read = (t: SheetTable, sheetColumns: CollectInput["options"]["sheetColumns"] = null) =>
  readLinksSheet(t, { sheetColumns }, { uploadId: "u1", origin: "sheet" });

/** The delivery-sheet shape the prototype describes: identifier in B, six photo columns H to M. */
function vendorSheet(): string[][] {
  const header = ["Brand", "Vendor Style Number", "Product Name", "Colour", "Size Range", "Price", "EAN",
    "Product Image 1", "Product Image 2", "Product Image 3", "Product Image 4", "Product Image 5", "Product Image 6"];
  const row = (id: string, ean: string) => ["Anta", id, `Runner ${id}`, "Black", "7-11", "4999", ean, ...[1, 2, 3, 4, 5, 6].map((n) => img(id, n))];
  return [header, row("112411101-1", "6941234500011"), row("112411101-2", "6941234500028"), row("112421102-3", "6941234500035")];
}

describe("normalizeHeader", () => {
  it("treats Color Code, color_code and COLORCODE as the same heading", () => {
    expect(new Set(["Color Code", "color_code", "COLORCODE"].map(normalizeHeader))).toEqual(new Set(["colorcode"]));
  });

  it("finds the colour-code column whichever spelling the sheet uses", () => {
    for (const h of ["Color Code", "color_code", "COLORCODE"]) {
      const d = detectColumns(table([["Style", h, "Image 1"], ["S1", "RED", img("S1", 1)], ["S2", "BLU", img("S2", 1)]]));
      expect(d.colourColumn).toBe(1);
    }
  });
});

describe("columnLetter", () => {
  it("maps 0-based indexes to spreadsheet letters", () => {
    expect([0, 1, 7, 12, 25, 26, 27, 51, 52].map(columnLetter)).toEqual(["A", "B", "H", "M", "Z", "AA", "AB", "AZ", "BA"]);
  });
});

describe("links-sheet.detectColumns", () => {
  it("builds the step 2 sentence for the vendor delivery sheet", () => {
    const d = detectColumns(table(vendorSheet()));
    expect(d.identifierColumn).toBe(1);
    expect(d.urlColumns).toEqual([7, 8, 9, 10, 11, 12]);
    expect(d.eanColumn).toBe(6);
    expect(d.isProductList).toBe(false);
    expect(d.sentence).toBe("We will use column B (Vendor Style Number) as the identifier and columns H to M (Product Image 1 to 6) as photos.");
  });

  it("records an EAN column but never picks it as the identifier", () => {
    const d = detectColumns(table([
      ["EAN", "Product Name", "Image URL"],
      ["8905701361431", "Shirt A", img("A", 1)],
      ["8905701361448", "Shirt B", img("B", 1)],
    ]));
    expect(d.eanColumn).toBe(0);
    expect(d.identifierColumn).toBe(1);

    const onlyEan = detectColumns(table([["Barcode", "Gender", "Image"], ["890570136143", "M", img("A", 1)], ["890570136144", "M", img("B", 1)]]));
    expect(onlyEan.eanColumn).toBe(0);
    expect(onlyEan.identifierColumn).toBe(-1);
  });

  it("uses style + colour code as a composite key and ignores the colour-name column", () => {
    const t = table([
      ["Style Number", "Colour Name", "Color Code", "Image 1", "Image 2"],
      ["S100", "Bright Red", "RED", img("S100_RED", 1), img("S100_RED", 2)],
      ["S100", "Deep Blue", "BLU", img("S100_BLU", 1), ""],
    ]);
    const d = detectColumns(t);
    expect(d).toMatchObject({ identifierColumn: 0, styleColumn: 0, colourColumn: 2, identifierHeader: "Style Number + Color Code" });
    expect(d.sentence).toBe("Grouped by style and colour code (Style Number + Color Code)");
    expect([...new Set(read(t).items.map((i) => i.identifier))]).toEqual(["S100_RED", "S100_BLU"]);
  });

  it("finds the header row under a title row", () => {
    const d = detectColumns(table([
      ["Anta delivery, October"],
      [],
      ["Option ID", "Product Name", "Image 1"],
      ["OPT-1", "Runner", img("OPT-1", 1)],
    ]));
    expect(d.headerRow).toBe(3);
    expect(d.identifierColumn).toBe(0);
    expect(d.sentence).toBe("We will use column A (Option ID) as the identifier and column C (Image 1) as photos.");
  });

  it("refuses with identifierColumn -1 when no heading matches and no column is 90% unique", () => {
    const d = detectColumns(table([
      ["Notes", "Qty", "Pics"],
      ["new", "1", img("A", 1)],
      ["new", "1", img("B", 1)],
      ["old", "2", img("C", 1)],
    ]));
    expect(d.identifierColumn).toBe(-1);
    expect(d.identifierHeader).toBeNull();
    expect(d.cannotRead).toBe("Could not tell which column holds the identifier.");
    expect(d.sentence).toBe(CANNOT_READ_IDENTIFIER);
    const r = read(table([["Notes", "Pics"], ["new", img("A", 1)], ["new", img("B", 1)]]));
    expect(r.items).toEqual([]);
    expect(r.detected).toMatchObject({ identifierColumn: -1, cannotRead: CANNOT_READ_IDENTIFIER });
  });

  it("uses the first row of a repeated identifier, adds none of the later URLs and warns once", () => {
    const r = read(table([
      ["Option ID", "Image 1", "Image 2"],
      ["ABC-123", img("ABC123", 1), img("ABC123", 2)],
      ["abc123", img("ABC123", 9), ""],
      ["XYZ9", img("XYZ9", 1), ""],
      ["XYZ 9", img("XYZ9", 8), ""],
    ], "anta-oct.xlsx"));
    expect(r.items.map((i) => [i.identifier, i.n, i.sheetRow])).toEqual([["ABC-123", 1, 2], ["ABC-123", 2, 2], ["XYZ9", 1, 4]]);
    expect(r.warnings).toEqual(["2 identifiers appear more than once in anta-oct.xlsx; the first row of each is used."]);
  });

  it("rejects a row without an identifier with its row number", () => {
    const r = read(table([["Option ID", "Image 1"], ["A1", img("A1", 1)], ["", img("X", 1)], ["B1", img("B1", 1)]]));
    expect(r.rejected).toEqual([{ name: "Row 3", reason: "Row 3 has no identifier." }]);
    expect(r.items.map((i) => i.identifier)).toEqual(["A1", "B1"]);
  });

  it("names the row and column of a URL that does not return an image", async () => {
    const r = read(table(vendorSheet()));
    const second = r.items.find((i) => i.identifier === "112411101-2" && i.n === 1)!;
    const fetch404: typeof fetch = async () => new Response("no", { status: 404 });
    const lookup = async () => ["104.18.38.10"];
    expect(await fetchSourceUrl(second, { fetch: fetch404 }, { lookup })).toEqual({
      ok: false,
      reason: `Row 3, column Product Image 1: ${img("112411101-2", 1)} did not return an image (got 404).`,
    });
    const html: typeof fetch = async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    expect(await fetchSourceUrl(second, { fetch: html }, { lookup })).toEqual({
      ok: false,
      reason: `Row 3, column Product Image 1: ${img("112411101-2", 1)} did not return an image (got text/html).`,
    });
  });
});

describe("links-sheet.ts reading", () => {
  it("reads an xlsx with header-named URL columns into url items in shot order", async () => {
    const buf = await xlsx(vendorSheet(), "Delivery");
    const t = await readSheetTable(buf, "anta-delivery.xlsx");
    expect(t.title).toBe("anta-delivery.xlsx");
    const r = read(t);
    expect(r.items).toHaveLength(18);
    const first = r.items[0]!;
    expect(first).toMatchObject({
      identifier: "112411101-1", n: 1, suffix: "", originalName: "112411101-1_1.jpeg", folder: null,
      sheetIdentifier: "112411101-1", ext: "jpeg", bytes: { kind: "url", url: img("112411101-1", 1) },
      uploadId: "u1", origin: "sheet", warnings: [], sheetRow: 2, sheetHeader: "Product Image 1",
    });
    expect(r.items.filter((i) => i.identifier === "112411101-1").map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.detected).toMatchObject({ kind: "sheet", rows: 3, headerRow: 1, identifierColumn: 1, identifierHeader: "Vendor Style Number", urlColumns: [7, 8, 9, 10, 11, 12], eanColumn: 6 });
  });

  it("detects unnamed URL columns by their content", () => {
    const d = detectColumns(table([
      ["Option ID", "Name", "", ""],
      ["A1", "Shirt", img("A1", 1), img("A1", 2)],
      ["B1", "Pant", img("B1", 1), ""],
    ]));
    expect(d.urlColumns).toEqual([2, 3]);
    expect(d.sentence).toBe("We will use column A (Option ID) as the identifier and columns C to D as photos.");
  });

  it("splits cells on , and ; and continues the numbering across columns", () => {
    const r = read(table([
      ["Option ID", "Images", "More images"],
      ["A1", `${img("A1", 1)}, ${img("A1", 2)};${img("A1", 3)}`, ` ${img("A1", 4)} `],
    ]));
    expect(r.items.map((i) => [i.n, i.bytes.kind === "url" ? i.bytes.url : ""])).toEqual([1, 2, 3, 4].map((n) => [n, img("A1", n)]));
  });

  it("uses an identifier column named Option ID", async () => {
    const t = await readSheetTable(await xlsx([["Size", "Option ID", "Main Image"], ["M", "STY-001-BLK", img("x", 1)], ["L", "STY-002-WHT", img("y", 1)]]), "o.xlsx");
    const d = detectColumns(t);
    expect(d.identifierColumn).toBe(1);
    expect(d.identifierHeader).toBe("Option ID");
  });

  it("marks a sheet with no URL columns as a product list", async () => {
    const t = await readSheetTable(await xlsx([["Style", "Color Code", "Size", "EAN"], ["S1", "RED", "M", "8905701361431"], ["S1", "RED", "L", "8905701361448"]]), "list.xlsx");
    const d = detectColumns(t);
    expect(d.isProductList).toBe(true);
    expect(d.urlColumns).toEqual([]);
    expect(read(t).items).toEqual([]);
  });

  it("reads Supabase public links as plain https", () => {
    const r = read(table([["Identifier", "Image 1"], ["112411101-1", img("112411101-1", 1)]]));
    expect(r.items[0]!.bytes).toEqual({ kind: "url", url: img("112411101-1", 1) });
    expect(r.items[0]!.originalName).toBe("112411101-1_1.jpeg");
  });

  it("lets options.sheetColumns override the detection", () => {
    const t = table(vendorSheet());
    const r = read(t, { identifier: 2, images: [9, 8] });
    expect(r.detection).toMatchObject({ identifierColumn: 2, identifierHeader: "Product Name", urlColumns: [9, 8], styleColumn: null, colourColumn: null });
    const items = r.items.filter((i) => i.identifier === "Runner 112411101-1");
    expect(items.map((i) => [i.n, i.sheetHeader])).toEqual([[1, "Product Image 3"], [2, "Product Image 2"]]);
  });

  it("takes the link of a hyperlinked xlsx cell", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Option ID", "Image 1"]);
    ws.addRow(["A1", { text: "photo", hyperlink: img("A1", 1) }]);
    const t = await readSheetTable(Buffer.from(await wb.xlsx.writeBuffer()), "h.xlsx");
    expect(read(t).items[0]!.bytes).toEqual({ kind: "url", url: img("A1", 1) });
  });

  it("reads a csv fixture (BOM, quoted cells, semicolons)", async () => {
    const t = await readSheetTable(readFileSync(new URL("links.csv", FIXTURES)), "links.csv");
    const r = read(t);
    expect(r.detection.identifierHeader).toBe("Option ID");
    expect(r.items.map((i) => `${i.identifier}_${i.n}`)).toEqual(["ABC123_1", "ABC123_2", "ABC123_3", "XYZ-9_1"]);
  });

  it("linksSheetAdapter downloads the upload and returns its items", async () => {
    const buf = await xlsx(vendorSheet());
    const downloads: string[] = [];
    const storage = {
      downloadBuffer: async (gsUri: string) => (downloads.push(gsUri), { buf, mime: "application/octet-stream" }),
    } as unknown as IngestDeps["storage"];
    const upload = { id: "u9", kind: "sheet", name: "anta.xlsx", gcsUri: "gs://b/catalog-test/anta/b1/uploads/u9/anta.xlsx" } as CatalogUpload;
    const items = await linksSheetAdapter.collect({
      batchId: "b1", brandSlug: "anta", prefix: "catalog-test/anta/b1", upload,
      options: { identifierMode: "sheet_column", precedence: "uploads_then_links", sheetColumns: null },
      deps: { storage, fetch: async () => { throw new Error("no fetch at collect time"); } },
    });
    expect(downloads).toEqual([upload.gcsUri]);
    expect(items).toHaveLength(18);
    expect((items[0] as SheetSourceItem).uploadId).toBe("u9");
  });
});
