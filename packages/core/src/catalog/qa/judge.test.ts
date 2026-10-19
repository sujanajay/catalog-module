import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { judgeOutput, normalizeScores, verdictFor, dimensionThresholds, QA_DIMENSIONS, type JudgeInput } from "./judge";
import { classifyProductType } from "./classify";
import { CATALOG_QA_TEMPLATE, renderTemplate } from "./templates";
import { QA_USD_PER_CHECK_ESTIMATE } from "../cost";
/** A non-streaming OpenRouter chat completion as it arrives in production (usage is always present). */
const openRouterReply = (content: string) => ({id:"gen-1760900000-abc",provider:"Google",model:"test",object:"chat.completion",created:1760900000,
 choices:[{logprobs:null,finish_reason:"stop",native_finish_reason:"STOP",index:0,message:{role:"assistant",content,refusal:null,reasoning:null}}],
 usage:{prompt_tokens:2911,completion_tokens:160,total_tokens:3071,cost:0.000139,is_byok:false,prompt_tokens_details:{cached_tokens:0,audio_tokens:0},cost_details:{upstream_inference_cost:null,upstream_inference_prompt_cost:0.0002911,upstream_inference_completions_cost:0.000064},completion_tokens_details:{reasoning_tokens:0,image_tokens:0}}});
/** The v2 reply with every scored check at `score`. */
const all = (score: number) => Object.fromEntries(["complete_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok"].map(d => [d, score]));
const reply = (extra: Record<string, unknown> = {}) => ({view:"front",wrong_item:false,...all(95),is_collage:false,evidence:{},...extra});
const image = () => sharp({create:{width:2000,height:1000,channels:3,background:"white"}}).png().toBuffer();
/** An OpenRouter chat completion in its real response shape (id, model, choices, usage.cost). */
const response = (value: unknown, cost: number | undefined = .003, model = "test-judge") => new Response(JSON.stringify({id:"gen-1",object:"chat.completion",model,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:typeof value === "string" ? value : JSON.stringify(value)}}],usage:{prompt_tokens:1200,completion_tokens:80,total_tokens:1280,...(cost === undefined ? {} : {cost})}}));
const requestModel = (init?: RequestInit) => String(JSON.parse(String(init?.body)).model);
/** One mocked OpenRouter that answers per requested model. */
const byModel = (answers: Record<string, unknown>) => vi.fn<typeof fetch>(async (_url, init) => response(answers[requestModel(init)], .001, requestModel(init)));
async function input(extra: Partial<JudgeInput> = {}): Promise<JudgeInput> {
  const bytes = await image();
  return {original:bytes,output:bytes,shotOne:bytes,n:5,identifier:"ANTA-112",channel:"centrepoint",anchor:"centre",productType:"footwear",model:"first/judge",threshold:75,floor:60,secondModel:"second/judge",...extra};
}

describe("catalog judge v2", () => {
 it("clamps and coerces the scored checks, derives same_product from wrong_item and has no placement dimension", () => {
  const {scores,reasons} = normalizeScores({...all(80), complete_product:120, edge_quality:-8, background_clean:"60", orientation_ok:undefined, overall:100, placement_ok:5});
  expect(scores).toMatchObject({complete_product:100,edge_quality:0,background_clean:60,orientation_ok:0,same_product:100});
  expect(scores.overall).toBe(0);
  expect(reasons.some(r => /orientation/i.test(r))).toBe(true);
  expect(QA_DIMENSIONS).not.toContain("placement_ok");
  expect(normalizeScores({...all(90),wrong_item:true}).scores.same_product).toBe(0);
 });
 it("judges each dimension against its own policy line and never averages", () => {
  const scores = (extra: Record<string, number>) => normalizeScores({...all(95),...extra}).scores;
  expect(dimensionThresholds(75,60)).toEqual({complete_product:60,same_product:60,no_text_or_watermark:60,orientation_ok:60,edge_quality:75,background_clean:75});
  expect(verdictFor(scores({edge_quality:74}),75,60)).toBe("flag");
  expect(verdictFor(scores({background_clean:76,edge_quality:76}),75,60)).toBe("pass");
  expect(verdictFor(scores({complete_product:61,orientation_ok:61,no_text_or_watermark:61}),75,60)).toBe("pass");
  expect(verdictFor(scores({no_text_or_watermark:59}),75,60)).toBe("flag");
 });
 it("sends role-labelled images at 1536 px with the product type, and reads the actual cost", async () => {
  const fetcher = vi.fn<typeof fetch>(async()=>response(reply()));
  const result = await judgeOutput(await input({channel:"styli",anchor:"bottom-centre",n:2}),{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"pass",costUsd:.003,calls:1,model:"first/judge",flags:[],view:"front"});
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({temperature:0,max_tokens:4000,model:"first/judge"});
  const system = body.messages[0].content as string;
  expect(system).toContain("Image 1 is the source photo");
  expect(system).toContain("Image 2 is the output we rendered from image 1 for Styli");
  expect(system).toContain("Image 3, when present, is photo 1 of the same product id, for reference only");
  expect(system).toContain("The product type is footwear (shoes, boots or sandals)");
  expect(system).toMatch(/1\. view:[\s\S]*2\. wrong_item:[\s\S]*3\. Score image 1[\s\S]*4\. Score image 2 against image 1/);
  expect(system).toMatch(/the sole, the inside, close-ups of a detail and on-model shots of the same item are expected/);
  expect(system).not.toMatch(/placement_ok|<channel>|<productType>/);
  const content = body.messages[1].content;
  expect(content.filter((p:{type:string})=>p.type==="text").map((p:{text:string})=>p.text).join("\n")).toMatch(/Image 1: the source photo[\s\S]*Image 2: the output we rendered from image 1 for Styli[\s\S]*Image 3: photo 1 of the same product id \(ANTA-112\)/);
  const urls = content.filter((p:{type:string})=>p.type==="image_url").map((p:{image_url:{url:string}})=>p.image_url.url);
  expect(urls).toHaveLength(3);
  for (const url of urls) { expect(url).toMatch(/^data:image\/jpeg;base64,/); const metadata = await sharp(Buffer.from(url.split(",")[1],"base64")).metadata(); expect(metadata.width).toBe(1536); expect(metadata.height).toBe(768); }
 });
 it("a sole view of the same shoe is not flagged and needs no second opinion", async () => {
  const fetcher = byModel({"first/judge":reply({view:"sole"})});
  const result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"pass",flags:[],view:"sole",wrongItem:{first:false,second:null,confirmed:false}});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it("a planted wrong item becomes different_product only after the second model agrees", async () => {
  const wrong = reply({view:"side",wrong_item:true,evidence:{wrong_item:"Image 1 shows a red sandal, image 3 a black running shoe."}});
  const disagree = byModel({"first/judge":wrong,"second/judge":reply({view:"side"})});
  const unconfirmed = await judgeOutput(await input(),{apiKey:"fake",fetch:disagree});
  expect(disagree.mock.calls.map(call=>requestModel(call[1]))).toEqual(["first/judge","second/judge"]);
  expect(unconfirmed.flags).not.toContain("different_product");
  expect(unconfirmed).toMatchObject({verdict:"pass",scores:{same_product:100},wrongItem:{first:true,second:false,secondModel:"second/judge",confirmed:false},costUsd:.002,calls:2});
  const agree = byModel({"first/judge":wrong,"second/judge":wrong});
  const confirmed = await judgeOutput(await input(),{apiKey:"fake",fetch:agree});
  expect(confirmed).toMatchObject({verdict:"flag",flags:["different_product"],scores:{same_product:0},wrongItem:{first:true,second:true,confirmed:true}});
  expect(confirmed.evidence?.different_product).toBe("Image 1 shows a red sandal, image 3 a black running shoe.");
  expect(confirmed.opinions?.map(o=>o.model)).toEqual(["first/judge","second/judge"]);
  // Without a second judge, or without photo 1 to compare with, a wrong_item answer never holds.
  const alone = await judgeOutput(await input({secondModel:undefined}),{apiKey:"fake",fetch:byModel({"first/judge":wrong})});
  expect(alone.flags).not.toContain("different_product");
  const noReference = byModel({"first/judge":wrong});
  expect((await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:noReference})).flags).toEqual([]);
  expect(noReference).toHaveBeenCalledTimes(1);
 });
 it("placement never comes from the judge, even when the reply scores it", async () => {
  const result = await judgeOutput(await input(),{apiKey:"fake",fetch:byModel({"first/judge":reply({placement_ok:0,evidence:{placement_ok:"It sits too high."}})})});
  expect(result.flags).toEqual([]);expect(result.scores).not.toHaveProperty("placement_ok");
 });
 it("maps failing checks lowest first with one evidence sentence each, plus collage", async () => {
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:byModel({"first/judge":reply({background_clean:30,edge_quality:50,is_collage:true,evidence:{background_clean:"A grey block remains left of the shoe.",is_collage:"Two photos sit side by side."}})})});
  expect(result.flags).toEqual(["leftover_background","halo","collage"]);
  expect(result.reasons).toEqual(["A grey block remains left of the shoe.","The edge of the product looks rough or shows a halo, often white on white.","Two photos sit side by side."]);
  expect(result.thresholds).toMatchObject({edge_quality:75,complete_product:60});
 });
 it("retries invalid JSON once then returns qa_unavailable, retaining both request costs", async () => {
  const fetcher = vi.fn(async()=>response("not JSON",.002));
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher});
  expect(fetcher).toHaveBeenCalledTimes(2);expect(result).toMatchObject({verdict:"flag",flags:["qa_unavailable"],costUsd:.004,calls:2});
 });
 it("requires at least one numeric dimension and logs absent cost",async()=>{
  const bytes=await image(), log=vi.fn();
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"A",channel:"noon",anchor:"centre",productType:"other",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({complete_product:80})}}]})),log});
  expect(result.flags).not.toContain("qa_unavailable");expect(result.costUsd).toBe(QA_USD_PER_CHECK_ESTIMATE);
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
  expect(result.costUsd).toBe(QA_USD_PER_CHECK_ESTIMATE);
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
 it("keeps template context and literal braces without interpreting replacement dollars", () => {
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
