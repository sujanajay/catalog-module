// M6-F1-R2 (M6-S1): the worker's own request wall time per delivery in the cost ledger, so time spent waiting on
// matting or upscaling is counted (load 5: the ledger held 24,945 vCPU-seconds against 181,000 billable worker
// seconds). The chunk and publish handlers write their own compute rows (with their chunk and product); every other
// task route is wrapped here: one `compute` row per delivery, the batch's when the body names one, else a row of no
// batch (the sweep, the master sync).
import { eq } from "drizzle-orm";
import { ownComponent, recordCostEvent } from "@catalog/core/cost-events";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, type CostOutcome, type CostStage } from "@catalog/core/db/schema";
import { log } from "@catalog/core/log";
import { computeVcpuPerSecond } from "./catalog/chunk";
import type { HandleResult, RouteHandler } from "./server";

/** USD of `ms` of one delivery: wall seconds x the vCPU share of one delivery x COMPUTE_USD_PER_VCPU_SECOND (0 unset). */
export function deliveryUsd(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  const rate = Number(env.COMPUTE_USD_PER_VCPU_SECOND ?? 0);
  return Number.isFinite(rate) && rate > 0 && ms > 0 ? (ms / 1000) * computeVcpuPerSecond(env) * rate : 0;
}

/** The outcome of a delivery: `failed` when the handler threw or answered 500, else `ok` (a 503 wait is billed time too). */
export function deliveryOutcome(result: HandleResult | null): CostOutcome {
  return result === null || result.httpStatus === 500 ? "failed" : "ok";
}

export interface DeliveryCostDeps {
  db: () => Db;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Writes one compute row for a delivery of `stage` that ran `ms`; never throws (recordCostEvent logs a failed write). */
export async function recordDeliveryCost(db: Db, body: Record<string, unknown>, stage: CostStage, ms: number, outcome: CostOutcome, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const batchId = typeof body.batchId === "string" && /^[0-9a-f-]{36}$/i.test(body.batchId) ? body.batchId : null;
    const [batch] = batchId ? await db.select({ id: catalogBatches.id, brandSlug: catalogBatches.brandSlug, isTest: catalogBatches.isTest }).from(catalogBatches).where(eq(catalogBatches.id, batchId)) : [];
    await recordCostEvent(db, {
      batchId: batch?.id ?? null, brandSlug: batch?.brandSlug ?? null, isTest: batch?.isTest ?? false,
      stage, kind: "compute", engine: "worker", component: ownComponent(env), ms, billableMs: ms, usd: deliveryUsd(ms, env), outcome,
    });
  } catch (error) {
    log("ERROR", "cost event write failed", { stage, error: error instanceof Error ? error.message : String(error) });
  }
}

/** `handler` with one compute row written after each delivery (also when it throws; the error is passed on). */
export function withDeliveryCost(deps: DeliveryCostDeps, stage: CostStage, handler: RouteHandler): RouteHandler {
  const now = deps.now ?? Date.now;
  return async (body, opts) => {
    const started = now();
    let result: HandleResult | null = null;
    try {
      result = await handler(body, opts);
      return result;
    } finally {
      await recordDeliveryCost(deps.db(), body, stage, Math.max(0, now() - started), deliveryOutcome(result), deps.env);
    }
  };
}
