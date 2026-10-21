import sharp from "sharp";
import type { Size } from "./channels";

/** The part of a source photo to place (render.ts BBox, repeated here so render.ts can import this module). */
export interface CropBox { x: number; y: number; w: number; h: number }

/**
 * Unsharp mask settings for an enlarged cut-out (sharp's sharpen(), which works on the L channel in LAB, so
 * colour is untouched). Conservative on purpose: it restores some of the edge contrast an enlargement softens and
 * never invents detail.
 * - sigma 0.8 to 1.0: a mask about one output pixel wide, rising with the enlargement.
 * - m1 0 with x1 2: differences under 2 L* (flat areas, fabric grain, JPEG noise) are not sharpened at all.
 * - m2 (the amount on edges) grows with the enlargement, 1.2 x (scale - 1), capped at 1.0 (reached at 1.83x).
 * - y2 4 / y3 6: at most 4 L* brighter and 6 L* darker than plain Lanczos, so an edge never gets a visible halo.
 */
export const SHARPEN = { sigmaMin: 0.8, sigmaMax: 1.0, x1: 2, m1: 0, amountPerScale: 1.2, amountMax: 1.0, y2: 4, y3: 6 } as const;

export interface SharpenParams { sigma: number; m1: number; m2: number; x1: number; y2: number; y3: number }

/** The sharpen() settings for an enlargement of `scale` (output px per source px), or null at scale <= 1. */
export function sharpenParams(scale: number): SharpenParams | null {
  if (!(scale > 1)) return null;
  const over = Math.min(1, scale - 1);
  return { sigma: SHARPEN.sigmaMin + (SHARPEN.sigmaMax - SHARPEN.sigmaMin) * over, m1: SHARPEN.m1, m2: Math.min(SHARPEN.amountMax, SHARPEN.amountPerScale * (scale - 1)), x1: SHARPEN.x1, y2: SHARPEN.y2, y3: SHARPEN.y3 };
}

/** The larger of the two axis scales from `crop` to `to`. */
export const enlargementOf = (crop: Size, to: Size): number => Math.max(to.w / crop.w, to.h / crop.h);

/**
 * Sharpens a raw 3-channel RGB image that was enlarged by `scale`; returns it unchanged (the same buffer) at
 * scale <= 1. RGB only: an alpha channel is never passed through here.
 */
export async function sharpenAfterEnlarge(rgb: Buffer, size: Size, scale: number): Promise<Buffer> {
  const params = sharpenParams(scale);
  if (!params) return rgb;
  return sharp(rgb, { raw: { width: size.w, height: size.h, channels: 3 } }).sharpen(params).raw().toBuffer();
}

/** From this alpha up a cut-out pixel takes all of the sharpening (model mattes peak at 250 to 254 inside the product). */
export const SHARPEN_ALPHA_FULL = 250;
/** At or below this alpha (the partly transparent silhouette edge) a pixel takes none of it and keeps its Lanczos colour. */
export const SHARPEN_ALPHA_FLOOR = 224;

/** The share (0 to 1) of the sharpening a cut-out pixel of this alpha takes: a straight ramp from the floor to full. */
export function sharpenWeight(alpha: number): number {
  if (alpha >= SHARPEN_ALPHA_FULL) return 1;
  if (alpha <= SHARPEN_ALPHA_FLOOR) return 0;
  return (alpha - SHARPEN_ALPHA_FLOOR) / (SHARPEN_ALPHA_FULL - SHARPEN_ALPHA_FLOOR);
}

/**
 * The sharpening is weighed on the lowest alpha within this many px (a square window), not on the pixel's own: the
 * mask reaches about 2 px, so a product pixel this close to the silhouette would be sharpened against the old
 * background (a dark or light line along the outline on the new one).
 */
export const SHARPEN_EDGE_PX = 2;

/** Per pixel, the lowest alpha of a 4-channel image within `r` px (a separable minimum filter). */
export function innerAlpha(rgba: Buffer, size: Size, r: number): Uint8Array {
  const { w, h } = size, rows = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let low = 255;
    for (let k = Math.max(0, x - r), end = Math.min(w - 1, x + r); k <= end; k++) low = Math.min(low, rgba[(y * w + k) * 4 + 3]!);
    rows[y * w + x] = low;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let low = 255;
    for (let k = Math.max(0, y - r), end = Math.min(h - 1, y + r); k <= end; k++) low = Math.min(low, rows[k * w + x]!);
    out[y * w + x] = low;
  }
  return out;
}

export interface EnlargeInput {
  /** The source photo with the matte as alpha, 4 channels. */ rgba: Buffer;
  /** The same photo without alpha, 3 channels. */ rgb: Buffer;
  width: number; height: number;
  /** The part of the photo to place. */ crop: CropBox;
  /** The placed product size on the canvas. */ to: Size;
  /**
   * Spec 11: the colour of `crop` already enlarged to `to` by the GPU upscaler (x2, then Lanczos3 to `to`), raw
   * 3-channel RGB. It replaces the Lanczos3 enlargement of the full photo in step 2; the sharpening then runs on it
   * with the residual Lanczos factor (enlargement / 2). Absent: the plain path.
   */
  upscaled?: Buffer;
}

/** The fixed factor of the upscale service (POST /upscale?scale=2); the residual Lanczos factor is the enlargement over this. */
export const UPSCALE_SERVICE_FACTOR = 2;

/**
 * The cut-out of `crop` resized to `to` as a PNG with alpha, the one place a product is resized for a canvas.
 *
 * At scale <= 1 on both axes this is exactly the plain Lanczos3 resize it always was (byte for byte).
 * On an enlargement:
 * 1. the RGBA cut-out is resized with Lanczos3 as before; its alpha is kept exactly as it is;
 * 2. the full photo (no alpha, so the real background stays under the edge) is resized the same way and
 *    sharpened (sharpenAfterEnlarge); the difference the sharpening made is added to the cut-out's colour.
 *    Using the full photo means the edge is sharpened against what the camera saw, never against the black
 *    that sits under transparent pixels. How much of the difference a pixel takes follows the lowest alpha within
 *    SHARPEN_EDGE_PX (2 px) of it (sharpenWeight of innerAlpha): all of it from SHARPEN_ALPHA_FULL (250) up, none at
 *    or below SHARPEN_ALPHA_FLOOR (224), a straight ramp in between. A model matte is never exactly 255 inside the
 *    product (it peaks at 250 to 254, and the Lanczos3 resize of a soft matte rarely lands on 255), so the old rule
 *    "exactly 255 only" left every model cut-out unsharpened. The partly transparent silhouette edge, and the 2 px
 *    of product next to it, keep their plain Lanczos colour, so no bright or dark rim appears on the new background;
 *    the short ramp fades the sharpening in further inside.
 *
 * With `upscaled` (spec 11), step 2 starts from the upscaler's colour instead of the Lanczos3 enlargement of the full
 * photo: every pixel of the cut-out takes that colour, plus the same alpha-weighted share of its sharpening with the
 * residual factor (enlargement / 2, so no sharpening once the x2 pass alone covers the enlargement), and the alpha
 * stays the plain Lanczos3 alpha of step 1, byte for byte.
 */
export async function enlargeCutout(input: EnlargeInput): Promise<Buffer> {
  const { rgba, rgb, width, height, crop, to, upscaled } = input;
  const region = { left: crop.x, top: crop.y, width: crop.w, height: crop.h };
  const resized = sharp(rgba, { raw: { width, height, channels: 4 } }).extract(region).resize(to.w, to.h, { kernel: "lanczos3" });
  const scale = enlargementOf(crop, to);
  if (!upscaled && !(scale > 1)) return resized.png().toBuffer();
  if (upscaled && upscaled.length !== to.w * to.h * 3) throw new Error("The upscaled colour does not match the product size.");
  const cutout = await resized.raw().toBuffer();
  const base = upscaled ?? await sharp(rgb, { raw: { width, height, channels: 3 } }).extract(region).resize(to.w, to.h, { kernel: "lanczos3" }).raw().toBuffer();
  const sharpened = await sharpenAfterEnlarge(base, to, upscaled ? scale / UPSCALE_SERVICE_FACTOR : scale);
  const inner = innerAlpha(cutout, to, SHARPEN_EDGE_PX);
  for (let i = 0, n = to.w * to.h; i < n; i++) {
    // The share of the sharpening this pixel takes: none on the silhouette edge, so the sharpening of the old
    // background never shows as a rim on the new one; all of it inside the product.
    const weight = sharpenWeight(inner[i]!);
    for (let c = 0; c < 3; c++) {
      const delta = sharpened[i * 3 + c]! - base[i * 3 + c]!;
      const start = upscaled ? upscaled[i * 3 + c]! : cutout[i * 4 + c]!;
      cutout[i * 4 + c] = weight && delta ? Math.max(0, Math.min(255, start + Math.round(delta * weight))) : start;
    }
  }
  return sharp(cutout, { raw: { width: to.w, height: to.h, channels: 4 } }).png().toBuffer();
}
