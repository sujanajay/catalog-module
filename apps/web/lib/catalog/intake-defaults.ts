// M1-F2-R3 and R4 for the one-page New batch: the brand of the dropped names and where its batch goes.
import { and, eq, ne } from "drizzle-orm";
import { brandMaster, catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { mergeCounts } from "@catalog/core/catalog/counts";
import { assertDraft, isTestBatch } from "./batches";
import { regroupBatch } from "./uploads";
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
 * M1-F2 "Human in the loop" (M1 D14): change the brand of a draft before it starts. The channels become the new
 * brand's defaults and the countdown stops; the files are collected and grouped again under the new brand (products
 * this draft made under the old brand are removed by the regroup), and a new countdown runs when that ends. Refused
 * while the files are collected (assertDraft), and when it would make a test batch a real one or the other way round.
 */
export async function changeBrand(id: string, value: unknown) {
  const input = (value ?? {}) as { brandSlug?: unknown };
  if (typeof input.brandSlug !== "string" || !input.brandSlug) throw badRequest("Choose a brand from the list.");
  const batch = await assertDraft(id);
  const [brand] = await db().select({ slug: brandMaster.slug, name: brandMaster.name }).from(brandMaster).where(eq(brandMaster.slug, input.brandSlug));
  if (!brand) throw badRequest("Choose a brand from the list.");
  if (isTestBatch(brand.slug, batch.name) !== batch.isTest) throw badRequest("Make a new batch to change whether this is a test batch.");
  const defaults = await channelDefaults(db(), brand.slug);
  if (brand.slug === batch.brandSlug) return { brandSlug: brand.slug, brandName: brand.name, channels: batch.channels, channelSource: null, collecting: false };
  const [updated] = await db().update(catalogBatches)
    .set({ brandSlug: brand.slug, brandName: brand.name, channels: defaults.channels, counts: mergeCounts({ autoStartAt: null, previewReady: false }), updatedAt: new Date() })
    .where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "draft"))).returning({ id: catalogBatches.id });
  if (!updated) throw new HttpError(409, "This batch has already started. Open its progress page.");
  const inputs = await db().select({ id: catalogUploads.id }).from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
  if (inputs.length) await regroupBatch(id);
  return { brandSlug: brand.slug, brandName: brand.name, channels: defaults.channels, channelSource: defaults.source, collecting: inputs.length > 0 };
}
