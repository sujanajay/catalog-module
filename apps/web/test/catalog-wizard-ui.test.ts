import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChannelPicker from "../components/catalog/ChannelPicker";
import OverwritePreview from "../components/catalog/OverwritePreview";
import WizardStep4 from "../components/catalog/WizardStep4";
import type { WizardPreview } from "../lib/catalog/preview";

const preview = {
  ready: true, previewAt: "2026-10-19T00:00:00.000Z", groupedBy: "Grouped by folder name",
  counts: {products:1,sources:3,photos:3,channels:2,outputs:6}, warnings: [], collected:3,collectTotal:3,estimate:null,
  groups:[{identifier:"ABC123",opptraSkuIds:[],shots:3,firstPhotoUrl:"https://thumb.example/one",status:"existing",files:[{n:1,originalName:"ABC123/ABC123_1.heic",width:1200,height:1600}],notes:[]}],totalRows:1,
  overwrite:{newProducts:0,existingProducts:[{identifier:"ABC123",liveShots:[1,2,3,4,5],uploadShots:[1,2,3],shotsToRemove:[4,5],channels:["noon"]}],renameHints:[],sameProductPairs:[]},busy:[]
} as unknown as WizardPreview;
describe("wizard visible state",()=>{
  it("starts with all nine marketplaces unchecked and reflects a deliberate selection",()=>{
    const initial=renderToStaticMarkup(createElement(ChannelPicker,{channels:[],onChange:()=>{}}));
    expect(initial.match(/type="checkbox"/g)).toHaveLength(9);expect(initial).not.toContain("checked=");
    const selected=renderToStaticMarkup(createElement(ChannelPicker,{channels:["noon"],onChange:()=>{}}));
    expect(selected.match(/checked=""/g)).toHaveLength(1);expect(selected).toContain("1080 x 1480, light grey background, 10% space above and below, 5% at the sides");
  });
  it("shows collecting progress before a preview is ready, then source file details and removals",()=>{
    const waiting=renderToStaticMarkup(createElement(WizardStep4,{preview:{...preview,ready:false,collected:2,collectTotal:3}}));
    expect(waiting).toContain("Collecting files 2 of 3");expect(waiting).not.toContain("will be overwritten");
    const ready=renderToStaticMarkup(createElement(WizardStep4,{preview}));
    expect(ready).toContain("ABC123: 5 photos live, 3 in this upload; _4 and _5 will be removed.");
    expect(ready).toContain("ABC123/ABC123_1.heic");expect(ready).toContain("1200 x 1600");expect(ready).toContain("Estimated cost: not available");
    expect(ready).not.toMatch(/model|policy/i);
  });
  it("names busy products and duplicate spellings in the visible overwrite preview",()=>{
    const html=renderToStaticMarkup(createElement(OverwritePreview,{preview:{...preview,busy:[{identifier:"ABC123",batchName:"October photos"}],overwrite:{...preview.overwrite,sameProductPairs:[{a:"ABC-123",b:"ABC123"}]}}}));
    expect(html).toContain("ABC123 is still being processed in batch October photos. Wait for it to finish or remove them from this upload.");
    expect(html).toContain("ABC-123 and ABC123 are the same product. Keep one.");
  });
});
