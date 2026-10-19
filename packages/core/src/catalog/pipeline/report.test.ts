import {expect,it,vi} from "vitest";
import {readIngestReport} from "./report";
it("keeps rejected images without DB rows in the final report",async()=>{
  const ledger={rejected:[{item:{item:{originalName:"A.bmp",identifier:"A"}},reason:"A.bmp is a BMP file. Save it as JPEG or PNG and add it again."},{item:{item:{originalName:"B_1.jpg",identifier:"B"}},reason:"Two files claim shot 1 of B: B_1.jpg, B-1.jpg. Rename one and re-upload."}],duplicates:[{a:"C-1",b:"C1"}]};
  const result=await readIngestReport({getBucketName:()=>"assets",headObject:vi.fn(async()=>({exists:true,size:1,contentType:"application/json",generation:"1",crc32c:"x"})),downloadBuffer:vi.fn(async()=>({buf:Buffer.from(JSON.stringify(ledger)),mime:"application/json"}))},"catalog-test/anta/batch");
  expect(result!.unsupportedFiles).toEqual([expect.objectContaining({name:"A.bmp",identifier:"A"})]);
  expect(result!.duplicates).toHaveLength(2);
});
