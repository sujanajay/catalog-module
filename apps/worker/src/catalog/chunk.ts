import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { CHANNELS } from "@catalog/core/catalog/channels";
import { batchPrefix, derivedPath, publicObjectPath, publicUrl, stagingPath } from "@catalog/core/catalog/naming";
import { planProduct, shotGeometry, trimRules, UnsupportedSourceError, type EnlargementShot, type Matte } from "@catalog/core/catalog/render";
import { renderKey, renderKeys, rerenderedKey } from "@catalog/core/catalog/pipeline/publish";
import { catalogLlmDeps, CatalogQaCapError, limitDeliveryBackoff, runQaStage, spendCapHit } from "./qa-stage";
import { CHUNK_HEARTBEAT_MS, CHUNK_LEASE_MS, CHUNK_MAX_STALLS, CHUNK_STALLED_REASON, chunkTimeBudgetMs, isBulkBatch, leaseLapsed, notParked, redispatchUnstartedChunks, tryEnqueueChunk } from "@catalog/core/catalog/pipeline/dispatch";
import { ENLARGE_MAX_TIMEOUTS, ENLARGE_TASK_MAX_ATTEMPTS, ENLARGING_TASK, queuedEnlargementsOfChunk, unparkSettledChunks, wantedQueuedExists } from "@catalog/core/catalog/pipeline/enlargement";
import type { EnlargeTaskBody } from "@catalog/core/tasks";
import { afterUnpark, batchEnlargement, derivedPrefixFor, handleEnlargeTask, loadShotFromMatte, photosWantingEnlargement, primeReadiness, productHasQueuedEnlargement, reconcileEnlargements, type PhotoShot } from "./enlarge";
import { eachLimit, positiveIntEnv, serialLock } from "@catalog/core/concurrency";
import { EnlargementNotReadyError, isCpuUpscalerId } from "@catalog/core/catalog/upscale";
import { recordCostEvents, type CostEventInput } from "@catalog/core/cost-events";
import { matteCallUsd } from "@catalog/core/catalog/cost";
import type { CostOutcome } from "@catalog/core/db/schema";
import { checkCatalogCaps } from "@catalog/core/catalog/qa/caps";
import { shadowSynthesisAllowed } from "@catalog/core/catalog/qa/policy";
import { holdsAtRender } from "@catalog/core/catalog/qa/triage";
import { flagReason } from "@catalog/core/catalog/types";
import { autoActionsOf, busyBackgroundHold, withAutoActions, type AutoAction } from "@catalog/core/catalog/auto-resolve";
import { BUSY_BACKGROUND_DETAILS } from "@catalog/core/catalog/qa/reasons";
import { BREAKER_COOLDOWN_MS, MATTING_TIMEOUT_MS, type MattingTrace } from "@catalog/core/catalog/matte";
import { detectTextImage, GUARD_PAD_FRACTION, heldInHand, resolveMatte } from "@catalog/core/catalog/matte-guard";
import { DISPATCH_DEADLINE_SEC } from "@catalog/core/tasks";
import { resolvePhoto } from "./auto-resolve";
import { recordCost } from "@catalog/core/spend";
import type { HandleOptions, HandleResult } from "../server";
import { enqueueFinalize, photoConcurrency, refreshBatchProgress, topUpWindow, type CatalogDeps } from "./deps";

/** The first wait matches the matting breaker's cool-down, so the retry reaches a half-open service. */
export const MATTE_RETRY_WAIT_MS = BREAKER_COOLDOWN_MS;
export const MATTE_RETRY_POLL_MS = 15_000;
/** Time kept back after a retry for the rest of the delivery's writes. */
export const MATTE_RETRY_MARGIN_MS = 60_000;
/** Spec 15 E1: the QA back-off never waits into the last two minutes before the request deadline. */
export const QA_BACKOFF_DEADLINE_MARGIN_MS = 120_000;
/**
 * Spec 15 E3 threshold (the fifth real error of one task fails the chunk), counted by this code in the batch's
 * `counts.chunkErrors` (spec 17 G4). Not X-CloudTasks-TaskRetryCount: that also counts 429 and 503 attempts
 * that never reached this handler, so with unlimited queue retries one error after a 429 storm would fail a chunk.
 */
export const CHUNK_MAX_ERRORS = 5;
const OWNERSHIP_CHANGED = "Chunk ownership changed.";

/** Where a delivery's time went, for the `chunk delivery` line (spec 15 E7). */
export type DeliverySteps = Record<"download"|"prepare"|"matte"|"guard"|"render"|"upscale"|"judge"|"write",number>;

/** Spec 15 E2: renews the lease every 30 s until `renew` reports the deadline passed; returns the stop function. */
export const defaultHeartbeat = (renew:()=>Promise<boolean>) => {
  const timer = setInterval(()=>{ void renew().then(more=>{ if (!more) clearInterval(timer); }).catch(()=>{}); },CHUNK_HEARTBEAT_MS);
  timer.unref?.();
  return ()=>clearInterval(timer);
};

/**
 * Spec 16: the vCPU-seconds one second of a delivery uses, `WORKER_CPU / WORKER_CONCURRENCY` (deploy.sh passes
 * both; defaults 2 and 2, today's worker shape).
 */
export function computeVcpuPerSecond(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.WORKER_CPU, 2)/positiveIntEnv(env.WORKER_CONCURRENCY, 2);
}

/** The delivery's deps with each slow call timed into `steps` (the calls themselves are unchanged). */
function timedDeps(deps:CatalogDeps,steps:DeliverySteps):CatalogDeps {
  const timed = <A extends unknown[],R>(step:keyof DeliverySteps,fn:(...args:A)=>Promise<R>) => async (...args:A):Promise<R> => {
    const t0 = Date.now();
    try { return await fn(...args); } finally { steps[step] += Date.now()-t0; }
  };
  return {...deps,storage:{...deps.storage,downloadBuffer:timed("download",deps.storage.downloadBuffer)},prepare:timed("prepare",deps.prepare),matteFor:timed("matte",deps.matteFor),
    renderAllChannels:timed("render",deps.renderAllChannels),judgeOutput:timed("judge",deps.judgeOutput),classifyProductType:timed("judge",deps.classifyProductType)};
}

/**
 * The current task body of a chunk, for in-process callers (evals, real runs, tests) that run a chunk's stages
 * one after the other without a queue.
 */
export async function currentChunkTask(db:CatalogDeps["db"],chunkId:string):Promise<Record<string,unknown>> {
  const [row] = await db.select({stage:catalogChunks.stage,step:catalogChunks.step}).from(catalogChunks).where(eq(catalogChunks.id,chunkId));
  return row ? {chunkId,stage:row.stage,step:row.step}:{chunkId};
}
/** In-process callers deliver a chunk until it is done or failed: three stages plus any hand-offs, at most this many. */
const IN_PROCESS_DELIVERIES = 100;
async function chunkFinished(db:CatalogDeps["db"],chunkId:string):Promise<boolean> {
  const [row] = await db.select({status:catalogChunks.status}).from(catalogChunks).where(eq(catalogChunks.id,chunkId));
  return !row || row.status === "done" || row.status === "failed";
}
/**
 * Runs a chunk in process (eval, QA-check and real-run tools): one `each(deliver)` per delivery, each with the row's
 * current task. Spec 18: a chunk parked for its photos' enlargements runs their enlarge tasks here, one photo at a time,
 * each until it is done or failed (the queue's attempts, without its back-off), which unparks it.
 */
export async function deliverChunkToEnd(deps:CatalogDeps,chunkId:string,each:(deliver:()=>Promise<HandleResult>)=>Promise<void>):Promise<void> {
  for (let delivery=0; delivery<IN_PROCESS_DELIVERIES && !(await chunkFinished(deps.db,chunkId)); delivery++) {
    if (await enlargeInProcess(deps,chunkId)) continue;
    await each(async()=>handleChunkTask(deps,await currentChunkTask(deps.db,chunkId)));
  }
}
/** In process, the deliveries one enlargement row gets before the runner moves on (its counted bounds plus room for tiles). */
const IN_PROCESS_ENLARGE_DELIVERIES = ENLARGE_TASK_MAX_ATTEMPTS+ENLARGE_MAX_TIMEOUTS+32;
/** Spec 18: runs the enlarge tasks of a parked chunk's wanted queued rows in process; false when the chunk is not parked. */
async function enlargeInProcess(deps:CatalogDeps,chunkId:string):Promise<boolean> {
  const [chunk] = await deps.db.select().from(catalogChunks).where(and(eq(catalogChunks.id,chunkId),eq(catalogChunks.taskName,ENLARGING_TASK)));
  if (!chunk) return false;
  for (const row of await queuedEnlargementsOfChunk(deps.db,chunk)) {
    const body:EnlargeTaskBody = {batchId:row.batchId,productId:row.productId,enlargementId:row.id};
    for (let delivery=0; delivery<IN_PROCESS_ENLARGE_DELIVERIES; delivery++) if ((await handleEnlargeTask(deps,{...body})).httpStatus!==503) break;
  }
  // The last settle unparked it; this is the safety net (a direct enqueue is not needed: the runner delivers it).
  const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,chunk.batchId));
  const unparked = await unparkSettledChunks(deps.db,chunk.batchId,[chunkId],deps.now());
  if (batch && unparked.length) await afterUnpark(deps,batch,unparked.map(c=>({...c,direct:false})),false);
  return true;
}

/**
 * One chunk delivery (spec 15). Before any claim: a task whose stage or step is not the row's current one, or a
 * legacy task (no step) for a row from after 0004, answers 200 "stale". The claim takes a queued row or one whose
 * lease lapsed, and a heartbeat renews the lease while the delivery works. The delivery starts no new photo after
 * its time budget: it saves what it did, takes the next step and queues the rest ("handed_off").
 */
export async function handleChunkTask(rawDeps: CatalogDeps, body: Record<string,unknown>, opts: HandleOptions = {}): Promise<HandleResult> {
  if (typeof body.chunkId !== "string") return {httpStatus:400,outcome:"chunkId is required"};
  let [chunk] = await rawDeps.db.select().from(catalogChunks).where(eq(catalogChunks.id,body.chunkId));
  if (!chunk) return {httpStatus:200,outcome:"not_found"};
  const steps:DeliverySteps = {download:0,prepare:0,matte:0,guard:0,render:0,upscale:0,judge:0,write:0};
  const deps = timedDeps(rawDeps,steps);
  const started = deps.now(), claim = randomUUID(); let mattingMs = 0, renderMs = 0;
  const deadlineAt = +started+DISPATCH_DEADLINE_SEC*1000, budgetMs = deps.chunkTimeBudgetMs ?? chunkTimeBudgetMs();
  const bodyStep = typeof body.step === "number" ? body.step:undefined;
  const fromProduct = bodyStep !== undefined && typeof body.fromProduct === "number" ? body.fromProduct:0;
  // Photos finished by this delivery. The budget is honoured once one photo is done, so a delivery always moves.
  let photos = 0, lost = false;
  const budgetLeft = () => photos === 0 || +deps.now() < +started+budgetMs;
  const delivery = (outcome:string,fields:Record<string,unknown> = {}) => deps.log("chunk delivery",{batchId:chunk!.batchId,chunkId:chunk!.id,stage:chunk!.stage,step:chunk!.step,attempt:chunk!.attempt,outcome,photos,ms:+deps.now()-+started,msPerStep:steps,...fields});
  const answer = (httpStatus:number,outcome:string,logged = outcome):HandleResult => { delivery(logged); return {httpStatus,outcome}; };
  // Cost ledger rows of this delivery (observability plan, part A): collected in memory and flushed inside
  // the next existing claim write (the photo's matte update, each output's render update, the compute row),
  // so paid calls survive a delivery that throws later, while a lost claim writes nothing for that write.
  const ledger: CostEventInput[] = [];
  type LedgerRow = Omit<CostEventInput,"batchId"|"brandSlug"|"isTest"|"chunkId">;
  // Rows flushed inside the claim write now running; put back if that write rolls back, so another photo's
  // failed write does not drop this photo's paid calls (photos run in parallel, spec 16).
  let flushing: CostEventInput[] = [];
  const flush = async (tx:CatalogDeps["db"]) => { if (ledger.length) { const rows = ledger.splice(0); flushing.push(...rows); await recordCostEvents(tx,rows,deps.log); } };
  const matteRow = (productId:string,sourceImageId:string,m:Matte,attempt:number,outcome:CostOutcome):LedgerRow =>
    ({productId,sourceImageId,stage:"matte",kind:"matte_call",engine:m.target ?? "worker",ms:m.ms,...matteCallUsd(m.target,m.ms),attempt,outcome});
  const ownsClaim = () => and(eq(catalogChunks.id,chunk!.id),eq(catalogChunks.taskName,claim),eq(catalogChunks.stage,chunk!.stage),eq(catalogChunks.status,"running"));
  // Ownership changes lock this same row. Keep compute/downloads outside these small write sections.
  // Every write also renews the lease (spec 15 E2), but never past the delivery's own deadline.
  // Spec 16: photos run in parallel, but their writes take turns (they lock the same chunk row anyway), so one
  // delivery holds at most one pool connection for writes and a lost claim stops every photo's next write.
  const writeTurn = serialLock();
  function underClaim<T>(write:(db:CatalogDeps["db"])=>Promise<T>):Promise<T> {
    return writeTurn(()=>claimWrite(write));
  }
  async function claimWrite<T>(write:(db:CatalogDeps["db"])=>Promise<T>):Promise<T> {
    if (lost) throw new Error(OWNERSHIP_CHANGED);
    const t0 = Date.now();
    try {
      return await deps.db.transaction(async tx=>{
        const now = +deps.now();
        const [owner]=now < deadlineAt
          ? await tx.update(catalogChunks).set({leaseUntil:new Date(now+CHUNK_LEASE_MS)}).where(ownsClaim()).returning({id:catalogChunks.id})
          : await tx.select({id:catalogChunks.id}).from(catalogChunks).where(ownsClaim()).for("update");
        if(!owner) { lost = true; throw new Error(OWNERSHIP_CHANGED); }
        return write(tx as unknown as CatalogDeps["db"]);
      });
    } catch (err) {
      ledger.unshift(...flushing);
      throw err;
    } finally { flushing = []; steps.write += Date.now()-t0; }
  }
  /** The heartbeat's renewal: false once the deadline passed (the lease then lapses within CHUNK_LEASE_MS). */
  async function renew():Promise<boolean> {
    const now = +deps.now();
    if (lost || now >= deadlineAt) return false;
    const rows = await deps.db.update(catalogChunks).set({leaseUntil:new Date(now+CHUNK_LEASE_MS)}).where(ownsClaim()).returning({id:catalogChunks.id});
    if (!rows.length) lost = true;
    return !lost;
  }
  /** A photo finished in this stage: counted for the stall rule and the batch page (spec 15 E4, E7). */
  async function photoDone(tx:CatalogDeps["db"]):Promise<void> {
    photos += 1;
    await tx.update(catalogChunks).set({progressAt:deps.now()}).where(eq(catalogChunks.id,chunk!.id));
  }
  let matteRetryFailed = false;
  /**
   * One retry of a model cut-out after the service failed (the photo would otherwise be held with the
   * simple method). Waits for the service's breaker cool-down, then polls its health; retries only
   * while this delivery still has time for a full matting call, and not again after a retry failed.
   */
  async function retryMatte(p:Awaited<ReturnType<CatalogDeps["prepare"]>>,model:string,trace:MattingTrace):Promise<{matte:Matte|null;action:AutoAction;call?:Matte}> {
    const action=(result:AutoAction["result"],detail:string):AutoAction=>({step:"matte_retry",trigger:["fallback_matte"],result,channels:[],rejudged:false,detail});
    const deadline=deadlineAt-MATTING_TIMEOUT_MS-MATTE_RETRY_MARGIN_MS, sleep=deps.sleep ?? (ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
    if (matteRetryFailed) return {matte:null,action:action("skipped","an earlier retry in this run failed")};
    let wait=MATTE_RETRY_WAIT_MS;
    for (;;) {
      if (+deps.now()+wait>deadline) return {matte:null,action:action("skipped","not enough time left in this run")};
      await sleep(wait); await underClaim(async()=>{});
      const health=await deps.matting.health();
      if (health.ok && health.models.some(m=>m.id===model)) break;
      wait=MATTE_RETRY_POLL_MS;
    }
    const matte=await deps.matteFor(p,deps.matting,model,{},trace);
    if (matte.source==="floodfill") { matteRetryFailed=true; return {matte:null,action:action("failed","the service failed again"),call:matte}; }
    return {matte,action:action("passed",matte.model),call:matte};
  }
  const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,chunk.batchId));
  if (!batch || batch.status === "failed") return {httpStatus:200,outcome:"stopped"};
  if (chunk.status === "done" || chunk.status === "failed") { await finish(); return {httpStatus:200,outcome:chunk.status}; }
  // Spec 15 E3: only the chunk's current task may claim it. A legacy task (from before 0004, no step) may adopt
  // a row from before 0004, or one queued by old code that no window ever dispatched.
  if (bodyStep !== undefined ? body.stage !== chunk.stage || bodyStep !== chunk.step : chunk.stepKnown && chunk.dispatchedAt !== null) return answer(200,"stale");
  const legacyOnly = bodyStep === undefined ? or(eq(catalogChunks.stepKnown,false),isNull(catalogChunks.dispatchedAt)):undefined;
  // Spec 15 E2: a queued row, or a running one whose holder is dead (its lease lapsed). The stall count goes up
  // when the previous delivery of this chunk finished no photo.
  const [claimed] = await deps.db.update(catalogChunks).set({status:"running",taskName:claim,attempt:sql`${catalogChunks.attempt}+1`,startedAt:started,finishedAt:null,
    leaseUntil:new Date(+started+CHUNK_LEASE_MS),stepKnown:true,dispatchedAt:sql`coalesce(${catalogChunks.dispatchedAt},${started}::timestamptz)`,
    stalls:sql`CASE WHEN ${catalogChunks.startedAt} IS NOT NULL AND (${catalogChunks.progressAt} IS NULL OR ${catalogChunks.progressAt} < ${catalogChunks.startedAt}) THEN ${catalogChunks.stalls}+1 ELSE 0 END`})
    .where(and(eq(catalogChunks.id,chunk.id),eq(catalogChunks.stage,chunk.stage),eq(catalogChunks.step,chunk.step),legacyOnly,notParked(),or(eq(catalogChunks.status,"queued"),and(eq(catalogChunks.status,"running"),leaseLapsed(started))))).returning();
  if (!claimed) {
    const [now] = await deps.db.select().from(catalogChunks).where(eq(catalogChunks.id,chunk.id));
    if (!now || now.stage !== chunk.stage || now.step !== chunk.step) return answer(200,"stale");
    // A copy of the chunk's current task waits (503) while the holder's lease is live: it claims once the lease
    // lapses (a crashed holder), or answers stale once the holder moved the step on. The lease ends by the deadline,
    // so the wait is bounded; the retry count is not used, as it also counts 429s (spec 17 G4).
    if (now.status === "running" && bodyStep !== undefined) return answer(503,"busy");
    return answer(200,"duplicate");
  }
  chunk = claimed;
  if (chunk.stalls >= CHUNK_MAX_STALLS) {
    // Spec 15 E4: three deliveries in a row finished no photo. Fail the chunk cleanly (alert 1 counts the ERROR).
    deps.log("chunk failed",{severity:"ERROR",batchId:chunk.batchId,chunkId:chunk.id,stage:chunk.stage,attempt:chunk.attempt,stalls:chunk.stalls,error:CHUNK_STALLED_REASON});
    await failChunk(CHUNK_STALLED_REASON,CHUNK_STALLED_REASON);
    return answer(200,"failed");
  }
  const stopHeartbeat = (deps.heartbeat ?? defaultHeartbeat)(renew);
  try {
    const note = (row:LedgerRow) => { ledger.push({batchId:batch.id,brandSlug:batch.brandSlug,isTest:batch.isTest,chunkId:chunk!.id,at:deps.now(),...row}); };
    let policy = batch.options.policy;
    if (!policy) {
      const resolved = await deps.resolvePolicy(batch.brandSlug,batch.productType === "auto" ? "*":batch.productType);
      await deps.db.update(catalogBatches).set({options:sql`jsonb_set(${catalogBatches.options},'{policy}',${JSON.stringify(resolved)}::jsonb)`}).where(and(eq(catalogBatches.id,batch.id),sql`${catalogBatches.options}->'policy' IS NULL`));
      const [fresh] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,batch.id)); policy = fresh!.options.policy!;
    }
    const prefix = batchPrefix(batch.brandSlug,batch.id,batch.isTest);
    limitDeliveryBackoff(batch,deadlineAt-QA_BACKOFF_DEADLINE_MARGIN_MS,deps.now);
    // Spec 18 lifecycle: the batch's pinned route on this worker (null: started before the stage, or the rollback
    // switch is on: the plain path), and the render's stored upscalers for it.
    const be = batchEnlargement(deps,batch);
    const renderUpscalers = {upscaler:be?.x2 ?? null,upscalerX4:be?.x4 ?? null};
    // Spec 18 lifecycle 3.5 step 4 (F63): render-stage products skipped because an enlargement is still queued; the
    // chunk parks at the end of the delivery (or goes on at once when the rows settled meanwhile).
    const waitingProducts:number[] = [];
    // Spec 15 E1: the index of the product to resume at when the budget stopped this delivery (null: finished).
    let stopAt: number | null = null;
    // Spec 16: a product's photos are worked on `photoLimit` at a time. The budget is asked before each photo
    // starts (`outOfTime` then stops the rest; started photos finish); one photo's error stops new photos and is
    // rethrown once the started ones are done.
    const photoLimit = deps.photoConcurrency ?? photoConcurrency();
    let outOfTime = false;
    const eachPhoto = <T>(items:readonly T[],fn:(item:T)=>Promise<void>) => eachLimit(items,photoLimit,fn,()=>outOfTime);
    const startPhoto = () => { if (!budgetLeft()) outOfTime = true; return !outOfTime; };
    products: for (const [index,productId] of chunk.productIds.entries()) {
      if (index < fromProduct) continue;
      if (!budgetLeft()) { stopAt = index; break; }
      await underClaim(async()=>{});
      const [product] = await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id,productId));
      if (!product || product.lockBatchId !== batch.id) continue;
      // Sent to the matting service as x-catalog-batch / x-catalog-product, so its log lines carry the ids.
      const trace:MattingTrace = {batchId:batch.id,productId};
      const allSources = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.batchId,batch.id))).orderBy(catalogSourceImages.n);
      const replaced=new Set(allSources.flatMap(source=>source.replacesId ? [source.replacesId]:[]));
      const sources=allSources.filter(source=>!replaced.has(source.id) && (!chunk!.sourceImageIds?.length || chunk!.sourceImageIds.includes(source.id)));
      // Only an operator replacement (its raw copy sits under <batch>/replacements-<upload>/) needs its own
      // derived prefix, so the matte cache never serves the replaced photo's matte for the same shot.
      // Ingest also sets replacesId on every redelivered shot of a later batch; those keep the batch prefix.
      // Staging always uses <batch>/staging/, the only layout stageCopyToPublic accepts; a replacement's
      // fresh output has no bytes yet, so it re-renders over the replaced shot's staged file.
      const derivedPrefix=(source:typeof sources[number])=>derivedPrefixFor(deps.storage,prefix,source);
      // Spec 18 lifecycle 3.5: the photos whose rows this delivery owns (its own and those they replace).
      const scope=allSources.filter(source=>sources.some(own=>own.id===source.id || own.replacesId===source.id)).map(source=>source.id);
      if(chunk.stage==="matte" && (!product.productType || product.productType==="auto") && sources.length) {
       let type=batch.productType, flags:typeof sources[number]["flags"]=[];
       const charts:string[]=[];
       if(type==="auto") {
        try {
         const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});if(!cap.ok) throw spendCapHit(deps,batch.id,cap.reason);
         const lowest=allSources.find(source=>!replaced.has(source.id))!;
         // A rate-limited classifier backs off (the delivery's shared budget) and then asks the judge's second model once.
         const llmFor=(sourceImageId:string)=>({...catalogLlmDeps(deps,batch,underClaim,{stage:"classify",productId,sourceImageId,chunkId:chunk!.id}),...(policy.qaModelSecond ? {secondModel:policy.qaModelSecond}:{})});
         const llm=llmFor(lowest.id);
         let result=await deps.classifyProductType((await deps.storage.downloadBuffer(lowest.rawUri)).buf,llm);
         llm.assertAvailable();
         // 07 4.0a: a size chart says nothing about the product type. It is a property of that photo only
         // (never copied to the others); the next photo is classified for the type, once.
         if(result.chart) {
          charts.push(lowest.id);
          const next=allSources.find(source=>!replaced.has(source.id) && source.id!==lowest.id);
          if(next) {const llmNext=llmFor(next.id);const again=await deps.classifyProductType((await deps.storage.downloadBuffer(next.rawUri)).buf,llmNext);llmNext.assertAvailable();if(again.chart) charts.push(next.id);else result=again;}
         }
         type=result.type;flags=result.flags;
        } catch(error) {if(!(error instanceof CatalogQaCapError)) throw error;type="other";flags=["type_unknown"];}
       }
       const flagsFor=(source:typeof sources[number])=>[...new Set([...source.flags,...flags,...(charts.includes(source.id) ? ["chart_image" as const]:[])])];
       await underClaim(async tx=>{await tx.update(catalogProducts).set({productType:type}).where(eq(catalogProducts.id,product.id));for(const source of sources) if(flags.length || charts.includes(source.id)) await tx.update(catalogSourceImages).set({flags:flagsFor(source)}).where(eq(catalogSourceImages.id,source.id));});
       product.productType=type;for(const source of sources) source.flags=flagsFor(source);
      }
      // 08: an eval batch runs exactly its forced policy (source manual), so each run measures one matte model.
      const forced=!!batch.options.evalSet && batch.isTest && policy.source==="manual";
      let productPolicy=forced ? {...policy} : {...await deps.resolvePolicy(batch.brandSlug,product.productType ?? "other"),qaModel:policy.qaModel,qaModelSecond:policy.qaModelSecond};
      if(!forced && product.productType==="other" && sources.some(source=>source.flags.includes("transparent"))) {
       // Transparent material gets the policy's second cut-out model (a deployed one); the first becomes the ladder's second choice.
       const second=productPolicy.matteModelSecond;
       if(second && second!==productPolicy.matteModel) productPolicy={...productPolicy,matteModel:second,matteModelSecond:productPolicy.matteModel};
      }
      // Threshold, floor, mode and sampling follow the product's policy; the judge stays the batch's (4.4).
      if(chunk.stage==="qa") {
        const qa=await runQaStage(deps,batch,sources,productPolicy,underClaim,chunk.id,{shouldStop:()=>!budgetLeft(),onPhoto:photoDone,photoConcurrency:photoLimit});
        if(!qa.complete) { stopAt = index; break; }
        continue;
      }
      if(chunk.stage==="matte") {
       await underClaim(async()=>{});
       const health=await deps.matting.health();
       const selected=[productPolicy.matteModel,productPolicy.matteModelSecond].find(id=>id && health.models.some(model=>model.id===id));
       // 08: an eval run measures exactly one model; never let it silently measure the default instead.
       if(!selected && forced) throw new Error("The eval matte model is not listed by the matting services.");
       if(!selected) {if(!health.default) throw new Error("The cut-out service has not reported a default. Try again shortly.");productPolicy.matteModel=health.default;await underClaim(async tx=>tx.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || '{"policyFallback":true}'::jsonb`}).where(eq(catalogBatches.id,batch.id)));deps.log("catalog matte policy fallback",{batchId:batch.id,productId});}
       else productPolicy.matteModel=selected;
       await underClaim(async tx=>{for(const source of sources) {source.matteModel=productPolicy.matteModel;await tx.update(catalogSourceImages).set({matteModel:productPolicy.matteModel}).where(eq(catalogSourceImages.id,source.id));}});
      }
      if (chunk.stage === "matte") {
        // Spec 18: the shots cut out in this delivery, for the product's enlargement decision once all are cut out.
        const shots = new Map<string,EnlargementShot>();
        const live = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.isLive,true)));
        await eachPhoto(sources,async source=>{
          for (const channel of batch.channels) {
            const keys = renderKeys({sourceSha256:source.sha256,channel,n:source.n,policyKey:`default|${productPolicy.matteModel}`}), key = keys[0]!;
            if (live.some(o=>o.channel===channel && o.n===source.n && keys.includes(o.renderKey))) continue;
            const [exists] = await deps.db.select({id:catalogOutputs.id}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.channel,channel)));
            if (exists) continue;
            const path = publicObjectPath(batch.brandSlug,product.pathKey,channel,source.n,batch.isTest), chart = source.flags.includes("chart_image");
            await underClaim(async tx=>tx.insert(catalogOutputs).values({batchId:batch.id,productId,sourceImageId:source.id,channel,n:source.n,canvasW:0,canvasH:0,scale:0,placedX:0,placedY:0,renderKey:key,objectPath:path,publicUrl:publicUrl(deps.storage.getPublicBucketName(),path),status:chart ? "skipped":"pending",flags:chart ? ["chart_image"]:source.flags.filter(flag=>flag==="type_unknown" || flag==="transparent"),reason:chart ? flagReason("chart_image"):null}));
          }
          const pending = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          if (!pending.length || source.matteUri) return;
          // Spec 15 E1: a matted photo is saved (matteUri), so the continuation starts at this photo.
          if (!startPhoto()) return;
          try {
            const mattePath = derivedPath(derivedPrefix(source),product.pathKey,source.n,"matte"), gs = deps.storage.toGsUri(deps.storage.getBucketName(),mattePath), cached = await deps.storage.headObject(gs);
            if (cached.exists) { await underClaim(async tx=>{await tx.update(catalogSourceImages).set({matteUri:gs,status:"matted"}).where(eq(catalogSourceImages.id,source.id));await photoDone(tx);}); return; }
            const raw = await deps.storage.downloadBuffer(source.rawUri);
            let conversionFailure:unknown;
            let p:Awaited<ReturnType<CatalogDeps["prepare"]>>;
            try { p = await deps.prepare(raw.buf,source.originalName,async b=>{try{return await deps.matting.convert(b,trace);}catch(error){conversionFailure=error;throw error;}}); }
            catch(error) { throw conversionFailure ?? error; }
            // A size chart or text-only photo is not cut out: left out with its note (07 4.0a), never held.
            const text = detectTextImage(p);
            if (text.text) {
              deps.log("catalog chart left out",{batchId:batch.id,sourceImageId:source.id,glyphs:text.glyphs,lines:text.lines});
              await underClaim(async tx=>{
                await tx.update(catalogSourceImages).set({width:p.width,height:p.height,status:"prepared",flags:[...new Set([...source.flags,"chart_image" as const])]}).where(eq(catalogSourceImages.id,source.id));
                await tx.update(catalogOutputs).set({status:"skipped",flags:["chart_image"],reason:flagReason("chart_image"),updatedAt:deps.now()}).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
                await photoDone(tx);
              });
              return;
            }
            await underClaim(async()=>{});
            let matte = await deps.matteFor(p,deps.matting,productPolicy.matteModel,{},trace); mattingMs += matte.ms;
            // Ledger: the photo's n-th cut-out call in this delivery (1 first, 2 the retry, then the guard ladder).
            let matteCalls = 1;
            note(matteRow(productId,source.id,matte,matteCalls,matte.source === "floodfill" ? "fallback":"ok"));
            // 07 auto-resolve: the cut-out service was down. Retry once it responds, within this delivery's time budget, before holding.
            let retry: AutoAction | null = null;
            if (matte.source === "floodfill") {
              const retried = await retryMatte(p,productPolicy.matteModel,trace);
              retry = retried.action; mattingMs += retried.matte?.ms ?? 0;
              if (retried.call) note(matteRow(productId,source.id,retried.call,++matteCalls,retried.matte ? "ok":"failed"));
              if (retried.matte) matte = retried.matte;
            }
            // Cut-out integrity (matte-guard.ts): a matte that removed the product is replaced by the
            // second model, the padded frame, or the whole frame, before anything is rendered.
            const deadline=deadlineAt-MATTING_TIMEOUT_MS-MATTE_RETRY_MARGIN_MS, firstModel=matte.model;
            const guardStart=Date.now(), matteBefore=steps.matte;
            const resolved = await resolveMatte({prepared:p,first:matte,handRule:product.productType!=="apparel_model" && product.productType!=="apparel_flat",soleStrip:product.productType==="footwear",attempt:async variant=>{
              const model = variant==="padded_first" ? firstModel : productPolicy.matteModelSecond;
              if (!model || (variant!=="padded_first" && model===firstModel) || +deps.now()>deadline) return null;
              if (!(await deps.matting.health()).models.some(m=>m.id===model)) return null;
              await underClaim(async()=>{});
              const next = await deps.matteFor(p,deps.matting,model,variant==="second" ? {}:{padFraction:GUARD_PAD_FRACTION},trace);
              mattingMs += next.ms;
              note(matteRow(productId,source.id,next,++matteCalls,next.source==="model" ? "ok":"failed"));
              return next.source==="model" ? next:null;
            }});
            // With photos in parallel the matte total also holds other photos' calls, so this is an estimate.
            steps.guard += Math.max(0,Date.now()-guardStart-(steps.matte-matteBefore));
            if (resolved.actions.length) deps.log("catalog matte guard",{batchId:batch.id,sourceImageId:source.id,steps:resolved.actions.map(a=>`${a.step}:${a.result}`),passthrough:resolved.passthrough});
            if (resolved.soleStripRecovered) deps.log("catalog sole strip recovered",{batchId:batch.id,sourceImageId:source.id,pixels:resolved.soleStripRecovered});
            matte = resolved.matte;
            const fallback = matte.source === "floodfill", flags = [...new Set([...source.flags,...p.flags,...(fallback ? ["fallback_matte" as const]:[]),...(resolved.passthrough ? ["matte_passthrough" as const]:[]),...(resolved.busyBackground ? ["leftover_background" as const]:[])])];
            const records = [...(retry ? [retry]:[]),...resolved.actions];
            if (records.length) await underClaim(async tx=>{for (const row of pending) await tx.update(catalogOutputs).set({compliance:withAutoActions(row.compliance,records)}).where(eq(catalogOutputs.id,row.id));});
            await underClaim(async tx=>{await tx.update(catalogSourceImages).set({matteModel:matte.model,matteMs:matte.ms,width:p.width,height:p.height,flags}).where(eq(catalogSourceImages.id,source.id));await flush(tx);});
            // The retry failed too: the outputs still render with the simple cut-out so the operator sees
            // something, and carry `fallback_matte` (render marks them needs_attention; triage decides).
            if (fallback) await underClaim(async tx=>{for (const row of pending) await tx.update(catalogOutputs).set({flags:[...new Set([...row.flags,"fallback_matte" as const])],reason:flagReason("fallback_matte"),updatedAt:deps.now()}).where(and(eq(catalogOutputs.id,row.id),eq(catalogOutputs.status,"pending")));});
            if (be) shots.set(source.id,{width:p.width,height:p.height,rgb:p.rgb,alpha:matte.alpha,model:matte.model});
            const png = await sharp(matte.alpha,{raw:{width:p.width,height:p.height,channels:1}}).png().toBuffer();
            await underClaim(async()=>deps.storage.uploadBuffer(mattePath,png,"image/png"));
            await underClaim(async tx=>{await tx.update(catalogSourceImages).set({matteUri:gs,status:"matted"}).where(eq(catalogSourceImages.id,source.id));await photoDone(tx);});
          } catch (failure) {
            if (!(failure instanceof UnsupportedSourceError)) throw failure;
            const error = "The file is corrupt and could not be decoded.";
            await underClaim(async tx=>tx.update(catalogSourceImages).set({status:"failed",error}).where(eq(catalogSourceImages.id,source.id)));
            await underClaim(async tx=>{await tx.update(catalogOutputs).set({status:"failed",reason:error,error,updatedAt:deps.now()}).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));await photoDone(tx);});
          }
        });
        if (outOfTime) { stopAt = index; break products; }
        // Spec 18 lifecycle 3.5: once the product's photos are cut out, its wanted enlargements are reconciled and sent.
        if (be) await reconcileEnlargements(deps,{be,batch,product,shots:await productShots(sources,shots,productPolicy.matteModel,trace),scope,wanted:await photosWantingEnlargement(deps.db,batch.id,productId),mode:"queue",write:underClaim,chunkId:chunk.id});
      } else if(chunk.stage==="render") {
        // F63: a product with an enlargement still queued is skipped before anything is prepared; the chunk parks.
        if (be && await productHasQueuedEnlargement(deps.db,batch.id,productId,chunk.sourceImageIds)) { waitingProducts.push(index); continue; }
        // In source order (the product plan reads the shots in order), whichever photo finishes first.
        const ready: ({ source: typeof sources[number]; p: Awaited<ReturnType<CatalogDeps["prepare"]>>; matte: Matte } | undefined)[] = new Array(sources.length);
        const productOutputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.productId,productId),eq(catalogOutputs.status,"pending")));
        await eachPhoto(sources.map((source,at)=>({source,at})),async ({source,at})=>{
          const pending = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          let matteUri = source.matteUri;
          // Unchanged angles still take part in the product-wide plan (one canvas per channel, Styli's uniform scale).
          if (!pending.length && productOutputs.length) {
            const [old] = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.sha256,source.sha256),eq(catalogSourceImages.isCurrent,true)));
            matteUri ??= old?.matteUri ?? null;
          }
          if ((!pending.length && !productOutputs.length) || !matteUri) return;
          // Spec 15 E1: staged outputs are skipped and the plan is rebuilt from the stored mattes, so a stop here is safe.
          if (!startPhoto()) return;
          try {
            const {p,alpha} = await loadShotFromMatte(deps,source,matteUri,trace);
            ready[at] = {source,p,matte:{alpha,width:p.width,height:p.height,model:source.matteModel ?? productPolicy.matteModel,ms:source.matteMs ?? 0,source:source.flags.includes("alpha_source") ? "alpha_source":"model",target:null,sentLongSide:null}};
          } catch(error) {
            await underClaim(async tx=>tx.update(catalogOutputs).set({status:"failed",reason:error instanceof Error ? error.message : String(error),updatedAt:deps.now()}).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending"))));
          }
        });
        if (outOfTime) { stopAt = index; break products; }
        const prepared = ready.filter(entry=>entry!==undefined);
        if (be) {
          // Spec 18 lifecycle 3.5 and 3.3: the product's wanted identities from the pixels just prepared (a changed
          // prepare wants a new identity, F43), then the readiness of every photo; anything queued parks the chunk.
          const reconciled = await reconcileEnlargements(deps,{be,batch,product,shots:prepared.map(({source,p,matte})=>({source,p,alpha:matte.alpha,matteModel:matte.model})),scope,wanted:await photosWantingEnlargement(deps.db,batch.id,productId),mode:"queue",write:underClaim,chunkId:chunk.id});
          if (reconciled.queued || (await primeReadiness(deps,{be,batch,photos:prepared,rows:reconciled.rows,write:underClaim,chunkId:chunk.id})).queued) { waitingProducts.push(index); continue; }
        }
        const geometry = prepared.flatMap(({p,matte})=>{const shot=shotGeometry(matte.alpha,p.width,p.height,{rgb:p.rgb,...trimRules(product.productType,matte)});return shot ? [shot]:[];});
        const productPlan = (c:keyof typeof CHANNELS) => geometry.length ? planProduct(CHANNELS[c],geometry):undefined;
        const uniformScale = productPlan("styli")?.uniformScale;
        await eachPhoto(prepared,async ({source,p,matte})=>{
          const outputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          // 05 rule 3 plus: a product held in a hand does not rest on a floor, so it gets no contact shadow.
          if (outputs.length && !startPhoto()) return;
          const shadowAllowed = shadowSynthesisAllowed(product.productType,source.flags) && !heldInHand(p,matte.alpha).held;
          for (const output of outputs) try {
            const path = stagingPath(prefix,product.pathKey,output.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path), head = await deps.storage.headObject(uri);
            // Spec 18 lifecycle 3.7: an output held for its enlargement is always rendered again (readiness decides anew, F22).
            if (head.exists && output.bytes !== null && head.size===output.bytes && !output.flags.includes("enlargement_failed")) { await underClaim(async tx=>tx.update(catalogOutputs).set({stagingUri:uri,crc32c:head.crc32c,status:output.flags.some(f=>f==="failed_compliance") || holdsAtRender(output.flags) ? "needs_attention":"staged",updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id))); continue; }
            const renderStart = +deps.now();
            const rendered = (await deps.renderAllChannels(p,matte,[output.channel],{shotNumber:source.n,productType:product.productType ?? "other",synthesiseShadow:shadowAllowed,identifier:product.identifier,publicObjectPath:output.objectPath,canvas:productPlan(output.channel)?.canvas,...renderUpscalers,...(output.channel==="styli" ? {uniformScale}:{}),trace:{batchId:batch.id,productId}}))[output.channel];
            renderMs += +deps.now()-renderStart;
            // Ledger: worker time per output (ms only; the per-chunk compute row carries the money) without the
            // photo's one upscale call, which gets its own row priced at the rate of the service that made it (spec 16:
            // the CPU service when the upscaler id says so, else the GPU; an output that reused the x2 image records
            // no upscale row and no upscale time).
            const upscaleMs = rendered.upscale && !rendered.upscale.reused ? rendered.upscale.ms : 0;
            steps.upscale += upscaleMs; steps.render -= upscaleMs;
            note({productId,sourceImageId:source.id,outputId:output.id,channel:output.channel,stage:"render",kind:"render",engine:"worker",ms:Math.max(0,+deps.now()-renderStart-upscaleMs),usd:0,outcome:rendered.status==="failed" ? "failed":"ok"});
            const upscaleTarget = rendered.upscale && isCpuUpscalerId(rendered.upscale.model) ? "cpu":"gpu";
            if (upscaleMs) note({productId,sourceImageId:source.id,outputId:output.id,channel:output.channel,stage:"upscale",kind:"upscale_call",engine:upscaleTarget,ms:upscaleMs,...matteCallUsd(upscaleTarget,upscaleMs)});
            // Spec 11: the per-image upscale time, for the cost record (the call time is inside renderMs too; one call per photo,
            // so an output that reused the photo's x2 image records 0). An upscaled
            // output's render_key names the upscaler (a redelivered render whose row already says `upscaled` keeps its key, and
            // one that fell back to the plain path goes back to the plain key).
            if (rendered.upscale) deps.log("catalog upscale",{batchId:batch.id,productId,sourceImageId:source.id,channel:output.channel,n:source.n,upscaleMs:rendered.upscale.reused ? 0:rendered.upscale.ms,reused:!!rendered.upscale.reused});
            const flags = [...new Set([...source.flags,...rendered.flags])], status = rendered.status==="skipped" ? "skipped":!rendered.compliance.ok || holdsAtRender(flags) ? "needs_attention":rendered.jpeg ? "staged":"failed";
            const patch = {canvasW:rendered.plan.w,canvasH:rendered.plan.h,scale:rendered.plan.scale,placedX:rendered.plan.placedX,placedY:rendered.plan.placedY,bytes:rendered.bytes,quality:rendered.quality,flags,compliance:{...rendered.compliance,auto_actions:autoActionsOf(output.compliance)},renderKey:rerenderedKey(output,rendered.upscale?.model,()=>renderKey({sourceSha256:source.sha256,channel:output.channel,n:source.n,policyKey:`default|${productPolicy.matteModel}`})),reason:[...(busyBackgroundHold(output.compliance) ? [`${BUSY_BACKGROUND_DETAILS.why} ${BUSY_BACKGROUND_DETAILS.whatToDo}`]:[]),...rendered.notes].join("; ") || (flags.includes("small_source") ? flagReason("small_source"):null),updatedAt:deps.now()};
            await underClaim(async tx=>{await tx.update(catalogOutputs).set(patch).where(eq(catalogOutputs.id,output.id));await flush(tx);});
            if (rendered.jpeg) { const jpeg=rendered.jpeg; await underClaim(async()=>deps.storage.uploadBuffer(path,jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL})); }
            const staged = rendered.jpeg ? await deps.storage.headObject(uri):null;
            await underClaim(async tx=>tx.update(catalogOutputs).set({status,stagingUri:rendered.jpeg ? uri:null,crc32c:staged?.crc32c ?? null,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id)));
          } catch(error) { if (error instanceof EnlargementNotReadyError) throw error; const reason = error instanceof Error ? error.message:String(error); await underClaim(async tx=>{await tx.update(catalogOutputs).set({status:"failed",error:reason,reason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id));await flush(tx);}); }
          // 07 4.6a: a channel rule we broke (the Styli guide, margins, the band colour, the file size) is re-made
          // before anything is held, with the fix the measured failure asks for, on the failing channel only.
          const photo = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),isNull(catalogOutputs.decision),inArray(catalogOutputs.status,["staged","needs_attention"])));
          // Once per photo: a redelivered chunk does not repair again.
          const failing = photo.filter(row=>row.flags.includes("failed_compliance") && !autoActionsOf(row.compliance).some(action=>action.trigger.includes("failed_compliance")));
          if (failing.length) try {
            await resolvePhoto(deps,{batch,product,source,policy:productPolicy,underClaim,outputs:photo,failing,trigger:["failed_compliance"],prepared:p,matte,
              shadowAllowed,statusFor:flags=>flags.includes("failed_compliance") || holdsAtRender(flags) ? "needs_attention":"staged",
              contextFor:row=>({...(productPlan(row.channel) ? {canvas:productPlan(row.channel)!.canvas}:{}),...(row.channel==="styli" && uniformScale!==undefined ? {uniformScale}:{})})});
          } catch(error) {
            // The ladder only improves an image; the photo keeps its flags (and its decision path) when it breaks.
            if (error instanceof Error && /ownership changed/.test(error.message)) throw error;
            deps.log("catalog auto-resolve failed",{batchId:batch.id,sourceImageId:source.id,error:error instanceof Error ? error.message:String(error)});
          }
          if (outputs.length) await underClaim(photoDone);
        });
        if (outOfTime) { stopAt = index; break products; }
      }
    }
    const changedOutputs = await deps.db.select({id:catalogOutputs.id}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),inArray(catalogOutputs.productId,chunk.productIds)));
    const wall = changedOutputs.length ? Math.max(0,(+deps.now()-+started)/1000)*computeVcpuPerSecond():0, usd = wall*Number(process.env.COMPUTE_USD_PER_VCPU_SECOND ?? 0);
    await underClaim(async tx=>{
    await tx.update(catalogBatches).set({cost:sql`${catalogBatches.cost} || jsonb_build_object('mattingMs',(${catalogBatches.cost}->>'mattingMs')::numeric+${mattingMs}::numeric,'renderMs',(${catalogBatches.cost}->>'renderMs')::numeric+${renderMs}::numeric,'computeVcpuSeconds',(${catalogBatches.cost}->>'computeVcpuSeconds')::numeric+${wall}::numeric,'computeUsd',(${catalogBatches.cost}->>'computeUsd')::numeric+${usd}::numeric)`}).where(eq(catalogBatches.id,batch.id));
    await recordCost(tx,{brandSlug:batch.brandSlug,batchId:batch.id,engine:"catalog_compute",costUsd:usd});
    // Any ledger rows not yet flushed plus one compute row with the same USD as spend_days, in a savepoint:
    // a failing ledger write is logged and the delivery carries on.
    await recordCostEvents(tx,[...ledger.splice(0),{batchId:batch.id,brandSlug:batch.brandSlug,isTest:batch.isTest,chunkId:chunk!.id,stage:chunk!.stage,kind:"compute",engine:"worker",ms:+deps.now()-+started,usd,attempt:chunk!.attempt,at:deps.now()}],deps.log);
    });
    const release = {status:"queued" as const,taskName:null,leaseUntil:null,step:sql`${catalogChunks.step}+1`,dispatchedAt:deps.now()};
    let outcome = "done";
    if (stopAt !== null) {
      // Spec 15 E1: the budget stopped the loop. Release the chunk at the next step and queue the rest (from the first
      // product skipped for its enlargement, so it is rendered once ready).
      const [handed] = await deps.db.update(catalogChunks).set(release).where(ownsClaim()).returning();
      if (!handed) return answer(200,"lost");
      await dispatchNext(handed,{fromProduct:Math.min(stopAt,...waitingProducts)});
      outcome = "handed_off";
    } else if (chunk.stage === "render" && waitingProducts.length) {
      // Spec 18 lifecycle 3.8: products wait for their enlargements. The chunk parks at the render stage (no task, no
      // window slot; dispatched_at set so an older dispatch never sends it) under its own lock, the lock every settle
      // takes first; when the rows settled meanwhile it goes on at once with the next step.
      const [moved] = await deps.db.transaction(async tx=>{
        const [mine] = await tx.select({id:catalogChunks.id}).from(catalogChunks).where(ownsClaim()).for("update");
        if (!mine) return [];
        const [waiting] = await tx.select({id:catalogChunks.id}).from(catalogChunks).where(and(eq(catalogChunks.id,chunk!.id),wantedQueuedExists()));
        return tx.update(catalogChunks).set({...release,attempt:0,progressAt:deps.now(),...(waiting ? {taskName:ENLARGING_TASK}:{})}).where(ownsClaim()).returning();
      });
      if (!moved) return answer(200,"lost");
      if (moved.taskName === ENLARGING_TASK) { outcome = "enlarging"; await resendUnstarted(); await topUpWindow(deps,batch.id); }
      else await dispatchNext(moved);
    } else if (chunk.stage === "matte" || chunk.stage === "render") {
      // The stage finished: the next one starts at a new step, with its own attempt count. Spec 18: a matte stage that
      // leaves a photo queued for its x2 image parks the chunk at the render stage (no task, no window slot) under the
      // chunk's lock, the lock every enlargement settle takes first, so the last settle always sees the park.
      const parks = chunk.stage === "matte" && !!be;
      const [advanced] = await deps.db.transaction(async tx=>{
        const [mine] = await tx.select({id:catalogChunks.id}).from(catalogChunks).where(ownsClaim()).for("update");
        if (!mine) return [];
        const [waiting] = parks ? await tx.select({id:catalogChunks.id}).from(catalogChunks).where(and(eq(catalogChunks.id,chunk!.id),wantedQueuedExists())):[];
        return tx.update(catalogChunks).set({...release,stage:chunk!.stage === "matte" ? "render":"qa",attempt:0,finishedAt:deps.now(),progressAt:deps.now(),...(waiting ? {taskName:ENLARGING_TASK}:{})}).where(ownsClaim()).returning();
      });
      if (!advanced) return answer(200,"lost");
      if (chunk.stage === "matte") await deps.db.update(catalogBatches).set({status:"rendering"}).where(and(eq(catalogBatches.id,batch.id),eq(catalogBatches.status,"matting")));
      else {
        const remaining=await deps.db.select().from(catalogChunks).where(eq(catalogChunks.batchId,batch.id));
        // Spec 18 H4: a late delivery never moves a finished (done or failed) batch back to qa.
        if(remaining.every(row=>row.stage==="qa" || row.status==="done" || row.status==="failed")) await deps.db.update(catalogBatches).set({status:"qa"}).where(and(eq(catalogBatches.id,batch.id),notInArray(catalogBatches.status,["done","failed"])));
      }
      if (advanced.taskName === ENLARGING_TASK) {
        // Its slot is free for the batch's next chunk; the enlarge task that settles its last photo queues it again.
        outcome = "enlarging";
        await resendUnstarted();
        await topUpWindow(deps,batch.id);
      } else await dispatchNext(advanced);
    } else { const completed = await deps.db.update(catalogChunks).set({status:"done",taskName:null,leaseUntil:null,finishedAt:deps.now()}).where(ownsClaim()).returning({id:catalogChunks.id}); if (!completed.length) return answer(200,"lost"); await finish(); }
    deps.log("chunk delivered",{batchId:batch.id,chunkId:chunk.id,stage:chunk.stage,attempt:chunk.attempt,durationMs:+deps.now()-+started,mattingMs,renderMs});
    await refreshBatchProgress(deps.db,batch.id,deps.now());
    return answer(200,"done",outcome);
  } catch(error) {
    const reason = error instanceof Error ? error.message:String(error);
    // Another delivery holds the chunk now: this copy's work is saved photo by photo, and retrying it is pointless.
    if (lost || reason === OWNERSHIP_CHANGED) return answer(200,"lost");
    // Spec 18 lifecycle F23: an enlargement not readable yet (a storage hiccup while priming) is a dependency wait,
    // never a counted error: the chunk is released for the retry and its progress kept.
    if (error instanceof EnlargementNotReadyError && error.transient) {
      deps.log("chunk waits for an enlargement",{severity:"WARNING",batchId:chunk.batchId,chunkId:chunk.id,stage:chunk.stage,error:reason});
      await deps.db.update(catalogChunks).set({status:"queued",taskName:null,leaseUntil:null,progressAt:deps.now()}).where(ownsClaim());
      return answer(503,"retry","enlargement_not_ready");
    }
    // Terminal (the chunk is marked failed below) is ERROR, a retried attempt WARNING: the alert counts ERROR only.
    // An Error object is passed whole, so a terminal line carries its stack for Error Reporting (the line shows its message).
    // A count that cannot be saved (the database is down too) is not terminal: the failure is still logged and retried.
    const errors = await recordError().catch(()=>null);
    const terminal = errors !== null && errors >= CHUNK_MAX_ERRORS;
    deps.log("chunk failed",{severity:terminal ? "ERROR":"WARNING",batchId:chunk.batchId,chunkId:chunk.id,stage:chunk.stage,attempt:chunk.attempt,errors,retryCount:opts.retryCount ?? 0,error:error instanceof Error ? error:reason});
    if (terminal) {
      if (!(await failChunk(reason,`Processing stopped after repeated errors: ${reason}`))) return answer(200,"lost");
      return answer(200,"failed");
    }
    // The same task retries at the same step and claims the released row.
    await deps.db.update(catalogChunks).set({status:"queued",taskName:null,leaseUntil:null}).where(ownsClaim());
    return answer(503,"retry","failed");
  } finally {
    stopHeartbeat();
  }
  /**
   * Spec 18 lifecycle 3.5 step 1: every shot of the product this delivery plans with (the chunk's photos with a matte):
   * those cut out in this delivery from memory, the others prepared from their stored matte (an unchanged angle by its
   * earlier one). A shot that cannot be read is left out (the render fails it).
   */
  async function productShots(sources:(typeof catalogSourceImages.$inferSelect)[],inMemory:Map<string,EnlargementShot>,matteModel:string,trace:MattingTrace):Promise<PhotoShot[]> {
    const shots:PhotoShot[] = [];
    for (const source of sources) {
      if (source.flags.includes("chart_image")) continue;
      const kept = inMemory.get(source.id);
      if (kept) { shots.push({source,p:{width:kept.width,height:kept.height,rgb:kept.rgb} as PhotoShot["p"],alpha:kept.alpha,matteModel:kept.model}); continue; }
      let matteUri = source.matteUri;
      if (!matteUri) { const [old] = await deps.db.select({matteUri:catalogSourceImages.matteUri}).from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,source.productId),eq(catalogSourceImages.sha256,source.sha256),eq(catalogSourceImages.isCurrent,true))); matteUri = old?.matteUri ?? null; }
      if (!matteUri) continue;
      try {
        const {p,alpha} = await loadShotFromMatte(deps,source,matteUri,trace);
        shots.push({source,p,alpha,matteModel:source.matteModel ?? matteModel});
      } catch (error) { deps.log("catalog enlargement decision skipped a shot",{severity:"WARNING",batchId:chunk!.batchId,sourceImageId:source.id,error:error instanceof Error ? error.message:String(error)}); }
    }
    return shots;
  }
  /**
   * Queues the chunk's new step; a failed enqueue is left to the sweep (the lost-task rule, 30 minutes). Spec 17 G4:
   * then re-sends any step of the batch whose task never started, so a dropped task waits minutes, not 30.
   */
  async function dispatchNext(next:NonNullable<typeof chunk>,extra:Record<string,unknown> = {}) {
    await tryEnqueueChunk(deps.enqueue,next,deps.log,extra,bulk());
    await resendUnstarted();
  }
  /** Spec 17 G4: this delivery's own work is saved, so a failure here is logged and never fails the delivery. */
  async function resendUnstarted() {
    try { await redispatchUnstartedChunks(deps.db,deps.enqueue,chunk!.batchId,{now:deps.now(),log:deps.log}); }
    catch (error) { deps.log("chunk redispatch failed",{severity:"WARNING",batchId:chunk!.batchId,error:error instanceof Error ? error.message:String(error)}); }
  }
  /** Counts this real error against the chunk's current task (stage, step) in one atomic write; returns the count. */
  async function recordError():Promise<number> {
    const {id,stage,step} = chunk!, entry = sql`${catalogBatches.counts}->'chunkErrors'->${id}::text`;
    const errors = sql`CASE WHEN ${entry}->>'stage' = ${stage}::text AND (${entry}->>'step')::int = ${step}::int THEN (${entry}->>'errors')::int + 1 ELSE 1 END`;
    const [row] = await deps.db.update(catalogBatches)
      .set({counts:sql`${catalogBatches.counts} || jsonb_build_object('chunkErrors',coalesce(${catalogBatches.counts}->'chunkErrors','{}'::jsonb) || jsonb_build_object(${id}::text,jsonb_build_object('stage',${stage}::text,'step',${step}::int,'errors',${errors})))`})
      .where(eq(catalogBatches.id,chunk!.batchId)).returning({errors:sql<number>`(${entry}->>'errors')::int`});
    return row?.errors ?? 1;
  }
  /** Spec 16: a bulk batch's chunk and publish tasks go to the bulk queue (when one is configured). */
  function bulk():boolean { return !!batch && isBulkBatch(batch); }
  /** Terminal: the chunk fails, its pending outputs fail with `outputReason`, the batch moves on. False when not the owner. */
  async function failChunk(error:string,outputReason:string):Promise<boolean> {
    const failed = await deps.db.update(catalogChunks).set({status:"failed",taskName:null,leaseUntil:null,error,finishedAt:deps.now()}).where(ownsClaim()).returning({id:catalogChunks.id});
    if (!failed.length) return false;
    if (chunk!.productIds.length) await deps.db.update(catalogOutputs).set({status:"failed",reason:outputReason,updatedAt:deps.now()}).where(and(eq(catalogOutputs.batchId,chunk!.batchId),inArray(catalogOutputs.productId,chunk!.productIds),eq(catalogOutputs.status,"pending")));
    await finish();
    return true;
  }
  async function finish() {
    // Spec 18 lifecycle F39: one publish per chunk (a Try again or replacement chunk of the same product publishes again).
    for (const productId of chunk!.productIds) await deps.enqueue("/tasks/catalog/publish",{batchId:chunk!.batchId,productId},{taskId:`publish-${chunk!.batchId}-${productId}-chunk-${chunk!.id}`,...(bulk() ? {bulk:true}:{})});
    const chunks = await deps.db.select().from(catalogChunks).where(eq(catalogChunks.batchId,chunk!.batchId));
    if (chunks.every(c=>c.status==="done" || c.status==="failed")) { await deps.db.update(catalogBatches).set({status:"publishing"}).where(and(eq(catalogBatches.id,chunk!.batchId),inArray(catalogBatches.status,["matting","rendering","qa"]))); await enqueueFinalize(deps,chunk!.batchId); }
    // Spec 15 E5: a finished chunk frees a slot in the batch's window. Spec 17 G4: a dropped task is re-sent first.
    else {
      await resendUnstarted();
      await topUpWindow(deps,chunk!.batchId);
    }
  }
}
