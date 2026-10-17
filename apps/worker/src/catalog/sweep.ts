// Sweeper (`/tasks/catalog/sweep`, Cloud Scheduler `catalog-sweep`): a batch that made no progress
// for SWEEP_STALE_MS is marked failed and its product locks are released. Idempotent: a second run
// finds nothing, because the swept batches are no longer in an active status.
import { sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import type { HandleResult } from "../server";

/** No progress for this long fails the batch (2 hours, from the plan). */
export const SWEEP_STALE_MS = 2 * 60 * 60 * 1000;

/** Batch statuses that mean "work in flight". */
export const SWEEPABLE_STATUSES = ["ingesting", "matting", "rendering", "qa", "publishing"] as const;

export const SWEEP_ERROR = "No progress for 2 hours. Start the batch again.";

/** Signature of `releaseLocks` in `@catalog/core/catalog/products` (spec 02 "Product identity helpers"). */
export type ReleaseLocks = (db: Db, batchId: string) => Promise<number>;

export interface SweepDeps {
  db: Db;
  releaseLocks: ReleaseLocks;
  now?: () => Date;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Fail every active batch whose newest progress (its chunks' started_at / finished_at and its own
 * updated_at) is older than SWEEP_STALE_MS, release its product locks, and log one WARNING per batch.
 * The status change and the lock release commit together.
 */
export async function handleSweep(deps: SweepDeps, _body: Record<string, unknown>): Promise<HandleResult> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - SWEEP_STALE_MS).toISOString();
  const statuses = sql.join(
    SWEEPABLE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const swept = await deps.db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE catalog_batches AS b
      SET status = 'failed', error = ${SWEEP_ERROR}, updated_at = now()
      WHERE b.status IN (${statuses})
        AND GREATEST(
          b.updated_at,
          (SELECT max(c.started_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id),
          (SELECT max(c.finished_at) FROM catalog_chunks AS c WHERE c.batch_id = b.id)
        ) < ${cutoff}::timestamptz
      RETURNING b.id
    `);
    const released: { batchId: string; releasedProducts: number }[] = [];
    for (const row of rowsOf(result)) {
      const batchId = String(row.id);
      released.push({ batchId, releasedProducts: await deps.releaseLocks(tx, batchId) });
    }
    return released;
  });

  for (const s of swept) {
    console.warn(JSON.stringify({ severity: "WARNING", message: "batch swept: no progress for 2 hours", ...s }));
  }
  return { httpStatus: 200, outcome: `swept:${swept.length}` };
}
