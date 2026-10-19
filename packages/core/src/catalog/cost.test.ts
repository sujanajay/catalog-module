import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPUTE_VCPU_SECONDS_PER_OUTPUT_ESTIMATE, costLine, DEFAULT_COMPUTE_USD_PER_VCPU_SECOND, estimateCost, inrAmount, QA_USD_PER_CHECK_ESTIMATE, QA_USD_PER_CHECK_FALLBACK, qaCallCost, usdAmount } from "./cost";
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
