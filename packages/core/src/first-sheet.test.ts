import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { firstSheetOnly } from "./first-sheet";

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

async function threeSheets(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const links = wb.addWorksheet("Links");
  links.getCell("A1").value = "Noon";
  links.mergeCells("A1:B1");
  links.getCell("A2").value = { text: "https://example.com/a.jpg", hyperlink: "https://example.com/a.jpg" };
  for (const name of ["Exceptions", "Delivered with a note"]) wb.addWorksheet(name).getCell("A1").value = name;
  wb.definedNames.add("'Delivered with a note'!$A$1", "far");
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 2, visibility: "visible" }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("firstSheetOnly", () => {
  it("keeps the first worksheet as it was (merges, hyperlinks) and drops the others", async () => {
    const wb = await load(await firstSheetOnly(await threeSheets()));
    expect(wb.worksheets.map(w => w.name)).toEqual(["Links"]);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell("B1").master.address).toBe("A1");
    expect(ws.getCell("A2").value).toEqual({ text: "https://example.com/a.jpg", hyperlink: "https://example.com/a.jpg" });
  });

  it("returns a one-sheet workbook and bytes that are not a zip unchanged", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Only").getCell("A1").value = "x";
    const one = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await firstSheetOnly(one)).toBe(one);
    const text = Buffer.from("identifier\nA1\n");
    expect(await firstSheetOnly(text)).toBe(text);
  });
});
