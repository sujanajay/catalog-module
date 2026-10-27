// Builds the spec 14 intake fixtures (docs/specs/14-intake-resilience.md section 8.1) so they stay in step:
//   intake-large-sheet.csv  - the attempt 3 stand-in (a Google Sheet as the csv the web tier writes)
//   intake-xlsx-grid.xlsx   - the attempt 1 stand-in, regenerated from the csv's first 6 rows
// Both generated files are committed. Re-run after changing this file, from the repository root:
//   pnpm --filter @catalog/web exec tsx ../../packages/core/test-fixtures/catalog/intake/build.ts
// Test Brand only, example.com hosts only (the browser harness serves them from a fake host).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CSV_PATH = path.join(DIR, "intake-large-sheet.csv");
export const XLSX_PATH = path.join(DIR, "intake-xlsx-grid.xlsx");
export const HOST = "https://example.com/test_brand";
const LINK_COLUMNS = 5;

/** The six products of attempt 1: option id, the file-name stem of its photos, and its photo count. */
export const XLSX_PRODUCTS = [
  { optionId: "BH-4610-NE", stem: "BH-4610-NE-NERO", style: "BH-4610", colour: "Nero", shots: 5 },
  { optionId: "BH-4611-BX", stem: "BH-4611-BX-BOXER", style: "BH-4611", colour: "Boxer", shots: 4 },
  { optionId: "BH-4612-MO", stem: "BH-4612-MO-MOCHA", style: "BH-4612", colour: "Mocha", shots: 5 },
  { optionId: "BH-4613-TN", stem: "BH-4613-TN-TAN", style: "BH-4613", colour: "Tan", shots: 4 },
  { optionId: "BH-4614-OL", stem: "BH-4614-OL-OLIVE", style: "BH-4614", colour: "Olive", shots: 5 },
  // The space-name product, as in the real list.
  { optionId: "BHSS2620Z-WN", stem: "BHSS2620Z-WHITE NAVY", style: "BHSS2620Z", colour: "White Navy", shots: 4 },
] as const;

/** Option ids that get a second row (a second size, no links): the duplicate-identifier warning with 2. */
const SECOND_SIZE = new Set<string>(["BH-4610-NE", "BH-4612-MO"]);

const link = (stem: string, n: number) => `${HOST}/${stem}_${n}.JPG`;

/** The csv rows: the 6 xlsx products plus `_OD`, then 54 more products; 60 rows, 287 links. */
function csvRows(): string[][] {
  const rows: string[][] = [];
  for (const p of XLSX_PRODUCTS) rows.push([`${p.optionId}_OD`, ...Array.from({ length: LINK_COLUMNS }, (_, i) => (i < p.shots ? link(p.stem, i + 1) : ""))]);
  // 54 more rows: the first 10 with 4 links, the other 44 with 5 (40 + 220 = 260; 27 + 260 = 287).
  for (let k = 0; k < 54; k++) {
    const id = `TB-${4700 + k}-OD`;
    const shots = k < 10 ? 4 : 5;
    rows.push([id, ...Array.from({ length: LINK_COLUMNS }, (_, i) => (i < shots ? link(id, i + 1) : ""))]);
  }
  return rows;
}

/** The csv text. No cell holds a comma, a quote or a newline, so no cell needs quoting. */
export function buildCsv(): string {
  const header = ["Unicommerce Code", ...Array.from({ length: LINK_COLUMNS }, (_, i) => `Image Link ${i + 1}`)];
  return [header, ...csvRows()].map((r) => r.join(",")).join("\n") + "\n";
}

/** The first 6 rows' links, by option id (the `_OD` suffix removed). */
function linksFromCsv(csv: string): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const line of csv.trim().split("\n").slice(1, 1 + XLSX_PRODUCTS.length)) {
    const [id, ...links] = line.split(",");
    byId.set(id!.replace(/_OD$/, ""), links.filter(Boolean));
  }
  return byId;
}

export async function buildXlsx(csv: string): Promise<Buffer> {
  const links = linksFromCsv(csv);
  const wb = new ExcelJS.Workbook();
  // Fixed metadata, so a rebuild with no change in this file gives the same cells and properties.
  wb.creator = "test_brand fixtures";
  wb.created = new Date("2026-10-27T00:00:00Z");
  wb.modified = new Date("2026-10-27T00:00:00Z");
  const ws = wb.addWorksheet("Sheet1");
  // A title row above the header, as in the real sheet.
  ws.addRow(["Test Brand bags, October lot"]);
  // 12 columns: Option Id at E, EAN at G, Image Link 1 to 5 at H to L.
  ws.addRow(["Brand", "Style", "Colour", "Size", "Option Id", "Product Name", "EAN", "Image Link 1", "Image Link 2", "Image Link 3", "Image Link 4", "Image Link 5"]);
  let ean = 8900000000001;
  for (const p of XLSX_PRODUCTS) {
    const urls = links.get(p.optionId);
    if (!urls || urls.length !== p.shots) throw new Error(`The csv does not hold ${p.shots} links for ${p.optionId}.`);
    const base = ["Test Brand", p.style, p.colour];
    ws.addRow([...base, "M", p.optionId, `${p.colour} bag`, String(ean++), ...urls]);
    if (SECOND_SIZE.has(p.optionId)) ws.addRow([...base, "L", p.optionId, `${p.colour} bag`, String(ean++)]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  writeFileSync(CSV_PATH, buildCsv());
  writeFileSync(XLSX_PATH, await buildXlsx(readFileSync(CSV_PATH, "utf8")));
  console.log(`wrote ${path.basename(CSV_PATH)} and ${path.basename(XLSX_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
