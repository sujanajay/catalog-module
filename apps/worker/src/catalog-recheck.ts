// catalog-recheck CLI (spec 09 section 4.4; esbuild entry "catalog-recheck", `pnpm catalog:recheck`).
// The independent re-check of 00 section 12.3: a fresh process reads a delivered sheet, fetches every
// link with plain GETs (no storage library, no database for the GETs) and reports
// "Independent re-check: N of N OK".
//
//   pnpm catalog:recheck --sheet <links.xlsx|links.csv> [--csv <links.csv>]   (no cloud credentials)
//   pnpm catalog:recheck --batch <batchId>    (reads the batch's sheet and live rows; writes counts)
//   pnpm catalog:recheck --brand <slug>       (every live link of the brand)
//   options: [--out <report.csv>] [--concurrency <n>]
//
// As the Cloud Run job catalog-recheck the mode comes from RECHECK_BATCH or RECHECK_BRAND (set per
// execution by infra/catalog-scale-jobs.sh) and the report goes to CATALOG_REAL_OUT. Exits non-zero
// when any link or sheet-level check fails.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "@catalog/core/db/client";
import { catalogOutputs, catalogProducts } from "@catalog/core/db/schema";
import { recheckCsv, recheckLinks, sheetProblems, summarize, withNoLinks, type LinkResult, type SheetProblem } from "@catalog/core/catalog/recheck/check";
import { readCsvLinks, readSheetLinks } from "@catalog/core/catalog/recheck/links";
import { RECHECK_CONCURRENCY } from "@catalog/core/catalog/recheck/index";
import { compareXlsxCsv } from "@catalog/core/catalog/sheet";
import { recheckBatch } from "./catalog/recheck-batch";

const USAGE = "Usage: catalog:recheck --sheet <path.xlsx|.csv> [--csv <path.csv>] | --batch <id> | --brand <slug> [--out <report.csv>] [--concurrency <n>]";

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

async function sheetMode(file: string, csvFile: string | undefined, concurrency: number): Promise<{ results: LinkResult[]; problems: SheetProblem[] }> {
  const bytes = await readFile(file), isCsv = /\.csv$/i.test(file);
  const sheet = isCsv ? readCsvLinks(bytes.toString("utf8")) : await readSheetLinks(bytes);
  const problems = [...sheet.problems, ...sheetProblems(sheet.identifiers)];
  if (csvFile) {
    if (isCsv) throw new Error("--csv compares an xlsx sheet with its csv; pass the xlsx as --sheet.");
    problems.push(...(await compareXlsxCsv(bytes, await readFile(csvFile, "utf8"))).differences.map(detail => ({ problem: "xlsx_csv_mismatch", detail })));
  }
  const results = await recheckLinks(sheet.links.map(l => ({ url: l.url, identifier: l.identifier, channel: l.channel, n: l.n, hyperlinkOk: l.hyperlinkOk })), { concurrency });
  return { results, problems };
}

async function brandMode(brand: string, concurrency: number): Promise<{ results: LinkResult[]; problems: SheetProblem[] }> {
  const rows = await getDb().select({ url: catalogOutputs.publicUrl, generation: catalogOutputs.generation, channel: catalogOutputs.channel, n: catalogOutputs.n, identifier: catalogProducts.identifier })
    .from(catalogOutputs).innerJoin(catalogProducts, eq(catalogProducts.id, catalogOutputs.productId))
    .where(and(eq(catalogProducts.brandSlug, brand), eq(catalogOutputs.isLive, true)));
  if (!rows.length) throw new Error(`Brand ${brand} has no live links.`);
  const results = await recheckLinks(rows.map(r => ({ url: r.url, identifier: r.identifier, channel: r.channel, n: r.n, expectedGeneration: r.generation === null ? null : String(r.generation) })), { concurrency });
  return { results, problems: [] };
}

async function main() {
  const { values } = parseArgs({ options: { sheet: { type: "string" }, csv: { type: "string" }, batch: { type: "string" }, brand: { type: "string" }, out: { type: "string" }, concurrency: { type: "string" } } });
  const sheetFile = values.sheet, batchId = values.batch ?? process.env.RECHECK_BATCH, brand = values.brand ?? process.env.RECHECK_BRAND;
  if ([sheetFile, batchId, brand].filter(Boolean).length !== 1) throw new Error(USAGE);
  const concurrency = Number(values.concurrency ?? RECHECK_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer.");
  try {
    const checked = sheetFile ? await sheetMode(sheetFile, values.csv, concurrency) : batchId ? await recheckBatch(getDb(), batchId, { concurrency }) : await brandMode(brand!, concurrency);
    const results = checked.results, problems = withNoLinks(results, checked.problems);
    const summary = summarize(results, problems);
    const out = path.resolve(values.out ?? path.join(process.env.CATALOG_REAL_OUT ?? ".", `recheck-${stamp()}.csv`));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, recheckCsv(results, problems));
    for (const r of results.filter(r => r.status === "failed").slice(0, 50)) console.info(`FAILED ${r.identifier} ${r.channel ?? ""} ${r.n ?? ""} ${r.url}: ${r.problem}`);
    for (const p of problems) console.info(`FAILED sheet: ${p.problem}: ${p.detail}`);
    console.info(`Report: ${out}`);
    console.info(summary.line);
    console.info(`Independent re-check: ${summary.ok} of ${summary.total} OK`);
    if (!summary.passed) process.exitCode = 1;
  } finally {
    if (!sheetFile) await closeDb();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
