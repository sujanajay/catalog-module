import { and, count, eq, isNotNull, max, or, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogEnlargements, catalogOutputs, catalogSourceImages } from "@catalog/core/db/schema";
import { ensureDefaultPolicies, resolvePolicy } from "@catalog/core/catalog/qa/policy";
import { judgeOutput } from "@catalog/core/catalog/qa/judge";
import { classifyProductType } from "@catalog/core/catalog/qa/classify";
import type { RepairOwnDefects } from "@catalog/core/catalog/qa/triage";
import { repairOwnDefects, type QaRepairContext } from "./qa-stage";
import type { ProductType } from "@catalog/core/catalog/types";
import { MattingClient, mattingClientFromEnv, matteFor } from "@catalog/core/catalog/matte";
import { prepare, renderAllChannels } from "@catalog/core/catalog/render";
import { storedUpscaler, upscaleConfigFromEnv, upscalerId, type Upscaler } from "@catalog/core/catalog/upscale";
import { dispatchChunks } from "@catalog/core/catalog/pipeline/dispatch";
import { workerEnlargeCall, workerEnlargeProbe, type EnlargeCall, type EnlargeProbe } from "./enlarge";
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
  /** Waits between cut-out retries (07 auto-resolve) and enlargement upload tries; absent uses a timer. Tests pass an instant one. */
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
  /**
   * Spec 18: the worker's configured upscaler (UPSCALE_MODEL), the default renderAllChannels is bound to. The stages
   * render with the batch's pinned route instead (enlarge.ts batchEnlargement, from options.enlargement), passed in the
   * render context; this one serves renders outside a batch. Absent or null (UPSCALE_MODEL off): the plain path.
   */
  upscaler?: Upscaler | null;
  /** Spec 18 quality: the configured x4 upscaler (UPSCALE_MODEL_X4), beside `upscaler`. */
  upscalerX4?: Upscaler | null;
  /**
   * Spec 18: the enlarge task's one service call. Absent is the worker's rollback switch (UPSCALE_MODEL=off): no
   * enlargement stage, queued rows released, the plain path everywhere (lifecycle F34).
   */
  enlarge?: EnlargeCall;
  /** Spec 18 lifecycle 3.4: the health probe before a call and after an unexplained failure; absent answers "ok". */
  enlargeProbe?: EnlargeProbe;
  /** Spec 18 lifecycle I1: the models' export hashes (absent: UPSCALE_MODEL_VERSIONS); tests give two revisions their own. */
  exportHashes?: Readonly<Record<string, string>>;
  /** Spec 18 lifecycle tile route: how long one delivery keeps making tiles (absent: ENLARGE_TILE_BUDGET_MS). */
  enlargeTileBudgetMs?: number;
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
  // Spec 11: UPSCALE_MODEL (unset: off) and UPSCALE_MIN_SCALE (default 1.0 since spec 18 quality) reach every render of the worker, the
  // auto-resolve ladder included. Spec 18: the render never calls the upscale service. Its upscaler is the stored one
  // (the x2 images the enlarge tasks made, primed per photo), named like the service that makes them (UPSCALE_URL, spec
  // 16; unset: the GPU service), so render keys stay `u:<model>@<hash>`; the enlarge task calls that service.
  const config = upscaleConfigFromEnv();
  const upscaler = config.model ? storedUpscaler(upscalerId(config.model, matting.upscaleTarget), config.minScale) : null;
  // Spec 18 quality: the x4 model above 2.0x (UPSCALE_MODEL_X4), stored and primed like the x2 one.
  const upscalerX4 = upscaler && config.x4Model ? storedUpscaler(upscalerId(config.x4Model, matting.upscaleTarget), config.minScale) : null;
  const render: typeof renderAllChannels = upscaler ? (p,m,channels,ctx)=>renderAllChannels(p,m,channels,{upscaler,upscalerX4,...ctx}) : renderAllChannels;
  return {db,storage,matting,enqueue:enqueueTask,fetch,now:()=>new Date(),log:catalogLog,prepare,matteFor,renderAllChannels:render,judgeOutput,classifyProductType,repairOwnDefects,
    upscaler,upscalerX4,...(config.model ? {enlarge:workerEnlargeCall(),enlargeProbe:workerEnlargeProbe()}:{}),
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
// Spec 18 H4: the one finalize request lives in core, so the web's Add SKU ids route asks the same way.
export { enqueueFinalize, FINALIZE_ENQUEUE_LEASE_MS, finalizeEnqueueExpired, finalizePendingFlag } from "@catalog/core/catalog/finalize-request";
/** Tops up the batch's chunk window (dispatchChunks) with the delivery's clock, log and window override. */
export function topUpWindow(deps: Pick<CatalogDeps, "db" | "enqueue" | "now" | "log" | "chunkWindow">, batchId: string): Promise<number> {
  return dispatchChunks(deps.db, deps.enqueue, batchId, { now: deps.now(), log: deps.log, ...(deps.chunkWindow ? { window: deps.chunkWindow } : {}) });
}
/** Spec 15 E7: the newest samples of the images made that the batch page's measured time is read from. */
export const PROCESSING_RATE_SAMPLES = 5;
export async function refreshBatchProgress(db:Db,batchId:string,now:Date=new Date()):Promise<void> {
  const groups=await db.select({status:catalogOutputs.status,n:count()}).from(catalogOutputs).where(eq(catalogOutputs.batchId,batchId)).groupBy(catalogOutputs.status);
  const [held]=await db.select({n:count()}).from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId,batchId),eq(catalogBatchProducts.change,"pending_attention")));
  // Spec 15 E7: photos prepared (cut out, failed, or left out as a size chart) and the last finished photo. A photo
  // the cut-out step skips (an unchanged shot of a re-upload has no pending output) counts once its chunk has left
  // the cut-out step, so the count reaches the total. The products of chunks past that step are listed once (a
  // materialized list, so the planner hashes it even without table statistics) and joined to their photos. A
  // per-photo search over every chunk grew with photos x chunks and, run after every delivery, slowed a 2,000-product
  // batch to a crawl (spec 16 F4 scale test).
  const [prepared]=await db.select({n:count()}).from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId,batchId),or(isNotNull(catalogSourceImages.matteUri),eq(catalogSourceImages.status,"failed"),sql`${catalogSourceImages.flags} @> '["chart_image"]'::jsonb`,
    sql`${catalogSourceImages.id} IN (WITH moved AS MATERIALIZED (SELECT p.product_id::uuid AS product_id, c.source_image_ids FROM ${catalogChunks} c CROSS JOIN LATERAL jsonb_array_elements_text(c.product_ids) AS p(product_id) WHERE c.batch_id = ${batchId} AND (c.stage <> 'matte' OR c.status IN ('done','failed'))) SELECT si.id FROM moved JOIN ${catalogSourceImages} si ON si.product_id = moved.product_id WHERE si.batch_id = ${batchId} AND (moved.source_image_ids IS NULL OR jsonb_array_length(moved.source_image_ids) = 0 OR moved.source_image_ids @> jsonb_build_array(si.id)))`)));
  const [last]=await db.select({at:max(catalogChunks.progressAt)}).from(catalogChunks).where(eq(catalogChunks.batchId,batchId));
  // Spec 18 lifecycle 3.7: the batch's wanted enlargements (catalog_enlargements), those made and those failed for good.
  const [x2]=await db.select({total:sql<number>`count(*)::int`,done:sql<number>`count(*) FILTER (WHERE ${catalogEnlargements.status} = 'done')::int`,
    failed:sql<number>`count(*) FILTER (WHERE ${catalogEnlargements.status} = 'failed')::int`}).from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId,batchId),eq(catalogEnlargements.wanted,true)));
  const total=(status:string)=>groups.find(g=>g.status===status)?.n ?? 0;
  const patch={verified:total("verified"),needsAttention:total("needs_attention"),failed:total("failed"),skipped:total("skipped"),staged:total("staged"),attentionProducts:held?.n ?? 0,prepared:prepared?.n ?? 0,progressAt:last?.at ? new Date(last.at).toISOString():null,
    ...(x2?.total ? {enlargeTotal:x2.total,enlargeDone:x2.done,enlargeFailed:x2.failed}:{})};
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
