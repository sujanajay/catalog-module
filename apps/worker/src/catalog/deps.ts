import { and, count, eq, isNotNull, max, or, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogSourceImages } from "@catalog/core/db/schema";
import { ensureDefaultPolicies, resolvePolicy } from "@catalog/core/catalog/qa/policy";
import { judgeOutput } from "@catalog/core/catalog/qa/judge";
import { classifyProductType } from "@catalog/core/catalog/qa/classify";
import type { RepairOwnDefects } from "@catalog/core/catalog/qa/triage";
import { repairOwnDefects, type QaRepairContext } from "./qa-stage";
import type { ProductType } from "@catalog/core/catalog/types";
import { MattingClient, mattingClientFromEnv, matteFor } from "@catalog/core/catalog/matte";
import { prepare, renderAllChannels } from "@catalog/core/catalog/render";
import { createUpscaler, upscaleConfigFromEnv } from "@catalog/core/catalog/upscale";
import type { ResolvedPolicy } from "@catalog/core/catalog/types";
import * as storage from "@catalog/core/storage";
import { DISPATCH_DEADLINE_SEC, enqueueTask } from "@catalog/core/tasks";
import { log as structuredLog, toSeverity } from "@catalog/core/log";
import { positiveIntEnv } from "@catalog/core/concurrency";
/** One structured JSON line (core/log.ts): a `severity` field picks the severity, INFO when absent. */
export function catalogLog(message: string, fields: Record<string,unknown> = {}): void {
  structuredLog(toSeverity(fields?.severity) ?? "INFO", message, fields);
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
  /**
   * Spec 15 E2: starts the lease heartbeat of a running delivery and returns its stop. `renew` resolves false once
   * the delivery is past its deadline (stop renewing). Absent: a timer every CHUNK_HEARTBEAT_MS. Tests drive it.
   */
  heartbeat?: (renew: () => Promise<boolean>) => () => void;
  /** Spec 15 E1: the delivery's time budget; absent reads CATALOG_CHUNK_TIME_BUDGET_MS (default 480 s). */
  chunkTimeBudgetMs?: number;
  /** Spec 15 E5: the per-batch window for every batch; absent uses the batch class's (spec 16: operator or bulk). */
  chunkWindow?: number;
  /** Spec 16: photos worked on at once inside one delivery; absent reads CATALOG_PHOTO_CONCURRENCY (default 1). */
  photoConcurrency?: number;
}
/** Spec 16: `CATALOG_PHOTO_CONCURRENCY`, the photos one chunk delivery works on at once (default 1, today). */
export function photoConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.CATALOG_PHOTO_CONCURRENCY, 1);
}
let sharedMatting: MattingClient | undefined;
// Default rows are check-then-insert; once per process is enough.
let defaultsEnsured = false;
export function workerCatalogDeps(db: Db): CatalogDeps {
  // Spec 16: the CPU service, every GPU service of MATTING_GPU_URLS (or MATTING_GPU_URL) and UPSCALE_URL.
  sharedMatting ??= mattingClientFromEnv(process.env);
  const matting = sharedMatting;
  // Spec 11: UPSCALE_MODEL (unset: off) and UPSCALE_MIN_SCALE (default 1.5) reach every render of the worker, the
  // auto-resolve ladder included; the upscaler uses the service UPSCALE_URL names (spec 16; unset: the GPU service)
  // through the same client and its breakers.
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
/** Spec 15 E7: the newest samples of the images made that the batch page's measured time is read from. */
export const PROCESSING_RATE_SAMPLES = 5;
export async function refreshBatchProgress(db:Db,batchId:string,now:Date=new Date()):Promise<void> {
  const groups=await db.select({status:catalogOutputs.status,n:count()}).from(catalogOutputs).where(eq(catalogOutputs.batchId,batchId)).groupBy(catalogOutputs.status);
  const [held]=await db.select({n:count()}).from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId,batchId),eq(catalogBatchProducts.change,"pending_attention")));
  // Spec 15 E7: photos prepared (cut out, failed, or left out as a size chart) and the last finished photo. A photo
  // the cut-out step skips (an unchanged shot of a re-upload has no pending output) counts once its chunk has left
  // the cut-out step, so the count reaches the total.
  const [prepared]=await db.select({n:count()}).from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId,batchId),or(isNotNull(catalogSourceImages.matteUri),eq(catalogSourceImages.status,"failed"),sql`${catalogSourceImages.flags} @> '["chart_image"]'::jsonb`,
    sql`EXISTS (SELECT 1 FROM ${catalogChunks} c WHERE c.batch_id = ${catalogSourceImages.batchId} AND c.product_ids @> jsonb_build_array(${catalogSourceImages.productId}) AND (c.source_image_ids IS NULL OR jsonb_array_length(c.source_image_ids) = 0 OR c.source_image_ids @> jsonb_build_array(${catalogSourceImages.id})) AND (c.stage <> 'matte' OR c.status IN ('done','failed')))`)));
  const [last]=await db.select({at:max(catalogChunks.progressAt)}).from(catalogChunks).where(eq(catalogChunks.batchId,batchId));
  const total=(status:string)=>groups.find(g=>g.status===status)?.n ?? 0;
  const patch={verified:total("verified"),needsAttention:total("needs_attention"),failed:total("failed"),skipped:total("skipped"),staged:total("staged"),attentionProducts:held?.n ?? 0,prepared:prepared?.n ?? 0,progressAt:last?.at ? new Date(last.at).toISOString():null};
  const made=patch.verified+patch.needsAttention+patch.failed+patch.skipped+patch.staged;
  // The samples are read and written under the row lock, so two deliveries ending together both count.
  await db.transaction(async tx=>{
    const [row]=await tx.select({counts:catalogBatches.counts}).from(catalogBatches).where(and(eq(catalogBatches.id,batchId),sql`${catalogBatches.status} <> 'done'`)).for("update");
    if(!row) return;
    const samples=row.counts.processingRate ?? [];
    const processingRate=samples.at(-1)?.made===made ? samples:[...samples,{at:now.toISOString(),made}].slice(-PROCESSING_RATE_SAMPLES);
    await tx.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || ${JSON.stringify({...patch,processingRate})}::jsonb`}).where(eq(catalogBatches.id,batchId));
  });
}
