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

export interface EnlargeInput {
  /** The source photo with the matte as alpha, 4 channels. */ rgba: Buffer;
  /** The same photo without alpha, 3 channels. */ rgb: Buffer;
  width: number; height: number;
  /** The part of the photo to place. */ crop: CropBox;
  /** The placed product size on the canvas. */ to: Size;
}

/**
 * The cut-out of `crop` resized to `to` as a PNG with alpha, the one place a product is resized for a canvas.
 *
 * At scale <= 1 on both axes this is exactly the plain Lanczos3 resize it always was (byte for byte).
 * On an enlargement:
 * 1. the RGBA cut-out is resized with Lanczos3 as before; its alpha is kept exactly as it is;
 * 2. the full photo (no alpha, so the real background stays under the edge) is resized the same way and
 *    sharpened (sharpenAfterEnlarge); the difference the sharpening made is added to the cut-out's colour.
 *    Using the full photo means the edge is sharpened against what the camera saw, never against the black
 *    that sits under transparent pixels. The difference goes on fully opaque pixels only: the partly transparent
 *    silhouette edge keeps its plain Lanczos colour, so no bright or dark rim appears on the new background.
 *
 * A later upscaler goes in step 2, in place of the Lanczos3 enlargement of the full photo, before the sharpening.
 */
export async function enlargeCutout(input: EnlargeInput): Promise<Buffer> {
  const { rgba, rgb, width, height, crop, to } = input;
  const region = { left: crop.x, top: crop.y, width: crop.w, height: crop.h };
  const resized = sharp(rgba, { raw: { width, height, channels: 4 } }).extract(region).resize(to.w, to.h, { kernel: "lanczos3" });
  const scale = enlargementOf(crop, to);
  if (!(scale > 1)) return resized.png().toBuffer();
  const cutout = await resized.raw().toBuffer();
  const plain = await sharp(rgb, { raw: { width, height, channels: 3 } }).extract(region).resize(to.w, to.h, { kernel: "lanczos3" }).raw().toBuffer();
  const sharpened = await sharpenAfterEnlarge(plain, to, scale);
  for (let i = 0, n = to.w * to.h; i < n; i++) {
    // Only fully opaque pixels: the silhouette edge (partly transparent) stays as Lanczos made it, so the
    // sharpening of the old background never shows as a rim on the new one.
    if (cutout[i * 4 + 3] !== 255) continue;
    for (let c = 0; c < 3; c++) {
      const delta = sharpened[i * 3 + c]! - plain[i * 3 + c]!;
      if (delta) cutout[i * 4 + c] = Math.max(0, Math.min(255, cutout[i * 4 + c]! + delta));
    }
  }
  return sharp(cutout, { raw: { width: to.w, height: to.h, channels: 4 } }).png().toBuffer();
}
