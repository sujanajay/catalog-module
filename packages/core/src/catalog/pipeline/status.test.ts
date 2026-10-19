import { expect,it } from "vitest";
import { EMPTY_BATCH_COUNTS } from "../../db/schema";
import { deriveBatchState } from "./status";
it.each(["matting","rendering","qa","publishing"] as const)("shows %s as processing",status=>expect(deriveBatchState({status,counts:EMPTY_BATCH_COUNTS}).state).toBe("processing"));
it("requires independent counts before Ready",()=>{const counts={...EMPTY_BATCH_COUNTS,outputs:4,verified:4};expect(deriveBatchState({status:"done",counts}).state).toBe("recheck_failed");expect(deriveBatchState({status:"done",counts:{...counts,recheckOk:4,recheckTotal:4}}).state).toBe("ready");expect(deriveBatchState({status:"done",counts:{...counts,attentionProducts:1}}).state).toBe("attention");});
it("derives ETA from the last five minutes",()=>{const now=new Date("2026-01-01T00:05:00Z");const state=deriveBatchState({status:"publishing",counts:{...EMPTY_BATCH_COUNTS,outputs:40,verified:20},now,samples:[{at:new Date(+now-60_000),made:10},{at:now,made:20}]});expect(state.eta).toBe(120);});
it.each(["draft","ingesting","failed"] as const)("derives %s",status=>expect(deriveBatchState({status,counts:EMPTY_BATCH_COUNTS}).state).toBe(status==="ingesting" ? "collecting":status));
it("uses singular copy for one product or link and plural otherwise",()=>{
  const done=(counts:Partial<typeof EMPTY_BATCH_COUNTS>)=>deriveBatchState({status:"done",counts:{...EMPTY_BATCH_COUNTS,...counts}});
  expect(done({attentionProducts:1})).toMatchObject({pill:"1 product needs your attention",listPill:"Needs attention (1 product)"});
  expect(done({attentionProducts:3})).toMatchObject({pill:"3 products need your attention",listPill:"Needs attention (3 products)"});
  expect(done({outputs:2,verified:1,recheckOk:1,recheckTotal:1})).toMatchObject({pill:"1 link did not pass the independent re-check",listPill:"1 link needs a check"});
  expect(done({outputs:1,verified:1,recheckOk:1,recheckTotal:1}).text).toBe("All 1 image is live and passed every check. Nothing needs your attention.");
});
it("shows the batch page the same image count as wizard step 4 and names what it leaves out",()=>{
  const state=deriveBatchState({status:"rendering",counts:{...EMPTY_BATCH_COUNTS,outputs:468,verified:100,skipped:52}});
  expect(state).toMatchObject({made:100,total:416,listPill:"Processing 100 of 416",text:"100 of 416 images made, not counting 52 skipped (too small for Styli or removed)"});
  expect(deriveBatchState({status:"rendering",counts:{...EMPTY_BATCH_COUNTS,outputs:20,verified:4,skipped:2,unchanged:8}}).text).toBe("4 of 10 images made, not counting 2 skipped (too small for Styli or removed) and 8 unchanged");
  expect(deriveBatchState({status:"rendering",counts:{...EMPTY_BATCH_COUNTS,outputs:10,verified:2}}).text).toBe("2 of 10 images made");
});
