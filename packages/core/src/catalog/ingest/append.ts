// M1 D30 (M1-S6, review P1-2 and re-review P1-A): a follow-up batch ("Add more photos") only adds photos. Its shot
// numbers come from one place, allocateShots: under the product row lock, after every shot the product has or is
// about to have (any batch's photos, pending, held for attention or published, its live outputs, and the numbers
// other follow-ups hold), and held in catalog_shot_numbers, whose primary key (product, n) makes two batches holding
// one number impossible. Publish keeps the rule too (pipeline/publish.ts `append`): a follow-up only deletes or
// replaces objects it made itself.
import { and, eq, inArray, max, ne } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogOutputs, catalogProducts, catalogShotNumbers, catalogSourceImages } from "../../db/schema";
import type { ChannelId } from "../types";

/**
 * Per channel, the most images a product may have when a follow-up adds photos. Empty: SPEC sets no cap per product
 * or channel. A follow-up photo whose shot number is above its channel's limit is not added and is flagged
 * (`not_added`), never published over another photo, so a limit set here later can only hold photos back.
 * Before setting one (M1 D30, re-review 3 P2-2): shot numbers can skip (held numbers are never freed and highestShots
 * counts every photo a product ever had), so compare the limit with the count of live photos plus this batch's
 * additions, not with the shot number, and free unused held numbers first.
 */
export const CHANNEL_IMAGE_LIMITS: Partial<Record<ChannelId, number>> = {};

const SLICE = 1000;

/**
 * The highest shot number each product already has or is about to have, not counting `exceptBatchId`: every photo of
 * any batch (whatever its status: a parent's product held for attention keeps photos that are neither current nor
 * live), every live output, and every number another follow-up holds. A product with none is absent.
 */
export async function highestShots(db: Db, productIds: readonly string[], exceptBatchId: string): Promise<Map<string, number>> {
  const highest = new Map<string, number>();
  const raise = (rows: { productId: string; n: number | null }[]) => {
    for (const r of rows) if (r.n !== null && r.n > (highest.get(r.productId) ?? 0)) highest.set(r.productId, r.n);
  };
  for (let i = 0; i < productIds.length; i += SLICE) {
    const part = productIds.slice(i, i + SLICE);
    raise(await db.select({ productId: catalogOutputs.productId, n: max(catalogOutputs.n) }).from(catalogOutputs)
      .where(and(inArray(catalogOutputs.productId, part), eq(catalogOutputs.isLive, true))).groupBy(catalogOutputs.productId));
    raise(await db.select({ productId: catalogSourceImages.productId, n: max(catalogSourceImages.n) }).from(catalogSourceImages)
      .where(and(inArray(catalogSourceImages.productId, part), ne(catalogSourceImages.batchId, exceptBatchId))).groupBy(catalogSourceImages.productId));
    raise(await db.select({ productId: catalogShotNumbers.productId, n: max(catalogShotNumbers.n) }).from(catalogShotNumbers)
      .where(and(inArray(catalogShotNumbers.productId, part), ne(catalogShotNumbers.batchId, exceptBatchId))).groupBy(catalogShotNumbers.productId));
  }
  return highest;
}

/** The numbers `batchId` holds per product, lowest first. */
async function heldShots(db: Db, batchId: string, productIds: readonly string[]): Promise<Map<string, number[]>> {
  const held = new Map<string, number[]>();
  for (let i = 0; i < productIds.length; i += SLICE) {
    const rows = await db.select({ productId: catalogShotNumbers.productId, n: catalogShotNumbers.n }).from(catalogShotNumbers)
      .where(and(eq(catalogShotNumbers.batchId, batchId), inArray(catalogShotNumbers.productId, productIds.slice(i, i + SLICE)))).orderBy(catalogShotNumbers.n);
    for (const r of rows) held.set(r.productId, [...(held.get(r.productId) ?? []), r.n]);
  }
  return held;
}

/**
 * Gives `batchId` (a follow-up) `count` shot numbers for each product, in one transaction that takes the product rows
 * FOR UPDATE (sorted, so two batches lock in the same order). Numbers the batch already holds are used first (a
 * regroup keeps them); new ones follow the highest any other batch has or holds. The insert has no conflict clause:
 * should two batches ever reach one number, the primary key refuses it and the delivery is retried, never skipped.
 */
export async function allocateShots(db: Db, batchId: string, wants: readonly { productId: string; count: number }[]): Promise<Map<string, number[]>> {
  const ids = [...new Set(wants.map((w) => w.productId))].sort();
  if (!ids.length) return new Map();
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    for (let i = 0; i < ids.length; i += SLICE) {
      await tx.select({ id: catalogProducts.id }).from(catalogProducts).where(inArray(catalogProducts.id, ids.slice(i, i + SLICE))).orderBy(catalogProducts.id).for("update");
    }
    const held = await heldShots(t, batchId, ids);
    const highest = await highestShots(t, ids, batchId);
    const fresh: { productId: string; n: number; batchId: string }[] = [];
    const out = new Map<string, number[]>();
    for (const w of wants) {
      const own = [...(held.get(w.productId) ?? [])];
      let next = Math.max(highest.get(w.productId) ?? 0, own.at(-1) ?? 0);
      while (own.length < w.count) {
        own.push(++next);
        fresh.push({ productId: w.productId, n: next, batchId });
      }
      held.set(w.productId, own);
      out.set(w.productId, own.slice(0, w.count));
    }
    for (let i = 0; i < fresh.length; i += SLICE) await tx.insert(catalogShotNumbers).values(fresh.slice(i, i + SLICE));
    return out;
  });
}

/**
 * The numbers a follow-up's photos of each product would get, without holding them (the overwrite preview, which may
 * run before the grouping allocates): the ones it holds, then the ones after the highest.
 */
export async function plannedShots(db: Db, batchId: string, wants: readonly { productId: string; count: number }[]): Promise<Map<string, number[]>> {
  const ids = [...new Set(wants.map((w) => w.productId))];
  const held = await heldShots(db, batchId, ids);
  const highest = await highestShots(db, ids, batchId);
  const out = new Map<string, number[]>();
  for (const w of wants) {
    const own = [...(held.get(w.productId) ?? [])];
    let next = Math.max(highest.get(w.productId) ?? 0, own.at(-1) ?? 0);
    while (own.length < w.count) own.push(++next);
    out.set(w.productId, own.slice(0, w.count));
  }
  return out;
}

/** The distinct shots of one product's photos (its own number from the file name, else its place), in order. */
export function shotRanks<T extends { n?: number | null }>(items: readonly T[]): number {
  return new Set(items.map((item, i) => item.n ?? i + 1)).size;
}

/**
 * The shot number of each photo of one product: its own number (`n` from the file name, else its place), or, for a
 * follow-up, the k-th of `numbers` for its k-th distinct shot. Photos keep their order; two files of one shot keep
 * sharing a number (the duplicate_shot rule).
 */
export function shotNumbers<T extends { n?: number | null }>(items: readonly T[], numbers: readonly number[] | null): Map<T, number> {
  const own = items.map((item, i) => ({ item, n: item.n ?? i + 1 }));
  if (numbers === null) return new Map(own.map(({ item, n }) => [item, n]));
  const distinct = [...new Set(own.map(({ n }) => n))].sort((a, b) => a - b);
  const rank = new Map(distinct.map((n, i) => [n, numbers[i]!]));
  return new Map(own.map(({ item, n }) => [item, rank.get(n)!]));
}
