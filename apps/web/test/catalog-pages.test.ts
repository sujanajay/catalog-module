import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import { brandMaster, catalogBatches, catalogBatchProducts, catalogOutputs, catalogProducts, catalogProductAliases, catalogSourceImages, users } from "@catalog/core/db/schema";
import { findOrCreateProduct } from "@catalog/core/catalog/products";
import { seedAdmin, upsertPerson } from "@catalog/core/people";
import { setStorageClient, type StorageLike } from "@catalog/core/storage";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps } from "../lib/user";
import { addProductAlias, batchAttention, getProduct, removeProduct } from "../lib/catalog/products";
import { searchBrandProducts } from "../lib/catalog/brands";
import { writeLinksXlsx } from "@catalog/core/catalog/sheet";
import { readSheetTable } from "@catalog/core/catalog/ingest/links-sheet";
import { buildReport } from "@catalog/core/catalog/pipeline/report";
import { batchDetails, batchExportUrl, batchSheet, exportBrand } from "../lib/catalog/exports";
import { POST as aliasPost } from "../app/api/catalog/products/[id]/aliases/route";
import { DELETE as productDelete } from "../app/api/catalog/products/[id]/route";
import { POST as brandExport } from "../app/api/catalog/brands/[slug]/export/route";
import { GET as brandSearch } from "../app/api/catalog/brands/[slug]/products/route";
import { GET as attentionGet } from "../app/api/catalog/batches/[id]/attention/route";
import { GET as batchDownload } from "../app/api/catalog/batches/[id]/export/route";

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
it("shows a held product even when processing failed before output planning", async () => {
 await db.update(catalogBatchProducts).set({change:"pending_attention",notes:"Some photos could not be processed. Start this product again."}).where(eq(catalogBatchProducts.productId,productId));
 const sign=vi.fn(async(uri:string)=>`signed:${uri}`);
 expect(await batchAttention(batchId,db,sign)).toEqual([{productId,identifier:"ABC-123",totalShots:1,problemLine:"Some photos could not be processed. Start this product again.",photos:[]}]);
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
 }
});
