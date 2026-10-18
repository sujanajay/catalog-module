import ExcelJS from "exceljs";
import { expect,it,vi } from "vitest";
import { writeLinksXlsx,type SheetSpec } from "../sheet";
import { recheckSheet } from "./index";
const spec:SheetSpec={channels:["noon"],rows:[{brand:"Anta",identifier:"A",optionIdStyleColor:"",opptraSkuIds:[],links:{noon:["https://example.com/a.jpg"]},status:"ok",notes:"",change:"new",changedAt:null}]};
const request=()=>vi.fn(async()=>new Response(new Uint8Array([255,216,255]),{headers:{"content-type":"image/jpeg"}}));
it("independently reads a writer-generated workbook and fetches its link",async()=>{const fetch=request();expect(await recheckSheet(await writeLinksXlsx(spec),{fetch})).toEqual({ok:1,total:1,failures:[]});expect(fetch).toHaveBeenCalledWith("https://example.com/a.jpg");});
it("reads only a split JPEG signature and cancels the remaining image", async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(new Uint8Array([255]));
      else if (pulls === 2) controller.enqueue(new Uint8Array([216, 255]));
      else controller.error(new Error("The image tail must not be downloaded."));
    },
    cancel,
  }, { highWaterMark: 0 });
  const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "image/jpeg" } }));
  expect(await recheckSheet(await writeLinksXlsx(spec), { fetch })).toEqual({ ok: 1, total: 1, failures: [] });
  expect(pulls).toBe(2);
  expect(cancel).toHaveBeenCalledOnce();
});
it("detects altered hyperlink text, duplicate URLs, rows and bad suffix",async()=>{const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await writeLinksXlsx(spec) as unknown as Parameters<typeof workbook.xlsx.load>[0]);const ws=workbook.worksheets[0]!;ws.getCell(3,5).value={text:"wrong",hyperlink:"https://example.com/a.jpg"};ws.getCell(4,2).value="A";ws.getCell(4,5).value={text:"https://example.com/a.jpg",hyperlink:"https://example.com/a.jpg"};ws.getCell(5,2).value="B";ws.getCell(5,5).value={text:"https://example.com/b.jpeg",hyperlink:"https://example.com/b.jpeg"};const result=await recheckSheet(Buffer.from(await workbook.xlsx.writeBuffer()),{fetch:request()});expect(result.ok).toBe(0);expect(result.failures).toHaveLength(4);});
