import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandMaster, catalogBatches, catalogChunks, catalogUploads } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { runIngest } from "@catalog/core/catalog/ingest/index";
import { googleClients } from "@catalog/core/catalog/ingest/google-sheet";
import { heicFixture } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { GET as list, POST as create } from "../app/api/catalog/batches/route";
import { GET as get, PATCH as patch } from "../app/api/catalog/batches/[id]/route";
import { POST as upload } from "../app/api/catalog/batches/[id]/uploads/route";
import { POST as complete } from "../app/api/catalog/batches/[id]/uploads/[uploadId]/complete/route";
import { POST as links } from "../app/api/catalog/batches/[id]/links/route";
import { POST as ingest } from "../app/api/catalog/batches/[id]/ingest/route";
import { GET as detected, PATCH as regroup } from "../app/api/catalog/batches/[id]/detected/route";
import { GET as preview } from "../app/api/catalog/batches/[id]/preview/route";
import { POST as start } from "../app/api/catalog/batches/[id]/start/route";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";

vi.mock("@catalog/core/tasks", () => ({ enqueueTask: vi.fn(async () => "test-task") }));
vi.mock("@catalog/core/catalog/ingest/google-sheet", async (original) => ({...await original<typeof import("@catalog/core/catalog/ingest/google-sheet")>(),googleClients:vi.fn()}));
vi.mock("@catalog/core/storage", async (original) => {
  const actual = await original<typeof storage>();
  return { ...actual, signedPutUrl: vi.fn(async (path: string) => `https://upload.example/${path}`), signedUrl: vi.fn(async (uri: string) => `https://thumb.example/${encodeURIComponent(uri)}`), headObject: vi.fn(), readRange: vi.fn(), downloadBuffer: vi.fn(), uploadBuffer: vi.fn(), listObjects: vi.fn(), setCustomTime: vi.fn(), createRangeStream: vi.fn() };
});

let db: Db;
let close: () => Promise<void>;
const objects = new Map<string, {buf:Buffer;mime:string}>();
const request = (method: string, body?: unknown) => new Request("http://localhost/api/catalog/batches", { method, ...(body !== undefined ? {headers:{"content-type":"application/json"},body:JSON.stringify(body)} : {}) });
const ctx = (id: string, uploadId?: string) => ({params:Promise.resolve({id,...(uploadId?{uploadId}:{})})});
beforeAll(async () => {
  ({db,close}=await createTestDb());setDbForTests(db);
  await db.insert(brandMaster).values({slug:"test-brand",name:"Test Brand",line:"softline",source:"manual"});
});
afterAll(async () => {setDbForTests(undefined);resetUserDeps();vi.unstubAllEnvs();await close();});
beforeEach(() => {
  vi.clearAllMocks();vi.stubEnv("SKIP_IAP","1");vi.stubEnv("DEV_USER_EMAIL","operator@opptra.com");vi.stubEnv("BUCKET","test-assets");
  setUserDeps({roleLookup:async()=>"operator"});
  vi.mocked(storage.headObject).mockImplementation(async (uri) => {const o=objects.get(uri);return {exists:!!o,size:o?.buf.length??null,contentType:o?.mime??null,generation:o?"1":null,crc32c:null};});
  vi.mocked(storage.readRange).mockImplementation(async (uri,start,end)=>objects.get(uri)!.buf.subarray(start,end+1));
  vi.mocked(storage.downloadBuffer).mockImplementation(async (uri)=>{const o=objects.get(uri);if(!o)throw Object.assign(new Error("Missing"),{code:404});return {buf:o.buf,mime:o.mime};});
  vi.mocked(storage.uploadBuffer).mockImplementation(async (path,buf,mime)=>{const uri=`gs://test-assets/${path}`;objects.set(uri,{buf,mime});return uri;});
  vi.mocked(storage.listObjects).mockImplementation(async (prefix)=>[...objects.keys()].filter((uri)=>uri.startsWith(prefix)));
  vi.mocked(storage.createRangeStream).mockImplementation((uri,start,end)=>Readable.from([objects.get(uri)!.buf.subarray(start,end+1)]));
});
async function newBatch(name="catalog-test wizard") {
  const response=await create(request("POST",{brandSlug:"test-brand",productType:"auto",name}));expect(response.status).toBe(201);
  return (await response.json() as {id:string}).id;
}
async function addPhoto(id: string, path="ABC123_1.heic") {
  const bytes=heicFixture(1200,1600);
  const response=await upload(request("POST",{files:[{name:path.split("/").at(-1),size:bytes.length,mime:"image/heic",relativePath:path}]}),ctx(id));
  expect(response.status).toBe(200);
  const [plan]=await response.json() as {uploadId:string;putUrl:string;headers:Record<string,string>}[];
  expect(plan!.putUrl).toContain("catalog-test/test-brand");expect(plan!.headers["Content-Type"]).toBe("image/heic");
  const rows=await db.select().from(catalogUploads);const row=rows.find((u)=>u.id===plan!.uploadId)!;
  objects.set(row.gcsUri!,{buf:bytes,mime:"image/heic"});
  expect((await complete(request("POST"),ctx(id,row.id))).status).toBe(200);
  return row;
}
async function collectBatch(id: string) {
  const response=await ingest(request("POST"),ctx(id));expect(response.status).toBe(200);
  const uploads=(await db.select().from(catalogUploads)).filter((u)=>u.batchId===id && u.status==="uploaded");
  for(const u of uploads) await runIngest(db,{storage,fetch:vi.fn(),enqueue:enqueueTask},{batchId:id,uploadId:u.id});
}

describe("catalog wizard authorization and contracts",()=>{
  it("refuses every operator action for a viewer before reading bodies or touching storage",async()=>{
    setUserDeps({roleLookup:async()=>"viewer"});
    const id="00000000-0000-0000-0000-000000000001";
    const responses=await Promise.all([create(request("POST",{})),patch(request("PATCH",{}),ctx(id)),upload(request("POST",{}),ctx(id)),complete(request("POST"),ctx(id,id)),links(request("POST",{}),ctx(id)),ingest(request("POST"),ctx(id)),detected(request("GET"),ctx(id)),regroup(request("PATCH",{}),ctx(id)),preview(request("GET"),ctx(id)),start(request("POST",{}),ctx(id))]);
    for(const response of responses){expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"You can view this but not change it. Ask an admin for the operator role."});}
    expect(storage.signedPutUrl).not.toHaveBeenCalled();expect(enqueueTask).not.toHaveBeenCalled();
  });
  it("creates a signed-in draft without channel defaults and lets a viewer read sanitized data",async()=>{
    const id=await newBatch();
    const data=await (await get(request("GET"),ctx(id))).json();
    expect(data.batch).toMatchObject({brandName:"Test Brand",createdBy:"operator@opptra.com",status:"draft",channels:[],isTest:true,productType:"auto"});
    const batch=(await db.select().from(catalogBatches)).find((b)=>b.id===id)!;
    await db.update(catalogBatches).set({options:{...batch.options,policy:{matteModel:"private-model-id",qaModel:"private-qa-id",threshold:75,floor:60,qaMode:"per_source",qaSampleRate:1,source:"default"}}}).where(eq(catalogBatches.id,id));
    setUserDeps({roleLookup:async()=>"viewer"});
    expect((await get(request("GET"),ctx(id))).status).toBe(200);
    expect(await (await get(request("GET"),ctx(id))).text()).not.toContain("private-model-id");
    expect(await (await list(request("GET"))).text()).not.toContain("private-qa-id");
  });
  it("rejects hidden policy controls and invalid channels",async()=>{
    const id=await newBatch();
    expect((await patch(request("PATCH",{options:{policy:{matteModel:"x"}}}),ctx(id))).status).toBe(400);
    expect((await patch(request("PATCH",{channels:["unknown"]}),ctx(id))).status).toBe(400);
    expect((await patch(request("PATCH",{channels:["noon"]}),ctx(id))).status).toBe(200);
  });
  it("checks object size before accepting completion",async()=>{
    const id=await newBatch();
    const [plan]=await (await upload(request("POST",{files:[{name:"ABC_1.heic",size:100,mime:"image/heic",relativePath:"ABC_1.heic"}]}),ctx(id))).json();
    const response=await complete(request("POST"),ctx(id,plan.uploadId));expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"ABC_1.heic did not finish uploading. Try again."});
  });
  it("stores plain image links with no Google sharing requirement",async()=>{
    const id=await newBatch();
    const response=await links(request("POST",{text:"https://images.example/ABC_1.jpg\nhttps://images.example/ABC_2.jpg"}),ctx(id));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:"url_list",access:"ok",summary:"We will download them when you start. No sharing needed.",count:2});
  });
  it("keeps folder paths and HEIC, collects, re-groups without fetching URLs, previews and starts real chunks",async()=>{
    const id=await newBatch();const photo=await addPhoto(id,"ABC123/ABC123_1.heic");await collectBatch(id);
    const found=await (await detected(request("GET"),ctx(id))).json();expect(found.formats.heic).toBe(1);expect(found.identifierMode.examples[0].identifier).toBe("ABC123");
    const changed=await regroup(request("PATCH",{identifierMode:"folder"}),ctx(id));expect(changed.status).toBe(200);
    await runIngest(db,{storage,fetch:vi.fn(()=>{throw new Error("Should not fetch again");}),enqueue:enqueueTask},{batchId:id,uploadId:photo.id});
    expect((await patch(request("PATCH",{channels:["noon","styli"]}),ctx(id))).status).toBe(200);
    const shown=await (await preview(request("GET"),ctx(id))).json();expect(shown.ready).toBe(true);expect(shown.estimate).toBeNull();expect(shown.groupedBy).toBe("Grouped by folder name");expect(shown.groups[0].files[0]).toMatchObject({n:1,originalName:"ABC123/ABC123_1.heic",width:1200,height:1600});expect(shown.groups[0].firstPhotoUrl).toContain("thumb.example");expect(shown.counts.outputs).toBe(2);
    const response=await start(request("POST",{previewAt:shown.previewAt}),ctx(id));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({id,status:"matting"});
    const chunks=(await db.select().from(catalogChunks)).filter((c)=>c.batchId===id);expect(chunks).toHaveLength(1);expect(chunks[0]).toMatchObject({stage:"matte",status:"queued"});expect(enqueueTask).toHaveBeenCalledWith("/tasks/catalog/chunk",{chunkId:chunks[0]!.id},{taskId:`chunk-${chunks[0]!.id}-matte`});
    expect((await patch(request("PATCH",{channels:["amazon"]}),ctx(id))).status).toBe(409);
    expect((await upload(request("POST",{files:[]}),ctx(id))).status).toBe(409);
  });
  it("invalidates a previously ready preview when another upload is planned",async()=>{
    const id=await newBatch();await addPhoto(id);await collectBatch(id);await patch(request("PATCH",{channels:["noon"]}),ctx(id));
    const shown=await (await preview(request("GET"),ctx(id))).json();
    await upload(request("POST",{files:[{name:"ABC123_2.heic",relativePath:"ABC123_2.heic",size:100,mime:"image/heic"}]}),ctx(id));
    const response=await start(request("POST",{previewAt:shown.previewAt}),ctx(id));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"Files changed since the preview. Open step 4 again."});
  });
  it("retains independent column choices for two sheets through actual regroup without downloading links again",async()=>{
    const id=await newBatch();
    const rows=[{name:"one.csv",csv:"Wrong,Style,Photo\nWRONG1,GOOD1,https://8.8.8.8/GOOD1_1.heic\n"},{name:"two.csv",csv:"Style,Wrong,Unused,Photo\nGOOD2,WRONG2,x,https://8.8.8.8/GOOD2_1.heic\n"}];
    const uploadIds=[];
    for(const row of rows){
      const [plan]=await (await upload(request("POST",{files:[{name:row.name,relativePath:row.name,size:Buffer.byteLength(row.csv),mime:"text/csv"}]}),ctx(id))).json();
      const stored=(await db.select().from(catalogUploads)).find((u)=>u.id===plan.uploadId)!;
      objects.set(stored.gcsUri!,{buf:Buffer.from(row.csv),mime:"text/csv"});
      expect((await complete(request("POST"),ctx(id,plan.uploadId))).status).toBe(200);uploadIds.push(plan.uploadId as string);
    }
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    const fetchImage=vi.fn(async()=>new Response(new Uint8Array(heicFixture(1200,1600)),{headers:{"content-type":"image/heic"}}));
    for(const uploadId of uploadIds)await runIngest(db,{storage,fetch:fetchImage,enqueue:enqueueTask},{batchId:id,uploadId});
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect((await regroup(request("PATCH",{identifierMode:"sheet_column",sheets:[{uploadId:uploadIds[0],identifierColumn:1,imageColumns:[2],kind:"sheet"},{uploadId:uploadIds[1],identifierColumn:0,imageColumns:[3],kind:"sheet"}]}),ctx(id))).status).toBe(200);
    for(const uploadId of uploadIds)await runIngest(db,{storage,fetch:fetchImage,enqueue:enqueueTask},{batchId:id,uploadId});
    expect(fetchImage).toHaveBeenCalledTimes(2);
    const shown=await (await preview(request("GET"),ctx(id))).json();
    expect(shown.groups.map((g:{identifier:string})=>g.identifier).sort()).toEqual(["GOOD1","GOOD2"]);
    const checked=await (await detected(request("GET"),ctx(id))).json();
    expect(checked.sheets.map((s:{identifierColumn:number;imageColumns:number[]})=>[s.identifierColumn,s.imageColumns])).toEqual([[1,[2]],[0,[3]]]);
  });
  it("reads a Google Sheet as a product list after its kind is changed with explicit columns",async()=>{
    const id=await newBatch();await addPhoto(id);
    const uri=`gs://test-assets/google-${id}.csv`;objects.set(uri,{buf:Buffer.from("Identifier,Photo\nABC123,https://8.8.8.8/ABC123_1.heic\nMISSING,\n"),mime:"text/csv"});
    const [sheet]=await db.insert(catalogUploads).values({batchId:id,name:"Google products",kind:"google_sheet",gcsUri:uri,sourceUrl:"https://docs.google.com/spreadsheets/d/test/edit",status:"uploaded",detected:{kind:"google_sheet",message:"Access confirmed",columns:["Identifier","Photo"],identifierColumn:0,urlColumns:[1]}}).returning();
    await ingest(request("POST"),ctx(id));
    const fetchImage=vi.fn(async()=>new Response(new Uint8Array(heicFixture(1200,1600)),{headers:{"content-type":"image/heic"}}));
    for(const u of (await db.select().from(catalogUploads)).filter((u)=>u.batchId===id))await runIngest(db,{storage,fetch:fetchImage,enqueue:enqueueTask},{batchId:id,uploadId:u.id});
    expect((await regroup(request("PATCH",{sheets:[{uploadId:sheet!.id,identifierColumn:0,imageColumns:[],kind:"product_list"}]}),ctx(id))).status).toBe(200);
    for(const u of (await db.select().from(catalogUploads)).filter((u)=>u.batchId===id))await runIngest(db,{storage,fetch:fetchImage,enqueue:enqueueTask},{batchId:id,uploadId:u.id});
    const shown=await (await preview(request("GET"),ctx(id))).json();
    expect(shown.groups.find((g:{identifier:string})=>g.identifier==="MISSING")?.status).toBe("missing images");
    const checked=await (await detected(request("GET"),ctx(id))).json();expect(checked.sheets[0].kind).toBe("product_list");
  });
  it("refuses a second batch that would overwrite a locked product and keeps it a draft",async()=>{
    const first=await newBatch("catalog-test first owner");await addPhoto(first,"LOCKED_1.heic");await collectBatch(first);await patch(request("PATCH",{channels:["noon"]}),ctx(first));
    const firstPreview=await (await preview(request("GET"),ctx(first))).json();expect((await start(request("POST",{previewAt:firstPreview.previewAt}),ctx(first))).status).toBe(200);
    const second=await newBatch("catalog-test next owner");await addPhoto(second,"LOCKED_1.heic");await collectBatch(second);await patch(request("PATCH",{channels:["noon"]}),ctx(second));
    const nextPreview=await (await preview(request("GET"),ctx(second))).json();expect(nextPreview.busy).toEqual([{identifier:"LOCKED",batchName:"catalog-test first owner"}]);
    const refused=await start(request("POST",{previewAt:nextPreview.previewAt}),ctx(second));expect(refused.status).toBe(409);expect(await refused.json()).toEqual({error:"LOCKED is still being processed in batch catalog-test first owner. Wait for it to finish or remove them from this upload."});
    expect((await (await get(request("GET"),ctx(second))).json()).batch.status).toBe("draft");
  });
  it("records the plain no-photos failure and returns it from Start",async()=>{
    const id=await newBatch();
    const [plan]=await (await upload(request("POST",{files:[{name:"EMPTY_1.bmp",relativePath:"EMPTY_1.bmp",size:54,mime:"image/bmp"}]}),ctx(id))).json();
    const stored=(await db.select().from(catalogUploads)).find((u)=>u.id===plan.uploadId)!;const bmp=Buffer.alloc(54);bmp.write("BM");objects.set(stored.gcsUri!,{buf:bmp,mime:"image/bmp"});
    expect((await complete(request("POST"),ctx(id,stored.id))).status).toBe(200);await collectBatch(id);
    const shown=await (await preview(request("GET"),ctx(id))).json();expect(shown.counts.failReason).toContain("No photos were found");
    const refused=await start(request("POST",{previewAt:shown.previewAt}),ctx(id));expect(refused.status).toBe(400);expect((await refused.json()).error).toContain("No photos were found");
    expect((await (await get(request("GET"),ctx(id))).json()).batch.status).toBe("failed");
  });
  it("checks Google access, then copies a newly shared sheet through the real web adapter before worker ingest",async()=>{
    const id=await newBatch();await addPhoto(id);await collectBatch(id);
    const sheetUrl="https://docs.google.com/spreadsheets/d/accessible-sheet/edit";
    const read=vi.fn().mockRejectedValueOnce(Object.assign(new Error("No access"),{code:403})).mockResolvedValue({data:{properties:{title:"Shared products"},sheets:[{properties:{sheetId:0,title:"Products"}}]}});
    vi.mocked(googleClients).mockResolvedValue({sheets:{spreadsheets:{get:read,values:{get:vi.fn(async()=>({data:{values:[["Identifier","Photo"],["SHEET123","https://8.8.8.8/SHEET123_1.heic"]]}}))}}},drive:{files:{list:vi.fn(),get:vi.fn()}}});
    const denied=await links(request("POST",{text:sheetUrl}),ctx(id));expect((await denied.json()).access).toBe("no_access");
    expect((await (await get(request("GET"),ctx(id))).json()).counts.previewReady).toBe(true);
    const confirmed=await links(request("POST",{text:sheetUrl}),ctx(id));expect((await confirmed.json()).access).toBe("ok");
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    const sheet=(await db.select().from(catalogUploads)).find((u)=>u.batchId===id&&u.kind==="google_sheet")!;
    expect(sheet.gcsUri).toMatch(/^gs:\/\/test-assets\/catalog-test\//);expect(sheet.status).toBe("uploaded");
    await runIngest(db,{storage,fetch:vi.fn(async()=>new Response(new Uint8Array(heicFixture(1200,1600)),{headers:{"content-type":"image/heic"}})),enqueue:enqueueTask},{batchId:id,uploadId:sheet.id});
    const shown=await (await preview(request("GET"),ctx(id))).json();expect(shown.groups.map((g:{identifier:string})=>g.identifier).sort()).toEqual(["ABC123","SHEET123"]);
  });
});
