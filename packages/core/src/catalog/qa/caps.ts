import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches } from "../../db/schema";
import { dailyCapFromEnv, sumSpendForBatch, sumSpendForDay, utcDay, type CapCheck } from "../../spend";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The per-batch QA cap from `options.qaCapUsd`. Null, empty, invalid or negative means no cap. */
export function batchQaCap(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 07 4.5: refuses the next QA call once the UTC day's spend over all engines and brands reaches
 * DAILY_SPEND_CAP_USD (default 10), or once this batch's `catalog_qa` spend reaches its
 * `catalog_batches.options.qaCapUsd` (null = no per-batch cap).
 */
export async function checkCatalogCaps(db: Db, input: { batchId: string; env?: NodeJS.ProcessEnv; now?: Date }): Promise<CapCheck> {
  const [batch] = await db.select({ name: catalogBatches.name, options: catalogBatches.options }).from(catalogBatches).where(eq(catalogBatches.id, input.batchId));
  if (!batch) throw new Error("Batch not found.");
  const daily = dailyCapFromEnv(input.env ?? process.env);
  const today = await sumSpendForDay(db, utcDay(input.now ?? new Date()));
  if (today >= daily) return { ok: false, reason: `Daily spend cap reached: ${usd(today)} of ${usd(daily)} used this UTC day. Raise the daily spending limit or wait for it to reset at midnight UTC.` };
  const cap = batchQaCap((batch.options as { qaCapUsd?: unknown }).qaCapUsd);
  if (cap !== null) {
    const spent = await sumSpendForBatch(db, input.batchId, "catalog_qa");
    if (spent >= cap) return { ok: false, reason: `Batch QA spend cap reached: ${usd(spent)} of ${usd(cap)} used by batch "${batch.name}". Raise the batch's QA cap to check the remaining images.` };
  }
  return { ok: true };
}
