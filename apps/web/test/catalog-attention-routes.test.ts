import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches,catalogBatchProducts,catalogProducts,catalogSourceImages,catalogOutputs,catalogEvalLabels,users } from "@catalog/core/db/schema";
import { seedAdmin,upsertPerson } from "@catalog/core/people";
import { setDbForTests,type Db } from "../lib/db";
import { resetUserDeps } from "../lib/user";
import { POST as decide } from "../app/api/catalog/outputs/[id]/decision/route";
import { POST as label,GET as labels } from "../app/api/catalog/batches/[id]/eval-labels/route";
vi.mock("@catalog/core/tasks",()=>({enqueueTask:vi.fn(async()=>"task")}));
let db:Db,close:()=>Promise<void>,id:string,batchId:string;
beforeAll(async()=>{({db,close}=await createTestDb());setDbForTests(db);});afterAll(async()=>{setDbForTests(undefined);await close();});
beforeEach(async()=>{
 resetUserDeps();await db.delete(catalogOutputs);await db.delete(catalogProducts);await db.delete(catalogBatches);await db.delete(users);
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
