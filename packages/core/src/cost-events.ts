// Cost ledger writes (observability plan, part A). Every write runs in its own savepoint (a nested
// transaction when `db` is already one, a short transaction otherwise), so a failing insert is caught,
// logged as an ERROR line and never fails or slows the chunk, judge call or publish around it.
import type { Db } from "./db/client";
import { catalogCostEvents, type CostKind, type CostOutcome, type CostStage } from "./db/schema";
import type { ChannelId } from "./catalog/types";
import { cpuUpscaleOnDedicatedService } from "./catalog/cost";
import { log } from "./log";
import { isOverflowAdapter } from "./vendor/routes";

export interface CostEventInput {
  /** M6-S1: null for a row of no batch (a job run, the sweep); then brandSlug is null too. */
  batchId: string | null;
  brandSlug: string | null;
  isTest: boolean;
  productId?: string | null;
  sourceImageId?: string | null;
  outputId?: string | null;
  channel?: ChannelId | null;
  stage: CostStage;
  kind: CostKind;
  /** `cpu`, `gpu`, `worker` or a model id. Never shown to an operator. */
  engine: string;
  ms?: number;
  promptTokens?: number;
  completionTokens?: number;
  usd?: number;
  estimated?: boolean;
  /**
   * `cap` is written only by the judge's fetch wrapper, when a spend cap refused the next attempt in the
   * middle of a quality check (the photo is then held with `qa_cap`). The cap checks before a judging,
   * before a re-judge and before the classifier write no row: nothing was spent there.
   */
  outcome?: CostOutcome;
  chunkId?: string | null;
  attempt?: number | null;
  at?: Date;
  /** M6-S1: the Cloud Run service or job billed for this row (its `component` label); default costComponent. */
  component?: string | null;
  /** M6-S1: the M0 content version of the output, once outputs carry one. */
  contentVersionId?: string | null;
  /** M6-S1: the billable instance time this row explains (a delivery's wall time, a job's run time). */
  billableMs?: number | null;
}

/** Third-party vendors off the GCP bill, as `component` (M6-F1-R7). */
export const OPENROUTER_COMPONENT = "openrouter";

/** The Cloud Run service or job this process runs as (K_SERVICE, CLOUD_RUN_JOB), or null outside Cloud Run. */
export function ownComponent(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.K_SERVICE?.trim() || env.CLOUD_RUN_JOB?.trim() || null;
}

/**
 * M6-F1 (M6-S1): the component a row is billed to, the same name as the Cloud Run `component` label so the
 * reconciliation joins the ledger to the bill. A judge or classifier call is OpenRouter's; a cut-out call is the
 * matting service that answered (`cpu` catalog-matting, `gpu` catalog-matting-gpu; the worker's own cut-out is the
 * worker; an overflow vendor's call is that vendor's, its adapter id); an upscale call is the service upscale.ts routes it to (catalog-upscale or catalog-upscale-gpu when
 * configured, else the matting service of its target); compute, render and job rows are this process's own service
 * or job.
 */
export function costComponent(row: Pick<CostEventInput, "kind" | "engine" | "component">, env: NodeJS.ProcessEnv = process.env): string | null {
  if (row.component) return row.component;
  if (row.kind === "llm_call") return OPENROUTER_COMPONENT;
  // M3-F2-R4: an overflow vendor's call is billed by that vendor, off the GCP bill (M6-F1-R7), never to the worker.
  if (isOverflowAdapter(row.engine)) return row.engine;
  if (row.kind === "matte_call") return row.engine === "gpu" ? "catalog-matting-gpu" : row.engine === "cpu" ? "catalog-matting" : ownComponent(env);
  if (row.kind === "upscale_call") {
    if (row.engine === "cpu") return cpuUpscaleOnDedicatedService(env) ? "catalog-upscale" : "catalog-matting";
    if (row.engine === "gpu") return env.UPSCALE_GPU_URL?.trim() ? "catalog-upscale-gpu" : "catalog-matting-gpu";
  }
  return ownComponent(env);
}

/** The worker's `deps.log` shape (a `severity` field picks the severity); the default is the shared log helper. */
export type CostEventLog = (message: string, fields?: Record<string, unknown>) => void;
export const COST_EVENT_WRITE_FAILED = "cost event write failed";
const defaultLog: CostEventLog = (message, fields) => log("ERROR", message, fields);

const whole = (value: number | undefined | null) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const money = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The insert values for one event; non-finite or negative numbers become 0 so a row never fails on them. */
export function costEventValues(row: CostEventInput, env: NodeJS.ProcessEnv = process.env): typeof catalogCostEvents.$inferInsert {
  return {
    batchId: row.batchId,
    brandSlug: row.batchId ? row.brandSlug : null,
    isTest: row.isTest,
    productId: row.productId ?? null,
    sourceImageId: row.sourceImageId ?? null,
    outputId: row.outputId ?? null,
    channel: row.channel ?? null,
    stage: row.stage,
    kind: row.kind,
    engine: row.engine,
    ms: whole(row.ms),
    promptTokens: whole(row.promptTokens),
    completionTokens: whole(row.completionTokens),
    usd: money(row.usd),
    estimated: row.estimated ?? false,
    outcome: row.outcome ?? "ok",
    chunkId: row.chunkId ?? null,
    attempt: row.attempt ?? null,
    component: costComponent(row, env),
    contentVersionId: row.contentVersionId ?? null,
    billableMs: row.billableMs === undefined || row.billableMs === null ? null : whole(row.billableMs),
    ...(row.at ? { at: row.at } : {}),
  };
}

/**
 * Inserts the rows inside a savepoint on `db`. Returns true when they were written. On any failure the
 * savepoint is rolled back, "cost event write failed" is logged at ERROR with the batch id, and the
 * caller's transaction carries on as if nothing had been written.
 */
export async function recordCostEvents(db: Db, rows: readonly CostEventInput[], log: CostEventLog = defaultLog): Promise<boolean> {
  if (!rows.length) return true;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(catalogCostEvents).values(rows.map((row) => costEventValues(row)));
    });
    return true;
  } catch (error) {
    log(COST_EVENT_WRITE_FAILED, {
      severity: "ERROR",
      batchId: rows[0]!.batchId ?? null,
      component: rows[0] ? costComponent(rows[0]) : null,
      rows: rows.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** One row; see recordCostEvents. */
export function recordCostEvent(db: Db, row: CostEventInput, log?: CostEventLog): Promise<boolean> {
  return recordCostEvents(db, [row], log);
}
