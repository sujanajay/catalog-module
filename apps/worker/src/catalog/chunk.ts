import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { CHANNELS, STYLI_MIN_SOURCE_HEIGHT_PX, STYLI_SKIP_LOW_RESOLUTION } from "@catalog/core/catalog/channels";
import { batchPrefix, derivedPath, publicObjectPath, publicUrl, stagingPath } from "@catalog/core/catalog/naming";
import { bbox, planProduct, UnsupportedSourceError, type Matte } from "@catalog/core/catalog/render";
import { renderKey } from "@catalog/core/catalog/pipeline/publish";
import { catalogLlmDeps, CatalogQaCapError, runQaStage } from "./qa-stage";
import { checkCatalogCaps } from "@catalog/core/catalog/qa/caps";
import { shadowSynthesisAllowed } from "@catalog/core/catalog/qa/policy";
import { flagReason } from "@catalog/core/catalog/types";
import { flagDetails } from "@catalog/core/catalog/qa/reasons";
import { recordCost } from "@catalog/core/spend";
import type { HandleOptions, HandleResult } from "../server";
import { CATALOG_TASK_LEASE_MS, enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";

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
       if(type==="auto") {
        try {
         const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});if(!cap.ok) throw new CatalogQaCapError(cap.reason);
         const lowest=allSources.find(source=>!replaced.has(source.id))!;
         const llm=catalogLlmDeps(deps,batch,underClaim);
         const result=await deps.classifyProductType((await deps.storage.downloadBuffer(lowest.rawUri)).buf,llm);
         llm.assertAvailable();
         type=result.type;flags=result.flags;
        } catch(error) {if(!(error instanceof CatalogQaCapError)) throw error;type="other";flags=["type_unknown"];}
       }
       await underClaim(async tx=>{await tx.update(catalogProducts).set({productType:type}).where(eq(catalogProducts.id,product.id));for(const source of sources) if(flags.length) await tx.update(catalogSourceImages).set({flags:[...new Set([...source.flags,...flags])]}).where(eq(catalogSourceImages.id,source.id));});
       product.productType=type;for(const source of sources) source.flags=[...new Set([...source.flags,...flags])];
      }
      // 08: an eval batch runs exactly its forced policy (source manual), so each run measures one matte model.
      const forced=!!batch.options.evalSet && batch.isTest && policy.source==="manual";
      let productPolicy=forced ? {...policy} : {...await deps.resolvePolicy(batch.brandSlug,product.productType ?? "other"),qaModel:policy.qaModel,qaModelSecond:policy.qaModelSecond};
      if(!forced && product.productType==="other" && sources.some(source=>source.flags.includes("transparent"))) productPolicy={...productPolicy,matteModel:"birefnet-hr-matting"};
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
            const path = publicObjectPath(batch.brandSlug,product.pathKey,channel,source.n,batch.isTest), skip = channel === "styli" && STYLI_SKIP_LOW_RESOLUTION && (source.height ?? Infinity) < STYLI_MIN_SOURCE_HEIGHT_PX;
            await underClaim(async tx=>tx.insert(catalogOutputs).values({batchId:batch.id,productId,sourceImageId:source.id,channel,n:source.n,canvasW:0,canvasH:0,scale:0,placedX:0,placedY:0,renderKey:key,objectPath:path,publicUrl:publicUrl(deps.storage.getPublicBucketName(),path),status:skip ? "skipped":"pending",flags:skip ? ["low_resolution"]:source.flags.filter(flag=>flag==="type_unknown" || flag==="transparent"),reason:skip ? "Skipped for Styli: the photo is smaller than Styli needs.":null}));
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
            await underClaim(async()=>{});
            const matte = await deps.matteFor(p,deps.matting,productPolicy.matteModel); mattingMs += matte.ms;
            const fallback = matte.source === "floodfill", flags = [...new Set([...source.flags,...p.flags,...(fallback ? ["fallback_matte" as const]:[])])];
            await underClaim(async tx=>tx.update(catalogSourceImages).set({matteModel:matte.model,matteMs:matte.ms,width:p.width,height:p.height,flags}).where(eq(catalogSourceImages.id,source.id)));
            if (fallback) await underClaim(async tx=>tx.update(catalogOutputs).set({status:"needs_attention",flags:["fallback_matte"],reason:flagReason("fallback_matte"),updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending"))));
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
        const uniformOutputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.productId,productId),eq(catalogOutputs.channel,"styli"),eq(catalogOutputs.status,"pending")));
        for (const source of sources) {
          const pending = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          let matteUri = source.matteUri;
          // Unchanged angles still participate in Styli's product-wide placement plan.
          if (!pending.length && uniformOutputs.length) {
            const [old] = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.sha256,source.sha256),eq(catalogSourceImages.isCurrent,true)));
            matteUri ??= old?.matteUri ?? null;
          }
          if ((!pending.length && !uniformOutputs.length) || !matteUri) continue;
          try {
            const p = await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b));
            const alpha = await sharp((await deps.storage.downloadBuffer(matteUri)).buf).toColourspace("b-w").raw().toBuffer();
            prepared.push({source,p,matte:{alpha,width:p.width,height:p.height,model:source.matteModel ?? productPolicy.matteModel,ms:source.matteMs ?? 0,source:source.flags.includes("alpha_source") ? "alpha_source":"model",target:null,sentLongSide:null}});
          } catch(error) {
            await underClaim(async tx=>tx.update(catalogOutputs).set({status:"failed",reason:error instanceof Error ? error.message : String(error),updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending"))));
          }
        }
        const uniform = prepared.map(({p,matte})=>({box:bbox(matte.alpha,p.width,p.height)!,source:{w:p.width,h:p.height}})).filter(s=>s.box);
        const uniformScale = uniform.length ? planProduct(CHANNELS.styli,uniform).uniformScale:undefined;
        for (const {source,p,matte} of prepared) {
          const outputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          for (const output of outputs) try {
            const path = stagingPath(prefix,product.pathKey,output.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path), head = await deps.storage.headObject(uri);
            if (head.exists && output.bytes !== null && head.size===output.bytes) { await underClaim(async tx=>tx.update(catalogOutputs).set({stagingUri:uri,crc32c:head.crc32c,status:output.flags.some(f=>f==="small_source" || f==="failed_compliance" || f==="complete_product") ? "needs_attention":"staged",updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id))); continue; }
            const renderStart = +deps.now();
            const rendered = (await deps.renderAllChannels(p,matte,[output.channel],{shotNumber:source.n,productType:product.productType ?? "other",synthesiseShadow:shadowSynthesisAllowed(product.productType,source.flags),identifier:product.identifier,publicObjectPath:output.objectPath,...(output.channel==="styli" ? {uniformScale}:{})}))[output.channel];
            renderMs += +deps.now()-renderStart;
            const flags = [...new Set([...source.flags,...rendered.flags])], status = rendered.status==="skipped" ? "skipped":!rendered.compliance.ok || flags.includes("small_source") || flags.includes("complete_product") ? "needs_attention":rendered.jpeg ? "staged":"failed";
            const patch = {canvasW:rendered.plan.w,canvasH:rendered.plan.h,scale:rendered.plan.scale,placedX:rendered.plan.placedX,placedY:rendered.plan.placedY,bytes:rendered.bytes,quality:rendered.quality,flags,compliance:rendered.compliance,reason:rendered.notes.join("; ") || (flags.includes("small_source") ? flagReason("small_source"):flags.includes("complete_product") ? flagDetails("complete_product",{n:source.n,k:batch.channels.length}).why:null),updatedAt:deps.now()};
            await underClaim(async tx=>tx.update(catalogOutputs).set(patch).where(eq(catalogOutputs.id,output.id)));
            if (rendered.jpeg) { const jpeg=rendered.jpeg; await underClaim(async()=>deps.storage.uploadBuffer(path,jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL})); }
            const staged = rendered.jpeg ? await deps.storage.headObject(uri):null;
            await underClaim(async tx=>tx.update(catalogOutputs).set({status,stagingUri:rendered.jpeg ? uri:null,crc32c:staged?.crc32c ?? null,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id)));
          } catch(error) { const reason = error instanceof Error ? error.message:String(error); await underClaim(async tx=>tx.update(catalogOutputs).set({status:"failed",error:reason,reason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id))); }
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
