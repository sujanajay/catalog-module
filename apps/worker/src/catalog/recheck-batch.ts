// The `--batch` mode of the independent re-check (spec 09 section 4.4), shared by catalog-recheck
// and the load driver. The sheet file is read from the private bucket; every link is then fetched
// with plain GETs and must carry the recorded live generation. The numbers for this batch's delivered
// links are written to counts.recheckOk and counts.recheckTotal, which the Details tab shows as
// "Independent re-check: N of N OK"; the held products' earlier links the sheet keeps are counted
// apart (counts.recheckCarriedOk and counts.recheckCarriedTotal).
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs } from "@catalog/core/db/schema";
import { recheckLinks, sheetProblems, summarize, withNoLinks, type LinkResult, type RecheckSummary, type SheetProblem } from "@catalog/core/catalog/recheck/check";
import { readSheetLinks } from "@catalog/core/catalog/recheck/links";
import { compareXlsxCsv } from "@catalog/core/catalog/sheet";
import { deliveredLinks } from "@catalog/core/catalog/pipeline/report";
import * as storage from "@catalog/core/storage";

export interface BatchRecheck { results: LinkResult[]; problems: SheetProblem[]; summary: RecheckSummary }

export async function recheckBatch(db: Db, batchId: string, options: { fetch?: typeof fetch; concurrency?: number; store?: Pick<typeof storage, "downloadBuffer"> } = {}): Promise<BatchRecheck> {
  const store = options.store ?? storage;
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error(`Batch ${batchId} does not exist.`);
  if (!batch.sheetXlsxUri) throw new Error("This batch has no links sheet yet. Wait until it says \"Ready to download\" or \"Needs attention\".");
  const xlsx = (await store.downloadBuffer(batch.sheetXlsxUri)).buf, sheet = await readSheetLinks(xlsx);
  const pairs = await db.select({ productId: catalogBatchProducts.productId, change: catalogBatchProducts.change }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId));
  const outputs = pairs.length
    ? await db.select({ productId: catalogOutputs.productId, batchId: catalogOutputs.batchId, channel: catalogOutputs.channel, n: catalogOutputs.n, status: catalogOutputs.status, isLive: catalogOutputs.isLive, publicUrl: catalogOutputs.publicUrl, generation: catalogOutputs.generation }).from(catalogOutputs).where(inArray(catalogOutputs.productId, pairs.map(p => p.productId)))
    : [];
  const expected = new Map(outputs.flatMap(r => (!r.isLive || r.generation === null ? [] : [[r.publicUrl, String(r.generation)] as const])));
  const carried = new Set(deliveredLinks({ batchId, channels: batch.channels, heldProductIds: new Set(pairs.filter(p => p.change === "pending_attention").map(p => p.productId)), outputs }).carried);
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
  const carriedTotal = results.filter(r => carried.has(r.url)).length, carriedOk = results.filter(r => carried.has(r.url) && r.status === "ok").length;
  // Only the re-check numbers change; updatedAt stays, as in finalize.
  await db.update(catalogBatches).set({ updatedAt: sql`${catalogBatches.updatedAt}`, counts: sql`${catalogBatches.counts} || jsonb_build_object('recheckOk', ${summary.ok - carriedOk}::int, 'recheckTotal', ${summary.total - carriedTotal}::int, 'recheckCarriedOk', ${carriedOk}::int, 'recheckCarriedTotal', ${carriedTotal}::int)` }).where(eq(catalogBatches.id, batchId));
  return { results, problems, summary };
}
