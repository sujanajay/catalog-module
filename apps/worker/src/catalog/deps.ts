import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs } from "@catalog/core/db/schema";
import { ensureDefaultPolicies, resolvePolicy } from "@catalog/core/catalog/qa/policy";
import { judgeOutput } from "@catalog/core/catalog/qa/judge";
import { classifyProductType } from "@catalog/core/catalog/qa/classify";
import type { ProductType } from "@catalog/core/catalog/types";
import { MattingClient, matteFor } from "@catalog/core/catalog/matte";
import { prepare, renderAllChannels } from "@catalog/core/catalog/render";
import type { ResolvedPolicy } from "@catalog/core/catalog/types";
import * as storage from "@catalog/core/storage";
import { DISPATCH_DEADLINE_SEC, enqueueTask } from "@catalog/core/tasks";
export interface CatalogDeps {
  db: Db; storage: typeof storage; matting: MattingClient; enqueue: typeof enqueueTask;
  fetch: typeof fetch; now: () => Date; log: (message: string, fields?: Record<string,unknown>) => void;
  resolvePolicy: (brandSlug:string,category:string) => Promise<ResolvedPolicy>;
  judgeOutput: typeof judgeOutput; classifyProductType: typeof classifyProductType;
  prepare: typeof prepare; matteFor: typeof matteFor; renderAllChannels: typeof renderAllChannels;
}
let sharedMatting: MattingClient | undefined;
export function workerCatalogDeps(db: Db): CatalogDeps {
  sharedMatting ??= new MattingClient({services:[{baseUrl:process.env.MATTING_URL ?? "http://localhost:8081",target:"cpu"},...(process.env.MATTING_GPU_URL ? [{baseUrl:process.env.MATTING_GPU_URL,target:"gpu" as const}]:[])]});
  const matting = sharedMatting;
  return {db,storage,matting,enqueue:enqueueTask,fetch,now:()=>new Date(),log:(message,fields)=>console.info(JSON.stringify({message,...fields})),prepare,matteFor,renderAllChannels,judgeOutput,classifyProductType,
    resolvePolicy:async(brandSlug,category)=> {
      const health = await matting.health();
      if (!health.default) throw new Error("The cut-out service has not reported a default. Try again shortly.");
      await ensureDefaultPolicies(db,health);
      const policy=await resolvePolicy(db,brandSlug,category as ProductType | "*");
      return policy;
    }};
}
// Keep execution ownership through the Cloud Tasks deadline, plus a short termination grace.
export const CATALOG_TASK_LEASE_MS=(DISPATCH_DEADLINE_SEC+60)*1000;
export const FINALIZE_ENQUEUE_LEASE_MS = 120_000;
export function finalizeEnqueueExpired(now:number) {
  return sql`CASE WHEN coalesce(${catalogBatches.counts}->>'finalizeEnqueuedAt','') ~ '^[0-9]+$' THEN (${catalogBatches.counts}->>'finalizeEnqueuedAt')::numeric <= ${now-FINALIZE_ENQUEUE_LEASE_MS} ELSE true END`;
}
export async function enqueueFinalize(deps: Pick<CatalogDeps,"db"|"enqueue"> & Partial<Pick<CatalogDeps,"now">>, batchId:string, delaySec?:number): Promise<void> {
  const now=+(deps.now?.() ?? new Date());
  const rows = await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizePending',true,'finalizeEnqueuedAt',${now}::numeric)`}).where(and(eq(catalogBatches.id,batchId),sql`(NOT coalesce((${catalogBatches.counts}->>'finalizePending')::boolean,false) OR ${finalizeEnqueueExpired(now)})`)).returning({id:catalogBatches.id});
  if (!rows.length) return;
  try { await deps.enqueue("/tasks/catalog/finalize",{batchId}, delaySec ? {delaySec}:{}); }
  catch(error) { await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`jsonb_set(${catalogBatches.counts}, '{finalizePending}', 'false')`}).where(and(eq(catalogBatches.id,batchId),sql`${catalogBatches.counts}->>'finalizeEnqueuedAt' = ${String(now)}`)); throw error; }
}
export async function refreshBatchProgress(db:Db,batchId:string):Promise<void> {
  const groups=await db.select({status:catalogOutputs.status,n:count()}).from(catalogOutputs).where(eq(catalogOutputs.batchId,batchId)).groupBy(catalogOutputs.status);
  const [held]=await db.select({n:count()}).from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId,batchId),eq(catalogBatchProducts.change,"pending_attention")));
  const total=(status:string)=>groups.find(g=>g.status===status)?.n ?? 0;
  const patch={verified:total("verified"),needsAttention:total("needs_attention"),failed:total("failed"),skipped:total("skipped"),staged:total("staged"),attentionProducts:held?.n ?? 0};
  await db.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || ${JSON.stringify(patch)}::jsonb`}).where(and(eq(catalogBatches.id,batchId),sql`${catalogBatches.status} <> 'done'`));
}
