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

/**
 * Only dark components connected to the contact line, inside the band around it, can be a preserved shadow; past the
 * band they fade (continueBeyondBand). This holds for apparel too: searching the whole frame let a toned studio floor
 * (a few levels under the border's colour) flood-connect from the contact line and stay on the canvas as a large faint
 * patch that ended on the source frame (2026-11-07, Vero Moda: 47 of 533 kept shadows). Inside the band an apparel
 * shadow is also read against the floor's own tone beside it (floorTone), or the tone stays as a soft slab around the feet.
 */
export function preservedDarkness(p: Prepared, matte: Matte, box: BBox, type: ProductType): Buffer | null {
  if (!p.background.uniform || matte.source === "alpha_source") return null;
  const x0 = Math.max(0, Math.floor(box.x - box.w * SHADOW_BAND_SIDE));
  const x1 = Math.min(p.width, Math.ceil(box.x + box.w * (1 + SHADOW_BAND_SIDE)));
  const y0 = Math.max(0, Math.floor(box.y + box.h * (1 - SHADOW_BAND_ABOVE)));
  const y1 = Math.min(p.height, Math.ceil(box.y + box.h * (1 + SHADOW_BAND_BELOW)));
  const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const bg = luma(...p.background.color);
  if (bg === 0) return null;
  const reach = Math.max(2, Math.round(box.h * SHADOW_BAND_ABOVE));
  const apparel = type === "apparel_flat" || type === "apparel_model";
  const tone = apparel ? floorTone(p, matte, { x0, y0: y0 - reach, x1, y1: y1 + reach }, reach, bg, luma) : null;
  const darkAt = (i: number, x: number, y: number) => Math.min(SHADOW_MAX_DARKNESS, Math.max(0, (bg - luma(p.rgb[i * 3]!, p.rgb[i * 3 + 1]!, p.rgb[i * 3 + 2]!)) / bg - (tone ? tone(x, y) : 0)));
  const darkness = Buffer.alloc(p.width * p.height), seen = new Uint8Array(darkness.length), queue = new Int32Array(darkness.length);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * p.width + x;
    if (matte.alpha[i] === 255) continue;
    const d = darkAt(i, x, y);
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
  // On a toned floor the mean is taken above the floor's tone, so a real shadow reads fainter than on a plain floor; half the bar keeps it.
  const onTonedFloor = !!tone && tone(box.x + (box.w >> 1), contactY) > FLOOR_TONED;
  if (!tail || sum / tail <= (onTonedFloor ? SHADOW_MIN_DARKNESS / 2 : SHADOW_MIN_DARKNESS)) return null;
  // Qualify real background shadow first, without counting partially transparent product.
  // Then let that verified shadow continue underneath the partial edge. Original foreground
  // RGB is still composited over it unchanged. Never bridge into another background component.
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!, x = i % p.width, y = Math.floor(i / p.width);
    for (const next of [x > x0 ? i - 1 : -1, x + 1 < x1 ? i + 1 : -1, y > y0 ? i - p.width : -1, y + 1 < y1 ? i + p.width : -1]) if (next >= 0 && darkness[next] && matte.alpha[next]! > ALPHA_BBOX_THRESHOLD && matte.alpha[next]! < 255 && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
  }
  for (let i = 0; i < darkness.length; i++) if (!seen[i]) darkness[i] = 0;
  continueBeyondBand(p, matte, reach, { x0, y0, x1, y1 }, darkness, seen, darkAt, apparel);
  return darkness;
}

/** Above this floor tone at the contact line (darkness, 0..1) the floor is toned: about 2.5 levels on a light backdrop, JPEG noise stays under it. */
const FLOOR_TONED = 0.01;
/** The width of the floor sample beside the band, as a share of the photo's width. */
const FLOOR_SAMPLE_WIDTH = 0.02;
/** Rows of the floor sample smoothed together, as a share of the photo's height, so a row's noise does not print as a line. */
const FLOOR_SAMPLE_ROWS = 0.01;

/**
 * The tone of the floor itself under a band (darkness, 0..1), row by row: the median of the background beside the band,
 * past the reach of a contact shadow, on each side, and a straight line between the two sides, since studio light makes
 * one side darker. The canvas stands for the floor, so only what is darker than this is the product's shadow. A side
 * with no background to read (the product fills it) takes the other side's tone; with neither, the tone is 0.
 */
function floorTone(p: Prepared, matte: Matte, band: { x0: number; y0: number; x1: number; y1: number }, reach: number, bg: number, luma: (r: number, g: number, b: number) => number): (x: number, y: number) => number {
  const width = Math.max(4, Math.round(p.width * FLOOR_SAMPLE_WIDTH)), rows = Math.max(1, Math.round(p.height * FLOOR_SAMPLE_ROWS));
  const y0 = Math.max(0, band.y0), y1 = Math.min(p.height, band.y1), count = Math.max(0, y1 - y0);
  const median = (from: number, to: number): Float32Array => {
    const out = new Float32Array(count).fill(Number.NaN), values: number[] = [];
    if (to - from < 1) return out;
    for (let y = y0; y < y1; y++) {
      values.length = 0;
      for (let x = from; x < to; x++) { const i = y * p.width + x; if (matte.alpha[i]! <= ALPHA_BBOX_THRESHOLD) values.push((bg - luma(p.rgb[i * 3]!, p.rgb[i * 3 + 1]!, p.rgb[i * 3 + 2]!)) / bg); }
      if (values.length >= (to - from) / 2) out[y - y0] = values.sort((a, b) => a - b)[values.length >> 1]!;
    }
    return out;
  };
  const smooth = (line: Float32Array): Float32Array => line.map((_, at) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, at - rows); k <= Math.min(count - 1, at + rows); k++) if (!Number.isNaN(line[k]!)) { sum += line[k]!; n++; }
    return n ? Math.max(0, sum / n) : Number.NaN;
  });
  const leftEnd = Math.max(0, band.x0 - reach), rightStart = Math.min(p.width, band.x1 + reach);
  const left = smooth(median(Math.max(0, leftEnd - width), leftEnd)), right = smooth(median(rightStart, Math.min(p.width, rightStart + width)));
  const leftX = leftEnd - width / 2, rightX = rightStart + width / 2;
  return (x, y) => {
    const at = y - y0;
    if (at < 0 || at >= count) return 0;
    const l = left[at]!, r = right[at]!;
    if (Number.isNaN(l)) return Number.isNaN(r) ? 0 : r;
    if (Number.isNaN(r)) return l;
    const t = Math.min(1, Math.max(0, (x - leftX) / (rightX - leftX)));
    return l + (r - l) * t;
  };
}

/**
 * A real shadow does not stop at the measuring band. Cutting it there left a straight line along the
 * top of shoe shadows, so the connected shadow continues past the band and fades out smoothly over
 * the band's own height above the contact line.
 */
function continueBeyondBand(p: Prepared, matte: Matte, reach: number, band: { x0: number; y0: number; x1: number; y1: number }, darkness: Buffer, seen: Uint8Array, darkAt: (i: number, x: number, y: number) => number, intoBand: boolean): void {
  const outside = (x: number, y: number) => Math.max(band.x0 - x, x - (band.x1 - 1), band.y0 - y, y - (band.y1 - 1), 0);
  const queue: number[] = [];
  for (let i = 0; i < darkness.length; i++) if (seen[i]) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!, x = i % p.width, y = Math.floor(i / p.width);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= p.width || ny >= p.height) continue;
      const n = ny * p.width + nx, distance = outside(nx, ny);
      // `intoBand`: a part of the band the flood could not reach inside it (beside a foot, cut off by the foot) is filled when the shadow comes round to it; left empty, it shows as a clean rectangle in the shadow.
      if (seen[n] || (distance === 0 && !intoBand) || distance >= reach || matte.alpha[n] === 255) continue;
      const d = darkAt(n, nx, ny);
      if (d <= 0.01) continue;
      seen[n] = 1; queue.push(n);
      darkness[n] = Math.round(d * 255 * (1 - smoothstep(distance / reach)));
    }
  }
}

function smoothstep(t: number): number { const s = Math.min(1, Math.max(0, t)); return s * s * (3 - 2 * s); }

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

/** A floor patch's tone: this many luma levels under the canvas colour. Under the low bound the eye and JPEG noise see nothing; above the high bound it is a real shadow, not floor tone. */
export const FLOOR_PATCH_MIN_LEVELS = 1.5;
export const FLOOR_PATCH_MAX_LEVELS = 25;
/** Room beside the product box that a contact shadow may use, as a share of the canvas's smaller side. */
export const FLOOR_PATCH_MARGIN = 0.03;
/**
 * The share of the canvas a kept shadow may tint with floor tone beside the product before it counts as a leftover patch.
 * Live Noon images of Vero Moda (2026-11-07, 533 kept shadows) split cleanly: 45 at 1.18 to 13.27%, then 0.28% and 0.05%, the rest at most 0.01%.
 */
export const FLOOR_PATCH_MAX_SHARE = 0.01;

/**
 * The share of the canvas a drawn shadow layer (one grey byte per pixel, 255 no shadow, multiplied over `background`)
 * tints with floor tone in the lower half, beside the product: outside the columns of its box plus FLOOR_PATCH_MARGIN.
 * Under the product does not count: a skirt laid flat has a real soft shadow below its hem (Z7682102A02F73D315DA9Z shot 5,
 * 5715909709286 shot 1, 1.09% and 1.03% when that area counted). No judge sees a patch this faint, so the code measures it.
 */
export function floorPatchShare(layer: Buffer, width: number, height: number, background: readonly [number, number, number], product: BBox): number {
  const bg = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  const margin = Math.round(FLOOR_PATCH_MARGIN * Math.min(width, height));
  const x0 = product.x - margin, x1 = product.x + product.w + margin;
  let tinted = 0;
  for (let y = Math.floor(height / 2); y < height; y++) for (let x = 0; x < width; x++) {
    if (x >= x0 && x < x1) continue;
    const levels = bg * (255 - layer[y * width + x]!) / 255;
    if (levels >= FLOOR_PATCH_MIN_LEVELS && levels <= FLOOR_PATCH_MAX_LEVELS) tinted++;
  }
  return tinted / (width * height);
}

/** `keepSource` false skips the shadow kept from the source photo (07 4.6a `source_shadow_off`); the synthesis rule then decides as if none could be measured. */
export async function shadowLayer(p: Prepared, matte: Matte, box: BBox, plan: CanvasPlan, type: ProductType, background: string, foregroundMask?: Buffer, keepSource = true): Promise<{ layer: Buffer | null; flags: OutputFlag[] }> {
  const darkness = keepSource ? preservedDarkness(p, matte, box, type) : null, product = plan.productBox!;
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
