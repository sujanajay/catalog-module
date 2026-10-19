// Channel table (spec 02, "Channel table"): the marketplace image rules sheet, encoded exactly.
// Nothing is pre-ticked and no channel defaults are stored; the groups only order the wizard cards.
import { CHANNEL_IDS, type ChannelId } from "./types";

export interface Size {
  w: number;
  h: number;
}

export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
  unit: "fraction" | "px";
  /** Noon: side margins apply only when the product bbox is wider than tall. */
  sidesOnlyWhenWide?: boolean;
}

export interface ChannelSpec {
  id: ChannelId;
  label: string;
  /** Information only: orders the cards in the wizard. */
  group: "P1" | "P2";
  minCanvas: Size;
  targetCanvas: Size;
  /** Zeros with unit "fraction" when the sheet is silent. */
  margins: Margins;
  anchor: "centre" | "bottom-centre";
  background: string;
  /** "#FFFFFF" for amazon and shein: the first image is pure white. */
  firstImageBackground?: string;
  dpi: number;
  /**
   * True where every output is exactly the target canvas: styli and centrepoint (min equals target)
   * and trendyol, whose accepted files are 1200x1800 (SPEC.md channel table). A fixed canvas scales
   * the product to fit even beyond MAX_UPSCALE; `low_resolution` then stays an information flag
   * (Styli alone skips such shots).
   */
  fixedCanvas: boolean;
  /** True for styli. */
  uniformScaleDefault: boolean;
  /** The text column of the rules sheet. */
  sheetText: string;
  notes?: string;
}

const GREY = "#E0E0E0";
const WHITE = "#FFFFFF";
const NO_MARGINS: Margins = { top: 0, bottom: 0, left: 0, right: 0, unit: "fraction" };

export const CHANNELS: Record<ChannelId, ChannelSpec> = {
  noon: {
    id: "noon",
    label: "Noon",
    group: "P1",
    minCanvas: { w: 660, h: 900 },
    targetCanvas: { w: 1080, h: 1480 },
    margins: { top: 0.1, bottom: 0.1, left: 0.05, right: 0.05, unit: "fraction", sidesOnlyWhenWide: true },
    anchor: "centre",
    background: GREY,
    dpi: 72,
    fixedCanvas: false,
    uniformScaleDefault: false,
    sheetText: "660x900 (min) -> 1080x1480+, >=72 PPI, <=2 MB, 0.73 (3:4)",
    notes: "The 5% side margin is the minimum for horizontal shots (product wider than tall).",
  },
  namshi: {
    id: "namshi",
    label: "Namshi",
    group: "P1",
    minCanvas: { w: 660, h: 900 },
    targetCanvas: { w: 1080, h: 1480 },
    margins: { top: 0.1, bottom: 0.1, left: 0, right: 0, unit: "fraction" },
    anchor: "centre",
    background: GREY,
    dpi: 72,
    fixedCanvas: false,
    uniformScaleDefault: false,
    sheetText: "= Noon rules",
  },
  trendyol: {
    id: "trendyol",
    label: "Trendyol",
    group: "P1",
    minCanvas: { w: 600, h: 800 },
    targetCanvas: { w: 1200, h: 1800 },
    margins: NO_MARGINS,
    anchor: "centre",
    background: GREY,
    dpi: 96,
    fixedCanvas: true,
    uniformScaleDefault: false,
    sheetText: "600x800 @72 (min) -> 1200x1800 @96, <=2 MB, 3:4, HTTPS, no spaces",
    notes: "Accepted files are 1200x1800, so every Trendyol image is delivered at exactly 1200x1800.",
  },
  styli: {
    id: "styli",
    label: "Styli",
    group: "P2",
    minCanvas: { w: 2342, h: 3123 },
    targetCanvas: { w: 2342, h: 3123 },
    margins: { top: 450, bottom: 450, left: 150, right: 150, unit: "px" },
    anchor: "bottom-centre",
    background: GREY,
    dpi: 300,
    fixedCanvas: true,
    uniformScaleDefault: true,
    sheetText: "1200x1600 -> 2000x2667",
    notes: "The 2342x3123 canvas from the Styli email applies to every Styli image.",
  },
  centrepoint: {
    id: "centrepoint",
    label: "Centrepoint",
    group: "P2",
    minCanvas: { w: 3000, h: 3000 },
    targetCanvas: { w: 3000, h: 3000 },
    margins: NO_MARGINS,
    anchor: "centre",
    background: GREY,
    dpi: 300,
    fixedCanvas: true,
    uniformScaleDefault: false,
    sheetText: "3000x3000, >=300 PPI, 1:1",
  },
  sixthstreet: {
    id: "sixthstreet",
    label: "6thStreet",
    group: "P2",
    minCanvas: { w: 1200, h: 1600 },
    targetCanvas: { w: 2000, h: 2667 },
    margins: NO_MARGINS,
    anchor: "centre",
    background: GREY,
    dpi: 300,
    fixedCanvas: false,
    uniformScaleDefault: false,
    sheetText: "1200x1600 -> 2000x2667, 3:4",
  },
  vogacloset: {
    id: "vogacloset",
    label: "VogaCloset",
    group: "P2",
    minCanvas: { w: 1200, h: 1600 },
    targetCanvas: { w: 2000, h: 2667 },
    margins: NO_MARGINS,
    anchor: "centre",
    background: GREY,
    dpi: 300,
    fixedCanvas: false,
    uniformScaleDefault: false,
    sheetText: "same as 6thStreet",
  },
  amazon: {
    id: "amazon",
    label: "Amazon",
    group: "P1",
    minCanvas: { w: 1000, h: 1000 },
    targetCanvas: { w: 2000, h: 2000 },
    margins: NO_MARGINS,
    anchor: "centre",
    background: GREY,
    firstImageBackground: WHITE,
    dpi: 300,
    fixedCanvas: false,
    uniformScaleDefault: false,
    sheetText: "1000x1000 -> 2000x2000, 3:4 portrait, first image pure white",
  },
  shein: {
    id: "shein",
    label: "Shein",
    group: "P2",
    minCanvas: { w: 1000, h: 1000 },
    targetCanvas: { w: 2000, h: 2000 },
    margins: NO_MARGINS,
    anchor: "centre",
    background: GREY,
    firstImageBackground: WHITE,
    dpi: 300,
    fixedCanvas: false,
    uniformScaleDefault: false,
    sheetText: "exactly Amazon",
  },
};

/** The row order of the rules sheet. */
/** The channel table's row order (the order of CHANNEL_IDS). */
export const CHANNEL_ORDER: ChannelId[] = [...CHANNEL_IDS];

export function channel(id: ChannelId): ChannelSpec {
  const spec = CHANNELS[id];
  if (!spec) throw new Error(`Unknown channel: ${String(id)}`);
  return spec;
}

/** The canvas colour for a shot: `firstImageBackground` for shot 1 where the channel has one. */
export function backgroundFor(id: ChannelId, shotNumber: number): string {
  const spec = channel(id);
  return shotNumber === 1 && spec.firstImageBackground ? spec.firstImageBackground : spec.background;
}

export const JPEG_QUALITY_START = 90;
export const JPEG_QUALITY_MIN = 70;
export const JPEG_QUALITY_STEP = 5;
export const MAX_OUTPUT_BYTES = 2_000_000;
export const MAX_UPSCALE = 1.5;
export const DETAIL_SHOT_BBOX_FRACTION = 0.85;
export const MIN_SOURCE_LONG_SIDE_PX = 500;
/** ceil((3123 - 450 - 450) / 1.5); feeds the wizard warning only. */
export const STYLI_MIN_SOURCE_HEIGHT_PX = 1482;
/** Agreement with Styli; always applied (not a batch option). */
export const STYLI_SKIP_LOW_RESOLUTION = true;
/** Bumped on any rule change; part of render_key (06). */
export const CHANNEL_RULES_VERSION = "4";
