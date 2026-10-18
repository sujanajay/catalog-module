// Product matching and the overwrite preview (spec 04, "Product matching and the overwrite preview").
//
// matchProducts is a dry run of findOrCreateProduct (02): it reads aliases and the SKU master and
// never writes. buildOverwritePreview tells the operator, before Start, which products are new,
// which existing products will be overwritten and which of their live shots will be removed, which
// new identifiers look like a rename, which two spellings are one product, and which products are
// still held by another batch.
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  catalogBatches,
  catalogOutputs,
  catalogProductAliases,
  catalogProducts,
  catalogSourceImages,
  type CatalogBatch,
} from "../../db/schema";
import { normalizeKey, sanitizeSegment } from "../naming";
import { resolveSkus } from "../sku-mapping";
import type { BatchStatus } from "../types";
import type { GroupingResult, OverwritePreview, SourceItem } from "./types";

export interface ProductMatch { identifier: string; productId: string | null; pathKey: string; isNew: boolean; matchedBy: "alias" | "option_key" | null }

/** A batch in one of these states no longer holds its product locks. */
const FINISHED_STATUSES: BatchStatus[] = ["done", "failed"];

/** Values per IN (...) list, well below the Postgres limit of 65,535 bind parameters per query. */
const IN_LIST_MAX = 1000;

function chunks<T>(values: T[], size = IN_LIST_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedNumbers = (values: Iterable<number>): number[] => [...new Set(values)].sort((a, b) => a - b);

/**
 * Read-only alias lookup for many keys at once: alias_key -> product id and path_key, for the
 * brand and is_test. The same query findOrCreateProduct runs per key inside its transaction.
 */
async function productsByAliasKeys(
  db: Db,
  brandSlug: string,
  isTest: boolean,
  keys: string[],
): Promise<Map<string, { productId: string; pathKey: string }>> {
  const found = new Map<string, { productId: string; pathKey: string }>();
  for (const part of chunks([...new Set(keys.filter(Boolean))])) {
    const rows = await db
      .select({ aliasKey: catalogProductAliases.aliasKey, productId: catalogProducts.id, pathKey: catalogProducts.pathKey })
      .from(catalogProductAliases)
      .innerJoin(catalogProducts, eq(catalogProducts.id, catalogProductAliases.productId))
      .where(
        and(
          eq(catalogProductAliases.brandSlug, brandSlug),
          eq(catalogProductAliases.isTest, isTest),
          inArray(catalogProductAliases.aliasKey, part),
        ),
      );
    for (const r of rows) found.set(r.aliasKey, { productId: r.productId, pathKey: r.pathKey });
  }
  return found;
}

/**
 * Dry run of findOrCreateProduct (02): alias hit -> existing; resolveSkus option_key alias hit ->
 * existing; else new (productId null). Never writes. One match per identifier, in input order.
 * A new product's pathKey is the one findOrCreateProduct would give it (sanitizeSegment).
 * `eans` (optional, after the contract's parameters): identifier -> the product list's EAN, passed
 * to resolveSkus exactly as the ingest's real findOrCreateProduct call gets it.
 */
export async function matchProducts(db: Db, batch: CatalogBatch, identifiers: string[], eans?: Map<string, string>): Promise<ProductMatch[]> {
  const { brandSlug, isTest } = batch;
  const trimmed = identifiers.map((id) => id.trim());
  const byKey = await productsByAliasKeys(db, brandSlug, isTest, trimmed.map((id) => normalizeKey(id)));

  // (2) Identifiers without an alias hit: the option id resolveSkus finds, normalised, may be one.
  const optionKeyOf = new Map<string, string>();
  for (const id of new Set(trimmed)) {
    const key = normalizeKey(id);
    if (!key || byKey.has(key)) continue;
    const skus = await resolveSkus(db, { brandSlug, identifier: id, ean: eans?.get(id) ?? null });
    if (skus.optionIdStyleColor) optionKeyOf.set(id, normalizeKey(skus.optionIdStyleColor));
  }
  const byOption = await productsByAliasKeys(db, brandSlug, isTest, [...optionKeyOf.values()]);

  return identifiers.map((identifier, i): ProductMatch => {
    const id = trimmed[i]!;
    const aliasHit = byKey.get(normalizeKey(id));
    if (aliasHit) return { identifier, productId: aliasHit.productId, pathKey: aliasHit.pathKey, isNew: false, matchedBy: "alias" };
    const optionKey = optionKeyOf.get(id);
    const optionHit = optionKey ? byOption.get(optionKey) : undefined;
    if (optionHit) return { identifier, productId: optionHit.productId, pathKey: optionHit.pathKey, isNew: false, matchedBy: "option_key" };
    return { identifier, productId: null, pathKey: sanitizeSegment(id), isNew: true, matchedBy: null };
  });
}

/**
 * The step 4 overwrite preview for the products grouped in this batch. Matches for identifiers
 * that have no photos in this upload (product-list rows) are not part of it.
 *
 * Two grouped identifiers that map to the same product (an existing product, or the same
 * product_key for new ones) are reported in `duplicates` and both are moved from
 * `grouped.products` to `grouped.rejected` with the sentence "<a> and <b> are the same product.
 * Keep one."; the rest of the preview leaves them out. This is the only change made to `grouped`.
 */
export async function buildOverwritePreview(
  db: Db,
  batch: CatalogBatch,
  grouped: GroupingResult,
  matches: ProductMatch[],
  sha256ByItem: Map<SourceItem, string>,
): Promise<OverwritePreview> {
  const matchOf = new Map(matches.map((m) => [m.identifier, m]));
  const groupedIds = [...grouped.products.keys()];
  for (const id of groupedIds) {
    if (!matchOf.has(id)) throw new Error(`No product match was computed for ${id}. Run matchProducts over every grouped identifier first.`);
  }

  // Duplicates: grouped identifiers that land on one product.
  const bySameProduct = new Map<string, string[]>();
  for (const id of groupedIds) {
    const m = matchOf.get(id)!;
    const key = m.productId ? `product:${m.productId}` : `new:${normalizeKey(id)}`;
    bySameProduct.set(key, [...(bySameProduct.get(key) ?? []), id]);
  }
  const duplicates: OverwritePreview["duplicates"] = [];
  for (const ids of bySameProduct.values()) {
    if (ids.length < 2) continue;
    const [first, ...others] = [...ids].sort(byText);
    for (const other of others) duplicates.push({ a: first!, b: other });
    const sentence = `${ids.slice().sort(byText).join(" and ")} are the same product. Keep one.`;
    for (const id of ids) {
      for (const item of grouped.products.get(id) ?? []) grouped.rejected.push({ item, reason: sentence });
      grouped.products.delete(id);
    }
  }
  duplicates.sort((x, y) => byText(x.a, y.a) || byText(x.b, y.b));

  const kept = [...grouped.products.keys()].map((id) => matchOf.get(id)!);
  const existing = kept.filter((m): m is ProductMatch & { productId: string } => !m.isNew && m.productId !== null);
  const fresh = kept.filter((m) => m.isNew);
  const channels = [...batch.channels];

  // liveShots: distinct n of live outputs on the batch's channels.
  const liveByProduct = new Map<string, Set<number>>();
  if (channels.length) {
    for (const part of chunks(existing.map((m) => m.productId))) {
      const rows = await db
        .selectDistinct({ productId: catalogOutputs.productId, n: catalogOutputs.n })
        .from(catalogOutputs)
        .where(and(inArray(catalogOutputs.productId, part), eq(catalogOutputs.isLive, true), inArray(catalogOutputs.channel, channels)));
      for (const r of rows) {
        const set = liveByProduct.get(r.productId) ?? new Set<number>();
        set.add(r.n);
        liveByProduct.set(r.productId, set);
      }
    }
  }
  const existingProducts: OverwritePreview["existingProducts"] = existing
    .map((m) => {
      const items = grouped.products.get(m.identifier) ?? [];
      const uploadShots = sortedNumbers(items.map((item, i) => item.n ?? i + 1));
      const liveShots = sortedNumbers(liveByProduct.get(m.productId) ?? []);
      const shotsToRemove = liveShots.filter((n) => !uploadShots.includes(n));
      return { identifier: m.identifier, liveShots, uploadShots, shotsToRemove, channels };
    })
    .sort((x, y) => byText(x.identifier, y.identifier));

  // busy: existing products locked by another batch that has not finished.
  const busy: OverwritePreview["busy"] = [];
  const identifierOfProduct = new Map(existing.map((m) => [m.productId, m.identifier]));
  for (const part of chunks([...identifierOfProduct.keys()])) {
    const rows = await db
      .select({ productId: catalogProducts.id, batchId: catalogBatches.id, batchName: catalogBatches.name })
      .from(catalogProducts)
      .innerJoin(catalogBatches, eq(catalogBatches.id, catalogProducts.lockBatchId))
      .where(and(inArray(catalogProducts.id, part), notInArray(catalogBatches.status, FINISHED_STATUSES)));
    for (const r of rows) {
      if (r.batchId === batch.id) continue;
      busy.push({ identifier: identifierOfProduct.get(r.productId)!, batchName: r.batchName });
    }
  }
  busy.sort((x, y) => byText(x.identifier, y.identifier));

  const renameHints = await findRenameHints(db, batch, grouped, fresh, sha256ByItem);
  return { newProducts: fresh.length, existingProducts, renameHints, duplicates, busy };
}

/**
 * A new identifier whose sha256 set equals the sha256 set of an existing product's current
 * versions in the same brand (and is_test). A new identifier with an item of unknown sha256 is
 * not compared.
 */
async function findRenameHints(
  db: Db,
  batch: CatalogBatch,
  grouped: GroupingResult,
  fresh: ProductMatch[],
  sha256ByItem: Map<SourceItem, string>,
): Promise<OverwritePreview["renameHints"]> {
  const setOfNew = new Map<string, Set<string>>();
  for (const m of fresh) {
    const items = grouped.products.get(m.identifier) ?? [];
    const shas = items.map((item) => sha256ByItem.get(item));
    if (!items.length || shas.some((s) => !s)) continue;
    setOfNew.set(m.identifier, new Set(shas as string[]));
  }
  if (!setOfNew.size) return [];

  // Candidates: products of the brand with a current version carrying one of the new hashes.
  const candidates = new Set<string>();
  for (const part of chunks([...new Set([...setOfNew.values()].flatMap((s) => [...s]))])) {
    const rows = await db
      .selectDistinct({ productId: catalogSourceImages.productId })
      .from(catalogSourceImages)
      .innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId))
      .where(
        and(
          eq(catalogProducts.brandSlug, batch.brandSlug),
          eq(catalogProducts.isTest, batch.isTest),
          eq(catalogSourceImages.isCurrent, true),
          inArray(catalogSourceImages.sha256, part),
        ),
      );
    for (const r of rows) candidates.add(r.productId);
  }

  // Each candidate's full set of current hashes.
  const current = new Map<string, { identifier: string; shas: Set<string> }>();
  for (const part of chunks([...candidates])) {
    const rows = await db
      .select({ productId: catalogProducts.id, identifier: catalogProducts.identifier, sha256: catalogSourceImages.sha256 })
      .from(catalogSourceImages)
      .innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId))
      .where(and(inArray(catalogSourceImages.productId, part), eq(catalogSourceImages.isCurrent, true)));
    for (const r of rows) {
      const entry = current.get(r.productId) ?? { identifier: r.identifier, shas: new Set<string>() };
      entry.shas.add(r.sha256);
      current.set(r.productId, entry);
    }
  }

  const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((s) => b.has(s));
  const hints: OverwritePreview["renameHints"] = [];
  for (const [newIdentifier, shas] of setOfNew) {
    for (const product of current.values()) {
      if (sameSet(shas, product.shas)) hints.push({ newIdentifier, existingIdentifier: product.identifier });
    }
  }
  return hints.sort((x, y) => byText(x.newIdentifier, y.newIdentifier) || byText(x.existingIdentifier, y.existingIdentifier));
}
