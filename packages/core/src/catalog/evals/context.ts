// Builds the per-output context the image checkers share: the decoded canvas, the alpha the output
// should carry (the matte projected the way the render projects it) and the boxes of spec 05.
import { backgroundFor, channel, type ChannelSpec } from "../channels";
import { hexColor, safeBoxFor, shotGeometry, type BBox, type CutEdges } from "../render";
import { decodeRaster, productBoxOf, projectAlpha, projectRgb, shadowBand, thresholdMask, type Mask } from "./image";
import type { OutputSubject, Raster } from "./types";

/** Alpha at or below this level is edge antialiasing (spec 05 ALPHA_BBOX_THRESHOLD). */
export const ALPHA_EDGE = 10;
/** Alpha from this level up is more product than background (half coverage): the visible edge of the product. */
export const ALPHA_HALF = 128;

export interface OutputContext {
  subject: OutputSubject;
  spec: ChannelSpec;
  canvas: Raster;
  /** The canvas colour the sheet prescribes for this shot. */
  background: [number, number, number];
  sourceBox: BBox;
  /** The part of `sourceBox` the recorded placement leaves room for (expectedSourceCrop): smaller than `sourceBox` only where the product overflows an axis. */
  sourceCrop: BBox;
  productBox: BBox;
  safeBox: BBox;
  /** Spec 05 shadow band for this placement. */
  band: BBox;
  /** Projected alpha per canvas pixel. */
  expectedAlpha: Uint8Array;
  /** expectedAlpha > ALPHA_EDGE. */
  product: Mask;
  /** expectedAlpha >= ALPHA_HALF: where the product covers more than half of the pixel, which is what a reviewer sees as its edge. */
  half: Mask;
  /** The source RGB resampled to `productBox` from `sourceCrop` (lanczos3), row-major over the product box: what every product pixel should look like. */
  sourceRgb: Buffer;
  /** Whether the channel allows a shadow for this product type (spec 05: footwear, bags, other). */
  shadowAllowed: boolean;
  /**
   * Sides the placed crop is cut at (`placedCutSides`): of the sides the render's shotGeometry found cut (`cut`), those the
   * part of the source actually placed still touches. The cut-fill trim can take the rows that touched a perpendicular
   * edge off the crop (eval run 3, Z03E68A3989163039BCFEZ n=3: a 32% bottom trim removed the collar rows that touched the
   * left edge), and the output then rightly shows a margin there. `flush_*` and `no_line_*` are judged on these sides.
   */
  cutSides: ("top" | "bottom" | "left" | "right")[];
  /** Sides of the source frame the product is cut at (the render's own shotGeometry rule), which decided the placement. */
  cut: CutEdges;
}

/** A cut side needs a straight run of product at least this share of the frame edge (spec 10 section 7; shotGeometry's CUT_EDGE_MIN_STRAIGHT). */
export const PLACED_CUT_MIN_SHARE = 0.02;
export const PLACED_CUT_MIN_PX = 8;

/**
 * Which of the render's cut sides the placed crop still touches. A side the crop was trimmed on (the crop's edge lies
 * inside the product box there) stays cut: the product continues beyond the crop. On the other cut sides the matte along
 * the box's edge line, within the crop's span on the other axis, must still hold a straight run of product at least
 * PLACED_CUT_MIN_SHARE of the frame edge (never under PLACED_CUT_MIN_PX): a side whose touching rows the trim removed is
 * not cut on this output, and its margin is a margin, not a band.
 */
export function placedCutSides(alpha: Buffer, source: { w: number; h: number }, sourceBox: BBox, sourceCrop: BBox, cut: CutEdges): ("top" | "bottom" | "left" | "right")[] {
  const out: ("top" | "bottom" | "left" | "right")[] = [];
  for (const side of ["top", "bottom", "left", "right"] as const) {
    if (!cut[side]) continue;
    const horizontal = side === "top" || side === "bottom";
    const trimmed = side === "top" ? sourceCrop.y > sourceBox.y : side === "bottom" ? sourceCrop.y + sourceCrop.h < sourceBox.y + sourceBox.h : side === "left" ? sourceCrop.x > sourceBox.x : sourceCrop.x + sourceCrop.w < sourceBox.x + sourceBox.w;
    if (trimmed) { out.push(side); continue; }
    const line = side === "top" ? sourceBox.y : side === "bottom" ? sourceBox.y + sourceBox.h - 1 : side === "left" ? sourceBox.x : sourceBox.x + sourceBox.w - 1;
    const from = horizontal ? sourceCrop.x : sourceCrop.y, to = horizontal ? sourceCrop.x + sourceCrop.w : sourceCrop.y + sourceCrop.h;
    const need = Math.max(PLACED_CUT_MIN_PX, Math.ceil((horizontal ? source.w : source.h) * PLACED_CUT_MIN_SHARE));
    let run = 0, longest = 0;
    for (let i = Math.max(0, from); i < Math.min(horizontal ? source.w : source.h, to); i++) {
      const a = alpha[horizontal ? line * source.w + i : i * source.w + line]!;
      if (a > ALPHA_EDGE) { run++; if (run > longest) longest = run; } else run = 0;
    }
    if (longest >= need) out.push(side);
  }
  return out;
}

export const SHADOW_TYPES = new Set(["footwear", "bag_accessory", "other", "auto"]);
export const APPAREL_TYPES = new Set(["apparel_model", "apparel_flat"]);

/** How the output carries its shadow, from the render's own flags on the output. */
export function shadowMode(flags: readonly string[]): "synthesised" | "kept" | "none" {
  if (flags.includes("shadow_synthesised")) return "synthesised";
  if (flags.includes("no_shadow_source")) return "none";
  return "kept";
}
/**
 * Whether a shadow may lie under this output. Footwear, bags and hardline may carry one in either mode. Apparel follows
 * SPEC.md's shadow rule (preserve_only): the photo's own shadow, measured on a uniform background, is kept for every
 * type and only synthesis is forbidden, so an apparel output in kept mode (neither `shadow_synthesised` nor
 * `no_shadow_source`) may carry the photographer's shadow and is judged against the source like footwear; one that
 * says `no_shadow_source` or `shadow_synthesised` may carry none.
 */
export const shadowAllowedFor = (productType: string, flags: readonly string[]): boolean => SHADOW_TYPES.has(productType) || (APPAREL_TYPES.has(productType) && shadowMode(flags) === "kept");

/** Source pixels the recorded scale leaves no room for on one axis of the safe box (0 when the product fits). */
export function overflowPx(length: number, scale: number, room: number): number {
  return Math.max(0, length - Math.max(1, Math.min(length, Math.round(room / scale))));
}

/**
 * The part of `sourceBox` the output should show, computed from the recorded placement and the spec 05 rule, not
 * from the render's own code: where the product at `scale` overflows an axis of the safe box, the overflow comes
 * off that axis's cut sides (split evenly when both are cut; matchCropSplit reads an uneven split from the canvas). An axis with no cut side is never trimmed here, so a
 * render that trims an uncut outline shows up as a mismatch in `geometry.extent` and `geometry.pixels_copied`,
 * and `cut_edge.trim` bounds how much a cut side may lose.
 */
export function expectedSourceCrop(sourceBox: BBox, scale: number, safeBox: BBox, cut: CutEdges): BBox {
  const axis = (start: number, length: number, room: number, low: boolean, high: boolean): [number, number] => {
    const extra = low || high ? overflowPx(length, scale, room) : 0;
    return [start + (low && high ? Math.floor(extra / 2) : low ? extra : 0), length - extra];
  };
  const [x, w] = axis(sourceBox.x, sourceBox.w, safeBox.w, cut.left, cut.right), [y, h] = axis(sourceBox.y, sourceBox.h, safeBox.h, cut.top, cut.bottom);
  return { x, y, w, h };
}

/** Samples per axis matchCropSplit compares; a tie within this mean delta goes to the even split. */
export const SPLIT_SAMPLES = 96;
export const SPLIT_TIE_DELTA = 0.5;

/**
 * Where both cut sides of an axis share a trim, spec 05 lets the render take more off one of them so a logo, text or a
 * buckle near the other stays whole. Which split it took is read from the canvas, not from the render's code: the
 * offset whose resampled source (nearest neighbour on a SPLIT_SAMPLES grid inside the product box) matches the output
 * best; a tie within SPLIT_TIE_DELTA goes to the even split. Both sides are cut, so any split keeps uncut outlines whole.
 */
function bilinear(source: Raster, x: number, y: number, c: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(source.w - 1, x0 + 1), y1 = Math.min(source.h - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) => source.rgb[(yy * source.w + xx) * 3 + c]!;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

export function matchCropSplit(canvas: Raster, source: Raster, sourceBox: BBox, crop: BBox, productBox: BBox, axis: "x" | "y"): BBox {
  const extra = axis === "x" ? sourceBox.w - crop.w : sourceBox.h - crop.h;
  if (extra <= 0) return crop;
  const even = Math.floor(extra / 2), scores: number[] = [];
  for (let off = 0; off <= extra; off++) {
    const cx = axis === "x" ? sourceBox.x + off : crop.x, cy = axis === "y" ? sourceBox.y + off : crop.y;
    let sum = 0, count = 0;
    for (let j = 0; j < SPLIT_SAMPLES; j++) for (let i = 0; i < SPLIT_SAMPLES; i++) {
      const px = productBox.x + Math.floor((i + 0.5) * productBox.w / SPLIT_SAMPLES), py = productBox.y + Math.floor((j + 0.5) * productBox.h / SPLIT_SAMPLES);
      if (px < 0 || py < 0 || px >= canvas.w || py >= canvas.h) continue;
      // Bilinear sample of the source at the canvas pixel's centre, so a fine texture does not alias into a tie between neighbouring offsets.
      const sx = Math.min(source.w - 1, Math.max(0, cx + (px - productBox.x + 0.5) * crop.w / productBox.w - 0.5)), sy = Math.min(source.h - 1, Math.max(0, cy + (py - productBox.y + 0.5) * crop.h / productBox.h - 0.5));
      const a = (py * canvas.w + px) * 3;
      for (let c = 0; c < 3; c++) sum += Math.abs(canvas.rgb[a + c]! - bilinear(source, sx, sy, c));
      count++;
    }
    scores.push(count ? sum / count / 3 : 0);
  }
  const best = Math.min(...scores);
  let off = even;
  for (let k = 0; k <= extra; k++) if (scores[k]! <= best + SPLIT_TIE_DELTA && Math.abs(k - even) < Math.abs(off - even)) off = k;
  if (scores[off]! > best + SPLIT_TIE_DELTA) off = scores.indexOf(best);
  return axis === "x" ? { ...crop, x: sourceBox.x + off } : { ...crop, y: sourceBox.y + off };
}

export async function buildContext(subject: OutputSubject): Promise<OutputContext | null> {
  const spec = channel(subject.channel), canvas = await decodeRaster(subject.jpeg);
  const geometry = shotGeometry(subject.alpha, subject.source.w, subject.source.h, { rgb: subject.source.rgb });
  if (!geometry) return null;
  const { box: sourceBox, cut } = geometry;
  const productBox = productBoxOf(subject.channel, subject.placement, sourceBox, cut);
  const safeBox = safeBoxFor(spec, canvas, sourceBox.w > sourceBox.h, cut);
  let sourceCrop = expectedSourceCrop(sourceBox, subject.placement.scale, safeBox, cut);
  if (cut.left && cut.right) sourceCrop = matchCropSplit(canvas, subject.source, sourceBox, sourceCrop, productBox, "x");
  if (cut.top && cut.bottom) sourceCrop = matchCropSplit(canvas, subject.source, sourceBox, sourceCrop, productBox, "y");
  const expectedAlpha = await projectAlpha(subject.alpha, subject.source, sourceCrop, productBox, canvas);
  const sourceRgb = await projectRgb(subject.source, sourceCrop, productBox);
  return {
    subject, spec, canvas, background: hexColor(backgroundFor(subject.channel, subject.n)), sourceBox, sourceCrop, productBox,
    safeBox, band: shadowBand(productBox, canvas), expectedAlpha, sourceRgb,
    product: thresholdMask(expectedAlpha, ALPHA_EDGE), half: thresholdMask(expectedAlpha, ALPHA_HALF - 1), shadowAllowed: shadowAllowedFor(subject.productType, subject.flags),
    cutSides: placedCutSides(subject.alpha, subject.source, sourceBox, sourceCrop, cut), cut,
  };
}
