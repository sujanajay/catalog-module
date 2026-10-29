import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import { brandMaster,catalogBatches,catalogBatchProducts,catalogProductAliases,catalogProducts,catalogSourceImages,catalogOutputs,catalogEvalLabels,skuMap,users } from "@catalog/core/db/schema";
import { seedAdmin,upsertPerson } from "@catalog/core/people";
import { setDbForTests,type Db } from "../lib/db";
import { resetUserDeps } from "../lib/user";
import { POST as decide } from "../app/api/catalog/outputs/[id]/decision/route";
import { POST as label,GET as labels } from "../app/api/catalog/batches/[id]/eval-labels/route";
import { POST as replacement } from "../app/api/catalog/outputs/[id]/replacement/route";
import { POST as retryEnlargementRoute } from "../app/api/catalog/outputs/[id]/retry-enlargement/route";
import { catalogEnlargements,catalogProductEvents } from "@catalog/core/db/schema";
import { flagDetails } from "@catalog/core/catalog/qa/reasons";
import { plainWarningText,TRY_AGAIN_LABEL,TRY_AGAIN_STATUS,TRY_AGAIN_TOAST } from "../lib/catalog/copy";
import { POST as replacementComplete } from "../app/api/catalog/outputs/[id]/replacement/complete/route";
import { POST as skuMapPost } from "../app/api/catalog/batches/[id]/sku-map/route";
vi.mock(import("@catalog/core/tasks"),async original=>({...await original(),enqueueTask:vi.fn(async()=>"task")}));
vi.mock(import("@catalog/core/catalog/finalize-request"),async original=>{const module=await original();return {...module,enqueueFinalize:vi.fn(module.enqueueFinalize)};});
import { enqueueTask } from "@catalog/core/tasks";
import { enqueueFinalize } from "@catalog/core/catalog/finalize-request";
// Only the replacement route signs a URL here; no storage call leaves the test.
vi.mock(import("@catalog/core/storage"),async original=>({...await original(),getBucketName:()=>"private",signedPutUrl:vi.fn(async()=>"https://signed.example/put")}));
import { SKU_MAP_MAX_BYTES,SKU_MAP_TOO_LARGE } from "../lib/catalog/sku-map";
let db:Db,close:()=>Promise<void>,id:string,batchId:string;
beforeAll(async()=>{({db,close}=await createTestDb());setDbForTests(db);});afterAll(async()=>{setDbForTests(undefined);await close();});
beforeEach(async()=>{
 resetUserDeps();await db.delete(catalogOutputs);await db.delete(skuMap);await db.delete(catalogProducts);await db.delete(catalogBatches);await db.delete(users);
 await seedAdmin(db,"a@opptra.com");await upsertPerson(db,{email:"v@opptra.com",role:"viewer",addedBy:"a@opptra.com"});
 vi.stubEnv("SKIP_IAP","1");vi.stubEnv("DEV_USER_EMAIL","a@opptra.com");
 const [b]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name:"catalog-test-eval",isTest:true,options:{evalSet:"holdout",identifierMode:"filename",precedence:"uploads_then_links",sheetColumns:null,qaCapUsd:null},channels:["noon","styli"],createdBy:"a@opptra.com"}).returning();batchId=b!.id;
 const [p]=await db.insert(catalogProducts).values({brandSlug:"anta",identifier:"SHOE",productKey:"shoe",pathKey:"SHOE",isTest:true}).returning();
 await db.insert(catalogBatchProducts).values({batchId,productId:p!.id,change:"pending_attention"});
 const [s]=await db.insert(catalogSourceImages).values({batchId,productId:p!.id,n:1,sha256:"a",rawUri:"gs://private/one.jpg",originalName:"one.jpg",mime:"image/jpeg"}).returning();
 const [o]=await db.insert(catalogOutputs).values({batchId,productId:p!.id,sourceImageId:s!.id,n:1,channel:"noon",canvasW:1080,canvasH:1480,scale:1,placedX:0,placedY:0,renderKey:"key",objectPath:"catalog-test/one",publicUrl:"https://public/one",stagingUri:"gs://private/staged",status:"needs_attention",flags:["halo"],qaModel:"private/model",qaScores:{overall:50,edge_quality:20,verdict:"flag",model:"private/model"}}).returning();id=o!.id;
});afterEach(()=>vi.unstubAllEnvs());
const req=(body:unknown)=>new Request("http://localhost/api",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
it("operator decisions change real output state, return affected IDs and reject a second click",async()=>{
 let r=await decide(req({decision:"use_as_is"}),{params:Promise.resolve({id})});expect(r.status).toBe(200);expect(await r.json()).toMatchObject({outputIds:[id]});
 expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,id)))[0]!.status).toBe("staged");
 r=await decide(req({decision:"remove"}),{params:Promise.resolve({id})});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:"Already decided."});
});
it("viewer cannot decide or read/write eval labels",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","v@opptra.com");
 for(const r of [await decide(req({decision:"remove"}),{params:Promise.resolve({id})}),await label(req({outputId:id,label:"flag",reasons:["halo"],note:"edge"}),{params:Promise.resolve({id:batchId})}),await labels(new Request("http://localhost/api"),{params:Promise.resolve({id:batchId})})]){
 expect(r.status).toBe(403);expect(await r.json()).toEqual({error:"You can view this but not change it. Ask an admin for the operator role."});}
});
it("eval label records the numeric judge snapshot without changing image state or exposing model metadata",async()=>{
 const r=await label(req({outputId:id,label:"flag",reasons:["halo"],note:"edge"}),{params:Promise.resolve({id:batchId})});expect(r.status).toBe(200);
 const [stored]=await db.select().from(catalogEvalLabels);expect(stored).toMatchObject({outputId:id,label:"flag",judgeVerdict:"flag",judgeScores:{overall:50,edge_quality:20}});
 const out=(await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,id)))[0]!;expect(out.status).toBe("needs_attention");expect(out.decision).toBeNull();
 const result=await labels(new Request("http://localhost/api"),{params:Promise.resolve({id:batchId})});expect(result.status).toBe(200);expect(JSON.stringify(await result.json())).not.toContain("private/model");
});
const csv=(text:string)=>{const form=new FormData();form.append("file",new File([text],"map.csv",{type:"text/csv"}));return new Request("http://localhost/api",{method:"POST",body:form});};
it("viewer gets the 403 sentence from the replacement and SKU routes",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","v@opptra.com");
 for(const r of [await replacement(req({name:"SHOE_1.jpg",size:10,mime:"image/jpeg"}),{params:Promise.resolve({id})}),await replacementComplete(req({uploadId:crypto.randomUUID()}),{params:Promise.resolve({id})}),await skuMapPost(csv("identifier,opptra_sku_id\nSHOE,SKU1"),{params:Promise.resolve({id:batchId})})]){
 expect(r.status).toBe(403);expect(await r.json()).toEqual({error:"You can view this but not change it. Ask an admin for the operator role."});}
});
it("operator SKU mapping fills ids from a csv and lists unmatched rows",async()=>{
 await db.insert(brandMaster).values({name:"Anta",slug:"anta",line:"softline",source:"manual"}).onConflictDoNothing();
 const [p]=await db.select().from(catalogProducts);await db.insert(catalogProductAliases).values({brandSlug:"anta",isTest:true,productId:p!.id,aliasKey:"SHOE",kind:"identifier"});
 const r=await skuMapPost(csv("identifier,opptra_sku_id\nshoe,SKU1;SKU2\nNOPE,SKU3"),{params:Promise.resolve({id:batchId})});
 expect(r.status).toBe(200);expect(await r.json()).toEqual({added:2,matched:1,unmatched:["NOPE"]});
 expect((await db.select().from(catalogProducts))[0]!.opptraSkuIds).toEqual(["SKU1","SKU2"]);
 expect((await db.select().from(skuMap)).map(row=>row.source)).toEqual(["manual","manual"]);
 // Spec 18 H4: one re-open representation, the stored flag; the task body is only the batch id.
 expect(vi.mocked(enqueueFinalize)).toHaveBeenCalledWith(expect.objectContaining({enqueue:enqueueTask}),batchId,undefined,{reopen:true});
 expect(vi.mocked(enqueueTask)).toHaveBeenCalledWith("/tasks/catalog/finalize",{batchId},{});
 expect((await db.select().from(catalogBatches).where(eq(catalogBatches.id,batchId)))[0]!.counts.finalizePending).toBe(true);
});
it("a malformed output id answers 400 instead of a database error",async()=>{
 const r=await decide(req({decision:"use_as_is"}),{params:Promise.resolve({id:"not-a-uuid"})});expect(r.status).toBe(400);
});
it("operator gets one signed PUT URL for a replacement photo",async()=>{
 const r=await replacement(req({name:"SHOE_1.jpg",size:1000,mime:"image/jpeg"}),{params:Promise.resolve({id})});
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({signedPutUrl:"https://signed.example/put",uploadId:expect.any(String)});
});
it("refuses an oversized SKU mapping sheet before reading it",async()=>{
 const form=new FormData();form.append("file",new File([new Uint8Array(SKU_MAP_MAX_BYTES+1)],"map.csv",{type:"text/csv"}));
 const r=await skuMapPost(new Request("http://localhost/api",{method:"POST",body:form}),{params:Promise.resolve({id:batchId})});
 expect(r.status).toBe(400);expect(await r.json()).toEqual({error:SKU_MAP_TOO_LARGE});
});
it("admin keeps a held photo of a finished batch with Use as is (quality gate 2: Centrepoint photo 2 of bd-162637307S-2)",async()=>{
 // The gate-1 shape: the batch is done, the held product keeps its batch lock, photo 2 is held on Centrepoint only,
 // made and staged on the other channels and skipped for Styli (too small).
 await db.update(catalogBatches).set({status:"done",channels:["noon","centrepoint","styli"]}).where(eq(catalogBatches.id,batchId));
 const [p]=await db.select().from(catalogProducts);await db.update(catalogProducts).set({lockBatchId:batchId}).where(eq(catalogProducts.id,p!.id));
 const [s]=await db.insert(catalogSourceImages).values({batchId,productId:p!.id,n:2,sha256:"b",rawUri:"gs://private/two.jpg",originalName:"two.jpg",mime:"image/jpeg"}).returning();
 const row=(channel:"noon"|"centrepoint"|"styli",status:"staged"|"needs_attention"|"skipped",flags:("low_resolution"|"shadow_synthesised"|"leftover_background"|"placement")[])=>({batchId,productId:p!.id,sourceImageId:s!.id,n:2,channel,canvasW:1080,canvasH:1480,scale:1,placedX:0,placedY:0,renderKey:`k-${channel}`,objectPath:`catalog-test/two-${channel}`,publicUrl:`https://public/two-${channel}`,stagingUri:`gs://private/two-${channel}`,status,flags});
 const made=await db.insert(catalogOutputs).values([row("noon","staged",["shadow_synthesised"]),row("centrepoint","needs_attention",["low_resolution","shadow_synthesised","leftover_background","placement"]),row("styli","skipped",["low_resolution"])]).returning();
 const held=made.find(o=>o.channel==="centrepoint")!;
 const r=await decide(req({decision:"use_as_is"}),{params:Promise.resolve({id:held.id})});
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({batchId,outputIds:[held.id]});
 const after=await db.select().from(catalogOutputs).where(eq(catalogOutputs.sourceImageId,s!.id));
 expect(after.find(o=>o.id===held.id)).toMatchObject({status:"staged",decision:"use_as_is",decidedBy:"a@opptra.com"});
 expect(after.filter(o=>o.id!==held.id).map(o=>[o.channel,o.status,o.decision])).toEqual(expect.arrayContaining([["noon","staged",null],["styli","skipped",null]]));
});
/** T59 (spec 18 lifecycle 3.6): the held photo could not be enlarged; its row failed for good. */
async function heldForEnlargement(){
 await db.update(catalogOutputs).set({flags:["enlargement_failed"],scale:2.4,qaScores:null}).where(eq(catalogOutputs.id,id));
 const [o]=await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,id));
 await db.insert(catalogEnlargements).values({batchId,productId:o!.productId,sourceImageId:o!.sourceImageId,upscaler:"swinir-x2+cpu",factor:2,scale:2.4,outW:2400,outH:2400,route:"direct",pixelHash:"p",identityHash:"i",status:"failed",attempts:8,error:"The upscaler could not enlarge this photo.",errorKind:"bad_input"});
 return o!;
}
it("T59: Use as is on a photo that could not be enlarged answers the plain warning; with acceptPlain it is staged and recorded",async()=>{
 await heldForEnlargement();
 let r=await decide(req({decision:"use_as_is"}),{params:Promise.resolve({id})});
 expect(r.status).toBe(409);expect(await r.json()).toEqual({error:"plain_warning",channels:["noon"]});
 expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,id)))[0]).toMatchObject({status:"needs_attention",decision:null});
 r=await decide(req({decision:"use_as_is",acceptPlain:true}),{params:Promise.resolve({id})});
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({outputIds:[id]});
 expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,id)))[0]).toMatchObject({status:"staged",decision:"use_as_is",flags:["enlargement_failed"]});
 expect((await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId,batchId))).map(e=>e.kind)).toContain("plain_accepted");
 // A body that is not a boolean is refused before any change.
 r=await decide(req({decision:"use_as_is",acceptPlain:"yes"}),{params:Promise.resolve({id})});expect(r.status).toBe(400);
});
it("T59: Try again is operator only, answers 409 when nothing failed, and queues the photo's failed rows with a parked render",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","v@opptra.com");
 let r=await retryEnlargementRoute(req({}),{params:Promise.resolve({id})});
 expect(r.status).toBe(403);expect(await r.json()).toEqual({error:"You can view this but not change it. Ask an admin for the operator role."});
 vi.stubEnv("DEV_USER_EMAIL","a@opptra.com");
 r=await retryEnlargementRoute(req({}),{params:Promise.resolve({id})});
 expect(r.status).toBe(409);expect(await r.json()).toEqual({error:"Nothing to try again."});
 await heldForEnlargement();
 vi.mocked(enqueueTask).mockClear();
 r=await retryEnlargementRoute(req({}),{params:Promise.resolve({id})});
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({batchId,outputIds:[id],rows:1,retries:1});
 expect((await db.select().from(catalogEnlargements).where(eq(catalogEnlargements.batchId,batchId))).map(row=>[row.status,row.attempts,row.sends])).toEqual([["queued",0,1]]);
 expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id,id)))[0]).toMatchObject({status:"pending",flags:[]});
 expect(vi.mocked(enqueueTask).mock.calls.map(c=>c[0])).toEqual(["/tasks/catalog/enlarge"]);
 r=await retryEnlargementRoute(req({}),{params:Promise.resolve({id})});expect(r.status).toBe(409);
});
it("T59: the enlargement copy names no model",async()=>{
 const words=[plainWarningText(["Noon","Styli"]),TRY_AGAIN_LABEL,TRY_AGAIN_STATUS,TRY_AGAIN_TOAST,...Object.values(flagDetails("enlargement_failed"))].join(" ");
 expect(words).not.toMatch(/swinir|realesrgan|esrgan|x2|x4|model/i);
 expect(plainWarningText(["Noon","Styli"])).toBe("This photo could not be enlarged. If you use it as it is, the Noon and Styli images will be stretched and may look soft. Use it anyway?");
});
