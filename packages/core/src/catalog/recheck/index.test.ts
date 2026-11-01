import ExcelJS from "exceljs";
import { expect,it,vi } from "vitest";
import { writeLinksXlsx,type SheetSpec } from "../sheet";
import { recheckSheet, recheckSheetPart, RECHECK_TIMEOUT_REASON, type RecheckProgress } from "./index";
const spec:SheetSpec={channels:["noon"],rows:[{brand:"Anta",identifier:"A",optionIdStyleColor:"",opptraSkuIds:[],links:{noon:["https://example.com/a.jpg"]},status:"ok",notes:"",change:"new",changedAt:null}]};
const request=()=>vi.fn(async()=>new Response(new Uint8Array([255,216,255]),{headers:{"content-type":"image/jpeg"}}));
it("independently reads a writer-generated workbook and fetches its link",async()=>{const fetch=request();expect(await recheckSheet(await writeLinksXlsx(spec),{fetch})).toEqual({ok:1,total:1,failures:[]});expect(fetch).toHaveBeenCalledWith("https://example.com/a.jpg",expect.objectContaining({signal:expect.any(AbortSignal)}));});
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
// Large-batch fix (2026-11-01): a link that never answers must not hold the re-check (and its finalize request) open.
it("fails a link that does not answer within the per-link time limit and goes on with the others", async () => {
  const two: SheetSpec = { ...spec, rows: [spec.rows[0]!, { ...spec.rows[0]!, identifier: "B", links: { noon: ["https://example.com/b.jpg"] } }] };
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/a.jpg")) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
  });
  const result = await recheckSheet(await writeLinksXlsx(two), { fetch: fetch as unknown as typeof globalThis.fetch, timeoutMs: 50 });
  expect(result).toEqual({ ok: 1, total: 2, failures: [{ url: "https://example.com/a.jpg", reason: RECHECK_TIMEOUT_REASON }] });
}, 10_000);
it("re-checks in parts up to a deadline, each link once, and a resumed part ends with the same result as one run", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ ...spec.rows[0]!, identifier: `P${i}`, links: { noon: [`https://example.com/p${i}.jpg`] } }));
  const xlsx = await writeLinksXlsx({ ...spec, rows });
  const fetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith("p3.jpg") ? new Response(null, { status: 404 }) : new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } }));
  const whole = await recheckSheet(xlsx, { fetch: fetch as unknown as typeof globalThis.fetch });
  fetch.mockClear();
  // A deadline already past: every part still reads one link, so the parts always move on.
  let part = await recheckSheetPart(xlsx, { fetch: fetch as unknown as typeof globalThis.fetch, deadlineAt: 0, now: () => 1 });
  let parts = 1;
  while (!part.done) { part = await recheckSheetPart(xlsx, { fetch: fetch as unknown as typeof globalThis.fetch, deadlineAt: 0, now: () => 1, resume: JSON.parse(JSON.stringify(part.progress)) as RecheckProgress }); parts++; }
  expect(parts).toBe(7);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(rows.map((r) => r.links.noon![0]));
  expect(part.result).toEqual(whole);
  expect(whole).toMatchObject({ ok: 6, total: 7 });
});
