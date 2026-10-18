import { and, asc, eq } from "drizzle-orm";
import { brandMaster, catalogBatches, catalogOutputs, catalogProductAliases, catalogProducts } from "@catalog/core/db/schema";
import { db, type Db } from "../db";
import { HttpError } from "../errors";

export async function getBrand(slug: string, conn: Db = db()) {
  const [brand] = await conn.select({ slug: brandMaster.slug, name: brandMaster.name, line: brandMaster.line }).from(brandMaster).where(eq(brandMaster.slug, slug));
  if (!brand) throw new HttpError(404, "This brand was not found. Return to Catalog images.");
  return brand;
}

export async function searchBrandProducts(slug: string, query: string, conn: Db = db()) {
  await getBrand(slug, conn);
  const products = await conn.select({ id: catalogProducts.id, identifier: catalogProducts.identifier, pathKey: catalogProducts.pathKey, opptraSkuIds: catalogProducts.opptraSkuIds, lastBatchId: catalogProducts.lastBatchId, lastBatchName: catalogBatches.name }).from(catalogProducts).leftJoin(catalogBatches, eq(catalogBatches.id, catalogProducts.lastBatchId)).where(and(eq(catalogProducts.brandSlug, slug), eq(catalogProducts.isTest, false))).orderBy(asc(catalogProducts.identifier));
  const [aliases, live] = await Promise.all([
    conn.select({ productId: catalogProductAliases.productId, alias: catalogProductAliases.aliasKey }).from(catalogProductAliases).where(and(eq(catalogProductAliases.brandSlug, slug), eq(catalogProductAliases.isTest, false))),
    conn.select({ productId: catalogOutputs.productId, channel: catalogOutputs.channel }).from(catalogOutputs).innerJoin(catalogProducts, eq(catalogProducts.id, catalogOutputs.productId)).where(and(eq(catalogProducts.brandSlug, slug), eq(catalogProducts.isTest, false), eq(catalogOutputs.isLive, true))),
  ]);
  const q = query.trim().toLowerCase();
  return products.map(p => ({ ...p, aliases: aliases.filter(a => a.productId === p.id).map(a => a.alias), liveChannels: [...new Set(live.filter(l => l.productId === p.id).map(l => l.channel))] })).filter(p => !q || [p.identifier, ...p.aliases, ...p.opptraSkuIds].some(v => v.toLowerCase().includes(q)));
}
