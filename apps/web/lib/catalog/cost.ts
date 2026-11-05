import { and, eq, ne, sql } from "drizzle-orm";
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
  // Styles made: the batch's products not unchanged with at least one output not skipped, counted in the database. A
  // lookup of outputs per product here was quadratic (about 27 s at 25,000 products, M1-S5 review follow-up).
  const [row] = await conn.select({ n: sql<number>`count(*)::int` }).from(catalogBatchProducts).where(and(
    eq(catalogBatchProducts.batchId, batch.id), ne(catalogBatchProducts.change, "unchanged"),
    sql`exists (select 1 from ${catalogOutputs} o where o.batch_id = ${batch.id}::uuid and o.product_id = ${catalogBatchProducts.productId} and o.status <> 'skipped')`,
  ));
  return costLine({ cost: { ...batch.cost, identifiers: Number(row?.n ?? 0) } }, env);
}

/** The wizard step 4 estimate; null when INR_PER_USD is not set. */
export function wizardEstimate(counts: EstimateCounts, env: NodeJS.ProcessEnv = process.env) {
  return estimateCost(counts, env);
}
