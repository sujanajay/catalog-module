import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProductAliases, catalogProductEvents, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { assertWithinProduct, normalizeKey, productPrefix } from "@catalog/core/catalog/naming";
import { addAlias } from "@catalog/core/catalog/products";
import { channel } from "@catalog/core/catalog/channels";
import { deletePublicObject, signedUrl } from "@catalog/core/storage";
import { flagReason, type ChannelId } from "@catalog/core/catalog/types";
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

export interface AttentionPhoto { n: number; channel: ChannelId; outputId: string; originalUrl: string; outputUrl: string | null; why: string; whatToDo: string; liveObjectExists: boolean }
export interface AttentionProduct { productId: string; identifier: string; totalShots: number; problemLine: string; photos: AttentionPhoto[] }

export async function batchAttention(batchId: string, conn: Db = db(), sign = signedUrl): Promise<AttentionProduct[]> {
  const [batch] = await conn.select({ id: catalogBatches.id }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  const rows = await conn.select({ output: catalogOutputs, source: catalogSourceImages, identifier: catalogProducts.identifier }).from(catalogOutputs).innerJoin(catalogSourceImages, eq(catalogSourceImages.id, catalogOutputs.sourceImageId)).innerJoin(catalogProducts, eq(catalogProducts.id, catalogOutputs.productId)).where(and(eq(catalogOutputs.batchId, batchId), inArray(catalogOutputs.status, ["needs_attention", "failed"]))).orderBy(asc(catalogProducts.identifier), asc(catalogOutputs.n));
  const held = await conn.select({productId:catalogBatchProducts.productId,identifier:catalogProducts.identifier,notes:catalogBatchProducts.notes}).from(catalogBatchProducts).innerJoin(catalogProducts,eq(catalogProducts.id,catalogBatchProducts.productId)).where(and(eq(catalogBatchProducts.batchId,batchId),eq(catalogBatchProducts.change,"pending_attention")));
  const ids = [...new Set([...rows.map(r => r.output.productId),...held.map(p=>p.productId)])];
  if (!ids.length) return [];
  const [live, sources] = await Promise.all([
    conn.select({ productId: catalogOutputs.productId, channel: catalogOutputs.channel, n: catalogOutputs.n }).from(catalogOutputs).where(and(inArray(catalogOutputs.productId, ids), eq(catalogOutputs.isLive, true))),
    conn.select({ productId: catalogSourceImages.productId, n: catalogSourceImages.n }).from(catalogSourceImages).where(and(inArray(catalogSourceImages.productId, ids), eq(catalogSourceImages.batchId, batchId))),
  ]);
  const grouped = new Map<string, AttentionProduct>();
  for (const { output: o, source, identifier } of rows) {
    const informationOnly = ["low_resolution", "no_shadow_source", "passthrough", "alpha_source", "numbering_gap", "shadow_synthesised"];
    const reasons = o.flags.filter(f => !informationOnly.includes(f)).map(f => flagReason(f, {
      channel: channel(o.channel).label,
      ...(source.width !== null && source.height !== null ? { w: source.width, h: source.height } : {}),
      failures: o.reason ?? "",
    })).filter(Boolean);
    const why = reasons[0] || o.reason || o.error || source.error || "This photo could not be made. Check the original and try again.";
    const item = grouped.get(o.productId) ?? { productId: o.productId, identifier, totalShots: new Set(sources.filter(s => s.productId === o.productId).map(s => s.n)).size, problemLine: why, photos: [] };
    item.photos.push({ n: o.n, channel: o.channel, outputId: o.id, originalUrl: await sign(source.rawUri), outputUrl: o.stagingUri ? await sign(o.stagingUri) : null, why, whatToDo: reasons[0] || why, liveObjectExists: live.some(l => l.productId === o.productId && l.channel === o.channel && l.n === o.n) });
    grouped.set(o.productId, item);
  }
  for (const product of held) if (!grouped.has(product.productId)) {
    grouped.set(product.productId,{productId:product.productId,identifier:product.identifier,totalShots:new Set(sources.filter(s=>s.productId===product.productId).map(s=>s.n)).size,problemLine:product.notes || "Some photos could not be processed. Start this product again.",photos:[]});
  }
  return [...grouped.values()].sort((a,b)=>a.identifier.localeCompare(b.identifier));
}
