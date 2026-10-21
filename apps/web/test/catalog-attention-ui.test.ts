import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AttentionProductCard from "../components/catalog/AttentionProductCard";
import CostLine from "../components/catalog/CostLine";
import DetailsTab from "../components/catalog/DetailsTab";
import BatchTabs, { attentionLabel, showAttentionTab } from "../components/catalog/BatchTabs";
import BatchBanner from "../components/catalog/BatchBanner";
import { EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { plannedImages } from "../lib/catalog/preview";
import { missingLine, skuAddedToast, unmatchedLine } from "../components/catalog/SkuMapModal";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";
import { batchSource, collectingText, estimateText, listAnd, readyText } from "../lib/catalog/copy";
import type { AttentionProduct } from "../lib/catalog/products";

const MODEL_WORDS = /gemini|claude|qwen|birefnet|rmbg|bria|inspyre|ben_custom|google\/|anthropic\//i;
const wrap = (node: ReactNode) => renderToStaticMarkup(createElement(ViewerPreviewProvider, null, createElement(ToastProvider, null, node)));
const item: AttentionProduct = {
  productId: "p1", identifier: "6W_ACHILLE_MEN_OD_BLACK", totalShots: 5, problemLine: "Photo 2: the model's hand looks cut at the frame edge.",
  photos: [{ n: 2, channel: "noon", outputId: "o1", outputIds: ["o1", "o2"], originalUrl: "https://signed/raw", outputUrl: "https://signed/made", why: "Part of the product or model looks cut at the frame edge in the original photo.", whatToDo: "We never crop, so the made image shows the same thing.", liveObjectExists: true, liveChannels: ["noon", "styli"], failed: false, flags: ["complete_product"] }],
};

describe("needs attention card", () => {
  it("shows the photo rows, the three actions and the live warning for an operator", () => {
    const html = wrap(createElement(AttentionProductCard, { item, canAct: true, channels: ["Noon", "Styli"] }));
    expect(html).toContain("1 of 5 photos need a decision");
    expect(html).toContain("Photo 2 of 5, original");
    expect(html).toContain("Photo 2 of 5, made for Noon");
    for (const text of ["Use as is", "Remove this photo", "Replace photo 2"]) expect(html).toContain(`>${text}</button>`);
    expect(html).toContain("This removes the live image for this photo on Noon and Styli.");
    expect(html).not.toMatch(MODEL_WORDS);
  });
  it("hides every action for a viewer and collapses to the resolved card once decided", () => {
    const viewer = wrap(createElement(AttentionProductCard, { item, canAct: false, channels: ["Noon"] }));
    expect(viewer).not.toContain("Use as is");
    const done = wrap(createElement(AttentionProductCard, { item, canAct: true, channels: ["Noon"], stateOf: () => "done" as const }));
    expect(done).toContain("Resolved");
    expect(done).toContain("Sheet updated.");
    expect(done).not.toContain("Use as is");
  });
  it("counts the tab label down in the singular and plural", () => {
    expect(attentionLabel(3)).toBe("Needs attention (3 products)");
    expect(attentionLabel(1)).toBe("Needs attention (1 product)");
  });
});

describe("cost and SKU copy", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "");
  it("renders the INR per style line, the USD fallback and the not-yet line", () => {
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: 0.04, inrPerIdentifier: 3.8, usd: 0.4, inr: 38 } })))).toBe("USD 0.0400 (INR 3.80) per style so far · USD 0.4000 (INR 38.00) for this batch · agency reference INR 60 per style");
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: 0.04, inrPerIdentifier: null, usd: 0.4, inr: null } })))).toBe("USD 0.0400 per style so far · USD 0.4000 for this batch · Cost in rupees is not configured yet · agency reference INR 60 per style");
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: null, inrPerIdentifier: null, usd: 0, inr: null } })))).toContain("agency reference INR 60 per style");
    // A real judged batch costs a fraction of a cent per style; the line must not read 0.00.
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: 0.000603, inrPerIdentifier: null, usd: 0.0072398, inr: null } })))).toMatch(/^USD 0\.0006 per style so far · USD 0\.0072 for this batch/);
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: 0.000603, inrPerIdentifier: 0.0507, usd: 0.0072398, inr: 0.6081 } })))).toMatch(/^USD 0\.0006 \(INR 0\.05\) per style so far · USD 0\.0072 \(INR 0\.61\) for this batch/);
    for (const line of [{ usdPerIdentifier: 0.04, inrPerIdentifier: null, usd: 0.4, inr: null }, { usdPerIdentifier: null, inrPerIdentifier: null, usd: 0, inr: null }]) expect(renderToStaticMarkup(createElement(CostLine, { line }))).not.toMatch(/INR_PER_USD|set [A-Z_]+/);
  });
  it("words the wizard estimate and the SKU modal lines", () => {
    expect(estimateText({ usd: 1, inr: 1234.5, images: 6569, qaChecks: 412 })).toBe("Estimated cost: about INR 1,234.50 (6,569 images, 412 quality checks)");
    expect(estimateText(null)).toBe("Estimated cost: not available. Cost in rupees is not configured yet.");
    expect(skuAddedToast(2)).toBe("2 ids added. New links sheet ready.");
    expect(missingLine(3)).toBe("3 identifiers have no Opptra SKU id yet in this batch.");
    expect(unmatchedLine(["abc", "def"])).toBe("2 rows did not match any identifier in this batch: abc, def");
    expect(listAnd(["Noon", "Namshi", "Trendyol", "Styli"])).toBe("Noon, Namshi, Trendyol and Styli");
  });
});

describe("attention tab after the last decision", () => {
  const tabs = (attentionCount: number, initialTab?: string) => renderToStaticMarkup(createElement(BatchTabs, { attentionCount, initialTab, overview: "OVERVIEW", attention: "RESOLVED CARDS", sheet: "SHEET", details: "DETAILS" }));
  it("stays while the operator is on it, so the resolved cards show, and goes once they leave at 0", () => {
    expect(showAttentionTab({ evalMode: false, remaining: 0, active: "attention" })).toBe(true);
    expect(showAttentionTab({ evalMode: false, remaining: 0, active: "overview" })).toBe(false);
    expect(showAttentionTab({ evalMode: false, remaining: 1, active: "overview" })).toBe(true);
    const onTab = tabs(0, "attention");
    expect(onTab).toContain(">Needs attention (0 products)</button>");
    expect(onTab).toMatch(/aria-selected="true"[^>]*>Needs attention/);
    expect(onTab).not.toContain("hidden=\"\">RESOLVED CARDS");
    expect(tabs(0)).not.toContain("Needs attention");
  });
});

describe("batch copy for the real state of the batch", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "");
  it("does not say every image passed every check when photos were kept with Use as is", () => {
    expect(readyText(12, 0)).toBe("All 12 images are live and passed every check. Nothing needs your attention.");
    expect(readyText(12, 1)).toBe("All 12 images are live. 1 photo was kept as is after a decision; everything else passed every check. Nothing needs your attention.");
    const counts = { ...EMPTY_BATCH_COUNTS, outputs: 12, verified: 12, recheckOk: 12, recheckTotal: 12 };
    expect(text(renderToStaticMarkup(createElement(BatchBanner, { status: "done", counts, keptPhotos: 2 })))).toBe("ReadyAll 12 images are live. 2 photos were kept as is after a decision; everything else passed every check. Nothing needs your attention.");
    expect(text(renderToStaticMarkup(createElement(BatchBanner, { status: "done", counts })))).toContain("passed every check. Nothing needs your attention.");
    const skipped = { ...counts, outputs: 15, skipped: 5, verified: 10, recheckOk: 10, recheckTotal: 10 };
    expect(text(renderToStaticMarkup(createElement(BatchBanner, { status: "done", counts: skipped })))).toBe("ReadyAll 10 images are live and passed every check. Nothing needs your attention.");
    expect(text(renderToStaticMarkup(createElement(BatchBanner, { status: "done", counts: skipped, styliSkipped: 5 })))).toBe("ReadyAll 10 images are live and passed every check. 5 Styli images were not made because the photos are too small for Styli even after enlargement (see the notes column).");
    expect(readyText(10, 1, 1)).toBe("All 10 images are live. 1 photo was kept as is after a decision; everything else passed every check. 1 Styli image was not made because the photo is too small for Styli even after enlargement (see the notes column).");
  });
  it("shows the server's time left in the processing banner, the same on every reload", () => {
    const counts = { ...EMPTY_BATCH_COUNTS, outputs: 10 };
    const banner = text(renderToStaticMarkup(createElement(BatchBanner, { status: "matting", counts, startedAt: "2026-10-21T13:36:19.000Z", now: "2026-10-21T13:36:49.000Z" })));
    expect(banner).toBe("Processing0 of 10 images made · about 1 to 5 min left. You can close this page and come back; nothing stops. Starting the image services. The first pictures usually take a minute or two on the first batch after a quiet spell.");
  });
  it("names the actual source while collecting, never a Drive folder for local uploads", () => {
    expect(batchSource(["image"])).toBe("upload");
    expect(batchSource(["image", "product_list"])).toBe("upload");
    expect(batchSource(["zip"])).toBe("zip");
    expect(batchSource(["url_list"])).toBe("links");
    expect(batchSource(["sheet", "image"])).toBe("links");
    expect(batchSource(["google_sheet"])).toBe("Google Sheet");
    expect(batchSource(["drive_folder", "zip"])).toBe("Drive folder");
    const banner = text(renderToStaticMarkup(createElement(BatchBanner, { status: "ingesting", counts: { ...EMPTY_BATCH_COUNTS, collected: 3, collectTotal: 10 }, source: batchSource(["image"]) })));
    expect(banner).toContain("3 of 10 files copied from your upload");
    expect(collectingText("upload")).toBe("Checking your uploaded files. Processing starts by itself. You can close this page.");
    for (const source of ["upload", "zip", "links", "Google Sheet"] as const) expect(collectingText(source)).not.toContain("Drive folder");
    expect(collectingText("zip")).toBe("Unpacking your zip. Processing starts by itself. You can close this page.");
    for (const source of ["links", "Google Sheet", "Drive folder"] as const) expect(collectingText(source)).toBe("Copying your files. Processing starts by itself. You can close this page.");
  });
  it("leaves out pairs whose live image was made from the same photo in the step 4 count", () => {
    const sources = [{ productId: "p", n: 1, sha256: "same", height: 1600 }, { productId: "p", n: 2, sha256: "new", height: 800 }];
    const live = [{ productId: "p", n: 1, channel: "noon" as const, sha256: "same" }, { productId: "p", n: 2, channel: "noon" as const, sha256: "old" }];
    // Photo 1 is unchanged on Noon but new on Styli; photo 2 changed on Noon and is too small for Styli.
    expect(plannedImages(sources, ["noon", "styli"], live)).toEqual({ outputs: 2, sourcesToMake: 2 });
    expect(plannedImages([sources[0]!], ["noon"], live)).toEqual({ outputs: 0, sourcesToMake: 0 });
  });
});

describe("Details tab link counts", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
  const details = (counts: Partial<typeof EMPTY_BATCH_COUNTS>) => text(renderToStaticMarkup(createElement(DetailsTab, { id: "b1", brand: "test_brand", isTest: true, counts: { ...EMPTY_BATCH_COUNTS, ...counts }, failures: [], recheckFailures: [], notRefreshedChannels: [], hasReport: true })));
  it("counts this batch's delivered links on both lines and says the held and carried-over links apart (quality gate 2)", () => {
    // B4: 376 planned, 40 held for a decision, 336 delivered; the sheet kept 40 earlier links of the held product.
    const html = details({ outputs: 376, verified: 336, attentionProducts: 1, heldLinks: 40, recheckOk: 336, recheckTotal: 336, recheckCarriedOk: 40, recheckCarriedTotal: 40 });
    expect(html).toContain("Links verified: 336 of 336");
    expect(html).toContain("Independent re-check: 336 of 336 OK");
    expect(html).toContain("Not counted above: 40 images of the product that needs your attention, published once you decide. Until then the sheet keeps 40 earlier links for it; the re-check found 40 of 40 OK.");
    // B1: two new products held, nothing carried over.
    const b1 = details({ outputs: 96, verified: 32, attentionProducts: 2, heldLinks: 64, recheckOk: 32, recheckTotal: 32 });
    expect(b1).toContain("Links verified: 32 of 32");
    expect(b1).toContain("Not counted above: 64 images of the products that need your attention, published once you decide.");
    expect(b1).not.toContain("earlier");
    expect(details({ outputs: 4, verified: 4, recheckOk: 4, recheckTotal: 4 })).not.toContain("Not counted above");
  });
});
