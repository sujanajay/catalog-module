import { afterAll,beforeAll,expect,it,vi } from "vitest";
import { and,eq,sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches,catalogBatchProducts,catalogChunks,catalogOutputs,catalogProducts,catalogProductEvents,catalogSourceImages,catalogUploads,EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { workerCatalogDeps,type CatalogDeps } from "./deps";
import { UnsupportedSourceError } from "@catalog/core/catalog/render";
import { handleSweep } from "./sweep";
import { handleChunkTask } from "./chunk";
import { handlePublishTask } from "./publish";
import { handleFinalizeTask } from "./finalize";
import { renderKey } from "@catalog/core/catalog/pipeline/publish";
import { compareXlsxCsv,writeLinksXlsx } from "@catalog/core/catalog/sheet";
import { workbookCsvSheets } from "@catalog/core/catalog/pipeline/report";
import { cleanupTestBatch,cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
vi.mock(import("@catalog/core/catalog/sheet"),async original=>{const module=await original();return {...module,compareXlsxCsv:vi.fn(module.compareXlsxCsv)};});
let db:Db,close:()=>Promise<void>;
beforeAll(async()=>{({db,close}=await createTestDb());},60_000);
afterAll(async()=>{await close();});
const jpeg=Buffer.from([255,216,255,1]);
function world() {
  const objects=new Map<string,{buf:Buffer;mime:string;generation:string;crc32c:string}>();
  let generation=100;
  const upload=async(path:string,buf:Buffer,mime:string)=>{const uri=`gs://assets/${path}`;objects.set(uri,{buf,mime,generation:String(++generation),crc32c:buf.toString("base64")});return uri;};
  const copy=vi.fn(async(uri:string,path:string,condition:storage.GenerationPrecondition)=>{const obj=objects.get(uri)!;const target=`gs://public/${path}`,old=objects.get(target);if(String(condition.ifGenerationMatch)!==String(old?.generation ?? 0))throw new storage.GenerationMismatchError(path);const next={...obj,generation:String(++generation)};objects.set(target,next);return{generation:next.generation,crc32c:next.crc32c};});
  const remove=vi.fn(async(path:string)=>objects.delete(`gs://public/${path}`));
  const fetch=vi.fn<typeof globalThis.fetch>(async(url)=>{const path=new URL(String(url)).pathname.replace(/^\/public\//,"");const obj=objects.get(`gs://public/${path}`);return obj ? new Response(new Uint8Array(obj.buf),{headers:{"content-type":obj.mime,"content-length":String(obj.buf.length),"x-goog-generation":obj.generation}}):new Response(null,{status:404});});
  const base=workerCatalogDeps(db);
  const deps:CatalogDeps={...base,fetch,now:()=>new Date("2026-01-01T00:00:00Z"),log:()=>{},enqueue:vi.fn(async()=>"task"),resolvePolicy:vi.fn<CatalogDeps["resolvePolicy"]>(async()=>({matteModel:"fixture",qaModel:"",threshold:75,floor:60,qaMode:"per_source",qaSampleRate:1,source:"default"})),
    storage:{...storage,getBucketName:()=>"assets",getPublicBucketName:()=>"public",uploadBuffer:upload,downloadBuffer:async uri=>{const o=objects.get(uri);if(!o)throw new Error(`No object ${uri}`);return {buf:o.buf,mime:o.mime};},headObject:async uri=>{const o=objects.get(uri);return o ? {exists:true,size:o.buf.length,contentType:o.mime,generation:o.generation,crc32c:o.crc32c}:{exists:false,size:null,contentType:null,generation:null,crc32c:null};},stageCopyToPublic:copy,deletePublicObject:remove,setCustomTime:vi.fn(async()=>{})},
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
async function run(w:ReturnType<typeof world>,s:Awaited<ReturnType<typeof seed>>) {expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200);expect((await handleChunkTask(w.deps,{chunkId:s.chunk.id})).httpStatus).toBe(200);return handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id});}
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
it("holds undecided outputs with no public writes, then publishes once staged",async()=>{const w=world(),s=await seed(w,"held");await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});await db.update(catalogOutputs).set({status:"needs_attention",reason:"Check the edge."}).where(eq(catalogOutputs.batchId,s.batch.id));expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("held");expect(w.copy).not.toHaveBeenCalled();expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id,s.product.id)))[0]!.lockBatchId).toBe(s.batch.id);await db.update(catalogOutputs).set({status:"staged"}).where(eq(catalogOutputs.batchId,s.batch.id));expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");},60_000);
it("replaces changed bytes and deletes removed shots only on selected channels",async()=>{const w=world(),s=await seed(w,"overwrite",{shots:["one","two"],channels:["noon","amazon"]});await run(w,s);const next=await seed(w,"overwrite2",{productId:s.product.id,shots:["changed"]});await run(w,next);expect(w.remove).toHaveBeenCalledTimes(1);expect(w.remove.mock.calls[0]![0]).toContain("/noon/");const [pair]=await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,next.batch.id));expect(pair!.change).toBe("shots_removed");const events=await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId,next.batch.id));expect(events.map(e=>e.kind)).toEqual(expect.arrayContaining(["overwritten","shots_removed"]));const amazon=await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId,s.product.id),eq(catalogOutputs.channel,"amazon"),eq(catalogOutputs.isLive,true)));expect(amazon).toHaveLength(2);},60_000);
it("render keys include rules, policy, shot, channel and source",()=>{const input={sourceSha256:"one",channel:"noon" as const,n:1,policyKey:"default|fixture"};expect(new Set([renderKey(input),renderKey({...input,n:2}),renderKey({...input,channel:"amazon"}),renderKey({...input,policyKey:"other"}),renderKey({...input,rulesVersion:"next"}),renderKey({...input,sourceSha256:"two"})]).size).toBe(6);});
it("holds a product if its chunk failed before it could create planned outputs",async()=>{const w=world(),s=await seed(w,"missing-output");await db.update(catalogChunks).set({status:"failed"}).where(eq(catalogChunks.id,s.chunk.id));expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("held");expect(w.copy).not.toHaveBeenCalled();},60_000);
it("isolates one render exception and holds fallback mattes",async()=>{const w=world(),s=await seed(w,"render-error",{channels:["noon","amazon"]});vi.mocked(w.deps.renderAllChannels).mockRejectedValueOnce(new Error("Could not make this photo."));await run(w,s);const outputs=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));expect(outputs.map(o=>o.status)).toEqual(["failed","staged"]);expect(w.copy).not.toHaveBeenCalled();const fallback=await seed(w,"fallback");vi.mocked(w.deps.matteFor).mockResolvedValueOnce({alpha:Buffer.alloc(800*800,255),width:800,height:800,model:"floodfill",ms:0,source:"floodfill",target:null,sentLongSide:null});expect((await run(w,fallback)).outcome).toBe("held");const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,fallback.batch.id));expect(output!.flags).toContain("fallback_matte");expect(output!.reason).toContain("cut-out service was unavailable");},60_000);
it("re-copies only once before recording a public verification failure",async()=>{const w=world(),s=await seed(w,"verify-failure");w.deps.fetch=vi.fn(async()=>new Response(new Uint8Array(jpeg),{headers:{"content-type":"text/plain","content-length":"4","x-goog-generation":"wrong"}}));await handleChunkTask(w.deps,{chunkId:s.chunk.id});await handleChunkTask(w.deps,{chunkId:s.chunk.id});const result=await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id});expect(result.outcome).toBe("failed");expect(w.copy).toHaveBeenCalledTimes(2);const [output]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,s.batch.id));expect(output!.reason).toBe("Uploaded file could not be read back from the public link");},60_000);
it("leaves the batch unfinished when xlsx and csv differ",async()=>{const w=world(),s=await seed(w,"mismatch");await run(w,s);vi.mocked(compareXlsxCsv).mockResolvedValueOnce({equal:false,differences:["Identifier differs."]});expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("exports_mismatch");const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));expect(batch!.status).not.toBe("done");expect(batch!.error).toContain("Identifier differs.");},60_000);
it("writes a filled product list, repeats links per size, preserves the upload and records CSV exports",async()=>{const w=world(),s=await seed(w,"filled");const original=await writeLinksXlsx({channels:["noon"],rows:[7,8].map(size=>({brand:"Anta",identifier:`filled/${size}`,optionIdStyleColor:"",opptraSkuIds:[],links:{},status:"ok",notes:`size ${size}`,change:"new",changedAt:null}))});const originalUri=await w.upload(`catalog-test/anta/${s.batch.id}/uploads/list.xlsx`,original,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");await db.insert(catalogUploads).values({batchId:s.batch.id,kind:"product_list",name:"list.xlsx",gcsUri:originalUri,status:"collected",detected:{matchColumn:1}});await run(w,s);expect((await handleFinalizeTask(w.deps,{batchId:s.batch.id})).outcome).toBe("done");const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,s.batch.id));const report=JSON.parse(w.objects.get(batch!.reportUri!)!.buf.toString());expect(report.exports.filledProductList.csv).toHaveLength(1);const filled=await workbookCsvSheets(w.objects.get(report.exports.filledProductList.xlsx)!.buf);expect(filled[0]!.csv).toContain("link_status");expect(filled[0]!.csv.match(/https:\/\/storage.googleapis.com/g)).toHaveLength(2);expect(w.objects.get(originalUri)!.buf).toEqual(original);},60_000);
it("refuses production cleanup and cleans both passes only under test prefixes",async()=>{const w=world();const [production]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name:"production",createdBy:"test@opptra.com",isTest:false}).returning();const remove=vi.fn(async(uri:string)=>{expect(uri).toMatch(/^gs:\/\/(assets|public)\/catalog-test\//);return 1;});const deps={...w.deps.storage,deleteTestObjects:remove};await expect(cleanupTestBatch(db,deps,production!.id)).rejects.toThrow("catalog-test/");expect(remove).not.toHaveBeenCalled();const first=await seed(w,"cleanup");await run(w,first);const second=await seed(w,"cleanup2",{productId:first.product.id});await run(w,second);await expect(cleanupTestBatch(db,deps,first.batch.id)).rejects.toThrow("shared");await expect(cleanupTestBatches(db,deps,[first.batch.id,second.batch.id])).resolves.toEqual({objects:3});expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id,first.product.id)))).toHaveLength(0);},60_000);
it("recovers uploaded matte and staging caches after a crash before their final DB updates",async()=>{const w=world(),s=await seed(w,"crash");await handleChunkTask(w.deps,{chunkId:s.chunk.id});await db.update(catalogChunks).set({stage:"matte",status:"queued"}).where(eq(catalogChunks.id,s.chunk.id));await db.update(catalogSourceImages).set({matteUri:null}).where(eq(catalogSourceImages.batchId,s.batch.id));await handleChunkTask(w.deps,{chunkId:s.chunk.id});expect(w.deps.matteFor).toHaveBeenCalledTimes(1);await handleChunkTask(w.deps,{chunkId:s.chunk.id});await db.update(catalogChunks).set({stage:"render",status:"queued"}).where(eq(catalogChunks.id,s.chunk.id));await db.update(catalogOutputs).set({status:"pending",stagingUri:null}).where(eq(catalogOutputs.batchId,s.batch.id));await handleChunkTask(w.deps,{chunkId:s.chunk.id});expect(w.deps.renderAllChannels).toHaveBeenCalledTimes(1);expect((await handlePublishTask(w.deps,{batchId:s.batch.id,productId:s.product.id})).outcome).toBe("published");expect(w.copy).toHaveBeenCalledTimes(1);},60_000);

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
  expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id)))[0]).toMatchObject({stage:"render",status:"done"});
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
  expect((await db.select().from(catalogChunks).where(eq(catalogChunks.id,s.chunk.id)))[0]).toMatchObject({stage:"render",status:"done"});
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
