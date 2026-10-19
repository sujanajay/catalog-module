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

export async function buildContext(subject: OutputSubject): Promise<OutputContext | null> {
  const spec = channel(subject.channel), canvas = await decodeRaster(subject.jpeg);
  const geometry = shotGeometry(subject.alpha, subject.source.w, subject.source.h);
  if (!geometry) return null;
  const { box: sourceBox, cut } = geometry;
  const productBox = productBoxOf(subject.channel, subject.placement, sourceBox, cut);
  const expectedAlpha = await projectAlpha(subject.alpha, subject.source, sourceBox, productBox, canvas);
  return {
    subject, spec, canvas, background: hexColor(backgroundFor(subject.channel, subject.n)), sourceBox, productBox,
    safeBox: safeBoxFor(spec, canvas, sourceBox.w > sourceBox.h, cut), band: shadowBand(productBox, canvas), expectedAlpha,
    product: thresholdMask(expectedAlpha, ALPHA_EDGE), shadowAllowed: SHADOW_TYPES.has(subject.productType),
    cutSides: (["top", "bottom", "left", "right"] as const).filter(side => cut[side]), cut,
  };
}
