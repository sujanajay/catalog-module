import sharp from "sharp";
import type { BBox, CanvasPlan, Matte, Prepared } from "./render";
import type { OutputFlag, ProductType } from "./types";

export const BG_UNIFORM_STDEV = 8;
export const SHADOW_MIN_DARKNESS = 0.04;
export const SHADOW_MAX_DARKNESS = 0.6;
export const SHADOW_SYNTH_INTENSITY_GREY = 0.25;
export const SHADOW_SYNTH_INTENSITY_WHITE = 0.15;
export const SHADOW_BAND_ABOVE = 0.1;
export const SHADOW_BAND_BELOW = 0.25;
export const SHADOW_BAND_SIDE = 0.1;
export const SHADOW_PRESET = { softness: 0.025, spread: 0.12, direction: 0, pose: "contact", bottomFraction: 0.2 } as const;

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
    if (matte.alpha[i] !== 0) continue;
    const d = Math.min(SHADOW_MAX_DARKNESS, Math.max(0, (bg - luma(p.rgb[i * 3]!, p.rgb[i * 3 + 1]!, p.rgb[i * 3 + 2]!)) / bg));
    // Sub-JPEG-level noise must not connect a vignette to a real contact shadow.
    if (d > 0.01) darkness[i] = Math.round(d * 255);
  }
  let tail = 0;
  const contactY = Math.min(p.height - 1, box.y + box.h);
  for (let y = Math.max(y0, contactY - 1); y <= Math.min(y1 - 1, contactY + 1); y++) for (let x = box.x; x < box.x + box.w; x++) { const i = y * p.width + x; if (darkness[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; } }
  let sum = 0;
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!, x = i % p.width, y = Math.floor(i / p.width); sum += darkness[i]! / 255;
    for (const next of [x > x0 ? i - 1 : -1, x + 1 < x1 ? i + 1 : -1, y > y0 ? i - p.width : -1, y + 1 < y1 ? i + p.width : -1]) if (next >= 0 && darkness[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
  }
  if (!tail || sum / tail <= SHADOW_MIN_DARKNESS) return null;
  for (let i = 0; i < darkness.length; i++) if (!seen[i]) darkness[i] = 0;
  return darkness;
}

export async function shadowLayer(p: Prepared, matte: Matte, box: BBox, plan: CanvasPlan, type: ProductType, background: string, foregroundMask?: Buffer): Promise<{ layer: Buffer | null; flags: OutputFlag[] }> {
  let darkness = preservedDarkness(p, matte, box, type), flags: OutputFlag[] = [];
  const product = plan.productBox!;
  let projected: Buffer;
  if (darkness) {
    const resizedW = Math.max(1, Math.round(p.width * plan.scale)), resizedH = Math.max(1, Math.round(p.height * plan.scale));
    const scaled = await sharp(darkness, { raw: { width: p.width, height: p.height, channels: 1 } }).resize(resizedW, resizedH).toColourspace("b-w").raw().toBuffer();
    projected = Buffer.alloc(plan.w * plan.h);
    const dx = product.x - Math.round(box.x * plan.scale), dy = product.y - Math.round(box.y * plan.scale);
    for (let y = 0; y < resizedH; y++) for (let x = 0; x < resizedW; x++) { const px = x + dx, py = y + dy; if (px >= 0 && px < plan.w && py >= 0 && py < plan.h) projected[py * plan.w + px] = scaled[y * resizedW + x]!; }
  } else {
    const synth = type !== "apparel_model" && type !== "apparel_flat" && (type === "footwear" || box.h > box.w);
    if (!synth) return { layer: null, flags: ["no_shadow_source"] };
    flags = ["shadow_synthesised"];
    darkness = Buffer.alloc(box.w * Math.max(1, Math.ceil(box.h * SHADOW_PRESET.bottomFraction)));
    const rows = darkness.length / box.w;
    for (let y = 0; y < rows; y++) for (let x = 0; x < box.w; x++) darkness[y * box.w + x] = matte.alpha[(box.y + box.h - rows + y) * p.width + box.x + x]!;
    const h = Math.max(1, Math.round(product.h * SHADOW_PRESET.spread)), sigma = Math.max(0.3, product.w * SHADOW_PRESET.softness);
    const squash = await sharp(darkness, { raw: { width: box.w, height: rows, channels: 1 } }).resize(product.w, h).toColourspace("b-w").raw().toBuffer();
    const raw = Buffer.alloc(plan.w * plan.h), intensity = background.toUpperCase() === "#FFFFFF" ? SHADOW_SYNTH_INTENSITY_WHITE : SHADOW_SYNTH_INTENSITY_GREY;
    const top = product.y + product.h - Math.ceil(h / 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < product.w; x++) if (top + y >= 0 && top + y < plan.h) raw[(top + y) * plan.w + product.x + x] = Math.round(squash[y * product.w + x]! * intensity);
    projected = await sharp(raw, { raw: { width: plan.w, height: plan.h, channels: 1 } }).blur(sigma).toColourspace("b-w").raw().toBuffer();
  }
  const band = borderBand(plan.w, plan.h), safe = plan.safeBox;
  const grey = Buffer.alloc(plan.w * plan.h);
  for (let y = 0; y < plan.h; y++) for (let x = 0; x < plan.w; x++) {
    const inside = x >= Math.max(band.x, safe.x) && x < Math.min(plan.w - band.x, safe.x + safe.w) && y >= Math.max(band.y, safe.y) && y < Math.min(plan.h - band.y, safe.y + safe.h);
    grey[y * plan.w + x] = inside && !foregroundMask?.[y * plan.w + x] ? 255 - projected[y * plan.w + x]! : 255;
  }
  return { layer: await sharp(grey, { raw: { width: plan.w, height: plan.h, channels: 1 } }).png().toBuffer(), flags };
}
