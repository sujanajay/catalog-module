import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { brandMaster, catalogBatches, catalogUploads, type CatalogBatch } from "@catalog/core/db/schema";
import { CHANNEL_IDS, IDENTIFIER_MODES, PRECEDENCES, PRODUCT_TYPES, PASTE_INPUT_KINDS, type BatchOptions, type BatchStatus, type ChannelId, type ProductType } from "@catalog/core/catalog/types";
import { mergeCounts } from "@catalog/core/catalog/counts";
import { db, type Db } from "../db";
import type { CurrentUser } from "../user";
import { ageText, deriveBatchState, failedBeforeStart } from "@catalog/core/catalog/pipeline/status";
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
// The refusals of a change that needs a draft, by status (spec 14c F8; parent copy register "assertDraft").
export const BATCH_STARTED = "This batch has already started. Make a new batch to add more photos.";
export const BATCH_COULD_NOT_START = "This batch could not start. Press Fix and continue to change its photos or links.";
export const BATCH_STILL_COLLECTING = "This batch is still collecting. Wait for it to finish, or press Try again if nothing has moved for 10 minutes.";
export const BATCH_CANCELLED = "This batch was cancelled. Make a new batch.";
/** The sentence for a batch that is not a draft: what happened to it and what to do now. */
export function notDraftText(batch: { status: BatchStatus; startedAt: Date | string | null }): string {
  if (failedBeforeStart(batch)) return BATCH_COULD_NOT_START;
  if (batch.status === "ingesting") return BATCH_STILL_COLLECTING;
  if (batch.status === "cancelled") return BATCH_CANCELLED;
  return BATCH_STARTED;
}
export async function assertDraft(id: string): Promise<CatalogBatch> {
  const batch = await queryBatch(id);
  if (batch.status !== "draft") throw new HttpError(409, notDraftText(batch));
  return batch;
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export async function draftForUpdate(tx: Transaction, id: string): Promise<CatalogBatch> {
  const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, id)).for("update");
  if (!batch) throw new HttpError(404, BATCH_NOT_FOUND);
  if (batch.status !== "draft") throw new HttpError(409, notDraftText(batch));
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
 * The reopen of F8 (spec 14c section 3.4; POST /reopen, "Fix and continue", and POST /retry-links of
 * spec 14b F5 part 1): a batch that failed before Start (`failed`, `startedAt` null) returns to `draft`
 * with `failReason` cleared and `previewReady` false (a merge, so a worker counts key is kept). Uploads
 * are untouched, so their manifests and staged bytes are reused. A draft is returned as it is; any other
 * batch is refused with its status sentence.
 */
export async function reopenBatch(id: string): Promise<CatalogBatch> {
  const [reopened] = await db().update(catalogBatches)
    .set({ status: "draft", counts: mergeCounts({ failReason: null, previewReady: false }), updatedAt: new Date() })
    .where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "failed"), isNull(catalogBatches.startedAt)))
    .returning();
  if (reopened) return reopened;
  const batch = await queryBatch(id);
  if (batch.status !== "draft") throw new HttpError(409, notDraftText(batch));
  return batch;
}
/**
 * POST /cancel (spec 14c F4 part 2): a draft, a collecting batch or one that failed before Start becomes
 * `cancelled` in one conditional update, so a Start that lands first wins. Drafts hold no product locks,
 * so nothing is released; the worker's own guards stop a collection in flight. Cancelling twice answers
 * the same; a started batch is refused.
 */
export async function cancelBatch(id: string): Promise<{ id: string; status: "cancelled" }> {
  const [cancelled] = await db().update(catalogBatches).set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(catalogBatches.id, id), isNull(catalogBatches.startedAt), inArray(catalogBatches.status, ["draft", "ingesting", "failed"])))
    .returning({ id: catalogBatches.id });
  if (cancelled) return { id, status: "cancelled" };
  const batch = await queryBatch(id);
  if (batch.status === "cancelled") return { id, status: "cancelled" };
  throw new HttpError(409, BATCH_STARTED);
}
export function publicBatch(batch: CatalogBatch) {
  const { policy: _policy, ...options } = batch.options;
  return { ...batch, options };
}
/** The batch's state; with `uploads` (any status) the unfinished words also name pending and missing inputs. */
export function batchState(batch: CatalogBatch, source?: string, now?: Date, uploads?: readonly { status: string }[]) {
  return deriveBatchState({ status: batch.status, counts: batch.counts, source, updatedAt: batch.updatedAt, startedAt: batch.startedAt, now, channels: batch.channels, uploads, expired: batch.options.expired ?? null });
}
/**
 * Whether a batch other than this one is being processed now, so wizard step 4 can say this one may wait.
 * A processing row untouched for an hour is an old batch left behind, not one ahead in the queue.
 */
export async function anotherBatchProcessing(id: string, now = new Date()): Promise<boolean> {
  const [row] = await db().select({ id: catalogBatches.id }).from(catalogBatches).where(and(ne(catalogBatches.id, id), inArray(catalogBatches.status, ["matting", "rendering", "qa", "publishing"]), gt(catalogBatches.updatedAt, new Date(+now - 60 * 60_000)))).limit(1);
  return !!row;
}
// A cleaned-up test batch keeps its row only so today's spend still counts; it is not a batch to open.
const notCleanedUp = sql`not coalesce((${catalogBatches.options}->>'cleanedUp')::boolean, false)`;
/** The uploads (status and kind) of some batches, by batch id. */
async function uploadsOf(ids: string[]): Promise<Map<string, { status: string; kind: string }[]>> {
  const rows = ids.length ? await db().select({ batchId: catalogUploads.batchId, status: catalogUploads.status, kind: catalogUploads.kind }).from(catalogUploads).where(inArray(catalogUploads.batchId, ids)) : [];
  const byBatch = new Map<string, { status: string; kind: string }[]>();
  for (const row of rows) byBatch.set(row.batchId, [...(byBatch.get(row.batchId) ?? []), row]);
  return byBatch;
}
/** A batch's source for the phase words, from its inputs that were not removed. */
const sourceOf = (uploads: readonly { status: string; kind: string }[] | undefined) => batchSource((uploads ?? []).filter((u) => u.status !== "removed").map((u) => u.kind));
/**
 * The batch list. Cancelled batches are left out unless `cancelled` is asked for (spec 14c F4 part 2).
 * A collecting row reads its uploads, so its phase words follow its source.
 */
export async function listBatches(options: { cancelled?: boolean } = {}) {
  const rows = await db().select({ batch: catalogBatches, brandLine: brandMaster.line }).from(catalogBatches).leftJoin(brandMaster, eq(catalogBatches.brandSlug, brandMaster.slug))
    .where(options.cancelled ? notCleanedUp : and(notCleanedUp, ne(catalogBatches.status, "cancelled"))).orderBy(desc(catalogBatches.createdAt));
  const uploads = await uploadsOf(rows.filter(({ batch }) => batch.status === "ingesting").map(({ batch }) => batch.id));
  return rows.map(({ batch, brandLine }) => ({ ...publicBatch(batch), brandLine, state: batchState(batch, uploads.has(batch.id) ? sourceOf(uploads.get(batch.id)) : undefined) }));
}
export type UnfinishedBatch = { id: string; name: string; brandName: string; createdBy: string; age: string; words: string; fixable: boolean; collecting: boolean };
/**
 * "Your unfinished batches" (spec 14c F4 part 2): drafts, collecting batches and batches that failed
 * before Start, newest first, with their state words and age. An operator sees their own; an admin and a
 * viewer (read only) see everyone's, with the creator.
 */
export async function unfinishedBatches(user: CurrentUser, now = new Date()): Promise<UnfinishedBatch[]> {
  const unfinished = and(isNull(catalogBatches.startedAt), inArray(catalogBatches.status, ["draft", "ingesting", "failed"]));
  const mine = user.role === "operator" ? sql`lower(${catalogBatches.createdBy}) = ${user.email.toLowerCase()}` : undefined;
  const rows = await db().select().from(catalogBatches).where(and(notCleanedUp, unfinished, mine)).orderBy(desc(catalogBatches.createdAt));
  const uploads = await uploadsOf(rows.map((b) => b.id));
  return rows.map((batch) => {
    const state = batchState(batch, sourceOf(uploads.get(batch.id)), now, uploads.get(batch.id) ?? []);
    return { id: batch.id, name: batch.name, brandName: batch.brandName, createdBy: batch.createdBy, age: ageText(batch.createdAt, now), words: state.intake, fixable: !!state.fixable, collecting: state.state === "collecting" };
  });
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
  const patch: Omit<Partial<typeof catalogBatches.$inferInsert>, "counts"> & { counts?: ReturnType<typeof mergeCounts> } = { updatedAt: new Date() };
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
    patch.counts = mergeCounts({ previewReady: false });
  }
  const [updated] = await db().update(catalogBatches).set(patch).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "draft"))).returning();
  if (!updated) throw new HttpError(409, "This batch has already started. Open its progress page.");
  return publicBatch(updated);
}
