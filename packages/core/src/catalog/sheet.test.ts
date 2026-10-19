import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../csv";
import { compareXlsxCsv, fillProductListWorkbook, sheetColumns, writeLinksCsv, writeLinksXlsx, type SheetRow, type SheetSpec } from "./sheet";

const U = (id: string, ch: string, n: number) => `https://storage.googleapis.com/pub/catalog/uspa/${id}/${ch}/${id}_${n}.jpg`;

function row(identifier: string, over: Partial<SheetRow> = {}): SheetRow {
  return {
    brand: "USPA",
    identifier,
    optionIdStyleColor: `${identifier}-OPT`,
    opptraSkuIds: [`${identifier}-S`, `${identifier}-M`],
    links: {
      noon: [U(identifier, "noon", 1), U(identifier, "noon", 2), U(identifier, "noon", 3)],
      amazon: [U(identifier, "amazon", 1), U(identifier, "amazon", 2)],
    },
    status: "ok",
    notes: "",
    change: "new",
    changedAt: new Date("2026-10-17T10:00:00Z"),
    ...over,
  };
}

function spec(): SheetSpec {
  return {
    channels: ["noon", "amazon"],
    rows: [
      row("ABC123"),
      row("8905701361431", { links: { noon: [U("8905701361431", "noon", 1), null], amazon: [null, U("8905701361431", "amazon", 2)] } }),
      row("ZZZ999", { status: "missing_images", links: { noon: [U("ZZZ999", "noon", 1)] }, change: "pending_attention", changedAt: null }),
      row("NEW777", { status: "not_in_sheet", links: { noon: [U("NEW777", "noon", 1)], amazon: [U("NEW777", "amazon", 1)] } }),
    ],
  };
}

async function load(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb.worksheets[0]!;
}

function text(v: ExcelJS.CellValue): string {
  if (v && typeof v === "object" && "hyperlink" in v) return String(v.text);
  return v === null || v === undefined ? "" : String(v);
}

function colOf(ws: ExcelJS.Worksheet, name: string, headerRow = 1): number {
  for (let c = 1; c <= ws.columnCount; c++) if (text(ws.getCell(headerRow, c).value) === name) return c;
  throw new Error(`column ${name} not found`);
}

describe("sheetColumns", () => {
  it("sizes each channel by its most shots, ignoring missing_images rows", () => {
    const cols = sheetColumns(spec());
    expect(cols.fixed).toEqual(["brand", "identifier", "option_id_style_color", "opptra_sku_ids"]);
    expect(cols.perChannel.noon).toBe(3);
    expect(cols.perChannel.amazon).toBe(2);
    expect(cols.perChannel.styli).toBe(0);
    expect(cols.tail).toEqual(["status", "notes", "change", "changed_at"]);
  });
});

describe("writeLinksXlsx", () => {
  it("writes merged channel headers over Image 1..N, bold, frozen below the header", async () => {
    const ws = await load(await writeLinksXlsx(spec()));
    // A-D fixed, E-G noon, H-I amazon, J-M tail
    expect(text(ws.getCell("E1").value)).toBe("Noon");
    expect(ws.getCell("G1").master.address).toBe("E1");
    expect(text(ws.getCell("H1").value)).toBe("Amazon");
    expect(ws.getCell("I1").master.address).toBe("H1");
    expect(ws.getCell("J1").master.address).toBe("J1");
    expect(["E2", "F2", "G2", "H2", "I2"].map((a) => text(ws.getCell(a).value))).toEqual([
      "Image 1",
      "Image 2",
      "Image 3",
      "Image 1",
      "Image 2",
    ]);
    expect(["J1", "K1", "L1", "M1"].map((a) => text(ws.getCell(a).value))).toEqual(["status", "notes", "change", "changed_at"]);
    for (const a of ["A1", "E1", "E2", "M1"]) expect(ws.getCell(a).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
  });

  it("writes hyperlinks, blanks for null, text identifiers and tail values, in natural order", async () => {
    const ws = await load(await writeLinksXlsx(spec()));
    // natural order: 8905701361431, ABC123, NEW777, ZZZ999
    expect([3, 4, 5, 6].map((r) => text(ws.getCell(r, 2).value))).toEqual(["8905701361431", "ABC123", "NEW777", "ZZZ999"]);
    const id = ws.getCell("B3");
    expect(id.value).toBe("8905701361431");
    expect(typeof id.value).toBe("string");
    expect(id.numFmt).toBe("@");
    expect(ws.getCell("D4").value).toBe("ABC123-S;ABC123-M");

    const link = ws.getCell("E4").value as ExcelJS.CellHyperlinkValue;
    expect(link).toMatchObject({ text: U("ABC123", "noon", 1), hyperlink: U("ABC123", "noon", 1) });
    expect(ws.getCell("F3").value).toBeNull();
    expect(text(ws.getCell("I3").value)).toBe(U("8905701361431", "amazon", 2));

    // missing_images: no links, status word; not_in_sheet: links kept
    expect(["E6", "F6", "G6", "H6", "I6"].map((a) => ws.getCell(a).value)).toEqual([null, null, null, null, null]);
    expect(ws.getCell("J6").value).toBe("missing_images");
    expect(text(ws.getCell("E5").value)).toBe(U("NEW777", "noon", 1));
    expect(ws.getCell("J5").value).toBe("not_in_sheet");

    expect(ws.getCell("L4").value).toBe("new");
    expect(ws.getCell("M4").value).toBe("2026-10-17T10:00:00.000Z");
    expect(ws.getCell("M6").value ?? "").toBe("");
  });

  it("keeps column widths within the caps", async () => {
    const long = row("L".repeat(80));
    const ws = await load(await writeLinksXlsx({ channels: ["noon", "amazon"], rows: [long, row("A1")] }));
    for (let c = 1; c <= 13; c++) {
      const w = ws.getColumn(c).width ?? 0;
      expect(w).toBeLessThanOrEqual(60);
      if (c >= 5 && c <= 9) expect(w).toBeGreaterThanOrEqual(40);
    }
    expect(ws.getColumn(2).width).toBe(60);
    expect(ws.getColumn(1).width).toBe("brand".length);
  });

  it("gives the same row order regardless of input order", async () => {
    const ids = ["A10", "A2", "a1", "B1", "A2b"];
    const order = async (list: string[]) => {
      const ws = await load(await writeLinksXlsx({ channels: ["noon"], rows: list.map((i) => row(i)) }));
      return Array.from({ length: list.length }, (_, k) => text(ws.getCell(k + 3, 2).value));
    };
    const a = await order(ids);
    expect(a).toEqual(["a1", "A2", "A2b", "A10", "B1"]);
    expect(await order([...ids].reverse())).toEqual(a);
  });
});

describe("writeLinksCsv", () => {
  it("uses the flat header and the same cells", () => {
    const rows = parseCsv(writeLinksCsv(spec()));
    expect(rows[0]).toEqual([
      "brand",
      "identifier",
      "option_id_style_color",
      "opptra_sku_ids",
      "Noon Image 1",
      "Noon Image 2",
      "Noon Image 3",
      "Amazon Image 1",
      "Amazon Image 2",
      "status",
      "notes",
      "change",
      "changed_at",
    ]);
    expect(rows[1]![1]).toBe("8905701361431");
    expect(rows[1]![5]).toBe("");
    expect(rows[4]!.slice(4, 9)).toEqual(["", "", "", "", ""]);
  });
});

describe("compareXlsxCsv", () => {
  it("finds the xlsx and csv equal, and reports a changed cell", async () => {
    const s = spec();
    const xlsx = await writeLinksXlsx(s);
    const csv = writeLinksCsv(s);
    expect(await compareXlsxCsv(xlsx, csv)).toEqual({ equal: true, differences: [] });

    const changed = csv.replace(U("ABC123", "noon", 2), U("ABC123", "noon", 9));
    const res = await compareXlsxCsv(xlsx, changed);
    expect(res.equal).toBe(false);
    expect(res.differences).toHaveLength(1);
    expect(res.differences[0]).toContain("ABC123");
    expect(res.differences[0]).toContain("Noon Image 2");
  });
});

describe("fillProductListWorkbook", () => {
  async function original(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");
    ws.addRow(["Size list for USPA"]);
    ws.addRow(["Style Color", "Size", "Opptra SKU", "Price"]);
    ws.addRow(["ABC123", "S", "SKU-1", 10]);
    ws.addRow(["ABC123", "M", "SKU-2", 10]);
    ws.addRow(["ABC123/L/EA", "L", "SKU-3", 11]);
    ws.addRow(["ZZZ999", "S", "SKU-9", 12]);
    ws.addRow(["8905701361431", "", "", 5]);
    ws.getCell("A7").numFmt = "@";
    const notes = wb.addWorksheet("Notes");
    notes.getCell("A1").value = "keep me";
    notes.getCell("C4").value = 42;
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  it("keeps every original cell, appends the columns, repeats links on size rows and appends not_in_sheet", async () => {
    const before = await original();
    const copy = Buffer.from(before);
    const out = await fillProductListWorkbook(before, spec(), 0);
    expect(before.equals(copy)).toBe(true);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet("Products")!;
    const notes = wb.getWorksheet("Notes")!;

    // original values untouched
    expect(ws.getCell("A1").value).toBe("Size list for USPA");
    expect(["A2", "B2", "C2", "D2"].map((a) => ws.getCell(a).value)).toEqual(["Style Color", "Size", "Opptra SKU", "Price"]);
    expect(["A3", "B3", "C3", "D3"].map((a) => ws.getCell(a).value)).toEqual(["ABC123", "S", "SKU-1", 10]);
    expect(ws.getCell("A7").value).toBe("8905701361431");
    expect(notes.getCell("A1").value).toBe("keep me");
    expect(notes.getCell("C4").value).toBe(42);
    // a sheet with no matching rows is left alone
    expect(notes.columnCount).toBe(3);
    expect(notes.getCell(1, 4).value).toBeNull();

    // appended header on the header row, right of the last column
    const status = colOf(ws, "link_status", 2);
    expect(status).toBe(5);
    expect(text(ws.getCell(2, 6).value)).toBe("Noon Image 1");
    expect(text(ws.getCell(2, 10).value)).toBe("Amazon Image 2");
    expect(ws.getCell(2, status).font?.bold).toBe(true);

    // per-size rows repeat their colourway's links
    for (const r of [3, 4, 5]) {
      expect(ws.getCell(r, status).value).toBe("ok");
      expect(text(ws.getCell(r, 6).value)).toBe(U("ABC123", "noon", 1));
      expect(text(ws.getCell(r, 10).value)).toBe(U("ABC123", "amazon", 2));
    }
    expect(ws.getCell(6, status).value).toBe("missing_images");
    expect(ws.getCell(6, 6).value).toBeNull();
    expect(ws.getCell(7, 7).value).toBeNull();
    expect(text(ws.getCell(7, 10).value)).toBe(U("8905701361431", "amazon", 2));

    // not_in_sheet product appended at the bottom, identifier as text in the match column
    expect(ws.getCell("A8").value).toBe("NEW777");
    expect(ws.getCell("A8").numFmt).toBe("@");
    expect(ws.getCell(8, status).value).toBe("not_in_sheet");
    expect(text(ws.getCell(8, 6).value)).toBe(U("NEW777", "noon", 1));
    expect(ws.rowCount).toBe(8);
  });

  it("refuses a negative match column", async () => {
    await expect(fillProductListWorkbook(await original(), spec(), -1)).rejects.toThrow(/matchColumn/);
  });
});

describe("a ticked channel with no images", () => {
  it("gets no column, so no empty Styli Image 1 appears", async () => {
    const s: SheetSpec = { channels: ["noon", "styli"], rows: [row("ABC123", { links: { noon: [U("ABC123", "noon", 1)] } })] };
    expect(sheetColumns(s).perChannel.styli).toBe(0);
    const csv = writeLinksCsv(s);
    expect(csv).not.toContain("Styli Image");
    const ws = await load(await writeLinksXlsx(s));
    expect(text(ws.getCell("E1").value)).toBe("Noon");
    expect(text(ws.getCell("F1").value)).toBe("status");
    expect(await compareXlsxCsv(await writeLinksXlsx(s), csv)).toEqual({ equal: true, differences: [] });
  });
});
