// M1-F2-R3 and R4 for the one-page New batch: the brand of the dropped names and where its batch goes.
import { eq } from "drizzle-orm";
import { brandMaster } from "@catalog/core/db/schema";
import { channelDefaults, inferBrand } from "@catalog/core/catalog/intake-defaults";
import { db } from "../db";
import { badRequest } from "../errors";

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
