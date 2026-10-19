import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
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
  const q = query.trim().toLowerCase();
  const matches = q ? or(
    sql`strpos(lower(${catalogProducts.identifier}),${q}) > 0`,
    sql`EXISTS (SELECT 1 FROM ${catalogProductAliases} WHERE ${catalogProductAliases.productId}=${catalogProducts.id} AND ${catalogProductAliases.brandSlug}=${slug} AND ${catalogProductAliases.isTest}=false AND strpos(lower(${catalogProductAliases.aliasKey}),${q}) > 0)`,
    sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${catalogProducts.opptraSkuIds}) AS sku(value) WHERE strpos(lower(sku.value),${q}) > 0)`,
  ) : undefined;
  const products = await conn.select({ id: catalogProducts.id, identifier: catalogProducts.identifier, pathKey: catalogProducts.pathKey, opptraSkuIds: catalogProducts.opptraSkuIds, lastBatchId: catalogProducts.lastBatchId, lastBatchName: catalogBatches.name }).from(catalogProducts).leftJoin(catalogBatches, eq(catalogBatches.id, catalogProducts.lastBatchId)).where(and(eq(catalogProducts.brandSlug, slug), eq(catalogProducts.isTest, false), matches)).orderBy(asc(catalogProducts.identifier));
  if (!products.length) return [];
  const ids = products.map(product=>product.id);
  const [aliases, live] = await Promise.all([
    conn.select({ productId: catalogProductAliases.productId, alias: catalogProductAliases.aliasKey }).from(catalogProductAliases).where(and(eq(catalogProductAliases.brandSlug, slug), eq(catalogProductAliases.isTest, false), inArray(catalogProductAliases.productId, ids))),
    conn.selectDistinct({ productId: catalogOutputs.productId, channel: catalogOutputs.channel }).from(catalogOutputs).where(and(inArray(catalogOutputs.productId, ids), eq(catalogOutputs.isLive, true))),
  ]);
  const aliasesByProduct = new Map<string,string[]>(), channelsByProduct = new Map<string,typeof live[number]["channel"][]>();
  for (const alias of aliases) { const values=aliasesByProduct.get(alias.productId) ?? []; values.push(alias.alias); aliasesByProduct.set(alias.productId,values); }
  for (const output of live) { const values=channelsByProduct.get(output.productId) ?? []; values.push(output.channel); channelsByProduct.set(output.productId,values); }
  return products.map(p => ({ ...p, aliases: aliasesByProduct.get(p.id) ?? [], liveChannels: channelsByProduct.get(p.id) ?? [] }));
}
