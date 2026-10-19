// Builds the per-output context the image checkers share: the decoded canvas, the alpha the output
// should carry (the matte projected the way the render projects it) and the boxes of spec 05.
import { backgroundFor, channel, type ChannelSpec } from "../channels";
import { bbox, hexColor, safeBoxFor, type BBox } from "../render";
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
  /** Sides of the source frame the product touches (a source cut at that edge). */
  cutSides: ("top" | "bottom" | "left" | "right")[];
}

export const SHADOW_TYPES = new Set(["footwear", "bag_accessory", "other", "auto"]);
/** A side counts as cut when at least this share of its edge pixels carries product. */
export const CUT_EDGE_SHARE = 0.02;

export function cutSidesOf(alpha: Buffer, w: number, h: number): OutputContext["cutSides"] {
  const count = (pixels: number[]) => pixels.filter(i => alpha[i]! > ALPHA_EDGE).length;
  const xs = [...Array(w).keys()], ys = [...Array(h).keys()];
  const sides: OutputContext["cutSides"] = [];
  if (count(xs.map(x => x)) >= w * CUT_EDGE_SHARE) sides.push("top");
  if (count(xs.map(x => (h - 1) * w + x)) >= w * CUT_EDGE_SHARE) sides.push("bottom");
  if (count(ys.map(y => y * w)) >= h * CUT_EDGE_SHARE) sides.push("left");
  if (count(ys.map(y => y * w + w - 1)) >= h * CUT_EDGE_SHARE) sides.push("right");
  return sides;
}

export async function buildContext(subject: OutputSubject): Promise<OutputContext | null> {
  const spec = channel(subject.channel), canvas = await decodeRaster(subject.jpeg);
  const sourceBox = bbox(subject.alpha, subject.source.w, subject.source.h);
  if (!sourceBox) return null;
  const productBox = productBoxOf(subject.channel, subject.placement, sourceBox);
  const expectedAlpha = await projectAlpha(subject.alpha, subject.source, sourceBox, productBox, canvas);
  return {
    subject, spec, canvas, background: hexColor(backgroundFor(subject.channel, subject.n)), sourceBox, productBox,
    safeBox: safeBoxFor(spec, canvas, sourceBox.w > sourceBox.h), band: shadowBand(productBox, canvas), expectedAlpha,
    product: thresholdMask(expectedAlpha, ALPHA_EDGE), shadowAllowed: SHADOW_TYPES.has(subject.productType),
    cutSides: cutSidesOf(subject.alpha, subject.source.w, subject.source.h),
  };
}
