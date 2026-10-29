import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches } from "../db/schema";
import type { enqueueTask } from "../tasks";

/** How long a queued finalize counts as on its way; after it the sweep may send the request again. */
export const FINALIZE_ENQUEUE_LEASE_MS = 120_000;
export function finalizeEnqueueExpired(now:number) {
  return sql`CASE WHEN coalesce(${catalogBatches.counts}->>'finalizeEnqueuedAt','') ~ '^[0-9]+$' THEN (${catalogBatches.counts}->>'finalizeEnqueuedAt')::numeric <= ${now-FINALIZE_ENQUEUE_LEASE_MS} ELSE true END`;
}
export interface FinalizeRequestDeps { db: Db; enqueue: typeof enqueueTask; now?: () => Date }
/**
 * Asks for one finalize (spec 18 H4). A request is the stored `counts.finalizePending` flag, never a task body
 * field: the task carries only `{batchId}` and finalize decides from the flag. Never for a failed batch; for a
 * done batch only with `reopen` (a change after done: an operator decision, Add SKU ids, a changed late delivery)
 * or when a request is already pending (a lost task re-sent). While a request is pending and its enqueue is
 * recent, nothing more is queued. The worker and the web's Add SKU ids route both ask through here.
 */
export async function enqueueFinalize(deps: FinalizeRequestDeps, batchId:string, delaySec?:number, options:{reopen?:boolean}={}): Promise<void> {
  const now=+(deps.now?.() ?? new Date());
  const pending=sql`coalesce((${catalogBatches.counts}->>'finalizePending')::boolean,false)`;
  const open=options.reopen ? sql`true`:sql`(${catalogBatches.status} <> 'done' OR ${pending})`;
  // The row is read under its lock first, so a failed enqueue can put back the enqueue time it replaced.
  const claimed=await deps.db.transaction(async tx=>{
    const [row]=await tx.select({prior:sql<unknown>`${catalogBatches.counts}->'finalizeEnqueuedAt'`}).from(catalogBatches).where(and(eq(catalogBatches.id,batchId),ne(catalogBatches.status,"failed"),open,sql`(NOT ${pending} OR ${finalizeEnqueueExpired(now)})`)).for("update");
    if(!row) return null;
    await tx.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizePending',true,'finalizeEnqueuedAt',${now}::numeric)`}).where(eq(catalogBatches.id,batchId));
    return {prior:row.prior ?? null};
  });
  if (!claimed) return;
  try { await deps.enqueue("/tasks/catalog/finalize",{batchId}, delaySec ? {delaySec}:{}); }
  catch(error) {
    const ours=and(eq(catalogBatches.id,batchId),sql`${catalogBatches.counts}->>'finalizeEnqueuedAt' = ${String(now)}`);
    // A re-open keeps its request: the prior enqueue time comes back (absent or expired), so the sweep's
    // done + pending + expired clause sends it again. Any other request is dropped; its caller retries.
    const restored=claimed.prior===null ? sql`(${catalogBatches.counts} - 'finalizeEnqueuedAt')`:sql`(${catalogBatches.counts} || ${JSON.stringify({finalizeEnqueuedAt:claimed.prior})}::jsonb)`;
    await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:options.reopen ? restored:sql`jsonb_set(${catalogBatches.counts}, '{finalizePending}', 'false')`}).where(ours);
    throw error;
  }
}
