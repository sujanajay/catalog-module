import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { CHANNELS, STYLI_MIN_SOURCE_HEIGHT_PX, STYLI_SKIP_LOW_RESOLUTION } from "@catalog/core/catalog/channels";
import { batchPrefix, derivedPath, publicObjectPath, publicUrl, stagingPath } from "@catalog/core/catalog/naming";
import { planProduct, shotGeometry, UnsupportedSourceError, type Matte } from "@catalog/core/catalog/render";
import { renderKey } from "@catalog/core/catalog/pipeline/publish";
import { catalogLlmDeps, CatalogQaCapError, runQaStage } from "./qa-stage";
import { checkCatalogCaps } from "@catalog/core/catalog/qa/caps";
import { shadowSynthesisAllowed } from "@catalog/core/catalog/qa/policy";
import { flagReason } from "@catalog/core/catalog/types";
import { autoActionsOf, withAutoActions, type AutoAction } from "@catalog/core/catalog/auto-resolve";
import { BREAKER_COOLDOWN_MS, MATTING_TIMEOUT_MS } from "@catalog/core/catalog/matte";
import { detectTextImage, GUARD_PAD_FRACTION, heldInHand, resolveMatte } from "@catalog/core/catalog/matte-guard";
import { DISPATCH_DEADLINE_SEC } from "@catalog/core/tasks";
import { resolvePhoto } from "./auto-resolve";
import { recordCost } from "@catalog/core/spend";
import type { HandleOptions, HandleResult } from "../server";
import { CATALOG_TASK_LEASE_MS, enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";

/** The first wait matches the matting breaker's cool-down, so the retry reaches a half-open service. */
export const MATTE_RETRY_WAIT_MS = BREAKER_COOLDOWN_MS;
export const MATTE_RETRY_POLL_MS = 15_000;
/** Time kept back after a retry for the rest of the delivery's writes. */
export const MATTE_RETRY_MARGIN_MS = 60_000;

export async function handleChunkTask(deps: CatalogDeps, body: Record<string,unknown>, opts: HandleOptions = {}): Promise<HandleResult> {
  if (typeof body.chunkId !== "string") return {httpStatus:400,outcome:"chunkId is required"};
  let [chunk] = await deps.db.select().from(catalogChunks).where(eq(catalogChunks.id,body.chunkId));
  if (!chunk) return {httpStatus:200,outcome:"not_found"};
  const started = deps.now(), claim = randomUUID(); let mattingMs = 0, renderMs = 0;
  const ownsClaim = () => and(eq(catalogChunks.id,chunk!.id),eq(catalogChunks.taskName,claim),eq(catalogChunks.stage,chunk!.stage),eq(catalogChunks.status,"running"));
  // Ownership changes lock this same row. Keep compute/downloads outside these small write sections.
  async function underClaim<T>(write:(db:CatalogDeps["db"])=>Promise<T>):Promise<T> {
    return deps.db.transaction(async tx=>{
      const [owner]=await tx.select({id:catalogChunks.id}).from(catalogChunks).where(ownsClaim()).for("update");
      if(!owner) throw new Error("Chunk ownership changed.");
      return write(tx as unknown as CatalogDeps["db"]);
    });
  }
  let matteRetryFailed = false;
  /**
   * One retry of a model cut-out after the service failed (the photo would otherwise be held with the
   * simple method). Waits for the service's breaker cool-down, then polls its health; retries only
   * while this delivery still has time for a full matting call, and not again after a retry failed.
   */
  async function retryMatte(p:Awaited<ReturnType<CatalogDeps["prepare"]>>,model:string):Promise<{matte:Matte|null;action:AutoAction}> {
    const action=(result:AutoAction["result"],detail:string):AutoAction=>({step:"matte_retry",trigger:["fallback_matte"],result,channels:[],rejudged:false,detail});
    const deadline=+started+DISPATCH_DEADLINE_SEC*1000-MATTING_TIMEOUT_MS-MATTE_RETRY_MARGIN_MS, sleep=deps.sleep ?? (ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
    if (matteRetryFailed) return {matte:null,action:action("skipped","an earlier retry in this run failed")};
    let wait=MATTE_RETRY_WAIT_MS;
    for (;;) {
      if (+deps.now()+wait>deadline) return {matte:null,action:action("skipped","not enough time left in this run")};
      await sleep(wait); await underClaim(async()=>{});
      const health=await deps.matting.health();
      if (health.ok && health.models.some(m=>m.id===model)) break;
      wait=MATTE_RETRY_POLL_MS;
    }
    const matte=await deps.matteFor(p,deps.matting,model);
    if (matte.source==="floodfill") { matteRetryFailed=true; return {matte:null,action:action("failed","the service failed again")}; }
    return {matte,action:action("passed",matte.model)};
  }
  try {
    const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,chunk.batchId));
    if (!batch || batch.status === "failed") return {httpStatus:200,outcome:"stopped"};
    if (chunk.status === "done" || chunk.status === "failed") { await finish(); return {httpStatus:200,outcome:chunk.status}; }
    // The lease outlasts the worker/task 900-second request deadline. A killed delivery is recoverable.
    const [claimed] = await deps.db.update(catalogChunks).set({status:"running",taskName:claim,attempt:sql`${catalogChunks.attempt}+1`,startedAt:started,finishedAt:null}).where(and(eq(catalogChunks.id,chunk.id),eq(catalogChunks.stage,chunk.stage),or(eq(catalogChunks.status,"queued"),and(eq(catalogChunks.status,"running"),sql`${catalogChunks.startedAt} < ${new Date(+started-CATALOG_TASK_LEASE_MS)}::timestamptz`)))).returning();
    if (!claimed) return {httpStatus:503,outcome:"busy"};
    chunk = claimed;
    let policy = batch.options.policy;
    if (!policy) {
      const resolved = await deps.resolvePolicy(batch.brandSlug,batch.productType === "auto" ? "*":batch.productType);
      await deps.db.update(catalogBatches).set({options:sql`jsonb_set(${catalogBatches.options},'{policy}',${JSON.stringify(resolved)}::jsonb)`}).where(and(eq(catalogBatches.id,batch.id),sql`${catalogBatches.options}->'policy' IS NULL`));
      const [fresh] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,batch.id)); policy = fresh!.options.policy!;
    }
    const prefix = batchPrefix(batch.brandSlug,batch.id,batch.isTest);
    for (const productId of chunk.productIds) {
      await underClaim(async()=>{});
      const [product] = await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id,productId));
      if (!product || product.lockBatchId !== batch.id) continue;
      const allSources = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.batchId,batch.id))).orderBy(catalogSourceImages.n);
      const replaced=new Set(allSources.flatMap(source=>source.replacesId ? [source.replacesId]:[]));
      const sources=allSources.filter(source=>!replaced.has(source.id) && (!chunk!.sourceImageIds?.length || chunk!.sourceImageIds.includes(source.id)));
      // Only an operator replacement (its raw copy sits under <batch>/replacements-<upload>/) needs its own
      // derived prefix, so the matte cache never serves the replaced photo's matte for the same shot.
      // Ingest also sets replacesId on every redelivered shot of a later batch; those keep the batch prefix.
      // Staging always uses <batch>/staging/, the only layout stageCopyToPublic accepts; a replacement's
      // fresh output has no bytes yet, so it re-renders over the replaced shot's staged file.
      const replacementRoot=deps.storage.toGsUri(deps.storage.getBucketName(),`${prefix}/replacements-`);
      const derivedPrefix=(source:typeof sources[number])=>source.replacesId && source.rawUri.startsWith(replacementRoot) ? `${prefix}/replacements-${source.id}`:prefix;
      if(chunk.stage==="matte" && (!product.productType || product.productType==="auto") && sources.length) {
       let type=batch.productType, flags:typeof sources[number]["flags"]=[];
       const charts:string[]=[];
       if(type==="auto") {
        try {
         const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});if(!cap.ok) throw new CatalogQaCapError(cap.reason);
         const lowest=allSources.find(source=>!replaced.has(source.id))!;
         const llm=catalogLlmDeps(deps,batch,underClaim);
         let result=await deps.classifyProductType((await deps.storage.downloadBuffer(lowest.rawUri)).buf,llm);
         llm.assertAvailable();
         // 07 4.0a: a size chart says nothing about the product type. It is a property of that photo only
         // (never copied to the others); the next photo is classified for the type, once.
         if(result.chart) {
          charts.push(lowest.id);
          const next=allSources.find(source=>!replaced.has(source.id) && source.id!==lowest.id);
          if(next) {const again=await deps.classifyProductType((await deps.storage.downloadBuffer(next.rawUri)).buf,llm);llm.assertAvailable();if(again.chart) charts.push(next.id);else result=again;}
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
      if(chunk.stage==="qa") {await runQaStage(deps,batch,sources,productPolicy,underClaim);continue;}
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
        const live = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.isLive,true)));
        for (const source of sources) {
          for (const channel of batch.channels) {
            const key = renderKey({sourceSha256:source.sha256,channel,n:source.n,policyKey:`default|${productPolicy.matteModel}`});
            if (live.some(o=>o.channel===channel && o.n===source.n && o.renderKey===key)) continue;
            const [exists] = await deps.db.select({id:catalogOutputs.id}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.channel,channel)));
            if (exists) continue;
            const path = publicObjectPath(batch.brandSlug,product.pathKey,channel,source.n,batch.isTest), chart = source.flags.includes("chart_image"), skip = !chart && channel === "styli" && STYLI_SKIP_LOW_RESOLUTION && (source.height ?? Infinity) < STYLI_MIN_SOURCE_HEIGHT_PX;
            await underClaim(async tx=>tx.insert(catalogOutputs).values({batchId:batch.id,productId,sourceImageId:source.id,channel,n:source.n,canvasW:0,canvasH:0,scale:0,placedX:0,placedY:0,renderKey:key,objectPath:path,publicUrl:publicUrl(deps.storage.getPublicBucketName(),path),status:skip || chart ? "skipped":"pending",flags:chart ? ["chart_image"]:skip ? ["low_resolution"]:source.flags.filter(flag=>flag==="type_unknown" || flag==="transparent"),reason:chart ? flagReason("chart_image"):skip ? "Skipped for Styli: the photo is smaller than Styli needs.":null}));
          }
          const pending = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          if (!pending.length || source.matteUri) continue;
          try {
            const mattePath = derivedPath(derivedPrefix(source),product.pathKey,source.n,"matte"), gs = deps.storage.toGsUri(deps.storage.getBucketName(),mattePath), cached = await deps.storage.headObject(gs);
            if (cached.exists) { await underClaim(async tx=>tx.update(catalogSourceImages).set({matteUri:gs,status:"matted"}).where(eq(catalogSourceImages.id,source.id))); continue; }
            const raw = await deps.storage.downloadBuffer(source.rawUri);
            let conversionFailure:unknown;
            let p:Awaited<ReturnType<CatalogDeps["prepare"]>>;
            try { p = await deps.prepare(raw.buf,source.originalName,async b=>{try{return await deps.matting.convert(b);}catch(error){conversionFailure=error;throw error;}}); }
            catch(error) { throw conversionFailure ?? error; }
            // A size chart or text-only photo is not cut out: left out with its note (07 4.0a), never held.
            const text = detectTextImage(p);
            if (text.text) {
              deps.log("catalog chart left out",{batchId:batch.id,sourceImageId:source.id,glyphs:text.glyphs,lines:text.lines});
              await underClaim(async tx=>{
                await tx.update(catalogSourceImages).set({width:p.width,height:p.height,status:"prepared",flags:[...new Set([...source.flags,"chart_image" as const])]}).where(eq(catalogSourceImages.id,source.id));
                await tx.update(catalogOutputs).set({status:"skipped",flags:["chart_image"],reason:flagReason("chart_image"),updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
              });
              continue;
            }
            await underClaim(async()=>{});
            let matte = await deps.matteFor(p,deps.matting,productPolicy.matteModel); mattingMs += matte.ms;
            // 07 auto-resolve: the cut-out service was down. Retry once it responds, within this delivery's time budget, before holding.
            let retry: AutoAction | null = null;
            if (matte.source === "floodfill") {
              const retried = await retryMatte(p,productPolicy.matteModel);
              retry = retried.action; mattingMs += retried.matte?.ms ?? 0;
              if (retried.matte) matte = retried.matte;
            }
            // Cut-out integrity (matte-guard.ts): a matte that removed the product is replaced by the
            // second model, the padded frame, or the whole frame, before anything is rendered.
            const deadline=+started+DISPATCH_DEADLINE_SEC*1000-MATTING_TIMEOUT_MS-MATTE_RETRY_MARGIN_MS, firstModel=matte.model;
            const resolved = await resolveMatte({prepared:p,first:matte,handRule:product.productType!=="apparel_model" && product.productType!=="apparel_flat",attempt:async variant=>{
              const model = variant==="padded_first" ? firstModel : productPolicy.matteModelSecond;
              if (!model || (variant!=="padded_first" && model===firstModel) || +deps.now()>deadline) return null;
              if (!(await deps.matting.health()).models.some(m=>m.id===model)) return null;
              await underClaim(async()=>{});
              const next = await deps.matteFor(p,deps.matting,model,variant==="second" ? {}:{padFraction:GUARD_PAD_FRACTION});
              mattingMs += next.ms;
              return next.source==="model" ? next:null;
            }});
            if (resolved.actions.length) deps.log("catalog matte guard",{batchId:batch.id,sourceImageId:source.id,steps:resolved.actions.map(a=>`${a.step}:${a.result}`),passthrough:resolved.passthrough});
            matte = resolved.matte;
            const fallback = matte.source === "floodfill", flags = [...new Set([...source.flags,...p.flags,...(fallback ? ["fallback_matte" as const]:[]),...(resolved.passthrough ? ["matte_passthrough" as const]:[])])];
            const records = [...(retry ? [retry]:[]),...resolved.actions];
            if (records.length) await underClaim(async tx=>{for (const row of pending) await tx.update(catalogOutputs).set({compliance:withAutoActions(row.compliance,records)}).where(eq(catalogOutputs.id,row.id));});
            await underClaim(async tx=>tx.update(catalogSourceImages).set({matteModel:matte.model,matteMs:matte.ms,width:p.width,height:p.height,flags}).where(eq(catalogSourceImages.id,source.id)));
            // The retry failed too: the outputs still render with the simple cut-out so the operator sees
            // something, and carry `fallback_matte` (render marks them needs_attention; triage decides).
            if (fallback) await underClaim(async tx=>{for (const row of pending) await tx.update(catalogOutputs).set({flags:[...new Set([...row.flags,"fallback_matte" as const])],reason:flagReason("fallback_matte"),updatedAt:deps.now()}).where(and(eq(catalogOutputs.id,row.id),eq(catalogOutputs.status,"pending")));});
            const png = await sharp(matte.alpha,{raw:{width:p.width,height:p.height,channels:1}}).png().toBuffer();
            await underClaim(async()=>deps.storage.uploadBuffer(mattePath,png,"image/png"));
            await underClaim(async tx=>tx.update(catalogSourceImages).set({matteUri:gs,status:"matted"}).where(eq(catalogSourceImages.id,source.id)));
          } catch (failure) {
            if (!(failure instanceof UnsupportedSourceError)) throw failure;
            const error = "The file is corrupt and could not be decoded.";
            await underClaim(async tx=>tx.update(catalogSourceImages).set({status:"failed",error}).where(eq(catalogSourceImages.id,source.id)));
            await underClaim(async tx=>tx.update(catalogOutputs).set({status:"failed",reason:error,error,updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending"))));
          }
        }
      } else if(chunk.stage==="render") {
        const prepared: { source: typeof sources[number]; p: Awaited<ReturnType<CatalogDeps["prepare"]>>; matte: Matte }[] = [];
        const productOutputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.productId,productId),eq(catalogOutputs.status,"pending")));
        for (const source of sources) {
          const pending = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          let matteUri = source.matteUri;
          // Unchanged angles still take part in the product-wide plan (one canvas per channel, Styli's uniform scale).
          if (!pending.length && productOutputs.length) {
            const [old] = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.sha256,source.sha256),eq(catalogSourceImages.isCurrent,true)));
            matteUri ??= old?.matteUri ?? null;
          }
          if ((!pending.length && !productOutputs.length) || !matteUri) continue;
          try {
            const p = await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b));
            const alpha = await sharp((await deps.storage.downloadBuffer(matteUri)).buf).toColourspace("b-w").raw().toBuffer();
            prepared.push({source,p,matte:{alpha,width:p.width,height:p.height,model:source.matteModel ?? productPolicy.matteModel,ms:source.matteMs ?? 0,source:source.flags.includes("alpha_source") ? "alpha_source":"model",target:null,sentLongSide:null}});
          } catch(error) {
            await underClaim(async tx=>tx.update(catalogOutputs).set({status:"failed",reason:error instanceof Error ? error.message : String(error),updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending"))));
          }
        }
        const geometry = prepared.flatMap(({p,matte})=>{const shot=shotGeometry(matte.alpha,p.width,p.height,{rgb:p.rgb});return shot ? [shot]:[];});
        const productPlan = (c:keyof typeof CHANNELS) => geometry.length ? planProduct(CHANNELS[c],geometry):undefined;
        const uniformScale = productPlan("styli")?.uniformScale;
        for (const {source,p,matte} of prepared) {
          const outputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          // 05 rule 3 plus: a product held in a hand does not rest on a floor, so it gets no contact shadow.
          const shadowAllowed = shadowSynthesisAllowed(product.productType,source.flags) && !heldInHand(p,matte.alpha).held;
          for (const output of outputs) try {
            const path = stagingPath(prefix,product.pathKey,output.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path), head = await deps.storage.headObject(uri);
            if (head.exists && output.bytes !== null && head.size===output.bytes) { await underClaim(async tx=>tx.update(catalogOutputs).set({stagingUri:uri,crc32c:head.crc32c,status:output.flags.some(f=>f==="small_source" || f==="failed_compliance" || f==="fallback_matte") ? "needs_attention":"staged",updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id))); continue; }
            const renderStart = +deps.now();
            const rendered = (await deps.renderAllChannels(p,matte,[output.channel],{shotNumber:source.n,productType:product.productType ?? "other",synthesiseShadow:shadowAllowed,identifier:product.identifier,publicObjectPath:output.objectPath,canvas:productPlan(output.channel)?.canvas,...(output.channel==="styli" ? {uniformScale}:{})}))[output.channel];
            renderMs += +deps.now()-renderStart;
            const flags = [...new Set([...source.flags,...rendered.flags])], status = rendered.status==="skipped" ? "skipped":!rendered.compliance.ok || flags.includes("small_source") || flags.includes("fallback_matte") ? "needs_attention":rendered.jpeg ? "staged":"failed";
            const patch = {canvasW:rendered.plan.w,canvasH:rendered.plan.h,scale:rendered.plan.scale,placedX:rendered.plan.placedX,placedY:rendered.plan.placedY,bytes:rendered.bytes,quality:rendered.quality,flags,compliance:{...rendered.compliance,auto_actions:autoActionsOf(output.compliance)},reason:rendered.notes.join("; ") || (flags.includes("small_source") ? flagReason("small_source"):null),updatedAt:deps.now()};
            await underClaim(async tx=>tx.update(catalogOutputs).set(patch).where(eq(catalogOutputs.id,output.id)));
            if (rendered.jpeg) { const jpeg=rendered.jpeg; await underClaim(async()=>deps.storage.uploadBuffer(path,jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL})); }
            const staged = rendered.jpeg ? await deps.storage.headObject(uri):null;
            await underClaim(async tx=>tx.update(catalogOutputs).set({status,stagingUri:rendered.jpeg ? uri:null,crc32c:staged?.crc32c ?? null,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id)));
          } catch(error) { const reason = error instanceof Error ? error.message:String(error); await underClaim(async tx=>tx.update(catalogOutputs).set({status:"failed",error:reason,reason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id))); }
          // 07 auto-resolve: a channel rule we broke (placement, margins, background) is re-made before
          // anything is held: shadow off, second matte, 5% smaller fit, the winner on every channel.
          const photo = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),isNull(catalogOutputs.decision),inArray(catalogOutputs.status,["staged","needs_attention"])));
          // Once per photo: a redelivered chunk does not climb the ladder again.
          const failing = photo.filter(row=>row.flags.includes("failed_compliance") && !autoActionsOf(row.compliance).some(action=>action.trigger.includes("failed_compliance")));
          if (failing.length) try {
            await resolvePhoto(deps,{batch,product,source,policy:productPolicy,underClaim,outputs:photo,failing,trigger:["failed_compliance"],prepared:p,matte,
              shadowAllowed,statusFor:flags=>flags.includes("small_source") || flags.includes("failed_compliance") || flags.includes("fallback_matte") ? "needs_attention":"staged",
              contextFor:row=>({...(productPlan(row.channel) ? {canvas:productPlan(row.channel)!.canvas}:{}),...(row.channel==="styli" && uniformScale!==undefined ? {uniformScale}:{})})});
          } catch(error) {
            // The ladder only improves an image; the photo keeps its flags (and its decision path) when it breaks.
            if (error instanceof Error && /ownership changed/.test(error.message)) throw error;
            deps.log("catalog auto-resolve failed",{batchId:batch.id,sourceImageId:source.id,error:error instanceof Error ? error.message:String(error)});
          }
        }
      }
    }
    const changedOutputs = await deps.db.select({id:catalogOutputs.id}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),inArray(catalogOutputs.productId,chunk.productIds)));
    const wall = changedOutputs.length ? Math.max(0,(+deps.now()-+started)/1000)*2:0, usd = wall*Number(process.env.COMPUTE_USD_PER_VCPU_SECOND ?? 0);
    await underClaim(async tx=>{
    await tx.update(catalogBatches).set({cost:sql`${catalogBatches.cost} || jsonb_build_object('mattingMs',(${catalogBatches.cost}->>'mattingMs')::numeric+${mattingMs}::numeric,'renderMs',(${catalogBatches.cost}->>'renderMs')::numeric+${renderMs}::numeric,'computeVcpuSeconds',(${catalogBatches.cost}->>'computeVcpuSeconds')::numeric+${wall}::numeric,'computeUsd',(${catalogBatches.cost}->>'computeUsd')::numeric+${usd}::numeric)`}).where(eq(catalogBatches.id,batch.id));
    await recordCost(tx,{brandSlug:batch.brandSlug,batchId:batch.id,engine:"catalog_compute",costUsd:usd});
    });
    if (chunk.stage === "matte") {
      const advanced = await deps.db.update(catalogChunks).set({stage:"render",status:"queued",taskName:null,finishedAt:deps.now()}).where(ownsClaim()).returning({id:catalogChunks.id});
      if (!advanced.length) return {httpStatus:503,outcome:"claim_lost"};
      await deps.db.update(catalogBatches).set({status:"rendering"}).where(and(eq(catalogBatches.id,batch.id),eq(catalogBatches.status,"matting")));
      await deps.enqueue("/tasks/catalog/chunk",{chunkId:chunk.id},{taskId:`chunk-${chunk.id}-render`});
    } else if(chunk.stage==="render") {
      const advanced=await deps.db.update(catalogChunks).set({stage:"qa",status:"queued",taskName:null,finishedAt:deps.now()}).where(ownsClaim()).returning({id:catalogChunks.id});
      if(!advanced.length) return {httpStatus:503,outcome:"claim_lost"};
      const remaining=await deps.db.select().from(catalogChunks).where(eq(catalogChunks.batchId,batch.id));
      if(remaining.every(row=>row.stage==="qa" || row.status==="done" || row.status==="failed")) await deps.db.update(catalogBatches).set({status:"qa"}).where(eq(catalogBatches.id,batch.id));
      await deps.enqueue("/tasks/catalog/chunk",{chunkId:chunk.id},{taskId:`chunk-${chunk.id}-qa`});
    } else { const completed = await deps.db.update(catalogChunks).set({status:"done",taskName:null,finishedAt:deps.now()}).where(ownsClaim()).returning({id:catalogChunks.id}); if (!completed.length) return {httpStatus:503,outcome:"claim_lost"}; await finish(); }
    await refreshBatchProgress(deps.db,batch.id);
    return {httpStatus:200,outcome:"done"};
  } catch(error) {
    const reason = error instanceof Error ? error.message:String(error);
    deps.log("chunk failed",{chunkId:chunk.id,error:reason});
    if ((opts.retryCount ?? 0) >= 4) {
      const failed = await deps.db.update(catalogChunks).set({status:"failed",taskName:null,error:reason,finishedAt:deps.now()}).where(ownsClaim()).returning({id:catalogChunks.id});
      if (!failed.length) return {httpStatus:503,outcome:"retry"};
      if (chunk.productIds.length) await deps.db.update(catalogOutputs).set({status:"failed",reason:`Processing stopped after repeated errors: ${reason}`,updatedAt:deps.now()}).where(and(eq(catalogOutputs.batchId,chunk.batchId),inArray(catalogOutputs.productId,chunk.productIds),eq(catalogOutputs.status,"pending")));
      await finish(); return {httpStatus:200,outcome:"failed"};
    }
    await deps.db.update(catalogChunks).set({status:"queued",taskName:null}).where(ownsClaim());
    return {httpStatus:503,outcome:"retry"};
  }
  async function finish() {
    for (const productId of chunk!.productIds) await deps.enqueue("/tasks/catalog/publish",{batchId:chunk!.batchId,productId},{taskId:`publish-${chunk!.batchId}-${productId}-chunk`});
    const chunks = await deps.db.select().from(catalogChunks).where(eq(catalogChunks.batchId,chunk!.batchId));
    if (chunks.every(c=>c.status==="done" || c.status==="failed")) { await deps.db.update(catalogBatches).set({status:"publishing"}).where(and(eq(catalogBatches.id,chunk!.batchId),inArray(catalogBatches.status,["matting","rendering","qa"]))); await enqueueFinalize(deps,chunk!.batchId); }
  }
}
