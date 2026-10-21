import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { judgeOutput, sheetNames, sheetNumbered, normalizeScores, verdictFor, dimensionThresholds, QA_DIMENSIONS, type JudgeInput } from "./judge";
import { classifyProductType } from "./classify";
import { CATALOG_QA_TEMPLATE, renderTemplate } from "./templates";
import { QA_USD_PER_CHECK_FALLBACK } from "../cost";
/** A non-streaming OpenRouter chat completion as it arrives in production (usage is always present). */
const openRouterReply = (content: string) => ({id:"gen-1760900000-abc",provider:"Google",model:"test",object:"chat.completion",created:1760900000,
 choices:[{logprobs:null,finish_reason:"stop",native_finish_reason:"STOP",index:0,message:{role:"assistant",content,refusal:null,reasoning:null}}],
 usage:{prompt_tokens:2911,completion_tokens:160,total_tokens:3071,cost:0.000139,is_byok:false,prompt_tokens_details:{cached_tokens:0,audio_tokens:0},cost_details:{upstream_inference_cost:null,upstream_inference_prompt_cost:0.0002911,upstream_inference_completions_cost:0.000064},completion_tokens_details:{reasoning_tokens:0,image_tokens:0}}});
/** The v2 reply with every scored check at `score`. */
const all = (score: number) => Object.fromEntries(["complete_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok", "product_intact"].map(d => [d, score]));
const reply = (extra: Record<string, unknown> = {}) => ({view:"front",wrong_item:false,...all(95),is_collage:false,evidence:{},...extra});
const image = () => sharp({create:{width:2000,height:1000,channels:3,background:"white"}}).png().toBuffer();
/** An OpenRouter chat completion in its real response shape (id, model, choices, usage.cost). */
const response = (value: unknown, cost: number | undefined = .003, model = "test-judge") => new Response(JSON.stringify({id:"gen-1",object:"chat.completion",model,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:typeof value === "string" ? value : JSON.stringify(value)}}],usage:{prompt_tokens:1200,completion_tokens:80,total_tokens:1280,...(cost === undefined ? {} : {cost})}}));
const requestModel = (init?: RequestInit) => String(JSON.parse(String(init?.body)).model);
/** Every request answered with the same reply in OpenRouter's full production shape. */
const openRouterFetch = (value: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(openRouterReply(JSON.stringify(value)))));
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
  expect(dimensionThresholds(75,60)).toEqual({complete_product:60,same_product:60,no_text_or_watermark:60,orientation_ok:60,edge_quality:75,background_clean:75,product_intact:75});
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
  expect(confirmed.evidence?.different_product).toBe("Photo 5 shows a red sandal, photo 1 a black running shoe.");
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
 it("maps failing checks worst first with one evidence sentence each, plus collage", async () => {
  const flagged = reply({background_clean:30,edge_quality:50,is_collage:true,evidence:{background_clean:"A grey block remains left of the shoe.",is_collage:"Two photos sit side by side."}});
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:byModel({"first/judge":flagged,"second/judge":reply({background_clean:40})})});
  expect(result.flags).toEqual(["collage","leftover_background","halo"]);
  expect(result.reasons).toEqual(["Two photos sit side by side.","A grey block remains left of the shoe.","The edge of the product looks rough or shows a halo, often white on white."]);
  expect(result.thresholds).toMatchObject({edge_quality:75,complete_product:60});
 });
 it("retries invalid JSON once then returns qa_unavailable, retaining both request costs", async () => {
  const fetcher = vi.fn(async()=>response("not JSON",.002));
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher});
  expect(fetcher).toHaveBeenCalledTimes(2);expect(result).toMatchObject({verdict:"flag",flags:["qa_unavailable"],costUsd:.004,calls:2});
 });
 it("asks again for missing scores instead of reading them as failed checks, and logs absent cost",async()=>{
  const bytes=await image(), log=vi.fn();
  const replies=[{complete_product:80},all(90)];
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(replies.shift())}}]})));
  const result=await judgeOutput({original:bytes,output:bytes,n:1,identifier:"A",channel:"noon",anchor:"centre",productType:"other",model:"test",threshold:75,floor:60},{apiKey:"fake",fetch:fetcher,log});
  expect(fetcher).toHaveBeenCalledTimes(2);
  // The retry names the missing scores; the partial first reply raised no flag.
  expect(JSON.stringify(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).messages.at(-1))).toMatch(/Missing scores: edge_quality, background_clean, no_text_or_watermark, orientation_ok, product_intact/);
  expect(result).toMatchObject({verdict:"pass",flags:[]});expect(result.costUsd).toBe(2*QA_USD_PER_CHECK_FALLBACK);
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
 it("keeps template context and literal braces without interpreting replacement dollars", () => {
  expect(CATALOG_QA_TEMPLATE).toContain("sparkle or star icon");expect(renderTemplate("<anchor>: <identifier>",{anchor:"centre",identifier:"$&"})).toBe("centre: $&");
 });
});
/** Quality gate 2 (2026-10-20): the false holds and the missed cut-outs, replayed as judge replies. */
describe("judge views amendment",()=>{
 it("tells the judge which views are the same product and asks for product_intact on image 2", async () => {
  const fetcher = byModel({"first/judge":reply()});
  await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  const system = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].content as string;
  expect(system).toMatch(/a single item out of a multipack or set shown in image 3/);
  expect(system).toMatch(/a packshot or flat product photo against the same product worn on a model or on legs/);
  expect(system).toMatch(/a size chart, care label, measurement guide or infographic of the listing/);
  expect(system).toMatch(/a detail or close-up of any part of the product/);
  expect(system).toMatch(/exactly the same design in another colour/);
  expect(system).toMatch(/another category of product[\s\S]*clearly different design/);
  expect(system).toMatch(/one of front, side, back, sole, top, inside, detail, on-model, flat, chart/);
  expect(system).toMatch(/4\. Score image 2 against image 1[\s\S]*product_intact:[\s\S]*A logo or label on its own is not the product/);
  expect(system).toMatch(/background_clean:[\s\S]*say where it is in image 2/);
  expect(system).toContain(`"product_intact":100`);
  expect(system).not.toContain(String.fromCharCode(0x2014));
 });
 it("a single brief out of a 3-pack is the same product: no flag and no second opinion", async () => {
  // Penti Z01369261B0BCB88911B3Z photo 2: one black brief, image 3 the white, grey and black 3-pack.
  const fetcher = byModel({"first/judge":reply({view:"flat"})});
  const result = await judgeOutput(await input({n:2,productType:"apparel_flat"}),{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"pass",flags:[],view:"flat",wrongItem:{first:false,confirmed:false}});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it("a packshot against the same tights worn on legs never becomes different_product when the second judge sees the same item", async () => {
  // Vero Moda Z001E274B11C8109CF34DZ photo 2: tights on a leg form, photo 1 worn on legs.
  const first = reply({view:"flat",wrong_item:true,evidence:{wrong_item:"Image 1 shows tights on a leg form, image 3 a model wearing tights."}});
  const fetcher = byModel({"first/judge":first,"second/judge":reply({view:"flat"})});
  const result = await judgeOutput(await input({n:2,productType:"apparel_model"}),{apiKey:"fake",fetch:fetcher});
  expect(result.flags).toEqual([]);
  expect(result).toMatchObject({verdict:"pass",scores:{same_product:100},wrongItem:{first:true,second:false,confirmed:false}});
 });
 it("a size chart is the chart view: one chart_image flag, no product checks and no second opinion", async () => {
  // Penti Z01369261B0BCB88911B3Z photo 5 and Z10DE3448DD7CE2D2BF8FZ photo 3: the size chart.
  const chart = reply({view:"chart",wrong_item:true,no_text_or_watermark:10,background_clean:20,product_intact:30,evidence:{wrong_item:"Image 1 is a size chart, not underwear.",background_clean:"Holes appear in the table at the top."}});
  const fetcher = byModel({"first/judge":chart});
  const result = await judgeOutput(await input({n:5}),{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"flag",flags:["chart_image"],view:"chart",wrongItem:{first:false,confirmed:false}});
  expect(result.reasons).toEqual(["This photo is a size chart or a text-only image, so it was left out of the marketplace images."]);
  expect(Object.values(result.scores).every(score => score === 100)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it("product_removed: a close-up whose fabric was cut away fails as our own defect", async () => {
  // Anta bd-152638122-2 photo 5 and French Connection Z02B2EE44E3A08044B816Z photos 3 to 6.
  const removed = reply({view:"detail",product_intact:5,edge_quality:60,evidence:{product_intact:"Only the embroidered logo is left; the grey fabric around it is gone.",edge_quality:"The letters have rough edges."}});
  const result = await judgeOutput(await input({n:5}),{apiKey:"fake",fetch:openRouterFetch(removed)});
  expect(result.flags).toEqual(["product_removed","halo"]);
  expect(result.scores.product_intact).toBe(5);
  expect(result.evidence?.product_removed).toBe("Only the embroidered logo is left; the grey fabric around it is gone.");
  expect(result.reasons[0]).toBe("Only the embroidered logo is left; the grey fabric around it is gone.");
 });
 it("leftover_background needs a sentence that says where and a second judge that agrees", async () => {
  // Anta bd-152637502S-3 photo 2 on Centrepoint: a clean render flagged with no leftover visible.
  const vague = reply({background_clean:40,evidence:{background_clean:"The background is not clean."}});
  let fetcher = byModel({"first/judge":vague});
  let result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  expect(result.flags).toEqual([]);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.leftover).toMatchObject({first:true,located:false,confirmed:false,second:null});
  expect(result.scores.background_clean).toBeGreaterThanOrEqual(75);
  const located = reply({background_clean:40,evidence:{background_clean:"A grey block remains to the left of the trousers."}});
  fetcher = byModel({"first/judge":located,"second/judge":reply({background_clean:96})});
  result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  expect(fetcher.mock.calls.map(call=>requestModel(call[1]))).toEqual(["first/judge","second/judge"]);
  expect(result).toMatchObject({verdict:"pass",flags:[],leftover:{first:true,located:true,second:false,secondModel:"second/judge",confirmed:false},scores:{background_clean:96}});
  // Without a second judge a leftover never counts.
  result = await judgeOutput(await input({secondModel:undefined}),{apiKey:"fake",fetch:byModel({"first/judge":located})});
  expect(result.flags).toEqual([]);
  fetcher = byModel({"first/judge":located,"second/judge":reply({background_clean:50})});
  result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"flag",flags:["leftover_background"],leftover:{confirmed:true},scores:{background_clean:40}});
  expect(result.evidence?.leftover_background).toBe("A grey block remains to the left of the trousers.");
  // One second call answers both checks; a re-check of another channel never asks about wrong_item.
  const both = reply({wrong_item:true,background_clean:40,evidence:{background_clean:"A grey block remains under the shoe.",wrong_item:"Another shoe."}});
  fetcher = byModel({"first/judge":both,"second/judge":both});
  result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  expect(fetcher).toHaveBeenCalledTimes(2);expect(result.flags).toEqual(["different_product","leftover_background"]);
  fetcher = byModel({"first/judge":reply({wrong_item:true})});
  result = await judgeOutput(await input({wrongItemCheck:false}),{apiKey:"fake",fetch:fetcher});
  expect(fetcher).toHaveBeenCalledTimes(1);expect(result.wrongItem).toMatchObject({first:false,confirmed:false});
 });
 it("a clean render gets no flag from one call", async () => {
  const fetcher = openRouterFetch(reply(all(100)));
  const result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher});
  expect(result).toMatchObject({verdict:"pass",flags:[],reasons:[],scores:{overall:100}});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it("caps the flags at the checks that actually failed and orders them worst first", async () => {
  // French Connection Z0F7B9F82E6080CB6BE80Z photo 2 got eight flags from one judge before v2. Now an
  // unplaced leftover, an unconfirmed wrong item and checks inside their lines raise nothing.
  const unhappy = reply({view:"on-model",wrong_item:true,complete_product:40,orientation_ok:70,no_text_or_watermark:65,edge_quality:70,background_clean:50,product_intact:80,
   evidence:{complete_product:"The shirt is cut off at the bottom edge.",edge_quality:"The sleeve edge looks soft.",background_clean:"The background looks uneven.",wrong_item:"The shirt looks different."}});
  const fetcher = byModel({"first/judge":unhappy,"second/judge":reply({view:"on-model"})});
  const result = await judgeOutput(await input({n:2,productType:"apparel_model"}),{apiKey:"fake",fetch:fetcher});
  expect(result.flags).toEqual(["halo","complete_product"]);
  expect(result.reasons).toEqual(["The sleeve edge looks soft.","The shirt is cut off at the bottom edge."]);
 });
});
describe("product classifier",()=>{
 it("returns chart for a size chart without turning it into a product flag",async()=>{
  const result=await classifyProductType(await image(),{apiKey:"fake",model:"test",fetch:async()=>response({type:"apparel_flat",confidence:.6,transparent:false,chart:true})});
  expect(result).toMatchObject({type:"apparel_flat",chart:true,flags:[]});
  expect((await classifyProductType(await image(),{apiKey:"fake",model:"test",fetch:async()=>response({type:"footwear",confidence:.9})})).chart).toBe(false);
 });
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

describe("judge back-off on rate limits and the second judge (07 4.2)", () => {
 const limited = (headers: Record<string, string> = {}) => new Response(JSON.stringify({error:{message:"Provider returned error",metadata:{raw:"temporarily rate-limited upstream"},code:429}}),{status:429,headers});
 /** A judge that answers per model from a queue of responses; the last one repeats. */
 const scripted = (plans: Record<string, (() => Response)[]>) => vi.fn<typeof fetch>(async (_url, init) => {
  const model = requestModel(init), plan = plans[model]!;
  return (plan.length > 1 ? plan.shift()! : plan[0]!)();
 });
 const ok = (value: unknown = reply()) => () => response(value, .001);
 const fast = () => { const waits: number[] = []; return {waits, sleep: vi.fn(async (ms: number) => { waits.push(ms); }), random: () => .5}; };
 it("a 429 burst that recovers within the back-off gives the normal verdict with no flag, waiting about 5 then 15 s", async () => {
  const clock = fast(), log = vi.fn();
  const fetcher = scripted({"first/judge":[limited, limited, ok()]});
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher,log,sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({verdict:"pass",flags:[],model:"first/judge",calls:3,costUsd:.001});
  expect(clock.waits).toEqual([5_000, 15_000]);
  expect(log.mock.calls.filter(([m]) => m === "catalog_qa: judge back-off").map(([, f]) => f)).toEqual([
   expect.objectContaining({severity:"WARNING",model:"first/judge",attempt:1,status:429,kind:"rate_limit",waitMs:5_000,retryAfterMs:null}),
   expect.objectContaining({attempt:2,status:429,kind:"rate_limit",waitMs:15_000}),
  ]);
  expect(log).not.toHaveBeenCalledWith("catalog_qa: quality check unavailable", expect.anything());
 });
 it("spreads the waits with jitter, about 5, 15 and 45 s", async () => {
  for (const [random, expected] of [[0, [4_000, 12_000, 36_000]], [.999999, [6_000, 18_000, 54_000]]] as const) {
   const waits: number[] = [];
   await judgeOutput(await input({n:1,shotOne:undefined,secondModel:undefined}),{apiKey:"fake",fetch:scripted({"first/judge":[limited]}),log:()=>{},sleep:async ms=>{waits.push(ms);},random:()=>random});
   expect(waits).toEqual(expected);
  }
 });
 it("backs off on a 5xx the same way", async () => {
  const clock = fast();
  const fetcher = scripted({"first/judge":[() => new Response("upstream error",{status:502}), ok()]});
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({verdict:"pass",flags:[],calls:2});
  expect(clock.waits).toEqual([5_000]);
 });
 it("honours Retry-After instead of its own delay", async () => {
  const clock = fast();
  const fetcher = scripted({"first/judge":[() => limited({"retry-after":"7"}), ok()]});
  await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(clock.waits).toEqual([7_000]);
 });
 it("first judge exhausted, then the second judge gives the verdict once: no hold, and the log says the fallback was used", async () => {
  const clock = fast(), log = vi.fn();
  const fetcher = scripted({"first/judge":[limited], "second/judge":[ok()]});
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher,log,sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({verdict:"pass",flags:[],model:"second/judge",calls:5,costUsd:.001});
  expect(fetcher.mock.calls.map(([, init]) => requestModel(init))).toEqual(["first/judge","first/judge","first/judge","first/judge","second/judge"]);
  expect(clock.waits).toEqual([5_000, 15_000, 45_000]);
  expect(log).toHaveBeenCalledWith("catalog_qa: first judge unavailable; the second judge gave the verdict", expect.objectContaining({model:"first/judge",fallbackModel:"second/judge",kind:"rate_limit",status:429,calls:5}));
 });
 it("after the fallback, the first judge gives the second opinion on a different item", async () => {
  const clock = fast();
  const fetcher = scripted({"first/judge":[limited, limited, limited, limited, ok(reply({wrong_item:true}))], "second/judge":[ok(reply({wrong_item:true}))]});
  const result = await judgeOutput(await input(),{apiKey:"fake",fetch:fetcher,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(result.wrongItem).toMatchObject({first:true,second:true,confirmed:true,secondModel:"first/judge"});
  expect(result.flags).toContain("different_product");
  expect(result.calls).toBe(6);
 });
 it("both judges exhausted: qa_unavailable as before, every attempt counted", async () => {
  const clock = fast(), log = vi.fn();
  const fetcher = scripted({"first/judge":[limited], "second/judge":[limited]});
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher,log,sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({verdict:"flag",flags:["qa_unavailable"],reasons:["The quality check could not read this image."],calls:5,costUsd:0,model:"first/judge"});
  // The second judge is asked once: no back-off of its own.
  expect(clock.waits).toEqual([5_000, 15_000, 45_000]);
  expect(log).toHaveBeenCalledWith("catalog_qa: both judges unavailable", expect.objectContaining({fallbackKind:"rate_limit",fallbackStatus:429}));
 });
 it("stops at the back-off budget: a Retry-After beyond what is left gives up, and a shared budget is drawn down", async () => {
  const clock = fast();
  const huge = scripted({"first/judge":[() => limited({"retry-after":"600"})]});
  const one = await judgeOutput(await input({n:1,shotOne:undefined,secondModel:undefined}),{apiKey:"fake",fetch:huge,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(one.flags).toEqual(["qa_unavailable"]);expect(huge).toHaveBeenCalledTimes(1);expect(clock.waits).toEqual([]);
  const shared = {remainingMs:12_000};
  const two = await judgeOutput(await input({n:1,shotOne:undefined,secondModel:undefined}),{apiKey:"fake",fetch:scripted({"first/judge":[limited]}),log:()=>{},sleep:clock.sleep,random:clock.random,backoff:shared});
  expect(two.flags).toEqual(["qa_unavailable"]);
  expect(clock.waits).toEqual([5_000, 7_000]);expect(shared.remainingMs).toBe(0);
 });
 it("an auth failure is not retried and does not ask the second judge", async () => {
  const clock = fast();
  const fetcher = scripted({"first/judge":[() => new Response(JSON.stringify({error:{message:"User not found.",code:401}}),{status:401})], "second/judge":[ok()]});
  const result = await judgeOutput(await input({n:1,shotOne:undefined}),{apiKey:"fake",fetch:fetcher,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(result.flags).toEqual(["qa_unavailable"]);expect(fetcher).toHaveBeenCalledTimes(1);expect(clock.waits).toEqual([]);
 });
});

describe("the judge's evidence sentence uses the sheet's photo numbers", () => {
 it("rewrites prompt image numbers to the product's photo numbers, at sentence start and mid-sentence", async () => {
  // french_connection.apparel_model Z023DBEC95DCF485E9E6EZ: the planted wrong item was photo 4.
  const wrong = reply({view:"front",wrong_item:true,evidence:{wrong_item:"Image 1 shows a pair of shoes, image 3 shows a shirt."}});
  const result = await judgeOutput(await input({n:4,productType:"apparel_model"}),{apiKey:"fake",fetch:byModel({"first/judge":wrong,"second/judge":wrong})});
  expect(result.flags).toEqual(["different_product"]);
  expect(result.evidence?.different_product).toBe("Photo 4 shows a pair of shoes, photo 1 shows a shirt.");
  expect(result.reasons).toEqual(["Photo 4 shows a pair of shoes, photo 1 shows a shirt."]);
  expect(result.opinions?.map(o => o.evidence.wrong_item)).toEqual(["Photo 4 shows a pair of shoes, photo 1 shows a shirt.","Photo 4 shows a pair of shoes, photo 1 shows a shirt."]);
 });
 it("names image 2 as the output, leaves sentences without numbers and numbers outside the map untouched", () => {
  const names = sheetNames(4, true);
  expect(sheetNumbered("A grey block remains left of the shoe in image 2.", names)).toBe("A grey block remains left of the shoe in the output.");
  expect(sheetNumbered("The image 2 edge is soft; Image 2 shows a halo.", names)).toBe("The output edge is soft; The output shows a halo.");
  expect(sheetNumbered("The shirt is cut off at the bottom edge.", names)).toBe("The shirt is cut off at the bottom edge.");
  expect(sheetNumbered("Image 5 shows a bag, unlike image 1.", names)).toBe("Image 5 shows a bag, unlike photo 4.");
  // Without photo 1 sent, image 3 is not in the map.
  expect(sheetNumbered("Image 3 shows a shirt.", sheetNames(1, false))).toBe("Image 3 shows a shirt.");
  expect(sheetNumbered("image 1 is blurred.", sheetNames(1, false))).toBe("photo 1 is blurred.");
 });
});

describe("classifier back-off on rate limits and the second model (gate 3h)", () => {
 const limited = (headers: Record<string, string> = {}) => new Response(JSON.stringify({error:{message:"Provider returned error",metadata:{raw:"temporarily rate-limited upstream"},code:429}}),{status:429,headers});
 const scripted = (plans: Record<string, (() => Response)[]>) => vi.fn<typeof fetch>(async (_url, init) => {
  const plan = plans[requestModel(init)]!;
  return (plan.length > 1 ? plan.shift()! : plan[0]!)();
 });
 const typed = (value: unknown = {type:"apparel_model",confidence:.9}) => () => response(value, .001);
 const fast = () => { const waits: number[] = []; return {waits, sleep: vi.fn(async (ms: number) => { waits.push(ms); }), random: () => .5}; };
 it("a 429 burst that recovers classifies normally with no flag, waiting about 5 then 15 s", async () => {
  const clock = fast(), log = vi.fn();
  const fetcher = scripted({"first/classifier":[limited, limited, typed()]});
  const result = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",secondModel:"second/classifier",fetch:fetcher,log,sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({type:"apparel_model",confidence:.9,flags:[],calls:3,costUsd:.001,model:"first/classifier"});
  expect(clock.waits).toEqual([5_000, 15_000]);
  expect(log.mock.calls.filter(([m]) => m === "catalog_qa: classifier back-off").map(([, f]) => f)).toEqual([
   expect.objectContaining({severity:"WARNING",model:"first/classifier",attempt:1,status:429,kind:"rate_limit",waitMs:5_000,retryAfterMs:null}),
   expect.objectContaining({attempt:2,status:429,kind:"rate_limit",waitMs:15_000}),
  ]);
  expect(log).not.toHaveBeenCalledWith("catalog_qa: quality check unavailable", expect.anything());
  expect(fetcher.mock.calls.map(([, init]) => requestModel(init))).not.toContain("second/classifier");
 });
 it("honours Retry-After and backs off on a 5xx", async () => {
  const clock = fast();
  const fetcher = scripted({"first/classifier":[() => limited({"retry-after":"7"}), () => new Response("upstream error",{status:503}), typed()]});
  const result = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",fetch:fetcher,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({type:"apparel_model",flags:[]});
  expect(clock.waits).toEqual([7_000, 15_000]);
 });
 it("first model exhausted, then the second model classifies once: no flag, and the log says the fallback was used", async () => {
  const clock = fast(), log = vi.fn();
  const fetcher = scripted({"first/classifier":[limited], "second/classifier":[typed({type:"footwear",confidence:.8})]});
  const result = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",secondModel:"second/classifier",fetch:fetcher,log,sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({type:"footwear",confidence:.8,flags:[],calls:5,costUsd:.001,model:"second/classifier"});
  expect(fetcher.mock.calls.map(([, init]) => requestModel(init))).toEqual(["first/classifier","first/classifier","first/classifier","first/classifier","second/classifier"]);
  expect(clock.waits).toEqual([5_000, 15_000, 45_000]);
  expect(log).toHaveBeenCalledWith("catalog_qa: quality check unavailable", expect.objectContaining({model:"first/classifier",status:429,kind:"rate_limit",calls:4}));
  expect(log).toHaveBeenCalledWith("catalog_qa: classifier unavailable; the second model gave the product type", expect.objectContaining({severity:"WARNING",model:"first/classifier",fallbackModel:"second/classifier",kind:"rate_limit",status:429,calls:5}));
 });
 it("both models exhausted: the general rules with type_unknown, every attempt counted, the second model asked once", async () => {
  const clock = fast(), log = vi.fn();
  const fetcher = scripted({"first/classifier":[limited], "second/classifier":[limited]});
  const result = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",secondModel:"second/classifier",fetch:fetcher,log,sleep:clock.sleep,random:clock.random});
  expect(result).toMatchObject({type:"other",confidence:0,flags:["type_unknown"],chart:false,calls:5,costUsd:0});
  expect(result.model).toBeUndefined();
  expect(clock.waits).toEqual([5_000, 15_000, 45_000]);
  expect(log).toHaveBeenCalledWith("catalog_qa: both classifier models unavailable; the general rules are used", expect.objectContaining({fallbackModel:"second/classifier",fallbackKind:"rate_limit",fallbackStatus:429,calls:5}));
 });
 it("without a second model the general rules follow the back-off; an auth failure is neither retried nor sent to the second model", async () => {
  const clock = fast();
  const exhausted = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",fetch:scripted({"first/classifier":[limited]}),log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(exhausted).toMatchObject({type:"other",flags:["type_unknown"],calls:4});
  const auth = scripted({"first/classifier":[() => new Response("no",{status:401})], "second/classifier":[typed()]});
  const denied = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",secondModel:"second/classifier",fetch:auth,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(denied).toMatchObject({type:"other",flags:["type_unknown"],calls:1});
 });
 it("stops waiting when the classification budget or the shared delivery budget is used up", async () => {
  const clock = fast();
  const backoff = {remainingMs:10_000};
  const result = await classifyProductType(await image(),{apiKey:"fake",model:"first/classifier",fetch:scripted({"first/classifier":[limited]}),backoff,log:()=>{},sleep:clock.sleep,random:clock.random});
  expect(result.flags).toEqual(["type_unknown"]);
  expect(clock.waits).toEqual([5_000, 5_000]);
  expect(backoff.remainingMs).toBe(0);
 });
});
