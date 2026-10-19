// Raster helpers shared by the output-quality checkers. Everything works on raw 8-bit buffers so the
// checks are exact, repeatable and independent of the render code they test.
import sharp from "sharp";
import { channel } from "../channels";
import { bbox, safeBoxFor, type BBox } from "../render";
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
export function productBoxOf(id: ChannelId, placement: OutputPlacement, sourceBox: BBox): BBox {
  const spec = channel(id), safe = safeBoxFor(spec, { w: placement.w, h: placement.h }, sourceBox.w > sourceBox.h);
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

/** Spec 05 shadow band on the canvas: 10% of the product height above its bottom, 25% below, 10% of its width each side. */
export function shadowBand(product: BBox, canvas: { w: number; h: number }): BBox {
  const x0 = Math.max(0, Math.floor(product.x - product.w * 0.1)), x1 = Math.min(canvas.w, Math.ceil(product.x + product.w * 1.1));
  const y0 = Math.max(0, Math.floor(product.y + product.h * 0.9)), y1 = Math.min(canvas.h, Math.ceil(product.y + product.h * 1.25));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
export const inBox = (b: BBox, x: number, y: number) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
