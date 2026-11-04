import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import CatalogWizard, { FoundSummary, resumedGrouping, type WizardInitialBatch } from "../components/catalog/CatalogWizard";
import ChannelPicker from "../components/catalog/ChannelPicker";
import OverwritePreview from "../components/catalog/OverwritePreview";
import WizardStep2, { mergeSheetChoices, PER_ROOT_LABEL } from "../components/catalog/WizardStep2";
import { ToastProvider } from "../components/Toast";
import { collectingBannerText, collectingLine, countdownText, foundText, goingToText, KEEP_GOING_LINE, SHEET_READING_TEXT } from "../lib/catalog/copy";
import type { WizardDetected, WizardPreview } from "../lib/catalog/preview";

vi.mock("next/navigation", async (actual) => ({
  ...(await actual<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
}));

const preview = {
  ready: true, previewAt: "2026-10-19T00:00:00.000Z", groupedBy: "Grouped by folder name",
  counts: {products:1,sources:3,photos:3,channels:2,outputs:6}, warnings: [], collected:3,collectTotal:3,estimate:null,
  groups:[{identifier:"ABC123",opptraSkuIds:[],shots:3,firstPhotoUrl:"https://thumb.example/one",status:"existing",files:[{n:1,originalName:"ABC123/ABC123_1.heic",width:1200,height:1600}],notes:[]}],totalRows:1,
  overwrite:{newProducts:0,existingProducts:[{identifier:"ABC123",liveShots:[1,2,3,4,5],uploadShots:[1,2,3],shotsToRemove:[4,5],channels:["noon"]}],renameHints:[],sameProductPairs:[],sameBatches:[],duplicatePhotos:[]},busy:[]
} as unknown as WizardPreview;
describe("wizard visible state",()=>{
  it("starts with all nine marketplaces unchecked and reflects a deliberate selection",()=>{
    const initial=renderToStaticMarkup(createElement(ChannelPicker,{channels:[],onChange:()=>{}}));
    expect(initial.match(/type="checkbox"/g)).toHaveLength(9);expect(initial).not.toContain("checked=");
    const selected=renderToStaticMarkup(createElement(ChannelPicker,{channels:["noon"],onChange:()=>{}}));
    expect(selected.match(/checked=""/g)).toHaveLength(1);expect(selected).toContain("1080 x 1480, light grey background, 10% space above and below, 5% at the sides");
  });
  it("what we found: the counts, source file details, removals and cost (UX3, was step 4)",()=>{
    const found=(p:WizardPreview)=>renderToStaticMarkup(createElement(FoundSummary,{preview:p,sentence:"Folder A grouped by folder name.",batchId:SHEET_ID}));
    const ready=found(preview);
    expect(ready).toContain("Found 3 photos for 1 products. Folder A grouped by folder name.");
    expect(ready).toContain("ABC123: 5 photos live, 3 in this upload; _4 and _5 will be removed.");
    expect(ready).toContain("ABC123/ABC123_1.heic");expect(ready).toContain("1200 x 1600");expect(ready).toContain("Estimated cost: not available. Cost in rupees is not configured yet.");
    expect(ready).not.toMatch(/model|policy|INR_PER_USD/i);
    const priced=found({...preview,estimate:{usd:0.5,inr:42,images:416,qaChecks:104}} as WizardPreview);
    expect(priced).toContain("Estimated cost: about INR 42.00 (416 images, 104 quality checks)");expect(priced).not.toContain("not available");
    expect(ready).not.toContain("Another batch is running");
    expect(found({...preview,otherBatchProcessing:true} as WizardPreview)).toContain("Another batch is running; yours may wait behind it.");
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
  grouping: { perRoot: false, sentence: null },
  precedence: { shown: false, default: "uploads_then_links" }, formats: { sentence: "All photos are JPEG." },
  unreadable: [], googleAccess: [], totalProducts: 0, sheets,
}) as unknown as WizardDetected;
const step2 = (value: WizardDetected, sheets: Parameters<typeof WizardStep2>[0]["sheets"], collecting = false) => renderToStaticMarkup(createElement(WizardStep2, {
  detected: value, collecting, mode: "sheet_column", precedence: "uploads_then_links", sheets, setMode: () => {}, setPrecedence: () => {}, setSheets: () => {},
  email: "share@example.com", id: SHEET_ID, onError: () => {}, onAccessChecked: async () => {},
}));
describe("M1-S1: the sharing line up front and per-root grouping", () => {
  const page = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ToastProvider, null, createElement(CatalogWizard, { brands: [{ slug: "uspa", name: "USPA", line: "softline" }] as never, shareEmail: "reader@example.com", ...props })));
  it("the New batch page shows the sharing email with Copy before anything is pasted, on one page with no Continue (M1-F2-R1, R2)", () => {
    const html = page();
    expect(html).toContain("To use a Google Sheet or Drive folder, share it with <code>reader@example.com</code> as Viewer.");
    expect(html).toContain(">Copy</button>");
    expect(html.indexOf("share it with")).toBeLessThan(html.indexOf("Or paste a link"));
    expect(html).toContain("Choose folders");
    expect(html).toContain("Drop folders, files, zips or sheets here. Several at once is fine.");
    expect(html).not.toContain("Continue");
    expect(html).not.toContain('aria-label="Batch steps"');
    // R3: no brand question before anything is dropped; R5: product type under More settings (UX3 D12).
    expect(html).not.toContain("Which brand is this?");
    expect(html.indexOf("<summary>More settings</summary>")).toBeLessThan(html.indexOf("What kind of products?"));
  });
  it("the paste hint names Supabase folders only while that paste kind is on (review #5)", () => {
    expect(page()).toContain(`placeholder="A Google Sheet link, a Google Drive folder link, or image links one per line"`);
    expect(page({ supabasePaste: false })).not.toContain("Supabase");
    expect(page({ supabasePaste: true })).toContain(`placeholder="A Google Sheet link, a Google Drive folder link, a Supabase folder link, or image links one per line"`);
  });
  it("step 2 offers each input on its own first, with the grouping sentence when the batch is grouped per root (M1-F1-R2)", () => {
    const value = { ...detected([]), grouping: { perRoot: true, sentence: "Folder A grouped by folder name, sheet b.xlsx by column E (Option Id)." } } as WizardDetected;
    const html = renderToStaticMarkup(createElement(WizardStep2, {
      detected: value, collecting: false, mode: "per_root", precedence: "uploads_then_links", sheets: [], setMode: () => {}, setPrecedence: () => {}, setSheets: () => {},
      email: "share@example.com", id: SHEET_ID, onError: () => {}, onAccessChecked: async () => {},
    }));
    expect(html).toContain(PER_ROOT_LABEL);
    expect(html).toContain("Recommended. Folder A grouped by folder name, sheet b.xlsx by column E (Option Id).");
    expect(html.indexOf(PER_ROOT_LABEL)).toBeLessThan(html.indexOf("By file name before the last _number"));
    expect(html).toContain(`checked="" value="per_root"`);
  });
});
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
  it("a reopened collecting batch shows the polled count under What we found and the keep-going line, never 0 of 0", () => {
    const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(CatalogWizard, { brands: [{ slug: "uspa", name: "USPA" }] as never, shareEmail: "", initialBatch: resumed })));
    expect(html).toContain("<h2>What we found</h2>");
    expect(html).toContain("Downloading photos 40 of 287.");
    expect(html).toContain(KEEP_GOING_LINE);
    expect(html).not.toContain("0 of 0 products");
  });
  it("the collecting line uses the polled words; the fixed sentence before a count or once stalled", () => {
    expect(collectingLine(state, 287)).toBe("Downloading photos 40 of 287.");
    expect(collectingLine(null, null)).toBe("Collecting files.");
    expect(collectingLine({ ...state, stalled: true }, 287)).toBe("Collecting files.");
    expect(collectingLine(deriveBatchState({ status: "draft", counts: EMPTY_BATCH_COUNTS }), null)).not.toMatch(/0 of 0/);
    expect(KEEP_GOING_LINE).toBe("You can close this page. We will keep going.");
  });
  it("a resumed batch keeps the grouping answers saved at step 2; untouched defaults let detection decide", () => {
    const ready = { ...resumed, status: "draft" as const, counts: { ...counts, previewReady: true } };
    expect(resumedGrouping(undefined, 1)).toEqual({ mode: "per_root", precedence: "uploads_then_links", chosen: false });
    expect(resumedGrouping(ready, 2)).toEqual({ mode: "filename", precedence: "uploads_then_links", chosen: false });
    expect(resumedGrouping({ ...ready, options: { identifierMode: "folder", precedence: "uploads_then_links" } }, 2)).toEqual({ mode: "folder", precedence: "uploads_then_links", chosen: true });
    expect(resumedGrouping({ ...ready, options: { identifierMode: "filename", precedence: "links_only" } }, 2)).toEqual({ mode: "filename", precedence: "links_only", chosen: true });
    expect(resumedGrouping(ready, 4).chosen).toBe(true);
    // M1-F1-R2: a per-root batch opens on "per_root"; a per-root batch is not a choice the first poll must keep.
    expect(resumedGrouping({ ...ready, options: { identifierMode: "filename", precedence: "uploads_then_links", perRoot: true } }, 2)).toEqual({ mode: "per_root", precedence: "uploads_then_links", chosen: false });
  });
  it("a collecting batch whose files are not listed yet shows the fixed sentence, never 0 of 0", () => {
    const listing = deriveBatchState({ status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, collected: 0, collectTotal: 0 }, source: "links" });
    expect(listing.text).toBe("Downloading photos");
    expect(collectingLine(listing, 0)).toBe("Collecting files.");
    expect(collectingLine(listing, null)).toBe("Collecting files.");
  });
});
describe("the one-page copy (M1 section 5)", () => {
  it("countdown, where it goes and what we found", () => {
    expect(countdownText(10)).toBe("Starting in 10 s. Change anything above, or Wait.");
    expect(countdownText(4.2)).toBe("Starting in 5 s. Change anything above, or Wait.");
    expect(countdownText(-1)).toBe("Starting in 1 s. Change anything above, or Wait.");
    expect(goingToText(["Namshi", "Noon"], true)).toBe("Going to: Namshi, Noon (where this brand is listed).");
    expect(goingToText(["Namshi"], false)).toBe("Going to: Namshi.");
    expect(foundText(1284, 312)).toBe("Found 1,284 photos for 312 products.");
  });
});
describe("phase, count and time while collecting and placing (spec 14c F6, web side)", () => {
  const t0 = new Date("2026-10-27T10:00:00Z"), t1 = new Date(+t0 + 100_000);
  const placing = { ...EMPTY_BATCH_COUNTS, collected: 1400, collectTotal: 1400, phase: "placing" as const, placed: 200, placeTotal: 1400, rate: [{ at: t0.toISOString(), phase: "placing" as const, done: 0 }, { at: t1.toISOString(), phase: "placing" as const, done: 200 }] };
  it("the batch page banner names the phase, the count, the source and the time", () => {
    expect(collectingBannerText({ ...placing, phase: "downloading", collected: 612, rate: [{ at: t0.toISOString(), phase: "downloading", done: 400 }, { at: t1.toISOString(), phase: "downloading", done: 612 }] }, "links", t1)).toBe("Downloading photos 612 of 1,400 from your links, about 7 min left");
    expect(collectingBannerText(placing, "Google Sheet", t1)).toBe("Placing photos 200 of 1,400 from your Google Sheet, about 10 min left");
    // Phase words that already name the source are not followed by it; no count before a total.
    expect(collectingBannerText({ ...EMPTY_BATCH_COUNTS, collected: 0, collectTotal: null }, "zip", t1)).toBe("Unpacking your zip");
    expect(collectingBannerText({ ...EMPTY_BATCH_COUNTS, phase: "reading", collected: 40, collectTotal: 287 }, "Google Sheet", t1)).toBe("Reading your sheet 40 of 287");
  });
  it("What we found shows the polled phase words and time", () => {
    const state = deriveBatchState({ status: "ingesting", counts: placing, source: "links", now: t1, updatedAt: t1 });
    expect(collectingLine(state, 1400)).toBe("Placing photos 200 of 1,400, about 10 min left.");
  });
});
