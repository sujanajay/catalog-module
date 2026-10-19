import sharp from "sharp";
import type { BBox, CanvasPlan, Matte, Prepared } from "./render";
import type { OutputFlag, ProductType } from "./types";

// Shared with bbox: alpha at or below this level is negligible edge antialiasing.
export const ALPHA_BBOX_THRESHOLD = 10;
export const BG_UNIFORM_STDEV = 8;
export const SHADOW_MIN_DARKNESS = 0.04;
export const SHADOW_MAX_DARKNESS = 0.6;
export const SHADOW_SYNTH_INTENSITY_GREY = 0.25;
export const SHADOW_SYNTH_INTENSITY_WHITE = 0.15;
export const SHADOW_BAND_ABOVE = 0.1;
export const SHADOW_BAND_BELOW = 0.25;
export const SHADOW_BAND_SIDE = 0.1;
// Synthesised contact shadow. The footprint comes from the silhouette's lowest rows (bottomFraction of
// the bbox height); columns that hover above the floor fade out. spread sets the shadow depth as a
// share of the product's smaller side, softness the minimum horizontal feather as a share of its width.
// fade is the feather, as a share of the canvas's smaller side, that takes every shadow smoothly to zero
// before a required margin or the border band, so no shadow ever ends in a straight cut.
export const SHADOW_PRESET = { softness: 0.025, spread: 0.12, direction: 0, pose: "contact", bottomFraction: 0.2, fade: 0.03 } as const;
// A source is cut at the bottom of its frame (no shadow, flag complete_product) when either
// - at least CUT_EDGE_MIN_SHARE of one of its last two rows is solid product (alpha >= CUT_EDGE_ALPHA), or
// - the silhouette ends within CUT_EDGE_GAP of the frame bottom (a photo cut, then padded with a thin
//   strip) on an edge at least CUT_EDGE_WIDE_SHARE of the frame wide that is still at least
//   CUT_EDGE_STRAIGHT_RATIO as wide CUT_EDGE_LOOKBACK of the frame height higher up. A cut keeps its
//   straight sides down to the edge; feet and soles standing near the bottom are narrow and round off
//   toward their lowest row. Calibrated on the QA-gate French Connection and Anta sets: cut edges were
//   26% to 98% of the width with ratios of 0.95 or more, standing feet at most 7% and 0.73.
export const CUT_EDGE_ALPHA = 128;
export const CUT_EDGE_MIN_SHARE = 0.02;
export const CUT_EDGE_GAP = 0.02;
export const CUT_EDGE_WIDE_SHARE = 0.1;
export const CUT_EDGE_LOOKBACK = 0.01;
export const CUT_EDGE_STRAIGHT_RATIO = 0.75;

export function borderBand(width: number, height: number): { x: number; y: number } { return { x: Math.max(4, Math.ceil(width * 0.02)), y: Math.max(4, Math.ceil(height * 0.02)) }; }
export function borderPixels(width: number, height: number): number[] {
  const band = borderBand(width, height), pixels: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x < band.x || x >= width - band.x || y < band.y || y >= height - band.y) pixels.push(y * width + x);
  return pixels;
}
export function analyseBackground(rgb: Buffer, width: number, height: number): Prepared["background"] {
  const pixels = borderPixels(width, height), hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sum = [0, 0, 0], squared = [0, 0, 0];
  for (const i of pixels) for (let c = 0; c < 3; c++) { const v = rgb[i * 3 + c]!; hist[c]![v] = hist[c]![v]! + 1; sum[c]! += v; squared[c]! += v * v; }
  const stdevs = sum.map((v, c) => Math.sqrt(Math.max(0, squared[c]! / pixels.length - (v / pixels.length) ** 2)));
  const color = hist.map(h => { let count = 0; for (let n = 0; n < 256; n++) { count += h[n]!; if (count >= pixels.length / 2) return n; } return 255; }) as [number, number, number];
  return { uniform: stdevs.every(v => v < BG_UNIFORM_STDEV), color, stdev: Math.max(...stdevs) };
}

/** Only dark components connected to the contact line can be a preserved shadow. */
export function preservedDarkness(p: Prepared, matte: Matte, box: BBox, type: ProductType): Buffer | null {
  if (!p.background.uniform || matte.source === "alpha_source") return null;
  const apparel = type === "apparel_flat" || type === "apparel_model";
  const x0 = apparel ? 0 : Math.max(0, Math.floor(box.x - box.w * SHADOW_BAND_SIDE));
  const x1 = apparel ? p.width : Math.min(p.width, Math.ceil(box.x + box.w * (1 + SHADOW_BAND_SIDE)));
  const y0 = apparel ? 0 : Math.max(0, Math.floor(box.y + box.h * (1 - SHADOW_BAND_ABOVE)));
  const y1 = apparel ? p.height : Math.min(p.height, Math.ceil(box.y + box.h * (1 + SHADOW_BAND_BELOW)));
  const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const bg = luma(...p.background.color);
  if (bg === 0) return null;
  const darkness = Buffer.alloc(p.width * p.height), seen = new Uint8Array(darkness.length), queue = new Int32Array(darkness.length);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * p.width + x;
    if (matte.alpha[i] === 255) continue;
    const d = Math.min(SHADOW_MAX_DARKNESS, Math.max(0, (bg - luma(p.rgb[i * 3]!, p.rgb[i * 3 + 1]!, p.rgb[i * 3 + 2]!)) / bg));
    // Sub-JPEG-level noise must not connect a vignette to a real contact shadow.
    if (d > 0.01) darkness[i] = Math.round(d * 255);
  }
  let tail = 0;
  const contactY = Math.min(p.height - 1, box.y + box.h);
  for (let y = Math.max(y0, contactY - 1); y <= Math.min(y1 - 1, contactY + 1); y++) for (let x = box.x; x < box.x + box.w; x++) { const i = y * p.width + x; if (darkness[i] && matte.alpha[i]! <= ALPHA_BBOX_THRESHOLD && !seen[i]) { seen[i] = 1; queue[tail++] = i; } }
  let sum = 0;
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!, x = i % p.width, y = Math.floor(i / p.width); sum += darkness[i]! / 255;
    for (const next of [x > x0 ? i - 1 : -1, x + 1 < x1 ? i + 1 : -1, y > y0 ? i - p.width : -1, y + 1 < y1 ? i + p.width : -1]) if (next >= 0 && darkness[next] && matte.alpha[next]! <= ALPHA_BBOX_THRESHOLD && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
  }
  if (!tail || sum / tail <= SHADOW_MIN_DARKNESS) return null;
  // Qualify real background shadow first, without counting partially transparent product.
  // Then let that verified shadow continue underneath the partial edge. Original foreground
  // RGB is still composited over it unchanged. Never bridge into another background component.
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!, x = i % p.width, y = Math.floor(i / p.width);
    for (const next of [x > x0 ? i - 1 : -1, x + 1 < x1 ? i + 1 : -1, y > y0 ? i - p.width : -1, y + 1 < y1 ? i + p.width : -1]) if (next >= 0 && darkness[next] && matte.alpha[next]! > ALPHA_BBOX_THRESHOLD && matte.alpha[next]! < 255 && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
  }
  for (let i = 0; i < darkness.length; i++) if (!seen[i]) darkness[i] = 0;
  if (!apparel) continueBeyondBand(p, matte, box, { x0, y0, x1, y1 }, darkness, seen, bg, luma);
  return darkness;
}

/**
 * A real shadow does not stop at the measuring band. Cutting it there left a straight line along the
 * top of shoe shadows, so the connected shadow continues past the band and fades out smoothly over
 * the band's own height above the contact line.
 */
function continueBeyondBand(p: Prepared, matte: Matte, box: BBox, band: { x0: number; y0: number; x1: number; y1: number }, darkness: Buffer, seen: Uint8Array, bg: number, luma: (r: number, g: number, b: number) => number): void {
  const reach = Math.max(2, Math.round(box.h * SHADOW_BAND_ABOVE));
  const outside = (x: number, y: number) => Math.max(band.x0 - x, x - (band.x1 - 1), band.y0 - y, y - (band.y1 - 1), 0);
  const queue: number[] = [];
  for (let i = 0; i < darkness.length; i++) if (seen[i]) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!, x = i % p.width, y = Math.floor(i / p.width);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= p.width || ny >= p.height) continue;
      const n = ny * p.width + nx, distance = outside(nx, ny);
      if (seen[n] || distance === 0 || distance >= reach || matte.alpha[n] === 255) continue;
      const d = Math.min(SHADOW_MAX_DARKNESS, Math.max(0, (bg - luma(p.rgb[n * 3]!, p.rgb[n * 3 + 1]!, p.rgb[n * 3 + 2]!)) / bg));
      if (d <= 0.01) continue;
      seen[n] = 1; queue.push(n);
      darkness[n] = Math.round(d * 255 * (1 - smoothstep(distance / reach)));
    }
  }
}

function smoothstep(t: number): number { const s = Math.min(1, Math.max(0, t)); return s * s * (3 - 2 * s); }

/** True when the product runs off the bottom of the source frame (a model cut at the knees, a hem cut off). */
export function cutAtBottom(matte: Matte): boolean {
  const { alpha, width, height } = matte, needed = Math.max(3, Math.ceil(width * CUT_EDGE_MIN_SHARE));
  for (let y = Math.max(0, height - 2); y < height; y++) {
    let solid = 0;
    for (let x = 0; x < width; x++) if (alpha[y * width + x]! >= CUT_EDGE_ALPHA) solid++;
    if (solid >= needed) return true;
  }
  const solidIn = (y: number) => { let n = 0; for (let x = 0; x < width; x++) if (alpha[y * width + x]! >= CUT_EDGE_ALPHA) n++; return n; };
  const gap = Math.max(2, Math.round(height * CUT_EDGE_GAP));
  let last = -1;
  for (let y = height - 1; y >= height - 1 - gap && y >= 0 && last < 0; y--) if (solidIn(y) > 0) last = y;
  // The lowest solid row is antialiased; measure one row up, and again a little higher.
  const back = Math.max(2, Math.round(height * CUT_EDGE_LOOKBACK));
  if (last < back + 1) return false;
  const edge = solidIn(last - 1), above = solidIn(last - 1 - back);
  return edge >= Math.ceil(width * CUT_EDGE_WIDE_SHARE) && edge >= above * CUT_EDGE_STRAIGHT_RATIO;
}

/** 1 deep inside [start, end), easing to 0 at both ends over `fade` pixels; 0 outside. */
function ramp(length: number, start: number, end: number, fade: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) out[i] = smoothstep(Math.min(i + 0.5 - start, end - i - 0.5) / fade);
  return out;
}

/**
 * Silhouette contact shadow as canvas-sized darkness in 0..1. Each column's weight comes from how close
 * the silhouette gets to the contact line in that column, so trouser legs that hover above the floor
 * cast almost nothing and feet or soles cast the most. The footprint is feathered sideways and given a
 * soft vertical falloff around the contact line, so no part of it is a block or a straight edge.
 */
function synthesisedDarkness(matte: Matte, box: BBox, plan: CanvasPlan, intensity: number): Float32Array {
  const product = plan.productBox!, zone = Math.max(1, box.h * SHADOW_PRESET.bottomFraction), bottom = box.y + box.h - 1;
  const contact = new Float32Array(box.w);
  for (let x = 0; x < box.w; x++) for (let gap = 0; gap < zone && bottom - gap >= box.y; gap++) {
    const a = matte.alpha[(bottom - gap) * matte.width + box.x + x]! / 255;
    contact[x] = Math.max(contact[x]!, a * (1 - gap / zone) ** 2);
  }
  const footprint = new Float32Array(plan.w);
  for (let cx = 0; cx < product.w; cx++) {
    const sx = Math.min(box.w - 1, Math.max(0, (cx + 0.5) * box.w / product.w - 0.5)), lo = Math.floor(sx), hi = Math.min(box.w - 1, lo + 1);
    const X = product.x + cx;
    if (X >= 0 && X < plan.w) footprint[X] = contact[lo]! + (contact[hi]! - contact[lo]!) * (sx - lo);
  }
  const depth = Math.max(2, SHADOW_PRESET.spread * Math.min(product.w, product.h));
  const sigmaX = Math.max(0.5, SHADOW_PRESET.softness * product.w, depth / 2), sigmaY = depth / 2;
  const radius = Math.ceil(3 * sigmaX), kernel = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k++) total += kernel[k + radius] = Math.exp(-0.5 * (k / sigmaX) ** 2);
  const row = new Float32Array(plan.w);
  for (let X = 0; X < plan.w; X++) {
    let sum = 0;
    for (let k = Math.max(-radius, -X); k <= Math.min(radius, plan.w - 1 - X); k++) sum += footprint[X + k]! * kernel[k + radius]!;
    row[X] = sum / total;
  }
  const out = new Float32Array(plan.w * plan.h), contactY = product.y + product.h;
  for (let Y = Math.max(0, Math.floor(contactY - 4 * sigmaY)); Y < Math.min(plan.h, Math.ceil(contactY + 4 * sigmaY)); Y++) {
    const v = intensity * Math.exp(-0.5 * ((Y + 0.5 - contactY) / sigmaY) ** 2);
    for (let X = 0; X < plan.w; X++) out[Y * plan.w + X] = row[X]! * v;
  }
  return out;
}

export async function shadowLayer(p: Prepared, matte: Matte, box: BBox, plan: CanvasPlan, type: ProductType, background: string, foregroundMask?: Buffer): Promise<{ layer: Buffer | null; flags: OutputFlag[] }> {
  // A product cut by the bottom of its photo has no contact line; a shadow there floats on a straight edge.
  if (cutAtBottom(matte)) return { layer: null, flags: ["complete_product", "no_shadow_source"] };
  const darkness = preservedDarkness(p, matte, box, type), product = plan.productBox!;
  let flags: OutputFlag[] = [], projected: Float32Array, frame = { x0: 0, y0: 0, x1: plan.w, y1: plan.h };
  if (darkness) {
    const resizedW = Math.max(1, Math.round(p.width * plan.scale)), resizedH = Math.max(1, Math.round(p.height * plan.scale));
    const scaled = await sharp(darkness, { raw: { width: p.width, height: p.height, channels: 1 } }).resize(resizedW, resizedH).toColourspace("b-w").raw().toBuffer();
    projected = new Float32Array(plan.w * plan.h);
    const dx = product.x - Math.round(box.x * plan.scale), dy = product.y - Math.round(box.y * plan.scale);
    for (let y = 0; y < resizedH; y++) for (let x = 0; x < resizedW; x++) { const px = x + dx, py = y + dy; if (px >= 0 && px < plan.w && py >= 0 && py < plan.h) projected[py * plan.w + px] = scaled[y * resizedW + x]! / 255; }
    // Where the source photo itself ends, a kept shadow fades instead of stopping on the frame line.
    frame = { x0: dx, y0: dy, x1: dx + resizedW, y1: dy + resizedH };
  } else {
    const synth = type !== "apparel_model" && type !== "apparel_flat" && (type === "footwear" || box.h > box.w);
    if (!synth) return { layer: null, flags: ["no_shadow_source"] };
    flags = ["shadow_synthesised"];
    projected = synthesisedDarkness(matte, box, plan, background.toUpperCase() === "#FFFFFF" ? SHADOW_SYNTH_INTENSITY_WHITE : SHADOW_SYNTH_INTENSITY_GREY);
  }
  // Required margins and the border band stay exact background, reached through a feather, never a cut.
  const band = borderBand(plan.w, plan.h), safe = plan.safeBox, fade = Math.max(2, Math.round(SHADOW_PRESET.fade * Math.min(plan.w, plan.h)));
  const wx = ramp(plan.w, Math.max(band.x, safe.x, frame.x0), Math.min(plan.w - band.x, safe.x + safe.w, frame.x1), fade);
  const wy = ramp(plan.h, Math.max(band.y, safe.y, frame.y0), Math.min(plan.h - band.y, safe.y + safe.h, frame.y1), fade);
  const grey = Buffer.alloc(plan.w * plan.h);
  for (let y = 0; y < plan.h; y++) for (let x = 0; x < plan.w; x++) {
    const i = y * plan.w + x;
    grey[i] = foregroundMask?.[i] === 255 ? 255 : 255 - Math.round(255 * projected[i]! * wx[x]! * wy[y]!);
  }
  return { layer: await sharp(grey, { raw: { width: plan.w, height: plan.h, channels: 1 } }).png().toBuffer(), flags };
}
