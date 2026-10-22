import { describe, expect, it } from "vitest";
import {
  backgroundFor,
  channel,
  CHANNEL_ORDER,
  CHANNEL_RULES_VERSION,
  CHANNELS,
  MIN_SOURCE_LONG_SIDE_PX,
} from "./channels";
import * as channels from "./channels";
import { CHANNEL_IDS, type ChannelId } from "./types";

// The rules sheet re-declared independently, one row per channel, compared field by field.
type Row = [
  id: ChannelId,
  label: string,
  group: "P1" | "P2",
  min: [number, number],
  target: [number, number],
  margins: [number, number, number, number, "fraction" | "px"],
  anchor: "centre" | "bottom-centre",
  first: string | undefined,
  dpi: number,
  fixed: boolean,
  uniform: boolean,
  sheetText: string,
];
const SHEET: Row[] = [
  ["noon", "Noon", "P1", [660, 900], [1080, 1480], [0.1, 0.1, 0.05, 0.05, "fraction"], "centre", undefined, 72, false, false,
    "660x900 (min) -> 1080x1480+, >=72 PPI, <=2 MB, 0.73 (3:4)"],
  ["namshi", "Namshi", "P1", [660, 900], [1080, 1480], [0.1, 0.1, 0, 0, "fraction"], "centre", undefined, 72, false, false,
    "= Noon rules"],
  ["trendyol", "Trendyol", "P1", [600, 800], [1200, 1800], [0, 0, 0, 0, "fraction"], "centre", undefined, 96, true, false,
    "600x800 @72 (min) -> 1200x1800 @96, <=2 MB, 3:4, HTTPS, no spaces"],
  ["styli", "Styli", "P2", [2342, 3123], [2342, 3123], [450, 450, 150, 150, "px"], "bottom-centre", undefined, 300, true, true,
    "1200x1600 -> 2000x2667"],
  ["centrepoint", "Centrepoint", "P2", [3000, 3000], [3000, 3000], [0, 0, 0, 0, "fraction"], "centre", undefined, 300, true, false,
    "3000x3000, >=300 PPI, 1:1"],
  ["sixthstreet", "6thStreet", "P2", [1200, 1600], [2000, 2667], [0, 0, 0, 0, "fraction"], "centre", undefined, 300, false, false,
    "1200x1600 -> 2000x2667, 3:4"],
  ["vogacloset", "VogaCloset", "P2", [1200, 1600], [2000, 2667], [0, 0, 0, 0, "fraction"], "centre", undefined, 300, false, false,
    "same as 6thStreet"],
  ["amazon", "Amazon", "P1", [1000, 1000], [2000, 2000], [0, 0, 0, 0, "fraction"], "centre", "#FFFFFF", 300, false, false,
    "1000x1000 -> 2000x2000, 3:4 portrait, first image pure white"],
  ["shein", "Shein", "P2", [1000, 1000], [2000, 2000], [0, 0, 0, 0, "fraction"], "centre", "#FFFFFF", 300, false, false,
    "exactly Amazon"],
];

describe("channel table", () => {
  it("has every channel id, in the sheet order", () => {
    expect(Object.keys(CHANNELS).sort()).toEqual([...CHANNEL_IDS].sort());
    expect(CHANNEL_ORDER).toEqual(SHEET.map((r) => r[0]));
  });

  it.each(SHEET)("%s matches the rules sheet", (id, label, group, min, target, m, anchor, first, dpi, fixed, uniform, text) => {
    const c = channel(id);
    expect(c.id).toBe(id);
    expect(c.label).toBe(label);
    expect(c.group).toBe(group);
    expect(c.minCanvas).toEqual({ w: min[0], h: min[1] });
    expect(c.targetCanvas).toEqual({ w: target[0], h: target[1] });
    expect(c.margins).toMatchObject({ top: m[0], bottom: m[1], left: m[2], right: m[3], unit: m[4] });
    expect(c.margins.sidesOnlyWhenWide ?? false).toBe(id === "noon");
    expect(c.anchor).toBe(anchor);
    expect(c.background).toBe("#E0E0E0");
    expect(c.firstImageBackground).toBe(first);
    expect(c.dpi).toBe(dpi);
    expect(c.fixedCanvas).toBe(fixed);
    // Fixed where min equals target, plus Trendyol: its accepted files are exactly 1200x1800 (SPEC.md).
    expect(c.fixedCanvas).toBe((min[0] === target[0] && min[1] === target[1]) || id === "trendyol");
    expect(c.uniformScaleDefault).toBe(uniform);
    expect(c.sheetText).toBe(text);
  });

  it("uses a white first image only where the sheet says so", () => {
    expect(backgroundFor("amazon", 1)).toBe("#FFFFFF");
    expect(backgroundFor("amazon", 2)).toBe("#E0E0E0");
    expect(backgroundFor("shein", 1)).toBe("#FFFFFF");
    expect(backgroundFor("noon", 1)).toBe("#E0E0E0");
  });

  it("keeps the constants", () => {
    expect(typeof CHANNEL_RULES_VERSION).toBe("string");
    expect(CHANNEL_RULES_VERSION.length).toBeGreaterThan(0);
  });
  it("has one size floor for every channel, 500 px, and no Styli-only one (owner decision 2026-10-22)", () => {
    expect(MIN_SOURCE_LONG_SIDE_PX).toBe(500);
    expect(Object.keys(channels).filter(name => /styli/i.test(name))).toEqual([]);
  });
});
