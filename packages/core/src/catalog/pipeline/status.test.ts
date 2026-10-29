import { describe,expect,it } from "vitest";
import { EMPTY_BATCH_COUNTS } from "../../db/schema";
import type { BatchCounts, ChannelId, RateSample } from "../types";
import { CLOSE_PAGE_TEXT, COLLECT_STALLED_TEXT, NOT_COLLECTED_TEXT, STARTING_SERVICES_TEXT, ageText, deriveBatchState, failedBeforeStart, intakeTimeText, measuredRate, processingStalledText, waitRangeMinutes, waitText, wizardStepFor, type WizardStep } from "./status";
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
  expect(stuck).toMatchObject({state:"collecting",stalled:true,text:COLLECT_STALLED_TEXT,listPill:"Downloading photos",intake:COLLECT_STALLED_TEXT});
  expect(deriveBatchState({status:"ingesting",counts:EMPTY_BATCH_COUNTS,now,updatedAt:at(15).toISOString()}).stalled).toBe(true);
  const moving=deriveBatchState({status:"ingesting",counts:{...EMPTY_BATCH_COUNTS,collected:3,collectTotal:8},now,updatedAt:at(9)});
  expect(moving.stalled).toBeUndefined();expect(moving.text).toBe("Downloading photos 3 of 8");
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
    expect(banner("rendering",100,at(2),startedAt,5032)).toBe(`100 of 5,032 images made · about 41 to 58 min left. ${CLOSE_PAGE_TEXT}`);
    expect(banner("rendering",600,at(6),startedAt,5032)).toBe(`600 of 5,032 images made · about 45 min left. ${CLOSE_PAGE_TEXT}`);
    // Spec 15 E7: past the usual range the page says so, never "about 1 min left" from the fit.
    expect(banner("rendering",0,at(4.5),startedAt.toISOString())).toBe(`0 of 10 images made · taking longer than usual. ${CLOSE_PAGE_TEXT}`);
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
describe("spec 15 E7: true processing progress",()=>{
  const startedAt=new Date("2026-10-27T08:00:00Z");
  const at=(minutes:number)=>new Date(+startedAt+minutes*60_000);
  const iso=(minutes:number)=>at(minutes).toISOString();
  const counts=(extra:Partial<typeof EMPTY_BATCH_COUNTS>={})=>({...EMPTY_BATCH_COUNTS,sources:1400,outputs:5600,...extra});
  const text=(status:"matting"|"rendering"|"qa"|"publishing",c:typeof EMPTY_BATCH_COUNTS,minutes:number)=>deriveBatchState({status,counts:c,startedAt,now:at(minutes)}).text;
  it("says how many photos are prepared while the cut-out runs",()=>{
    expect(text("matting",counts({prepared:340,progressAt:iso(9)}),10)).toBe(`Preparing photos 340 of 1,400 · 0 of 5,600 images made · about 38 to 57 min left. ${CLOSE_PAGE_TEXT}`);
  });
  it("spec 18: says how many photos are enlarged while their enlargements run, and drops it once all are settled",()=>{
    expect(text("rendering",counts({prepared:1400,enlargeTotal:120,enlargeDone:30,enlargeFailed:2,progressAt:iso(9)} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).toBe(`Enlarging photos 32 of 120 · 0 of 5,600 images made · about 38 to 57 min left. ${CLOSE_PAGE_TEXT}`);
    expect(text("matting",counts({prepared:340,enlargeTotal:12,enlargeDone:0,enlargeFailed:0,progressAt:iso(9)} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).toMatch(/^Preparing photos 340 of 1,400 · Enlarging photos 0 of 12 · /);
    expect(text("rendering",counts({prepared:1400,enlargeTotal:120,enlargeDone:118,enlargeFailed:2,progressAt:iso(9)} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).not.toContain("Enlarging");
  });
  it("drops the preparing part once every photo is prepared, and for a batch from before release E",()=>{
    expect(text("rendering",counts({prepared:1400,staged:120,progressAt:iso(9)} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).toBe(`120 of 5,600 images made · about 38 to 57 min left. ${CLOSE_PAGE_TEXT}`);
    expect(text("rendering",counts({staged:120,progressAt:iso(9)} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).toBe(`120 of 5,600 images made · about 38 to 57 min left. ${CLOSE_PAGE_TEXT}`);
  });
  it("gives the time from the measured speed when samples at least 60 s apart moved",()=>{
    const rate=[{at:iso(8),made:100},{at:iso(8.5),made:110},{at:iso(10),made:220}];
    // From the 8.5 min sample (the newest at least 60 s older): 110 images in 1.5 minutes, 5,380 left.
    expect(text("rendering",counts({prepared:1400,staged:220,progressAt:iso(10),processingRate:rate} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).toBe(`220 of 5,600 images made · about 74 min left. ${CLOSE_PAGE_TEXT}`);
    // Samples under 60 s apart give no rate: the usual range stays.
    expect(text("rendering",counts({prepared:1400,staged:110,progressAt:iso(10),processingRate:rate.slice(0,2)} as Partial<typeof EMPTY_BATCH_COUNTS>),10)).toContain("about 38 to 57 min left");
  });
  it("says taking longer than usual past the range with no rate, never about 1 min left",()=>{
    // The range for 5,600 images ends at 67 min; this batch is 2 hours past it and still moving.
    const late=text("matting",counts({prepared:900,progressAt:iso(186)}),187);
    expect(late).toBe(`Preparing photos 900 of 1,400 · 0 of 5,600 images made · taking longer than usual. ${CLOSE_PAGE_TEXT}`);
    for(let minutes=0;minutes<=300;minutes+=7) expect(text("matting",counts({prepared:10,progressAt:iso(minutes)}),minutes)).not.toContain("about 1 min left");
  });
  it("adds the stall sentence after 20 minutes with no finished photo, and not at 19",()=>{
    const c=counts({prepared:340,progressAt:iso(10)});
    expect(text("matting",c,31)).toBe(`Preparing photos 340 of 1,400 · 0 of 5,600 images made · taking longer than usual. ${CLOSE_PAGE_TEXT} ${processingStalledText(21)}`);
    expect(processingStalledText(21)).toBe("Nothing has moved for 21 minutes. The system is retrying by itself; you do not need to do anything.");
    expect(text("matting",c,29)).not.toContain("Nothing has moved");
    // Before any photo finished the start time counts; publishing has no chunk progress.
    expect(text("matting",counts({prepared:0}),21)).toContain(processingStalledText(21));
    expect(text("publishing",counts({prepared:1400,progressAt:iso(0)}),40)).not.toContain("Nothing has moved");
  });
  it("shows the starting-services line only in the first 5 minutes before any photo is prepared",()=>{
    expect(text("matting",counts({prepared:0}),4)).toContain(STARTING_SERVICES_TEXT);
    expect(text("matting",counts({prepared:0}),6)).not.toContain(STARTING_SERVICES_TEXT);
    expect(text("matting",counts({prepared:3,progressAt:iso(3)}),4)).not.toContain(STARTING_SERVICES_TEXT);
  });
  it("keeps the list pill",()=>{
    expect(deriveBatchState({status:"matting",counts:counts({prepared:340}),startedAt,now:at(10)}).listPill).toBe("Processing 0 of 5,600");
  });
  it("measuredRate uses the newest sample and the newest one at least 60 s older",()=>{
    expect(measuredRate(undefined)).toBeNull();
    expect(measuredRate([{at:iso(0),made:0},{at:iso(0.5),made:5}])).toBeNull();
    expect(measuredRate([{at:iso(0),made:0},{at:iso(1),made:60},{at:iso(2),made:180}])).toBe(2);
  });
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
    ["pending upload wins over collecting",{status:"ingesting",channels:[],counts:{...EMPTY_BATCH_COUNTS,collected:40,collectTotal:287}},[{status:"collected"},{status:"pending"}],1],
    ["waiting for a column",{status:"draft",channels:[],counts:ready},[{status:"collected"}],2],
    ["ready without channels",{status:"draft",channels:[],counts:ready},[{status:"collected"}],2],
    ["ready with channels",{status:"draft",channels:["noon","styli"],counts:ready},[{status:"collected"}],4],
  ])("%s",(_label,batch,uploads,step)=>expect(wizardStepFor(batch,uploads)).toBe(step));
  it("never opens at step 3",()=>{
    for(const status of ["draft","ingesting"] as const)for(const previewReady of [true,false])for(const channels of [[],["noon"]] as const)for(const uploads of [[],[{status:"pending"}],[{status:"collected"}]])
      expect(wizardStepFor({status,channels:[...channels],counts:{...EMPTY_BATCH_COUNTS,previewReady}},uploads)).not.toBe(3);
  });
});

// Spec 14c F6 and F4 part 2: intake time, phase words and the state words of unfinished batches.
describe("intakeTimeText (spec 14c F6)", () => {
  const t0 = new Date("2026-10-27T10:00:00Z");
  const at = (s: number) => new Date(+t0 + s * 1000).toISOString();
  const placing = (rate: RateSample[], extra: Partial<BatchCounts> = {}): BatchCounts => ({ ...EMPTY_BATCH_COUNTS, phase: "placing", placed: 200, placeTotal: 1400, rate, ...extra });
  it("gives about 10 min left from placing samples 0 at t0 and 200 at t0+100 s over 1,400", () => {
    expect(intakeTimeText(placing([{ at: at(0), phase: "placing", done: 0 }, { at: at(100), phase: "placing", done: 200 }]), new Date(at(100)))).toBe("about 10 min left");
  });
  it("gives no text from downloading samples next to one placing sample, from one sample, or before a rate is measured", () => {
    const dl = (s: number, done: number): RateSample => ({ at: at(s), phase: "downloading", done });
    expect(intakeTimeText(placing([dl(0, 0), dl(60, 300), { at: at(100), phase: "placing", done: 200 }]), new Date(at(100)))).toBe("");
    expect(intakeTimeText(placing([{ at: at(100), phase: "placing", done: 200 }]), new Date(at(100)))).toBe("");
    expect(intakeTimeText(placing([]), new Date(at(100)))).toBe("");
    // Samples closer than 20 s are not a measured rate.
    expect(intakeTimeText(placing([{ at: at(90), phase: "placing", done: 0 }, { at: at(100), phase: "placing", done: 200 }]), new Date(at(100)))).toBe("");
    // Nothing moved, no phase, or no total: no text.
    expect(intakeTimeText(placing([{ at: at(0), phase: "placing", done: 200 }, { at: at(100), phase: "placing", done: 200 }]), new Date(at(100)))).toBe("");
    expect(intakeTimeText(placing([{ at: at(0), phase: "placing", done: 0 }, { at: at(100), phase: "placing", done: 200 }], { phase: null }), new Date(at(100)))).toBe("");
    expect(intakeTimeText(placing([{ at: at(0), phase: "placing", done: 0 }, { at: at(100), phase: "placing", done: 200 }], { placeTotal: null }), new Date(at(100)))).toBe("");
  });
  it("uses the latest pair at least 20 s apart, the collecting totals, counts down between samples, and says a few minutes near the end", () => {
    const dl = (s: number, done: number): RateSample => ({ at: at(s), phase: "downloading", done });
    const counts: BatchCounts = { ...EMPTY_BATCH_COUNTS, phase: "downloading", collected: 600, collectTotal: 1400, rate: [dl(0, 0), dl(60, 100), dl(110, 500), dl(120, 600)] };
    // Pair (60 s, 100) and (120 s, 600): 500 per minute; 800 left = 1.6 min.
    expect(intakeTimeText(counts, new Date(at(120)))).toBe("a few minutes left");
    const slow: BatchCounts = { ...counts, rate: [dl(0, 0), dl(60, 120)], collected: 120 };
    expect(intakeTimeText(slow, new Date(at(60)))).toBe("about 11 min left");
    expect(intakeTimeText(slow, new Date(at(60 + 5 * 60)))).toBe("about 6 min left");
  });
});

describe("deriveBatchState intake words (spec 14c F4 part 2)", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  const ago = (minutes: number) => new Date(+now - minutes * 60_000);
  it("shows placing as collecting with the placing count, the time and a placing list pill", () => {
    const state = deriveBatchState({ status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, collected: 1400, collectTotal: 1400, phase: "placing", placed: 300, placeTotal: 1400 }, now, updatedAt: now });
    expect(state).toMatchObject({ state: "collecting", text: "Placing photos 300 of 1,400", listPill: "Placing photos 300 of 1,400", intake: "Placing photos 300 of 1,400", made: 300, total: 1400 });
    const timed = deriveBatchState({ status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, phase: "placing", placed: 200, placeTotal: 1400, rate: [{ at: ago(100 / 60).toISOString(), phase: "placing", done: 0 }, { at: now.toISOString(), phase: "placing", done: 200 }] }, now, updatedAt: now });
    expect(timed.text).toBe("Placing photos 200 of 1,400, about 10 min left");
    expect(timed.listPill).toBe("Placing photos 200 of 1,400");
  });
  it("words each collecting phase, falls back to the source for rows without a phase, and never says 0 of 0", () => {
    const ingesting = (counts: Partial<BatchCounts>, source?: string) => deriveBatchState({ status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, collected: 612, collectTotal: 1400, ...counts }, source, now, updatedAt: now }).text;
    expect(ingesting({ phase: "downloading" })).toBe("Downloading photos 612 of 1,400");
    expect(ingesting({ phase: "reading" })).toBe("Reading your sheet 612 of 1,400");
    expect(ingesting({ phase: "unpacking" })).toBe("Unpacking your zip 612 of 1,400");
    expect(ingesting({ phase: "checking" })).toBe("Checking your uploaded files 612 of 1,400");
    expect(ingesting({}, "zip")).toBe("Unpacking your zip 612 of 1,400");
    expect(ingesting({}, "upload")).toBe("Checking your uploaded files 612 of 1,400");
    for (const source of ["links", "Google Sheet", "Drive folder", undefined]) expect(ingesting({}, source)).toBe("Downloading photos 612 of 1,400");
    expect(ingesting({ phase: "reading", collected: 0, collectTotal: null })).toBe("Reading your sheet");
    expect(ingesting({ collected: 0, collectTotal: 0 })).toBe("Downloading photos");
  });
  it("words every unfinished draft", () => {
    const draft = (counts: Partial<BatchCounts>, uploads?: { status: string }[], channels: ChannelId[] = []) => deriveBatchState({ status: "draft", counts: { ...EMPTY_BATCH_COUNTS, ...counts }, uploads, channels, now }).intake;
    expect(draft({}, [{ status: "uploaded" }, { status: "pending" }, { status: "pending" }])).toBe("2 files did not finish uploading");
    expect(draft({}, [{ status: "pending" }])).toBe("1 file did not finish uploading");
    expect(draft({}, [])).toBe("Nothing added yet");
    expect(draft({}, [{ status: "removed" }])).toBe("Nothing added yet");
    expect(draft({ previewReady: true, phase: "needs_input" }, [{ status: "collected" }])).toBe("Needs your input: which column holds the identifier?");
    expect(draft({ previewReady: true, phase: "ready" }, [{ status: "collected" }])).toBe("Ready to check");
    expect(draft({ previewReady: true }, [{ status: "collected" }], ["noon"])).toBe("Ready to start");
    expect(draft({}, [{ status: "uploaded" }])).toBe(NOT_COLLECTED_TEXT);
    // Without uploads the input checks are skipped.
    expect(draft({ previewReady: true })).toBe("Ready to check");
  });
  it("words a failed batch and offers Fix and continue only before Start", () => {
    const failed = (startedAt?: Date | null) => deriveBatchState({ status: "failed", counts: { ...EMPTY_BATCH_COUNTS, failReason: "No photos could be downloaded." }, startedAt, now });
    expect(failed(null)).toMatchObject({ state: "failed", pill: "Could not start", intake: "Could not start: No photos could be downloaded.", fixable: true });
    expect(failed(ago(5)).fixable).toBeUndefined();
    expect(failed(undefined).fixable).toBeUndefined();
    expect(failedBeforeStart({ status: "failed", startedAt: null })).toBe(true);
    expect(failedBeforeStart({ status: "failed", startedAt: ago(5) })).toBe(false);
    expect(failedBeforeStart({ status: "draft", startedAt: null })).toBe(false);
  });
  it("derives cancelled with its age", () => {
    const state = deriveBatchState({ status: "cancelled", counts: EMPTY_BATCH_COUNTS, updatedAt: ago(2 * 24 * 60), now });
    expect(state).toMatchObject({ state: "cancelled", pill: "Cancelled", listPill: "Cancelled", intake: "Cancelled 2 days ago", text: "Cancelled 2 days ago" });
    expect(deriveBatchState({ status: "cancelled", counts: EMPTY_BATCH_COUNTS }).intake).toBe("Cancelled");
    // A draft the sweep expired (spec 14d F12).
    expect(deriveBatchState({ status: "cancelled", counts: EMPTY_BATCH_COUNTS, updatedAt: "2026-10-25T10:00:00Z", expired: { days: 14 } })).toMatchObject({ state: "cancelled", intake: "Expired after 14 days with no activity", text: "Expired after 14 days with no activity" });
    expect(deriveBatchState({ status: "cancelled", counts: EMPTY_BATCH_COUNTS, expired: { days: 1 } }).intake).toBe("Expired after 1 day with no activity");
  });
  it("gives a started batch its list pill as intake words", () => {
    expect(deriveBatchState({ status: "rendering", counts: { ...EMPTY_BATCH_COUNTS, outputs: 10, verified: 2 } }).intake).toBe("Processing 2 of 10");
    expect(deriveBatchState({ status: "done", counts: { ...EMPTY_BATCH_COUNTS, outputs: 4, verified: 4, recheckOk: 4, recheckTotal: 4 } }).intake).toBe("Ready to download");
  });
  it("says the age in words", () => {
    expect(ageText(now, now)).toBe("just now");
    expect(ageText(ago(1), now)).toBe("1 minute ago");
    expect(ageText(ago(5).toISOString(), now)).toBe("5 minutes ago");
    expect(ageText(ago(60), now)).toBe("1 hour ago");
    expect(ageText(ago(23 * 60 + 59), now)).toBe("23 hours ago");
    expect(ageText(ago(24 * 60), now)).toBe("1 day ago");
    expect(ageText(ago(-5), now)).toBe("just now");
  });
});
