import { readFileSync } from "node:fs";
import path from "node:path";
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
import { DELETE as removeLinks, PATCH as patchLinks } from "../app/api/catalog/batches/[id]/links/[uploadId]/route";
import { DELETE as removeUpload } from "../app/api/catalog/batches/[id]/uploads/[uploadId]/route";
import { POST as ingest } from "../app/api/catalog/batches/[id]/ingest/route";
import { GET as detected, PATCH as regroup } from "../app/api/catalog/batches/[id]/detected/route";
import { GET as preview } from "../app/api/catalog/batches/[id]/preview/route";
import { POST as start } from "../app/api/catalog/batches/[id]/start/route";
import { setDbForTests, type Db } from "../lib/db";
import { handOffError } from "../lib/catalog/uploads";
import { HAND_OFF_FAILED, HAND_OFF_RETRY } from "../lib/catalog/copy";
import { COLLECT_STALLED_TEXT } from "@catalog/core/catalog/pipeline/status";
import { resetUserDeps, setUserDeps } from "../lib/user";

vi.mock("@catalog/core/tasks", () => ({ enqueueTask: vi.fn(async () => "test-task") }));
// The paste readback opens the first links (spec 14b F2): a fake image host and a fake resolver, so no network is used.
vi.mock("@catalog/core/safe-url", async (original) => {
  const actual = await original<typeof import("@catalog/core/safe-url")>();
  const jpegHead = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), { status: 206, headers: { "content-type": "image/jpeg" } });
  const shareHost = /dropbox\.example\.com/;
  return {
    ...actual,
    pinnedFetch: vi.fn(async (input: RequestInfo | URL) => (shareHost.test(String(input)) ? new Response("<html>Dropbox</html>", { status: 200, headers: { "content-type": "text/html" } }) : jpegHead())),
    safeFetch: (url: string, opts: import("@catalog/core/safe-url").SafeFetchOptions = {}) => actual.safeFetch(url, { lookup: async () => ["93.184.215.14"], ...opts }),
  };
});
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
  vi.stubEnv("CATALOG_CHUNK_IMAGES", undefined);
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
  it("makes every test_brand batch a test batch whatever its name, so its objects stay under catalog-test/",async()=>{
    await db.insert(brandMaster).values({slug:"test_brand",name:"Test Brand",line:"softline",source:"manual"}).onConflictDoNothing();
    const response=await create(request("POST",{brandSlug:"test_brand",productType:"auto",name:"Spring shoes"}));expect(response.status).toBe(201);
    const {id}=await response.json() as {id:string};
    expect((await db.select().from(catalogBatches).where(eq(catalogBatches.id,id)))[0]!.isTest).toBe(true);
    expect((await patch(request("PATCH",{name:"Spring shoes again"}),ctx(id))).status).toBe(200);
    const planned=await upload(request("POST",{files:[{name:"ABC_1.heic",size:10,mime:"image/heic",relativePath:"ABC_1.heic"}]}),ctx(id));
    expect(((await planned.json()) as {putUrl:string}[])[0]!.putUrl).toContain("catalog-test/test_brand/");
  });
  it("uses the deployed chunk image setting when the operator starts a batch",async()=>{
    vi.stubEnv("CATALOG_CHUNK_IMAGES","1");
    const id=await newBatch();
    await addPhoto(id,"CHUNK_A_1.heic");await addPhoto(id,"CHUNK_B_1.heic");
    await collectBatch(id);await patch(request("PATCH",{channels:["noon"]}),ctx(id));
    const shown=await (await preview(request("GET"),ctx(id))).json();
    expect((await start(request("POST",{previewAt:shown.previewAt}),ctx(id))).status).toBe(200);
    const chunks=await db.select().from(catalogChunks).where(eq(catalogChunks.batchId,id));
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk)=>chunk.sourceImageIds?.length)).toEqual([1,1]);
  });
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
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:"url_list",access:"ok",summary:"Products will be named from the file names, for example ABC. We opened the first 2 links: all fine.",count:2,pill:"2 image links",notes:[]});
  });
  it("reads back a pasted grid and explains a share page while still keeping the paste (spec 14b F2)",async()=>{
    const id=await newBatch();
    const grid=readFileSync(path.resolve(__dirname,"../../../packages/core/test-fixtures/catalog/intake/intake-pasted-grid.txt"),"utf8");
    const body=await (await links(request("POST",{text:grid}),ctx(id))).json();
    expect(body).toMatchObject({kind:"url_list",access:"ok",count:27,pill:"6 rows, 27 links",notes:["3 empty or non-link cells were ignored."]});
    expect(body.summary).toBe("4 to 5 links per row. This paste has no product code column, so products will be named from the photo file names, for example BH-4610-NE-NERO. To name them yourself, copy the product code column in as the first column. We opened the first 3 links: all fine.");
    const shared=await newBatch();
    const share=await (await links(request("POST",{text:"https://www.dropbox.example.com/s/tbd1share/TB-D_1.JPG?dl=0"}),ctx(shared))).json();
    expect(share.notes).toEqual(["These look like share pages, not image links. Download the photos and drop them here, or paste direct image links."]);
    const [row]=await db.select().from(catalogUploads).where(eq(catalogUploads.batchId,shared));
    expect(row!.status).toBe("uploaded");expect(row!.detected).toMatchObject({shape:"one_per_line",sample:{tried:1,ok:0,webPages:1}});
  });
  it("keeps folder paths and HEIC, collects, re-groups without fetching URLs, previews and starts real chunks",async()=>{
    const id=await newBatch();const photo=await addPhoto(id,"ABC123/ABC123_1.heic");await collectBatch(id);
    const found=await (await detected(request("GET"),ctx(id))).json();expect(found.formats.heic).toBe(1);expect(found.identifierMode.examples[0].identifier).toBe("ABC123");
    const changed=await regroup(request("PATCH",{identifierMode:"folder"}),ctx(id));expect(changed.status).toBe(200);
    await runIngest(db,{storage,fetch:vi.fn(()=>{throw new Error("Should not fetch again");}),enqueue:enqueueTask},{batchId:id,uploadId:photo.id});
    expect((await patch(request("PATCH",{channels:["noon","styli"]}),ctx(id))).status).toBe(200);
    const shown=await (await preview(request("GET"),ctx(id))).json();expect(shown.ready).toBe(true);expect(shown.estimate).toBeNull();expect(shown.groupedBy).toBe("Grouped by folder name");expect(shown.groups[0].files[0]).toMatchObject({n:1,originalName:"ABC123/ABC123_1.heic",width:1200,height:1600});expect(shown.groups[0].firstPhotoUrl).toContain("thumb.example");expect(shown.counts.outputs).toBe(2);
    const info=vi.spyOn(console,"info").mockImplementation(()=>{});
    const response=await start(request("POST",{previewAt:shown.previewAt}),ctx(id));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({id,status:"matting"});
    const lines=info.mock.calls.map(([line])=>{try{return JSON.parse(String(line)) as Record<string,unknown>;}catch{return {};}});info.mockRestore();
    expect(lines.filter(l=>l.message==="batch started")).toEqual([expect.objectContaining({severity:"INFO",batchId:id,products:1,sources:1,outputs:2,chunks:1,"logging.googleapis.com/labels":{app:"catalog",batchId:id}})]);
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
    const logged=vi.spyOn(console,"warn").mockImplementation(()=>{}),errors=vi.spyOn(console,"error").mockImplementation(()=>{});
    const [plan]=await (await upload(request("POST",{files:[{name:"EMPTY_1.bmp",relativePath:"EMPTY_1.bmp",size:54,mime:"image/bmp"}]}),ctx(id))).json();
    const stored=(await db.select().from(catalogUploads)).find((u)=>u.id===plan.uploadId)!;const bmp=Buffer.alloc(54);bmp.write("BM");objects.set(stored.gcsUri!,{buf:bmp,mime:"image/bmp"});
    expect((await complete(request("POST"),ctx(id,stored.id))).status).toBe(200);await collectBatch(id);
    const shown=await (await preview(request("GET"),ctx(id))).json();expect(shown.counts.failReason).toContain("No photos were found");
    // Log contract: an upload with nothing usable logs "batch failed" at WARNING (no alert, no Error Reporting), never ERROR.
    const parse=(calls:unknown[][])=>calls.map(([line])=>{try{return JSON.parse(String(line)) as Record<string,unknown>;}catch{return {};}}).filter(l=>l.message==="batch failed");
    const failed=parse(logged.mock.calls),asErrors=parse(errors.mock.calls);logged.mockRestore();errors.mockRestore();
    expect(failed).toEqual([expect.objectContaining({severity:"WARNING",batchId:id,reason:shown.counts.failReason,cause:"no_photos"})]);
    expect(asErrors).toEqual([]);
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

describe("ingest hand-off failures and stalled collecting",()=>{
  const reset=()=>Object.assign(new Error("14 UNAVAILABLE: read ECONNRESET"),{code:14,details:"read ECONNRESET"});
  const statusOf=async(id:string)=>(await db.select().from(catalogBatches).where(eq(catalogBatches.id,id)))[0]!.status;
  const ingestCalls=()=>vi.mocked(enqueueTask).mock.calls.filter(([route])=>route==="/tasks/catalog/ingest");
  const age=async(id:string,minutes:number)=>db.update(catalogBatches).set({updatedAt:new Date(Date.now()-minutes*60_000)}).where(eq(catalogBatches.id,id));
  it("maps transient and permanent hand-off errors to plain sentences, never the library text",()=>{
    expect(handOffError(reset())).toMatchObject({status:503,message:HAND_OFF_RETRY});
    expect(handOffError(Object.assign(new Error("4 DEADLINE_EXCEEDED"),{code:4}))).toMatchObject({status:503,message:HAND_OFF_RETRY});
    expect(handOffError(Object.assign(new Error("7 PERMISSION_DENIED: cloudtasks.tasks.create"),{code:7}))).toMatchObject({status:500,message:HAND_OFF_FAILED});
  });
  it("gives the batch back its draft state when nothing reached the queue, so a second Continue works instead of 409",async()=>{
    const logged=vi.spyOn(console,"error").mockImplementation(()=>{});
    const id=await newBatch();const photo=await addPhoto(id);
    expect((await patch(request("PATCH",{name:"catalog-test e2e b"}),ctx(id))).status).toBe(200);
    vi.mocked(enqueueTask).mockRejectedValueOnce(reset());
    const failed=await ingest(request("POST"),ctx(id));
    expect(failed.status).toBe(503);
    const text=await failed.text();expect(JSON.parse(text)).toEqual({error:HAND_OFF_RETRY});expect(text).not.toMatch(/UNAVAILABLE|ECONNRESET/);
    expect(logged.mock.calls.flat().join(" ")).toContain("read ECONNRESET");
    expect(await statusOf(id)).toBe("draft");
    // The wizard's second Continue: PATCH then /ingest, both accepted now.
    expect((await patch(request("PATCH",{name:"catalog-test e2e b"}),ctx(id))).status).toBe(200);
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    expect(await statusOf(id)).toBe("ingesting");
    const ids=ingestCalls().map(([,body,opts])=>{expect(body).toEqual({batchId:id,uploadId:photo.id});return opts?.taskId;});
    expect(ids).toHaveLength(2);
    for(const taskId of ids) expect(taskId).toMatch(new RegExp(`^ingest-${photo.id}-[0-9a-f-]{36}$`));
    expect(ids[0]).not.toBe(ids[1]);
    logged.mockRestore();
  });
  it("keeps the batch collecting once part of the hand-off reached the queue, and the next /ingest hands over the rest",async()=>{
    const logged=vi.spyOn(console,"error").mockImplementation(()=>{});
    const id=await newBatch();const a=await addPhoto(id,"PART_A_1.heic");const b=await addPhoto(id,"PART_B_1.heic");
    vi.mocked(enqueueTask).mockResolvedValueOnce("queued").mockRejectedValueOnce(reset());
    expect((await ingest(request("POST"),ctx(id))).status).toBe(503);
    expect(await statusOf(id)).toBe("ingesting");
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    expect(ingestCalls().slice(2).map(([,body])=>(body as {uploadId:string}).uploadId).sort()).toEqual([a.id,b.id].sort());
    logged.mockRestore();
  });
  it("shows a collecting batch with no progress for 10 minutes as stalled, and Try again re-runs the hand-off",async()=>{
    const id=await newBatch();const photo=await addPhoto(id);
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    expect((await (await get(request("GET"),ctx(id))).json()).state.stalled).toBeUndefined();
    await age(id,15);
    const stuck=(await (await get(request("GET"),ctx(id))).json()).state;
    expect(stuck).toMatchObject({state:"collecting",stalled:true,text:COLLECT_STALLED_TEXT});
    vi.mocked(enqueueTask).mockClear();
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    expect(ingestCalls().map(([,body])=>body)).toEqual([{batchId:id,uploadId:photo.id}]);
    expect((await (await get(request("GET"),ctx(id))).json()).state.stalled).toBeUndefined();
  });
  it("Try again on a stalled batch whose files were all read hands one read upload over, so the grouping step runs",async()=>{
    const id=await newBatch();const photo=await addPhoto(id);await collectBatch(id);
    // The batch-wide step was lost: every upload is collected but the batch never left collecting.
    const [row]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,id));
    await db.update(catalogBatches).set({status:"ingesting",counts:{...row!.counts,previewReady:false},updatedAt:new Date(Date.now()-15*60_000)}).where(eq(catalogBatches.id,id));
    vi.mocked(enqueueTask).mockClear();
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    expect(ingestCalls().map(([,body])=>body)).toEqual([{batchId:id,uploadId:photo.id}]);
    await runIngest(db,{storage,fetch:vi.fn(),enqueue:enqueueTask},{batchId:id,uploadId:photo.id});
    const [after]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,id));
    expect(after!.status).toBe("draft");expect(after!.counts.previewReady).toBe(true);
  });
});

describe("inputs corrected without duplicates (spec 14b F3)",()=>{
  const heic=()=>vi.fn(async()=>new Response(new Uint8Array(heicFixture(1200,1600)),{headers:{"content-type":"image/heic"}}));
  const rowsOf=async(id:string)=>(await db.select().from(catalogUploads)).filter((u)=>u.batchId===id);
  const countsOf=async(id:string)=>(await db.select().from(catalogBatches).where(eq(catalogBatches.id,id)))[0]!.counts;
  async function collectAll(id:string){
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    const fetchImage=heic();
    for(const u of (await rowsOf(id)).filter((u)=>u.status==="uploaded"))await runIngest(db,{storage,fetch:fetchImage,enqueue:enqueueTask},{batchId:id,uploadId:u.id});
  }
  const groupsOf=async(id:string)=>((await (await preview(request("GET"),ctx(id))).json()).groups as {identifier:string}[]).map((g)=>g.identifier).sort();
  it("paste A (3 links) then PATCH with text B (2 links): one url_list row, 2 links, preview invalidated",async()=>{
    const id=await newBatch();
    const first=await links(request("POST",{text:"https://8.8.8.8/AAA_1.heic\nhttps://8.8.8.8/AAA_2.heic\nhttps://8.8.8.8/BBB_1.heic"}),ctx(id));
    expect(first.status).toBe(200);const {uploadId}=await first.json() as {uploadId:string};
    await collectAll(id);expect((await countsOf(id)).previewReady).toBe(true);
    expect(await groupsOf(id)).toEqual(["AAA","BBB"]);
    const replaced=await patchLinks(request("PATCH",{text:"https://8.8.8.8/CCC_1.heic\nhttps://8.8.8.8/CCC_2.heic"}),ctx(id,uploadId));
    expect(replaced.status).toBe(200);expect(await replaced.json()).toMatchObject({kind:"url_list",access:"ok",count:2,uploadId});
    const lists=(await rowsOf(id)).filter((u)=>u.kind==="url_list");
    expect(lists).toHaveLength(1);expect(lists[0]!.id).toBe(uploadId);expect(lists[0]!.status).toBe("uploaded");
    expect(lists[0]!.sourceUrl!.split("\n")).toHaveLength(2);
    expect((await countsOf(id)).previewReady).toBe(false);
    await collectAll(id);
    expect(await groupsOf(id)).toEqual(["CCC"]);
  });
  it("binds the paste box to one url_list row: a second POST /links replaces it, and a removed paste comes back as the same row",async()=>{
    const id=await newBatch();
    const a=await (await links(request("POST",{text:"https://8.8.8.8/AAA_1.heic"}),ctx(id))).json() as {uploadId:string};
    const b=await (await links(request("POST",{text:"https://8.8.8.8/BBB_1.heic\nhttps://8.8.8.8/BBB_2.heic"}),ctx(id))).json() as {uploadId:string};
    expect(b.uploadId).toBe(a.uploadId);
    expect((await rowsOf(id)).filter((u)=>u.kind==="url_list")).toHaveLength(1);
    expect((await removeLinks(request("DELETE"),ctx(id,a.uploadId))).status).toBe(200);
    expect((await rowsOf(id))[0]!.status).toBe("removed");
    const again=await (await links(request("POST",{text:"https://8.8.8.8/DDD_1.heic"}),ctx(id))).json() as {uploadId:string};
    expect(again.uploadId).toBe(a.uploadId);
    const rows=await rowsOf(id);expect(rows).toHaveLength(1);expect(rows[0]!.status).toBe("uploaded");
  });
  it("DELETE an upload: the row is removed, the preview is invalidated by a merge, and ingestBatch ignores it",async()=>{
    const id=await newBatch();const kept=await addPhoto(id,"KEEP_1.heic");const gone=await addPhoto(id,"GONE_1.heic");
    await collectAll(id);expect(await groupsOf(id)).toEqual(["GONE","KEEP"]);
    // A counts key written by the worker after the web tier read the row must survive (merge, not replace).
    await db.update(catalogBatches).set({counts:{...(await countsOf(id)),collected:7}}).where(eq(catalogBatches.id,id));
    const removed=await removeUpload(request("DELETE"),ctx(id,gone.id));
    expect(removed.status).toBe(200);expect(await removed.json()).toEqual({removed:true});
    expect((await rowsOf(id)).find((u)=>u.id===gone.id)!.status).toBe("removed");
    const counts=await countsOf(id);expect(counts.previewReady).toBe(false);expect(counts.collected).toBe(7);
    vi.mocked(enqueueTask).mockClear();
    expect((await ingest(request("POST"),ctx(id))).status).toBe(200);
    const handed=vi.mocked(enqueueTask).mock.calls.filter(([route])=>route==="/tasks/catalog/ingest").map(([,body])=>(body as {uploadId:string}).uploadId);
    expect(handed).toEqual([kept.id]);
    for(const uploadId of handed)await runIngest(db,{storage,fetch:vi.fn(),enqueue:enqueueTask},{batchId:id,uploadId});
    expect(await groupsOf(id)).toEqual(["KEEP"]);
    // A delivery for the removed upload queued before the removal reads nothing.
    expect((await runIngest(db,{storage,fetch:vi.fn(),enqueue:enqueueTask},{batchId:id,uploadId:gone.id})).outcome).toBe("noop: upload already removed");
  });
  it("a batch with one removed and one uploaded row collects the uploaded one only",async()=>{
    const id=await newBatch();const gone=await addPhoto(id,"OLD_1.heic");
    expect((await removeUpload(request("DELETE"),ctx(id,gone.id))).status).toBe(200);
    const kept=await addPhoto(id,"NEW_1.heic");
    await collectAll(id);
    const rows=await rowsOf(id);
    expect(rows.find((u)=>u.id===gone.id)!.status).toBe("removed");expect(rows.find((u)=>u.id===kept.id)!.status).toBe("collected");
    expect(await groupsOf(id)).toEqual(["NEW"]);
    expect(JSON.stringify(await (await detected(request("GET"),ctx(id))).json())).not.toContain("OLD");
  });
  it("keeps a file removed while it uploaded removed when its completion arrives, and it no longer blocks Continue",async()=>{
    const id=await newBatch();
    const [plan]=await (await upload(request("POST",{files:[{name:"LATE_1.heic",size:10,mime:"image/heic",relativePath:"LATE_1.heic"}]}),ctx(id))).json();
    const row=(await rowsOf(id))[0]!;objects.set(row.gcsUri!,{buf:Buffer.alloc(10),mime:"image/heic"});
    expect((await removeUpload(request("DELETE"),ctx(id,plan.uploadId))).status).toBe(200);
    expect((await complete(request("POST"),ctx(id,plan.uploadId))).status).toBe(410);
    expect((await rowsOf(id))[0]!.status).toBe("removed");
    const refused=await ingest(request("POST"),ctx(id));
    expect(refused.status).toBe(400);expect((await refused.json()).error).toBe("Add photos or a links sheet before continuing.");
  });
});
