import { listAttention } from "@catalog/core/catalog/attention";
import { and, asc, desc, eq } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProductAliases, catalogProductEvents, catalogProducts } from "@catalog/core/db/schema";
import { assertWithinProduct, normalizeKey, productPrefix } from "@catalog/core/catalog/naming";
import { addAlias } from "@catalog/core/catalog/products";
import { deletePublicObject, signedUrl } from "@catalog/core/storage";
import { db, type Db } from "../db";
import { HttpError } from "../errors";

export async function getProduct(brand: string, key: string, isTest = false, conn: Db = db()) {
  const [product] = await conn.select().from(catalogProducts).where(and(eq(catalogProducts.brandSlug, brand), eq(catalogProducts.pathKey, key), eq(catalogProducts.isTest, isTest)));
  if (!product) throw new HttpError(404, "This product was not found. Return to the brand page.");
  const [images, aliases, events, lock] = await Promise.all([
    conn.select({ id: catalogOutputs.id, channel: catalogOutputs.channel, n: catalogOutputs.n, publicUrl: catalogOutputs.publicUrl }).from(catalogOutputs).where(and(eq(catalogOutputs.productId, product.id), eq(catalogOutputs.isLive, true))).orderBy(asc(catalogOutputs.channel), asc(catalogOutputs.n)),
    conn.select({ aliasKey: catalogProductAliases.aliasKey, kind: catalogProductAliases.kind }).from(catalogProductAliases).where(eq(catalogProductAliases.productId, product.id)),
    conn.select({ id: catalogProductEvents.id, kind: catalogProductEvents.kind, actor: catalogProductEvents.actor, details: catalogProductEvents.details, at: catalogProductEvents.at, batchId: catalogProductEvents.batchId, batchName: catalogBatches.name }).from(catalogProductEvents).leftJoin(catalogBatches, eq(catalogBatches.id, catalogProductEvents.batchId)).where(eq(catalogProductEvents.productId, product.id)).orderBy(desc(catalogProductEvents.at)),
    product.lockBatchId ? conn.select({ name: catalogBatches.name }).from(catalogBatches).where(eq(catalogBatches.id, product.lockBatchId)) : Promise.resolve([]),
  ]);
  return { ...product, images, aliases, events, lockedBy: lock[0]?.name ?? null };
}

export async function addProductAlias(id: string, alias: string, actor: string, conn: Db = db()) {
  try { await addAlias(conn, { productId: id, aliasKey: alias, kind: "manual", actor }); }
  catch (err) {
    const message = err instanceof Error ? err.message : "Could not add the alias. Try again.";
    const conflict = /^This name already belongs to (.+)\.$/.exec(message);
    throw new HttpError(conflict ? 409 : 400, conflict ? `That name already points to ${conflict[1]}.` : message);
  }
  return { alias: alias.trim(), aliasKey: normalizeKey(alias) };
}

export async function removeProduct(id: string, confirm: string, actor: string, conn: Db = db(), remove = deletePublicObject) {
  await conn.transaction(async tx => {
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id,id)).for("update");
    if (!product) throw new HttpError(404,"This product no longer exists. Return to the brand page.");
    if (product.identifier !== confirm) throw new HttpError(400,"Type the product identifier exactly to confirm removal.");
    if (product.lockBatchId) {
      const [batch] = await tx.select({name:catalogBatches.name}).from(catalogBatches).where(eq(catalogBatches.id,product.lockBatchId));
      throw new HttpError(409,`${product.identifier} is being processed in batch ${batch?.name ?? product.lockBatchId}.`);
    }
    const live=await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,id),eq(catalogOutputs.isLive,true)));
    const prefix=productPrefix(product.brandSlug,product.pathKey,product.isTest);
    for(const output of live) {
      assertWithinProduct(output.objectPath,prefix);
      if(output.generation===null) throw new HttpError(409,"A live image has no recorded generation. Ask the technical team to check this product before removing it.");
    }
    for(const output of live) {
      await remove(output.objectPath,prefix,{ifGenerationMatch:output.generation!});
      await tx.update(catalogOutputs).set({isLive:false,supersededAt:new Date(),status:"skipped",reason:`Removed by ${actor}`}).where(eq(catalogOutputs.id,output.id));
    }
    await tx.insert(catalogProductEvents).values({productId:id,kind:"removed",actor,details:{channels:[...new Set(live.map(o=>o.channel))],shots:live.map(o=>o.n)}});
    await tx.delete(catalogOutputs).where(eq(catalogOutputs.productId,id));
    await tx.delete(catalogProducts).where(eq(catalogProducts.id,id));
  });
}

export type { AttentionPhoto,AttentionProduct } from "@catalog/core/catalog/attention";
export async function batchAttention(batchId:string,conn:Db=db(),sign=signedUrl){const [batch]=await conn.select({id:catalogBatches.id}).from(catalogBatches).where(eq(catalogBatches.id,batchId));if(!batch)throw new HttpError(404,"This batch was not found. Return to All batches.");return listAttention(conn,batchId,sign);}
