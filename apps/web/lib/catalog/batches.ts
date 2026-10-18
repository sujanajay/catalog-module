import { and, desc, eq } from "drizzle-orm";
import { brandMaster, catalogBatches, catalogUploads, type CatalogBatch } from "@catalog/core/db/schema";
import { CHANNEL_IDS, IDENTIFIER_MODES, PRECEDENCES, PRODUCT_TYPES, type BatchOptions, type ChannelId, type ProductType } from "@catalog/core/catalog/types";
import { db, type Db } from "../db";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import { notRefreshedChannels } from "@catalog/core/catalog/pipeline/report";
import { badRequest, HttpError } from "../errors";

export async function queryBatch(id: string): Promise<CatalogBatch> {
  const [batch] = await db().select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, "This batch does not exist. Open the batch list and choose another.");
  return batch;
}
export async function assertDraft(id: string): Promise<CatalogBatch> {
  const batch = await queryBatch(id);
  if (batch.status !== "draft") throw new HttpError(409, "This batch has already started. Make a new batch to add more photos.");
  return batch;
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export async function draftForUpdate(tx: Transaction, id: string): Promise<CatalogBatch> {
  const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, id)).for("update");
  if (!batch) throw new HttpError(404, "This batch does not exist. Open the batch list and choose another.");
  if (batch.status !== "draft") throw new HttpError(409, "This batch has already started. Make a new batch to add more photos.");
  return batch;
}
export function publicBatch(batch: CatalogBatch) {
  const { policy: _policy, ...options } = batch.options;
  return { ...batch, options };
}
export function batchState(batch: CatalogBatch, source?: string) {
  return deriveBatchState({ status: batch.status, counts: batch.counts, source });
}
export async function listBatches() {
  const rows = await db().select({ batch: catalogBatches, brandLine: brandMaster.line }).from(catalogBatches).leftJoin(brandMaster, eq(catalogBatches.brandSlug, brandMaster.slug)).orderBy(desc(catalogBatches.createdAt));
  return rows.map(({ batch, brandLine }) => ({ ...publicBatch(batch), brandLine, state: batchState(batch) }));
}
export async function getBatch(id: string) {
  const batch = await queryBatch(id);
  const uploads = await db().select().from(catalogUploads).where(eq(catalogUploads.batchId, id));
  const source = uploads.some((u) => u.kind === "drive_folder") ? "Drive folder" : uploads.some((u) => u.kind === "google_sheet") ? "Google Sheet" : uploads.some((u) => u.kind === "zip") ? "zip" : uploads.some((u) => u.kind === "url_list") ? "links" : "upload";
  return { batch: publicBatch(batch), counts: batch.counts, cost: batch.cost, state: batchState(batch, source), uploads, notRefreshedChannels: await notRefreshedChannels(db(), id) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Check the form and try again.");
  return value as Record<string, unknown>;
}
export async function createBatch(value: unknown, actor: string) {
  const input = record(value);
  if (typeof input.brandSlug !== "string") throw badRequest("Choose a brand before continuing.");
  if (!PRODUCT_TYPES.includes(input.productType as ProductType)) throw badRequest("Choose a product type and try again.");
  if (input.name !== undefined && typeof input.name !== "string") throw badRequest("Enter a batch name and try again.");
  const [brand] = await db().select().from(brandMaster).where(eq(brandMaster.slug, input.brandSlug));
  if (!brand) throw badRequest("Choose a brand from the list. Email sujan@opptra.com if it is missing.");
  const name = (input.name as string | undefined)?.trim() || `${brand.name} photos`;
  const [batch] = await db().insert(catalogBatches).values({ brandSlug: brand.slug, brandName: brand.name, name, productType: input.productType as ProductType, createdBy: actor, isTest: name.startsWith("catalog-test"), channels: [] }).returning({ id: catalogBatches.id });
  return batch!;
}
export function parseOptions(value: unknown, existing: BatchOptions): BatchOptions {
  const input = record(value);
  if (Object.keys(input).some((k) => !["identifierMode", "precedence", "sheetColumns"].includes(k))) throw badRequest("Choose the grouping controls shown on this page and try again.");
  const options = { ...existing };
  if (input.identifierMode !== undefined) {
    if (!IDENTIFIER_MODES.includes(input.identifierMode as BatchOptions["identifierMode"])) throw badRequest("Choose how to tell products apart.");
    options.identifierMode = input.identifierMode as BatchOptions["identifierMode"];
  }
  if (input.precedence !== undefined) {
    if (!PRECEDENCES.includes(input.precedence as BatchOptions["precedence"])) throw badRequest("Choose which photos should win.");
    options.precedence = input.precedence as BatchOptions["precedence"];
  }
  if (input.sheetColumns !== undefined) {
    if (input.sheetColumns === null) options.sheetColumns = null;
    else {
      const cols = record(input.sheetColumns);
      if (!Number.isInteger(cols.identifier) || Number(cols.identifier) < 0 || !Array.isArray(cols.images) || !cols.images.every((n) => Number.isInteger(n) && n >= 0)) throw badRequest("Choose the identifier and photo columns in your sheet.");
      options.sheetColumns = { identifier: Number(cols.identifier), images: cols.images as number[] };
    }
  }
  return options;
}
export async function patchBatch(id: string, value: unknown) {
  const input = record(value);
  const batch = await assertDraft(id);
  const patch: Partial<typeof catalogBatches.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) throw badRequest("Enter a batch name and try again.");
    if (input.name.startsWith("catalog-test") !== batch.isTest) throw badRequest("Make a new batch to change whether this is a test batch.");
    patch.name = input.name.trim();
  }
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels) || !input.channels.every((c) => CHANNEL_IDS.includes(c as ChannelId))) throw badRequest("Choose marketplaces from the list and try again.");
    patch.channels = [...new Set(input.channels as ChannelId[])];
  }
  if (input.options !== undefined) {
    patch.options = parseOptions(input.options, batch.options);
    patch.counts = { ...batch.counts, previewReady: false };
  }
  const [updated] = await db().update(catalogBatches).set(patch).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "draft"))).returning();
  if (!updated) throw new HttpError(409, "This batch has already started. Open its progress page.");
  return publicBatch(updated);
}
