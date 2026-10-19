import { describe, expect, it } from "vitest";
import { costLine, DEFAULT_COMPUTE_USD_PER_VCPU_SECOND, estimateCost } from "./cost";
describe("catalog cost",()=>{
 const cost={qaUsd:1,computeUsd:2,identifiers:99};
 const products=[{change:"new",outputs:[{status:"staged"}]},{change:"updated",outputs:[{status:"skipped"},{status:"verified"}]},{change:"unchanged",outputs:[{status:"verified"}]},{change:"new",outputs:[{status:"skipped"}]}];
 it("excludes unchanged and wholly skipped products from the denominator",()=>{
  expect(costLine({cost,products},{INR_PER_USD:"80"})).toMatchObject({usd:3,identifiers:2,usdPerIdentifier:1.5,inrPerIdentifier:120,text:"INR 120.00 per style so far · agency reference INR 60 per style"});
 });
 it("has explicit USD fallback and no division by zero",()=>{
  expect(costLine({cost:{...cost,identifiers:2}},{}).text).toBe("USD 1.50 per style so far (set INR_PER_USD to show rupees) · agency reference INR 60 per style");
  expect(costLine({cost,products:[]},{INR_PER_USD:"80"})).toMatchObject({identifiers:0,usdPerIdentifier:null,inrPerIdentifier:null});
 });
 it("uses the documented default compute rate when COMPUTE_USD_PER_VCPU_SECOND is unset",()=>{
  expect(DEFAULT_COMPUTE_USD_PER_VCPU_SECOND).toBeGreaterThan(0);
  expect(estimateCost({outputs:100,sources:20},{INR_PER_USD:"80"})?.usd).toBeCloseTo(20*.0013+100*1.5*2*DEFAULT_COMPUTE_USD_PER_VCPU_SECOND,12);
 });
 it("estimates output compute and sampled QA plus classifier calls; no INR means no estimate",()=>{
  const counts={outputs:100,sources:20,untypedProducts:3,qaSampleRate:.5,qaMode:"per_source" as const,styliSkips:4,unchangedPairs:6};
  expect(estimateCost(counts,{})).toBeNull();
  expect(estimateCost(counts,{INR_PER_USD:"80",COMPUTE_USD_PER_VCPU_SECOND:"0.00002"})).toMatchObject({images:90,qaChecks:13,usd:13*.0013+90*1.5*2*.00002,inr:(13*.0013+90*1.5*2*.00002)*80});
  expect(estimateCost({...counts,qaMode:"per_output"},{INR_PER_USD:"80"})?.qaChecks).toBe(48);
 });
});

