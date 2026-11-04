// M1-F2-R3 and R4 (M1-S2): what the one-page New batch decides for the operator before anything is uploaded.
// - The brand is inferred from the names of the dropped files and folders when at least 90% of the identifiers we can
//   resolve belong to one brand; otherwise the brand is the one question asked (UX 5.1 step 3).
// - The channels default to where the brand's options are listed (M0), else the five slice channels; never the last
//   batch someone else typed (UX 5.2, M1 D1). The brand's channel setting (M12-F3-R8) comes first once it exists.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { brandMaster, catalogChannelListings, catalogOptions, catalogProducts, skuMap } from "../db/schema";
import { normalizeKey, parseShotName } from "./naming";
import { CHANNEL_IDS, type ChannelId } from "./types";

/** M1-F2-R3: the share of resolved identifiers one brand must hold (admin setting in M12 once it exists). */
export const BRAND_INFERENCE_SHARE = 0.9;
/**
 * M1 D15: the share of all distinct identifiers that must resolve at all before a brand is inferred. Below it the
 * brand is asked (an explicit choice), so a drop of hundreds of unknown names with one known name never starts by
 * itself on a guessed brand.
 */
export const BRAND_MIN_COVERAGE = 0.5;
/** M1-F2-R4: the default when the brand has no listings: Namshi, Noon, Trendyol, Styli, Centrepoint. */
export const SLICE_CHANNELS: readonly ChannelId[] = ["namshi", "noon", "trendyol", "styli", "centrepoint"];
/** At most this many distinct names are looked up; a big drop is judged on a sample of its first names. */
const MAX_UNITS = 2000;
const LOOKUP_CHUNK = 500;

/**
 * The keys a dropped path could be known by, most specific first: the identifier read from the file name, then each
 * folder name from the nearest up. Keys are normalised as product keys are (upper case, no spaces, "_" or "-").
 */
export function candidateKeys(relativePath: string): string[] {
  const segs = relativePath.split(/[\\/]+/).filter(Boolean);
  const base = segs.pop() ?? "";
  const keys = [normalizeKey(parseShotName(base).identifier), ...segs.reverse().map(normalizeKey)].filter(Boolean);
  return [...new Set(keys)];
}

/** Which brands each key belongs to: the SKU master (option id, EAN, Opptra SKU), M0 options and products made before. */
async function brandsOfKeys(db: Db, keys: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, brand: string) => { const set = out.get(key) ?? new Set<string>(); set.add(brand); out.set(key, set); };
  for (let at = 0; at < keys.length; at += LOOKUP_CHUNK) {
    const part = keys.slice(at, at + LOOKUP_CHUNK);
    for (const r of await db.select({ key: skuMap.optionKey, brand: skuMap.brandSlug }).from(skuMap).where(inArray(skuMap.optionKey, part))) add(r.key, r.brand);
    for (const r of await db.select({ key: skuMap.ean, brand: skuMap.brandSlug }).from(skuMap).where(inArray(skuMap.ean, part))) if (r.key) add(r.key, r.brand);
    // Opptra SKUs are stored as written ("VM-1001_a"); the keys are normalised, so compare normalised forms.
    for (const r of await db.select({ key: skuMap.opptraSku, brand: skuMap.brandSlug }).from(skuMap).where(inArray(sql`upper(regexp_replace(${skuMap.opptraSku}, '[[:space:]_-]', '', 'g'))`, part))) add(normalizeKey(r.key), r.brand);
    for (const r of await db.select({ key: catalogOptions.optionKey, brand: catalogOptions.brandSlug }).from(catalogOptions).where(inArray(catalogOptions.optionKey, part))) add(r.key, r.brand);
    for (const r of await db.select({ key: catalogProducts.productKey, brand: catalogProducts.brandSlug }).from(catalogProducts).where(and(inArray(catalogProducts.productKey, part), eq(catalogProducts.isTest, false)))) add(r.key, r.brand);
  }
  return out;
}

export interface BrandInference {
  /** The inferred brand, or null when the brand must be asked. */
  brandSlug: string | null;
  /** Distinct identifiers that resolved to exactly one brand, and distinct identifiers in all. */
  resolved: number; total: number;
}

/**
 * M1-F2-R3: the brand of a drop, from its relative paths. Each path counts once per distinct identifier: the first of
 * its candidate keys that resolves to exactly one brand, else its file-name identifier (unresolved). The brand is
 * inferred when one brand holds at least BRAND_INFERENCE_SHARE of the resolved identifiers, at least BRAND_MIN_COVERAGE
 * of all identifiers resolved, and the brand is in the brand list.
 */
export async function inferBrand(db: Db, relativePaths: readonly string[]): Promise<BrandInference> {
  const candidates = [...new Set(relativePaths)].map(candidateKeys).filter((keys) => keys.length > 0);
  const sample = candidates.slice(0, MAX_UNITS);
  const brands = await brandsOfKeys(db, [...new Set(sample.flat())]);
  const units = new Map<string, string | null>();
  for (const keys of sample) {
    const hit = keys.find((k) => brands.get(k)?.size === 1);
    const unit = hit ?? keys[0]!;
    if (!units.has(unit)) units.set(unit, hit ? [...brands.get(hit)!][0]! : null);
  }
  const counts = new Map<string, number>();
  for (const brand of units.values()) if (brand) counts.set(brand, (counts.get(brand) ?? 0) + 1);
  const resolved = [...counts.values()].reduce((a, b) => a + b, 0);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let brandSlug: string | null = null;
  if (top && top[1] / resolved >= BRAND_INFERENCE_SHARE && resolved / units.size >= BRAND_MIN_COVERAGE) {
    const [known] = await db.select({ slug: brandMaster.slug }).from(brandMaster).where(eq(brandMaster.slug, top[0]));
    brandSlug = known ? known.slug : null;
  }
  return { brandSlug, resolved, total: units.size };
}

/**
 * M1-F2-R4: the channels a new batch of this brand starts with: the channels where the brand's options are listed in
 * M0 (any status except "not listed"), in the usual channel order, else SLICE_CHANNELS.
 */
export async function defaultChannels(db: Db, brandSlug: string): Promise<ChannelId[]> {
  return (await channelDefaults(db, brandSlug)).channels;
}

/** defaultChannels with where they came from: "listed" (M0 listings) or "slice" (the five slice channels). */
export async function channelDefaults(db: Db, brandSlug: string): Promise<{ channels: ChannelId[]; source: "listed" | "slice" }> {
  const rows = await db.selectDistinct({ channel: catalogChannelListings.channel }).from(catalogChannelListings)
    .innerJoin(catalogOptions, eq(catalogOptions.id, catalogChannelListings.optionId))
    .where(and(eq(catalogOptions.brandSlug, brandSlug), ne(catalogChannelListings.status, "not_listed")));
  const listed = new Set(rows.map((r) => r.channel));
  const channels = CHANNEL_IDS.filter((c) => listed.has(c));
  return channels.length ? { channels, source: "listed" } : { channels: [...SLICE_CHANNELS], source: "slice" };
}
