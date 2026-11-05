import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogSourceImages, catalogUploads } from "@catalog/core/db/schema";
import { brandExportPath } from "@catalog/core/catalog/naming";
import { CHANNEL_IDS, type ChannelId, type ChangeKind, type SheetStatus } from "@catalog/core/catalog/types";
import { writeLinksCsv, writeLinksXlsx, type SheetRow, type SheetSpec } from "@catalog/core/catalog/sheet";
import { downloadBuffer, signedUrl, uploadBuffer } from "@catalog/core/storage";
import { db, type Db } from "../db";
import { HttpError } from "../errors";
import { getBrand } from "./brands";
import { channel } from "@catalog/core/catalog/channels";
import { readSheetTable } from "@catalog/core/catalog/ingest/links-sheet";
import { firstSheetOnly } from "@catalog/core/first-sheet";
import { batchSheetStatus, notRefreshedChannels as readNotRefreshedChannels } from "@catalog/core/catalog/pipeline/report";
import { withoutModelNames } from "./redact";
import { batchCostFigure } from "@catalog/core/catalog/cost-report";
import { inrPerUsdFromEnv } from "@catalog/core/catalog/cost";
import { digestCost } from "@catalog/core/catalog/digest";
import { STYLI_SKIP_NOTE } from "@catalog/core/catalog/evals/completeness";

export async function batchExportUrl(id: string, format: string, conn: Db = db(), storage = { signedUrl, downloadBuffer }) {
  const [batch] = await conn.select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  let uri: string | null;
  if (format === "xlsx") uri = batch.sheetXlsxUri;
  else if (format === "csv") uri = batch.sheetCsvUri;
  else if (format === "filled") {
    if (!batch.reportUri) throw new HttpError(404, "No product list was uploaded in this batch.");
    const { buf } = await storage.downloadBuffer(batch.reportUri);
    const report = JSON.parse(buf.toString()) as { exports?: { filledProductList?: { xlsx?: string } | null } };
    uri = report.exports?.filledProductList?.xlsx ?? null;
    if (!uri) throw new HttpError(404, "No product list was uploaded in this batch.");
  } else if (format === "exceptions" || format === "notes") {
    // M1-S5: the digest sheets as csv (the xlsx carries them as its second and third sheets). Their paths are in the
    // digest, so the download never reads the report (M1-S5 review P2-3).
    if (!batch.digest) throw new HttpError(404, "The sheet is not ready yet. Wait for processing to finish.");
    uri = (format === "exceptions" ? batch.digest.page?.exceptionsCsv : batch.digest.page?.notesCsv) ?? null;
    if (!uri) throw new HttpError(404, "This batch finished before these sheets were made. Download the links sheet instead.");
  } else throw new HttpError(400, "Choose xlsx, csv, report, filled, exceptions or notes to download.");
  if (!uri) throw new HttpError(404, "The sheet is not ready yet. Wait for processing to finish.");
  return storage.signedUrl(uri, 7 * 86400);
}

/**
 * The batch report as the operator downloads it (Details, report.json). It is served through the
 * app rather than a signed link so model ids, which the stored report keeps for evals, are removed. R1 exit item 4: its
 * `cost` is the live batchCostFigure (the figure the page and the digest show), not the stored judge and chunk compute.
 */
export async function batchReport(id: string, conn: Db = db(), read = downloadBuffer): Promise<unknown> {
  const [batch] = await conn.select({ reportUri: catalogBatches.reportUri }).from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  if (!batch.reportUri) throw new HttpError(404, "The sheet is not ready yet. Wait for processing to finish.");
  const report = withoutModelNames(JSON.parse((await read(batch.reportUri)).buf.toString())) as Record<string, unknown>;
  const figure = await batchCostFigure(conn, id);
  return { ...report, cost: { ...digestCost(figure, inrPerUsdFromEnv()), products: figure.products } };
}

/** Ids per IN (...) list for a selection of products, well below Postgres's 65,535 bind parameters per query. */
const IN_LIST_MAX = 1000;
function slices<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_LIST_MAX) out.push(values.slice(i, i + IN_LIST_MAX));
  return out;
}
type LiveOutput = { productId: string; channel: ChannelId; n: number; publicUrl: string; publishedAt: Date | null };
const liveOutputColumns = { productId: catalogOutputs.productId, channel: catalogOutputs.channel, n: catalogOutputs.n, publicUrl: catalogOutputs.publicUrl, publishedAt: catalogOutputs.publishedAt };
/** One sheet row per product with its live links; the outputs are grouped once, not filtered per product. */
function liveRows(products: (typeof catalogProducts.$inferSelect)[], outputs: LiveOutput[], channels: ChannelId[]): SheetRow[] {
  const byProduct = new Map<string, LiveOutput[]>();
  for (const o of outputs) if (channels.includes(o.channel)) { const list = byProduct.get(o.productId); if (list) list.push(o); else byProduct.set(o.productId, [o]); }
  return products.map(p => {
    const links: SheetRow["links"] = {};
    let changedAt: Date | null = null;
    for (const o of byProduct.get(p.id) ?? []) {
      const list = links[o.channel] ?? [];
      while (list.length < o.n) list.push(null);
      list[o.n - 1] = o.publicUrl;
      links[o.channel] = list;
      if (o.publishedAt && (!changedAt || o.publishedAt > changedAt)) changedAt = o.publishedAt;
    }
    return { brand: p.brandSlug, identifier: p.identifier, optionIdStyleColor: p.optionIdStyleColor ?? "", opptraSkuIds: p.opptraSkuIds, links, status: "ok", notes: "", change: "unchanged", changedAt };
  });
}
const byIdentifier = (a: SheetRow, b: SheetRow) => a.identifier.localeCompare(b.identifier, "en", { numeric: true });

export async function liveSheet(productIds: string[], channels: ChannelId[], conn: Db = db()): Promise<SheetSpec> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return { channels, rows: [] };
  const parts = await Promise.all(slices(ids).map(slice => Promise.all([
    conn.select().from(catalogProducts).where(inArray(catalogProducts.id, slice)),
    conn.select(liveOutputColumns).from(catalogOutputs).where(and(inArray(catalogOutputs.productId, slice), eq(catalogOutputs.isLive, true))),
  ])));
  const rows = liveRows(parts.flatMap(([products]) => products), parts.flatMap(([, outputs]) => outputs), channels);
  rows.sort(byIdentifier);
  return { channels, rows };
}

async function savedSheet(uri: string, read: typeof downloadBuffer): Promise<SheetSpec> {
  // The Links sheet only: the Exceptions and "Delivered with a note" sheets after it are not parsed (review P2-1).
  const table = await readSheetTable(await firstSheetOnly((await read(uri)).buf), "links.xlsx");
  const columns = table.header;
  const imageHeaders = table.rows[0] ?? [];
  const channels = CHANNEL_IDS.filter(id => columns.includes(channel(id).label));
  const value = (cells: string[], name: string) => cells[columns.indexOf(name)] ?? "";
  const rows = table.rows.slice(1).map(cells => {
    const links: SheetRow["links"] = {};
    for (const id of channels) {
      links[id] = columns.flatMap((label, i) => label === channel(id).label && /^Image \d+$/.test(imageHeaders[i] ?? "") ? [cells[i] || null] : []);
    }
    const changedAt = value(cells, "changed_at");
    return { brand: value(cells, "brand"), identifier: value(cells, "identifier"), optionIdStyleColor: value(cells, "option_id_style_color"), opptraSkuIds: value(cells, "opptra_sku_ids").split(";").filter(Boolean), links,
      status: value(cells, "status") as SheetStatus, notes: value(cells, "notes"), change: value(cells, "change") as ChangeKind, changedAt: changedAt ? new Date(changedAt) : null };
  });
  return { channels, rows };
}

export async function batchSheet(id: string, conn: Db = db(), read = downloadBuffer) {
  const [batch] = await conn.select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  if (batch.sheetXlsxUri) return savedSheet(batch.sheetXlsxUri, read);
  // The batch's products and live outputs through the batch (no bind parameter per product), each row with its own member.
  const members = conn.select({ id: catalogBatchProducts.productId }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, id));
  const channels = CHANNEL_IDS.filter(c => batch.channels.includes(c));
  const [pairs, outputs] = await Promise.all([
    conn.select({ product: catalogProducts, member: catalogBatchProducts }).from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, id)),
    conn.select(liveOutputColumns).from(catalogOutputs).where(and(inArray(catalogOutputs.productId, members), eq(catalogOutputs.isLive, true))),
  ]);
  const rows = liveRows(pairs.map(p => p.product), outputs, channels).map((row, i) => {
    const member = pairs[i]!.member, status = batchSheetStatus(member);
    return { ...row, brand: batch.brandName, change: member.change, notes: member.notes, status, ...(status === "missing_images" ? { links: {} } : {}) };
  });
  rows.sort(byIdentifier);
  return { channels, rows };
}

export async function exportBrand(slug: string, productIds: string[], conn: Db = db(), storage = { uploadBuffer, signedUrl }, now = new Date()) {
  const brand = await getBrand(slug, conn);
  const ids = [...new Set(productIds)];
  if (!ids.length) throw new HttpError(400, "Select at least one product to download.");
  const products = (await Promise.all(slices(ids).map(slice => conn.select({ id: catalogProducts.id, isTest: catalogProducts.isTest }).from(catalogProducts).where(and(eq(catalogProducts.brandSlug, slug), inArray(catalogProducts.id, slice)))))).flat();
  if (products.length !== ids.length || products.some(p=>p.isTest !== products[0]!.isTest)) throw new HttpError(400, "Select products from one brand and the same test namespace.");
  const sheet = await liveSheet(ids, [...CHANNEL_IDS], conn);
  for (const row of sheet.rows) row.brand = brand.name;
  sheet.channels = CHANNEL_IDS.filter(c => sheet.rows.some(r => (r.links[c]?.length ?? 0) > 0));
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0,15);
  const base = `${randomUUID()}/links-${stamp}`;
  const [xlsx, csv] = await Promise.all([writeLinksXlsx(sheet), Promise.resolve(writeLinksCsv(sheet))]);
  const uri = await storage.uploadBuffer(brandExportPath(slug, `${base}.xlsx`, products[0]!.isTest), xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await storage.uploadBuffer(brandExportPath(slug, `${base}.csv`, products[0]!.isTest), Buffer.from(csv), "text/csv");
  return { url: await storage.signedUrl(uri) };
}

/** The batch page shows the digest in place of the overview: a finished batch with one, not an eval batch (M1-F4-R5). */
export function showsDigest(batch: Pick<typeof catalogBatches.$inferSelect, "status" | "digest" | "isTest" | "options">): boolean {
  return batch.status === "done" && !!batch.digest && !(batch.isTest && !!batch.options.evalSet);
}

/**
 * `sheet: "unless-digest"` skips reading the links sheet when the page shows a digest: the batch page then shows the
 * digest from one row and loads the sheet only on its own tab (M1-F4-R6). Unless `details` is asked for, it also skips
 * the report and every outputs query, taking the page's counts from the digest (M1-S5 review P2-3), so the page reads
 * the same few rows at any batch size.
 */
export async function batchDetails(id: string, conn: Db = db(), read = downloadBuffer, options: { sheet?: "always" | "unless-digest"; details?: boolean } = {}) {
  const [batch] = await conn.select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  const page = options.sheet === "unless-digest" && !options.details && showsDigest(batch) ? batch.digest!.page : undefined;
  if (page) {
    const uploads = await conn.select({ kind: catalogUploads.kind }).from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
    return { batch, sheet: { channels: [], rows: [] } as SheetSpec, failures: [], recheckFailures: [], notRefreshedChannels: page.notRefreshedChannels, filled: page.filled,
      uploads, keptPhotos: page.keptPhotos, styliSkipped: page.styliSkipped };
  }
  const [uploads, failures, sheet, kept, styliSkips] = await Promise.all([
    conn.select({ kind: catalogUploads.kind, detected: catalogUploads.detected }).from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed"))),
    conn.select({ n: catalogOutputs.n, originalName: catalogSourceImages.originalName, channel: catalogOutputs.channel, reason: catalogOutputs.reason, error: catalogOutputs.error }).from(catalogOutputs).innerJoin(catalogSourceImages, eq(catalogSourceImages.id,catalogOutputs.sourceImageId)).where(and(eq(catalogOutputs.batchId, id), eq(catalogOutputs.status, "failed"))),
    options.sheet === "unless-digest" && showsDigest(batch) ? Promise.resolve<SheetSpec>({ channels: [], rows: [] }) : batchSheet(id, conn, read),
    conn.select({ sourceImageId: catalogOutputs.sourceImageId }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, id), eq(catalogOutputs.decision, "use_as_is"))),
    // Styli outputs left out as too small, for the Ready line; counts.skipped also holds removed, replaced and chart skips.
    // The render can join other notes onto the skip note, so it is matched anywhere in the reason.
    conn.select({ id: catalogOutputs.id }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, id), eq(catalogOutputs.channel, "styli"), eq(catalogOutputs.status, "skipped"), like(catalogOutputs.reason, `%${STYLI_SKIP_NOTE}%`))),
  ]);
  // Photos an operator kept with "Use as is": the Ready line must not claim they passed every check.
  const keptPhotos = new Set(kept.map((k) => k.sourceImageId)).size;
  let recheckFailures: { url: string; reason: string }[] = [];
  const notRefreshedChannels = await readNotRefreshedChannels(conn, id);
  let filled = false;
  if (batch.reportUri) {
    const report = JSON.parse((await read(batch.reportUri)).buf.toString());
    recheckFailures = withoutModelNames(report.recheck?.failures ?? []);
    filled = !!report.exports?.filledProductList;
  }
  return { batch, sheet, failures, recheckFailures, notRefreshedChannels, filled, uploads, keptPhotos, styliSkipped: styliSkips.length };
}
