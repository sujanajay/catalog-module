// Synthetic subjects for the checker tests: a coloured product with a thin strap on a plain source,
// pushed through the real renderSource so the passing case exercises the checkers against what the
// pipeline really makes, plus helpers that break one thing at a time.
import sharp from "sharp";
import { backgroundFor } from "../channels";
import { analyseBackground } from "../shadow";
import { renderSource, type Matte, type Prepared } from "../render";
import type { ChannelId, OutputFlag, ProductType } from "../types";
import type { OutputSubject, Raster } from "./types";

export interface SyntheticOptions {
  width?: number; height?: number;
  box?: { x: number; y: number; w: number; h: number };
  /** Source background colour. */
  bg?: [number, number, number];
  /** Product colour. */
  color?: [number, number, number];
  /** A 3 px wide vertical strap above the body (thin structure). */
  strap?: boolean;
  /** Extend the product to the bottom edge of the source frame (a cut source). */
  cutBottom?: boolean;
  /** Narrow the bottom quarter of the body by 12% each side, like a sole under an upper, so a contact shadow stays under the product. */
  taper?: boolean;
}

/** Paints the source and the matte; the matte is exact (255 inside, 0 outside). */
export function syntheticSource(opts: SyntheticOptions = {}): { prepared: Prepared; matte: Matte; box: { x: number; y: number; w: number; h: number } } {
  const width = opts.width ?? 800, height = opts.height ?? 800, bg = opts.bg ?? [255, 255, 255], color = opts.color ?? [160, 30, 50];
  // Copied: the strap and the cut extend the box, and callers share option objects across tests.
  const box = { ...(opts.box ?? { x: 200, y: 250, w: 400, h: 380 }) };
  if (opts.cutBottom) box.h = height - box.y;
  const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
  const paint = (x: number, y: number, c: [number, number, number]) => { const i = y * width + x; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; alpha[i] = 255; };
  const inset = opts.taper ? Math.round(box.w * 0.12) : 0, taperFrom = box.y + Math.round(box.h * 0.75);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x + (y >= taperFrom ? inset : 0); x < box.x + box.w - (y >= taperFrom ? inset : 0); x++) paint(x, y, [color[0] + ((x + y) % 7) * 3, color[1] + (x % 5) * 2, color[2] + (y % 3) * 4]);
  if (opts.strap ?? true) { const sx = box.x + Math.floor(box.w / 2); for (let y = box.y - 60; y < box.y; y++) for (let x = sx - 1; x <= sx + 1; x++) paint(x, y, [40, 40, 60]); box.y -= 60; box.h += 60; }
  const prepared: Prepared = { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" };
  const matte: Matte = { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null };
  return { prepared, matte, box };
}

export async function syntheticSubject(channel: ChannelId, n: number, productType: ProductType, opts: SyntheticOptions = {}, identifier = "SYN1"): Promise<OutputSubject> {
  const { prepared, matte } = syntheticSource(opts);
  const out = await renderSource({ prepared, matte, channel, shotNumber: n, productType, identifier, publicObjectPath: `catalog-test/x/${identifier}/${channel}/${identifier}_${n}.jpg` });
  if (!out.jpeg) throw new Error(`Synthetic render failed: ${out.notes.join("; ")}`);
  return {
    identifier, n, channel, productType, source: { w: prepared.width, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, jpeg: out.jpeg,
    placement: { w: out.plan.w, h: out.plan.h, scale: out.plan.scale, placedX: out.plan.placedX, placedY: out.plan.placedY },
    flags: out.flags as OutputFlag[], status: "staged", expect: { attention: false, flags: [], detector: "code" },
  };
}

/** Decodes the subject's JPEG, lets `edit` change pixels, and re-encodes it the way the render does. */
export async function editOutput(subject: OutputSubject, edit: (r: Raster) => void, encode: { quality?: number; chromaSubsampling?: "4:4:4" | "4:2:0"; density?: number } = {}): Promise<OutputSubject> {
  const { data, info } = await sharp(subject.jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raster: Raster = { w: info.width, h: info.height, rgb: data };
  edit(raster);
  const meta = await sharp(subject.jpeg).metadata();
  const jpeg = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).withDensity(encode.density ?? meta.density ?? 72).withIccProfile("srgb").jpeg({ quality: encode.quality ?? 90, chromaSubsampling: encode.chromaSubsampling ?? "4:4:4" }).toBuffer();
  return { ...subject, jpeg };
}

export const paintRect = (r: Raster, x0: number, y0: number, w: number, h: number, c: [number, number, number]) => {
  for (let y = Math.max(0, y0); y < Math.min(r.h, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(r.w, x0 + w); x++) { const i = (y * r.w + x) * 3; r.rgb[i] = c[0]; r.rgb[i + 1] = c[1]; r.rgb[i + 2] = c[2]; }
};
export const canvasColor = (channel: ChannelId, n: number): [number, number, number] => { const v = backgroundFor(channel, n); return [1, 3, 5].map(s => parseInt(v.slice(s, s + 2), 16)) as [number, number, number]; };
