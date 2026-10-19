import { expect, it, vi } from "vitest";
import { verifyPublic, verifyPublicSettled } from "./verify";
const jpeg=Buffer.from([255,216,255,1]);
function response(patch:Record<string,string>={},status=200,bytes=jpeg) { return new Response(new Uint8Array(bytes),{status,headers:{"content-type":"image/jpeg; charset=binary","content-length":"4","x-goog-generation":"12",...patch}}); }
it("accepts the media type suffix and correct generation",async()=>expect(await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:vi.fn(async()=>response())})).toEqual({ok:true}));
it.each<{name:string;patch:Record<string,string>}>([{name:"type",patch:{"content-type":"image/png"}},{name:"size",patch:{"content-length":"5"}},{name:"generation",patch:{"x-goog-generation":"11"}}])("rejects wrong $name",async({patch})=>expect((await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:vi.fn(async()=>response(patch)),sleep:async()=>{}})).ok).toBe(false));
it("rejects jpeg suffix without a request",async()=>{const request=vi.fn();expect((await verifyPublic("https://example.com/a.jpeg",{size:4,generation:12,fetch:request})).ok).toBe(false);expect(request).not.toHaveBeenCalled();});
it("retries a stale generation and transient failures",async()=>{const request=vi.fn().mockResolvedValueOnce(response({},503)).mockResolvedValueOnce(response({"x-goog-generation":"11"})).mockResolvedValue(response());expect((await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:request,sleep:async()=>{}})).ok).toBe(true);expect(request).toHaveBeenCalledTimes(3);});
it("rejects wrong JPEG magic and HTTP failures",async()=>{for(const r of [response({},200,Buffer.from("text")),response({},404)]) expect((await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:vi.fn(async()=>r)})).ok).toBe(false);});
it("an independent reader waits out a cached previous generation within the public cache window",async()=>{
  let clock=0;const sleep=async(ms:number)=>{clock+=ms;};
  const request=vi.fn().mockResolvedValue(response({"x-goog-generation":"11"}));
  for(let i=0;i<20;i++) request.mockResolvedValueOnce(response({"x-goog-generation":"11"}));
  request.mockResolvedValue(response());
  expect(await verifyPublicSettled("https://example.com/a.jpg",{size:4,generation:12,fetch:request,sleep,now:()=>clock})).toEqual({ok:true});
  const stale=vi.fn(async()=>response({"x-goog-generation":"11"}));clock=0;
  expect(await verifyPublicSettled("https://example.com/a.jpg",{size:4,generation:12,fetch:stale,sleep,now:()=>clock})).toEqual({ok:false,reason:"The public link returned a different generation."});
  expect(clock).toBeGreaterThanOrEqual(600_000);
  const wrongType=vi.fn(async()=>response({"content-type":"image/png"}));clock=0;
  expect((await verifyPublicSettled("https://example.com/a.jpg",{size:4,generation:12,fetch:wrongType,sleep,now:()=>clock})).ok).toBe(false);
  expect(wrongType).toHaveBeenCalledTimes(1);
});
it("publication reads the copied generation when the plain link keeps serving a cached older one",async()=>{
  const plainStale=vi.fn(async(url:Parameters<typeof fetch>[0])=>String(url).includes("?generation=12") ? response():response({"x-goog-generation":"11"}));
  expect(await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:plainStale,sleep:async()=>{},pinnedFallback:true})).toEqual({ok:true});
  expect(plainStale).toHaveBeenLastCalledWith("https://example.com/a.jpg?generation=12",expect.anything());
  expect(await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:plainStale,sleep:async()=>{}})).toEqual({ok:false,reason:"The public link returned a different generation."});
  const missing=vi.fn(async(url:Parameters<typeof fetch>[0])=>String(url).includes("?generation=") ? response({},404):response({"x-goog-generation":"11"}));
  expect(await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:missing,sleep:async()=>{},pinnedFallback:true})).toEqual({ok:false,reason:"HTTP 404"});
  const wrongBytes=vi.fn(async(url:Parameters<typeof fetch>[0])=>String(url).includes("?generation=") ? response({"content-length":"5"}):response({"x-goog-generation":"11"}));
  expect((await verifyPublic("https://example.com/a.jpg",{size:4,generation:12,fetch:wrongBytes,sleep:async()=>{},pinnedFallback:true})).ok).toBe(false);
});
