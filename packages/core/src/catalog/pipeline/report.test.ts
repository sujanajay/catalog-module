import {expect,it,vi} from "vitest";
import {cutInSourceNote,mergeNotes,readIngestReport} from "./report";
import {outputNote} from "./publish";
it("keeps rejected images without DB rows in the final report",async()=>{
  const ledger={rejected:[{item:{item:{originalName:"A.bmp",identifier:"A"}},reason:"A.bmp is a BMP file. Save it as JPEG or PNG and add it again."},{item:{item:{originalName:"B_1.jpg",identifier:"B"}},reason:"Two files claim shot 1 of B: B_1.jpg, B-1.jpg. Rename one and re-upload."}],duplicates:[{a:"C-1",b:"C1"}]};
  const result=await readIngestReport({getBucketName:()=>"assets",headObject:vi.fn(async()=>({exists:true,size:1,contentType:"application/json",generation:"1",crc32c:"x"})),downloadBuffer:vi.fn(async()=>({buf:Buffer.from(JSON.stringify(ledger)),mime:"application/json"}))},"catalog-test/anta/batch");
  expect(result!.unsupportedFiles).toEqual([expect.objectContaining({name:"A.bmp",identifier:"A"})]);
  expect(result!.duplicates).toHaveLength(2);
});
it("lists each note once although the publish step already stored it",()=>{const skipped=outputNote({channel:"styli",n:1,reason:"Skipped for Styli: the photo is smaller than Styli needs.",decision:null,decidedBy:null}),second=outputNote({channel:"styli",n:2,reason:"Skipped for Styli: the photo is smaller than Styli needs.",decision:null,decidedBy:null});expect(mergeNotes(`${skipped}; ${second}`,[skipped,second,""])).toBe(`${skipped}; ${second}`);expect(mergeNotes(null,[skipped,skipped])).toBe(skipped);});
it("notes cut-in-source shots once per photo and never for failed or skipped outputs",()=>{const o=(n:number,status:"verified"|"skipped"|"failed",flags:("cut_in_source"|"low_resolution")[]=["cut_in_source"])=>({n,status,flags});expect(cutInSourceNote([o(3,"verified"),o(1,"verified"),o(1,"verified"),o(2,"skipped"),o(4,"failed"),o(5,"verified",["low_resolution"])])).toBe("Photos 1 and 3: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image");expect(cutInSourceNote([o(2,"verified")])).toMatch(/^Photo 2: /);expect(cutInSourceNote([])).toBe("");});
