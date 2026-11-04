// M1-F2-R3 and R4 for the one-page New batch: the brand of the dropped names and where its batch goes.
import { and, eq, ne } from "drizzle-orm";
import { brandMaster, catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { mergeCounts } from "@catalog/core/catalog/counts";
import { assertDraft, isTestBatch } from "./batches";
import { regroupBatch } from "./uploads";
import { armAutoStart } from "@catalog/core/catalog/auto-start";
import { enqueueTask } from "@catalog/core/tasks";
import { BRAND_REGROUP_FAILED } from "./copy";

/** regroupBatch for a brand change: a failed hand-off (the batch is back to a draft) says how to retry. */
async function regroupAfterBrand(id: string) {
  try { await regroupBatch(id); }
  catch (err) {
    if (err instanceof HttpError && err.status < 500) throw err;
    throw new HttpError(503, BRAND_REGROUP_FAILED);
  }
}
import { channelDefaults, inferBrand } from "@catalog/core/catalog/intake-defaults";
import { db } from "../db";
import { badRequest, HttpError } from "../errors";

/** The most names one request may send; the page sends a sample of a bigger drop. */
export const INFER_MAX_PATHS = 5000;

/**
 * `{ paths, brandSlug? }`: the brand inferred from the relative paths (or null when it must be asked), and the default
 * channels of that brand, or of `brandSlug` when the operator chose one.
 */
export async function inferIntake(value: unknown) {
  const input = (value ?? {}) as { paths?: unknown; brandSlug?: unknown };
  if (!Array.isArray(input.paths) || input.paths.length > INFER_MAX_PATHS || !input.paths.every((p) => typeof p === "string")) throw badRequest("Drop the files again.");
  if (input.brandSlug !== undefined && typeof input.brandSlug !== "string") throw badRequest("Choose a brand from the list.");
  const inferred = input.brandSlug === undefined ? await inferBrand(db(), input.paths as string[]) : { brandSlug: input.brandSlug, resolved: 0, total: 0 };
  const [brand] = inferred.brandSlug ? await db().select({ slug: brandMaster.slug, name: brandMaster.name }).from(brandMaster).where(eq(brandMaster.slug, inferred.brandSlug)) : [];
  if (!brand) return { brandSlug: null, brandName: null, resolved: inferred.resolved, total: inferred.total, channels: [], channelSource: null };
  const defaults = await channelDefaults(db(), brand.slug);
  return { brandSlug: brand.slug, brandName: brand.name, resolved: inferred.resolved, total: inferred.total, channels: defaults.channels, channelSource: defaults.source };
}

/**
 * M1-F2 "Human in the loop" (M1 D15): change the brand of a draft before it starts. The channels become the new
 * brand's defaults and the countdown stops; the files are collected and grouped again under the new brand (products
 * this draft made under the old brand are removed by the regroup), and a new countdown runs when that ends. Refused
 * while the files are collected (assertDraft), and when it would make a test batch a real one or the other way round.
 * `autoStart`: turn auto-start back on (the page holds the countdown while the brand list is open). The same brand
 * again is never a no-op for a draft whose grouping is not ready: it hands the files to collecting again, so a
 * change whose hand-off failed (queue down) is retried by picking the brand again.
 */
export async function changeBrand(id: string, value: unknown) {
  const input = (value ?? {}) as { brandSlug?: unknown; autoStart?: unknown };
  if (typeof input.brandSlug !== "string" || !input.brandSlug) throw badRequest("Choose a brand from the list.");
  if (input.autoStart !== undefined && typeof input.autoStart !== "boolean") throw badRequest("Choose a brand from the list.");
  const batch = await assertDraft(id);
  const [brand] = await db().select({ slug: brandMaster.slug, name: brandMaster.name }).from(brandMaster).where(eq(brandMaster.slug, input.brandSlug));
  if (!brand) throw badRequest("Choose a brand from the list.");
  if (isTestBatch(brand.slug, batch.name) !== batch.isTest) throw badRequest("Make a new batch to change whether this is a test batch.");
  const options = input.autoStart === undefined ? batch.options : { ...batch.options, autoStart: input.autoStart };
  const inputs = await db().select({ id: catalogUploads.id }).from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
  if (brand.slug === batch.brandSlug) {
    if (input.autoStart !== undefined) await db().update(catalogBatches).set({ options, updatedAt: new Date() }).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "draft")));
    // Grouping not ready (a change whose hand-off failed): hand the files over again.
    if (!batch.counts.previewReady && inputs.length) {
      await regroupAfterBrand(id);
      return { brandSlug: brand.slug, brandName: brand.name, channels: batch.channels, channelSource: null, collecting: true };
    }
    // Ready and auto-start back on: a new countdown, as the end of collection would arm.
    if (batch.counts.previewReady && input.autoStart === true) await armAutoStart(db(), enqueueTask, id);
    return { brandSlug: brand.slug, brandName: brand.name, channels: batch.channels, channelSource: null, collecting: false };
  }
  const defaults = await channelDefaults(db(), brand.slug);
  const [updated] = await db().update(catalogBatches)
    .set({ brandSlug: brand.slug, brandName: brand.name, channels: defaults.channels, options, counts: mergeCounts({ autoStartAt: null, previewReady: false }), updatedAt: new Date() })
    .where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "draft"))).returning({ id: catalogBatches.id });
  if (!updated) throw new HttpError(409, "This batch has already started. Open its progress page.");
  if (inputs.length) await regroupAfterBrand(id);
  return { brandSlug: brand.slug, brandName: brand.name, channels: defaults.channels, channelSource: defaults.source, collecting: inputs.length > 0 };
}
