// Cost ledger writes (observability plan, part A). Every write runs in its own savepoint (a nested
// transaction when `db` is already one, a short transaction otherwise), so a failing insert is caught,
// logged as an ERROR line and never fails or slows the chunk, judge call or publish around it.
import type { Db } from "./db/client";
import { catalogCostEvents, type CostKind, type CostOutcome, type CostStage } from "./db/schema";
import type { ChannelId } from "./catalog/types";
import { log } from "./log";

export interface CostEventInput {
  batchId: string;
  brandSlug: string;
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
}

/** The worker's `deps.log` shape (a `severity` field picks the severity); the default is the shared log helper. */
export type CostEventLog = (message: string, fields?: Record<string, unknown>) => void;
export const COST_EVENT_WRITE_FAILED = "cost event write failed";
const defaultLog: CostEventLog = (message, fields) => log("ERROR", message, fields);

const whole = (value: number | undefined | null) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const money = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The insert values for one event; non-finite or negative numbers become 0 so a row never fails on them. */
export function costEventValues(row: CostEventInput): typeof catalogCostEvents.$inferInsert {
  return {
    batchId: row.batchId,
    brandSlug: row.brandSlug,
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
      await tx.insert(catalogCostEvents).values(rows.map(costEventValues));
    });
    return true;
  } catch (error) {
    log(COST_EVENT_WRITE_FAILED, {
      severity: "ERROR",
      batchId: rows[0]!.batchId,
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
