// Builds the per-output context the image checkers share: the decoded canvas, the alpha the output
// should carry (the matte projected the way the render projects it) and the boxes of spec 05.
import { backgroundFor, channel, type ChannelSpec } from "../channels";
import { hexColor, safeBoxFor, shotGeometry, type BBox, type CutEdges } from "../render";
import { decodeRaster, productBoxOf, projectAlpha, shadowBand, thresholdMask, type Mask } from "./image";
import type { OutputSubject, Raster } from "./types";

/** Alpha at or below this level is edge antialiasing (spec 05 ALPHA_BBOX_THRESHOLD). */
export const ALPHA_EDGE = 10;

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
  /** Whether the channel allows a shadow for this product type (spec 05: footwear, bags, other). */
  shadowAllowed: boolean;
  /** Sides of the source frame the product is cut at (the render's own shotGeometry rule). */
  cutSides: ("top" | "bottom" | "left" | "right")[];
  cut: CutEdges;
}

export const SHADOW_TYPES = new Set(["footwear", "bag_accessory", "other", "auto"]);

/** Source pixels the recorded scale leaves no room for on one axis of the safe box (0 when the product fits). */
export function overflowPx(length: number, scale: number, room: number): number {
  return Math.max(0, length - Math.max(1, Math.min(length, Math.round(room / scale))));
}

/**
 * The part of `sourceBox` the output should show, computed from the recorded placement and the spec 05 rule, not
 * from the render's own code: where the product at `scale` overflows an axis of the safe box, the overflow comes
 * off that axis's cut sides (split evenly when both are cut). An axis with no cut side is never trimmed here, so a
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

export async function buildContext(subject: OutputSubject): Promise<OutputContext | null> {
  const spec = channel(subject.channel), canvas = await decodeRaster(subject.jpeg);
  const geometry = shotGeometry(subject.alpha, subject.source.w, subject.source.h, { rgb: subject.source.rgb });
  if (!geometry) return null;
  const { box: sourceBox, cut } = geometry;
  const productBox = productBoxOf(subject.channel, subject.placement, sourceBox, cut);
  const safeBox = safeBoxFor(spec, canvas, sourceBox.w > sourceBox.h, cut), sourceCrop = expectedSourceCrop(sourceBox, subject.placement.scale, safeBox, cut);
  const expectedAlpha = await projectAlpha(subject.alpha, subject.source, sourceCrop, productBox, canvas);
  return {
    subject, spec, canvas, background: hexColor(backgroundFor(subject.channel, subject.n)), sourceBox, sourceCrop, productBox,
    safeBox, band: shadowBand(productBox, canvas), expectedAlpha,
    product: thresholdMask(expectedAlpha, ALPHA_EDGE), shadowAllowed: SHADOW_TYPES.has(subject.productType),
    cutSides: (["top", "bottom", "left", "right"] as const).filter(side => cut[side]), cut,
  };
}
