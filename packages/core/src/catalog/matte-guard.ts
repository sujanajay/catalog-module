// Cut-out integrity guard (runtime). A salient-object matting model treats a frame-filling texture
// (leather grain, knit, a lace trim on fabric) as background and keeps only the logo, label or clasp
// on it. This module checks every model matte against an independent estimate of the product taken
// from the source's own pixels, before anything is rendered, and supplies the last resort of the
// resolution ladder: a pass-through matte that keeps the whole frame. It also recognises size charts
// and other text-only images (left out with a note) and a product held by a hand (no contact shadow).
//
// Plain-language terms. Border band: the outer 2% of the photo (the band prepare() analyses). Smooth:
// a pixel whose right and lower neighbours differ from it by little (a studio background is smooth;
// leather grain, knit and lace are not). Product estimate: the pixels that are clearly not the
// background colour. Frame-filling: the border band holds (almost) no smooth background, so the
// product runs off every side of the photo and the whole frame is product.
import { components, delta, dilate, erode, thresholdMask, type Mask } from "./evals/image";
import { estimateForeground, SHADOW_ZONE_CHROMA_MAX } from "./evals/cutout";
import { borderBand } from "./shadow";
import { PASSTHROUGH_MODEL, type Matte, type Prepared } from "./render";
import type { OutputFlag } from "./types";
import type { AutoAction } from "./auto-resolve";

/** A border pixel is smooth background when its right and lower neighbours differ by at most this per channel. */
export const SMOOTH_NEIGHBOUR_DELTA = 6;
/** A smooth border pixel belongs to the background cluster when it is this close (per channel) to the cluster colour. */
export const BACKGROUND_CLUSTER_DELTA = 16;
/** Below this share of smooth background in the border band the photo is frame-filling: every pixel is product. */
export const FRAME_FILLING_BORDER_SHARE = 0.1;
/** Matte alpha at or below this is "dropped" (the spec 10 ALPHA_EDGE). */
export const GUARD_ALPHA_EDGE = 10;
/** Lost pixels count only this far inside the product estimate (its interior). */
export const GUARD_INTERIOR_PX = 3;
/** Grid over the estimate's bounding box, as in spec 10 `cutout.pixels_lost`. */
export const GUARD_GRID = 6;
/** A grid cell needs this many estimated product pixels to be measured. */
export const GUARD_CELL_MIN_PIXELS = 400;
/**
 * Runtime bars. Spec 10 grades a golden matte at 1% per cell and 0.3% overall; a runtime guard
 * only has to catch a matte that removes product, so its bars sit well above the soft-edge and
 * JPEG noise of a good 1024 px matte (measured: under 4% worst cell and 1% overall on the passing
 * shoes, models and flat lays) and far below what a destroyed close-up loses (over 40% overall).
 */
export const GUARD_CELL_LOSS_MAX = 0.2;
export const GUARD_OVERALL_LOSS_MAX = 0.04;
/**
 * A strongly coloured product pixel: its chroma (max minus min channel) is at least the most a cast
 * shadow may carry in the estimate (spec 10 SHADOW_ZONE_CHROMA_MAX), so it is neither the white or grey
 * backdrop nor the source's own shadow. When the matte drops it more than GUARD_COLOURED_KEPT_GAP_PX
 * away from what it kept, it counts as lost even inside the GUARD_INTERIOR_PX edge band: a thin
 * coloured part (a midsole sliver along a dark outsole, a piping) is all edge band, so the interior
 * rule alone never sees it go. Measured on 129 real photos (258 first mattes): the most a good matte
 * loses this way is 10.7% of a cell; the Anta sole view bd-112625546-12 shot 5 loses 41%.
 */
export const GUARD_COLOURED_CHROMA_MIN = SHADOW_ZONE_CHROMA_MAX;
export const GUARD_COLOURED_KEPT_GAP_PX = 1;
/** A hand dropped by the matte (skin touching the frame edge, next to the product) larger than this share of the kept product rejects the matte. */
export const HAND_NOTCH_MAX_SHARE = 0.02;
/** Skin must differ from the source background by this much (a beige wall is not a hand). */
export const SKIN_MIN_BACKGROUND_DELTA = 30;
/** Smallest dropped skin region that counts as a hand, as a share of the frame. */
export const HAND_MIN_FRAME_SHARE = 0.002;
/** Pass-through keeps every component at least this share of the largest one (a pair, not a speck). */
export const PASSTHROUGH_KEEP_SHARE = 0.25;
/**
 * A kept background chunk: a connected region the matte keeps (alpha over 128) whose source pixels are the plain
 * backdrop colour itself (within KEPT_BACKGROUND_DELTA per channel of the border colour, so a white or pale product
 * part with any shading of its own does not count), that touches what the matte dropped (within
 * KEPT_BACKGROUND_TOUCH_PX: it hangs off the silhouette, it is not a label inside it) and lies wholly in the lower half
 * of the kept product (below a base, where a model mistakes the backdrop for a plinth or a reflection; a halo ring
 * around the whole silhouette is the judge's `halo`, not this). It rejects the
 * matte when it covers more than KEPT_BACKGROUND_FRAME_SHARE of the frame and more than KEPT_BACKGROUND_KEPT_SHARE of
 * the kept product. Measured on 593 deployed mattes of the gate 3e, Anta and French Connection golden photos: the
 * French Connection candle Z15276411CE85C2E728DEZ shot 4 (padded birefnet-general) keeps 2.0% of the frame and 4.2%
 * of the product; next come a dark fabric close-up (bd-152637502S-3 shot 5: 1.2% of the frame, 1.2% of the product)
 * and two size charts (left out before matting); every other matte keeps under 0.1% of the frame.
 */
export const KEPT_BACKGROUND_DELTA = 6;
export const KEPT_BACKGROUND_TOUCH_PX = 4;
export const KEPT_BACKGROUND_FRAME_SHARE = 0.003;
export const KEPT_BACKGROUND_KEPT_SHARE = 0.02;
/** A kept chunk counts only when its top row is at least this far down the kept product's height (0 top, 1 bottom). */
export const KEPT_BACKGROUND_MIN_DEPTH = 0.5;

export interface BorderBackground {
  /** Median colour of the smooth border pixels (all border pixels when none is smooth). */
  color: [number, number, number];
  /** Share of the border band that is smooth and within BACKGROUND_CLUSTER_DELTA of `color`. */
  share: number;
  /** True when `share` is under FRAME_FILLING_BORDER_SHARE: the whole frame is product. */
  frameFilling: boolean;
}

function smoothAt(rgb: Buffer, w: number, h: number, x: number, y: number): boolean {
  const i = (y * w + x) * 3;
  for (const j of [x + 1 < w ? i + 3 : i - 3, y + 1 < h ? i + w * 3 : i - w * 3]) for (let c = 0; c < 3; c++) if (Math.abs(rgb[i + c]! - rgb[j + c]!) > SMOOTH_NEIGHBOUR_DELTA) return false;
  return true;
}

/** The source background as the border band shows it: the smooth colour cluster, and how much of the band it covers. */
export function borderBackground(p: Pick<Prepared, "width" | "height" | "rgb">): BorderBackground {
  const { width: w, height: h, rgb } = p, band = borderBand(w, h);
  const all: number[] = [], smooth: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= band.x && x < w - band.x && y >= band.y && y < h - band.y) continue;
    const i = y * w + x; all.push(i);
    if (smoothAt(rgb, w, h, x, y)) smooth.push(i);
  }
  const pool = smooth.length ? smooth : all;
  const color = [0, 1, 2].map(c => { const hist = new Uint32Array(256); for (const i of pool) hist[rgb[i * 3 + c]!]!++; let seen = 0; for (let v = 0; v < 256; v++) { seen += hist[v]!; if (seen * 2 >= pool.length) return v; } return 255; }) as [number, number, number];
  let near = 0;
  for (const i of smooth) if (delta(rgb, i, color) <= BACKGROUND_CLUSTER_DELTA) near++;
  const share = all.length ? near / all.length : 0;
  return { color, share, frameFilling: share < FRAME_FILLING_BORDER_SHARE };
}

/** A pixel is smooth when, in the 5x5 window around it, no channel varies by more than this (walls with fine grain, floors, shadows; not leather grain, knit or lace). Measured on 82 photos: 10 and 14 left grainy studio walls as product, 24 started to absorb smooth fabric into the background. */
export const SMOOTH_WINDOW_RANGE = 18;
/** A border row or column is part of a uniform strip (a photo pasted on a plain canvas) when this share of it is the border colour. */
export const STRIP_ROW_SHARE = 0.97;
/** A strip is at most this share of the frame side. */
export const STRIP_MAX_SHARE = 0.25;
/** Smooth pixels whose 8-level colour bucket holds at least this share of the connected background are background too (wall seen between an arm and the body). */
export const BACKGROUND_BUCKET_MIN_SHARE = 0.002;

/** Per pixel: the largest per-channel range over its 5x5 window. */
function windowRange(rgb: Buffer, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h), mx = new Uint8Array(w * h), mn = new Uint8Array(w * h);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hi = 0, lo = 255;
      for (let k = Math.max(0, x - 2); k <= Math.min(w - 1, x + 2); k++) { const v = rgb[(y * w + k) * 3 + c]!; if (v > hi) hi = v; if (v < lo) lo = v; }
      mx[y * w + x] = hi; mn[y * w + x] = lo;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hi = 0, lo = 255;
      for (let k = Math.max(0, y - 2); k <= Math.min(h - 1, y + 2); k++) { const i = k * w + x; if (mx[i]! > hi) hi = mx[i]!; if (mn[i]! < lo) lo = mn[i]!; }
      const i = y * w + x; if (hi - lo > out[i]!) out[i] = hi - lo;
    }
  }
  return out;
}

export interface BackgroundRegion {
  /** 1 where the source shows background: uniform canvas strips, and smooth regions reached from the photo's border band. */
  background: Mask;
  /** The photo inside any uniform canvas strips. */
  rect: { x0: number; y0: number; x1: number; y1: number };
  /** Share of the photo's border band that is smooth (background seeds). */
  seedShare: number;
  /** True when that share is under FRAME_FILLING_BORDER_SHARE: everything inside the strips is product. */
  frameFilling: boolean;
}

/**
 * Where the source shows background. A brand often pastes a studio photo onto a plain canvas, so
 * uniform strips of the border colour are trimmed first; then every smooth region (5x5 range at most
 * SMOOTH_WINDOW_RANGE) connected to the photo's own border band is background, including a wall that
 * differs from the canvas, the floor and the cast shadow; and smooth pixels in the colours that
 * background holds (wall seen through a gap between arm and body). Texture (leather grain, knit,
 * lace, embroidery) is never smooth, so a close-up that runs off every side is frame-filling.
 */
export function backgroundRegion(p: Pick<Prepared, "width" | "height" | "rgb">): BackgroundRegion {
  const { width: w, height: h, rgb } = p, border = borderBackground(p), bg = new Uint8Array(w * h);
  const near = (i: number) => delta(rgb, i, border.color) <= BACKGROUND_CLUSTER_DELTA;
  const rowShare = (y: number, x0: number, x1: number) => { let n = 0; for (let x = x0; x <= x1; x++) if (near(y * w + x)) n++; return n / (x1 - x0 + 1); };
  const colShare = (x: number, y0: number, y1: number) => { let n = 0; for (let y = y0; y <= y1; y++) if (near(y * w + x)) n++; return n / (y1 - y0 + 1); };
  let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
  while (y0 < h * STRIP_MAX_SHARE && rowShare(y0, x0, x1) >= STRIP_ROW_SHARE) y0++;
  while (h - 1 - y1 < h * STRIP_MAX_SHARE && y1 > y0 && rowShare(y1, x0, x1) >= STRIP_ROW_SHARE) y1--;
  while (x0 < w * STRIP_MAX_SHARE && colShare(x0, y0, y1) >= STRIP_ROW_SHARE) x0++;
  while (w - 1 - x1 < w * STRIP_MAX_SHARE && x1 > x0 && colShare(x1, y0, y1) >= STRIP_ROW_SHARE) x1--;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x > x1 || y < y0 || y > y1) bg[y * w + x] = 1;
  const range = windowRange(rgb, w, h), smooth = (i: number) => range[i]! <= SMOOTH_WINDOW_RANGE;
  const band = borderBand(x1 - x0 + 1, y1 - y0 + 1), queue = new Int32Array(w * h);
  let head = 0, tail = 0, bandPixels = 0, seeds = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x >= x0 + band.x && x <= x1 - band.x && y >= y0 + band.y && y <= y1 - band.y) continue;
    const i = y * w + x; bandPixels++;
    if (smooth(i)) { seeds++; bg[i] = 1; queue[tail++] = i; }
  }
  const seedShare = bandPixels ? seeds / bandPixels : 0, rect = { x0, y0, x1, y1 };
  if (seedShare < FRAME_FILLING_BORDER_SHARE) {
    for (let y = y0; y <= y1; y++) bg.fill(0, y * w + x0, y * w + x1 + 1);
    return { background: bg, rect, seedShare, frameFilling: true };
  }
  while (head < tail) {
    const i = queue[head++]!, x = i % w, y = (i - x) / w;
    for (const j of [x > x0 ? i - 1 : -1, x < x1 ? i + 1 : -1, y > y0 ? i - w : -1, y < y1 ? i + w : -1]) if (j >= 0 && !bg[j] && smooth(j)) { bg[j] = 1; queue[tail++] = j; }
  }
  // Smooth pixels in the background's own colours (8-level buckets) are background too.
  const buckets = new Uint32Array(32 * 32 * 32), key = (i: number) => (rgb[i * 3]! >> 3) * 1024 + (rgb[i * 3 + 1]! >> 3) * 32 + (rgb[i * 3 + 2]! >> 3);
  for (let i = 0; i < tail; i++) buckets[key(queue[i]!)]!++;
  const min = Math.max(20, tail * BACKGROUND_BUCKET_MIN_SHARE);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (!bg[i] && smooth(i) && buckets[key(i)]! >= min) bg[i] = 1; }
  return { background: bg, rect, seedShare, frameFilling: false };
}

/**
 * Pixels that are product by the source's own pixels: the spec 10 colour estimate (far from the
 * border colour, minus the source's own cast shadow where the matte drops it) without the smooth
 * background region grown by 2 px (the smoothness window straddles the silhouette there). A
 * frame-filling photo is product everywhere inside its canvas strips.
 */
export function productEstimate(p: Pick<Prepared, "width" | "height" | "rgb">, alpha: Buffer, region: BackgroundRegion = backgroundRegion(p)): Mask {
  const { width: w, height: h } = p, out = new Uint8Array(w * h);
  if (region.frameFilling) { for (let i = 0; i < out.length; i++) out[i] = region.background[i] ? 0 : 1; return out; }
  let y0 = h, y1 = -1;
  for (let i = 0; i < alpha.length; i++) if (alpha[i]! > GUARD_ALPHA_EDGE) { const y = (i - (i % w)) / w; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const box = y1 < 0 ? { y: 0, h } : { y: y0, h: y1 - y0 + 1 };
  const colour = estimateForeground({ identifier: "", n: 0, source: { w, h, rgb: p.rgb }, sourceBackground: { uniform: true, color: borderBackground(p).color }, alpha }, box).mask;
  const grown = dilate(region.background, w, h, 2);
  for (let i = 0; i < out.length; i++) out[i] = colour[i] && !grown[i] ? 1 : 0;
  return out;
}

const isSkin = (r: number, g: number, b: number) => r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && r - g > 15 && r - g < 110 && b > 0.45 * g;

/**
 * A smooth region reached from the border is a background candidate (studio wall, floor), but in a
 * close-up it can be the model's skin next to a trim or neckline. When a model matte keeps at least
 * SURFACE_KEPT_MIN of such a region and both the kept and the dropped part are skin (skin colour, not
 * the source background colour), the matte cut through one uniform skin surface with no edge in the
 * source to cut along: a jagged partial. The whole region is then product and must be kept.
 * Measured on 189 photos: without the skin condition a white product on a white backdrop, or a
 * beige cardigan on a light wall, joins the backdrop in one smooth region and would be rejected.
 *
 * The same holds for a plain garment panel (a smooth fabric beside a trim, running off the frame
 * edge): a region the matte keeps at least SURFACE_KEPT_MIN of, whose kept part is not the source
 * background colour and whose dropped part has the kept part's colour (mean within
 * SURFACE_COLOUR_DELTA per channel), is one uniform surface too. A backdrop next to a product of
 * another colour is cut along that colour edge, so its kept and dropped parts differ; a backdrop of
 * the border colour never qualifies.
 */
export const SURFACE_KEPT_MIN = 0.25;
/** Share of the kept part, and of the dropped part, that must be skin. */
export const SURFACE_SKIN_SHARE = 0.6;
/** Only regions at least this share of the photo count (smaller ones are edge noise). */
export const SURFACE_MIN_FRAME_SHARE = 0.01;
/** A non-skin surface: the dropped part's mean colour is within this (per channel) of the kept part's. */
export const SURFACE_COLOUR_DELTA = 24;

/** The skin regions and plain garment panels among the background candidates (inside any canvas strips) that this matte cuts through or keeps (see SURFACE_KEPT_MIN). */
export function keptSurfaces(p: Pick<Prepared, "width" | "height" | "rgb">, alpha: Buffer, region: BackgroundRegion): Mask {
  const { width: w, height: h, rgb } = p, { x0, y0, x1, y1 } = region.rect, inner = new Uint8Array(w * h), out = new Uint8Array(w * h);
  if (region.frameFilling) return out;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (region.background[i]) inner[i] = 1; }
  const border = borderBackground(p).color, { labels, sizes } = components(inner, w, h), n = sizes.length;
  const kept = new Uint32Array(n), keptSkin = new Uint32Array(n), dropped = new Uint32Array(n), droppedSkin = new Uint32Array(n);
  const keptSum = new Float64Array(n * 3), droppedSum = new Float64Array(n * 3);
  for (let i = 0; i < inner.length; i++) {
    const l = labels[i]!; if (!l) continue;
    const skin = delta(rgb, i, border) > SKIN_MIN_BACKGROUND_DELTA && isSkin(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!) ? 1 : 0;
    if (alpha[i]! > 128) { kept[l]!++; keptSkin[l]! += skin; for (let c = 0; c < 3; c++) keptSum[l * 3 + c]! += rgb[i * 3 + c]!; }
    else if (alpha[i]! <= GUARD_ALPHA_EDGE) { dropped[l]!++; droppedSkin[l]! += skin; for (let c = 0; c < 3; c++) droppedSum[l * 3 + c]! += rgb[i * 3 + c]!; }
  }
  // A plain panel: the kept part is not the background colour and the dropped part (if any) has its colour.
  const panel = (l: number) => {
    const mean = (sum: Float64Array, count: number) => [0, 1, 2].map(c => sum[l * 3 + c]! / count);
    const k = mean(keptSum, kept[l]!), far = Math.max(...k.map((v, c) => Math.abs(v - border[c]!))) > SKIN_MIN_BACKGROUND_DELTA;
    if (!far || !dropped[l]) return far;
    const d = mean(droppedSum, dropped[l]!);
    return Math.max(...k.map((v, c) => Math.abs(v - d[c]!))) <= SURFACE_COLOUR_DELTA;
  };
  const min = w * h * SURFACE_MIN_FRAME_SHARE, surface = new Uint8Array(n);
  for (let l = 1; l < n; l++) {
    if (sizes[l]! < min || kept[l]! < sizes[l]! * SURFACE_KEPT_MIN) continue;
    const skin = keptSkin[l]! >= kept[l]! * SURFACE_SKIN_SHARE && droppedSkin[l]! >= dropped[l]! * SURFACE_SKIN_SHARE;
    surface[l] = skin || panel(l) ? 1 : 0;
  }
  for (let i = 0; i < inner.length; i++) if (surface[labels[i]!]) out[i] = 1;
  return out;
}

export interface HeldInHand {
  /** A hand or arm (skin touching the frame edge) holds the product: it does not rest on a floor. */
  held: boolean;
  /** The part of that hand the matte dropped, as a share of the kept product (the notch it leaves). */
  droppedShare: number;
}
/**
 * A hand or arm holding the product: a skin-coloured region, not the source background colour, that
 * reaches the border band (the frame edge, or the thin canvas strip a brand leaves) and borders the kept, non-skin product. The matte may keep it (the hand
 * stays in the picture) or drop it (a notch where the fingers were). Either way the product does not
 * rest on a floor, so it never gets a synthesised contact shadow.
 */
export function heldInHand(p: Pick<Prepared, "width" | "height" | "rgb">, alpha: Buffer): HeldInHand {
  const { width: w, height: h, rgb } = p, border = borderBackground(p).color, skin = new Uint8Array(w * h), band = borderBand(w, h);
  let kept = 0;
  for (let i = 0; i < skin.length; i++) {
    if (alpha[i]! > 128) kept++;
    if (delta(rgb, i, border) > SKIN_MIN_BACKGROUND_DELTA && isSkin(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!)) skin[i] = 1;
  }
  const { labels, sizes } = components(skin, w, h), touchesEdge = new Uint8Array(sizes.length), touchesProduct = new Uint8Array(sizes.length), dropped = new Uint32Array(sizes.length);
  for (let i = 0; i < skin.length; i++) {
    const l = labels[i]!; if (!l) continue;
    const x = i % w, y = (i - x) / w;
    if (x < band.x || y < band.y || x >= w - band.x || y >= h - band.y) touchesEdge[l] = 1;
    if (alpha[i]! <= GUARD_ALPHA_EDGE) dropped[l]!++;
    for (const j of [x > 2 ? i - 3 : -1, x + 3 < w ? i + 3 : -1, y > 2 ? i - 3 * w : -1, y + 3 < h ? i + 3 * w : -1]) if (j >= 0 && !skin[j] && alpha[j]! > 128) touchesProduct[l] = 1;
  }
  let held = false, lost = 0;
  const min = w * h * HAND_MIN_FRAME_SHARE;
  for (let l = 1; l < sizes.length; l++) if (touchesEdge[l] && touchesProduct[l] && sizes[l]! >= min) { held = true; lost += dropped[l]!; }
  return { held, droppedShare: kept ? Math.round(lost / kept * 1e4) / 1e4 : 0 };
}

/**
 * The largest kept background chunk (see KEPT_BACKGROUND_DELTA) as a share of the frame and of the kept product.
 * A frame-filling photo has no backdrop to keep, so it reports 0.
 */
export function keptBackground(p: Pick<Prepared, "width" | "height" | "rgb">, alpha: Buffer, region: BackgroundRegion): { frameShare: number; keptShare: number } {
  const none = { frameShare: 0, keptShare: 0 };
  if (region.frameFilling) return none;
  const { width: w, height: h, rgb } = p, color = borderBackground(p).color, chunk = new Uint8Array(w * h), dropped = new Uint8Array(w * h);
  let kept = 0, y0 = h, y1 = -1;
  for (let i = 0; i < chunk.length; i++) {
    if (alpha[i]! <= GUARD_ALPHA_EDGE) { dropped[i] = 1; continue; }
    if (alpha[i]! <= 128) continue;
    const y = (i - (i % w)) / w; kept++; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (delta(rgb, i, color) <= KEPT_BACKGROUND_DELTA) chunk[i] = 1;
  }
  if (!kept) return none;
  const near = dilate(dropped, w, h, KEPT_BACKGROUND_TOUCH_PX), { labels, sizes } = components(chunk, w, h);
  const touches = new Uint8Array(sizes.length), top = new Int32Array(sizes.length).fill(h);
  for (let i = 0; i < chunk.length; i++) { const l = labels[i]!; if (!l) continue; if (near[i]) touches[l] = 1; const y = (i - (i % w)) / w; if (y < top[l]!) top[l] = y; }
  let largest = 0;
  for (let l = 1; l < sizes.length; l++) if (touches[l] && (top[l]! - y0) / Math.max(1, y1 - y0) >= KEPT_BACKGROUND_MIN_DEPTH) largest = Math.max(largest, sizes[l]!);
  return { frameShare: largest / (w * h), keptShare: largest / kept };
}

export interface MatteIntegrity {
  ok: boolean;
  /** Share of estimated product pixels the matte drops, worst grid cell and overall. */
  worstCellLoss: number; overallLoss: number;
  /** The dropped part of a holding hand, as a share of the kept product (see heldInHand). */
  handShare: number;
  /** The largest kept background chunk, as a share of the frame (see keptBackground). */
  keptBackground: number;
  frameFilling: boolean; borderShare: number; estimatePixels: number;
  /** Short technical note for the auto_actions record and the logs; never shown to operators. */
  detail: string;
}

/**
 * Compares a matte with the product estimate (its interior, plus any strongly coloured part the matte
 * dropped, see GUARD_COLOURED_CHROMA_MIN). Rejects a matte that drops more than
 * GUARD_CELL_LOSS_MAX of any grid cell or GUARD_OVERALL_LOSS_MAX of the whole estimate, or a dropped
 * hand larger than HAND_NOTCH_MAX_SHARE (`handRule`, on unless the product is apparel: a model's own
 * skin is not a hand holding the product). A transparent source's own alpha is always accepted.
 */
export function checkMatteIntegrity(p: Pick<Prepared, "width" | "height" | "rgb">, matte: Pick<Matte, "alpha" | "source">, opts: { handRule?: boolean; region?: BackgroundRegion } = {}): MatteIntegrity {
  const { width: w, height: h } = p, alpha = matte.alpha, region = opts.region ?? backgroundRegion(p);
  const base = { frameFilling: region.frameFilling, borderShare: Math.round(region.seedShare * 1000) / 1000 };
  if (matte.source === "alpha_source") return { ok: true, worstCellLoss: 0, overallLoss: 0, handShare: 0, keptBackground: 0, estimatePixels: 0, ...base, detail: "transparent source" };
  // Only the estimate's interior counts: a matte edge a few pixels inside the silhouette (fur, a soft
  // fabric edge) is a quality question for spec 10, not a lost product.
  // Skin or a plain garment panel the matte cut through (keptSurfaces) is product: all of it counts.
  const product = productEstimate(p, alpha, region), surfaces = keptSurfaces(p, alpha, region);
  for (let i = 0; i < product.length; i++) if (surfaces[i]) product[i] = 1;
  const estimate = erode(product, w, h, GUARD_INTERIOR_PX);
  // A strongly coloured part the matte drops counts in full, edge band included (GUARD_COLOURED_CHROMA_MIN).
  const keptNear = dilate(thresholdMask(alpha, GUARD_ALPHA_EDGE), w, h, GUARD_COLOURED_KEPT_GAP_PX), rgb = p.rgb;
  for (let i = 0; i < estimate.length; i++) {
    if (!product[i] || estimate[i] || keptNear[i]) continue;
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) >= GUARD_COLOURED_CHROMA_MIN) estimate[i] = 1;
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (estimate[y * w + x]) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (!count) return { ok: true, worstCellLoss: 0, overallLoss: 0, handShare: 0, keptBackground: 0, estimatePixels: 0, ...base, detail: "no product estimate" };
  const cellW = (x1 - x0 + 1) / GUARD_GRID, cellH = (y1 - y0 + 1) / GUARD_GRID;
  const total = new Uint32Array(GUARD_GRID * GUARD_GRID), lost = new Uint32Array(GUARD_GRID * GUARD_GRID);
  let lostAll = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x; if (!estimate[i]) continue;
    const cell = Math.min(GUARD_GRID - 1, Math.floor((y - y0) / cellH)) * GUARD_GRID + Math.min(GUARD_GRID - 1, Math.floor((x - x0) / cellW));
    total[cell]!++; if (alpha[i]! <= GUARD_ALPHA_EDGE) { lost[cell]!++; lostAll++; }
  }
  let worst = 0;
  for (let c = 0; c < total.length; c++) if (total[c]! >= GUARD_CELL_MIN_PIXELS) worst = Math.max(worst, lost[c]! / total[c]!);
  const overall = lostAll / count, hand = opts.handRule === false ? 0 : heldInHand(p, alpha).droppedShare;
  const chunk = keptBackground(p, alpha, region), chunkKept = chunk.frameShare > KEPT_BACKGROUND_FRAME_SHARE && chunk.keptShare > KEPT_BACKGROUND_KEPT_SHARE;
  const dropped = worst > GUARD_CELL_LOSS_MAX || overall > GUARD_OVERALL_LOSS_MAX || hand > HAND_NOTCH_MAX_SHARE, ok = !dropped && !chunkKept;
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return { ok, worstCellLoss: round(worst), overallLoss: round(overall), handShare: round(hand), keptBackground: round(chunk.frameShare), estimatePixels: count, ...base,
    detail: `${dropped ? "dropped product" : chunkKept ? "kept background" : "kept"}: worst cell ${(worst * 100).toFixed(1)}%, overall ${(overall * 100).toFixed(1)}%${hand ? `, hand ${(hand * 100).toFixed(1)}%` : ""}${chunk.frameShare ? `, background chunk ${(chunk.frameShare * 100).toFixed(2)}% of the frame` : ""}${region.frameFilling ? ", frame-filling" : ""}` };
}

/**
 * What the pass-through recolours to the channel canvas. Two parts, both reached from the frame edge:
 * (a) the border colour itself, pixel-exact: a flood from the smooth border-colour pixels (and the
 * canvas strips) into every neighbouring pixel within BACKGROUND_CLUSTER_DELTA of the border colour,
 * so it runs right up to the product's edge (no 5x5 smoothness window, so no rim of source white is
 * left on the product) and stops at the first pixel of another colour or shade. A stricter step rule
 * between neighbours was tried and left JPEG ringing along canvas strips as light lines (gate 3e
 * photos). (b) A smooth backdrop of another colour (a studio wall, a floor) that covers at least
 * SURFACE_MIN_FRAME_SHARE of the frame and that no matte kept as skin or a garment panel
 * (keptSurfaces). A smaller smooth region of another colour at the frame edge (a light strap, a sliver
 * of skin below it) cannot be told from product by the source alone, so it stays product: a few
 * plain pixels kept cost less than a flat canvas patch cut into the product (gate 3d, Penti
 * Z91D419FC9238E844BF77Z shot 4).
 */
export function passthroughBackground(p: Pick<Prepared, "width" | "height" | "rgb">, region: BackgroundRegion, surfaces: Mask): Mask {
  const { width: w, height: h, rgb } = p, color = borderBackground(p).color, out = new Uint8Array(w * h), queue = new Int32Array(w * h);
  const near = (i: number) => delta(rgb, i, color) <= BACKGROUND_CLUSTER_DELTA;
  let head = 0, tail = 0;
  for (let i = 0; i < out.length; i++) if (region.background[i] && !surfaces[i] && near(i)) { out[i] = 1; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++]!, x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) {
      if (j >= 0 && !out[j] && !surfaces[j] && near(j)) { out[j] = 1; queue[tail++] = j; }
    }
  }
  // Large smooth backdrops of another colour that no matte kept.
  const { x0, y0, x1, y1 } = region.rect, inner = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (region.background[i] && !surfaces[i]) inner[i] = 1; }
  const { labels, sizes } = components(inner, w, h), min = w * h * SURFACE_MIN_FRAME_SHARE;
  for (let i = 0; i < out.length; i++) if (labels[i] && sizes[labels[i]!]! >= min) out[i] = 1;
  return out;
}

/**
 * The ladder's last resort: the whole frame is product except the source background
 * (passthroughBackground: the border colour reached from the frame edge, pixel-exact, and any large
 * smooth backdrop no matte kept), which becomes 0. Skin or a plain garment panel that one of the
 * `tried` model mattes cut through or kept (keptSurfaces) is always product. Enclosed background is
 * filled (no holes) and components smaller than PASSTHROUGH_KEEP_SHARE of the largest are dropped (no
 * floating fragments); a frame-filling photo keeps every pixel inside its canvas strips. The edge is
 * softened inward only (sigma 1), which cannot open a hole and keeps no source background; a frame
 * edge stays fully opaque so the cut-in-source rule places it flush.
 */
export function passthroughMatte(p: Pick<Prepared, "width" | "height" | "rgb">, tried: Pick<Matte, "alpha">[] = []): Matte {
  const { width: w, height: h } = p, region = backgroundRegion(p), solid = new Uint8Array(w * h);
  if (region.frameFilling) for (let i = 0; i < solid.length; i++) solid[i] = region.background[i] ? 0 : 1;
  else {
    const surfaces = new Uint8Array(w * h);
    for (const m of tried) { const kept = keptSurfaces(p, m.alpha, region); for (let i = 0; i < surfaces.length; i++) if (kept[i]) surfaces[i] = 1; }
    const background = passthroughBackground(p, region, surfaces);
    for (let i = 0; i < solid.length; i++) solid[i] = background[i] ? 0 : 1;
    // Keep the large product components only (no floating fragments).
    const { labels, sizes } = components(solid, w, h), largest = Math.max(0, ...sizes.slice(1));
    for (let i = 0; i < solid.length; i++) if (solid[i] && sizes[labels[i]!]! < largest * PASSTHROUGH_KEEP_SHARE) solid[i] = 0;
    // Fill holes: background not connected to the frame edge through background becomes product.
    const outside = new Uint8Array(w * h), queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const seed = (i: number) => { if (!solid[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++]!, x = i % w, y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) if (j >= 0) seed(j);
    }
    for (let i = 0; i < solid.length; i++) if (!outside[i]) solid[i] = 1;
  }
  const alpha = softenEdge(solid, w, h);
  return { alpha, width: w, height: h, model: PASSTHROUGH_MODEL, ms: 0, source: "model", target: null, sentLongSide: null };
}

/**
 * A pass-through replaces a plain studio backdrop only. In the border band, the pixels it keeps as product
 * although every model matte tried dropped them, and that are no skin or garment panel a matte cut through
 * (keptSurfaces), are what the recolour could not reach. Above this share of the band they are read
 * (busyBorderReading): when they look like scenery the background is busy and the photo is held instead of
 * published with a ragged cut-out. Measured: the French Connection tennis-court photo ZEE79259BBFD83FFA1DB0Z
 * shot 5 keeps 33% of its band this way; every plain-backdrop pass-through of the gate and golden sets keeps 0%.
 */
export const BUSY_BORDER_MAX_SHARE = 0.05;
/** An edge pixel: its luma differs from its neighbours by more than this per pixel (central difference, halved). */
export const BUSY_EDGE_GRADIENT = 20;
/** Tones: the fewest 16-level RGB colour buckets that hold this share of the pixels. */
export const BUSY_TONES_COVER = 0.9;
/**
 * Scenery, told from the product by the band pixels themselves. A scene shows strong structure (a net, a
 * racket, a hedge, people: edge density at least BUSY_EDGE_DENSITY_MIN, or at least BUSY_TONES_MIN tones), or a
 * plain area in several tones (a wall and a table: edge density under BUSY_PLAIN_EDGE_MAX and at least
 * BUSY_PLAIN_TONES_MIN tones). Anything else is one material or one plain colour: product every matte dropped,
 * or a plain backdrop the pass-through keeps whole, never scenery. That is the fine grain of a frame-filling
 * close-up whose mattes dropped the leather, knit or zip itself (its out-of-focus leather reads as smooth, so it
 * misses FRAME_FILLING_BORDER_SHARE), or a plain one-colour dress behind a held bag. Measured on the gate 3f
 * holds and the golden busy cases (edge density / tones): tennis court ZEE79259BBFD83FFA1DB0Z shot 5 0.51 / 55
 * to 60 (busy); lifestyle candle Z011CB57531CA8FA0CBDDZ shot 1 0.00 to 0.01 / 11 to 31 (busy, plain in several
 * tones); bag close-ups Z02B2EE44E3A08044B816Z shots 3 and 6 0.25 / 24 and 0.20 / 30 and Z5A0B7DE13FC67EDEAC9DZ
 * shot 5 0.13 / 9 (one material); the bag held against a plain dress, Z02B2EE44E3A08044B816Z shot 1, 0.00 / 4
 * (one plain colour).
 */
export const BUSY_EDGE_DENSITY_MIN = 0.4;
export const BUSY_TONES_MIN = 45;
export const BUSY_PLAIN_EDGE_MAX = 0.05;
export const BUSY_PLAIN_TONES_MIN = 8;

export interface BusyBorderReading {
  /** Share of the border band the pass-through keeps and every matte dropped (no skin, no garment panel). */
  share: number;
  /** Of those pixels: the share that are edges (BUSY_EDGE_GRADIENT), and their tones (BUSY_TONES_COVER). */
  edgeDensity: number; tones: number;
  /** True when those pixels look like scenery (BUSY_EDGE_DENSITY_MIN, BUSY_TONES_MIN, BUSY_PLAIN_*). */
  scenery: boolean;
}

/** The border band pixels the pass-through `pass` keeps although every matte tried dropped them, and what they look like (see BUSY_EDGE_DENSITY_MIN). */
export function busyBorderReading(p: Pick<Prepared, "width" | "height" | "rgb">, pass: Pick<Matte, "alpha">, tried: readonly Pick<Matte, "alpha">[], region: BackgroundRegion = backgroundRegion(p)): BusyBorderReading {
  const none = { share: 0, edgeDensity: 0, tones: 0, scenery: false };
  if (!tried.length) return none;
  const { width: w, height: h, rgb } = p, band = borderBand(w, h), surfaces = new Uint8Array(w * h);
  for (const m of tried) { const kept = keptSurfaces(p, m.alpha, region); for (let i = 0; i < surfaces.length; i++) if (kept[i]) surfaces[i] = 1; }
  const luma = (i: number) => 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
  const buckets = new Map<number, number>();
  let pixels = 0, kept = 0, edges = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= band.x && x < w - band.x && y >= band.y && y < h - band.y) continue;
    const i = y * w + x; pixels++;
    if (!(pass.alpha[i]! > 0 && !surfaces[i] && tried.every(m => m.alpha[i]! <= GUARD_ALPHA_EDGE))) continue;
    kept++;
    const gx = luma(y * w + Math.min(w - 1, x + 1)) - luma(y * w + Math.max(0, x - 1)), gy = luma(Math.min(h - 1, y + 1) * w + x) - luma(Math.max(0, y - 1) * w + x);
    if (Math.hypot(gx, gy) / 2 > BUSY_EDGE_GRADIENT) edges++;
    const key = (rgb[i * 3]! >> 4) * 256 + (rgb[i * 3 + 1]! >> 4) * 16 + (rgb[i * 3 + 2]! >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (!kept) return none;
  let tones = 0, covered = 0;
  for (const count of [...buckets.values()].sort((a, b) => b - a)) { if (covered >= kept * BUSY_TONES_COVER) break; covered += count; tones++; }
  const edgeDensity = edges / kept;
  return { share: kept / pixels, edgeDensity, tones, scenery: readsAsScenery(edgeDensity, tones) };
}

/** Band pixels with this edge density and this many tones are scenery (see BUSY_EDGE_DENSITY_MIN); otherwise one material or one plain colour. */
export function readsAsScenery(edgeDensity: number, tones: number): boolean {
  return edgeDensity >= BUSY_EDGE_DENSITY_MIN || tones >= BUSY_TONES_MIN || (edgeDensity < BUSY_PLAIN_EDGE_MAX && tones >= BUSY_PLAIN_TONES_MIN);
}

/** Share of the border band that the pass-through `pass` keeps although every matte tried dropped it (see busyBorderReading). */
export function busyBorderShare(p: Pick<Prepared, "width" | "height" | "rgb">, pass: Pick<Matte, "alpha">, tried: readonly Pick<Matte, "alpha">[], region: BackgroundRegion = backgroundRegion(p)): number {
  return busyBorderReading(p, pass, tried, region).share;
}

/** True when a pass-through would leave scenery: over BUSY_BORDER_MAX_SHARE of the band, read as scenery (busyBorderReading); a frame-filling close-up never is. */
export function isBusyBackground(p: Pick<Prepared, "width" | "height" | "rgb">, pass: Pick<Matte, "alpha">, tried: readonly Pick<Matte, "alpha">[], region: BackgroundRegion = backgroundRegion(p)): boolean {
  if (region.frameFilling) return false;
  const reading = busyBorderReading(p, pass, tried, region);
  return reading.share > BUSY_BORDER_MAX_SHARE && reading.scenery;
}

/**
 * The photo as it is (every pixel opaque) inside the uniform canvas strips a brand pasted it on (backgroundRegion
 * `rect`); the strips are dropped as the pass-through drops them. It is what a busy-background photo shows while it
 * waits for a person and what "Use as is" publishes: fitted on the channel canvas with the band note, never a white
 * frame inside a grey canvas.
 */
export function wholePhotoMatte(p: Pick<Prepared, "width" | "height" | "rgb">, region: BackgroundRegion = backgroundRegion(p)): Matte {
  const { width: w, height: h } = p, { x0, y0, x1, y1 } = region.rect, alpha = Buffer.alloc(w * h);
  for (let y = y0; y <= y1; y++) alpha.fill(255, y * w + x0, y * w + x1 + 1);
  return { alpha, width: w, height: h, model: PASSTHROUGH_MODEL, ms: 0, source: "model", target: null, sentLongSide: null };
}

/** Separable sigma-1 Gaussian on a 0/1 mask (edge pixels replicated), as floodFillMatte does, but only inward: the background around the product stays fully clear, so no source background bleeds onto the canvas. */
function softenEdge(mask: Mask, w: number, h: number): Buffer {
  const weights = [0.004433, 0.054006, 0.242036, 0.39905, 0.242036, 0.054006, 0.004433];
  const temp = new Float32Array(w * h), out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -3; k <= 3; k++) s += mask[y * w + Math.max(0, Math.min(w - 1, x + k))]! * weights[k + 3]!; temp[y * w + x] = s; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -3; k <= 3; k++) s += temp[Math.max(0, Math.min(h - 1, y + k)) * w + x]! * weights[k + 3]!; out[y * w + x] = mask[y * w + x] ? Math.round(Math.min(1, s) * 255) : 0; }
  return out;
}

/** Text-only images (size charts, infographics, banners): many glyph-sized marks on a plain background and no large object. */
export const TEXT_MIN_GLYPHS = 60;
/** A glyph is a mark between these areas (share of the frame) and no taller than TEXT_GLYPH_MAX_HEIGHT of the frame. */
export const TEXT_GLYPH_MIN_PX = 6;
export const TEXT_GLYPH_MAX_SHARE = 0.002;
export const TEXT_GLYPH_MAX_HEIGHT = 0.04;
/** The largest single mark must stay under this share of the frame (a product photo has one large object). */
export const TEXT_LARGEST_MAX_SHARE = 0.06;
/** Glyphs must sit on at least this many distinct text lines (rows of glyphs). */
export const TEXT_MIN_LINES = 6;
/** Ink is a pixel this far (per channel) from the background colour. */
export const TEXT_INK_DELTA = 40;
/** A glyph has a printed core at least this far from the background (lace, prints and white-on-white fragments do not). */
export const TEXT_GLYPH_CORE_DELTA = 100;
/** Text images are mostly plain page: at least this share of the frame is the background colour. */
export const TEXT_MIN_PAGE_SHARE = 0.6;
/**
 * The page is light (luma at least this): charts and infographics are printed on white or a pale
 * tint. A sweep of 5,362 brand photos found every dark-page match to be a frame-filling texture
 * close-up (woven leather, grained leather with a logo, sequins), never text.
 */
export const TEXT_MIN_PAGE_LUMA = 180;

/** Glyph marks must carry at least this share of all ink (in a product photo the product carries almost all of it). */
export const TEXT_MIN_GLYPH_INK_SHARE = 0.3;

export interface TextImage { text: boolean; glyphs: number; lines: number; largestShare: number; glyphInkShare: number; pageShare: number }
/** A size chart, infographic or text banner: a plain background, rows of small marks, nothing large. */
export function detectTextImage(p: Pick<Prepared, "width" | "height" | "rgb">): TextImage {
  const { width: w, height: h, rgb } = p, bg = borderBackground(p);
  const pageLuma = 0.2126 * bg.color[0] + 0.7152 * bg.color[1] + 0.0722 * bg.color[2];
  if (bg.frameFilling || pageLuma < TEXT_MIN_PAGE_LUMA) return { text: false, glyphs: 0, lines: 0, largestShare: 1, glyphInkShare: 0, pageShare: 0 };
  const ink = new Uint8Array(w * h), contrast = new Uint8Array(w * h);
  let page = 0;
  for (let i = 0; i < ink.length; i++) { const d = delta(rgb, i, bg.color); contrast[i] = d; if (d > TEXT_INK_DELTA) ink[i] = 1; else if (d <= BACKGROUND_CLUSTER_DELTA) page++; }
  const pageShare = page / (w * h);
  const { labels, sizes } = components(ink, w, h);
  const top = new Int32Array(sizes.length).fill(h), bottom = new Int32Array(sizes.length).fill(-1), core = new Uint8Array(sizes.length);
  for (let i = 0; i < ink.length; i++) { const l = labels[i]!; if (!l) continue; const y = (i - (i % w)) / w; if (y < top[l]!) top[l] = y; if (y > bottom[l]!) bottom[l] = y; if (contrast[i]! > core[l]!) core[l] = contrast[i]!; }
  const frame = w * h, rows = new Uint8Array(h);
  let glyphs = 0, largest = 0, inkTotal = 0, glyphInk = 0;
  for (let l = 1; l < sizes.length; l++) {
    const size = sizes[l]!; largest = Math.max(largest, size); inkTotal += size;
    if (size < TEXT_GLYPH_MIN_PX || size > frame * TEXT_GLYPH_MAX_SHARE || bottom[l]! - top[l]! + 1 > h * TEXT_GLYPH_MAX_HEIGHT || core[l]! < TEXT_GLYPH_CORE_DELTA) continue;
    glyphs++; glyphInk += size; rows[Math.round((top[l]! + bottom[l]!) / 2)] = 1;
  }
  // A text line is a run of rows holding glyph centres; gaps of a few rows split lines.
  let lines = 0, gap = Infinity;
  const split = Math.max(3, Math.round(h * 0.006));
  for (let y = 0; y < h; y++) { if (rows[y]) { if (gap > split) lines++; gap = 0; } else gap++; }
  const largestShare = largest / frame, glyphInkShare = inkTotal ? glyphInk / inkTotal : 0;
  return { text: glyphs >= TEXT_MIN_GLYPHS && lines >= TEXT_MIN_LINES && largestShare < TEXT_LARGEST_MAX_SHARE && glyphInkShare >= TEXT_MIN_GLYPH_INK_SHARE && pageShare >= TEXT_MIN_PAGE_SHARE,
    glyphs, lines, largestShare: Math.round(largestShare * 1e4) / 1e4, glyphInkShare: Math.round(glyphInkShare * 1000) / 1000, pageShare: Math.round(pageShare * 1000) / 1000 };
}

/**
 * Sole strip recovery (footwear). A thin strongly coloured strip along the bottom of a shoe (a lime midsole
 * sliver between a black outsole and a white floor, 5 to 8 source px) is dropped in part by every deployed model:
 * its lowest one to two rows fall into the model's soft edge or below it. Per column of the lower
 * SOLE_STRIP_ZONE_SHARE of the matte, the run of strongly coloured source pixels (chroma at least
 * SOLE_STRIP_CHROMA_MIN and at least SOLE_STRIP_SATURATION_MIN of the brightest channel) that starts right below
 * the matte's lowest kept pixel (alpha over 128) and ends within SOLE_STRIP_DEPTH_PX of it is a strip candidate.
 * The run must touch the kept matte and stops at the first pixel that is not strongly coloured, so a floor
 * reflection (a pale copy of the sole under a light or grey gap row, eval run 3 M2) or a grey cast shadow is never
 * reached. A connected group of candidates is recovered only when the matte drops (alpha at most GUARD_ALPHA_EDGE)
 * at least SOLE_STRIP_MIN_DROPPED_PX of them and it spans at least SOLE_STRIP_MIN_SPAN_SHARE of the product width
 * (a strip along the sole, not a coloured contact smudge): its runs become opaque, together with the soft kept pixels
 * right above them (now inside the product). The run ends are smoothed across the group's columns (a moving average over
 * SOLE_STRIP_SMOOTH_COLUMNS columns, clamped to each column's measured end so no pixel outside the coloured run is
 * added, then lowered until neighbouring ends differ by at most 1 px) and the lower edge is drawn at that sub-pixel
 * position: opaque above it and one antialiased pixel at it, so the edge shows no steps and is softened once.
 */
export const SOLE_STRIP_DEPTH_PX = 8;
export const SOLE_STRIP_CHROMA_MIN = 60;
export const SOLE_STRIP_SATURATION_MIN = 0.5;
export const SOLE_STRIP_ZONE_SHARE = 0.4;
export const SOLE_STRIP_MIN_DROPPED_PX = 20;
export const SOLE_STRIP_MIN_SPAN_SHARE = 0.1;
export const SOLE_STRIP_SMOOTH_COLUMNS = 5;

export interface SoleStripRecovery { alpha: Buffer; /** Pixels whose alpha was raised. */ changed: number; /** Of those, pixels the matte had dropped. */ recovered: number }

/** The matte with any dropped coloured sole strip given back (see SOLE_STRIP_DEPTH_PX); the input matte is not changed. */
export function recoverSoleStrip(p: Pick<Prepared, "width" | "height" | "rgb">, alphaIn: Buffer): SoleStripRecovery {
  const { width: w, height: h, rgb } = p, alpha = Buffer.from(alphaIn);
  const strong = (i: number) => { const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!, hi = Math.max(r, g, b), c = hi - Math.min(r, g, b); return c >= SOLE_STRIP_CHROMA_MIN && c >= hi * SOLE_STRIP_SATURATION_MIN; };
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let i = 0; i < alpha.length; i++) if (alpha[i]! > 128) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (y1 < 0) return { alpha, changed: 0, recovered: 0 };
  const zoneTop = y1 - (y1 - y0 + 1) * SOLE_STRIP_ZONE_SHARE, run = new Uint8Array(w * h), bottom = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    let yb = -1;
    for (let y = y1; y >= 0; y--) if (alpha[y * w + x]! > 128) { yb = y; break; }
    if (yb < zoneTop) continue;
    bottom[x] = yb;
    for (let y = yb + 1; y < h && y - yb <= SOLE_STRIP_DEPTH_PX && strong(y * w + x); y++) run[y * w + x] = 1;
  }
  const { labels, sizes } = components(run, w, h), dropped = new Uint32Array(sizes.length), left = new Int32Array(sizes.length).fill(w), right = new Int32Array(sizes.length).fill(-1);
  for (let i = 0; i < run.length; i++) {
    const l = labels[i]!; if (!l) continue;
    const x = i % w; if (x < left[l]!) left[l] = x; if (x > right[l]!) right[l] = x;
    if (alpha[i]! <= GUARD_ALPHA_EDGE) dropped[l]!++;
  }
  // A strip runs along the sole: it spans at least SOLE_STRIP_MIN_SPAN_SHARE of the product's width.
  const minSpan = (x1 - x0 + 1) * SOLE_STRIP_MIN_SPAN_SHARE, strip = (l: number) => dropped[l]! >= SOLE_STRIP_MIN_DROPPED_PX && right[l]! - left[l]! + 1 >= minSpan;
  let changed = 0, recovered = 0;
  const raise = (i: number, to: number) => { if (alpha[i]! >= to) return; if (alpha[i]! <= GUARD_ALPHA_EDGE) recovered++; changed++; alpha[i] = to; };
  // Per column of a recovered group: the measured run end (its last coloured row) and the group.
  const group = new Int32Array(w), end = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    const yb = bottom[x]!; if (yb < 0 || !run[(yb + 1) * w + x] || !strip(labels[(yb + 1) * w + x]!)) continue;
    let last = yb + 1;
    while (last + 1 < h && run[(last + 1) * w + x]) last++;
    group[x] = labels[(yb + 1) * w + x]!; end[x] = last;
  }
  // Smooth the ends within each group of neighbouring columns: a moving average over SOLE_STRIP_SMOOTH_COLUMNS, clamped to
  // the column's measured end (never past the coloured strip), then lowered until neighbours differ by at most 1 px.
  const smooth = new Float64Array(w).fill(-1), half = SOLE_STRIP_SMOOTH_COLUMNS >> 1, same = (a: number, b: number) => end[a]! >= 0 && end[b]! >= 0 && group[a] === group[b];
  for (let x = 0; x < w; x++) {
    if (end[x]! < 0) continue;
    let sum = 0, n = 0;
    for (let k = Math.max(0, x - half); k <= Math.min(w - 1, x + half); k++) if (same(k, x)) { sum += end[k]!; n++; }
    smooth[x] = Math.min(end[x]!, sum / n);
  }
  for (let x = 1; x < w; x++) if (same(x, x - 1)) smooth[x] = Math.min(smooth[x]!, smooth[x - 1]! + 1);
  for (let x = w - 2; x >= 0; x--) if (same(x, x + 1)) smooth[x] = Math.min(smooth[x]!, smooth[x + 1]! + 1);
  for (let x = 0; x < w; x++) {
    const yb = bottom[x]!, e = smooth[x]!; if (end[x]! < 0 || e < yb + 1) continue;
    // The kept pixels right above the run now lie inside the product (the strip is below them): opaque too, so the
    // model's soft edge there leaves no see-through line between the outsole and the strip.
    for (let y = yb; y > yb - SOLE_STRIP_DEPTH_PX && y >= 0 && alpha[y * w + x]! > 128 && alpha[y * w + x]! < 255; y--) raise(y * w + x, 255);
    // Coverage of each run pixel by the smoothed edge at e + 1/2: opaque above it, one antialiased pixel at it.
    for (let y = yb + 1; y <= end[x]!; y++) { const a = Math.round(255 * Math.max(0, Math.min(1, e + 0.5 - y))); if (a > GUARD_ALPHA_EDGE) raise(y * w + x, a); }
  }
  return { alpha, changed, recovered };
}

/** White border, as a share of the long side, around the photo for the ladder's padded matte. */
export const GUARD_PAD_FRACTION = 0.2;
/** The model mattes the ladder may ask for: the policy's second model, then the padded frame with the first and the second model. */
export type MatteVariant = "second" | "padded_first" | "padded_second";
export interface ResolveMatteInput {
  prepared: Pick<Prepared, "width" | "height" | "rgb">;
  /** The policy's first matte. Only a model matte is checked (a transparent source and the simple fallback are not). */
  first: Matte;
  /** The hand-notch rule (off for apparel, see checkMatteIntegrity). */
  handRule: boolean;
  /** Footwear: the model matte that wins gets a dropped coloured sole strip back (recoverSoleStrip). */
  soleStrip?: boolean;
  /** Makes one more matte; null when that model is not served, is the same as the first, or this run has no time left. */
  attempt: (variant: MatteVariant) => Promise<Matte | null>;
}
export interface MatteResolution {
  matte: Matte;
  /** True when no model matte kept the product and the whole frame is used (flag `matte_passthrough`). */
  passthrough: boolean;
  /**
   * True when no model matte kept the product and the background is busy (busyBorderShare over
   * BUSY_BORDER_MAX_SHARE): the matte is the whole photo as it is and the photo is held for a person
   * (flag `leftover_background`, code-detected: see auto-resolve.ts busyBackgroundHold), never published on its own.
   */
  busyBackground: boolean;
  /** One record per step taken, for the outputs' `compliance.auto_actions`; empty when the first matte was kept. */
  actions: AutoAction[];
  /** Pixels recoverSoleStrip gave back to the winning model matte (0 when it did not run or found no strip). */
  soleStripRecovered: number;
}

/**
 * The cut-out integrity ladder, run on every model matte before anything is rendered: keep the first
 * matte when it passes checkMatteIntegrity; else (a) the policy's second model, (b) the photo framed
 * in a white border (GUARD_PAD_FRACTION) with the first, then the second model, (c) the pass-through
 * matte (the whole frame minus the plain background). The first matte that passes wins. A pass-through
 * replaces a plain backdrop only: on a busy background (busyBorderShare) the photo is kept whole and held
 * (`busyBackground`). The judge's
 * `product_removed` names the same failure after the render, and its ladder ends in the same
 * pass-through step (auto-resolve.ts). For footwear (`soleStrip`) the winning model matte then gets a dropped
 * coloured sole strip back (recoverSoleStrip); the check itself always sees the model's own matte.
 */
export async function resolveMatte(input: ResolveMatteInput): Promise<MatteResolution> {
  const { prepared: p, first } = input, actions: AutoAction[] = [], trigger: OutputFlag[] = ["product_removed"];
  const record = (step: AutoAction["step"], result: AutoAction["result"], detail: string) => actions.push({ step, trigger: [...trigger], result, channels: [], rejudged: false, detail });
  const won = (matte: Matte): MatteResolution => {
    if (!input.soleStrip) return { matte, passthrough: false, busyBackground: false, actions, soleStripRecovered: 0 };
    const strip = recoverSoleStrip(p, matte.alpha);
    return { matte: strip.changed ? { ...matte, alpha: strip.alpha } : matte, passthrough: false, busyBackground: false, actions, soleStripRecovered: strip.recovered };
  };
  if (first.source !== "model") return { matte: first, passthrough: false, busyBackground: false, actions, soleStripRecovered: 0 };
  // Every matte tried is kept: skin or a panel one of them cut through or kept stays product in the pass-through.
  const region = backgroundRegion(p), tried: Matte[] = [];
  const check = (m: Matte) => { tried.push(m); return checkMatteIntegrity(p, m, { handRule: input.handRule, region }); };
  const verdict = check(first);
  if (verdict.ok) return won(first);
  record("matte_check", "failed", `${first.model}: ${verdict.detail}`);
  const steps: [AutoAction["step"], MatteVariant][] = [["second_matte", "second"], ["padded_matte", "padded_first"], ["padded_matte", "padded_second"]];
  for (const [step, variant] of steps) {
    const matte = await input.attempt(variant);
    if (!matte) { record(step, "skipped", `${variant}: not available`); continue; }
    const result = check(matte);
    record(step, result.ok ? "passed" : "failed", `${matte.model}${variant === "second" ? "" : " padded"}: ${result.detail}`);
    if (result.ok) return won(matte);
  }
  const pass = passthroughMatte(p, tried);
  // What the band pixels no cut-out kept look like (busyBorderReading), recorded so a hold can be read from the report.
  const reading = region.frameFilling ? null : busyBorderReading(p, pass, tried, region);
  const band = reading && reading.share > 0 ? `${(reading.share * 100).toFixed(1)}% of the border band no cut-out kept, edge density ${reading.edgeDensity.toFixed(2)}, ${reading.tones} tones` : "";
  if (reading && reading.share > BUSY_BORDER_MAX_SHARE && reading.scenery) {
    // Trigger `leftover_background`: the code-detected hold (auto-resolve.ts busyBackgroundHold).
    actions.push({ step: "matte_passthrough", trigger: ["product_removed", "leftover_background"], result: "failed", channels: [], rejudged: false, detail: `busy background: ${band}, read as scenery; the whole photo is kept and held` });
    return { matte: wholePhotoMatte(p, region), passthrough: false, busyBackground: true, actions, soleStripRecovered: 0 };
  }
  record("matte_passthrough", "passed", `no cut-out kept the product; the whole frame is used${band ? ` (${band}: one material or one plain colour, not scenery)` : ""}`);
  return { matte: pass, passthrough: true, busyBackground: false, actions, soleStripRecovered: 0 };
}
