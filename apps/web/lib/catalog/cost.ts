import { costLine, costLineFor, estimateCost, type EstimateCounts } from "@catalog/core/catalog/cost";
import { batchCostFigure } from "@catalog/core/catalog/cost-report";
import { db, type Db } from "../db";

export type BatchCostLine = ReturnType<typeof costLine>;

/**
 * The batch page cost line (spec 07 4.11). R1 exit item 4: the same figure, products and basis as the digest
 * (batchCostFigure): the whole cost ledger per product with links so far, then the daily cost check's figure.
 */
export async function batchCostLine(batch: { id: string }, conn: Db = db(), env: NodeJS.ProcessEnv = process.env): Promise<BatchCostLine> {
  const figure = await batchCostFigure(conn, batch.id);
  return costLineFor(figure.usd, figure.products, env, figure.basis);
}

/** The wizard step 4 estimate; null when INR_PER_USD is not set. */
export function wizardEstimate(counts: EstimateCounts, env: NodeJS.ProcessEnv = process.env) {
  return estimateCost(counts, env);
}
