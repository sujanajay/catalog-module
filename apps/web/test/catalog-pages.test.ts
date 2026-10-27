import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import { brandMaster, catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogProductAliases, catalogSourceImages, catalogUploads, users } from "@catalog/core/db/schema";
import { findOrCreateProduct } from "@catalog/core/catalog/products";
import { seedAdmin, upsertPerson } from "@catalog/core/people";
import { setStorageClient, type StorageLike } from "@catalog/core/storage";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps } from "../lib/user";
import { addProductAlias, batchAttention, getProduct, removeProduct } from "../lib/catalog/products";
import { searchBrandProducts } from "../lib/catalog/brands";
import { writeLinksCsv, writeLinksXlsx } from "@catalog/core/catalog/sheet";
import { readSheetTable } from "@catalog/core/catalog/ingest/links-sheet";
import { buildReport } from "@catalog/core/catalog/pipeline/report";
import { DEFAULT_POLICIES } from "@catalog/core/catalog/qa/policy";
import { batchDetails, batchExportUrl, batchSheet, exportBrand } from "../lib/catalog/exports";
import { anotherBatchProcessing } from "../lib/catalog/batches";
import { POST as aliasPost } from "../app/api/catalog/products/[id]/aliases/route";
import { DELETE as productDelete } from "../app/api/catalog/products/[id]/route";
import { POST as brandExport } from "../app/api/catalog/brands/[slug]/export/route";
import { GET as brandSearch } from "../app/api/catalog/brands/[slug]/products/route";
import { GET as attentionGet } from "../app/api/catalog/batches/[id]/attention/route";
import { GET as batchDownload } from "../app/api/catalog/batches/[id]/export/route";
import { GET as batchGet } from "../app/api/catalog/batches/[id]/route";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BatchPage from "../app/catalog/[id]/page";
import CatalogPage from "../app/catalog/page";
import BrandPage from "../app/catalog/brands/[slug]/page";
import NewBatchPage from "../app/catalog/new/page";
import { BATCH_NOT_FOUND } from "../lib/catalog/batches";
import CatalogErrorPage from "../app/catalog/error";
import CatalogError, { batchLinkFor } from "../components/catalog/CatalogError";
import ProductSearch from "../components/catalog/ProductSearch";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";
import { brandEmptyText, CONTINUE_SETTING_UP, DRAFT_READY_TEXT, ERROR_ALL_BATCHES, ERROR_BATCH_SAFE, ERROR_HEADING, ERROR_OPEN_BATCH, ERROR_TRY_AGAIN, HOW_THIS_WORKS_DRAFT, notStartedText, shortReason } from "../lib/catalog/copy";

// Pages render statically here: the App Router hooks are stubbed, the pages and their queries are real.
const nav = vi.hoisted(() => ({ pathname: "/catalog", search: "" }));
vi.mock("next/navigation", async (actual) => ({
 ...(await actual<typeof import("next/navigation")>()),
 useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
 usePathname: () => nav.pathname,
 useSearchParams: () => new URLSearchParams(nav.search),
 notFound: () => { throw new Error("not found"); },
}));

let db:Db;let close:()=>Promise<void>;let batchId:string;let productId:string;let sourceId:string;
const actor="admin@opptra.com";
beforeAll(async()=>{({db,close}=await createTestDb());setDbForTests(db);});
afterAll(async()=>{setDbForTests(undefined);await close();});
beforeEach(async()=>{
 resetUserDeps();await db.delete(catalogOutputs);await db.delete(catalogProducts);await db.delete(catalogBatches);await db.delete(brandMaster);await db.delete(users);
 await seedAdmin(db,actor);await upsertPerson(db,{email:"operator@opptra.com",role:"operator",addedBy:actor});
 vi.stubEnv("SKIP_IAP","1");vi.stubEnv("DEV_USER_EMAIL",actor);
 await db.insert(brandMaster).values({slug:"uspa",name:"USPA",line:"softline",source:"manual"});
 const [batch]=await db.insert(catalogBatches).values({name:"First delivery",brandSlug:"uspa",brandName:"USPA",channels:["noon"],createdBy:actor}).returning();batchId=batch!.id;
 const {product}=await findOrCreateProduct(db,{brandSlug:"uspa",identifier:"ABC-123",isTest:false,skus:null,actor});productId=product.id;
 const [source]=await db.insert(catalogSourceImages).values({productId,batchId,n:1,sha256:"abc",originalName:"ABC-123_1.jpg",rawUri:"gs://private/raw/1.jpg",mime:"image/jpeg",isCurrent:true}).returning();sourceId=source!.id;
 await db.insert(catalogBatchProducts).values({batchId,productId,change:"new"});
});
afterEach(()=>{setStorageClient(undefined);vi.unstubAllEnvs();});
async function output(extra:Partial<typeof catalogOutputs.$inferInsert>={}) {
 const [row]=await db.insert(catalogOutputs).values({batchId,productId,sourceImageId:sourceId,channel:"noon",n:1,canvasW:1080,canvasH:1480,scale:1,placedX:0,placedY:0,renderKey:"key",objectPath:"catalog/uspa/ABC-123/noon/ABC-123_1.jpg",publicUrl:"https://example.com/ABC-123_1.jpg",generation:7,status:"verified",isLive:true,...extra}).returning();return row!;
}
function request(method:string,body:unknown){return new Request("http://localhost/api/catalog",{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
const context=()=>({params:Promise.resolve({id:productId})});

it("searches identifiers, manual aliases and SKU ids without including the test namespace",async()=>{
 await addProductAlias(productId,"Summer shoe",actor,db);await db.update(catalogProducts).set({opptraSkuIds:["SKU-9"]}).where(eq(catalogProducts.id,productId));await output();
 for(const q of ["abc-123","summer","sku-9"])expect((await searchBrandProducts("uspa",q,db)).map(p=>p.id)).toEqual([productId]);
 expect(await searchBrandProducts("uspa","missing",db)).toEqual([]);
 const result=await getProduct("uspa","ABC-123",false,db);expect(result.images).toHaveLength(1);expect(JSON.stringify(result)).not.toContain("matteModel");
});
it("returns the exact alias conflict and keeps the existing owner",async()=>{
 const {product}=await findOrCreateProduct(db,{brandSlug:"uspa",identifier:"OTHER",isTest:false,skus:null,actor});
 await expect(addProductAlias(product.id,"ABC123",actor,db)).rejects.toMatchObject({status:409,message:"That name already points to ABC-123."});
});
it("groups attention photos with signed private images and previous live availability",async()=>{
 await output();await output({isLive:false,status:"needs_attention",stagingUri:"gs://private/staging/1.jpg",flags:["small_source"],reason:"The original photo is too small."});
 const sign=vi.fn(async(uri:string)=>`signed:${uri}`);const items=await batchAttention(batchId,db,sign);
 expect(items).toMatchObject([{identifier:"ABC-123",totalShots:1,photos:[{n:1,liveObjectExists:true,originalUrl:"signed:gs://private/raw/1.jpg",outputUrl:"signed:gs://private/staging/1.jpg"}]}]);expect(JSON.stringify(items)).not.toContain("qaModel");
});
it("lists only photos needing a decision, leaving held-only processing failures in Details", async () => {
 await db.update(catalogBatchProducts).set({change:"pending_attention",notes:"Some photos could not be processed. Start this product again."}).where(eq(catalogBatchProducts.productId,productId));
 const sign=vi.fn(async(uri:string)=>`signed:${uri}`);
 expect(await batchAttention(batchId,db,sign)).toEqual([]);
 expect(sign).not.toHaveBeenCalled();
});
it("sheet preview retains previous links for held products and tail columns",async()=>{
 await output();await db.update(catalogBatchProducts).set({change:"pending_attention",notes:"Photo needs attention"}).where(eq(catalogBatchProducts.productId,productId));
 const sheet=await batchSheet(batchId,db);expect(sheet.rows[0]).toMatchObject({identifier:"ABC-123",status:"needs_attention",change:"pending_attention",notes:"Photo needs attention",links:{noon:["https://example.com/ABC-123_1.jpg"]}});
});
it("shows live marketplaces not refreshed before this batch has any finalized report",async()=>{
 const [old]=await db.insert(catalogBatches).values({name:"Earlier Amazon delivery",brandSlug:"uspa",brandName:"USPA",channels:["amazon"],createdBy:actor}).returning();
 await output({batchId:old!.id,channel:"amazon",objectPath:"catalog/uspa/ABC-123/amazon/ABC-123_1.jpg",publishedAt:new Date("2026-10-18T12:00:00Z")});
 const details=await batchDetails(batchId,db);expect(details.batch.reportUri).toBeNull();expect(details.notRefreshedChannels).toEqual([{channel:"amazon",lastBatchId:old!.id,lastBatchName:"Earlier Amazon delivery"}]);
});
it("counts only Styli skips for being too small, not removed or chart skips, for the Ready line",async()=>{
 await output({channel:"styli",status:"skipped",isLive:false,reason:"Skipped for Styli: the photo is smaller than Styli needs.",objectPath:"catalog/uspa/ABC-123/styli/ABC-123_1.jpg"});
 await output({channel:"styli",n:2,status:"skipped",isLive:false,reason:"Removed by ops@opptra.com",objectPath:"catalog/uspa/ABC-123/styli/ABC-123_2.jpg"});
 await output({channel:"noon",n:3,status:"skipped",isLive:false,reason:"Skipped for Styli: the photo is smaller than Styli needs.",objectPath:"catalog/uspa/ABC-123/noon/ABC-123_3.jpg"});
 await output({channel:"styli",n:4,status:"skipped",isLive:false,reason:"Upscaled. Skipped for Styli: the photo is smaller than Styli needs.",objectPath:"catalog/uspa/ABC-123/styli/ABC-123_4.jpg"});
 expect((await batchDetails(batchId,db)).styliSkipped).toBe(2);
});
it("tells step 4 another batch is processing only for a different batch that moved in the last hour",async()=>{
 const now=new Date("2026-10-21T14:00:00Z");
 expect(await anotherBatchProcessing(batchId,now)).toBe(false);
 await db.update(catalogBatches).set({status:"rendering",updatedAt:new Date(+now-5*60_000)}).where(eq(catalogBatches.id,batchId));
 expect(await anotherBatchProcessing(batchId,now)).toBe(false);
 const [other]=await db.insert(catalogBatches).values({name:"Second delivery",brandSlug:"uspa",brandName:"USPA",channels:["noon"],createdBy:actor,status:"matting",updatedAt:new Date(+now-2*60*60_000)}).returning();
 expect(await anotherBatchProcessing(batchId,now)).toBe(false);
 await db.update(catalogBatches).set({updatedAt:new Date(+now-10*60_000)}).where(eq(catalogBatches.id,other!.id));
 expect(await anotherBatchProcessing(batchId,now)).toBe(true);
});
it("exports only the selected brand products and every live channel through existing writers",async()=>{
 await output();const uploadBuffer=vi.fn(async(path:string)=>`gs://private/${path}`);const signedUrl=vi.fn(async(uri:string)=>`signed:${uri}`);
 const result=await exportBrand("uspa",[productId],db,{uploadBuffer,signedUrl},new Date("2026-10-19T01:02:03Z"));expect(uploadBuffer).toHaveBeenCalledTimes(2);expect(uploadBuffer.mock.calls[0]![0]).toMatch(/^catalog\/uspa\/exports\/[0-9a-f-]{36}\/links-20261019-010203.xlsx$/);expect(result.url).toContain("signed:gs://private/");
 await expect(exportBrand("other",[productId],db,{uploadBuffer,signedUrl})).rejects.toMatchObject({status:404});
});
it("signs the latest batch export for seven days and uses the specified missing-filled sentence",async()=>{
 await db.update(catalogBatches).set({sheetXlsxUri:"gs://private/links-v2.xlsx"}).where(eq(catalogBatches.id,batchId));const signedUrl=vi.fn(async()=>"https://signed.example/file");const downloadBuffer=vi.fn();
 expect(await batchExportUrl(batchId,"xlsx",db,{signedUrl,downloadBuffer})).toBe("https://signed.example/file");expect(signedUrl).toHaveBeenCalledWith("gs://private/links-v2.xlsx",604800);
 await expect(batchExportUrl(batchId,"filled",db,{signedUrl,downloadBuffer})).rejects.toMatchObject({status:404,message:"No product list was uploaded in this batch."});
});
it("requires typed confirmation and refuses locked products before any storage action",async()=>{
 await output();const remove=vi.fn(async()=>true);
 await expect(removeProduct(productId,"wrong",actor,db,remove)).rejects.toMatchObject({status:400});
 await db.update(catalogProducts).set({lockBatchId:batchId}).where(eq(catalogProducts.id,productId));
 await expect(removeProduct(productId,"ABC-123",actor,db,remove)).rejects.toMatchObject({status:409,message:"ABC-123 is being processed in batch First delivery."});expect(remove).not.toHaveBeenCalled();
});
it("removes live objects with generation and product-prefix guards before hard deleting dependent records",async()=>{
 await output();const remove=vi.fn(async()=>true);await removeProduct(productId,"ABC-123",actor,db,remove);
 expect(remove).toHaveBeenCalledWith("catalog/uspa/ABC-123/noon/ABC-123_1.jpg","catalog/uspa/ABC-123/",{ifGenerationMatch:7});expect(await db.select().from(catalogProducts)).toEqual([]);expect(await db.select().from(catalogOutputs)).toEqual([]);expect(await db.select().from(catalogProductAliases)).toEqual([]);
});
it("does not delete outside the product prefix and leaves database records when storage fails",async()=>{
 await output({objectPath:"catalog/uspa/OTHER/noon/OTHER_1.jpg"});const remove=vi.fn(async()=>true);await expect(removeProduct(productId,"ABC-123",actor,db,remove)).rejects.toThrow();expect(remove).not.toHaveBeenCalled();expect(await db.select().from(catalogProducts)).toHaveLength(1);
});
it("rolls back database changes if a storage delete fails and refuses an unknown generation",async()=>{
 await output();const remove=vi.fn(async()=>{throw new Error("Storage is unavailable");});
 await expect(removeProduct(productId,"ABC-123",actor,db,remove)).rejects.toThrow("Storage is unavailable");expect((await db.select().from(catalogOutputs))[0]!.isLive).toBe(true);
 await db.update(catalogOutputs).set({generation:null});remove.mockClear();await expect(removeProduct(productId,"ABC-123",actor,db,remove)).rejects.toMatchObject({status:409});expect(remove).not.toHaveBeenCalled();
});
it("viewer mutation routes return 403 before parsing bodies; viewer search remains available",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","viewer@opptra.com");
 const results=await Promise.all([aliasPost(request("POST",{}),context()),productDelete(request("DELETE",{}),context()),brandExport(request("POST",{}),{params:Promise.resolve({slug:"uspa"})})]);
 for(const res of results){expect(res.status).toBe(403);expect(await res.json()).toEqual({error:"You can view this but not change it. Ask an admin for the operator role."});}
 const result=await brandSearch(new Request("http://localhost/api/catalog/brands/uspa/products?q=ABC"),{params:Promise.resolve({slug:"uspa"})});expect(result.status).toBe(200);
});
it("operator aliases route uses the signed-in actor and returns the added alias",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","operator@opptra.com");const result=await aliasPost(request("POST",{alias:"New Name"}),context());expect(result.status).toBe(200);expect(await result.json()).toEqual({alias:"New Name",aliasKey:"NEWNAME"});
});
it("a viewer can download the latest export and read attention without gaining mutation rights",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","viewer@opptra.com");
 const getSignedUrl=vi.fn(async()=>["https://signed.example/links.xlsx"]);
 setStorageClient({bucket:()=>({file:()=>({getSignedUrl})})} as unknown as StorageLike);
 await db.update(catalogBatches).set({sheetXlsxUri:"gs://private/links-v1.xlsx"}).where(eq(catalogBatches.id,batchId));
 const ctx={params:Promise.resolve({id:batchId})};
 const download=await batchDownload(new Request("http://localhost/api/catalog/export?format=xlsx"),ctx);
 expect(download.status).toBe(302);expect(download.headers.get("location")).toBe("https://signed.example/links.xlsx");
 const attention=await attentionGet(new Request("http://localhost/api/catalog/attention"),ctx);expect(attention.status).toBe(200);expect(await attention.json()).toEqual([]);
});
it("operator export and removal routes use real database rules and only fake storage calls",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","operator@opptra.com");vi.stubEnv("BUCKET","private");
 const save=vi.fn(async()=>undefined);const getSignedUrl=vi.fn(async()=>["https://signed.example/links.xlsx"]);const deleteObject=vi.fn(async()=>undefined);
 setStorageClient({bucket:()=>({file:()=>({save,getSignedUrl,delete:deleteObject})})} as unknown as StorageLike);
 await output();
 const exported=await brandExport(request("POST",{productIds:[productId]}),{params:Promise.resolve({slug:"uspa"})});
 expect(exported.status).toBe(200);expect(await exported.json()).toEqual({url:"https://signed.example/links.xlsx"});expect(save).toHaveBeenCalledTimes(2);
 const removed=await productDelete(request("DELETE",{confirm:"ABC-123"}),context());expect(removed.status).toBe(204);expect(deleteObject).toHaveBeenCalledWith({ifGenerationMatch:7});expect(await db.select().from(catalogProducts)).toEqual([]);
});


it("keeps simultaneous brand selections in separate immutable XLSX and CSV objects",async()=>{
 const {product:other}=await findOrCreateProduct(db,{brandSlug:"uspa",identifier:"OTHER",isTest:false,skus:null,actor});
 await output();
 const objects=new Map<string,Buffer>();
 const uploadBuffer=vi.fn(async(path:string,buf:Buffer)=>{objects.set(`gs://private/${path}`,buf);return `gs://private/${path}`;});
 const signedUrl=vi.fn(async(uri:string)=>uri);
 const now=new Date("2026-10-19T01:02:03Z");
 const [first,second]=await Promise.all([exportBrand("uspa",[productId],db,{uploadBuffer,signedUrl},now),exportBrand("uspa",[other.id],db,{uploadBuffer,signedUrl},now)]);
 expect(first.url).not.toBe(second.url);
 expect(objects.size).toBe(4);
 for(const [result,identifier] of [[first,"ABC-123"],[second,"OTHER"]] as const){
  const table=await readSheetTable(objects.get(result.url)!,"links.xlsx");
  expect(table.rows[1]![1]).toBe(identifier);
  expect(objects.get(result.url.replace(/xlsx$/,"csv"))!.toString()).toContain(identifier);
  expect(result.url).toMatch(/\/links-20261019-010203.xlsx$/);
 }
});
it("keeps a finalized batch preview equal to its saved download after a later publication",async()=>{
 await output();
 const initial=await batchSheet(batchId,db);
 initial.rows[0]!.opptraSkuIds=["OLD-SKU","OLD-SKU-2"];
 initial.rows[0]!.links.noon!.push(null,"https://example.com/old-third.jpg");
 initial.rows[0]!.notes="Saved finalization note";
 initial.rows[0]!.changedAt=new Date("2026-10-18T10:00:00Z");
 const saved=await writeLinksXlsx(initial);
 await db.update(catalogBatches).set({status:"done",sheetXlsxUri:"gs://private/old-links.xlsx"}).where(eq(catalogBatches.id,batchId));
 const [later]=await db.insert(catalogBatches).values({name:"Later delivery",brandSlug:"uspa",brandName:"USPA",channels:["noon"],createdBy:actor}).returning();
 await db.update(catalogOutputs).set({isLive:false});
 await output({batchId:later!.id,publicUrl:"https://example.com/replacement.jpg",publishedAt:new Date("2026-10-19T10:00:00Z")});
 const read=vi.fn(async()=>({buf:saved,mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
 const details=await batchDetails(batchId,db,read);
 expect(read).toHaveBeenCalledWith("gs://private/old-links.xlsx");
 expect(details.sheet).toEqual(initial);
});
it("matches report statuses in the pre-finalization page for failed, held and missing products",async()=>{
 await output();
 for(const [change,linkStatus,expected] of [["failed","ok","needs_attention"],["pending_attention","ok","needs_attention"],["failed","missing_images","missing_images"]] as const){
  await db.update(catalogBatchProducts).set({change,linkStatus}).where(eq(catalogBatchProducts.productId,productId));
  const preview=await batchSheet(batchId,db);
  const report=await buildReport(db,batchId,{recheck:{ok:0,total:0,failures:[]},exports:{xlsx:"x",csv:"c",report:"r",filledProductList:null,exportsMatch:true}});
  expect(preview.rows[0]!.status).toBe(expected);
  expect(preview.rows[0]!.status).toBe(report.sheet.rows[0]!.status);
  // The report never says "ok" for a held product: its linkStatus is the sheet status.
  expect((report.report.products as {linkStatus:string}[])[0]!.linkStatus).toBe(expected);
 }
});
// Spec 07: no model or provider name in any export. The stored report keeps the ids for evals; every
// operator download (report.json, links sheets, brand page selection) and the batch API carry none.
const MODEL_NAMES=/birefnet|rmbg|bria|inspyre|ben_custom|esrgan|swinir|gemini|claude|qwen|llama|gpt-|openai\/|anthropic\/|google\//i;
it("keeps model ids out of the report export, the links sheets, the brand download and the batch API",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","viewer@opptra.com");
 const judge="google/gemini-2.5-flash-lite";
 await db.update(catalogSourceImages).set({matteModel:"birefnet-general"}).where(eq(catalogSourceImages.id,sourceId));
 const [policyBatch]=await db.select({options:catalogBatches.options}).from(catalogBatches).where(eq(catalogBatches.id,batchId));
 await db.update(catalogBatches).set({options:{...policyBatch!.options,policy:{...DEFAULT_POLICIES.footwear,qaModel:judge,qaModelSecond:"anthropic/claude-haiku-4.5"}}}).where(eq(catalogBatches.id,batchId));
 const wrongItem={first:true,second:false,secondModel:"qwen/qwen2.5-vl-72b-instruct",confirmed:false};
 await output({qaModel:judge,qaScores:{overall:62,edge_quality:62,verdict:"flag",thresholds:{edge_quality:75},view:"packshot",evidence:{rough_edges:"The left strap edge is rough."},reasons:["The left strap edge is rough."],wrongItem,
  judgements:[{role:"judge",model:judge,channel:"noon",scores:{overall:62},wrongItem},{role:"second",model:"openai/gpt-4o-mini:free",channel:"noon",scores:{overall:70}}],autoAction:"note"},
  compliance:{auto_actions:[{step:"matte_check",detail:"birefnet-general: dropped product: worst cell 100.0%, overall 10.5%",result:"failed",trigger:["product_removed"],channels:[],rejudged:false},
   {step:"padded_matte",detail:"bria-rmbg padded: dropped product: worst cell 100.0%, overall 29.6%",result:"failed",trigger:["product_removed"],channels:[],rejudged:false}]}});
 const built=await buildReport(db,batchId,{recheck:{ok:0,total:1,failures:[{url:"https://example.com/ABC-123_1.jpg",reason:"birefnet-general output did not load"}]},exports:{xlsx:"gs://private/links-v1.xlsx",csv:"gs://private/links-v1.csv",report:"gs://private/report.json",filledProductList:null,exportsMatch:true}});
 const stored=JSON.stringify(built.report);expect(stored).toMatch(MODEL_NAMES);// the stored report keeps the ids for evals
 const objects=new Map<string,Buffer>([["gs://private/report.json",Buffer.from(stored)],["gs://private/links-v1.xlsx",await writeLinksXlsx(built.sheet)],["gs://private/links-v1.csv",Buffer.from(writeLinksCsv(built.sheet))]]);
 const getSignedUrl=vi.fn(async()=>["https://signed.example/file"]);
 setStorageClient({bucket:(b:string)=>({file:(name:string)=>({getSignedUrl,download:async()=>[objects.get(`gs://${b}/${name}`)],getMetadata:async()=>[{contentType:"application/json"}]})})} as unknown as StorageLike);
 await db.update(catalogBatches).set({reportUri:"gs://private/report.json",sheetXlsxUri:"gs://private/links-v1.xlsx",sheetCsvUri:"gs://private/links-v1.csv"}).where(eq(catalogBatches.id,batchId));
 const ctx={params:Promise.resolve({id:batchId})};
 const response=await batchDownload(new Request(`http://localhost/api/catalog/batches/${batchId}/export?format=report`),ctx);
 expect(response.status).toBe(200);const text=await response.text();
 expect(text).not.toMatch(MODEL_NAMES);
 const report=JSON.parse(text) as {products:{outputs:{qa:Record<string,unknown>&{judgements:Record<string,unknown>[]};autoActions:{detail:string}[]}[]}[];recheck:{failures:{reason:string}[]}};
 const out=report.products[0]!.outputs[0]!;
 expect(out.qa).toMatchObject({model:"quality check",overall:62,thresholds:{edge_quality:75},evidence:{rough_edges:"The left strap edge is rough."},wrongItem:{first:true,secondModel:"second opinion"},autoAction:"note"});
 expect(out.qa.judgements.map(j=>j.model)).toEqual(["quality check","quality check"]);
 expect(out.autoActions.map(a=>a.detail)).toEqual(["model A: dropped product: worst cell 100.0%, overall 10.5%","model B padded: dropped product: worst cell 100.0%, overall 29.6%"]);
 expect(report.recheck.failures[0]!.reason).toBe("model A output did not load");
 // Every other download and the batch API: sheets, brand page selection, details and the batch record.
 for(const uri of ["gs://private/links-v1.xlsx","gs://private/links-v1.csv"]){const table=await readSheetTable(objects.get(uri)!,uri.endsWith("csv")?"links.csv":"links.xlsx");expect(JSON.stringify(table)).not.toMatch(MODEL_NAMES);}
 const saved:Buffer[]=[];await exportBrand("uspa",[productId],db,{uploadBuffer:vi.fn(async(path:string,buf:Buffer)=>{saved.push(buf);return `gs://private/${path}`;}),signedUrl:vi.fn(async(uri:string)=>uri)});
 expect(saved).toHaveLength(2);expect(JSON.stringify((await readSheetTable(saved[0]!,"links.xlsx")))+saved[1]!.toString()).not.toMatch(MODEL_NAMES);
 const details=await batchDetails(batchId,db,async(uri:string)=>({buf:objects.get(uri)!,mime:"application/octet-stream"}));
 expect(JSON.stringify(details.recheckFailures)).not.toMatch(MODEL_NAMES);
 const batchApi=await batchGet(new Request(`http://localhost/api/catalog/batches/${batchId}`),ctx);expect(batchApi.status).toBe(200);expect(await batchApi.text()).not.toMatch(MODEL_NAMES);
 const product=await getProduct("uspa","ABC-123",false,db);expect(JSON.stringify(product)).not.toMatch(MODEL_NAMES);
});

// ---- Spec 14a F9 and F1: draft and failed screens tell the truth; the error page has a way back. ----
const render=async(page:Promise<ReactElement>|ReactElement)=>renderToStaticMarkup(createElement(ViewerPreviewProvider,null,createElement(ToastProvider,null,await page)));
const batchPage=(query:Record<string,string>={})=>render(BatchPage({params:Promise.resolve({id:batchId}),searchParams:Promise.resolve(query)}));
const panel=(html:string,id:string)=>new RegExp(`<section[^>]*id="panel-${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1]??"";
type BatchRow=typeof catalogBatches.$inferSelect;
async function setBatch(values:Partial<Omit<BatchRow,"counts">>&{counts?:Partial<BatchRow["counts"]>}){
 const [row]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,batchId));
 await db.update(catalogBatches).set({...values,counts:{...row!.counts,...values.counts}}).where(eq(catalogBatches.id,batchId));
}
it("a ready draft says created, carries Continue setting up and says its tabs have nothing made yet",async()=>{
 await setBatch({channels:[],counts:{previewReady:true,products:6,sources:27}});
 const html=await batchPage();
 expect(html).toMatch(/created \d{4}-\d\d-\d\d \d\d:\d\dZ by admin@opptra\.com/);
 expect(html).not.toMatch(/started \d{4}-/);expect(html).not.toMatch(/·\s*(<!-- -->)?\s*·/);
 expect(html).toContain(DRAFT_READY_TEXT);
 expect(html).toContain(`<a class="btn primary" href="/catalog/new?batch=${batchId}">${CONTINUE_SETTING_UP}</a>`);
 expect(html).toContain(HOW_THIS_WORKS_DRAFT);
 const line=notStartedText(27,6);expect(line).toBe("This batch has not started. 27 photos found for 6 products; nothing has been made yet.");
 expect(panel(html,"sheet")).toBe(`<p>${line}</p>`);
 expect(html).not.toContain("Add SKU ids");
 const compare=await batchPage({tab:"compare"});
 expect(panel(compare,"compare")).toBe(`<p>${line}</p>`);expect(compare).not.toContain("Loading the comparison.");
});
it("a draft still collecting keeps its state text, the button and the draft paragraph; a viewer gets no button",async()=>{
 await setBatch({status:"ingesting",updatedAt:new Date(),counts:{collected:3,collectTotal:10}});
 let html=await batchPage();
 expect(html).toContain("3 of 10 files copied");expect(html).not.toContain(DRAFT_READY_TEXT);
 expect(html).toContain(`href="/catalog/new?batch=${batchId}">${CONTINUE_SETTING_UP}</a>`);expect(html).toContain(HOW_THIS_WORKS_DRAFT);
 expect(html).toMatch(/ · Noon · (<!-- -->)?created /);
 vi.stubEnv("DEV_USER_EMAIL","viewer@opptra.com");
 // The overview's leaving line names the button in words; the viewer gets no button.
 html=await batchPage();expect(html).not.toContain(`>${CONTINUE_SETTING_UP}</a>`);expect(html).not.toContain("/catalog/new?batch=");
});
it("a draft whose grouping is not ready keeps the existing banner text",async()=>{
 const html=await batchPage();
 expect(html).toContain("Check what we found and start processing.");expect(html).not.toContain(DRAFT_READY_TEXT);expect(html).toContain(CONTINUE_SETTING_UP);
});
it("a batch that could not start says created, with the not-started tabs and without Continue setting up",async()=>{
 await setBatch({status:"failed",counts:{failReason:"No photos could be downloaded.",products:0,sources:0}});
 const html=await batchPage();
 expect(html).toMatch(/(<!-- -->)?created \d{4}-/);expect(html).not.toMatch(/started \d{4}-/);
 expect(html).not.toContain(CONTINUE_SETTING_UP);expect(html).not.toContain(HOW_THIS_WORKS_DRAFT);
 expect(panel(html,"sheet")).toBe(`<p>${notStartedText(0,0)}</p>`);
 expect(html).toContain("Start again");
});
it("a started batch says started, keeps its sheet and hides Add SKU ids only with 0 products",async()=>{
 vi.stubEnv("DEV_USER_EMAIL","operator@opptra.com");
 await setBatch({status:"rendering",startedAt:new Date("2026-10-27T09:00:00Z"),counts:{products:0}});
 let html=await batchPage();
 expect(html).toContain("started 2026-10-27 09:00Z by admin@opptra.com");expect(html).not.toMatch(/created \d{4}-/);
 expect(html).not.toContain(CONTINUE_SETTING_UP);expect(html).not.toContain("This batch has not started.");
 expect(html).not.toContain("Add SKU ids");
 await setBatch({counts:{products:1}});
 html=await batchPage();expect(html).toContain("Add SKU ids");
});
it("the batch list shows a failed batch's reason under its name, cut at 120 characters with the full reason on hover",async()=>{
 const reason=`No photos could be downloaded from the 27 links you pasted. ${"Check that the links open in a browser. ".repeat(4)}`.trim();
 await setBatch({status:"failed",counts:{failReason:reason}});
 const html=await render(CatalogPage());
 const short=shortReason(reason);expect(reason.length).toBeGreaterThan(120);expect(short.length).toBeLessThanOrEqual(123);expect(short.startsWith(reason.slice(0,100))).toBe(true);
 expect(html).toContain(`<div class="help" title="${reason}">${short}</div>`);
 // On a phone the collapsible columns carry classes; State has none, so it stays on screen.
 expect(html).toContain('<th class="col-channels">Channels</th>');expect(html).toContain("<th>State</th>");
 expect(shortReason("Short reason.")).toBe("Short reason.");
});
it("the brand page names the query only when there is one",async()=>{
 await db.insert(brandMaster).values({slug:"empty-brand",name:"Empty Brand",line:"softline",source:"manual"});
 expect(await render(BrandPage({params:Promise.resolve({slug:"empty-brand"})}))).toContain("No products of Empty Brand yet.");
 expect(brandEmptyText("USPA","  ")).toBe("No products of USPA yet.");
 expect(brandEmptyText("USPA","abc")).toBe("No products of USPA match abc.");
 expect(await render(createElement(ProductSearch,{slug:"uspa",brand:"USPA",initial:[],canAct:false}))).toContain("No products of USPA yet.");
});
it("the error page with a known batch shows the safe sentence, both links and the button, which calls reset",()=>{
 const id="0b6f3a52-6f0e-4c1e-9d1a-2f6f1b1c9e01";
 expect(batchLinkFor(`/catalog/${id}`,null)).toBe(`/catalog/${id}`);
 expect(batchLinkFor("/catalog/new",id)).toBe(`/catalog/new?batch=${id}`);
 for(const [p,b] of [["/catalog/new",null],["/catalog/ops",null],["/catalog/new","not-an-id"],["/catalog/brands/uspa",null]] as const)expect(batchLinkFor(p,b)).toBeNull();
 const reset=vi.fn();
 const view=CatalogError({batchHref:`/catalog/${id}`,reset});
 const html=renderToStaticMarkup(view);
 for(const text of [ERROR_HEADING,ERROR_BATCH_SAFE,ERROR_OPEN_BATCH,ERROR_ALL_BATCHES,ERROR_TRY_AGAIN])expect(html).toContain(text);
 expect(html).toContain(`href="/catalog/${id}">${ERROR_OPEN_BATCH}</a>`);expect(html).toContain(`href="/catalog">${ERROR_ALL_BATCHES}</a>`);
 const acts=(view.props as {children:ReactElement<{children:ReactElement<{onClick?:()=>void}>[]}>[]}).children[2]!;
 acts.props.children[2]!.props.onClick!();expect(reset).toHaveBeenCalledTimes(1);
 nav.pathname="/catalog/new";nav.search=`?batch=${id}`;
 const page=renderToStaticMarkup(createElement(CatalogErrorPage,{error:new Error("boom"),reset}));
 expect(page).toContain(`href="/catalog/new?batch=${id}">${ERROR_OPEN_BATCH}</a>`);expect(page).toContain(ERROR_BATCH_SAFE);
 nav.pathname="/catalog";nav.search="";
});
it("the error page without a batch shows the heading, All batches and the button only",()=>{
 nav.pathname="/catalog/ops";
 const html=renderToStaticMarkup(createElement(CatalogErrorPage,{error:new Error("boom"),reset:()=>undefined}));
 expect(html).toContain(ERROR_HEADING);expect(html).toContain(ERROR_ALL_BATCHES);expect(html).toContain(ERROR_TRY_AGAIN);
 expect(html).not.toContain(ERROR_BATCH_SAFE);expect(html).not.toContain(ERROR_OPEN_BATCH);
 nav.pathname="/catalog";
});
// ---- Spec 14a F4 part 1: /catalog/new?batch=<id> reopens the wizard, or goes to the batch page. ----
const newPage=(query:Record<string,string>)=>NewBatchPage({searchParams:Promise.resolve(query)});
const redirectTo=(target:string)=>expect.objectContaining({digest:expect.stringContaining(`;${target};`)});
async function addUpload(status:"pending"|"uploaded"|"collected"="collected"){await db.insert(catalogUploads).values({batchId,kind:"zip",name:"photos.zip",status});}
it("GET /catalog/new?batch= of a draft renders the wizard at its step",async()=>{
 await addUpload();await setBatch({counts:{previewReady:true}});
 let html=await render(newPage({batch:batchId}));
 expect(html).toContain('aria-current="step">Start</li>');expect(html).toContain('value="uspa" selected=""');
 await setBatch({channels:[]});
 html=await render(newPage({batch:batchId}));expect(html).toContain('aria-current="step">Check what we found</li>');
 await setBatch({status:"ingesting",updatedAt:new Date(),counts:{previewReady:false,collected:40,collectTotal:287}});
 html=await render(newPage({batch:batchId}));
 expect(html).toContain('aria-current="step">Check what we found</li>');expect(html).toContain("40 of 287 files copied from your zip.");expect(html).not.toContain("0 of 0 products");
 await addUpload("pending");
 expect(await render(newPage({batch:batchId}))).toContain('aria-current="step">Brand and files</li>');
});
it("GET /catalog/new?batch= of a failed or a started batch redirects to the batch page",async()=>{
 await setBatch({status:"failed",counts:{failReason:"No photos could be downloaded."}});
 await expect(newPage({batch:batchId})).rejects.toEqual(redirectTo(`/catalog/${batchId}`));
 await setBatch({status:"rendering",startedAt:new Date()});
 await expect(newPage({batch:batchId})).rejects.toEqual(redirectTo(`/catalog/${batchId}`));
 await setBatch({status:"draft"});
 await expect(newPage({batch:batchId})).rejects.toEqual(redirectTo(`/catalog/${batchId}`));
});
it("GET /catalog/new?batch= of a missing batch shows the 404 sentence; a viewer is refused",async()=>{
 for(const id of ["00000000-0000-4000-8000-000000000000","not-an-id"]){
  const html=await render(newPage({batch:id}));
  expect(html).toContain(BATCH_NOT_FOUND);expect(html).not.toContain("catalog-wizard");
 }
 vi.stubEnv("DEV_USER_EMAIL","viewer@opptra.com");
 await expect(newPage({batch:batchId})).rejects.toThrow();
});
// Spec 14 section 6, the removed sentences of release A: absent from the web app and core sources.
const ROOT=path.resolve(__dirname,"../../..");
function sources(dir:string):string[]{return readdirSync(dir).flatMap(name=>{const full=path.join(dir,name);if(statSync(full).isDirectory())return ["node_modules",".next"].includes(name)?[]:sources(full);return /\.tsx?$/.test(name)&&!/\.(test|spec)\.tsx?$/.test(name)?[full]:[];});}
it("the removed sentences of release A are gone from apps/web and packages/core",()=>{
 const files=[...["apps/web/app","apps/web/components","apps/web/lib","packages/core/src"].flatMap(d=>sources(path.join(ROOT,d)))];
 expect(files.length).toBeGreaterThan(50);
 // "started <time>" on an unstarted batch came from falling back to createdAt when startedAt was null.
 const hits=files.filter(f=>{const text=readFileSync(f,"utf8");return text.includes("Processing starts by itself")||/started \$\{[^}]*startedAt\s*\?\?/.test(text);}).map(f=>path.relative(ROOT,f));
 expect(hits).toEqual([]);
});
