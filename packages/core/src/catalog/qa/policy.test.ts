import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../../db/testing";
import type { Db } from "../../db/client";
import { catalogBatches, modelPolicy } from "../../db/schema";
import { recordCost } from "../../spend";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePolicy, ensureDefaultPolicies, strictestChannel, sampledForQa, defaultPolicyFor, shadowSynthesisAllowed, DEFAULT_POLICIES } from "./policy";
import { DEPLOYED_MATTE_MODELS } from "../matte";
import { checkCatalogCaps } from "./caps";
let db:Db, close:()=>Promise<void>;
beforeAll(async()=>{({db,close}=await createTestDb());});afterAll(async()=>close());
describe("catalog policies and caps",()=>{
 it("fills five built-in categories once and never overwrites measured rows",async()=>{
  await ensureDefaultPolicies(db,{models:[],default:"birefnet-general"});await ensureDefaultPolicies(db,{models:[],default:"birefnet-general"});
  expect(await db.select().from(modelPolicy)).toHaveLength(5);
  await db.update(modelPolicy).set({source:"bakeoff",matteModel:"measured"}).where(eq(modelPolicy.category,"footwear"));
  await ensureDefaultPolicies(db,{models:[],default:"birefnet-general"});expect((await resolvePolicy(db,"anta","footwear")).matteModel).toBe("measured");
 });
 it("no migration writes a cut-out model the services do not serve into a policy row",()=>{
  const folder=fileURLToPath(new URL("../../../drizzle/",import.meta.url));
  const statements=readdirSync(folder).filter(name=>name.endsWith(".sql")).flatMap(name=>readFileSync(folder+name,"utf8").split("--> statement-breakpoint").map(text=>text.replace(/^\s*--.*$/gm,"")));
  // What a statement writes comes before its WHERE; a WHERE may name a retired model, to replace it.
  const written=statements.filter(text=>/^\s*(UPDATE|INSERT INTO)\s+"model_policy"/.test(text)).flatMap(text=>[...text.split(/\bWHERE\b/)[0]!.matchAll(/'((?:birefnet|bria|rmbg|u2net|isnet|ben2|inspyrenet)[a-z0-9.-]*)'/g)].map(m=>m[1]));
  expect(written.length).toBeGreaterThan(0);
  for(const id of written) expect(DEPLOYED_MATTE_MODELS).toContain(id);
 });
 describe("migration 0031",()=>{
  const statements=readFileSync(fileURLToPath(new URL("../../../drizzle/0031_policy_served_second_models.sql",import.meta.url)),"utf8").split("--> statement-breakpoint");
  const migrate=async()=>{for(const statement of statements) await db.execute(sql.raw(statement));};
  type Row={brandSlug:string;category:"apparel_model"|"bag_accessory"|"other"|"apparel_flat";first?:string;second:string};
  const put=async(rows:Row[])=>{for(const r of rows) await db.insert(modelPolicy).values({brandSlug:r.brandSlug,category:r.category,matteModel:r.first ?? "bria-rmbg",matteModelSecond:r.second,qaModel:"q",threshold:80,floor:65,source:"default"}).onConflictDoUpdate({target:[modelPolicy.brandSlug,modelPolicy.category],set:{matteModel:r.first ?? "bria-rmbg",matteModelSecond:r.second}});};
  const second=async(brand:string,category:string)=>(await db.select().from(modelPolicy)).find(r=>r.brandSlug===brand && r.category===category)!.matteModelSecond;
  it("moves the three global rows that name a retired model, and can run twice",async()=>{
   await put([{brandSlug:"*",category:"apparel_model",second:"birefnet-dynamic-matting"},{brandSlug:"*",category:"bag_accessory",second:"birefnet-hr-matting"},{brandSlug:"*",category:"other",second:"birefnet-dynamic-matting"}]);
   const before=await db.select().from(modelPolicy);
   await migrate();await migrate();
   expect(await second("*","apparel_model")).toBe("birefnet-general-lite");
   expect(await second("*","bag_accessory")).toBe("birefnet-general");
   expect(await second("*","other")).toBe("birefnet-general");
   // The first choice, the source and the judge of a moved row stay as they were.
   for(const r of await db.select().from(modelPolicy)) { const old=before.find(b=>b.id===r.id)!; expect([r.matteModel,r.source,r.qaModel]).toEqual([old.matteModel,old.source,old.qaModel]); }
  });
  it("leaves a global row with a served second model, and a brand row even with a retired name",async()=>{
   await put([{brandSlug:"*",category:"apparel_model",second:"birefnet-hrsod"},{brandSlug:"*",category:"bag_accessory",second:"birefnet-hrsod"},{brandSlug:"*",category:"other",second:"birefnet-hrsod"},{brandSlug:"*",category:"apparel_flat",second:"birefnet-dynamic-matting"},
    {brandSlug:"m0031",category:"apparel_model",second:"birefnet-dynamic-matting"},{brandSlug:"m0031",category:"bag_accessory",second:"birefnet-hr-matting"},{brandSlug:"m0031",category:"other",second:"birefnet-dynamic-matting"}]);
   await migrate();
   for(const category of ["apparel_model","bag_accessory","other"]) expect(await second("*",category)).toBe("birefnet-hrsod");
   expect(await second("*","apparel_flat")).toBe("birefnet-dynamic-matting");
   expect(await second("m0031","apparel_model")).toBe("birefnet-dynamic-matting");
   expect(await second("m0031","bag_accessory")).toBe("birefnet-hr-matting");
   expect(await second("m0031","other")).toBe("birefnet-dynamic-matting");
   await db.update(modelPolicy).set({matteModelSecond:"birefnet-general"}).where(eq(modelPolicy.category,"apparel_flat"));
   await db.delete(modelPolicy).where(eq(modelPolicy.brandSlug,"m0031"));
  });
  it("never makes the second model the same as the first",async()=>{
   await put([{brandSlug:"*",category:"apparel_model",first:"birefnet-general-lite",second:"birefnet-dynamic-matting"},{brandSlug:"*",category:"bag_accessory",first:"birefnet-general",second:"birefnet-hr-matting"},{brandSlug:"*",category:"other",first:"birefnet-general",second:"birefnet-dynamic-matting"}]);
   await migrate();
   expect(await second("*","apparel_model")).toBe("birefnet-general");
   expect(await second("*","bag_accessory")).toBe("birefnet-general-lite");
   expect(await second("*","other")).toBe("birefnet-general-lite");
  });
 });
 it("resolves exact brand/category before brand wildcard, global category and global wildcard",async()=>{
  await db.insert(modelPolicy).values([{brandSlug:"anta",category:"*",matteModel:"brand",qaModel:"q",threshold:80,floor:65,source:"manual"},{brandSlug:"anta",category:"footwear",matteModel:"exact",qaModel:"q",threshold:80,floor:65,source:"manual"},{brandSlug:"*",category:"*",matteModel:"global",qaModel:"q",threshold:80,floor:65,source:"manual"}]);
  expect((await resolvePolicy(db,"anta","footwear")).matteModel).toBe("exact");expect((await resolvePolicy(db,"anta","other")).matteModel).toBe("brand");expect((await resolvePolicy(db,"fc","footwear")).matteModel).toBe("measured");expect((await resolvePolicy(db,"fc","*")).matteModel).toBe("global");
 });
 it("built-in rows follow the matting health listing: first, else second, else the service default",()=>{
  expect(defaultPolicyFor("footwear").matteModel).toBe("birefnet-general");
  expect(defaultPolicyFor("footwear",{models:[{id:"bria-rmbg"}],default:"bria-rmbg"}).matteModel).toBe("bria-rmbg");
  expect(defaultPolicyFor("footwear",{models:[{id:"birefnet-general"},{id:"bria-rmbg"}],default:"bria-rmbg"}).matteModel).toBe("birefnet-general");
  expect(defaultPolicyFor("footwear",{models:[{id:"u2net"}],default:"u2net"})).toMatchObject({matteModel:"u2net",matteModelSecond:"bria-rmbg",source:"default"});
 });
 it("every built-in policy names deployed matte models, first and second",()=>{
  const served=[...readFileSync(fileURLToPath(new URL("../../../../../services/matting/app.py",import.meta.url)),"utf8").match(/INPUT_SIZES = \{([\s\S]*?)\}/)![1]!.matchAll(/"([^"]+)":/g)].map(m=>m[1]);
  expect([...DEPLOYED_MATTE_MODELS].sort()).toEqual(served.sort());
  for(const policy of Object.values(DEFAULT_POLICIES)) for(const id of [policy.matteModel,policy.matteModelSecond]) expect(DEPLOYED_MATTE_MODELS).toContain(id);
  expect(DEFAULT_POLICIES.apparel_model).toMatchObject({matteModel:"birefnet-general",matteModelSecond:"birefnet-general-lite"});
 });
 it("chooses Styli first, then largest area, then stable marketplace order",()=>{
  expect(strictestChannel(["centrepoint","styli"])).toBe("styli");expect(strictestChannel(["noon","centrepoint"])).toBe("centrepoint");expect(strictestChannel(["namshi","noon"])).toBe("noon");
  expect(sampledForQa("ABC",.5)).toBe(sampledForQa("ABC",.5));expect(sampledForQa("ABC",0)).toBe(false);expect(sampledForQa("ABC",1)).toBe(true);
 });
 it("honours global UTC spend and batch QA cap without counting batch compute toward QA",async()=>{
  const now=new Date("2026-10-19T00:00:00Z");
  const [batch]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name:"Cap",createdBy:"op@opptra.com",options:{identifierMode:"filename",precedence:"uploads_then_links",sheetColumns:null,qaCapUsd:1}}).returning();
  await recordCost(db,{brandSlug:"fc",batchId:batch!.id,engine:"catalog_compute",costUsd:5,day:now});
  expect(await checkCatalogCaps(db,{batchId:batch!.id,now,env:{}})).toEqual({ok:true});
  await recordCost(db,{brandSlug:"anta",batchId:batch!.id,engine:"catalog_qa",costUsd:1,day:now});
  expect((await checkCatalogCaps(db,{batchId:batch!.id,now,env:{}})).ok).toBe(false);
  expect((await checkCatalogCaps(db,{batchId:batch!.id,now,env:{DAILY_SPEND_CAP_USD:"6"}})).ok).toBe(false);
  expect((await checkCatalogCaps(db,{batchId:batch!.id,now:new Date("2026-10-20T00:00:00Z"),env:{DAILY_SPEND_CAP_USD:"0"}})).ok).toBe(false);
 });
 it("applies options.qaCapUsd per batch, treats null as no cap and reads a numeric string",async()=>{
  const now=new Date("2026-10-21T00:00:00Z"),base={identifierMode:"filename",precedence:"uploads_then_links",sheetColumns:null} as const;
  const [capped]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name:"Capped",createdBy:"op@opptra.com",options:{...base,qaCapUsd:"0.5" as unknown as number}}).returning();
  const [open]=await db.insert(catalogBatches).values({brandSlug:"anta",brandName:"Anta",name:"Open",createdBy:"op@opptra.com",options:{...base,qaCapUsd:null}}).returning();
  for(const b of [capped!,open!]) await recordCost(db,{brandSlug:"anta",batchId:b.id,engine:"catalog_qa",costUsd:.6,day:now});
  const hit=await checkCatalogCaps(db,{batchId:capped!.id,now,env:{}});
  expect(hit.ok).toBe(false);expect(!hit.ok && hit.reason).toContain("Batch QA spend cap");
  expect(await checkCatalogCaps(db,{batchId:open!.id,now,env:{}})).toEqual({ok:true});
 });
});
describe("shadowSynthesisAllowed",()=>{
 it("follows the product's own classification and defaults to no synthesised shadow",()=>{
  expect(shadowSynthesisAllowed("footwear",[])).toBe(true);
  expect(shadowSynthesisAllowed("bag_accessory",[])).toBe(true);
  expect(shadowSynthesisAllowed("other",[])).toBe(true);
  expect(shadowSynthesisAllowed("apparel_model",[])).toBe(false);
  expect(shadowSynthesisAllowed("apparel_flat",[])).toBe(false);
  expect(shadowSynthesisAllowed("auto",[])).toBe(false);
  expect(shadowSynthesisAllowed(null,[])).toBe(false);
  expect(shadowSynthesisAllowed(undefined,[])).toBe(false);
  expect(shadowSynthesisAllowed("other",["type_unknown"])).toBe(false);
  expect(shadowSynthesisAllowed("footwear",["type_unknown"])).toBe(false);
 });
});
