import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { brandMaster, catalogBatches, catalogUploads, type CatalogBatch } from "@catalog/core/db/schema";
import { CHANNEL_IDS, IDENTIFIER_MODES, PRECEDENCES, PRODUCT_TYPES, PASTE_INPUT_KINDS, type BatchOptions, type ChannelId, type ProductType } from "@catalog/core/catalog/types";
import { mergeCounts } from "@catalog/core/catalog/counts";
import { db, type Db } from "../db";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import { TEST_BRAND } from "@catalog/core/catalog/brands";
import { notRefreshedChannels } from "@catalog/core/catalog/pipeline/report";
import { badRequest, HttpError } from "../errors";
import { batchSource } from "./copy";

/** The 404 sentence for a batch id that does not exist (API routes and `/catalog/new?batch=`). */
export const BATCH_NOT_FOUND = "This batch does not exist. Open the batch list and choose another.";
export async function queryBatch(id: string): Promise<CatalogBatch> {
  const [batch] = await db().select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new HttpError(404, BATCH_NOT_FOUND);
  return batch;
}
/** The refusal for a batch that has started (release C words it by status, 14c F8). */
export const BATCH_STARTED = "This batch has already started. Make a new batch to add more photos.";
export async function assertDraft(id: string): Promise<CatalogBatch> {
  const batch = await queryBatch(id);
  if (batch.status !== "draft") throw new HttpError(409, BATCH_STARTED);
  return batch;
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export async function draftForUpdate(tx: Transaction, id: string): Promise<CatalogBatch> {
  const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, id)).for("update");
  if (!batch) throw new HttpError(404, BATCH_NOT_FOUND);
  if (batch.status !== "draft") throw new HttpError(409, BATCH_STARTED);
  return batch;
}
/** The answer for an upload id that is not an input of this batch, or not of the route's kind. */
export const INPUT_NOT_FOUND = "This input is not part of this batch. Reload this page.";
/** Inputs added through the paste box (`/links` routes); every other kind is a file (`/uploads` routes). */
export const LINK_KINDS = PASTE_INPUT_KINDS;
/**
 * A merge-only write to `counts`: only the named keys change, so a worker write to other keys made in
 * between (phase, placingClaim, rate) is never lost. Every web write to `counts` uses it (spec 14c F6).
 */
export { mergeCounts };
/**
 * The reopen of F8 (spec 14c section 3.4), written for POST /retry-links (spec 14b F5 part 1): a batch
 * that failed before Start (`failed`, `startedAt` null) returns to `draft` with `failReason` cleared
 * and `previewReady` false (a merge, so a worker counts key is kept). Uploads are untouched, so their
 * manifests and staged bytes are reused. A draft is returned as it is; any other batch is refused.
 */
export async function reopenBatch(id: string): Promise<CatalogBatch> {
  const [reopened] = await db().update(catalogBatches)
    .set({ status: "draft", counts: mergeCounts({ failReason: null, previewReady: false }), updatedAt: new Date() })
    .where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "failed"), isNull(catalogBatches.startedAt)))
    .returning();
  if (reopened) return reopened;
  const batch = await queryBatch(id);
  if (batch.status !== "draft") throw new HttpError(409, BATCH_STARTED);
  return batch;
}
export function publicBatch(batch: CatalogBatch) {
  const { policy: _policy, ...options } = batch.options;
  return { ...batch, options };
}
export function batchState(batch: CatalogBatch, source?: string, now?: Date) {
  return deriveBatchState({ status: batch.status, counts: batch.counts, source, updatedAt: batch.updatedAt, startedAt: batch.startedAt, now });
}
/**
 * Whether a batch other than this one is being processed now, so wizard step 4 can say this one may wait.
 * A processing row untouched for an hour is an old batch left behind, not one ahead in the queue.
 */
export async function anotherBatchProcessing(id: string, now = new Date()): Promise<boolean> {
  const [row] = await db().select({ id: catalogBatches.id }).from(catalogBatches).where(and(ne(catalogBatches.id, id), inArray(catalogBatches.status, ["matting", "rendering", "qa", "publishing"]), gt(catalogBatches.updatedAt, new Date(+now - 60 * 60_000)))).limit(1);
  return !!row;
}
export async function listBatches() {
  const rows = await db().select({ batch: catalogBatches, brandLine: brandMaster.line }).from(catalogBatches).leftJoin(brandMaster, eq(catalogBatches.brandSlug, brandMaster.slug))
    // A cleaned-up test batch keeps its row only so today's spend still counts; it is not a batch to open.
    .where(sql`not coalesce((${catalogBatches.options}->>'cleanedUp')::boolean, false)`).orderBy(desc(catalogBatches.createdAt));
  return rows.map(({ batch, brandLine }) => ({ ...publicBatch(batch), brandLine, state: batchState(batch) }));
}
export async function getBatch(id: string) {
  const batch = await queryBatch(id);
  const uploads = await db().select().from(catalogUploads).where(eq(catalogUploads.batchId, id));
  // Removed inputs stay in `uploads` (the step 1 input list shows them) but say nothing about the source.
  const source = batchSource(uploads.filter((u) => u.status !== "removed").map((u) => u.kind));
  return { batch: publicBatch(batch), counts: batch.counts, cost: batch.cost, state: batchState(batch, source), uploads, notRefreshedChannels: await notRefreshedChannels(db(), id) };
}
/** A batch is a test batch when its name starts with catalog-test or its brand is the test brand. */
export function isTestBatch(brandSlug: string, name: string): boolean {
  return name.startsWith("catalog-test") || brandSlug === TEST_BRAND.slug;
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
  const [batch] = await db().insert(catalogBatches).values({ brandSlug: brand.slug, brandName: brand.name, name, productType: input.productType as ProductType, createdBy: actor, isTest: isTestBatch(brand.slug, name), channels: [] }).returning({ id: catalogBatches.id });
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
    if (isTestBatch(batch.brandSlug, input.name.trim()) !== batch.isTest) throw badRequest("Make a new batch to change whether this is a test batch.");
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
