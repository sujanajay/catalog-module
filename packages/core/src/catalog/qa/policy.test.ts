import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/testing";
import type { Db } from "../../db/client";
import { catalogBatches, modelPolicy } from "../../db/schema";
import { recordCost } from "../../spend";
import { readFileSync } from "node:fs";
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
