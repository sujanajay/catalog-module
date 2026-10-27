import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BatchTabs from "../components/catalog/BatchTabs";
import CompareTab, { compareHref } from "../components/catalog/CompareTab";
import CompareGrid, { cellLabel, UNCHANGED_NOTE } from "../components/catalog/CompareGrid";
import { step } from "../components/catalog/CompareViewer";
import ProductBatches, { compareLink } from "../components/catalog/ProductBatches";
import type { ComparePage } from "../lib/catalog/compare";
import type { CompareCell } from "../lib/catalog/compare-copy";
import { notStartedText } from "../lib/catalog/copy";

const cell = (extra: Partial<CompareCell>): CompareCell => ({ channel: "styli", outputId: "o1", url: "https://signed/out.jpg", grade: "passed", unchanged: false, skipped: false, why: "", ...extra });
const page: ComparePage = {
  total: 26, page: 0, channels: ["styli", "amazon"],
  rows: [{ sourceImageId: "s1", productId: "p1", identifier: "ABC-1", n: 1, originalUrl: "https://signed/raw.jpg", cells: [cell({ grade: "unchanged", unchanged: true }), cell({ channel: "amazon", url: null, grade: "failed", why: "No product was found in this photo." })] }],
};

describe("Compare images tab", () => {
  it("opens from ?tab=compare and loads its data from a link when it was not rendered", () => {
    const html = renderToStaticMarkup(createElement(BatchTabs, { attentionCount: 0, initialTab: "compare", overview: "OVERVIEW", attention: "A", compare: "COMPARE", sheet: "SHEET", details: "DETAILS" }));
    expect(html).toMatch(/aria-selected="true"[^>]*>Compare images<\/button>/);
    expect(html).not.toContain("hidden=\"\">COMPARE");
    expect(renderToStaticMarkup(createElement(BatchTabs, { attentionCount: 0, overview: "O", attention: "A", sheet: "S", details: "D" }))).not.toContain("Compare images");
    expect(compareHref({ channel: "styli", status: "attention", q: "ABC" }, 2)).toBe("?tab=compare&q=ABC&cchannel=styli&cstatus=attention&cpage=2");
    expect(compareHref({ channel: "", status: "", q: "" })).toBe("?tab=compare");
  });
  it("shows the original, each channel, the badges and the placeholder, with filters and a pager", () => {
    const html = renderToStaticMarkup(createElement(CompareTab, { data: page, channels: ["styli", "amazon"], filters: { channel: "", status: "", q: "" } }));
    expect(html).toContain("ABC-1");
    expect(html).toContain("src=\"https://signed/raw.jpg\"");
    expect(html).toContain(UNCHANGED_NOTE);
    expect(html).toContain("<div class=\"ph\">Could not be made</div>");
    expect(html).toContain("name=\"tab\" value=\"compare\"");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("href=\"?tab=compare&amp;cpage=1\"");
    expect(html).not.toMatch(/\u2014/);
  });
  it("says a draft with photos has not started, in one line and without a table (spec 14a F9)", () => {
    const line = notStartedText(1240, 312);
    expect(line).toBe("This batch has not started. 1,240 photos found for 312 products; nothing has been made yet.");
    expect(notStartedText(1, 1)).toBe("This batch has not started. 1 photo found for 1 product; nothing has been made yet.");
    const html = renderToStaticMarkup(createElement(BatchTabs, { attentionCount: 0, initialTab: "compare", overview: "O", attention: "A", compare: createElement("p", null, line), sheet: "S", details: "D" }));
    expect(html).toContain(`id="panel-compare" role="tabpanel" tabindex="0" aria-labelledby="tab-compare"><p>${line}</p></section>`);
    expect(html).not.toContain("<table");
  });
  it("words each cell state plainly", () => {
    expect(cellLabel(cell({ grade: "repaired" }))).toBe("Repaired");
    expect(cellLabel(cell({ grade: "failed", skipped: true }))).toBe("Skipped");
    expect(cellLabel(cell({ grade: "failed" }), "No live image")).toBe("No live image");
    expect(cellLabel(cell({ grade: "waiting" }))).toBe("Not made yet");
  });
  it("steps through photos with the arrow keys and wraps at both ends", () => {
    expect(step(3, 2, "ArrowRight")).toBe(0);
    expect(step(3, 0, "ArrowLeft")).toBe(2);
    expect(step(3, 1, "Enter")).toBe(1);
  });
});

describe("product page comparison", () => {
  it("shows no badges and says when a channel has no live image", () => {
    const html = renderToStaticMarkup(createElement(CompareGrid, { rows: [{ key: "1", n: 1, originalUrl: null, cells: [cell({ url: null, grade: "failed" })] }], channels: ["styli"], missing: "No live image", badges: false }));
    expect(html).toContain("No original kept");
    expect(html).toContain("No live image");
    expect(html).not.toContain("class=\"pill");
  });
  it("links each batch to its Compare tab on this product", () => {
    expect(compareLink("b1", "ABC 1")).toBe("/catalog/b1?tab=compare&q=ABC+1");
    const html = renderToStaticMarkup(createElement(ProductBatches, { identifier: "ABC-1", batches: [{ id: "b1", name: "May drop", createdAt: new Date("2026-10-01T10:00:00Z"), finishedAt: null, change: "updated" }] }));
    expect(html).toContain("href=\"/catalog/b1?tab=compare&amp;q=ABC-1\"");
    expect(html).toContain("Pictures replaced");
  });
});
