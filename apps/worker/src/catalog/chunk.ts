import sharp from "sharp";
import { and, eq, inArray, sql } from "drizzle-orm";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { CHANNELS, STYLI_MIN_SOURCE_HEIGHT_PX, STYLI_SKIP_LOW_RESOLUTION } from "@catalog/core/catalog/channels";
import { batchPrefix, derivedPath, publicObjectPath, publicUrl, stagingPath } from "@catalog/core/catalog/naming";
import { bbox, planProduct, type Matte } from "@catalog/core/catalog/render";
import { renderKey } from "@catalog/core/catalog/pipeline/publish";
import { flagReason } from "@catalog/core/catalog/types";
import { recordCost } from "@catalog/core/spend";
import type { HandleOptions, HandleResult } from "../server";
import { enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";

export async function handleChunkTask(deps: CatalogDeps, body: Record<string,unknown>, opts: HandleOptions = {}): Promise<HandleResult> {
  if (typeof body.chunkId !== "string") return {httpStatus:400,outcome:"chunkId is required"};
  const [chunk] = await deps.db.select().from(catalogChunks).where(eq(catalogChunks.id,body.chunkId));
  if (!chunk) return {httpStatus:200,outcome:"not_found"};
  const started = deps.now(); let mattingMs = 0, renderMs = 0;
  try {
    const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,chunk.batchId));
    if (!batch || batch.status === "failed") return {httpStatus:200,outcome:"stopped"};
    if (chunk.status === "done" || chunk.status === "failed") { await finish(); return {httpStatus:200,outcome:chunk.status}; }
    await deps.db.update(catalogChunks).set({status:"running",attempt:sql`${catalogChunks.attempt}+1`,startedAt:started,finishedAt:null}).where(eq(catalogChunks.id,chunk.id));
    let policy = batch.options.policy;
    if (!policy) {
      const resolved = await deps.resolvePolicy(batch.brandSlug,batch.productType === "auto" ? "*":batch.productType);
      await deps.db.update(catalogBatches).set({options:sql`jsonb_set(${catalogBatches.options},'{policy}',${JSON.stringify(resolved)}::jsonb)`}).where(and(eq(catalogBatches.id,batch.id),sql`${catalogBatches.options}->'policy' IS NULL`));
      const [fresh] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,batch.id)); policy = fresh!.options.policy!;
    }
    const prefix = batchPrefix(batch.brandSlug,batch.id,batch.isTest);
    for (const productId of chunk.productIds) {
      const [product] = await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id,productId));
      if (!product || product.lockBatchId !== batch.id) continue;
      const sources = await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.batchId,batch.id))).orderBy(catalogSourceImages.n);
      if (chunk.stage === "matte") {
        const live = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.isLive,true)));
        for (const source of sources) {
          for (const channel of batch.channels) {
            const key = renderKey({sourceSha256:source.sha256,channel,n:source.n,policyKey:`default|${policy.matteModel}`});
            if (live.some(o=>o.channel===channel && o.n===source.n && o.renderKey===key)) continue;
            const [exists] = await deps.db.select({id:catalogOutputs.id}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.channel,channel)));
            if (exists) continue;
            const path = publicObjectPath(batch.brandSlug,product.pathKey,channel,source.n,batch.isTest), skip = channel === "styli" && STYLI_SKIP_LOW_RESOLUTION && (source.height ?? Infinity) < STYLI_MIN_SOURCE_HEIGHT_PX;
            await deps.db.insert(catalogOutputs).values({batchId:batch.id,productId,sourceImageId:source.id,channel,n:source.n,canvasW:0,canvasH:0,scale:0,placedX:0,placedY:0,renderKey:key,objectPath:path,publicUrl:publicUrl(deps.storage.getPublicBucketName(),path),status:skip ? "skipped":"pending",flags:skip ? ["low_resolution"]:[],reason:skip ? "Skipped for Styli: the photo is smaller than Styli needs.":null});
          }
          const pending = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          if (!pending.length || source.matteUri) continue;
          try {
            const mattePath = derivedPath(prefix,product.pathKey,source.n,"matte"), gs = deps.storage.toGsUri(deps.storage.getBucketName(),mattePath), cached = await deps.storage.headObject(gs);
            if (cached.exists) { await deps.db.update(catalogSourceImages).set({matteUri:gs,status:"matted"}).where(eq(catalogSourceImages.id,source.id)); continue; }
            const raw = await deps.storage.downloadBuffer(source.rawUri), p = await deps.prepare(raw.buf,source.originalName,b=>deps.matting.convert(b));
            const matte = await deps.matteFor(p,deps.matting,policy.matteModel); mattingMs += matte.ms;
            const fallback = matte.source === "floodfill", flags = [...new Set([...source.flags,...p.flags,...(fallback ? ["fallback_matte" as const]:[])])];
            await deps.db.update(catalogSourceImages).set({matteModel:matte.model,matteMs:matte.ms,width:p.width,height:p.height,flags}).where(eq(catalogSourceImages.id,source.id));
            if (fallback) await deps.db.update(catalogOutputs).set({status:"needs_attention",flags:["fallback_matte"],reason:flagReason("fallback_matte"),updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
            const png = await sharp(matte.alpha,{raw:{width:p.width,height:p.height,channels:1}}).png().toBuffer();
            await deps.storage.uploadBuffer(mattePath,png,"image/png");
            await deps.db.update(catalogSourceImages).set({matteUri:gs,status:"matted"}).where(eq(catalogSourceImages.id,source.id));
          } catch {
            const error = "The file is corrupt and could not be decoded.";
            await deps.db.update(catalogSourceImages).set({status:"failed",error}).where(eq(catalogSourceImages.id,source.id));
            await deps.db.update(catalogOutputs).set({status:"failed",reason:error,error,updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          }
        }
      } else {
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
            prepared.push({source,p,matte:{alpha,width:p.width,height:p.height,model:source.matteModel ?? policy.matteModel,ms:source.matteMs ?? 0,source:source.flags.includes("alpha_source") ? "alpha_source":"model",target:null,sentLongSide:null}});
          } catch(error) {
            await deps.db.update(catalogOutputs).set({status:"failed",reason:error instanceof Error ? error.message : String(error),updatedAt:deps.now()}).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          }
        }
        const uniform = prepared.map(({p,matte})=>({box:bbox(matte.alpha,p.width,p.height)!,source:{w:p.width,h:p.height}})).filter(s=>s.box);
        const uniformScale = uniform.length ? planProduct(CHANNELS.styli,uniform).uniformScale:undefined;
        for (const {source,p,matte} of prepared) {
          const outputs = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.sourceImageId,source.id),eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.status,"pending")));
          for (const output of outputs) try {
            const path = stagingPath(prefix,product.pathKey,output.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path), head = await deps.storage.headObject(uri);
            if (head.exists && output.bytes !== null && head.size===output.bytes) { await deps.db.update(catalogOutputs).set({stagingUri:uri,crc32c:head.crc32c,status:output.flags.some(f=>f==="small_source" || f==="failed_compliance") ? "needs_attention":"staged",updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id)); continue; }
            const renderStart = +deps.now();
            const rendered = (await deps.renderAllChannels(p,matte,[output.channel],{shotNumber:source.n,productType:batch.productType,identifier:product.identifier,publicObjectPath:output.objectPath,...(output.channel==="styli" ? {uniformScale}:{})}))[output.channel];
            renderMs += +deps.now()-renderStart;
            const flags = [...new Set([...source.flags,...rendered.flags])], status = rendered.status==="skipped" ? "skipped":!rendered.compliance.ok || flags.includes("small_source") ? "needs_attention":rendered.jpeg ? "staged":"failed";
            const patch = {canvasW:rendered.plan.w,canvasH:rendered.plan.h,scale:rendered.plan.scale,placedX:rendered.plan.placedX,placedY:rendered.plan.placedY,bytes:rendered.bytes,quality:rendered.quality,flags,compliance:rendered.compliance,reason:rendered.notes.join("; ") || (flags.includes("small_source") ? flagReason("small_source"):null),updatedAt:deps.now()};
            await deps.db.update(catalogOutputs).set(patch).where(eq(catalogOutputs.id,output.id));
            if (rendered.jpeg) await deps.storage.uploadBuffer(path,rendered.jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL});
            const staged = rendered.jpeg ? await deps.storage.headObject(uri):null;
            await deps.db.update(catalogOutputs).set({status,stagingUri:rendered.jpeg ? uri:null,crc32c:staged?.crc32c ?? null,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id));
          } catch(error) { const reason = error instanceof Error ? error.message:String(error); await deps.db.update(catalogOutputs).set({status:"failed",error:reason,reason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,output.id)); }
        }
      }
    }
    const changedOutputs = await deps.db.select({id:catalogOutputs.id}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),inArray(catalogOutputs.productId,chunk.productIds)));
    const wall = changedOutputs.length ? Math.max(0,(+deps.now()-+started)/1000)*2:0, usd = wall*Number(process.env.COMPUTE_USD_PER_VCPU_SECOND ?? 0);
    await deps.db.update(catalogBatches).set({cost:sql`${catalogBatches.cost} || jsonb_build_object('mattingMs',(${catalogBatches.cost}->>'mattingMs')::numeric+${mattingMs}::numeric,'renderMs',(${catalogBatches.cost}->>'renderMs')::numeric+${renderMs}::numeric,'computeVcpuSeconds',(${catalogBatches.cost}->>'computeVcpuSeconds')::numeric+${wall}::numeric,'computeUsd',(${catalogBatches.cost}->>'computeUsd')::numeric+${usd}::numeric)`}).where(eq(catalogBatches.id,batch.id));
    await recordCost(deps.db,{brandSlug:batch.brandSlug,batchId:batch.id,engine:"catalog_compute",costUsd:usd});
    if (chunk.stage === "matte") {
      await deps.db.update(catalogChunks).set({stage:"render",status:"queued",finishedAt:deps.now()}).where(eq(catalogChunks.id,chunk.id));
      await deps.db.update(catalogBatches).set({status:"rendering"}).where(and(eq(catalogBatches.id,batch.id),eq(catalogBatches.status,"matting")));
      await deps.enqueue("/tasks/catalog/chunk",{chunkId:chunk.id},{taskId:`chunk-${chunk.id}-render`});
    } else { await deps.db.update(catalogChunks).set({status:"done",finishedAt:deps.now()}).where(eq(catalogChunks.id,chunk.id)); await finish(); }
    await refreshBatchProgress(deps.db,batch.id);
    return {httpStatus:200,outcome:"done"};
  } catch(error) {
    const reason = error instanceof Error ? error.message:String(error);
    deps.log("chunk failed",{chunkId:chunk.id,error:reason});
    if ((opts.retryCount ?? 0) >= 4) {
      await deps.db.update(catalogChunks).set({status:"failed",error:reason,finishedAt:deps.now()}).where(eq(catalogChunks.id,chunk.id));
      if (chunk.productIds.length) await deps.db.update(catalogOutputs).set({status:"failed",reason:`Processing stopped after repeated errors: ${reason}`,updatedAt:deps.now()}).where(and(eq(catalogOutputs.batchId,chunk.batchId),inArray(catalogOutputs.productId,chunk.productIds),eq(catalogOutputs.status,"pending")));
      await finish(); return {httpStatus:200,outcome:"failed"};
    }
    return {httpStatus:503,outcome:"retry"};
  }
  async function finish() {
    for (const productId of chunk!.productIds) await deps.enqueue("/tasks/catalog/publish",{batchId:chunk!.batchId,productId},{taskId:`publish-${chunk!.batchId}-${productId}-chunk`});
    const chunks = await deps.db.select().from(catalogChunks).where(eq(catalogChunks.batchId,chunk!.batchId));
    if (chunks.every(c=>c.status==="done" || c.status==="failed")) { await deps.db.update(catalogBatches).set({status:"publishing"}).where(and(eq(catalogBatches.id,chunk!.batchId),inArray(catalogBatches.status,["matting","rendering","qa"]))); await enqueueFinalize(deps,chunk!.batchId); }
  }
}
