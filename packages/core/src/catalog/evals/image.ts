// Raster helpers shared by the output-quality checkers. Everything works on raw 8-bit buffers so the
// checks are exact, repeatable and independent of the render code they test.
import sharp from "sharp";
import { channel } from "../channels";
import { bbox, NO_CUT, safeBoxFor, type BBox, type CutEdges } from "../render";
import { SHADOW_BAND_ABOVE, SHADOW_BAND_BELOW, SHADOW_BAND_SIDE, SHADOW_PRESET } from "../shadow";
import type { ChannelId } from "../types";
import type { OutputPlacement, Raster } from "./types";

export type Mask = Uint8Array;

/** Decodes any image to sRGB RGB without alpha. */
export async function decodeRaster(bytes: Buffer): Promise<Raster> {
  const { data, info } = await sharp(bytes).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, rgb: data };
}

/** Largest per-channel distance between a pixel and a colour. */
export function delta(rgb: Buffer, i: number, color: readonly [number, number, number]): number {
  const o = i * 3;
  return Math.max(Math.abs(rgb[o]! - color[0]), Math.abs(rgb[o + 1]! - color[1]), Math.abs(rgb[o + 2]! - color[2]));
}
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const lumaAt = (rgb: Buffer, i: number) => luma(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!);

/** Median colour of the outer 2% border band (the same band prepare() analyses). */
export function borderMedian(r: Raster): [number, number, number] {
  const bx = Math.max(4, Math.ceil(r.w * 0.02)), by = Math.max(4, Math.ceil(r.h * 0.02));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    if (x >= bx && x < r.w - bx && y >= by && y < r.h - by) continue;
    count++;
    for (let c = 0; c < 3; c++) { const v = r.rgb[(y * r.w + x) * 3 + c]!; hist[c]![v] = hist[c]![v]! + 1; }
  }
  return hist.map(h => { let seen = 0; for (let v = 0; v < 256; v++) { seen += h[v]!; if (seen * 2 >= count) return v; } return 255; }) as [number, number, number];
}

/** The product box the render used: the matte bbox scaled by the recorded scale, clamped to the safe box. */
export function productBoxOf(id: ChannelId, placement: OutputPlacement, sourceBox: BBox, cut: CutEdges = NO_CUT): BBox {
  const spec = channel(id), safe = safeBoxFor(spec, { w: placement.w, h: placement.h }, sourceBox.w > sourceBox.h, cut);
  const w = Math.max(1, Math.min(safe.w, Math.round(sourceBox.w * placement.scale)));
  const h = Math.max(1, Math.min(safe.h, Math.round(sourceBox.h * placement.scale)));
  return { x: placement.placedX, y: placement.placedY, w, h };
}

/**
 * Projects the source matte onto the canvas exactly as the render does (cut to the bbox, lanczos3 to
 * the product box, placed). The result is the alpha the output should carry per canvas pixel.
 */
export async function projectAlpha(alpha: Buffer, source: { w: number; h: number }, sourceBox: BBox, product: BBox, canvas: { w: number; h: number }): Promise<Uint8Array> {
  const resized = await sharp(alpha, { raw: { width: source.w, height: source.h, channels: 1 } })
    .extract({ left: sourceBox.x, top: sourceBox.y, width: sourceBox.w, height: sourceBox.h })
    .resize(product.w, product.h, { kernel: "lanczos3" }).toColourspace("b-w").raw().toBuffer();
  const out = new Uint8Array(canvas.w * canvas.h);
  for (let y = 0; y < product.h; y++) {
    const cy = product.y + y;
    if (cy < 0 || cy >= canvas.h) continue;
    for (let x = 0; x < product.w; x++) {
      const cx = product.x + x;
      if (cx >= 0 && cx < canvas.w) out[cy * canvas.w + cx] = resized[y * product.w + x]!;
    }
  }
  return out;
}

/** The source RGB resampled to the product box, for the "pixels copied, never regenerated" check. */
export async function projectRgb(source: Raster, sourceBox: BBox, product: BBox): Promise<Buffer> {
  return sharp(source.rgb, { raw: { width: source.w, height: source.h, channels: 3 } })
    .extract({ left: sourceBox.x, top: sourceBox.y, width: sourceBox.w, height: sourceBox.h })
    .resize(product.w, product.h, { kernel: "lanczos3" }).raw().toBuffer();
}

export function thresholdMask(values: Uint8Array | Buffer, above: number): Mask {
  const m = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) m[i] = values[i]! > above ? 1 : 0;
  return m;
}

/** Square dilation by `r` pixels (Chebyshev), separable and exact. */
export function dilate(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) { let run = -1; for (let x = 0; x < w; x++) { if (mask[y * w + x]) run = x; if (run >= 0 && x - run <= r) tmp[y * w + x] = 1; } run = -1; for (let x = w - 1; x >= 0; x--) { if (mask[y * w + x]) run = x; if (run >= 0 && run - x <= r) tmp[y * w + x] = 1; } }
  for (let x = 0; x < w; x++) { let run = -1; for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (run >= 0 && y - run <= r) out[y * w + x] = 1; } run = -1; for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run >= 0 && run - y <= r) out[y * w + x] = 1; } }
  return out;
}
export function erode(mask: Mask, w: number, h: number, r: number): Mask {
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  // Pixels outside the frame count as background, so eroding also pulls the mask away from the edges.
  const grown = dilate(inv, w, h, r), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; out[i] = grown[i] || x < r || y < r || x >= w - r || y >= h - r ? 0 : 1; }
  return out;
}
/** Removes connected regions smaller than `min` pixels (JPEG ringing specks next to sharp edges). */
export function dropSpecks(mask: Mask, w: number, h: number, min: number): Mask {
  const { labels, sizes } = components(mask, w, h), out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (mask[i] && sizes[labels[i]!]! >= min) out[i] = 1;
  return out;
}
export const SPECK_PX = 12;
export function maskCount(mask: Mask): number { let n = 0; for (let i = 0; i < mask.length; i++) n += mask[i]!; return n; }
export function maskBox(mask: Mask, w: number, h: number): BBox | null { return bbox(Buffer.from(mask.map(v => v ? 255 : 0)), w, h, 0); }

/** 4-connected components; returns a label per pixel (0 = none) and the size of each label. */
export function components(mask: Mask, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(mask.length), sizes: number[] = [0], queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = sizes.length; sizes.push(0);
    let head = 0, tail = 0; queue[tail++] = start; labels[start] = label;
    while (head < tail) {
      const i = queue[head++]!, x = i % w, y = (i - x) / w; sizes[label]!++;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) if (j >= 0 && mask[j] && !labels[j]) { labels[j] = label; queue[tail++] = j; }
    }
  }
  return { labels, sizes };
}

/** 4-neighbour distance from the mask, capped at `max` (multi-source BFS). */
export function distanceFrom(mask: Mask, w: number, h: number, max: number): Uint16Array {
  const dist = new Uint16Array(mask.length).fill(max + 1), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++]!, d = dist[i]!;
    if (d >= max) continue;
    const x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) if (j >= 0 && dist[j]! > d + 1) { dist[j] = d + 1; queue[tail++] = j; }
  }
  return dist;
}

/** Longest run of consecutive true values along one line. */
export function longestRun(values: ArrayLike<number>): number {
  let best = 0, run = 0;
  for (let i = 0; i < values.length; i++) { run = values[i] ? run + 1 : 0; if (run > best) best = run; }
  return best;
}

/**
 * Where a shadow may lie: the spec 05 band (10% of the product height above its bottom, 25% below,
 * 10% of its width each side) widened to the render's own synthesised feather (three sigmas of its
 * horizontal blur, two depths below the contact line), so "silhouette plus feather" is the bar.
 */
/** The render's synthesised feather for a product box: horizontal sigma and depth below the contact line. */
export function shadowFeather(product: BBox): { sigmaX: number; depth: number; radius: number } {
  const depth = Math.max(2, SHADOW_PRESET.spread * Math.min(product.w, product.h));
  const sigmaX = Math.max(0.5, SHADOW_PRESET.softness * product.w, depth / 2);
  return { sigmaX, depth, radius: Math.ceil(Math.max(3 * sigmaX, 2 * depth + 2)) };
}
export function shadowBand(product: BBox, canvas: { w: number; h: number }): BBox {
  const { sigmaX, depth } = shadowFeather(product);
  const side = Math.max(product.w * SHADOW_BAND_SIDE, 3 * sigmaX), below = Math.max(product.h * SHADOW_BAND_BELOW, 2 * depth + 2);
  const x0 = Math.max(0, Math.floor(product.x - side)), x1 = Math.min(canvas.w, Math.ceil(product.x + product.w + side));
  const y0 = Math.max(0, Math.floor(product.y + product.h * (1 - SHADOW_BAND_ABOVE))), y1 = Math.min(canvas.h, Math.ceil(product.y + product.h + below));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
export const inBox = (b: BBox, x: number, y: number) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

/**
 * The source background as a function of the row: a flat colour (prepare's uniform border) or a smooth studio
 * gradient (eval run 2, french_connection: a light grey graded top to bottom, which prepare calls "not uniform"
 * and which left the matte-quality checks not run on 92% of the apparel outputs). The gradient is read from
 * the per-row median of the 2% border band over the plain rows (per-row interquartile range of the band pixels
 * under GRADED_ROW_SPREAD_MAX; a row the product crosses, or a texture with a steady median, is not plain), fitted
 * linearly top to bottom. The fit is a background when at least GRADED_PLAIN_ROWS_MIN of the rows are plain (the
 * product crossing the band on a cut side takes a few rows, never the fit) and the 95th percentile of the plain rows'
 * residuals stays under GRADED_RESIDUAL_MAX levels. A busy border (a lifestyle photo, a full-bleed close-up) fits
 * nothing and returns null, so those checks stay not run there.
 *
 * A flat border the product crosses on its cut sides (live run D2, french_connection.other, section 15e: a gift box cut
 * at the left and right of a pure white frame had 70.5% plain rows and no background model, so the loss checks never ran
 * on the glass bottles beside it) is accepted from the plain rows alone when, given the matte, the plain rows cover at
 * least GRADED_PLAIN_ROWS_MIN of the rows outside the matte's row span grown by GRADED_SPAN_GROW of the frame height, or
 * at least GRADED_PLAIN_ROWS_MIN_OVERALL of all rows, under the same residual bar; a lifestyle photo with no plain rows
 * still fits nothing.
 */
export const GRADED_RESIDUAL_MAX = 8;
export const GRADED_ROW_SPREAD_MAX = 16;
export const GRADED_PLAIN_ROWS_MIN = 0.95;
export const GRADED_PLAIN_ROWS_MIN_OVERALL = 0.5;
export const GRADED_SPAN_GROW = 0.04;
export const GRADED_OUTSIDE_MIN_ROWS = 8;
export interface BackgroundModel {
  kind: "uniform" | "graded";
  /** 95th percentile of the per-row residual against the fit (0 for a uniform border). */
  residual: number;
  /** The colour at the frame's middle row (what a single colour would be). */
  color: [number, number, number];
  /** The background colour expected at source row `y`. */
  at: (y: number) => [number, number, number];
}
const n95 = (n: number) => Math.floor(n * 0.95);
/**
 * Whether the plain rows carry the fit: GRADED_PLAIN_ROWS_MIN of all rows; else, with the matte, the same share of the
 * rows outside the matte's row span (grown by GRADED_SPAN_GROW of the frame height, at least GRADED_OUTSIDE_MIN_ROWS of
 * them), or GRADED_PLAIN_ROWS_MIN_OVERALL of all rows.
 */
export function plainRowsSuffice(plain: readonly number[], r: { w: number; h: number }, alpha?: Buffer): boolean {
  if (plain.length >= r.h * GRADED_PLAIN_ROWS_MIN) return true;
  if (plain.length >= r.h * GRADED_PLAIN_ROWS_MIN_OVERALL) return true;
  if (!alpha) return false;
  let y0 = r.h, y1 = -1;
  // Matte support (alpha over ALPHA_EDGE, which lives in context.ts; the literal keeps this module free of that import).
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (alpha[y * r.w + x]! > 10) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
  if (y1 < 0) return false;
  const grow = Math.round(r.h * GRADED_SPAN_GROW), top = Math.max(0, y0 - grow), bottom = Math.min(r.h - 1, y1 + grow);
  const outside = top + (r.h - 1 - bottom), plainOutside = plain.filter(y => y < top || y > bottom).length;
  return outside >= GRADED_OUTSIDE_MIN_ROWS && plainOutside >= outside * GRADED_PLAIN_ROWS_MIN;
}
export function backgroundModel(r: Raster, bg: { uniform: boolean; color: [number, number, number] }, alpha?: Buffer): BackgroundModel | null {
  if (bg.uniform) return { kind: "uniform", residual: 0, color: bg.color, at: () => bg.color };
  const bx = Math.max(4, Math.ceil(r.w * 0.02)), by = Math.max(4, Math.ceil(r.h * 0.02));
  if (r.h < 8) return null;
  const medians = new Float64Array(r.h * 3), spreads = new Float64Array(r.h), hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let y = 0; y < r.h; y++) {
    for (const h of hist) h.fill(0);
    let count = 0;
    const inBand = y < by || y >= r.h - by;
    for (let x = 0; x < r.w; x++) {
      if (!inBand && x >= bx && x < r.w - bx) continue;
      count++;
      for (let c = 0; c < 3; c++) { const v = r.rgb[(y * r.w + x) * 3 + c]!; hist[c]![v] = hist[c]![v]! + 1; }
    }
    // Per channel: the row's quartiles and median from its histogram; the spread is the widest interquartile range.
    for (let c = 0; c < 3; c++) {
      let seen = 0, p25 = -1, median = -1, p75 = -1;
      for (let v = 0; v < 256 && p75 < 0; v++) { seen += hist[c]![v]!; if (p25 < 0 && seen * 4 >= count) p25 = v; if (median < 0 && seen * 2 >= count) median = v; if (seen * 4 >= count * 3) p75 = v; }
      medians[y * 3 + c] = median; spreads[y] = Math.max(spreads[y]!, p75 - p25);
    }
  }
  const plain: number[] = [];
  for (let y = 0; y < r.h; y++) if (spreads[y]! <= GRADED_ROW_SPREAD_MAX) plain.push(y);
  if (plain.length < 2 || !plainRowsSuffice(plain, r, alpha)) return null;
  // Least-squares line per channel over the plain rows (a row the product crosses never tilts the fit).
  const n = r.h, m = plain.length, slope = [0, 0, 0], offset = [0, 0, 0];
  let sumY = 0, sumYY = 0;
  for (const y of plain) { sumY += y; sumYY += y * y; }
  for (let c = 0; c < 3; c++) {
    let sumV = 0, sumYV = 0;
    for (const y of plain) { const v = medians[y * 3 + c]!; sumV += v; sumYV += y * v; }
    const det = m * sumYY - sumY * sumY;
    slope[c] = det ? (m * sumYV - sumY * sumV) / det : 0;
    offset[c] = (sumV - slope[c]! * sumY) / m;
  }
  const at = (y: number): [number, number, number] => { const yy = Math.min(n - 1, Math.max(0, y)); return [0, 1, 2].map(c => Math.min(255, Math.max(0, Math.round(offset[c]! + slope[c]! * yy)))) as [number, number, number]; };
  const residuals = plain.map(y => { const fit = at(y); return Math.max(...[0, 1, 2].map(c => Math.abs(medians[y * 3 + c]! - fit[c]!))); }).sort((a, b) => a - b);
  const residual = residuals[Math.min(m - 1, n95(m))]!;
  if (residual > GRADED_RESIDUAL_MAX) return null;
  return { kind: "graded", residual, color: at(Math.floor(n / 2)), at };
}
