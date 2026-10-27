import { describe,expect,it } from "vitest";
import { EMPTY_BATCH_COUNTS } from "../../db/schema";
import { CLOSE_PAGE_TEXT, COLLECT_STALLED_TEXT, STARTING_SERVICES_TEXT, deriveBatchState, waitRangeMinutes, waitText, wizardStepFor, type WizardStep } from "./status";
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
  expect(state).toMatchObject({made:100,total:416,listPill:"Processing 100 of 416",text:`100 of 416 images made, not counting 52 skipped (too small for Styli or removed). ${CLOSE_PAGE_TEXT}`});
  expect(deriveBatchState({status:"rendering",counts:{...EMPTY_BATCH_COUNTS,outputs:20,verified:4,skipped:2,unchanged:8}}).text).toBe(`4 of 10 images made, not counting 2 skipped (too small for Styli or removed) and 8 unchanged. ${CLOSE_PAGE_TEXT}`);
  expect(deriveBatchState({status:"rendering",counts:{...EMPTY_BATCH_COUNTS,outputs:10,verified:2}}).text).toBe("2 of 10 images made. You can close this page and come back; nothing stops.");
});
it("marks a collecting batch stalled after 10 minutes without progress, and only a collecting one",()=>{
  const now=new Date("2026-10-19T19:05:00Z");
  const at=(minutes:number)=>new Date(+now-minutes*60_000);
  const stuck=deriveBatchState({status:"ingesting",counts:EMPTY_BATCH_COUNTS,now,updatedAt:at(15)});
  expect(stuck).toMatchObject({state:"collecting",stalled:true,text:COLLECT_STALLED_TEXT,listPill:"Collecting files 0 of ?"});
  expect(deriveBatchState({status:"ingesting",counts:EMPTY_BATCH_COUNTS,now,updatedAt:at(15).toISOString()}).stalled).toBe(true);
  const moving=deriveBatchState({status:"ingesting",counts:{...EMPTY_BATCH_COUNTS,collected:3,collectTotal:8},now,updatedAt:at(9)});
  expect(moving.stalled).toBeUndefined();expect(moving.text).toBe("3 of 8 files copied from your links");
  expect(deriveBatchState({status:"ingesting",counts:EMPTY_BATCH_COUNTS,now}).stalled).toBeUndefined();
  for(const status of ["draft","matting","done","failed"] as const) expect(deriveBatchState({status,counts:EMPTY_BATCH_COUNTS,now,updatedAt:at(60)}).stalled).toBeUndefined();
});
it("estimates the usual wait from the images step 4 will make",()=>{
  expect(waitRangeMinutes(10)).toEqual({low:1,high:5});
  expect(waitRangeMinutes(5032)).toEqual({low:43,high:60});
  expect(waitText(5032)).toBe("This usually takes about 43 to 60 minutes. After you press Start you can close this page; the batch keeps going, and you can come back to it any time from All batches.");
});
describe("processing banner time left",()=>{
  const startedAt=new Date("2026-10-21T13:00:00Z");
  const at=(minutes:number)=>new Date(+startedAt+minutes*60_000);
  const banner=(status:"matting"|"rendering",verified:number,now:Date,started:Date|string|null=startedAt,outputs=10)=>deriveBatchState({status,counts:{...EMPTY_BATCH_COUNTS,outputs,verified},startedAt:started,now}).text;
  it("says the image services are starting while nothing is made yet, and only then",()=>{
    expect(banner("matting",0,at(0.5))).toBe(`0 of 10 images made · about 1 to 5 min left. ${CLOSE_PAGE_TEXT} ${STARTING_SERVICES_TEXT}`);
    expect(banner("matting",2,at(1))).not.toContain(STARTING_SERVICES_TEXT);
    expect(banner("rendering",0,at(1))).not.toContain(STARTING_SERVICES_TEXT);
  });
  it("shows the usual range before 10% is made, less the time spent, then the measured rate",()=>{
    expect(banner("rendering",100,at(2),startedAt,5032)).toBe(`100 of 5032 images made · about 41 to 58 min left. ${CLOSE_PAGE_TEXT}`);
    expect(banner("rendering",600,at(6),startedAt,5032)).toBe(`600 of 5032 images made · about 45 min left. ${CLOSE_PAGE_TEXT}`);
    expect(banner("rendering",0,at(30),startedAt.toISOString())).toBe(`0 of 10 images made · about 1 min left. ${CLOSE_PAGE_TEXT}`);
  });
  it("gives the same text on a reload because it uses startedAt, not browser samples",()=>{
    expect(banner("rendering",5,at(2))).toBe(banner("rendering",5,at(2)));
    expect(banner("rendering",5,at(2))).toBe(`5 of 10 images made · about 2 min left. ${CLOSE_PAGE_TEXT}`);
  });
  it("without startedAt leaves the time out unless browser samples give a rate",()=>{
    expect(banner("rendering",5,at(2),null)).toBe(`5 of 10 images made. ${CLOSE_PAGE_TEXT}`);
    const now=at(5);
    expect(deriveBatchState({status:"rendering",counts:{...EMPTY_BATCH_COUNTS,outputs:40,verified:20},now,samples:[{at:new Date(+now-60_000),made:10},{at:now,made:20}]}).text).toBe(`20 of 40 images made · about 2 min left. ${CLOSE_PAGE_TEXT}`);
  });
});
it("names the Styli images that were not made in the Ready banner",()=>{
  const ready=(skipped:number,styliSkipped=skipped)=>deriveBatchState({status:"done",counts:{...EMPTY_BATCH_COUNTS,outputs:10+skipped,verified:10,skipped,recheckOk:10,recheckTotal:10},styliSkipped});
  // A removed, replaced or size-chart skip is in counts.skipped too, but is not a Styli skip.
  expect(ready(2,0).text).toBe("All 10 images are live and passed every check. Nothing needs your attention.");
  expect(ready(3,1).text).toBe("All 10 images are live and passed every check. 1 Styli image was not made because the photo is too small for Styli even after enlargement (see the notes column).");
  expect(ready(5)).toMatchObject({state:"ready",text:"All 10 images are live and passed every check. 5 Styli images were not made because the photos are too small for Styli even after enlargement (see the notes column)."});
  expect(ready(1).text).toContain("1 Styli image was not made because the photo is too small for Styli");
  expect(ready(0).text).toBe("All 10 images are live and passed every check. Nothing needs your attention.");
});
describe("wizardStepFor: the step an existing batch opens at",()=>{
  const ready={...EMPTY_BATCH_COUNTS,previewReady:true};
  const uploaded=[{status:"uploaded"}];
  it.each<[string,Parameters<typeof wizardStepFor>[0],{status:string}[],WizardStep]>([
    ["no input",{status:"draft",channels:[],counts:EMPTY_BATCH_COUNTS},[],1],
    ["no input (only removed uploads)",{status:"draft",channels:[],counts:EMPTY_BATCH_COUNTS},[{status:"removed"}],1],
    ["pending upload",{status:"draft",channels:[],counts:EMPTY_BATCH_COUNTS},[{status:"uploaded"},{status:"pending"}],1],
    ["inputs added, not handed to collecting yet",{status:"draft",channels:[],counts:EMPTY_BATCH_COUNTS},uploaded,1],
    ["collecting",{status:"ingesting",channels:[],counts:{...EMPTY_BATCH_COUNTS,collected:40,collectTotal:287}},uploaded,2],
    ["placing",{status:"ingesting",channels:[],counts:{...EMPTY_BATCH_COUNTS,collected:287,collectTotal:287}},[{status:"collected"}],2],
    ["waiting for a column",{status:"draft",channels:[],counts:ready},[{status:"collected"}],2],
    ["ready without channels",{status:"draft",channels:[],counts:ready},[{status:"collected"}],2],
    ["ready with channels",{status:"draft",channels:["noon","styli"],counts:ready},[{status:"collected"}],4],
  ])("%s",(_label,batch,uploads,step)=>expect(wizardStepFor(batch,uploads)).toBe(step));
  it("never opens at step 3",()=>{
    for(const status of ["draft","ingesting"] as const)for(const previewReady of [true,false])for(const channels of [[],["noon"]] as const)for(const uploads of [[],[{status:"pending"}],[{status:"collected"}]])
      expect(wizardStepFor({status,channels:[...channels],counts:{...EMPTY_BATCH_COUNTS,previewReady}},uploads)).not.toBe(3);
  });
});
