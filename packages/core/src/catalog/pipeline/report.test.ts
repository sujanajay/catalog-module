import {expect,it,vi} from "vitest";
import {cutInSourceNote,deliveredLinks,mergeNotes,readIngestReport,sortNotesByPhoto,splitRecheck,typeUnknownNote} from "./report";
import {CATALOG_QA_DEFAULT_MODEL} from "../qa/classify";
import {DEFAULT_POLICIES} from "../qa/policy";
import {outputNote} from "./publish";
it("keeps rejected images without DB rows in the final report",async()=>{
  const ledger={rejected:[{item:{item:{originalName:"A.bmp",identifier:"A"}},reason:"A.bmp is a BMP file. Save it as JPEG or PNG and add it again."},{item:{item:{originalName:"B_1.jpg",identifier:"B"}},reason:"Two files claim shot 1 of B: B_1.jpg, B-1.jpg. Rename one and re-upload."}],duplicates:[{a:"C-1",b:"C1"}]};
  const result=await readIngestReport({getBucketName:()=>"assets",headObject:vi.fn(async()=>({exists:true,size:1,contentType:"application/json",generation:"1",crc32c:"x"})),downloadBuffer:vi.fn(async()=>({buf:Buffer.from(JSON.stringify(ledger)),mime:"application/json"}))},"catalog-test/anta/batch");
  expect(result!.unsupportedFiles).toEqual([expect.objectContaining({name:"A.bmp",identifier:"A"})]);
  expect(result!.duplicates).toHaveLength(2);
});
it("lists each note once although the publish step already stored it",()=>{const skipped=outputNote({channel:"styli",n:1,reason:"Skipped for Styli: the photo is smaller than Styli needs.",decision:null,decidedBy:null}),second=outputNote({channel:"styli",n:2,reason:"Skipped for Styli: the photo is smaller than Styli needs.",decision:null,decidedBy:null});expect(mergeNotes(`${skipped}; ${second}`,[skipped,second,""])).toBe(`${skipped}; ${second}`);expect(mergeNotes(null,[skipped,skipped])).toBe(skipped);});
it("notes cut-in-source shots once per photo and never for failed or skipped outputs",()=>{const o=(n:number,status:"verified"|"skipped"|"failed",flags:("cut_in_source"|"low_resolution")[]=["cut_in_source"])=>({n,status,flags});expect(cutInSourceNote([o(3,"verified"),o(1,"verified"),o(1,"verified"),o(2,"skipped"),o(4,"failed"),o(5,"verified",["low_resolution"])])).toBe("Photos 1 and 3: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image");expect(cutInSourceNote([o(2,"verified")])).toMatch(/^Photo 2: /);expect(cutInSourceNote([])).toBe("");});
it("leaves a photo out of the flush cut note when its cut edge does not sit flush on some channel",()=>{
  const band="The original photo is cut at the top, but on Trendyol the product cannot reach that edge of the image without trimming more of it, so a band shows there.";
  const o=(n:number,reason:string|null=null)=>({n,status:"verified" as const,flags:["cut_in_source" as const],reason});
  expect(cutInSourceNote([o(3),o(4),o(5),o(5,`Kept the original colours; ${band}`)])).toBe("Photos 3 and 4: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image");
  expect(cutInSourceNote([o(5,band)])).toBe("");
});
it("lists the sheet notes in photo order, keeping a continuation with its note",()=>{
  const notes="Styli img 7: Skipped for Styli: small.; Styli img 8: Skipped for Styli: small.; Styli img 1: Skipped for Styli: small.; Photos 2 and 3: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image";
  expect(sortNotesByPhoto(notes)).toBe("Styli img 1: Skipped for Styli: small.; Photos 2 and 3: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image; Styli img 7: Skipped for Styli: small.; Styli img 8: Skipped for Styli: small.");
  expect(mergeNotes("Noon img 3: kept.",["Namshi img 1: kept.","Two files for one shot."])).toBe("Two files for one shot.; Namshi img 1: kept.; Noon img 3: kept.");
});
it("counts delivered links the same way on both Details lines (quality gate 2: 336 of 376 against 376 of 376)",()=>{
  const o=(productId:string,batchId:string,channel:"noon"|"amazon",n:number,status:"verified"|"staged"|"needs_attention"|"skipped",isLive:boolean)=>({productId,batchId,channel,n,status,isLive,publicUrl:`https://pub/${productId}/${channel}/${n}/${batchId}`});
  const outputs=[o("A","b2","noon",1,"verified",true),o("A","b2","amazon",1,"verified",true),
    // Held product B: re-made in b2 but waiting for a decision; its b1 links stay in the sheet.
    o("B","b2","noon",1,"needs_attention",false),o("B","b2","amazon",1,"staged",false),o("B","b1","noon",1,"verified",true),o("B","b1","amazon",1,"verified",true),
    // Shot 2 of B was not re-made (unchanged): delivered, not carried.
    o("B","b1","noon",2,"verified",true),o("B","b2","amazon",2,"skipped",false)];
  const d=deliveredLinks({batchId:"b2",channels:["noon","amazon"],heldProductIds:new Set(["B"]),outputs});
  expect(d.held).toBe(2);
  expect(d.carried.sort()).toEqual(["https://pub/B/amazon/1/b1","https://pub/B/noon/1/b1"]);
  // The sheet holds 5 links: 3 delivered by this batch and 2 carried over; one carried link failed.
  expect(splitRecheck({ok:4,total:5,failures:[{url:"https://pub/B/noon/1/b1",reason:"HTTP 404"}]},d.carried)).toEqual({ok:3,total:3,carriedOk:1,carriedTotal:2});
});
it("notes a product whose type could not be checked once, first, with no model id in it (gate 3h)",()=>{
  const note=typeUnknownNote([{flags:["type_unknown","cut_in_source"]},{flags:["type_unknown"]}]);
  expect(note).toBe("We could not tell what kind of product this is, so the general treatment was used.");
  expect(typeUnknownNote([{flags:["cut_in_source"]}])).toBe("");
  const ids=[CATALOG_QA_DEFAULT_MODEL,...Object.values(DEFAULT_POLICIES).flatMap(p=>[p.qaModel,p.qaModelSecond,p.matteModel,p.matteModelSecond])].filter((id):id is string=>!!id);
  for(const id of ids) expect(note.toLowerCase()).not.toContain(id.toLowerCase());
  expect(note).not.toMatch(/gemini|claude|haiku|qwen|anthropic|google|openrouter|model/i);
  const flush="Photos 1 and 2: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image";
  expect(mergeNotes(null,["Noon img 2: Skipped.",note,flush])).toBe(`${note}; ${flush}; Noon img 2: Skipped.`);
});
