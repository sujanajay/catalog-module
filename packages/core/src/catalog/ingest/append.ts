// M1 D29 (M1-S6, review P1-2): a follow-up batch ("Add more photos") only adds photos. Its shots of a product are
// numbered after the highest shot that product already has, so publishing them never replaces or removes a photo the
// parent (or any batch) put live. Publish keeps that rule too (pipeline/publish.ts, `append`).
import { and, eq, inArray, max, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogOutputs, catalogSourceImages } from "../../db/schema";
import type { ChannelId } from "../types";

/**
 * Per channel, the most images a product may have when a follow-up adds photos. Empty: SPEC sets no cap per product
 * or channel. A follow-up photo whose shot number is above its channel's limit is skipped with a note on the product
 * (never published over another photo), so a limit set here later can only hold photos back.
 */
export const CHANNEL_IMAGE_LIMITS: Partial<Record<ChannelId, number>> = {};

/** Batches that started and may still publish (their photos are not current yet). */
const RUNNING = ["matting", "rendering", "qa", "publishing"] as const;

/**
 * The highest shot number each product already has: its live outputs on any channel, its current photos, and the
 * photos of any batch still running (a parent still running has not made its photos current
 * yet). A product with none is absent (its shots start at 1).
 */
export async function highestShots(db: Db, productIds: readonly string[]): Promise<Map<string, number>> {
  const highest = new Map<string, number>();
  const raise = (productId: string, n: number | null) => {
    if (n !== null && n > (highest.get(productId) ?? 0)) highest.set(productId, n);
  };
  for (let i = 0; i < productIds.length; i += 1000) {
    const part = productIds.slice(i, i + 1000);
    const live = await db.select({ productId: catalogOutputs.productId, n: max(catalogOutputs.n) }).from(catalogOutputs)
      .where(and(inArray(catalogOutputs.productId, part), eq(catalogOutputs.isLive, true))).groupBy(catalogOutputs.productId);
    for (const r of live) raise(r.productId, r.n);
    const sources = await db.select({ productId: catalogSourceImages.productId, n: max(catalogSourceImages.n) }).from(catalogSourceImages)
      .innerJoin(catalogBatches, eq(catalogBatches.id, catalogSourceImages.batchId))
      .where(and(inArray(catalogSourceImages.productId, part), or(eq(catalogSourceImages.isCurrent, true), inArray(catalogBatches.status, [...RUNNING]))))
      .groupBy(catalogSourceImages.productId);
    for (const r of sources) raise(r.productId, r.n);
  }
  return highest;
}

/**
 * The shot number of each photo of one product: its own number (`n` from the file name, else its place), after
 * `after` when the batch appends. Photos keep their order; appended ones follow on without gaps.
 */
export function shotNumbers<T extends { n?: number | null }>(items: readonly T[], after: number | null): Map<T, number> {
  const own = items.map((item, i) => ({ item, n: item.n ?? i + 1 }));
  if (after === null) return new Map(own.map(({ item, n }) => [item, n]));
  const distinct = [...new Set(own.map(({ n }) => n))].sort((a, b) => a - b);
  const rank = new Map(distinct.map((n, i) => [n, after + i + 1]));
  return new Map(own.map(({ item, n }) => [item, rank.get(n)!]));
}
