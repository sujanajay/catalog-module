// Spend control (spec 02, "Spend"): the optional UTC daily cap across all brands (off unless
// DAILY_SPEND_CAP_USD is set), the optional per-batch QA
// cap (catalog_batches.options.qaCapUsd, set by 07), and spend recording into spend_days.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { SPEND_ENGINES, catalogBatches, spendDays, type SpendEngine } from "./db/schema";

export { SPEND_ENGINES };
export type { SpendEngine };

/** No daily cap unless DAILY_SPEND_CAP_USD is set. */
export const DEFAULT_DAILY_SPEND_CAP_USD = Infinity;

export type CapCheck = { ok: true } | { ok: false; reason: string };

const usd = (n: number) => `$${n.toFixed(2)}`;

/** `YYYY-MM-DD` of the instant's UTC day. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** DAILY_SPEND_CAP_USD, default no cap. Empty, invalid or negative values fall back to the default. */
export function dailyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DAILY_SPEND_CAP_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_SPEND_CAP_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_SPEND_CAP_USD;
}

/** Total spend (USD) recorded for one UTC day across all brands, engines and batches. */
export async function sumSpendForDay(db: Db, day: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${spendDays.costUsd}), 0)` })
    .from(spendDays)
    .where(eq(spendDays.day, day));
  return Number(row?.total ?? 0);
}

/** Total spend (USD) of one engine for one batch, across all days. */
export async function sumSpendForBatch(db: Db, batchId: string, engine: SpendEngine): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${spendDays.costUsd}), 0)` })
    .from(spendDays)
    .where(and(eq(spendDays.batchId, batchId), eq(spendDays.engine, engine)));
  return Number(row?.total ?? 0);
}

/**
 * Adds a cost to spend_days (upsert on day, brand, engine, batch). Non-finite or negative costs
 * are recorded as 0; `calls` defaults to 1.
 */
export async function recordCost(
  db: Db,
  input: { brandSlug: string; batchId: string; engine: SpendEngine; costUsd: number; calls?: number; day?: Date },
): Promise<void> {
  const costUsd = Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0;
  const calls = input.calls ?? 1;
  await db
    .insert(spendDays)
    .values({
      day: utcDay(input.day ?? new Date()),
      brandSlug: input.brandSlug,
      engine: input.engine,
      batchId: input.batchId,
      costUsd,
      calls,
    })
    .onConflictDoUpdate({
      target: [spendDays.day, spendDays.brandSlug, spendDays.engine, spendDays.batchId],
      set: {
        costUsd: sql`${spendDays.costUsd} + excluded.cost_usd`,
        calls: sql`${spendDays.calls} + excluded.calls`,
      },
    });
}

/**
 * Refuses new work once the UTC day's total across all brands has reached the daily cap, or once
 * the batch's `catalog_qa` total has reached its `options.qaCapUsd` (when set).
 */
export async function checkCaps(
  db: Db,
  input: { brandSlug: string; batchId: string; env?: NodeJS.ProcessEnv; now?: Date },
): Promise<CapCheck> {
  const cap = dailyCapFromEnv(input.env ?? process.env);
  const today = await sumSpendForDay(db, utcDay(input.now ?? new Date()));
  if (today >= cap) {
    return {
      ok: false,
      reason:
        `Daily spend cap reached: ${usd(today)} of ${usd(cap)} used this UTC day. ` +
        `Raise DAILY_SPEND_CAP_USD or wait for the cap to reset at midnight UTC.`,
    };
  }

  const [batch] = await db
    .select({ name: catalogBatches.name, options: catalogBatches.options })
    .from(catalogBatches)
    .where(eq(catalogBatches.id, input.batchId));
  const batchCap = batch?.options?.qaCapUsd;
  if (batch && typeof batchCap === "number" && Number.isFinite(batchCap)) {
    const spent = await sumSpendForBatch(db, input.batchId, "catalog_qa");
    if (spent >= batchCap) {
      return {
        ok: false,
        reason:
          `Batch QA spend cap reached: ${usd(spent)} of ${usd(batchCap)} used by batch "${batch.name}". ` +
          `Raise the batch's QA cap to check the remaining images.`,
      };
    }
  }
  return { ok: true };
}
