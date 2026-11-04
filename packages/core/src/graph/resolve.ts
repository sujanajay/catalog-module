// Resolution reads of the graph (docs/program/requirements/M0-catalog-graph.md 3.4): option and listing from any key,
// and the outcome keys of a listing. Read only. A lookup that matches no option, or more than one, answers null: a
// caller never gets a guess.
import { and, eq, sql } from "drizzle-orm";
import type { ChannelId } from "../catalog/types";
import { catalogChannelListings, catalogListingKeys, catalogOptions, skuMap } from "../db/schema";
import type { GraphDb } from "./index";
import type { KeyKind, Market, StyleKeySource } from "./types";

export type OptionRef = { optionId: string; brandSlug: string; optionKey: string; styleKey: string | null; styleKeySource: StyleKeySource | null };
export type ListingRef = { listingId: string; optionId: string; channel: ChannelId; market: Market };
export type ResolveInput = { brandSlug: string; identifier?: string; opptraSku?: string; optionId?: string; ean?: string };

type Rows<T> = { rows: T[] };

/** Option ids of a brand matched by option key (case and spacing ignored). */
async function byOptionKey(db: GraphDb, brandSlug: string, key: string): Promise<string[]> {
  const k = key.trim().replace(/\s+/g, " ").toUpperCase();
  const rows = await db
    .select({ id: catalogOptions.id })
    .from(catalogOptions)
    .where(and(eq(catalogOptions.brandSlug, brandSlug), sql`upper(${catalogOptions.optionKey}) = ${k}`));
  return rows.map((r) => r.id);
}

/** Option ids of a brand's SKU: its master option id, its fallback key, or the listings its keys sit on. */
async function bySku(db: GraphDb, brandSlug: string, sku: string): Promise<string[]> {
  const res = (await db.execute(sql`
    select o.id from catalog_options o
    join sku_map s on upper(s.opptra_sku) = upper(${sku.trim()}) and s.brand_slug = o.brand_slug
    where o.brand_slug = ${brandSlug}
      and (upper(o.option_key) = upper(regexp_replace(btrim(coalesce(s.option_id_style_color, '')), '\\s+', ' ', 'g'))
           or o.option_key = 'sku:' || s.opptra_sku)
    union
    select l.option_id from catalog_listing_keys k
    join catalog_channel_listings l on l.id = k.listing_id
    join catalog_options o on o.id = l.option_id and o.brand_slug = ${brandSlug}
    where upper(k.opptra_sku) = upper(${sku.trim()})`)) as unknown as Rows<{ id: string }>;
  return res.rows.map((r) => r.id);
}

async function skusByEan(db: GraphDb, brandSlug: string, ean: string): Promise<string[]> {
  const rows = await db
    .select({ sku: skuMap.opptraSku })
    .from(skuMap)
    .where(and(eq(skuMap.brandSlug, brandSlug), eq(skuMap.ean, ean.trim())));
  return rows.map((r) => r.sku);
}

/** Option ids of a brand whose listings carry this key value on any channel. */
async function byKeyValue(db: GraphDb, brandSlug: string, value: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: catalogChannelListings.optionId })
    .from(catalogListingKeys)
    .innerJoin(catalogChannelListings, eq(catalogChannelListings.id, catalogListingKeys.listingId))
    .innerJoin(catalogOptions, eq(catalogOptions.id, catalogChannelListings.optionId))
    .where(and(eq(catalogListingKeys.keyValue, value.trim()), eq(catalogOptions.brandSlug, brandSlug)));
  return rows.map((r) => r.id);
}

/** The one option the input names, or null when it names none or several. The most specific field that matches wins. */
export async function resolveOption(db: GraphDb, input: ResolveInput): Promise<OptionRef | null> {
  const tries: (() => Promise<string[]>)[] = [];
  if (input.optionId) tries.push(() => byOptionKey(db, input.brandSlug, input.optionId!));
  if (input.opptraSku) tries.push(() => bySku(db, input.brandSlug, input.opptraSku!));
  if (input.ean) tries.push(async () => (await Promise.all((await skusByEan(db, input.brandSlug, input.ean!)).map((s) => bySku(db, input.brandSlug, s)))).flat());
  if (input.identifier) {
    const id = input.identifier;
    tries.push(() => byOptionKey(db, input.brandSlug, id));
    tries.push(() => bySku(db, input.brandSlug, id));
    tries.push(() => byKeyValue(db, input.brandSlug, id));
  }
  for (const t of tries) {
    const ids = [...new Set(await t())];
    if (ids.length > 1) return null;
    if (ids.length === 1) {
      const [o] = await db.select().from(catalogOptions).where(eq(catalogOptions.id, ids[0]!));
      return o ? { optionId: o.id, brandSlug: o.brandSlug, optionKey: o.optionKey, styleKey: o.styleKey, styleKeySource: o.styleKeySource } : null;
    }
  }
  return null;
}

export const RESOLVE_BULK_MAX = 2000;

/** resolveOption for up to 2,000 inputs, in input order. */
export async function resolveOptions(db: GraphDb, inputs: ResolveInput[]): Promise<(OptionRef | null)[]> {
  if (inputs.length > RESOLVE_BULK_MAX) throw new RangeError(`resolveOptions takes at most ${RESOLVE_BULK_MAX} inputs`);
  const out: (OptionRef | null)[] = [];
  for (const i of inputs) out.push(await resolveOption(db, i));
  return out;
}

/** The listing of a channel and market by one of its keys, or by its option; null when none or several match. */
export async function resolveListing(
  db: GraphDb,
  input: { channel: ChannelId; market: Market; keyKind?: KeyKind; keyValue?: string; optionId?: string },
): Promise<ListingRef | null> {
  if (input.keyValue) {
    const rows = await db
      .select({ listingId: catalogListingKeys.listingId })
      .from(catalogListingKeys)
      .where(and(
        eq(catalogListingKeys.channel, input.channel),
        eq(catalogListingKeys.market, input.market),
        eq(catalogListingKeys.keyValue, input.keyValue.trim()),
        ...(input.keyKind ? [eq(catalogListingKeys.keyKind, input.keyKind)] : []),
      ));
    const ids = [...new Set(rows.map((r) => r.listingId))];
    if (ids.length !== 1) return null;
    const [l] = await db.select().from(catalogChannelListings).where(eq(catalogChannelListings.id, ids[0]!));
    return l ? { listingId: l.id, optionId: l.optionId, channel: l.channel, market: l.market } : null;
  }
  if (input.optionId) {
    const [l] = await db
      .select()
      .from(catalogChannelListings)
      .where(and(eq(catalogChannelListings.optionId, input.optionId), eq(catalogChannelListings.channel, input.channel), eq(catalogChannelListings.market, input.market)));
    return l ? { listingId: l.id, optionId: l.optionId, channel: l.channel, market: l.market } : null;
  }
  return null;
}

/** Every key a listing is known by: the join to sales, ads, stock and price rows (3.1 outcome link). */
export async function outcomeKeys(db: GraphDb, listingId: string): Promise<{ keyKind: KeyKind; keyValue: string }[]> {
  return db
    .select({ keyKind: catalogListingKeys.keyKind, keyValue: catalogListingKeys.keyValue })
    .from(catalogListingKeys)
    .where(eq(catalogListingKeys.listingId, listingId))
    .orderBy(catalogListingKeys.keyKind, catalogListingKeys.keyValue);
}
