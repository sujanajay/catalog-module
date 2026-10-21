import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs } from "@catalog/core/db/schema";
import { ensureDefaultPolicies, resolvePolicy } from "@catalog/core/catalog/qa/policy";
import { judgeOutput } from "@catalog/core/catalog/qa/judge";
import { classifyProductType } from "@catalog/core/catalog/qa/classify";
import type { RepairOwnDefects } from "@catalog/core/catalog/qa/triage";
import { repairOwnDefects, type QaRepairContext } from "./qa-stage";
import type { ProductType } from "@catalog/core/catalog/types";
import { MattingClient, matteFor } from "@catalog/core/catalog/matte";
import { prepare, renderAllChannels } from "@catalog/core/catalog/render";
import { createUpscaler, upscaleConfigFromEnv } from "@catalog/core/catalog/upscale";
import type { ResolvedPolicy } from "@catalog/core/catalog/types";
import * as storage from "@catalog/core/storage";
import { DISPATCH_DEADLINE_SEC, enqueueTask } from "@catalog/core/tasks";
import { log as structuredLog, toSeverity } from "@catalog/core/log";
/** One structured JSON line (core/log.ts): a `severity` field picks the severity, INFO when absent. */
export function catalogLog(message: string, fields: Record<string,unknown> = {}): void {
  structuredLog(toSeverity(fields.severity) ?? "INFO", message, fields);
}
export interface CatalogDeps {
  db: Db; storage: typeof storage; matting: MattingClient; enqueue: typeof enqueueTask;
  fetch: typeof fetch; now: () => Date; log: (message: string, fields?: Record<string,unknown>) => void;
  resolvePolicy: (brandSlug:string,category:string) => Promise<ResolvedPolicy>;
  judgeOutput: typeof judgeOutput; classifyProductType: typeof classifyProductType;
  prepare: typeof prepare; matteFor: typeof matteFor; renderAllChannels: typeof renderAllChannels;
  /** Waits between cut-out retries (07 auto-resolve); absent uses a timer. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** The re-render-and-re-judge loop run before triage (qa/triage.ts); absent repairs nothing. */
  repairOwnDefects?: RepairOwnDefects<QaRepairContext>;
}
let sharedMatting: MattingClient | undefined;
// Default rows are check-then-insert; once per process is enough.
let defaultsEnsured = false;
export function workerCatalogDeps(db: Db): CatalogDeps {
  sharedMatting ??= new MattingClient({services:[{baseUrl:process.env.MATTING_URL ?? "http://localhost:8081",target:"cpu"},...(process.env.MATTING_GPU_URL ? [{baseUrl:process.env.MATTING_GPU_URL,target:"gpu" as const}]:[])]});
  const matting = sharedMatting;
  // Spec 11: UPSCALE_MODEL (unset: off) and UPSCALE_MIN_SCALE (default 1.5) reach every render of the worker, the
  // auto-resolve ladder included; the upscaler uses the GPU matting service through the same client and breaker.
  const upscaler = createUpscaler(matting,upscaleConfigFromEnv());
  const render: typeof renderAllChannels = upscaler ? (p,m,channels,ctx)=>renderAllChannels(p,m,channels,{upscaler,...ctx}) : renderAllChannels;
  return {db,storage,matting,enqueue:enqueueTask,fetch,now:()=>new Date(),log:catalogLog,prepare,matteFor,renderAllChannels:render,judgeOutput,classifyProductType,repairOwnDefects,
    resolvePolicy:async(brandSlug,category)=> {
      if (!defaultsEnsured) {
        const health = await matting.health();
        if (!health.default) throw new Error("The cut-out service has not reported a default. Try again shortly.");
        await ensureDefaultPolicies(db,health); defaultsEnsured = true;
      }
      const policy=await resolvePolicy(db,brandSlug,category as ProductType | "*");
      // 07 4.12: the operator's CATALOG_QA_DEFAULT_MODEL replaces the built-in first judge; measured rows win.
      return policy.source === "default" && process.env.CATALOG_QA_DEFAULT_MODEL ? {...policy,qaModel:process.env.CATALOG_QA_DEFAULT_MODEL} : policy;
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
