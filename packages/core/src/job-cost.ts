// M6-F1-R3 (M6-S1): every Cloud Run job run writes one cost ledger row (kind `job`) with its billable seconds, the
// batch's when the run belongs to one, else its `component` (the job name) only. Outside Cloud Run (a local run, a
// test) nothing is billed and nothing is written.
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { catalogBatches, type CostOutcome } from "./db/schema";
import { recordCostEvent } from "./cost-events";

/**
 * USD per second of a catalog job at its usual shape (--cpu=2 --memory=4Gi, infra/catalog-*.sh). Cloud Run jobs are
 * always instance-billed (cloud.google.com/run/docs/configuring/billing-settings, read 2026-11-03); Tier 1
 * (asia-south1) instance-based list prices are USD 0.000018 per vCPU-second and USD 0.000002 per GiB-second
 * (cloud.google.com/run/pricing, as in catalog/cost.ts): 2 * 0.000018 + 4 * 0.000002 = 0.000044. JOB_USD_PER_SECOND
 * overrides it; the row is marked estimated either way until the reconciliation (M6-S2) prices it from the bill.
 */
export const DEFAULT_JOB_USD_PER_SECOND = 0.000044;

export function jobUsdPerSecond(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.JOB_USD_PER_SECOND);
  return env.JOB_USD_PER_SECOND?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_JOB_USD_PER_SECOND;
}

export interface JobRun {
  startedAt: number;
  /** `failed` when the run ends with a non-zero exit. */
  outcome: CostOutcome;
  /** The batch the run belongs to (a load run, a re-check of one batch), when there is one. */
  batchId?: string | null;
  /** A test or load run (smoke, evals, load): reported apart from operator cost, as test batches are. */
  isTest?: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

/** Writes the run's row; false outside a Cloud Run job (CLOUD_RUN_JOB unset). Never throws. */
export async function recordJobRun(db: Db, run: JobRun): Promise<boolean> {
  const env = run.env ?? process.env;
  const component = env.CLOUD_RUN_JOB?.trim();
  if (!component) return false;
  const ms = Math.max(0, (run.now ?? Date.now()) - run.startedAt);
  try {
    const [batch] = run.batchId
      ? await db.select({ id: catalogBatches.id, brandSlug: catalogBatches.brandSlug, isTest: catalogBatches.isTest }).from(catalogBatches).where(eq(catalogBatches.id, run.batchId))
      : [];
    return await recordCostEvent(db, {
      batchId: batch?.id ?? null, brandSlug: batch?.brandSlug ?? null, isTest: batch?.isTest ?? run.isTest ?? false,
      stage: "system", kind: "job", engine: "job", component, ms, billableMs: ms,
      usd: (ms / 1000) * jobUsdPerSecond(env), estimated: true, outcome: run.outcome,
    });
  } catch {
    return false;
  }
}
