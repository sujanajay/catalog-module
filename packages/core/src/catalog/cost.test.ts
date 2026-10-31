import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPUTE_VCPU_SECONDS_PER_OUTPUT_ESTIMATE, costLine, DEFAULT_COMPUTE_USD_PER_VCPU_SECOND, DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND, DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND, DEFAULT_PRICE_UPSCALE_CPU_USD_PER_SECOND, DEFAULT_PRICE_UPSCALE_GPU_USD_PER_SECOND, estimateCost, inrAmount, matteCallUsd, mattePricesFromEnv, QA_USD_PER_CHECK_ESTIMATE, QA_USD_PER_CHECK_FALLBACK, qaCallCost, upscaleCallUsd, usdAmount } from "./cost";
describe("matting service prices (cost ledger)",()=>{
 it("prices the 4 vCPU, 16 GiB CPU service at the asia-south1 request-based rate and the GPU service at the asia-southeast1 L4 instance rate, the same defaults deploy.sh sets",()=>{
  expect(DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND).toBeCloseTo(4*0.000024+16*0.0000025,12);
  expect(DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND).toBeCloseTo(0.00022404+4*0.0000216+16*0.0000024,12);
  const deploy=readFileSync(new URL("../../../../infra/deploy.sh",import.meta.url),"utf8");
  expect(deploy).toContain(`PRICE_MATTE_CPU_USD_PER_SECOND=\${PRICE_MATTE_CPU_USD_PER_SECOND:-${DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND}}`);
  expect(deploy).toContain(`PRICE_MATTE_GPU_USD_PER_SECOND=\${PRICE_MATTE_GPU_USD_PER_SECOND:-${DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND}}`);
  expect(deploy).toContain("PRICE_MATTE_CPU_USD_PER_SECOND=$PRICE_MATTE_CPU_USD_PER_SECOND,PRICE_MATTE_GPU_USD_PER_SECOND=$PRICE_MATTE_GPU_USD_PER_SECOND");
 });
 it("reads both prices from the environment and falls back to the defaults for missing or invalid values",()=>{
  expect(mattePricesFromEnv({PRICE_MATTE_CPU_USD_PER_SECOND:"0.0002",PRICE_MATTE_GPU_USD_PER_SECOND:"0.0009"})).toEqual({cpu:0.0002,gpu:0.0009});
  expect(mattePricesFromEnv({PRICE_MATTE_CPU_USD_PER_SECOND:"",PRICE_MATTE_GPU_USD_PER_SECOND:"abc"})).toEqual({cpu:DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND,gpu:DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND});
  expect(mattePricesFromEnv({})).toEqual({cpu:DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND,gpu:DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND});
 });
 it("prices a call by its service seconds and target, free for the worker's own cut-out, estimated when the rate is a code default",()=>{
  expect(matteCallUsd("cpu",2000,{PRICE_MATTE_CPU_USD_PER_SECOND:"0.0002"})).toEqual({usd:0.0004,estimated:false});
  expect(matteCallUsd("gpu",500,{PRICE_MATTE_GPU_USD_PER_SECOND:"0.001"})).toEqual({usd:0.0005,estimated:false});
  expect(matteCallUsd("gpu",1000,{})).toEqual({usd:DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND,estimated:true});
  expect(matteCallUsd(null,5000,{})).toEqual({usd:0,estimated:false});
  expect(matteCallUsd("cpu",NaN,{})).toEqual({usd:0,estimated:false});
 });
 it("prices the GPU upscaler (RTX PRO 6000, 20 vCPU, 80 GiB, asia-south2 instance rate) apart from the L4 matting service, the same default deploy.sh sets",()=>{
  expect(DEFAULT_PRICE_UPSCALE_GPU_USD_PER_SECOND).toBeCloseTo(0.00043826+20*0.0000216+80*0.0000024,12);
  expect(DEFAULT_PRICE_UPSCALE_GPU_USD_PER_SECOND).not.toBe(DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND);
  const deploy=readFileSync(new URL("../../../../infra/deploy.sh",import.meta.url),"utf8");
  expect(deploy).toContain(`PRICE_UPSCALE_GPU_USD_PER_SECOND=\${PRICE_UPSCALE_GPU_USD_PER_SECOND:-${DEFAULT_PRICE_UPSCALE_GPU_USD_PER_SECOND}}`);
  expect(deploy).toContain(`WORKER_ENV+=",PRICE_UPSCALE_GPU_USD_PER_SECOND=$PRICE_UPSCALE_GPU_USD_PER_SECOND"`);
 });
 it("prices a GPU upscale made on catalog-upscale-gpu at the GPU upscale rate, never the L4 matting rate",()=>{
  const gpuService={UPSCALE_GPU_URL:"https://catalog-upscale-gpu.example"};
  const l4={PRICE_MATTE_GPU_USD_PER_SECOND:"0.00034884"};
  expect(upscaleCallUsd("gpu",2000,{...gpuService,...l4})).toEqual({usd:2*DEFAULT_PRICE_UPSCALE_GPU_USD_PER_SECOND,estimated:true});
  expect(upscaleCallUsd("gpu",2000,{...gpuService,...l4,PRICE_UPSCALE_GPU_USD_PER_SECOND:"0.00106226"}).usd).toBeCloseTo(0.00212452,12);
  expect(upscaleCallUsd("gpu",2000,{...gpuService,...l4,PRICE_UPSCALE_GPU_USD_PER_SECOND:"0.00106226"}).estimated).toBe(false);
  expect(upscaleCallUsd("gpu",2000,{...gpuService,PRICE_UPSCALE_GPU_USD_PER_SECOND:"abc"})).toEqual({usd:2*DEFAULT_PRICE_UPSCALE_GPU_USD_PER_SECOND,estimated:true});
  expect(upscaleCallUsd("gpu",0,gpuService)).toEqual({usd:0,estimated:false});
 });
 it("prices a CPU upscale on the CPU cut-out service like a CPU matting call and a GPU upscale without catalog-upscale-gpu (the L4 matting service) like a GPU matting call",()=>{
  const env={PRICE_MATTE_CPU_USD_PER_SECOND:"0.0002",PRICE_MATTE_GPU_USD_PER_SECOND:"0.001",PRICE_UPSCALE_GPU_USD_PER_SECOND:"0.005",PRICE_UPSCALE_CPU_USD_PER_SECOND:"0.007"};
  expect(upscaleCallUsd("cpu",2000,{...env,UPSCALE_GPU_URL:"https://catalog-upscale-gpu.example"})).toEqual({usd:0.0004,estimated:false});
  expect(upscaleCallUsd("cpu",2000,{...env,MATTING_URL:"https://catalog-matting.example",UPSCALE_URL:"https://catalog-matting.example/"})).toEqual({usd:0.0004,estimated:false});
  expect(upscaleCallUsd("gpu",500,env)).toEqual({usd:0.0005,estimated:false});
  expect(upscaleCallUsd("gpu",500,{...env,UPSCALE_GPU_URL:"  "})).toEqual({usd:0.0005,estimated:false});
 });
 it("prices the dedicated CPU upscaler (catalog-upscale, 4 vCPU, 8 GiB, asia-south1 request-based rate) apart from the CPU cut-out service, the same default deploy.sh sets",()=>{
  expect(DEFAULT_PRICE_UPSCALE_CPU_USD_PER_SECOND).toBeCloseTo(4*0.000024+8*0.0000025,12);
  expect(DEFAULT_PRICE_UPSCALE_CPU_USD_PER_SECOND).not.toBe(DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND);
  const deploy=readFileSync(new URL("../../../../infra/deploy.sh",import.meta.url),"utf8");
  expect(deploy).toContain(`PRICE_UPSCALE_CPU_USD_PER_SECOND=\${PRICE_UPSCALE_CPU_USD_PER_SECOND:-${DEFAULT_PRICE_UPSCALE_CPU_USD_PER_SECOND}}`);
  expect(deploy).toContain(`WORKER_ENV+=",PRICE_UPSCALE_CPU_USD_PER_SECOND=$PRICE_UPSCALE_CPU_USD_PER_SECOND"`);
 });
 it("prices each upscale and cut-out route at its own service's rate",()=>{
  // The live worker env: catalog-upscale (UPSCALE_URL names no matting service), catalog-upscale-gpu, the L4 matting service.
  const live={MATTING_URL:"https://catalog-matting.example",MATTING_GPU_URLS:"https://catalog-matting-gpu.example",UPSCALE_URL:"https://catalog-upscale.example",UPSCALE_GPU_URL:"https://catalog-upscale-gpu.example",
   PRICE_MATTE_CPU_USD_PER_SECOND:"0.0001",PRICE_MATTE_GPU_USD_PER_SECOND:"0.0003",PRICE_UPSCALE_GPU_USD_PER_SECOND:"0.001",PRICE_UPSCALE_CPU_USD_PER_SECOND:"0.0002"};
  // CPU dedicated upscale (`+cpu` id on catalog-upscale).
  expect(upscaleCallUsd("cpu",1000,live).usd).toBeCloseTo(0.0002,12);
  expect(upscaleCallUsd("cpu",1000,live).estimated).toBe(false);
  // GPU upscaler (catalog-upscale-gpu).
  expect(upscaleCallUsd("gpu",1000,live).usd).toBeCloseTo(0.001,12);
  // L4 matting upscale (a GPU upscale without catalog-upscale-gpu).
  expect(upscaleCallUsd("gpu",1000,{...live,UPSCALE_GPU_URL:""}).usd).toBeCloseTo(0.0003,12);
  // CPU and GPU cut-outs keep the matting rates.
  expect(matteCallUsd("cpu",1000,live).usd).toBeCloseTo(0.0001,12);
  expect(matteCallUsd("gpu",1000,live).usd).toBeCloseTo(0.0003,12);
  // Without a configured rate the CPU dedicated upscale uses the code default, marked estimated; a bad value too.
  const {PRICE_UPSCALE_CPU_USD_PER_SECOND:_,...noRate}=live;
  expect(upscaleCallUsd("cpu",2000,noRate)).toEqual({usd:2*DEFAULT_PRICE_UPSCALE_CPU_USD_PER_SECOND,estimated:true});
  expect(upscaleCallUsd("cpu",2000,{...live,PRICE_UPSCALE_CPU_USD_PER_SECOND:"abc"})).toEqual({usd:2*DEFAULT_PRICE_UPSCALE_CPU_USD_PER_SECOND,estimated:true});
  expect(upscaleCallUsd("cpu",0,live)).toEqual({usd:0,estimated:false});
  // UPSCALE_URL naming a GPU matting service (MATTING_GPU_URL when MATTING_GPU_URLS is unset) is not catalog-upscale.
  expect(upscaleCallUsd("cpu",1000,{...live,MATTING_GPU_URLS:"",MATTING_GPU_URL:"https://catalog-upscale.example"}).usd).toBeCloseTo(0.0001,12);
 });
});
describe("catalog cost",()=>{
 const cost={qaUsd:1,computeUsd:2,identifiers:99};
 const products=[{change:"new",outputs:[{status:"staged"}]},{change:"updated",outputs:[{status:"skipped"},{status:"verified"}]},{change:"unchanged",outputs:[{status:"verified"}]},{change:"new",outputs:[{status:"skipped"}]}];
 it("excludes unchanged and wholly skipped products from the denominator",()=>{
  expect(costLine({cost,products},{INR_PER_USD:"80"})).toMatchObject({usd:3,identifiers:2,usdPerIdentifier:1.5,inrPerIdentifier:120,inr:240,text:"INR 120.00 per style so far · INR 240.00 for this batch · agency reference INR 60 per style"});
 });
 it("has explicit USD fallback and no division by zero",()=>{
  expect(costLine({cost:{...cost,identifiers:2}},{}).text).toBe("USD 1.5000 per style so far · USD 3.0000 for this batch · Cost in rupees is not configured yet · agency reference INR 60 per style");
  expect(costLine({cost:{...cost,identifiers:2}},{}).text).not.toContain("INR_PER_USD");
  expect(costLine({cost,products:[]},{INR_PER_USD:"80"})).toMatchObject({identifiers:0,usdPerIdentifier:null,inrPerIdentifier:null});
 });
 it("prices compute at the Cloud Run asia-south1 rate for a 2 vCPU, 2 GiB worker, the same default deploy.sh sets",()=>{
  expect(DEFAULT_COMPUTE_USD_PER_VCPU_SECOND).toBeCloseTo(0.000024+(2/2)*0.0000025,12);
  const deploy=readFileSync(new URL("../../../../infra/deploy.sh",import.meta.url),"utf8");
  expect(deploy).toContain(`COMPUTE_USD_PER_VCPU_SECOND=\${COMPUTE_USD_PER_VCPU_SECOND:-${DEFAULT_COMPUTE_USD_PER_VCPU_SECOND}}`);
 });
 it("uses the measured judge price and compute per output (batch b489e466)",()=>{
  expect(QA_USD_PER_CHECK_ESTIMATE).toBe(0.0003);
  expect(QA_USD_PER_CHECK_ESTIMATE).toBeGreaterThanOrEqual(2*0.0072398/52);
  expect(COMPUTE_VCPU_SECONDS_PER_OUTPUT_ESTIMATE).toBeCloseTo(2023/468,1);
 });
 it("uses the documented default compute rate when COMPUTE_USD_PER_VCPU_SECOND is unset",()=>{
  expect(estimateCost({outputs:100,sources:20},{INR_PER_USD:"80"})?.usd).toBeCloseTo(20*0.0003+100*4.3*0.0000265,12);
 });
 it("estimates the measured batch close to what it really cost",()=>{
  // b489e466: 468 outputs, 52 checks; real spend USD 0.0072 judge + 2023 vCPU-s compute.
  const est=estimateCost({outputs:468,sources:52},{INR_PER_USD:"84"})!;
  expect(est.usd).toBeCloseTo(52*0.0003+468*4.3*0.0000265,12);
  const real=0.0072398+2023*DEFAULT_COMPUTE_USD_PER_VCPU_SECOND;
  expect(est.usd).toBeGreaterThan(real);
  expect(est.usd).toBeLessThan(real*1.5);
 });
 it("estimates output compute and sampled QA plus classifier calls; no INR means no estimate",()=>{
  const counts={outputs:100,sources:20,untypedProducts:3,qaSampleRate:.5,qaMode:"per_source" as const,styliSkips:4,unchangedPairs:6};
  expect(estimateCost(counts,{})).toBeNull();
  expect(estimateCost(counts,{INR_PER_USD:"80",COMPUTE_USD_PER_VCPU_SECOND:"0.00002"})).toMatchObject({images:90,qaChecks:13,usd:13*0.0003+90*4.3*0.00002,inr:(13*0.0003+90*4.3*0.00002)*80});
  expect(estimateCost({...counts,qaMode:"per_output"},{INR_PER_USD:"80"})?.qaChecks).toBe(48);
 });
 it("shows a real sub-cent spend per style instead of 0.00 (batch b489e466: 52 checks, USD 0.0072398, 12 styles)",()=>{
  const cost={qaUsd:0.0072398,computeUsd:0,identifiers:12};
  const usd=costLine({cost},{});
  expect(usd.usdPerIdentifier).toBeCloseTo(0.0072398/12,12);
  expect(usd.text).toBe("USD 0.0006 per style so far · USD 0.0072 for this batch · Cost in rupees is not configured yet · agency reference INR 60 per style");
  const inr=costLine({cost},{INR_PER_USD:"84"});
  expect(inr.inrPerIdentifier).toBeCloseTo(0.0072398/12*84,12);
  expect(inr.text).toBe("INR 0.05 per style so far · INR 0.61 for this batch · agency reference INR 60 per style");
 });
 it("formats USD with four decimals and INR with two",()=>{
  expect(usdAmount(0)).toBe("0.0000");
  expect(usdAmount(0.000149)).toBe("0.0001");
  expect(usdAmount(0.0072398)).toBe("0.0072");
  expect(usdAmount(1234.5)).toBe("1,234.5000");
  expect(inrAmount(0.05068)).toBe("0.05");
  expect(inrAmount(1234.5)).toBe("1,234.50");
 });
 it("reads OpenRouter's billed cost and tokens, and prices a missing cost at the fallback",()=>{
  const usage={prompt_tokens:2911,completion_tokens:160,total_tokens:3071,cost:0.000139,is_byok:false,prompt_tokens_details:{cached_tokens:0},cost_details:{upstream_inference_cost:null}};
  expect(qaCallCost({choices:[],usage})).toEqual({costUsd:0.000139,estimated:false,promptTokens:2911,completionTokens:160});
  expect(qaCallCost({choices:[],usage:{...usage,cost:0}})).toEqual({costUsd:0,estimated:false,promptTokens:2911,completionTokens:160});
  const {cost:_cost,...noCost}=usage;
  expect(qaCallCost({choices:[],usage:noCost})).toEqual({costUsd:QA_USD_PER_CHECK_FALLBACK,estimated:true,promptTokens:2911,completionTokens:160});
  for(const body of [{choices:[]},{choices:[],usage:null},{choices:[],usage:{cost:"0.1"}},undefined,null]) expect(qaCallCost(body)).toEqual({costUsd:QA_USD_PER_CHECK_FALLBACK,estimated:true,promptTokens:0,completionTokens:0});
 });
});
