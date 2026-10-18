import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { CANNOT_READ_IDENTIFIER } from "./links-sheet";
import { MATCHED_INSIDE_FILE_NAMES, linkStatuses, matchProductList, productListDetected, readProductList } from "./product-list";
import type { GroupingResult } from "./types";

async function xlsx(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const grouped = (...ids: string[]): GroupingResult => ({ products: new Map(ids.map((id) => [id, []])), rejected: [], warnings: [] });
const row = (identifier: string) => ({ identifier, ean: null, raw: { Identifier: identifier } });

describe("readProductList", () => {
  it("reads the identifier and EAN columns and keeps every cell in raw", async () => {
    const buf = await xlsx({ Items: [["Option ID", "Name", "EAN"], ["abc-123", "Shirt", "8905701361431"], ["", "No id", ""], ["DEF456", "Pant", ""]] });
    expect(await readProductList(buf, "list.xlsx")).toEqual([
      { identifier: "abc-123", ean: "8905701361431", raw: { "Option ID": "abc-123", Name: "Shirt", EAN: "8905701361431" } },
      { identifier: "DEF456", ean: null, raw: { "Option ID": "DEF456", Name: "Pant", EAN: "" } },
    ]);
  });

  it("refuses a list whose identifier column cannot be told", async () => {
    const buf = await xlsx({ S: [["Notes", "Qty"], ["x", "1"], ["x", "1"]] });
    await expect(readProductList(buf, "l.xlsx")).rejects.toThrow(CANNOT_READ_IDENTIFIER);
  });
});

describe("linkStatuses", () => {
  it("gives ok, missing_images and not_in_sheet on normalised keys", () => {
    const s = linkStatuses([row("abc-123"), row("Def 456"), row("GHI789")], grouped("ABC123", "DEF_456", "NEW1"));
    expect(s).toEqual(new Map([["ABC123", "ok"], ["DEF_456", "ok"], ["NEW1", "not_in_sheet"], ["GHI789", "missing_images"]]));
  });

  it("gives every grouped identifier ok without a product list", () => {
    expect(linkStatuses([], grouped("A", "B"))).toEqual(new Map([["A", "ok"], ["B", "ok"]]));
  });

  it("matches _rect and _square by the base identifier; an absent shape is not reported", () => {
    const list = [row("ABC123"), row("XYZ9")];
    const s = linkStatuses(list, grouped("ABC123_rect", "XYZ9_rect", "XYZ9_square"));
    expect(s).toEqual(new Map([["ABC123_rect", "ok"], ["XYZ9_rect", "ok"], ["XYZ9_square", "ok"]]));
    const m = matchProductList(list, ["ABC123_rect", "XYZ9_rect", "XYZ9_square"]);
    expect(m.byIdentifier.get("XYZ9_rect")).toEqual([list[1]]);
    expect(m.byIdentifier.get("XYZ9_square")).toEqual([list[1]]);
    expect(m.unmatchedRows).toEqual([]);
  });

  it("matches ANTA-style <style>/<size>/EA rows, collects the per-size SKU ids and says how many", async () => {
    const buf = await xlsx({
      "Item Master": [
        ["Item Code", "Description", "Size", "Opptra SKU ID"],
        ["112411101-1/7/EA", "Runner black 7", "7", "ANT-112411101-1-7"],
        ["112411101-1/8/EA", "Runner black 8", "8", "ANT-112411101-1-8"],
        ["112411101-1/9/EA", "Runner black 9", "9", "ANT-112411101-1-9"],
        ["112411101-2/7/EA", "Runner white 7", "7", "ANT-112411101-2-7"],
        ["112421102-3/7/EA", "Walker 7", "7", "ANT-112421102-3-7"],
        ["112421102-3/8/EA", "Walker 8", "8", "ANT-112421102-3-8"],
      ],
    });
    const list = await readProductList(buf, "anta-master.xlsx");
    expect(list).toHaveLength(6);
    const m = matchProductList(list, ["112411101-1", "112411101-2", "NEW-9"]);
    expect(m.sizeRowsMatched).toBe(4);
    expect(m.productsMatchedBySize).toBe(2);
    expect(m.sizeSentence).toBe("4 size rows matched 2 products.");
    expect(m.skuIds.get("112411101-1")).toEqual(["ANT-112411101-1-7", "ANT-112411101-1-8", "ANT-112411101-1-9"]);
    expect(m.skuIds.get("112411101-2")).toEqual(["ANT-112411101-2-7"]);
    expect(linkStatuses(list, grouped("112411101-1", "112411101-2", "NEW-9"))).toEqual(new Map([
      ["112411101-1", "ok"], ["112411101-2", "ok"], ["NEW-9", "not_in_sheet"], ["112421102-3", "missing_images"],
    ]));
  });

  it("matches <style>-<size> rows by removing the last segment", () => {
    const m = matchProductList([row("STY100-S"), row("STY100-M"), row("STY100-L")], ["STY100"]);
    expect(m.sizeSentence).toBe("3 size rows matched 1 products.");
    expect(m.byIdentifier.get("STY100")).toHaveLength(3);
  });

  it("finds a composite style + colour key inside file stems in either order; the key becomes the identifier", async () => {
    const buf = await xlsx({ List: [["Style Code", "Colour Name", "Colour Code"], ["SS25-ABC", "Red", "RD01"], ["SS25-ABC", "Blue", "BL02"], ["XYZ9", "Black", "BK"]] });
    const list = await readProductList(buf, "fc.xlsx");
    expect(list[0]).toMatchObject({ identifier: "SS25-ABC_RD01", composite: { style: "SS25-ABC", colour: "RD01" } });
    const stems = ["FCUK_SS25-ABC_RD01_front", "BL02_SS25-ABC", "SS25-ABCD_BK", "OTHER"];
    const m = matchProductList(list, stems);
    expect(m.renamed).toEqual(new Map([["FCUK_SS25-ABC_RD01_front", "SS25-ABC_RD01"], ["BL02_SS25-ABC", "SS25-ABC_BL02"]]));
    expect(m.groupedBy).toBe(MATCHED_INSIDE_FILE_NAMES);
    expect(MATCHED_INSIDE_FILE_NAMES).toBe("Matched by style and colour code found inside the file names");
    expect(linkStatuses(list, grouped(...stems))).toEqual(new Map([
      ["SS25-ABC_RD01", "ok"], ["SS25-ABC_BL02", "ok"], ["SS25-ABCD_BK", "not_in_sheet"], ["OTHER", "not_in_sheet"], ["XYZ9_BK", "missing_images"],
    ]));
  });

  it("strips a trailing _<n> from a chosen match column", async () => {
    const buf = await xlsx({ Files: [["Sl No", "File Name", "Category"], ["1", "ABC123_1", "Shoes"], ["2", "ABC123_2", "Shoes"], ["3", "DEF456", "Shoes"], ["4", "ZZZ_1", "Bags"]] });
    const list = await readProductList(buf, "files.xlsx", { identifier: 1 });
    expect(list.map((r) => r.identifier)).toEqual(["ABC123_1", "ABC123_2", "DEF456", "ZZZ_1"]);
    const m = matchProductList(list, ["ABC123", "DEF456"], { byMatchColumn: true });
    expect(m.byIdentifier.get("ABC123")).toHaveLength(2);
    expect(m.sizeRowsMatched).toBe(0);
    expect(m.sizeSentence).toBeNull();
    expect(m.unmatchedRows.map((r) => r.identifier)).toEqual(["ZZZ_1"]);
  });
});

describe("productListDetected", () => {
  it("records matchColumn and every sheet name for the filled copy", async () => {
    const buf = await xlsx({ Notes: [["Read me"]], Items: [["Option ID", "EAN"], ["A1", "8905701361431"]], "Valid values": [["Size"], ["M"]] });
    // "Notes" has no header row, so the list is read from "Items".
    const auto = await productListDetected(await xlsx({ Items: [["Brand", "Option ID", "EAN"], ["X", "A1", "8905701361431"]], Info: [["x"]] }), "items.xlsx");
    expect(auto).toMatchObject({ kind: "product_list", matchColumn: 1, identifierColumn: 1, identifierHeader: "Option ID", eanColumn: 2, sheetNames: ["Items", "Info"], urlColumns: [], cannotRead: null });
    const chosen = await productListDetected(buf, "list.xlsx", { identifier: 0 });
    expect(chosen).toMatchObject({ matchColumn: 0, identifierHeader: "Option ID", rows: 1 });
    expect(chosen.sheetNames).toEqual(["Notes", "Items", "Valid values"]);
  });
});
