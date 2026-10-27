import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import CatalogWizard, { resumedGrouping, type WizardInitialBatch } from "../components/catalog/CatalogWizard";
import ChannelPicker from "../components/catalog/ChannelPicker";
import OverwritePreview from "../components/catalog/OverwritePreview";
import WizardStep2, { mergeSheetChoices } from "../components/catalog/WizardStep2";
import WizardStep4 from "../components/catalog/WizardStep4";
import { ToastProvider } from "../components/Toast";
import { LEAVING_LINE, SHEET_READING_TEXT, STEP2_COLLECTING_TEXT, STEP3_COLLECTING_TEXT, wizardCollectingText } from "../lib/catalog/copy";
import type { WizardDetected, WizardPreview } from "../lib/catalog/preview";

vi.mock("next/navigation", async (actual) => ({
  ...(await actual<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
}));

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
    expect(ready).toContain("ABC123/ABC123_1.heic");expect(ready).toContain("1200 x 1600");expect(ready).toContain("Estimated cost: not available. Cost in rupees is not configured yet.");
    expect(ready).not.toMatch(/model|policy|INR_PER_USD/i);
    const priced=renderToStaticMarkup(createElement(WizardStep4,{preview:{...preview,estimate:{usd:0.5,inr:42,images:416,qaChecks:104}}}));
    expect(priced).toContain("Estimated cost: about INR 42.00 (416 images, 104 quality checks)");expect(priced).not.toContain("not available");
    expect(ready).toContain("This usually takes about 1 to 5 minutes. After you press Start you can close this page; the batch keeps going, and you can come back to it any time from All batches.");
    expect(ready).not.toContain("Another batch is running");
    expect(renderToStaticMarkup(createElement(WizardStep4,{preview:{...preview,otherBatchProcessing:true}}))).toContain("Another batch is running; yours may wait behind it.");
  });
  it("names busy products and duplicate spellings in the visible overwrite preview",()=>{
    const html=renderToStaticMarkup(createElement(OverwritePreview,{preview:{...preview,busy:[{identifier:"ABC123",batchName:"October photos"}],overwrite:{...preview.overwrite,sameProductPairs:[{a:"ABC-123",b:"ABC123"}]}}}));
    expect(html).toContain("ABC123 is still being processed in batch October photos. Wait for it to finish or remove them from this upload.");
    expect(html).toContain("ABC-123 and ABC123 are the same product. Keep one.");
  });
});

// ---- Spec 14a F1 and F6 (release A): a sheet upload never crashes step 2; steps 2 and 3 show the polled count. ----
const SHEET_ID = "0b6f3a52-6f0e-4c1e-9d1a-2f6f1b1c9e01";
const sheetEntry = (extra: Partial<WizardDetected["sheets"][number]> = {}) => ({ uploadId: SHEET_ID, name: "grid.xlsx", identifierColumn: -1, identifierHeader: null, imageColumns: [], kind: "sheet" as const, reading: true, cannotRead: null, columns: [], ...extra });
const detected = (sheets: WizardDetected["sheets"]) => ({
  identifierMode: { detected: "sheet_column", options: ["filename", "sheet_column"], examples: [] },
  precedence: { shown: false, default: "uploads_then_links" }, formats: { sentence: "All photos are JPEG." },
  unreadable: [], googleAccess: [], totalProducts: 0, sheets,
}) as unknown as WizardDetected;
const step2 = (value: WizardDetected, sheets: Parameters<typeof WizardStep2>[0]["sheets"], collecting = false) => renderToStaticMarkup(createElement(WizardStep2, {
  detected: value, collecting, mode: "sheet_column", precedence: "uploads_then_links", sheets, setMode: () => {}, setPrecedence: () => {}, setSheets: () => {},
  email: "share@example.com", id: SHEET_ID, onError: () => {}, onAccessChecked: async () => {},
}));
describe("wizard step 2 with a sheet (F1)", () => {
  it("renders a sheet entry with sheets: [] without throwing and shows the reading sentence", () => {
    const html = step2(detected([sheetEntry()]), []);
    expect(html).toContain(SHEET_READING_TEXT);
    expect(SHEET_READING_TEXT).toBe("Reading your sheet. The columns will appear here when it has been read.");
    expect(html).not.toContain("Change</button>");
  });
  it("shows a read sheet with no choice yet as read-only text, and with a choice as the summary and Change", () => {
    const read = sheetEntry({ reading: false, identifierColumn: 0, identifierHeader: "Style", imageColumns: [1, 2], columns: ["Style", "Image 1", "Image 2"] });
    const readOnly = step2(detected([read]), []);
    expect(readOnly).toContain("Sheet grid.xlsx: identifier column Style, 2 image columns, read as links sheet");
    expect(readOnly).not.toContain("Change</button>");expect(readOnly).not.toContain("<select");
    const chosen = step2(detected([read]), mergeSheetChoices([], [read]));
    expect(chosen).toContain("Change</button>");
  });
  it("hides the grouping cards while collecting and keeps the reading card", () => {
    const html = step2(detected([sheetEntry()]), [], true);
    expect(html).toContain(SHEET_READING_TEXT);
    for (const hidden of ["How should we tell products apart?", "Photo formats", "0 of 0 products", "Google access"]) expect(html).not.toContain(hidden);
    expect(step2(detected([]), [], true)).not.toContain("Sheet columns");
  });
  it("merges sheet choices by uploadId on every detection and gives a sheet being read no choice", () => {
    const read = sheetEntry({ reading: false, identifierColumn: 0, imageColumns: [1] });
    expect(mergeSheetChoices([], [sheetEntry()])).toEqual([]);
    expect(mergeSheetChoices([], [read])).toEqual([{ uploadId: SHEET_ID, identifierColumn: 0, imageColumns: [1], kind: "sheet" }]);
    const operator = { uploadId: SHEET_ID, identifierColumn: 2, imageColumns: [3, 4], kind: "product_list" as const };
    expect(mergeSheetChoices([operator], [read])).toEqual([operator]);
    expect(mergeSheetChoices([operator], [])).toEqual([]);
  });
});
describe("wizard steps 2 and 3 while collecting (F6 release A)", () => {
  const counts = { ...EMPTY_BATCH_COUNTS, collected: 40, collectTotal: 287 };
  const state = deriveBatchState({ status: "ingesting", counts, source: "links" });
  const resumed: WizardInitialBatch = { id: SHEET_ID, brandSlug: "uspa", name: "October", productType: "auto", channels: [], options: { identifierMode: "filename", precedence: "uploads_then_links" }, uploads: [{ status: "uploaded" }], counts, status: "ingesting", state };
  it("step 2 renders the polled count and the leaving line, never 0 of 0 products", () => {
    const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(CatalogWizard, { brands: [{ slug: "uspa", name: "USPA" }] as never, shareEmail: "", initialBatch: resumed })));
    expect(html).toContain('aria-current="step">Check what we found');
    expect(html).toContain(`Downloading photos 40 of 287. ${LEAVING_LINE}`);
    expect(html).not.toContain("0 of 0 products");expect(html).not.toContain("Processing starts by itself");
  });
  it("step 3 uses the same polled text; the fixed sentences only before a count or once stalled", () => {
    expect(wizardCollectingText(state, 287, STEP3_COLLECTING_TEXT)).toBe(`Downloading photos 40 of 287. ${LEAVING_LINE}`);
    expect(wizardCollectingText(null, null, STEP3_COLLECTING_TEXT)).toBe(`Collecting files. Continue when the grouping is ready. ${LEAVING_LINE}`);
    expect(wizardCollectingText({ ...state, stalled: true }, 287, STEP2_COLLECTING_TEXT)).toBe(`${STEP2_COLLECTING_TEXT} ${LEAVING_LINE}`);
    expect(wizardCollectingText(deriveBatchState({ status: "draft", counts: EMPTY_BATCH_COUNTS }), null, STEP2_COLLECTING_TEXT)).not.toMatch(/0 of 0/);
    expect(LEAVING_LINE).toBe("You can close this page. Open this batch again from the batch list and press Continue setting up when it is ready.");
  });
  it("a resumed batch keeps the grouping answers saved at step 2; untouched defaults let detection decide", () => {
    const ready = { ...resumed, status: "draft" as const, counts: { ...counts, previewReady: true } };
    expect(resumedGrouping(undefined, 1)).toEqual({ mode: "filename", precedence: "uploads_then_links", chosen: false });
    expect(resumedGrouping(ready, 2)).toEqual({ mode: "filename", precedence: "uploads_then_links", chosen: false });
    expect(resumedGrouping({ ...ready, options: { identifierMode: "folder", precedence: "uploads_then_links" } }, 2)).toEqual({ mode: "folder", precedence: "uploads_then_links", chosen: true });
    expect(resumedGrouping({ ...ready, options: { identifierMode: "filename", precedence: "links_only" } }, 2)).toEqual({ mode: "filename", precedence: "links_only", chosen: true });
    expect(resumedGrouping(ready, 4).chosen).toBe(true);
  });
  it("a collecting batch whose files are not listed yet shows the fixed sentence, never 0 of 0", () => {
    const listing = deriveBatchState({ status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, collected: 0, collectTotal: 0 }, source: "links" });
    expect(listing.text).toBe("Downloading photos");
    expect(wizardCollectingText(listing, 0, STEP2_COLLECTING_TEXT)).toBe(`${STEP2_COLLECTING_TEXT} ${LEAVING_LINE}`);
    expect(wizardCollectingText(listing, null, STEP3_COLLECTING_TEXT)).toBe(`${STEP3_COLLECTING_TEXT} ${LEAVING_LINE}`);
  });
  it("step 4 while collecting carries the leaving line and never shows 0 of 0 before a count exists", () => {
    const empty = renderToStaticMarkup(createElement(WizardStep4, { preview: null }));
    expect(empty).toContain(LEAVING_LINE);expect(empty).toContain("Collecting files.");expect(empty).not.toMatch(/\b0 of 0\b/);
    expect(renderToStaticMarkup(createElement(WizardStep4, { preview: { ...preview, ready: false, collected: 0, collectTotal: 0 } }))).not.toMatch(/\b0 of 0\b/);
  });
});
