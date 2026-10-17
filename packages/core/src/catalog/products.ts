// Product identity helpers (spec 02, "Product identity helpers").
//
// A product is one brand plus one style+colour identifier. product_key = normalizeKey(identifier)
// decides whether an upload is a known product; path_key = sanitizeSegment(identifier) as first
// seen is the path segment for life. Opptra SKU ids are attributes, never part of a key or path.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  catalogBatches,
  catalogProductAliases,
  catalogProductEvents,
  catalogProducts,
  type CatalogProduct,
} from "../db/schema";
import { normalizeKey, sanitizeSegment } from "./naming";
import type { ResolveResult } from "./sku-mapping";
import type { AliasKind, EventKind, ProductType } from "./types";

export type { CatalogProduct };

export type LockResult =
  | { ok: true }
  | { ok: false; busy: { productId: string; identifier: string; batchId: string; batchName: string }[] };

/** Drizzle transaction handle; it has the same query API as Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export async function recordEvent(
  db: Conn,
  input: { productId: string; batchId?: string | null; kind: EventKind; actor: string; details?: Record<string, unknown> },
): Promise<void> {
  await db.insert(catalogProductEvents).values({
    productId: input.productId,
    batchId: input.batchId ?? null,
    kind: input.kind,
    actor: input.actor,
    details: input.details ?? {},
  });
}

async function productByAlias(db: Conn, brandSlug: string, isTest: boolean, aliasKey: string): Promise<CatalogProduct | null> {
  const [row] = await db
    .select({ product: catalogProducts })
    .from(catalogProductAliases)
    .innerJoin(catalogProducts, eq(catalogProducts.id, catalogProductAliases.productId))
    .where(
      and(
        eq(catalogProductAliases.brandSlug, brandSlug),
        eq(catalogProductAliases.isTest, isTest),
        eq(catalogProductAliases.aliasKey, aliasKey),
      ),
    );
  return row?.product ?? null;
}

/** Inserts the alias unless the key is already taken (by this or another product). */
async function ensureAlias(db: Conn, product: CatalogProduct, aliasKey: string, kind: AliasKind): Promise<void> {
  if (!aliasKey) return;
  await db
    .insert(catalogProductAliases)
    .values({ brandSlug: product.brandSlug, isTest: product.isTest, aliasKey, productId: product.id, kind })
    .onConflictDoNothing({
      target: [catalogProductAliases.brandSlug, catalogProductAliases.isTest, catalogProductAliases.aliasKey],
    });
}

/**
 * Finds the product for an identifier, or creates it.
 * (1) normalizeKey(identifier) is an alias of the brand -> that product; (2) the resolved
 * option_id normalised is an alias -> that product (and the identifier becomes an alias of it);
 * (3) otherwise a new product with its own key as the first alias and a `created` event. A new
 * identifier whose path_key is empty or already used by another product of the brand is refused
 * with an operator sentence, so two products never share public paths.
 * In every case the resolved option_id and each opptra_sku become aliases if not yet present, and
 * new SKU ids are merged into opptra_sku_ids with a `sku_ids_added` event. Insert races are
 * resolved by the unique index: on conflict the row is re-read and isNew is false.
 */
export async function findOrCreateProduct(
  db: Db,
  input: { brandSlug: string; isTest: boolean; identifier: string; skus: ResolveResult | null; productType?: ProductType; actor: string },
): Promise<{ product: CatalogProduct; isNew: boolean }> {
  const identifier = input.identifier.trim();
  const productKey = normalizeKey(identifier);
  if (!productKey) throw new Error("The identifier is empty, so the product cannot be named.");
  const { brandSlug, isTest, skus, actor } = input;
  const optionKey = skus?.optionIdStyleColor ? normalizeKey(skus.optionIdStyleColor) : "";
  const skuIds = [...new Set(skus?.opptraSkuIds ?? [])].sort();

  return db.transaction(async (tx) => {
    let isNew = false;
    let product = await productByAlias(tx, brandSlug, isTest, productKey);
    if (!product && optionKey) {
      product = await productByAlias(tx, brandSlug, isTest, optionKey);
      if (product) await ensureAlias(tx, product, productKey, "identifier");
    }
    if (!product) {
      const pathKey = sanitizeSegment(identifier);
      if (!/[A-Za-z0-9]/.test(pathKey)) {
        throw new Error(`"${identifier}" cannot be used in an image link: it has no plain letters or digits. Rename the files using A-Z, 0-9, "-" or "_".`);
      }
      const [samePath] = await tx
        .select({ identifier: catalogProducts.identifier })
        .from(catalogProducts)
        .where(and(eq(catalogProducts.brandSlug, brandSlug), eq(catalogProducts.isTest, isTest), eq(catalogProducts.pathKey, pathKey)));
      if (samePath) {
        throw new Error(`"${identifier}" would share image links with ${samePath.identifier}. Rename one of them so they differ in letters or digits.`);
      }
      const [created] = await tx
        .insert(catalogProducts)
        .values({
          brandSlug,
          isTest,
          productKey,
          pathKey,
          identifier,
          optionIdStyleColor: skus?.optionIdStyleColor ?? null,
          opptraSkuIds: skuIds,
          skuMethod: skus?.method ?? null,
          productType: input.productType ?? null,
        })
        .onConflictDoNothing({ target: [catalogProducts.brandSlug, catalogProducts.isTest, catalogProducts.productKey] })
        .returning();
      if (created) {
        isNew = true;
        product = created;
        await ensureAlias(tx, product, productKey, "identifier");
        await recordEvent(tx, { productId: product.id, kind: "created", actor, details: { identifier } });
      } else {
        const [existing] = await tx
          .select()
          .from(catalogProducts)
          .where(
            and(
              eq(catalogProducts.brandSlug, brandSlug),
              eq(catalogProducts.isTest, isTest),
              eq(catalogProducts.productKey, productKey),
            ),
          );
        if (!existing) throw new Error(`Product ${identifier} could not be read back after a conflicting insert.`);
        product = existing;
      }
    }

    if (optionKey) await ensureAlias(tx, product, optionKey, "option_id");
    for (const sku of skuIds) await ensureAlias(tx, product, normalizeKey(sku), "opptra_sku");

    if (!isNew) {
      const current = product.opptraSkuIds ?? [];
      const added = skuIds.filter((s) => !current.includes(s));
      const patch: Partial<typeof catalogProducts.$inferInsert> = {};
      if (added.length) patch.opptraSkuIds = [...new Set([...current, ...added])].sort();
      if (skus && skus.method !== "unresolved") {
        if (!product.optionIdStyleColor && skus.optionIdStyleColor) patch.optionIdStyleColor = skus.optionIdStyleColor;
        if (added.length || !product.skuMethod) patch.skuMethod = skus.method;
      }
      if (!product.productType && input.productType) patch.productType = input.productType;
      if (Object.keys(patch).length) {
        const [updated] = await tx.update(catalogProducts).set(patch).where(eq(catalogProducts.id, product.id)).returning();
        if (updated) product = updated;
      }
      if (added.length) {
        await recordEvent(tx, { productId: product.id, kind: "sku_ids_added", actor, details: { added } });
      }
    }
    return { product, isNew };
  });
}

/**
 * Adds an alias to a product and an `alias_added` event. A key that already points at this
 * product is a no-op; a key that belongs to another product fails with an operator sentence.
 */
export async function addAlias(
  db: Db,
  input: { productId: string; aliasKey: string; kind: AliasKind; actor: string; batchId?: string | null },
): Promise<void> {
  const aliasKey = normalizeKey(input.aliasKey.trim());
  if (!aliasKey) throw new Error("The name is empty. Type the name the product should also be known by.");
  await db.transaction(async (tx) => {
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, input.productId));
    if (!product) throw new Error("This product no longer exists. Reload the page.");
    const inserted = await tx
      .insert(catalogProductAliases)
      .values({ brandSlug: product.brandSlug, isTest: product.isTest, aliasKey, productId: product.id, kind: input.kind })
      .onConflictDoNothing({
        target: [catalogProductAliases.brandSlug, catalogProductAliases.isTest, catalogProductAliases.aliasKey],
      })
      .returning({ id: catalogProductAliases.id });
    if (!inserted.length) {
      const owner = await productByAlias(tx, product.brandSlug, product.isTest, aliasKey);
      if (owner && owner.id !== product.id) throw new Error(`This name already belongs to ${owner.identifier}.`);
      return;
    }
    await recordEvent(tx, {
      productId: product.id,
      batchId: input.batchId ?? null,
      kind: "alias_added",
      actor: input.actor,
      details: { aliasKey, kind: input.kind },
    });
  });
}

class LockBusy extends Error {
  constructor(readonly busy: Extract<LockResult, { ok: false }>["busy"]) {
    super("products busy");
  }
}

/**
 * Locks the products for a batch in one transaction. Products already locked by this batch count
 * as locked. If any product is held by another batch the transaction rolls back (no row changes)
 * and the result lists the busy products with the batch that holds them.
 */
export async function lockProducts(db: Db, batchId: string, productIds: string[]): Promise<LockResult> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return { ok: true };
  try {
    await db.transaction(async (tx) => {
      const locked = await tx
        .update(catalogProducts)
        .set({ lockBatchId: batchId })
        .where(
          and(
            inArray(catalogProducts.id, ids),
            sql`(${catalogProducts.lockBatchId} IS NULL OR ${catalogProducts.lockBatchId} = ${batchId})`,
          ),
        )
        .returning({ id: catalogProducts.id });
      if (locked.length === ids.length) return;
      const busy = await tx
        .select({
          productId: catalogProducts.id,
          identifier: catalogProducts.identifier,
          batchId: catalogBatches.id,
          batchName: catalogBatches.name,
        })
        .from(catalogProducts)
        .innerJoin(catalogBatches, eq(catalogBatches.id, catalogProducts.lockBatchId))
        .where(and(inArray(catalogProducts.id, ids), ne(catalogProducts.lockBatchId, batchId)))
        .orderBy(catalogProducts.identifier);
      if (!busy.length) throw new Error("Some products to lock no longer exist. Reload the batch and try again.");
      throw new LockBusy(busy);
    });
  } catch (err) {
    if (err instanceof LockBusy) return { ok: false, busy: err.busy };
    throw err;
  }
  return { ok: true };
}

/** Releases every product lock held by the batch. Returns the number of products released. */
export async function releaseLocks(db: Db, batchId: string): Promise<number> {
  const released = await db
    .update(catalogProducts)
    .set({ lockBatchId: null })
    .where(eq(catalogProducts.lockBatchId, batchId))
    .returning({ id: catalogProducts.id });
  return released.length;
}
