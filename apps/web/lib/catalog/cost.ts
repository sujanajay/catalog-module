import { eq } from "drizzle-orm";
import { costLine, estimateCost, type EstimateCounts } from "@catalog/core/catalog/cost";
import { catalogBatchProducts, catalogOutputs } from "@catalog/core/db/schema";
import type { BatchCost } from "@catalog/core/catalog/types";
import { db, type Db } from "../db";

export type BatchCostLine = ReturnType<typeof costLine>;

/**
 * The batch page "Cost so far" line (spec 07 4.11). The denominator is read live from the batch's
 * products so the figure is right before finalize has written `cost.identifiers`.
 */
export async function batchCostLine(batch: { id: string; cost: BatchCost }, conn: Db = db(), env: NodeJS.ProcessEnv = process.env): Promise<BatchCostLine> {
  const [products, outputs] = await Promise.all([
    conn.select({ productId: catalogBatchProducts.productId, change: catalogBatchProducts.change }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id)),
    conn.select({ productId: catalogOutputs.productId, status: catalogOutputs.status }).from(catalogOutputs).where(eq(catalogOutputs.batchId, batch.id)),
  ]);
  return costLine({ cost: batch.cost, products: products.map(p => ({ change: p.change, outputs: outputs.filter(o => o.productId === p.productId) })) }, env);
}

/** The wizard step 4 estimate; null when INR_PER_USD is not set. */
export function wizardEstimate(counts: EstimateCounts, env: NodeJS.ProcessEnv = process.env) {
  return estimateCost(counts, env);
}
