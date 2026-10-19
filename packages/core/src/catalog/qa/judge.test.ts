import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { judgeOutput, normalizeScores, verdictFor, QA_DIMENSIONS } from "./judge";
import { classifyProductType } from "./classify";
import { CATALOG_QA_TEMPLATE, renderTemplate } from "./templates";
import { QA_USD_PER_CHECK_FALLBACK } from "../cost";
/** A non-streaming OpenRouter chat completion as it arrives in production (usage is always present). */
const openRouterReply = (content: string) => ({id:"gen-1760900000-abc",provider:"Google",model:"test",object:"chat.completion",created:1760900000,
 choices:[{logprobs:null,finish_reason:"stop",native_finish_reason:"STOP",index:0,message:{role:"assistant",content,refusal:null,reasoning:null}}],
 usage:{prompt_tokens:2911,completion_tokens:160,total_tokens:3071,cost:0.000139,is_byok:false,prompt_tokens_details:{cached_tokens:0,audio_tokens:0},cost_details:{upstream_inference_cost:null,upstream_inference_prompt_cost:0.0002911,upstream_inference_completions_cost:0.000064},completion_tokens_details:{reasoning_tokens:0,image_tokens:0}}});
const all = (score: number) => Object.fromEntries(["complete_product", "same_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok", "placement_ok"].map(d => [d, score]));
const image = () => sharp({create:{width:2000,height:1000,channels:3,background:"white"}}).png().toBuffer();
const response = (value: unknown, cost: number | undefined = .003) => new Response(JSON.stringify({choices:[{message:{content:typeof value === "string" ? value : JSON.stringify(value)}}],usage:cost === undefined ? {} : {cost}}));

describe("catalog judge", () => {
 it("clamps/coerces seven dimensions, ignores the supplied overall and explains missing values", () => {
  const {scores,reasons} = normalizeScores({...all(80), complete_product:120,same_product:"60",edge_quality:-8,placement_ok:undefined,overall:100});
  expect(scores.complete_product).toBe(100); expect(scores.same_product).toBe(60); expect(scores.edge_quality).toBe(0); expect(scores.placement_ok).toBe(0);
  expect(scores.overall).toBeCloseTo(400/7); expect(reasons.some(r=>/placement/i.test(r))).toBe(true);
  expect(QA_DIMENSIONS).toHaveLength(7);
 });
 it("uses overall and both hard floors with inclusive thresholds", () => {
  expect(verdictFor({...all(74),overall:74} as never)).toBe("flag");
  expect(verdictFor({...all(90),complete_product:59,overall:90} as never)).toBe("flag");
  expect(verdictFor({...all(90),same_product:59,overall:90} as never)).toBe("flag");
  expect(verdictFor({...all(81),complete_product:60,same_product:60,overall:75} as never)).toBe("pass");
 });
 it("sends private original/output/shot1 at 1536px as ordered data URLs, and reads actual cost", async () => {
  const fetcher = vi.fn<typeof fetch>(async()=>response({...all(95),is_collage:false,reasons:[]}));
  const bytes=await image();
  const result=await judgeOutput({original:bytes,output:bytes,shotOne:bytes,n:2,identifier:"ABC",channel:"styli",anchor:"bottom-centre",productType:"footwear",model:"test-judge",threshold:75,floor:60},{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"pass",costUsd:.003,calls:1,model:"test-judge",flags:[]});
  const body=JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({temperature:0,max_tokens:4000,model:"test-judge"});
  const content=body.messages[1].content;
  expect(content.filter((p:{type:string})=>p.type==="text").map((p:{text:string})=>p.text).join("\n")).toMatch(/original photo[\s\S]*made for Styli[\s\S]*photo 1.*ABC/);
  const urls=content.filter((p:{type:string})=>p.type==="image_url").map((p:{image_url:{url:string}})=>p.image_url.url);
  expect(urls).toHaveLength(3);
  for(const url of urls) { expect(url).toMatch(/^data:image\/jpeg;base64,/); const metadata=await sharp(Buffer.from(url.split(",")[1],"base64")).metadata(); expect(metadata.width).toBe(1536); expect(metadata.height).toBe(768); }
 });
 it("maps low dimensions/collage and preserves lowest-first plain reasons", async()=>{
  const bytes=await image();
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"ABC",channel:"noon",anchor:"centre",productType:"apparel_model",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:async()=>response({...all(95),complete_product:20,placement_ok:30,is_collage:true,reasons:["The model's hand looks cut at the frame edge."]})});
  expect(result.verdict).toBe("flag");expect(result.flags).toEqual(["complete_product","placement","collage"]);expect(result.reasons[0]).toContain("hand");
 });
 it("retries invalid JSON once then returns qa_unavailable, retaining both request costs",async()=>{
  const bytes=await image(), fetcher=vi.fn(async()=>response("not JSON",.002));
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"A",channel:"noon",anchor:"centre",productType:"other",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:fetcher});
  expect(fetcher).toHaveBeenCalledTimes(2);expect(result).toMatchObject({verdict:"flag",flags:["qa_unavailable"],costUsd:.004,calls:2});
 });
 it("requires at least one numeric dimension and logs absent cost",async()=>{
  const bytes=await image(), log=vi.fn();
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"A",channel:"noon",anchor:"centre",productType:"other",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({complete_product:80})}}]})),log});
  expect(result.flags).not.toContain("qa_unavailable");expect(result.costUsd).toBe(QA_USD_PER_CHECK_FALLBACK);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/usage\.cost absent; recorded the estimated price USD 0\.0013/));
 });
 it("reads the billed cost from OpenRouter's real response shape and does not log",async()=>{
  const bytes=await image(), log=vi.fn();
  const fetcher=async()=>new Response(JSON.stringify(openRouterReply(JSON.stringify(all(90)))));
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"A",channel:"noon",anchor:"centre",productType:"other",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:fetcher,log});
  expect(result).toMatchObject({verdict:"pass",costUsd:0.000139,calls:1});
  expect(result.usage).toMatchObject({prompt_tokens:2911,completion_tokens:160});
  expect(log).not.toHaveBeenCalled();
 });
 it("prices a reply with tokens but no cost at the estimate, never 0",async()=>{
  const bytes=await image(), log=vi.fn();
  const reply=openRouterReply(JSON.stringify(all(90)));
  delete (reply.usage as {cost?:number}).cost;
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"A",channel:"noon",anchor:"centre",productType:"other",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:async()=>new Response(JSON.stringify(reply)),log});
  expect(result.costUsd).toBe(QA_USD_PER_CHECK_FALLBACK);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("prompt tokens 2911, completion tokens 160"));
 });
 it("warns with the HTTP status before mapping an auth failure or a missing key to qa_unavailable",async()=>{
  const bytes=await image(), input={original:bytes,output:bytes,n:1,identifier:"A",channel:"noon" as const,anchor:"centre" as const,productType:"other" as const,model:"test",threshold:75,floor:60};
  const log=vi.fn();
  const denied=await judgeOutput(input,{apiKey:"fake",fetch:async()=>new Response(JSON.stringify({error:{message:"User not found.",code:401}}),{status:401}),log});
  expect(denied.flags).toEqual(["qa_unavailable"]);
  expect(log).toHaveBeenCalledWith("catalog_qa: quality check unavailable",expect.objectContaining({severity:"WARNING",model:"test",status:401,kind:"auth"}));
  const missing=vi.fn();
  vi.stubEnv("OPENROUTER_API_KEY","");
  try { expect((await judgeOutput(input,{fetch:async()=>{throw new Error("must not be called");},log:missing})).flags).toEqual(["qa_unavailable"]); } finally { vi.unstubAllEnvs(); }
  expect(missing).toHaveBeenCalledWith("catalog_qa: quality check unavailable",expect.objectContaining({severity:"WARNING",status:0,kind:"no_key",error:"OPENROUTER_API_KEY is not set"}));
 });
 it("keeps template context and literal braces without interpreting replacement dollars",()=>{
  expect(CATALOG_QA_TEMPLATE).toContain("sparkle or star icon");expect(renderTemplate("<anchor>: <identifier>",{anchor:"centre",identifier:"$&"})).toBe("centre: $&");
 });
});
describe("product classifier",()=>{
 it("maps unknown labels to other and keeps real usage",async()=>{
  const result=await classifyProductType(await image(),{apiKey:"fake",model:"test",fetch:async()=>response({type:"unknown",confidence:1.7},.001)});
  expect(result).toMatchObject({type:"other",confidence:1,costUsd:.001,calls:1});
 });
 it("returns type_unknown after malformed replies without failing the caller",async()=>{
  const result=await classifyProductType(await image(),{apiKey:"fake",model:"test",fetch:async()=>response("bad",.001)});
  expect(result).toMatchObject({type:"other",confidence:0,flags:["type_unknown"],calls:2,costUsd:.002});
 });
});


it("classifies transparent material explicitly for the specified engineering treatment",async()=>{
 const result=await classifyProductType(await image(),{apiKey:"fake",model:"test",fetch:async()=>response({type:"other",confidence:.9,transparent:true})});
 expect(result.flags).toContain("transparent");
});
