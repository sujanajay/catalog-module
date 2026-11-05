// M1-S5 review 2 P1: the links workbook at the M1-F4 target (25k products, 225k outputs), every image sent with a note.
// The in-memory writer peaked at 3.8 GB for this shape (the worker has 4 GiB and runs 3 requests at once), and every
// reader of the Links sheet also parsed the 225k-row "Delivered with a note" sheet.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { firstSheetOnly } from "../first-sheet";
import type { NoteRow } from "./digest";
import { compareXlsxCsv, writeLinksCsv, writeLinksXlsx, type SheetSpec } from "./sheet";

const PRODUCTS = 25_000, PHOTOS = 9;
const link = (i: number, n: number) => `https://storage.googleapis.com/public-bucket/catalog/brand/P${i}/noon/P${i}_${n}.jpg`;

function shape(noteProducts: number): { spec: SheetSpec; notes: NoteRow[] } {
  const spec: SheetSpec = { channels: ["noon"], rows: Array.from({ length: PRODUCTS }, (_, i) => ({ brand: "Brand", identifier: `P${i}`, optionIdStyleColor: `P${i}-OPT`, opptraSkuIds: [`P${i}-S`],
    links: { noon: Array.from({ length: PHOTOS }, (_, n) => link(i, n + 1)) }, status: "ok" as const, notes: "", change: "new" as const, changedAt: null })) };
  const notes: NoteRow[] = [];
  for (let i = 0; i < noteProducts; i++) for (let n = 1; n <= PHOTOS; n++) notes.push({ identifier: `P${i}`, channel: "noon", image: n, link: link(i, n), reason: "not enlarged yet", rule: "sent with the best image we have", improves: true, better: "A larger version replaces it at the same link when the enlargement works. Nothing to do." });
  return { spec, notes };
}

/** The highest heap use above the starting point while `run` works (sampled between the writer's yields). */
async function heapGrowth<T>(run: () => Promise<T>): Promise<{ result: T; mb: number }> {
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 10);
  try {
    const result = await run();
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    return { result, mb: (peak - base) / 1e6 };
  } finally { clearInterval(timer); }
}

describe("links workbook at 25k products with 225k notes", () => {
  it("streams the sheets, so the writer's memory does not grow with the note rows, and the compare reads the Links sheet only", async () => {
    const { spec, notes } = shape(PRODUCTS);
    expect(notes).toHaveLength(225_000);
    const write = await heapGrowth(() => writeLinksXlsx(spec, { exceptions: [], notes }));
    const xlsx = write.result;
    // Measured locally: about 120-240 MB here against about 3.6 GB for the in-memory writer.
    expect(write.mb).toBeLessThan(800);

    const zip = await JSZip.loadAsync(xlsx);
    const parts = Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort();
    expect(parts).toEqual(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]);
    const notesXml = await zip.file("xl/worksheets/sheet3.xml")!.async("string");
    expect(notesXml).toContain(`<row r="${notes.length + 1}"`);
    expect(notesXml).toContain(link(PRODUCTS - 1, PHOTOS));

    // The compare (finalize, re-check) loads the Links sheet alone: the two digest sheets are cut before ExcelJS parses.
    const first = await JSZip.loadAsync(await firstSheetOnly(xlsx));
    expect(Object.keys(first.files).filter(p => p.startsWith("xl/worksheets/sheet"))).toEqual(["xl/worksheets/sheet1.xml"]);
    const compare = await heapGrowth(() => compareXlsxCsv(xlsx, writeLinksCsv(spec)));
    expect(compare.result).toEqual({ equal: true, differences: [] });
  }, 180_000);
});
