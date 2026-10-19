import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AttentionProductCard from "../components/catalog/AttentionProductCard";
import CostLine from "../components/catalog/CostLine";
import { attentionLabel } from "../components/catalog/BatchTabs";
import { missingLine, skuAddedToast, unmatchedLine } from "../components/catalog/SkuMapModal";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";
import { estimateText, listAnd } from "../lib/catalog/copy";
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
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: 0.04, inrPerIdentifier: 3.8 } })))).toBe("INR 3.80 per style so far · agency reference INR 60 per style");
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: 0.04, inrPerIdentifier: null } })))).toBe("USD 0.04 per style so far · Cost in rupees is not configured yet · agency reference INR 60 per style");
    expect(text(renderToStaticMarkup(createElement(CostLine, { line: { usdPerIdentifier: null, inrPerIdentifier: null } })))).toContain("agency reference INR 60 per style");
    for (const line of [{ usdPerIdentifier: 0.04, inrPerIdentifier: null }, { usdPerIdentifier: null, inrPerIdentifier: null }]) expect(renderToStaticMarkup(createElement(CostLine, { line }))).not.toMatch(/INR_PER_USD|set [A-Z_]+/);
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
