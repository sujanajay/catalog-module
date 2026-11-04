import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { batchStatusWord, STATUS_KEYS, STATUS_WORDS, statusTone } from "@catalog/core/catalog/status-words";
import { EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import BatchBanner from "@/components/catalog/BatchBanner";
import * as ui from "@/components/ui";
import LocalTime from "@/components/LocalTime";
import { batchListDetail } from "@/lib/catalog/copy";

// UX2: the status vocabulary of UX section 4, the StatusWord that replaces Badge, and local times (UX section 7).
describe("status vocabulary (UX section 4)", () => {
  it("has the eight words of section 4, in order, with their colours", () => {
    expect(STATUS_KEYS.map(k => STATUS_WORDS[k].word)).toEqual([
      "Receiving files", "Getting ready", "Working", "Links ready", "Improving by itself", "Done", "Needs you", "Paused",
    ]);
    expect(STATUS_KEYS.map(k => statusTone(k))).toEqual(["neutral", "run", "run", "ok", "ok", "ok", "warn", "warn"]);
  });

  it("shows Needs you in red only when it blocks, amber when a safe default was used", () => {
    expect(statusTone("needs_you", { blocking: true })).toBe("bad");
    expect(statusTone("needs_you", { blocking: false })).toBe("warn");
    expect(statusTone("working", { blocking: true })).toBe("run");
  });

  it("never uses the avoided words", () => {
    const text = Object.values(STATUS_WORDS).map(w => `${w.word} ${w.meaning}`).join(" ").toLowerCase();
    for (const word of ["failed", "error", "attention", "review", "provisional"]) expect(text).not.toContain(word);
  });
});

describe("StatusWord replaces Badge", () => {
  it("renders the icon, the colour and the word, with the meaning as its title", () => {
    const html = renderToStaticMarkup(createElement(ui.StatusWord, { status: "links_ready" }));
    expect(html).toContain('class="status-word ok"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">Links ready</span>");
    expect(html).toContain(`title="${STATUS_WORDS.links_ready.meaning}"`);
  });

  it("colours Needs you by whether it blocks", () => {
    expect(renderToStaticMarkup(createElement(ui.StatusWord, { status: "needs_you", blocking: true }))).toContain('class="status-word bad"');
    expect(renderToStaticMarkup(createElement(ui.StatusWord, { status: "needs_you" }))).toContain('class="status-word warn"');
  });

  it("Badge is gone", () => {
    expect("Badge" in ui).toBe(false);
  });
});

describe("local times (UX section 7 formats)", () => {
  const at = new Date("2026-11-04T10:00:00Z");
  it("shows day month year and the time in the person's zone with IST or GST", () => {
    expect(ui.localTime(at, "Asia/Kolkata")).toBe("4 Nov 2026, 15:30 IST");
    expect(ui.localTime(at, "Asia/Calcutta")).toBe("4 Nov 2026, 15:30 IST");
    expect(ui.localTime(at, "Asia/Dubai")).toBe("4 Nov 2026, 14:00 GST");
    expect(ui.localTime(at, "UTC")).toBe("4 Nov 2026, 10:00 UTC");
    expect(ui.localTime("2026-09-30T23:30:00Z", "Asia/Dubai")).toBe("1 Oct 2026, 03:30 GST");
    expect(ui.localTime("2026-09-01T00:00:00Z", "UTC")).toBe("1 Sep 2026, 00:00 UTC");
  });

  it("falls back to UTC for a zone the browser reports but cannot format, instead of crashing", () => {
    expect(ui.localTime(at, "Etc/Unknown")).toBe("4 Nov 2026, 10:00 UTC");
    expect(ui.localTime(at, "Not/AZone")).toBe("4 Nov 2026, 10:00 UTC");
  });

  it("names other zones by their offset, and is empty for no date", () => {
    expect(ui.localTime(at, "Europe/London")).toBe("4 Nov 2026, 10:00 GMT");
    // ICU versions differ ("GMT" vs "GMT+0", "UTC+3" vs "GMT+3"); the label is the same on every runtime.
    for (const [raw, label] of [["GMT", "GMT"], ["GMT+0", "GMT"], ["UTC+0", "GMT"], ["GMT-00:00", "GMT"], ["UTC", "GMT"],
      ["UTC+3", "GMT+3"], ["GMT+03:00", "GMT+3"], ["GMT+5:30", "GMT+5:30"], ["UTC-04:00", "GMT-4"], ["GMT+05:45", "GMT+5:45"]]) {
      expect(ui.offsetLabel(raw!), raw).toBe(label);
    }
    expect(ui.localTime(new Date("2026-07-01T10:00:00Z"), "Europe/Berlin")).toBe("1 Jul 2026, 12:00 GMT+2");
    expect(ui.localTime(at, "Europe/Istanbul")).toBe("4 Nov 2026, 13:00 GMT+3");
    expect(ui.localTime(null, "UTC")).toBe("");
    expect(ui.localTime("not a date", "UTC")).toBe("");
  });

  it("the old UTC stamp helper `when` is gone", () => {
    expect("when" in ui).toBe(false);
  });

  it("renders a time element, in UTC on the server until the browser knows the person's zone", () => {
    const html = renderToStaticMarkup(createElement(LocalTime, { at }));
    expect(html).toBe('<time dateTime="2026-11-04T10:00:00.000Z">4 Nov 2026, 10:00 UTC</time>');
    expect(renderToStaticMarkup(createElement(LocalTime, { at: null }))).toBe("");
  });
});

// Owner decision (Sujan, 2026-11-04, "Use proposed"): which status word each batch state shows on the list and banner.
describe("batch states show the section 4 status words", () => {
  it("maps every batch state", () => {
    expect(batchStatusWord("draft")).toEqual({ status: "getting_ready" });
    expect(batchStatusWord("collecting")).toEqual({ status: "getting_ready" });
    expect(batchStatusWord("processing")).toEqual({ status: "working" });
    expect(batchStatusWord("ready")).toEqual({ status: "done" });
    expect(batchStatusWord("attention")).toEqual({ status: "needs_you", blocking: false });
    expect(batchStatusWord("recheck_failed")).toEqual({ status: "needs_you", blocking: false });
    expect(batchStatusWord("failed")).toEqual({ status: "needs_you", blocking: true });
    expect(batchStatusWord("cancelled")).toBeNull();
  });

  it("renders Needs you red for a batch that could not start and the plain word for a cancelled one", () => {
    expect(renderToStaticMarkup(createElement(ui.BatchStatusWord, { state: "failed" }))).toContain('class="status-word bad"');
    expect(renderToStaticMarkup(createElement(ui.BatchStatusWord, { state: "attention" }))).toContain('class="status-word warn"');
    const cancelled = renderToStaticMarkup(createElement(ui.BatchStatusWord, { state: "cancelled" }));
    expect(cancelled).toBe('<span class="status-word">Cancelled</span>');
  });

  it("the banner shows the status word, not the old pill", () => {
    const counts = { ...EMPTY_BATCH_COUNTS, outputs: 10, verified: 10, recheckOk: 10, recheckTotal: 10 };
    const html = renderToStaticMarkup(createElement(BatchBanner, { status: "done", counts, now: "2026-11-04T10:00:00Z" }));
    expect(html).toContain(">Done</span>");
    expect(html).not.toContain('class="pill');
    const failed = renderToStaticMarkup(createElement(BatchBanner, { status: "failed", counts: { ...EMPTY_BATCH_COUNTS, failReason: "No photos were found." }, now: "2026-11-04T10:00:00Z" }));
    expect(failed).toContain('class="status-word bad"');
    expect(failed).toContain(">Needs you</span>");
  });
});

describe("batch list detail under the status word", () => {
  it("shows the intake words while getting ready and the made count while working", () => {
    expect(batchListDetail({ state: "collecting", intake: "Placing photos 30 of 140", made: 0, total: 0 })).toBe("Placing photos 30 of 140");
    expect(batchListDetail({ state: "draft", intake: "Ready to start", made: 0, total: 0 })).toBe("Ready to start");
    expect(batchListDetail({ state: "processing", intake: "", made: 1964, total: 2000 })).toBe("1,964 of 2,000 images made");
    expect(batchListDetail({ state: "ready", intake: "", made: 10, total: 10 })).toBe("");
  });
});
