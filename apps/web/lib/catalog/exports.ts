import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
import { batchSheetStatus, notRefreshedChannels as readNotRefreshedChannels } from "@catalog/core/catalog/pipeline/report";

export async function batchExportUrl(id: string, format: string, conn: Db = db(), storage = { signedUrl, downloadBuffer }) {
  const [batch] = await conn.select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  let uri: string | null;
  if (format === "xlsx") uri = batch.sheetXlsxUri;
  else if (format === "csv") uri = batch.sheetCsvUri;
  else if (format === "report") uri = batch.reportUri;
  else if (format === "filled") {
    if (!batch.reportUri) throw new HttpError(404, "No product list was uploaded in this batch.");
    const { buf } = await storage.downloadBuffer(batch.reportUri);
    const report = JSON.parse(buf.toString()) as { exports?: { filledProductList?: { xlsx?: string } | null } };
    uri = report.exports?.filledProductList?.xlsx ?? null;
    if (!uri) throw new HttpError(404, "No product list was uploaded in this batch.");
  } else throw new HttpError(400, "Choose xlsx, csv, report or filled to download.");
  if (!uri) throw new HttpError(404, "The sheet is not ready yet. Wait for processing to finish.");
  return storage.signedUrl(uri, 7 * 86400);
}

export async function liveSheet(productIds: string[], channels: ChannelId[], conn: Db = db()): Promise<SheetSpec> {
  if (!productIds.length) return { channels, rows: [] };
  const [products, outputs] = await Promise.all([
    conn.select().from(catalogProducts).where(inArray(catalogProducts.id, productIds)),
    conn.select({ productId: catalogOutputs.productId, channel: catalogOutputs.channel, n: catalogOutputs.n, publicUrl: catalogOutputs.publicUrl, publishedAt: catalogOutputs.publishedAt }).from(catalogOutputs).where(and(inArray(catalogOutputs.productId, productIds), eq(catalogOutputs.isLive, true))),
  ]);
  const rows: SheetRow[] = products.map(p => {
    const links: SheetRow["links"] = {};
    let changedAt: Date | null = null;
    for (const o of outputs.filter(o => o.productId === p.id && channels.includes(o.channel))) {
      const list = links[o.channel] ?? [];
      while (list.length < o.n) list.push(null);
      list[o.n - 1] = o.publicUrl;
      links[o.channel] = list;
      if (o.publishedAt && (!changedAt || o.publishedAt > changedAt)) changedAt = o.publishedAt;
    }
    return { brand: p.brandSlug, identifier: p.identifier, optionIdStyleColor: p.optionIdStyleColor ?? "", opptraSkuIds: p.opptraSkuIds, links, status: "ok", notes: "", change: "unchanged", changedAt };
  });
  rows.sort((a,b) => a.identifier.localeCompare(b.identifier, "en", { numeric: true }));
  return { channels, rows };
}

async function savedSheet(uri: string, read: typeof downloadBuffer): Promise<SheetSpec> {
  const table = await readSheetTable((await read(uri)).buf, "links.xlsx");
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
  const members = await conn.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, id));
  const sheet = await liveSheet(members.map(m => m.productId), CHANNEL_IDS.filter(c => batch.channels.includes(c)), conn);
  const products = members.length ? await conn.select({ id: catalogProducts.id, identifier: catalogProducts.identifier }).from(catalogProducts).where(inArray(catalogProducts.id, members.map(m=>m.productId))) : [];
  for (const row of sheet.rows) {
    row.brand = batch.brandName;
    const p = products.find(p => p.identifier === row.identifier)!;
    const member = members.find(m => m.productId === p.id)!;
    row.change = member.change;
    row.notes = member.notes;
    row.status = batchSheetStatus(member);
    if (row.status === "missing_images") row.links = {};
  }
  return sheet;
}

export async function exportBrand(slug: string, productIds: string[], conn: Db = db(), storage = { uploadBuffer, signedUrl }, now = new Date()) {
  const brand = await getBrand(slug, conn);
  const ids = [...new Set(productIds)];
  if (!ids.length) throw new HttpError(400, "Select at least one product to download.");
  const products = await conn.select({ id: catalogProducts.id, isTest: catalogProducts.isTest }).from(catalogProducts).where(and(eq(catalogProducts.brandSlug, slug), inArray(catalogProducts.id, ids)));
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

export async function batchDetails(id: string, conn: Db = db(), read = downloadBuffer) {
  const [batch] = await conn.select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  const [uploads, failures, sheet] = await Promise.all([
    conn.select({ kind: catalogUploads.kind, detected: catalogUploads.detected }).from(catalogUploads).where(eq(catalogUploads.batchId, id)),
    conn.select({ n: catalogOutputs.n, originalName: catalogSourceImages.originalName, channel: catalogOutputs.channel, reason: catalogOutputs.reason, error: catalogOutputs.error }).from(catalogOutputs).innerJoin(catalogSourceImages, eq(catalogSourceImages.id,catalogOutputs.sourceImageId)).where(and(eq(catalogOutputs.batchId, id), eq(catalogOutputs.status, "failed"))),
    batchSheet(id, conn, read),
  ]);
  let recheckFailures: { url: string; reason: string }[] = [];
  const notRefreshedChannels = await readNotRefreshedChannels(conn, id);
  let filled = false;
  if (batch.reportUri) {
    const report = JSON.parse((await read(batch.reportUri)).buf.toString());
    recheckFailures = report.recheck?.failures ?? [];
    filled = !!report.exports?.filledProductList;
  }
  return { batch, sheet, failures, recheckFailures, notRefreshedChannels, filled, uploads };
}
