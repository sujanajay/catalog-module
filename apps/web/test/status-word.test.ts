import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STATUS_KEYS, STATUS_WORDS, statusTone } from "@catalog/core/catalog/status-words";
import * as ui from "@/components/ui";
import LocalTime from "@/components/LocalTime";

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
