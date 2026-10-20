import sharp from "sharp";
import {startReplacement,completeReplacement,applyDecision,applySkuMap} from "@catalog/core/catalog/decisions";
import { judgeOutput } from "@catalog/core/catalog/qa/judge";
import { batchPrefix, publicObjectPath, stagingPath } from "@catalog/core/catalog/naming";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { and,eq,sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { brandMaster,catalogBatches,catalogBatchProducts,catalogChunks,catalogOutputs,catalogProductAliases,catalogProducts,catalogProductEvents,catalogSourceImages,catalogUploads,DEFAULT_BATCH_OPTIONS,EMPTY_BATCH_COUNTS,spendDays } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { workerCatalogDeps,type CatalogDeps } from "./deps";
import { UnsupportedSourceError } from "@catalog/core/catalog/render";
import { handleSweep } from "./sweep";
import { handleChunkTask } from "./chunk";
import { catalogLlmDeps, CatalogQaCapError, type UnderClaim } from "./qa-stage";
import { QA_USD_PER_CHECK_FALLBACK } from "@catalog/core/catalog/cost";
import { handlePublishTask } from "./publish";
import { handleFinalizeTask } from "./finalize";
import { renderKey, upscaledRenderKey } from "@catalog/core/catalog/pipeline/publish";
import { compareXlsxCsv,writeLinksXlsx } from "@catalog/core/catalog/sheet";
import { workbookCsvSheets } from "@catalog/core/catalog/pipeline/report";
import { cleanupTestBatch,cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import { deriveBatchState, QA_CAP_BANNER } from "@catalog/core/catalog/pipeline/status";
import { strictestChannel } from "@catalog/core/catalog/qa/policy";
import { findOrCreateProduct } from "@catalog/core/catalog/products";
import { cannedQa } from "./qa-mock";
import type { RepairOwnDefects } from "@catalog/core/catalog/qa/triage";
vi.mock(import("@catalog/core/catalog/sheet"),async original=>{const module=await original();return {...module,compareXlsxCsv:vi.fn(module.compareXlsxCsv)};});
let db:Db,close:()=>Promise<void>;
// stageCopyToPublic reads the bucket names from the environment. Set directly (not vi.stubEnv) so the
// tests that call vi.unstubAllEnvs keep them.
const bucketEnv={BUCKET:process.env.BUCKET,PUBLIC_BUCKET:process.env.PUBLIC_BUCKET};
beforeAll(async()=>{process.env.BUCKET="assets";process.env.PUBLIC_BUCKET="public";({db,close}=await createTestDb());},60_000);
afterAll(async()=>{storage.setStorageClient(undefined);for(const [key,value] of Object.entries(bucketEnv)) if(value===undefined) delete process.env[key]; else process.env[key]=value;await close();});
const jpeg=Buffer.from([255,216,255,1]);
function world() {
  const objects=new Map<string,{buf:Buffer;mime:string;generation:string;crc32c:string}>();
  let generation=100;
  const upload=async(path:string,buf:Buffer,mime:string)=>{const uri=`gs://assets/${path}`;objects.set(uri,{buf,mime,generation:String(++generation),crc32c:buf.toString("base64")});return uri;};
  // The copy runs through the real stageCopyToPublic, so its staging guard (assertStagedForTarget)
  // checks every publish; only the GCS client underneath is an in-memory fake.
  const client={bucket:(bucket:string)=>({file:(path:string)=>({uri:`gs://${bucket}/${path}`,copy:async(dest:{uri:string},options:{preconditionOpts:{ifGenerationMatch:number|string}})=>{const obj=objects.get(`gs://${bucket}/${path}`)!,old=objects.get(dest.uri);if(String(options.preconditionOpts.ifGenerationMatch)!==String(old?.generation ?? 0))throw Object.assign(new Error("Precondition failed"),{code:412});const next={...obj,generation:String(++generation)};objects.set(dest.uri,next);return [dest,{resource:{generation:next.generation,crc32c:next.crc32c}}];},getMetadata:async()=>{throw new Error("No metadata in the fake.");}})})};
  storage.setStorageClient(client as unknown as storage.StorageLike);
  const copy=vi.fn(storage.stageCopyToPublic);
  const remove=vi.fn(async(path:string)=>objects.delete(`gs://public/${path}`));
  const fetch=vi.fn<typeof globalThis.fetch>(async(url)=>{const path=new URL(String(url)).pathname.replace(/^\/public\//,"");const obj=objects.get(`gs://public/${path}`);return obj ? new Response(new Uint8Array(obj.buf),{headers:{"content-type":obj.mime,"content-length":String(obj.buf.length),"x-goog-generation":obj.generation}}):new Response(null,{status:404});});
  const base=workerCatalogDeps(db);
  const deps:CatalogDeps={...base,sleep:async()=>{},fetch,now:()=>new Date("2026-01-01T00:00:00Z"),log:()=>{},enqueue:vi.fn(async()=>"task"),resolvePolicy:vi.fn<CatalogDeps["resolvePolicy"]>(async()=>({matteModel:"fixture",qaModel:"",threshold:75,floor:60,qaMode:"per_source",qaSampleRate:1,source:"default"})),
    storage:{...storage,getBucketName:()=>"assets",getPublicBucketName:()=>"public",uploadBuffer:upload,downloadBuffer:async uri=>{const o=objects.get(uri);if(!o)throw new Error(`No object ${uri}`);return {buf:o.buf,mime:o.mime};},headObject:async uri=>{const o=objects.get(uri);return o ? {exists:true,size:o.buf.length,contentType:o.mime,generation:o.generation,crc32c:o.crc32c}:{exists:false,size:null,contentType:null,generation:null,crc32c:null};},stageCopyToPublic:copy,deletePublicObject:remove,setCustomTime:vi.fn(async()=>{})},
    judgeOutput:vi.fn<CatalogDeps["judgeOutput"]>(async(input)=>({scores:{complete_product:95,same_product:95,edge_quality:95,background_clean:95,no_text_or_watermark:95,orientation_ok:95,product_intact:95,placement_ok:95,overall:95},verdict:"pass",reasons:[],isCollage:false,costUsd:0,calls:0,usage:{},model:input.model,flags:[]})),
    classifyProductType:vi.fn<CatalogDeps["classifyProductType"]>(async()=>({type:"footwear",confidence:1,costUsd:0,calls:0,usage:{},flags:[]})),
    matting:{...base.matting,health:vi.fn(async()=>({ok:true,models:[{id:"fixture",inputSize:1024,target:"cpu"}],default:"fixture",versions:{cpu:null,gpu:null}})),convert:base.matting.convert.bind(base.matting)} as unknown as CatalogDeps["matting"],
    prepare:vi.fn(async(buf)=>({width:800,height:800,rgb:Buffer.alloc(800*800*3,buf[3] ?? 0),alphaSource:null,background:{uniform:true,color:[255,255,255] as [number,number,number],stdev:0},flags:[],sourceMime:"image/jpeg"})),
    matteFor:vi.fn<CatalogDeps["matteFor"]>(async()=>({alpha:Buffer.alloc(800*800,255),width:800,height:800,model:"fixture",ms:12,source:"model",target:"cpu",sentLongSide:800})),
    renderAllChannels:vi.fn<CatalogDeps["renderAllChannels"]>(async(_p,_m,channels)=>Object.fromEntries(channels.map(channel=>[channel,{jpeg:Buffer.from([255,216,255,_p.rgb[0]!]),status:"ok",plan:{w:800,h:1000,lowResolution:false,safeBox:{x:0,y:0,w:800,h:1000},scale:1,placedX:0,placedY:0,detailShot:false},quality:90,bytes:4,flags:[],notes:[],attention:null,compliance:{ok:true,failures:[]}}])) as unknown as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>)};
  return {deps,objects,copy,remove,upload};
}
async function seed(w:ReturnType<typeof world>,name:string,options:{productId?:string;shots?:string[];channels?: ("noon"|"amazon")[]}={}) {
  const [batch]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name,isTest:true,createdBy:"test@opptra.com",status:"matting",channels:options.channels ?? ["noon"],counts:{...EMPTY_BATCH_COUNTS,products:1,sources:(options.shots ?? ["sha"]).length,outputs:(options.shots ?? ["sha"]).length*(options.channels ?? ["noon"]).length}}).returning();
  const product=options.productId ? (await db.select().from(catalogProducts).where(eq(catalogProducts.id,options.productId)))[0]!:(await db.insert(catalogProducts).values({brandSlug:"anta",isTest:true,productKey:name,pathKey:name,identifier:name}).returning())[0]!;
  await db.update(catalogProducts).set({lockBatchId:batch!.id}).where(eq(catalogProducts.id,product.id));
  await db.insert(catalogBatchProducts).values({batchId:batch!.id,productId:product.id,change:options.productId ? "updated":"new"});
  for(const [i,sha] of (options.shots ?? ["sha"]).entries()) {const rawUri=await w.upload(`catalog-test/anta/${batch!.id}/raw/${product.pathKey}/${i+1}.jpg`,Buffer.from([255,216,255,sha.charCodeAt(0)]),"image/jpeg");await db.insert(catalogSourceImages).values({batchId:batch!.id,productId:product.id,n:i+1,sha256:sha,originalName:`${product.pathKey}_${i+1}.jpg`,rawUri,mime:"image/jpeg",width:800,height:800});}
  const [chunk]=await db.insert(catalogChunks).values({batchId:batch!.id,index:0,stage:"matte",productIds:[product.id]}).returning();
  return {batch:batch!,product,chunk:chunk!};
}
async function run(w:ReturnType<typeof world>,s:Awaited<ReturnType<typeof seed>>) {expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200);expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200);expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200);return handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id});}
it("does not finalize initial new rows, publishes, checks exports, then increments export versions",async()=>{const w=world(),s=await seed(w,"first");expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("not_ready");expect((await run(w,s)).outcome).toBe("published");expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));expect(batch!.counts).toMatchObject({latestExport:1,recheckOk:1,recheckTotal:1,verified:1});expect(deriveBatchState(batch!).state).toBe("ready");expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");const [again]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));expect(again!.sheetXlsxUri).toContain("links-v2.xlsx");expect(w.copy).toHaveBeenCalledTimes(1);},60_000);
it("redelivery repeats no finished matte, render or copy; identical reupload keeps generations",async()=>{const w=world(),s=await seed(w,"repeat");await run(w,s);await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id});expect(w.deps.matteFor).toHaveBeenCalledTimes(1);expect(w.deps.renderAllChannels).toHaveBeenCalledTimes(1);expect(w.copy).toHaveBeenCalledTimes(1);const next=await seed(w,"repeat2",{productId:s.product.id});await run(w,next);expect(w.deps.matteFor).toHaveBeenCalledTimes(1);expect(w.deps.renderAllChannels).toHaveBeenCalledTimes(1);expect(w.copy).toHaveBeenCalledTimes(1);const [pair]=await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,next.batch.id));expect(pair!.change).toBe("unchanged");},60_000);
it("replaces a changed source even when its rendered JPEG bytes match the live image",async()=>{
  const w=world(),first=await seed(w,"same-jpeg",{shots:["source-one"]});
  await run(w,first);
  const [old]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,first.batch.id));
  const next=await seed(w,"same-jpeg-next",{productId:first.product.id,shots:["source-two"]});
  expect((await run(w,next)).outcome).toBe("published");
  const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,next.batch.id));
  expect(output!.renderKey).not.toBe(old!.renderKey);
  expect(output!.crc32c).toBe(old!.crc32c);
  expect(output!.bytes).toBe(old!.bytes);
  expect(output!.publicUrl).toBe(old!.publicUrl);
  expect(w.copy).toHaveBeenCalledTimes(2);
  expect(w.copy.mock.calls[1]![2]).toEqual({ifGenerationMatch:old!.generation});
  expect(output!.generation).not.toBe(old!.generation);
  const [pair]=await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,next.batch.id));
  expect(pair!.change).toBe("updated");
},60_000);
it("reuses a completed public copy after the publication transaction rolls back",async()=>{
  const w=world(),first=await seed(w,"public-copy-crash",{shots:["source-one"]});
  await run(w,first);
  const [old]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,first.batch.id));
  const next=await seed(w,"public-copy-crash-next",{productId:first.product.id,shots:["source-two"]});
  await handleChunkTask(w.deps,{chunkId:next.chunk.id});
  await handleChunkTask(w.deps,{chunkId:next.chunk.id});
  await handleChunkTask(w.deps,{chunkId:next.chunk.id});
  vi.mocked(w.deps.storage.setCustomTime).mockRejectedValueOnce(new Error("Crash before DB commit"));
  expect((await handlePublishTask(w.deps,{batchId:next.batch.id,productId:next.product.id})).outcome).toBe("retry");
  const [rolledBack]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,next.batch.id));
  expect(rolledBack).toMatchObject({status:"staged",generation:null,isLive:false});
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,old!.id)))[0]!.isLive).toBe(true);
  const copied=w.objects.get(`gs://public/${old!.objectPath}`)!;
  expect(copied.generation).not.toBe(String(old!.generation));
  expect(w.copy).toHaveBeenCalledTimes(2);
  expect((await handlePublishTask(w.deps,{batchId:next.batch.id,productId:next.product.id})).outcome).toBe("published");
  const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,next.batch.id));
  expect(output).toMatchObject({status:"verified",isLive:true,generation:Number(copied.generation)});
  expect(w.copy).toHaveBeenCalledTimes(2);
  expect((await handlePublishTask(w.deps,{batchId:next.batch.id,productId:next.product.id})).outcome).toBe("published");
  expect(w.copy).toHaveBeenCalledTimes(2);
},60_000);
it("holds undecided outputs with no public writes, then publishes once staged",async()=>{const w=world(),s=await seed(w,"held");await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});await db.update(catalogOutputs).set({status:"needs_attention",reason:"Check the edge."}).where(eq(catalogOutputs.batchId,s.batch.id));expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("held");expect(w.copy).not.toHaveBeenCalled();expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id,s.product.id)))[0]!.lockBatchId).toBe(s.batch.id);await db.update(catalogOutputs).set({status:"staged"}).where(eq(catalogOutputs.batchId,s.batch.id));expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");},60_000);
it("replaces changed bytes and deletes removed shots only on selected channels",async()=>{const w=world(),s=await seed(w,"overwrite",{shots:["one","two"],channels:["noon","amazon"]});await run(w,s);const next=await seed(w,"overwrite2",{productId:s.product.id,shots:["changed"]});await run(w,next);expect(w.remove).toHaveBeenCalledTimes(1);expect(w.remove.mock.calls[0]![0]).toContain("/noon/");const [pair]=await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,next.batch.id));expect(pair!.change).toBe("shots_removed");const events=await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId,next.batch.id));expect(events.map(e=>e.kind)).toEqual(expect.arrayContaining(["overwritten","shots_removed"]));const amazon=await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,s.product.id),eq(catalogOutputs.channel,"amazon"),eq(catalogOutputs.isLive,true)));expect(amazon).toHaveLength(2);},60_000);
it("a redelivered shot that ingest links to the previous source stages under its own batch prefix",async()=>{
  const w=world(),s=await seed(w,"redeliver",{shots:["one","two"]});await run(w,s);
  const next=await seed(w,"redeliver2",{productId:s.product.id,shots:["changed","two"]});
  // Ingest sets replacesId on every redelivered shot to the product's current source for that n.
  const previous=await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,s.batch.id));
  for(const source of await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,next.batch.id))) await db.update(catalogSourceImages).set({replacesId:previous.find(p=>p.n===source.n)!.id}).where(eq(catalogSourceImages.id,source.id));
  expect((await run(w,next)).outcome).toBe("published");
  const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,next.batch.id));
  // stageCopyToPublic only publishes <root>/<brand>/<batch>/staging/<pathKey>/<channel>/<name>.
  expect(output!.stagingUri).toBe(storage.toGsUri("assets",stagingPath(batchPrefix("anta",next.batch.id,true),s.product.pathKey,"noon",1)));
  expect(w.copy.mock.calls.at(-1)![0]).toBe(output!.stagingUri);
},60_000);
it("render keys include rules, policy, shot, channel and source",()=>{const input={sourceSha256:"one",channel:"noon" as const,n:1,policyKey:"default|fixture"};expect(new Set([renderKey(input),renderKey({...input,n:2}),renderKey({...input,channel:"amazon"}),renderKey({...input,policyKey:"other"}),renderKey({...input,rulesVersion:"next"}),renderKey({...input,sourceSha256:"two"})]).size).toBe(6);});
it("holds a product if its chunk failed before it could create planned outputs",async()=>{const w=world(),s=await seed(w,"missing-output");await db.update(catalogChunks).set({status:"failed"}).where(eq(catalogChunks.id,s.chunk.id));expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("held");expect(w.copy).not.toHaveBeenCalled();},60_000);
it("isolates one render exception, retries a fallback matte once, then renders and holds it",async()=>{const w=world(),s=await seed(w,"render-error",{channels:["noon","amazon"]});vi.mocked(w.deps.renderAllChannels).mockRejectedValueOnce(new Error("Could not make this photo."));await run(w,s);const outputs=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));expect(outputs.map(o=>o.status)).toEqual(["failed","staged"]);expect(w.copy).not.toHaveBeenCalled();const fallback=await seed(w,"fallback");const flood={alpha:Buffer.alloc(800*800,255),width:800,height:800,model:"floodfill",ms:0,source:"floodfill" as const,target:null,sentLongSide:null};vi.mocked(w.deps.matteFor).mockClear().mockResolvedValueOnce(flood).mockResolvedValueOnce(flood);expect((await run(w,fallback)).outcome).toBe("held");expect(w.deps.matteFor).toHaveBeenCalledTimes(2);const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,fallback.batch.id));expect(output!.flags).toContain("fallback_matte");expect(output!.stagingUri).not.toBeNull();expect(output!.status).toBe("needs_attention");expect((output!.compliance as {auto_actions:{step:string;result:string}[]}).auto_actions).toEqual([expect.objectContaining({step:"matte_retry",result:"failed"})]);expect(output!.reason).toContain("cut-out service was unavailable");},60_000);
it("re-copies only once before recording a public verification failure",async()=>{const w=world(),s=await seed(w,"verify-failure");w.deps.fetch=vi.fn(async()=>new Response(new Uint8Array(jpeg),{headers:{"content-type":"text/plain","content-length":"4","x-goog-generation":"wrong"}}));await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});const result=await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id});expect(result.outcome).toBe("failed");expect(w.copy).toHaveBeenCalledTimes(2);const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));expect(output!.reason).toBe("Uploaded file could not be read back from the public link");},60_000);
it("leaves the batch unfinished when xlsx and csv differ",async()=>{const w=world(),s=await seed(w,"mismatch");await run(w,s);vi.mocked(compareXlsxCsv).mockResolvedValueOnce({equal:false,differences:["Identifier differs."]});expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("exports_mismatch");const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));expect(batch!.status).not.toBe("done");expect(batch!.error).toContain("Identifier differs.");},60_000);
it("writes a filled product list, repeats links per size, preserves the upload and records CSV exports",async()=>{const w=world(),s=await seed(w,"filled");const original=await writeLinksXlsx({channels:["noon"],rows:[7,8].map(size=>({brand:"Anta",identifier:`filled/${size}`,optionIdStyleColor:"",opptraSkuIds:[],links:{},status:"ok",notes:`size ${size}`,change:"new",changedAt:null}))});const originalUri=await w.upload(`catalog-test/anta/${s.batch.id}/uploads/list.xlsx`,original,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");await db.insert(catalogUploads).values({batchId:s.batch.id,kind:"product_list",name:"list.xlsx",gcsUri:originalUri,status:"collected",detected:{matchColumn:1}});await run(w,s);expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));const report=JSON.parse(w.objects.get(batch!.reportUri!)!.buf.toString());expect(report.exports.filledProductList.csv).toHaveLength(1);const filled=await workbookCsvSheets(w.objects.get(report.exports.filledProductList.xlsx)!.buf);expect(filled[0]!.csv).toContain("link_status");expect(filled[0]!.csv.match(/https:\/\/storage.googleapis.com/g)).toHaveLength(2);expect(w.objects.get(originalUri)!.buf).toEqual(original);},60_000);
it("refuses production cleanup and cleans both passes only under test prefixes",async()=>{const w=world();const [production]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name:"production",createdBy:"test@opptra.com",isTest:false}).returning();const remove=vi.fn(async(uri:string)=>{expect(uri).toMatch(/^gs:\/\/(assets|public)\/catalog-test\//);return 1;});const deps={...w.deps.storage,deleteTestObjects:remove};await expect(cleanupTestBatch(db,deps,production!.id)).rejects.toThrow("catalog-test/");expect(remove).not.toHaveBeenCalled();const first=await seed(w,"cleanup");await run(w,first);const second=await seed(w,"cleanup2",{productId:first.product.id});await run(w,second);await expect(cleanupTestBatch(db,deps,first.batch.id)).rejects.toThrow("shared");await expect(cleanupTestBatches(db,deps,[first.batch.id,second.batch.id])).resolves.toMatchObject({objects:3});expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id,first.product.id)))).toHaveLength(0);},60_000);
it("recovers uploaded matte and staging caches after a crash before their final DB updates",async()=>{const w=world(),s=await seed(w,"crash");await handleChunkTask(w.deps,{chunkId:s.chunk.id});await db.update(catalogChunks).set({stage:"matte",status:"queued"}).where(eq(catalogChunks.id,s.chunk.id));await db.update(catalogSourceImages).set({matteUri:null}).where(eq(catalogSourceImages.batchId,s.batch.id));await handleChunkTask(w.deps,{chunkId:s.chunk.id});expect(w.deps.matteFor).toHaveBeenCalledTimes(1);await handleChunkTask(w.deps,{chunkId:s.chunk.id});await db.update(catalogChunks).set({stage:"render",status:"queued"}).where(eq(catalogChunks.id,s.chunk.id));await db.update(catalogOutputs).set({status:"pending",stagingUri:null}).where(eq(catalogOutputs.batchId,s.batch.id));await handleChunkTask(w.deps,{chunkId:s.chunk.id});expect(w.deps.renderAllChannels).toHaveBeenCalledTimes(1);await handleChunkTask(w.deps,{chunkId:s.chunk.id});expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");expect(w.copy).toHaveBeenCalledTimes(1);},60_000);

it("serializes overlapping chunk deliveries before either can regress the stage",async()=>{
  const w=world(),s=await seed(w,"overlapping");
  let release!:()=>void,entered!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const head=w.deps.storage.headObject;
  let first=true;
  w.deps.storage.headObject=async uri=>{if(first){first=false;entered();await paused;}return head(uri);};
  const firstDelivery=handleChunkTask(w.deps,{chunkId:s.chunk.id});
  await started;
  const duplicate=await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  release();await firstDelivery;
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  expect(duplicate.httpStatus).toBe(503);
  expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id)))[0]).toMatchObject({stage:"qa",status:"queued"});
  expect(w.deps.matteFor).toHaveBeenCalledTimes(1);
},60_000);
it("retries a temporary matte storage failure, then resumes without labelling the file corrupt",async()=>{
  const w=world(),s=await seed(w,"temporary-matte-store");
  const head=w.deps.storage.headObject;
  w.deps.storage.headObject=vi.fn(head).mockRejectedValueOnce(new Error("Temporary storage outage"));
  expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id},{retryCount:1})).httpStatus).toBe(503);
  expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,s.batch.id)))[0]!.status).toBe("pending");
  expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id},{retryCount:2})).httpStatus).toBe(200);
  expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,s.batch.id)))[0]!.status).toBe("matted");
},60_000);
it("records the fifth dependency failure and nudges publication and finalization",async()=>{
  const w=world(),s=await seed(w,"fifth-matte-store");
  w.deps.storage.headObject=vi.fn(async()=>{throw new Error("Temporary storage outage");});
  expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id},{retryCount:4})).outcome).toBe("failed");
  expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id)))[0]).toMatchObject({status:"failed",error:"Temporary storage outage"});
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id)))[0]).toMatchObject({status:"failed",reason:"Processing stopped after repeated errors: Temporary storage outage"});
  expect(w.deps.enqueue).toHaveBeenCalledWith("/tasks/catalog/publish",{batchId:s.batch.id,productId:s.product.id},expect.anything());
  expect(w.deps.enqueue).toHaveBeenCalledWith("/tasks/catalog/finalize",{batchId:s.batch.id},expect.anything());
},60_000);
it("performs finalization network work after releasing the database transaction",async()=>{
  const w=world(),s=await seed(w,"short-finalize-lock");await run(w,s);
  let inTransaction=false,networkInTransaction=false;
  const transaction=db.transaction.bind(db);
  const spy=vi.spyOn(db,"transaction").mockImplementation(async(callback,config)=>transaction(async tx=>{inTransaction=true;try{return await callback(tx);}finally{inTransaction=false;}},config));
  const fetch=w.deps.fetch;
  w.deps.fetch=async(...args)=>{networkInTransaction ||= inTransaction;return fetch(...args);};
  try {expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");expect(networkInTransaction).toBe(false);}finally{spy.mockRestore();}
},60_000);

it("recovers a committed finalize intent whose enqueue never happened",async()=>{
  const w=world(),s=await seed(w,"enqueue-process-death");
  await db.update(catalogBatches).set({status:"publishing",counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizePending',true,'finalizeEnqueuedAt',${+w.deps.now()-180_000}::numeric)`}).where(eq(catalogBatches.id,s.batch.id));
  await handleSweep({db,enqueue:w.deps.enqueue,releaseLocks:async()=>0,now:w.deps.now},{});
  expect(w.deps.enqueue).toHaveBeenCalledWith("/tasks/catalog/finalize",{batchId:s.batch.id},{});
  expect((await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id)))[0]!.status).toBe("publishing");
  vi.mocked(w.deps.enqueue).mockClear();
  await handleSweep({db,enqueue:w.deps.enqueue,releaseLocks:async()=>0,now:w.deps.now},{});
  expect(w.deps.enqueue).not.toHaveBeenCalled();
},60_000);
it("rejects a changed finalize snapshot and regenerates from the later state",async()=>{
  const w=world(),s=await seed(w,"finalize-snapshot-change");await run(w,s);
  const fetch=w.deps.fetch;let changed=false;
  w.deps.fetch=async(...args)=>{if(!changed){changed=true;await db.update(catalogBatchProducts).set({notes:"Updated while checking links"}).where(eq(catalogBatchProducts.batchId,s.batch.id));}return fetch(...args);};
  expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).httpStatus).toBe(503);
  const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
  expect(batch!.counts.latestExport).toBe(0);expect(batch!.sheetXlsxUri).toBeNull();
  expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");
  const [done]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
  expect(JSON.parse(w.objects.get(done!.reportUri!)!.buf.toString()).products[0].identifier).toBe(s.product.identifier);
},60_000);
it("does not let an expired delayed matte delivery regress a later completed render",async()=>{
  const w=world(),s=await seed(w,"expired-overlap");
  let now=w.deps.now();w.deps.now=()=>now;
  let release!:()=>void,entered!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const head=w.deps.storage.headObject;let first=true;
  w.deps.storage.headObject=async uri=>{if(first){first=false;entered();await paused;}return head(uri);};
  const delayed=handleChunkTask(w.deps,{chunkId:s.chunk.id});await started;
  now=new Date(+now+1_000_000);
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  release();expect((await delayed).httpStatus).toBe(503);
  expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id)))[0]).toMatchObject({stage:"qa",status:"queued"});
},60_000);
it("a stale finalizer cannot clear a newer owner's recoverable claim",async()=>{
  const w=world(),s=await seed(w,"finalize-new-owner");await run(w,s);
  const fetch=w.deps.fetch;
  w.deps.fetch=async(...args)=>{await db.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizeClaim','new-owner','finalizeClaimUntil',${+w.deps.now()+1_000_000}::numeric)`}).where(eq(catalogBatches.id,s.batch.id));return fetch(...args);};
  expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).httpStatus).toBe(503);
  const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
  expect(batch!.counts).toHaveProperty("finalizeClaim","new-owner");expect(batch!.counts.latestExport).toBe(0);
},60_000);

it("recovers an execution claim after the original finalize task died",async()=>{
  const w=world(),s=await seed(w,"finalize-execution-death");await run(w,s);
  await db.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizePending',false,'finalizeClaim','dead-owner','finalizeClaimUntil',${+w.deps.now()-1}::numeric)`}).where(eq(catalogBatches.id,s.batch.id));
  vi.mocked(w.deps.enqueue).mockClear();
  await handleSweep({db,enqueue:w.deps.enqueue,releaseLocks:async()=>0,now:w.deps.now},{});
  expect(w.deps.enqueue).toHaveBeenCalledWith("/tasks/catalog/finalize",{batchId:s.batch.id},{});
  expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");
},60_000);
it("recovers a dead chunk owner after its delivery retries have stopped",async()=>{
  const w=world(),s=await seed(w,"chunk-execution-death");
  await db.update(catalogChunks).set({status:"running",taskName:"dead-owner",startedAt:new Date(+w.deps.now()-1_000_000)}).where(eq(catalogChunks.id,s.chunk.id));
  await handleSweep({db,enqueue:w.deps.enqueue,releaseLocks:async()=>0,now:w.deps.now},{});
  expect(w.deps.enqueue).toHaveBeenCalledWith("/tasks/catalog/chunk",{chunkId:s.chunk.id},expect.objectContaining({taskId:expect.stringContaining("-recovery-")}));
  vi.mocked(w.deps.enqueue).mockClear();
  await handleSweep({db,enqueue:w.deps.enqueue,releaseLocks:async()=>0,now:w.deps.now},{});
  expect(w.deps.enqueue).not.toHaveBeenCalled();
  expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200);
},60_000);

it("keeps an actual decode error terminal while retrying a conversion service outage",async()=>{
  const w=world(),bad=await seed(w,"actual-corrupt");
  vi.mocked(w.deps.prepare).mockRejectedValueOnce(new UnsupportedSourceError("Cannot decode this image"));
  expect((await handleChunkTask(w.deps,{chunkId:bad.chunk.id})).httpStatus).toBe(200);
  expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,bad.batch.id)))[0]).toMatchObject({status:"failed",error:"The file is corrupt and could not be decoded."});
  const converted=await seed(w,"convert-outage");
  w.deps.prepare=async(buf,_name,convert)=>{try{await convert(buf);}catch{throw new UnsupportedSourceError("Wrapped decoder error");}throw new Error("Expected conversion failure");};
  const convert=vi.spyOn(w.deps.matting,"convert").mockRejectedValueOnce(new Error("Conversion service unavailable"));
  try {
    expect((await handleChunkTask(w.deps,{chunkId:converted.chunk.id})).httpStatus).toBe(503);
    expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,converted.batch.id)))[0]!.status).toBe("pending");
  } finally {convert.mockRestore();}
},60_000);

it("keeps verified output state when an expired render resumes after newer publication",async()=>{
  const w=world(),s=await seed(w,"late-render-publication");
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  let now=w.deps.now();w.deps.now=()=>now;
  let release!:()=>void,entered!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const render=w.deps.renderAllChannels;let first=true;
  w.deps.renderAllChannels=async(...args)=>{if(first){first=false;entered();await paused;}return render(...args);};
  const old=handleChunkTask(w.deps,{chunkId:s.chunk.id});await started;
  now=new Date(+now+1_000_000);
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");
  release();await old;
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id)))[0]).toMatchObject({status:"verified",isLive:true});
},60_000);

it("prevents an expired fallback attempt replacing a newer model matte cache",async()=>{
  const w=world(),s=await seed(w,"late-fallback-cache");
  let now=w.deps.now();w.deps.now=()=>now;
  let release!:()=>void,entered!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const matte=w.deps.matteFor;let first=true;
  w.deps.matteFor=async(...args)=>{if(first){first=false;entered();await paused;return {alpha:Buffer.alloc(800*800,0),width:800,height:800,model:"floodfill",ms:0,source:"floodfill",target:null,sentLongSide:null};}return matte(...args);};
  const old=handleChunkTask(w.deps,{chunkId:s.chunk.id});await started;
  now=new Date(+now+1_000_000);await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  const [source]=await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,s.batch.id));
  const checked=Buffer.from(w.objects.get(source!.matteUri!)!.buf);
  release();await old;
  expect(w.objects.get(source!.matteUri!)!.buf).toEqual(checked);
  expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id,source!.id)))[0]!.flags).not.toContain("fallback_matte");
},60_000);
it("does not refresh progress when a finalize attempt is busy or only drops its claim",async()=>{
  const w=world(),s=await seed(w,"finalize-housekeeping-progress");await run(w,s);
  await db.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizeClaim','active-owner','finalizeClaimUntil',${+w.deps.now()+1_000_000}::numeric)`}).where(eq(catalogBatches.id,s.batch.id));
  const before=(await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id)))[0]!.updatedAt;
  expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("busy");
  expect((await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id)))[0]!.updatedAt).toEqual(before);
  await db.update(catalogBatches).set({counts:sql`${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil'`}).where(eq(catalogBatches.id,s.batch.id));
  let startedAt:Date|undefined;
  w.deps.storage.uploadBuffer=async()=>{startedAt=(await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id)))[0]!.updatedAt;throw new Error("Temporary upload failure");};
  expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("retry");
  expect((await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id)))[0]!.updatedAt).toEqual(startedAt);
},60_000);
it("stops an expired owner before it requests another matte while its replacement is still working",async()=>{
  const w=world(),s=await seed(w,"stop-expired-compute",{shots:["one","two"]});
  let now=w.deps.now();w.deps.now=()=>now;
  let releaseOld!:()=>void,releaseNew!:()=>void,enteredOld!:()=>void,enteredNew!:()=>void;
  const oldPause=new Promise<void>(resolve=>{releaseOld=resolve;}),newPause=new Promise<void>(resolve=>{releaseNew=resolve;});
  const oldStarted=new Promise<void>(resolve=>{enteredOld=resolve;}),newStarted=new Promise<void>(resolve=>{enteredNew=resolve;});
  const matte=w.deps.matteFor;let calls=0;
  w.deps.matteFor=vi.fn<CatalogDeps["matteFor"]>(async(...args)=>{
    calls++;
    if(calls===1){enteredOld();await oldPause;}
    else if(calls===3){enteredNew();await newPause;}
    return matte(...args);
  });
  const old=handleChunkTask(w.deps,{chunkId:s.chunk.id});await oldStarted;
  now=new Date(+now+1_000_000);
  const replacement=handleChunkTask(w.deps,{chunkId:s.chunk.id});await newStarted;
  releaseOld();
  try {
    expect((await old).httpStatus).toBe(503);
    expect(w.deps.matteFor).toHaveBeenCalledTimes(3);
  } finally {releaseNew();await replacement;}
},60_000);

it("spec07 renders a replacement from its own private cache, processes only that source, and promotes one version",async()=>{
 const w=world(),s=await seed(w,"replacement-chain",{shots:["first","second"],channels:["noon","amazon"]});
 await run(w,s);
 const before=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 const target=before.find(o=>o.n===1 && o.channel==="noon")!;
 await db.update(catalogOutputs).set({status:"needs_attention",flags:["halo"]}).where(eq(catalogOutputs.id,target.id));
 const original=(await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id,target.sourceImageId)))[0]!;
 const originalBytes=Buffer.from(w.objects.get(original.rawUri)!.buf);
 const bytes=await sharp({create:{width:800,height:800,channels:3,background:"red"}}).jpeg().toBuffer();
 const replacementDeps={...w.deps,storage:{...w.deps.storage,signedPutUrl:vi.fn(async(p:string)=>p)}};
 const start=await startReplacement(replacementDeps,{outputId:target.id,name:"replacement-chain_1.jpg",size:bytes.length,mime:"image/jpeg"});
 const [upload]=await db.select().from(catalogUploads).where(eq(catalogUploads.id,start.uploadId));
 await w.upload(storage.parseGsUri(upload!.gcsUri!).path,bytes,"image/jpeg");
 const replacement=await completeReplacement(replacementDeps,{outputId:target.id,uploadId:start.uploadId,actor:"operator@opptra.com"});
 const matteCalls=vi.mocked(w.deps.matteFor).mock.calls.length,renderCalls=vi.mocked(w.deps.renderAllChannels).mock.calls.length;
 for(let i=0;i<3;i++) expect((await handleChunkTask(w.deps,{chunkId:replacement.chunkId})).httpStatus).toBe(200);
 expect(w.deps.matteFor).toHaveBeenCalledTimes(matteCalls+1);
 expect(w.deps.renderAllChannels).toHaveBeenCalledTimes(renderCalls+2);
 // The publish copy goes through the real staging guard, which only accepts <batch>/staging/...
 const publish=await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id});
 expect(publish.outcome,JSON.stringify((await db.select({reason:catalogOutputs.reason}).from(catalogOutputs).where(eq(catalogOutputs.sourceImageId,replacement.sourceImageId))).map(o=>o.reason))).toBe("published");
 const after=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 const fresh=after.filter(o=>o.sourceImageId===replacement.sourceImageId);
 expect(fresh).toHaveLength(2);
 expect(fresh.map(o=>o.stagingUri).sort()).toEqual(["amazon","noon"].map(channel=>storage.toGsUri("assets",stagingPath(batchPrefix("anta",s.batch.id,true),s.product.pathKey,channel as "noon"|"amazon",1))));
 expect(fresh.every(o=>o.isLive && o.generation!==before.find(old=>old.channel===o.channel && old.n===o.n)!.generation)).toBe(true);
 expect(after.filter(o=>o.n===2).map(o=>o.generation)).toEqual(before.filter(o=>o.n===2).map(o=>o.generation));
 const sources=await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.productId,s.product.id));
 expect(sources.filter(source=>source.n===1 && source.isCurrent).map(source=>source.id)).toEqual([replacement.sourceImageId]);
 expect(sources.find(source=>source.id===replacement.sourceImageId)!.matteUri).not.toBe(original.matteUri);
 expect(w.objects.get(original.rawUri)!.buf).toEqual(originalBytes);
},60_000);
it("spec07 renders into a queued QA delivery before publication",async()=>{
 const w=world(),s=await seed(w,"qa-stage-order");
 await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});
 const [chunk]=await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id));
 expect(chunk).toMatchObject({stage:"qa",status:"queued"});
 expect(w.deps.enqueue).not.toHaveBeenCalledWith("/tasks/catalog/publish",expect.anything(),expect.anything());
},60_000);
const judgeScores=(extra:Partial<Record<string,number>>={})=>({complete_product:95,same_product:100,edge_quality:95,background_clean:95,no_text_or_watermark:95,orientation_ok:95,overall:95,...extra});
type JudgePick={scores?:Record<string,number>;evidence?:Record<string,string>;flags?:string[];view?:string};
const judgeWith=(pick:(input:Parameters<CatalogDeps["judgeOutput"]>[0])=>JudgePick):CatalogDeps["judgeOutput"]=>async input=>{
 const chosen=pick(input);
 return {scores:judgeScores(chosen.scores) as never,verdict:"pass",reasons:[],isCollage:false,costUsd:0,calls:1,usage:{},model:input.model,flags:(chosen.flags ?? []) as never,view:chosen.view ?? "side",evidence:chosen.evidence ?? {},wrongItem:{first:false,second:null,secondModel:null,confirmed:false}};
};
const judgePolicy={matteModel:"fixture",qaModel:"test/judge",qaModelSecond:"test/second",threshold:75,floor:60,qaMode:"per_source" as const,qaSampleRate:1,source:"default" as const};
it("spec07 v2 placement never comes from the judge, and a photo flag applies to every channel",async()=>{
 const w=world(),s=await seed(w,"qa-v2-placement",{channels:["noon","amazon"]});
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(w.deps.judgeOutput).mockImplementation(judgeWith(()=>({scores:{placement_ok:5},flags:["placement"]})));
 expect((await run(w,s)).outcome).toBe("published");
 expect(w.deps.judgeOutput).toHaveBeenCalledTimes(1);
 for(const o of await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id))) {expect(o.flags).not.toContain("placement");expect(o.status).toBe("verified");}
 const t=world(),text=await seed(t,"qa-v2-photo-flag",{channels:["noon","amazon"]});
 vi.mocked(t.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(t.deps.judgeOutput).mockImplementation(judgeWith(()=>({scores:{no_text_or_watermark:10},evidence:{text_or_watermark:"A price sticker sits on the box."}})));
 expect((await run(t,text)).outcome).toBe("held");
 expect(t.deps.judgeOutput).toHaveBeenCalledTimes(1);
 const outputs=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,text.batch.id));
 expect(outputs.map(o=>o.channel).sort()).toEqual(["amazon","noon"]);
 for(const o of outputs) {expect(o.flags).toContain("text_or_watermark");expect(o).toMatchObject({status:"needs_attention",qaScores:{autoAction:"hold",holdCause:"photo_one",evidence:{text_or_watermark:{sentence:"A price sticker sits on the box.",model:"test/judge"}}}});}
},60_000);
it("spec07 v2 an output defect on one channel re-checks the photo's other channels and applies the strictest result",async()=>{
 const w=world(),s=await seed(w,"qa-v2-recheck",{shots:["a","b","c","d"],channels:["noon","amazon"]});
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 const judged=strictestChannel(["noon","amazon"]);
 // The shadow block shows only to the judged channel's judge; the re-check of the other channel misses it.
 vi.mocked(w.deps.judgeOutput).mockImplementation(judgeWith((input):JudgePick=>input.n===2 && input.channel===judged ? {scores:{background_clean:20},evidence:{leftover_background:"A grey block remains left of the shoe."}}:{}));
 expect((await run(w,s)).outcome).toBe("published");
 // Judge, re-check, then one re-judge of the 5% smaller fit on the judged channel (the other steps have nothing to change).
 expect(vi.mocked(w.deps.judgeOutput).mock.calls.filter(call=>call[0].n===2).map(call=>call[0].channel).sort()).toEqual([judged,...["amazon","noon"]].sort());
 expect(vi.mocked(w.deps.judgeOutput).mock.calls.filter(call=>call[0].n!==2)).toHaveLength(3);
 const second=await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,s.batch.id),eq(catalogOutputs.n,2)));
 for(const o of second) {
  expect(o.flags).toContain("leftover_background");
  expect(o).toMatchObject({status:"skipped",isLive:false,qaScores:{background_clean:20,autoAction:"drop",finalStatus:"skipped"}});
  expect(o.reason).toBe("Some of the original background is still visible around the product. Left out automatically because this product has enough other good photos.");
  expect((o.qaScores as {judgements:{role:string}[]}).judgements.map(j=>j.role).sort()).toEqual(["judge","recheck"]);
 }
},60_000);
it("spec07 v2 drop-with-note and note-only flags keep the batch attention rate at 0, and the report says why",async()=>{
 const w=world(),s=await seed(w,"qa-v2-notes",{shots:["a","b","c","d"]});
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(w.deps.judgeOutput).mockImplementation(judgeWith((input):JudgePick=>input.n===3 ? {scores:{edge_quality:40},evidence:{halo:"The heel edge shows a white fringe."}}:input.n===2 ? {scores:{complete_product:30},evidence:{complete_product:"The toe is cut off at the right edge of the photo."}}:{}));
 expect((await run(w,s)).outcome).toBe("published");
 const outputs=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 expect(outputs.find(o=>o.n===3)).toMatchObject({status:"skipped",qaScores:{autoAction:"drop"}});
 expect(outputs.find(o=>o.n===2)).toMatchObject({status:"verified",isLive:true,qaScores:{autoAction:"note"},reason:"Part of the product or model looks cut at the frame edge in the original photo."});
 expect(outputs.filter(o=>o.status==="needs_attention")).toHaveLength(0);
 expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");
 const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
 expect(batch!.counts.attentionProducts).toBe(0);
 const report=JSON.parse(w.objects.get(batch!.reportUri!)!.buf.toString());
 expect(report.qa).toMatchObject({attentionRate:0,productsHeld:0,products:1,judgedOutputs:4,autoActions:{drop:1,note:1,hold:0,none:2}});
 const entries=report.products[0].outputs as {n:number;qa:Record<string,unknown>}[];
 const dropped=entries.find(e=>e.n===3)!.qa;
 expect(dropped).toMatchObject({scores:{edge_quality:40},thresholds:{edge_quality:75,complete_product:60},evidence:{halo:{sentence:"The heel edge shows a white fringe.",model:"test/judge"}},model:"test/judge",autoAction:"drop",finalStatus:"skipped"});
 expect(entries.every(e=>e.qa && "scores" in e.qa && "thresholds" in e.qa && "autoAction" in e.qa && "finalStatus" in e.qa)).toBe(true);
 const sheet=(await workbookCsvSheets(w.objects.get(batch!.sheetXlsxUri!)!.buf))[0]!.csv;
 expect(sheet).toContain("Noon img 3: The edge of the product looks rough");
 expect(sheet).toContain("Noon img 2: Part of the product or model looks cut");
},60_000);
it("spec07 v2 the re-render extension point runs before triage and a repaired output is published",async()=>{
 const w=world(),s=await seed(w,"qa-v2-repair");
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(w.deps.judgeOutput).mockImplementation(judgeWith(()=>({scores:{edge_quality:30}})));
 w.deps.repairOwnDefects=vi.fn<RepairOwnDefects>(async candidates=>{
  for(const c of candidates) await db.update(catalogOutputs).set({status:"staged",flags:[]}).where(eq(catalogOutputs.id,c.outputId));
  return new Set(candidates.map(c=>c.outputId));
 });
 expect((await run(w,s)).outcome).toBe("published");
 expect(w.deps.repairOwnDefects).toHaveBeenCalledWith([expect.objectContaining({n:1,channel:"noon",flags:expect.arrayContaining(["halo"])})],expect.objectContaining({productId:s.product.id}));
},60_000);
it("judge views: a size chart is left out with its note and never held, even as photo 1",async()=>{
 const w=world(),s=await seed(w,"qa-views-chart",{shots:["a","b","c"]});
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(w.deps.judgeOutput).mockImplementation(judgeWith((input):JudgePick=>input.n===3 ? {view:"chart",flags:["chart_image"]}:{}));
 expect((await run(w,s)).outcome).toBe("published");
 const chart=(await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,s.batch.id),eq(catalogOutputs.n,3))))[0]!;
 expect(chart).toMatchObject({status:"skipped",isLive:false,reason:"This photo is a size chart or a text-only image, so it was left out of the marketplace images. Nothing to do.",qaScores:{autoAction:"drop",view:"chart",evidence:{chart_image:{model:"test/judge"}}}});
 expect(chart.flags).toContain("chart_image");expect(chart.flags).not.toContain("auto_dropped");
 // A chart in first place is left out too; the next photo becomes photo 1 and nothing is held.
 const t=world(),first=await seed(t,"qa-views-chart-first",{shots:["a","b"]});
 vi.mocked(t.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(t.deps.judgeOutput).mockImplementation(judgeWith((input):JudgePick=>input.n===1 ? {view:"chart",flags:["chart_image"],scores:{no_text_or_watermark:5}}:{}));
 expect((await run(t,first)).outcome).toBe("published");
 const outputs=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,first.batch.id));
 expect(outputs.find(o=>o.n===1)).toMatchObject({status:"skipped",flags:expect.not.arrayContaining(["text_or_watermark"])});
 expect(outputs.find(o=>o.n===2)).toMatchObject({status:"verified",isLive:true});
 expect(outputs.filter(o=>o.status==="needs_attention")).toHaveLength(0);
},60_000);
it("judge views: product_removed goes to the re-render loop, never straight to a hold",async()=>{
 const w=world(),s=await seed(w,"qa-views-removed");
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(w.deps.judgeOutput).mockImplementation(judgeWith(()=>({scores:{product_intact:10},evidence:{product_removed:"Only the gold logo is left; the orange leather around it is gone."}})));
 w.deps.repairOwnDefects=vi.fn<RepairOwnDefects>(async candidates=>{
  for(const c of candidates) await db.update(catalogOutputs).set({status:"staged",flags:[]}).where(eq(catalogOutputs.id,c.outputId));
  return new Set(candidates.map(c=>c.outputId));
 });
 // Photo 1 with our own defect is re-made first; once the loop fixes it, it is published.
 expect((await run(w,s)).outcome).toBe("published");
 expect(w.deps.repairOwnDefects).toHaveBeenCalledWith([expect.objectContaining({n:1,flags:expect.arrayContaining(["product_removed"])})],expect.anything());
 // Not fixed: photo 3 of four is left out with the drop note, the product still goes live.
 const t=world(),many=await seed(t,"qa-views-removed-drop",{shots:["a","b","c","d"]});
 vi.mocked(t.deps.resolvePolicy).mockResolvedValue(judgePolicy);
 vi.mocked(t.deps.judgeOutput).mockImplementation(judgeWith((input):JudgePick=>input.n===3 ? {scores:{product_intact:10},evidence:{product_removed:"The fabric around the logo is gone."}}:{}));
 t.deps.repairOwnDefects=vi.fn<RepairOwnDefects>(async()=>new Set<string>());
 expect((await run(t,many)).outcome).toBe("published");
 expect(t.deps.repairOwnDefects).toHaveBeenCalledWith([expect.objectContaining({n:3,flags:expect.arrayContaining(["product_removed"])})],expect.anything());
 const removed=(await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,many.batch.id),eq(catalogOutputs.n,3))))[0]!;
 expect(removed).toMatchObject({status:"skipped",qaScores:{autoAction:"drop",product_intact:10,evidence:{product_removed:{sentence:"The fabric around the logo is gone."}}}});
 expect(removed.flags).toEqual(expect.arrayContaining(["product_removed","auto_dropped"]));
},60_000);
it("spec07 a spending cap hit before QA marks outputs qa_cap, completes the chunk and shows the banner",async()=>{
 const w=world(),s=await seed(w,"qa-cap");
 for(let i=0;i<2;i++) await handleChunkTask(w.deps,{chunkId:s.chunk.id});
 vi.stubEnv("DAILY_SPEND_CAP_USD","0");
 try { expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200); } finally { vi.unstubAllEnvs(); }
 expect(w.deps.judgeOutput).not.toHaveBeenCalled();
 expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id)))[0]!.status).toBe("done");
 const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 expect(output).toMatchObject({status:"needs_attention",reason:"Quality check paused: the spending limit was reached. Look at this image yourself, or raise the limit and start a new batch."});expect(output!.flags).toContain("qa_cap");
 expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("held");
 expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");
 const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
 expect(deriveBatchState(batch!).text).toContain(QA_CAP_BANNER);
},60_000);

const flagHalo:CatalogDeps["judgeOutput"]=async input=>({scores:{complete_product:95,same_product:95,edge_quality:20,background_clean:20,no_text_or_watermark:95,orientation_ok:95,product_intact:95,placement_ok:95,overall:(95*5+40)/7},verdict:"flag",reasons:[],isCollage:false,costUsd:0,calls:0,usage:{},model:input.model,flags:["halo"]});
it("spec07 a decision-triggered publish during the qa stage never copies unjudged staged outputs",async()=>{
 const w=world(),s=await seed(w,"qa-race");
 for(let i=0;i<2;i++) await handleChunkTask(w.deps,{chunkId:s.chunk.id});
 const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 expect(output).toMatchObject({status:"staged",qaScores:null});
 expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("held");
 expect(w.copy).not.toHaveBeenCalled();
 await handleChunkTask(w.deps,{chunkId:s.chunk.id});
 expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");
},60_000);
it("spec07 use_as_is releases the publish gate and the product goes live on the next publish",async()=>{
 const w=world(),s=await seed(w,"use-as-is");
 vi.mocked(w.deps.judgeOutput).mockImplementation(flagHalo);
 expect((await run(w,s)).outcome).toBe("held");
 expect(w.copy).not.toHaveBeenCalled();
 const [flagged]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 expect(flagged).toMatchObject({status:"needs_attention"});
 await applyDecision(db,{outputId:flagged!.id,decision:"use_as_is",actor:"operator@opptra.com"});
 expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");
 expect(w.copy).toHaveBeenCalledTimes(1);
 expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,flagged!.id)))[0]).toMatchObject({isLive:true,decision:"use_as_is"});
},60_000);
it("spec07 remove on a live shot deletes only that product's object on the batch's channels",async()=>{
 const w=world(),s=await seed(w,"remove-live",{shots:["one","two"],channels:["noon","amazon"]});
 await run(w,s);
 const other=await seed(w,"remove-other",{channels:["noon","amazon"]});
 await run(w,other);
 const next=await seed(w,"remove-live-2",{productId:s.product.id,shots:["changed","two"]});
 vi.mocked(w.deps.judgeOutput).mockImplementation(flagHalo);
 expect((await run(w,next)).outcome).toBe("held");
 const [flagged]=await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,next.batch.id),eq(catalogOutputs.n,1)));
 expect(flagged).toMatchObject({status:"needs_attention",channel:"noon"});
 w.remove.mockClear();
 await applyDecision(db,{outputId:flagged!.id,decision:"remove",actor:"operator@opptra.com"});
 expect((await handlePublishTask(w.deps,{batchId:next.batch.id,productId:s.product.id})).outcome).toBe("published");
 expect(w.remove.mock.calls.map(call=>call[0])).toEqual([publicObjectPath("anta","remove-live","noon",1,true)]);
 const live=await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,s.product.id),eq(catalogOutputs.isLive,true)));
 expect(live.map(o=>`${o.channel}:${o.n}`).sort()).toEqual(["amazon:1","amazon:2","noon:2"]);
 expect(await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,other.product.id),eq(catalogOutputs.isLive,true)))).toHaveLength(2);
},60_000);
it("spec07 a malformed judge reply retries once, then qa_unavailable; spend_days keeps catalog_qa and catalog_compute rows",async()=>{
 const w=world(),s=await seed(w,"qa-malformed");
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue({matteModel:"fixture",qaModel:"test/judge",threshold:75,floor:60,qaMode:"per_source",qaSampleRate:1,source:"default"});
 for(let i=0;i<2;i++) await handleChunkTask(w.deps,{chunkId:s.chunk.id});
 const real=await sharp({create:{width:64,height:64,channels:3,background:"white"}}).jpeg().toBuffer();
 for(const [uri,obj] of w.objects) if(uri.includes(s.batch.id)) w.objects.set(uri,{...obj,buf:real});
 const publicFetch=w.deps.fetch;
 const llm=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:"not JSON"}}],usage:{cost:0.002}})));
 w.deps.fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>String(url).startsWith("https://openrouter.ai/")?llm():publicFetch(url,init));
 w.deps.judgeOutput=judgeOutput;
 vi.stubEnv("OPENROUTER_API_KEY","test-key");
 try { expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200); } finally { vi.unstubAllEnvs(); }
 expect(llm).toHaveBeenCalledTimes(2);
 const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 expect(output).toMatchObject({status:"needs_attention",reason:"The quality check could not read this image."});
 expect(output!.flags).toContain("qa_unavailable");
 const spend=await db.select().from(spendDays).where(eq(spendDays.batchId,s.batch.id));
 expect(spend.filter(row=>row.engine==="catalog_qa").reduce((sum,row)=>sum+Number(row.costUsd),0)).toBeCloseTo(0.004);
 expect(spend.every(row=>row.brandSlug==="anta")).toBe(true);
 expect(new Set(spend.map(row=>row.engine))).toEqual(new Set(["catalog_qa","catalog_compute"]));
 const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
 expect(batch!.cost).toMatchObject({qaCalls:2});
 expect(Number(batch!.cost.qaUsd)).toBeCloseTo(0.004);
},60_000);
/** A non-streaming OpenRouter chat completion in its production shape; `cost` is dropped when null. */
const openRouterReply=(content:string,cost:number|null=0.000139)=>({id:"gen-1760900000-abc",provider:"Google",model:"test/judge",object:"chat.completion",created:1760900000,
 choices:[{finish_reason:"stop",native_finish_reason:"STOP",index:0,message:{role:"assistant",content,refusal:null}}],
 usage:{prompt_tokens:2911,completion_tokens:160,total_tokens:3071,...(cost===null ? {}:{cost}),is_byok:false,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:0}}});
const passScores=JSON.stringify({complete_product:95,same_product:95,edge_quality:95,background_clean:95,no_text_or_watermark:95,orientation_ok:95,product_intact:95,placement_ok:95,is_collage:false,reasons:[]});
async function judgeOnceLive(name:string,respond:()=>Promise<Response>) {
 const w=world(),s=await seed(w,name),log=vi.fn();
 vi.mocked(w.deps.resolvePolicy).mockResolvedValue({matteModel:"fixture",qaModel:"test/judge",threshold:75,floor:60,qaMode:"per_source",qaSampleRate:1,source:"default"});
 for(let i=0;i<2;i++) await handleChunkTask(w.deps,{chunkId:s.chunk.id});
 const real=await sharp({create:{width:64,height:64,channels:3,background:"white"}}).jpeg().toBuffer();
 for(const [uri,obj] of w.objects) if(uri.includes(s.batch.id)) w.objects.set(uri,{...obj,buf:real});
 const publicFetch=w.deps.fetch;
 const llm=vi.fn(respond);
 w.deps.fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>String(url).startsWith("https://openrouter.ai/")?llm():publicFetch(url,init));
 w.deps.judgeOutput=judgeOutput;w.deps.log=log;
 vi.stubEnv("OPENROUTER_API_KEY","test-key");
 try { expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200); } finally { vi.unstubAllEnvs(); }
 expect(llm).toHaveBeenCalledTimes(1);
 const spend=(await db.select().from(spendDays).where(and(eq(spendDays.batchId,s.batch.id),eq(spendDays.engine,"catalog_qa"))));
 const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
 const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
 return {spend,batch:batch!,log,output:output!};
}
const reply=(cost:number|null)=>async()=>new Response(JSON.stringify(openRouterReply(passScores,cost)));
it("spec07 judge spend: OpenRouter's billed usage.cost and tokens reach spend_days and the batch cost, and the call is logged",async()=>{
 const {spend,batch,log}=await judgeOnceLive("qa-spend-billed",reply(0.000139));
 expect(log).toHaveBeenCalledWith("catalog_qa call",expect.objectContaining({batchId:batch.id,model:"test/judge",status:200,costUsd:0.000139,estimated:false,promptTokens:2911,completionTokens:160}));
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/test-key|base64/);
 expect(spend).toHaveLength(1);
 expect(spend[0]).toMatchObject({calls:1,brandSlug:"anta"});expect(Number(spend[0]!.costUsd)).toBeCloseTo(0.000139,9);
 expect(batch.cost).toMatchObject({qaCalls:1,qaPromptTokens:2911,qaCompletionTokens:160});expect(Number(batch.cost.qaUsd)).toBeCloseTo(0.000139,9);
 expect(log.mock.calls.filter(([message])=>/usage\.cost absent/.test(String(message)))).toHaveLength(0);
},60_000);
it("spec07 judge spend: a reply without usage.cost is recorded at the per-check estimate and logged, never 0",async()=>{
 const {spend,batch,log}=await judgeOnceLive("qa-spend-estimated",reply(null));
 expect(Number(spend[0]!.costUsd)).toBeCloseTo(QA_USD_PER_CHECK_FALLBACK,9);
 expect(Number(batch.cost.qaUsd)).toBeCloseTo(QA_USD_PER_CHECK_FALLBACK,9);
 expect(batch.cost).toMatchObject({qaCalls:1,qaPromptTokens:2911,qaCompletionTokens:160});
 expect(log).toHaveBeenCalledWith(expect.stringMatching(/usage\.cost absent; recorded the estimated price/),{batchId:batch.id});
},60_000);
it("spec07 an auth failure is logged at warn with its status before it becomes qa_unavailable, and costs nothing",async()=>{
 const {spend,batch,log,output}=await judgeOnceLive("qa-auth-failure",async()=>new Response(JSON.stringify({error:{message:"No auth credentials found",code:401}}),{status:401}));
 expect(output.flags).toContain("qa_unavailable");
 expect(log).toHaveBeenCalledWith("catalog_qa call failed",expect.objectContaining({severity:"WARNING",status:401,kind:"auth",error:"No auth credentials found",costUsd:0,batchId:batch.id}));
 expect(log).toHaveBeenCalledWith("catalog_qa: quality check unavailable",expect.objectContaining({severity:"WARNING",status:401,kind:"auth",batchId:batch.id}));
 expect(Number(spend[0]!.costUsd)).toBe(0);expect(spend[0]!.calls).toBe(1);
 expect(JSON.stringify(log.mock.calls)).not.toContain("test-key");
},60_000);
it("spec07 a judge timeout is logged at warn before it becomes qa_unavailable",async()=>{
 const {log,output}=await judgeOnceLive("qa-timeout",async()=>{throw new DOMException("The operation was aborted due to timeout","TimeoutError");});
 expect(output.flags).toContain("qa_unavailable");
 expect(log).toHaveBeenCalledWith("catalog_qa call failed",expect.objectContaining({severity:"WARNING",status:0,kind:"timeout"}));
 expect(log).toHaveBeenCalledWith("catalog_qa: quality check unavailable",expect.objectContaining({severity:"WARNING",status:0,kind:"no_response"}));
},60_000);
describe("spec07 caps count the recorded judge spend",()=>{
 const url="https://openrouter.ai/api/v1/chat/completions";
 async function capWorld(name:string,options:Record<string,unknown>,day:string) {
  const w=world();
  w.deps.now=()=>new Date(day);
  const upstream=vi.fn(async()=>new Response(JSON.stringify(openRouterReply(passScores))));
  w.deps.fetch=upstream as unknown as typeof globalThis.fetch;
  const [batch]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name,isTest:true,createdBy:"test@opptra.com",options:{...DEFAULT_BATCH_OPTIONS,...options}}).returning();
  const underClaim=(async(write:(conn:Db)=>Promise<unknown>)=>write(db)) as UnderClaim;
  return {llm:catalogLlmDeps(w.deps,batch!,underClaim),upstream,batch:batch!};
 }
 const recorded=async(batchId:string)=>(await db.select().from(spendDays).where(eq(spendDays.batchId,batchId))).reduce((sum,row)=>sum+Number(row.costUsd),0);
 it("the batch QA cap refuses the call after the recorded spend reaches it",async()=>{
  const {llm,upstream,batch}=await capWorld("qa-cap-recorded",{qaCapUsd:0.00025},"2031-05-05T10:00:00Z");
  await llm.fetch(url,{method:"POST"});await llm.fetch(url,{method:"POST"});
  expect(await recorded(batch.id)).toBeCloseTo(0.000278,9);
  await expect(llm.fetch(url,{method:"POST"})).rejects.toBeInstanceOf(CatalogQaCapError);
  expect(upstream).toHaveBeenCalledTimes(2);expect(()=>llm.assertAvailable()).toThrow(/Batch QA spend cap reached/);
 });
 it("the daily cap refuses the call after the day's recorded spend reaches DAILY_SPEND_CAP_USD",async()=>{
  const {llm,upstream}=await capWorld("qa-daily-recorded",{},"2031-06-06T10:00:00Z");
  vi.stubEnv("DAILY_SPEND_CAP_USD","0.00025");
  try {
   await llm.fetch(url,{method:"POST"});await llm.fetch(url,{method:"POST"});
   await expect(llm.fetch(url,{method:"POST"})).rejects.toThrow(/Daily spend cap reached/);
  } finally { vi.unstubAllEnvs(); }
  expect(upstream).toHaveBeenCalledTimes(2);
 });
});
it("spec07 SKU mapping adds ids and bumps the export to links-v<k+1>",async()=>{
 const w=world(),s=await seed(w,"sku-map");
 expect((await run(w,s)).outcome).toBe("published");
 expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");
 const [first]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
 expect(first!.sheetXlsxUri).toContain("links-v1.xlsx");
 await db.insert(brandMaster).values({name:"Anta",slug:"anta",line:"softline",source:"manual"}).onConflictDoNothing();
 await db.insert(catalogProductAliases).values({brandSlug:"anta",isTest:true,productId:s.product.id,aliasKey:"SKUMAP",kind:"identifier"}).onConflictDoNothing();
 expect(await applySkuMap(db,{batchId:s.batch.id,rows:[["identifier","opptra_sku_id"],["sku-map","OPP-1;OPP-2"],["nope","OPP-3"]],actor:"operator@opptra.com"})).toMatchObject({added:2,matched:1,unmatched:["NOPE"]});
 expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");
 const [again]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));
 expect(again!.sheetXlsxUri).toContain("links-v2.xlsx");
 expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id,s.product.id)))[0]!.opptraSkuIds).toEqual(["OPP-1","OPP-2"]);
 expect(w.copy).toHaveBeenCalledTimes(1);
},60_000);
it("spec08 an eval batch runs exactly its forced policy; a batch without evalSet still resolves per product; an unlisted forced model never falls back",async()=>{
 const w=world();
 const forced={matteModel:"forced-model",matteTarget:"cpu" as const,qaModel:"test/judge",threshold:75,floor:60,qaMode:"per_output" as const,qaSampleRate:1,source:"manual" as const};
 vi.mocked(w.deps.matting.health).mockResolvedValue({ok:true,models:[{id:"fixture",inputSize:1024,target:"cpu"},{id:"forced-model",inputSize:1024,target:"cpu"}],default:"fixture",versions:{cpu:null,gpu:null}});
 const evalRun=await seed(w,"eval-forced");
 await db.update(catalogBatches).set({options:{...DEFAULT_BATCH_OPTIONS,evalSet:"anta",policy:forced}}).where(eq(catalogBatches.id,evalRun.batch.id));
 await run(w,evalRun);
 expect(vi.mocked(w.deps.matteFor).mock.calls.at(-1)![2]).toBe("forced-model");
 expect(w.deps.resolvePolicy).not.toHaveBeenCalledWith("anta",expect.anything());
 const normal=await seed(w,"not-eval");
 await db.update(catalogBatches).set({options:{...DEFAULT_BATCH_OPTIONS,policy:forced}}).where(eq(catalogBatches.id,normal.batch.id));
 await run(w,normal);
 expect(vi.mocked(w.deps.matteFor).mock.calls.at(-1)![2]).toBe("fixture");
 const unlisted=await seed(w,"eval-unlisted");
 await db.update(catalogBatches).set({options:{...DEFAULT_BATCH_OPTIONS,evalSet:"anta",policy:{...forced,matteModel:"not-listed"}}}).where(eq(catalogBatches.id,unlisted.batch.id));
 expect((await handleChunkTask(w.deps,{chunkId:unlisted.chunk.id})).httpStatus).not.toBe(200);
 expect(vi.mocked(w.deps.matteFor).mock.calls.map(c=>c[2])).not.toContain("not-listed");
 expect(vi.mocked(w.deps.matteFor).mock.calls.map(c=>c[2]).filter(m=>m==="fixture")).toHaveLength(1);
},60_000);

// 05 rule 3 and 07 4.3: the shadow decision follows the product's own classification, never the
// batch's "auto" placeholder, the brand line or SKU rows. Unclassified products get no synthesised shadow.
describe("shadow decision input",()=>{
 async function renderStages(w:ReturnType<typeof world>,name:string,classify?:CatalogDeps["classifyProductType"]) {
  const s=await seed(w,name);
  if(classify) w.deps.classifyProductType=vi.fn(classify);
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  const ctx=vi.mocked(w.deps.renderAllChannels).mock.calls.at(-1)![3];
  const [product]=await db.select().from(catalogProducts).where(eq(catalogProducts.id,s.product.id));
  const outputs=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
  return {s,ctx,product:product!,outputs};
 }
 it("never stores the auto placeholder on a product, so the classifier still runs",async()=>{
  const [batch]=await db.insert(catalogBatches).values({brandSlug:"test_brand",brandName:"Test Brand",name:"auto-ingest",isTest:true,createdBy:"test@opptra.com"}).returning();
  expect(batch!.productType).toBe("auto");
  const {product}=await findOrCreateProduct(db,{brandSlug:"test_brand",isTest:true,identifier:"FC-AUTO-1",skus:null,productType:batch!.productType,actor:"test@opptra.com"});
  expect(product.productType).toBeNull();
  const forced=await findOrCreateProduct(db,{brandSlug:"test_brand",isTest:true,identifier:"FC-FORCED-1",skus:null,productType:"apparel_model",actor:"test@opptra.com"});
  expect(forced.product.productType).toBe("apparel_model");
 },60_000);
 it("classifies a product left as auto by an earlier ingest and renders an apparel_model photo with no synthesised shadow",async()=>{
  const w=world(),s=await seed(w,"fc-legacy-auto");
  await db.update(catalogProducts).set({productType:"auto"}).where(eq(catalogProducts.id,s.product.id));
  w.deps.classifyProductType=vi.fn<CatalogDeps["classifyProductType"]>(async()=>({type:"apparel_model",confidence:.9,costUsd:0,calls:1,usage:{},flags:[]}));
  await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});
  expect(w.deps.classifyProductType).toHaveBeenCalledTimes(1);
  expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id,s.product.id)))[0]!.productType).toBe("apparel_model");
  expect(vi.mocked(w.deps.renderAllChannels).mock.calls.at(-1)![3]).toMatchObject({productType:"apparel_model",synthesiseShadow:false});
 },60_000);
 it("lets a footwear classification synthesise",async()=>{
  const r=await renderStages(world(),"anta-footwear");
  expect(r.product.productType).toBe("footwear");
  expect(r.ctx).toMatchObject({productType:"footwear",synthesiseShadow:true});
 },60_000);
 it("forbids synthesis for an apparel_model classification",async()=>{
  const r=await renderStages(world(),"fc-model",async()=>({type:"apparel_model",confidence:.9,costUsd:0,calls:1,usage:{},flags:[]}));
  expect(r.ctx).toMatchObject({productType:"apparel_model",synthesiseShadow:false});
 },60_000);
 it("forbids synthesis and keeps type_unknown when the classification failed",async()=>{
  const r=await renderStages(world(),"fc-failed",async()=>({type:"other",confidence:0,costUsd:0,calls:2,usage:{},flags:["type_unknown"]}));
  expect(r.ctx).toMatchObject({productType:"other",synthesiseShadow:false});
  expect(r.outputs.every(o=>o.flags.includes("type_unknown"))).toBe(true);
 },60_000);
 it("forbids synthesis on the mocked classifier path and flags type_unknown",async()=>{
  const r=await renderStages(world(),"fc-mocked",cannedQa.classifyProductType);
  expect(r.ctx).toMatchObject({synthesiseShadow:false});
  expect(r.outputs.every(o=>o.flags.includes("type_unknown"))).toBe(true);
 },60_000);
});
it("records an upscaled output with the upscaler in its render_key, as information, and skips it when unchanged",async()=>{
  const w=world(),s=await seed(w,"upscaled"),model="realesrgan-x2plus";
  const render=vi.mocked(w.deps.renderAllChannels),base=render.getMockImplementation()!;
  render.mockImplementation(async(...args)=>Object.fromEntries(Object.entries(await base(...args)).map(([c,o])=>[c,{...o,flags:["upscaled"],upscale:{model,ms:321}}])) as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>);
  expect((await run(w,s)).outcome).toBe("published");
  expect(render.mock.calls.at(-1)![3]).toMatchObject({trace:{batchId:s.batch.id,productId:s.product.id}});
  const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));
  const plain=renderKey({sourceSha256:"sha",channel:"noon",n:1,policyKey:"default|fixture"});
  expect(output).toMatchObject({status:"verified",isLive:true,renderKey:upscaledRenderKey(plain,model)});
  expect(output!.flags).toContain("upscaled");
  // A re-run of the same photo with the upscaler on finds the upscaled key and makes nothing new.
  vi.stubEnv("UPSCALE_MODEL",model);
  try {
    const again=await seed(w,"upscaled-again",{productId:s.product.id}),calls=render.mock.calls.length;
    await run(w,again);
    expect(await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,again.batch.id))).toEqual([]);
    expect(render.mock.calls.length).toBe(calls);
  } finally { vi.unstubAllEnvs(); }
},60_000);
