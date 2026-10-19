// The `--batch` mode of the independent re-check (spec 09 section 4.4), shared by catalog-recheck
// and the load driver. The sheet file is read from the private bucket; every link is then fetched
// with plain GETs and must carry the recorded live generation. The two numbers are written to
// counts.recheckOk and counts.recheckTotal, which the Details tab shows as
// "Independent re-check: N of N OK".
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs } from "@catalog/core/db/schema";
import { recheckLinks, sheetProblems, summarize, withNoLinks, type LinkResult, type RecheckSummary, type SheetProblem } from "@catalog/core/catalog/recheck/check";
import { readSheetLinks } from "@catalog/core/catalog/recheck/links";
import { compareXlsxCsv } from "@catalog/core/catalog/sheet";
import * as storage from "@catalog/core/storage";

export interface BatchRecheck { results: LinkResult[]; problems: SheetProblem[]; summary: RecheckSummary }

export async function recheckBatch(db: Db, batchId: string, options: { fetch?: typeof fetch; concurrency?: number; store?: Pick<typeof storage, "downloadBuffer"> } = {}): Promise<BatchRecheck> {
  const store = options.store ?? storage;
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error(`Batch ${batchId} does not exist.`);
  if (!batch.sheetXlsxUri) throw new Error("This batch has no links sheet yet. Wait until it says \"Ready to download\" or \"Needs attention\".");
  const xlsx = (await store.downloadBuffer(batch.sheetXlsxUri)).buf, sheet = await readSheetLinks(xlsx);
  const pairs = await db.select({ productId: catalogBatchProducts.productId }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId));
  const live = pairs.length
    ? await db.select({ url: catalogOutputs.publicUrl, generation: catalogOutputs.generation }).from(catalogOutputs).where(and(inArray(catalogOutputs.productId, pairs.map(p => p.productId)), eq(catalogOutputs.isLive, true)))
    : [];
  const expected = new Map(live.flatMap(r => (r.generation === null ? [] : [[r.url, String(r.generation)] as const])));
  // One row per batch product: counts.products (set at "Start processing") already includes the
  // product-list rows without photos (missing_images), which the sheet lists with no links.
  const problems: SheetProblem[] = [...sheet.problems, ...sheetProblems(sheet.identifiers, batch.counts.products)];
  if (batch.sheetCsvUri) {
    const cmp = await compareXlsxCsv(xlsx, (await store.downloadBuffer(batch.sheetCsvUri)).buf.toString("utf8"));
    problems.push(...cmp.differences.map(detail => ({ problem: "xlsx_csv_mismatch", detail })));
  }
  const results = await recheckLinks(sheet.links.map(l => ({ url: l.url, identifier: l.identifier, channel: l.channel, n: l.n, hyperlinkOk: l.hyperlinkOk, expectedGeneration: expected.get(l.url) ?? null })), options);
  problems.push(...withNoLinks(results, problems).slice(problems.length));
  const summary = summarize(results, problems);
  // Only the two re-check numbers change; updatedAt stays, as in finalize.
  await db.update(catalogBatches).set({ updatedAt: sql`${catalogBatches.updatedAt}`, counts: sql`${catalogBatches.counts} || jsonb_build_object('recheckOk', ${summary.ok}::int, 'recheckTotal', ${summary.total}::int)` }).where(eq(catalogBatches.id, batchId));
  return { results, problems, summary };
}
