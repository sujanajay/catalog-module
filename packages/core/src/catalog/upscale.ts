// Spec 11 (render integration): a learned 2x upscale of the product colour on the GPU matting service, used
// only where a channel's plan enlarges a photo beyond UPSCALE_MIN_SCALE (today the exact-size
// channels, such as Trendyol 1200x1800 from an 800x1200 source, and a variable canvas held at its
// minimum by a small photo). Off unless UPSCALE_MODEL names a model. Any failure falls back to the
// plain Lanczos enlargement with a logged warning and no flag, so the output is byte-identical to
// the path without the upscaler. The model id never reaches operator copy: the flag's sentence is
// model-free (types.ts UPSCALED_SENTENCE) and the id lives only in render_key and engineering logs.
import sharp from "sharp";
import type { Size } from "./channels";

/** Bumped when the request or the recombination changes; part of render_key when the upscaler was used. */
export const UPSCALER_VERSION = "1";
/** The enlargement above which the upscaler is used when UPSCALE_MODEL is set (equal to MAX_UPSCALE, the variable canvases' cap). */
export const DEFAULT_UPSCALE_MIN_SCALE = 1.5;
/** The service always returns exactly this factor (POST /upscale?scale=2). */
export const UPSCALE_FACTOR = 2;
/** One upscale request; Real-ESRGAN x2 on an 800x1200 crop takes seconds on the L4, so this only bounds a stuck call. */
export const UPSCALE_TIMEOUT_MS = 60_000;
/** One retry after a 503 (the GPU service starting or busy), after this wait. */
export const UPSCALE_RETRY_DELAY_MS = 5_000;

export interface UpscaleConfig { model: string | null; minScale: number }

/** `UPSCALE_MODEL` (unset or empty: off) and `UPSCALE_MIN_SCALE` (default 1.5; a value that is not a number of at least 1 keeps the default). */
export function upscaleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UpscaleConfig {
  const model = env.UPSCALE_MODEL?.trim() || null;
  const raw = env.UPSCALE_MIN_SCALE?.trim(), parsed = raw ? Number(raw) : NaN;
  return { model, minScale: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_UPSCALE_MIN_SCALE };
}

/**
 * The decision: the plan's scale (source px to canvas px, the same factor on both axes) is above the
 * threshold. The plan's continuous scale is compared, not the rounded pixel ratio, so a variable
 * canvas held at exactly the 1.5x cap never triggers it through rounding.
 */
export function shouldUpscale(scale: number, minScale: number): boolean {
  return Number.isFinite(scale) && scale > minScale + 1e-9;
}

/** The render_key part that names the upscaler; present only when the upscaler was used. */
export const upscalerKey = (model: string): string => `u:${model}:${UPSCALER_VERSION}`;

/** What the render needs from the service: one 2x JPEG for one image. Throws on any failure. */
export interface Upscaler {
  readonly model: string;
  readonly minScale: number;
  upscale(image: Buffer, contentType: "image/png" | "image/jpeg"): Promise<{ jpeg: Buffer; ms: number }>;
}

/** The client method this module uses (MattingClient.upscale), so tests can pass a fake. */
export interface UpscaleClient {
  upscale(image: Buffer, opts: { model: string; contentType: "image/png" | "image/jpeg" }): Promise<{ jpeg: Buffer; ms: number; model: string }>;
}

/** The worker's upscaler, or null when UPSCALE_MODEL is unset (the default). */
export function createUpscaler(client: UpscaleClient, config: UpscaleConfig): Upscaler | null {
  const model = config.model;
  if (!model) return null;
  return { model, minScale: config.minScale, upscale: async (image, contentType) => { const r = await client.upscale(image, { model, contentType }); return { jpeg: r.jpeg, ms: r.ms }; } };
}

/** Ids for the logs; never shown to an operator. */
export interface UpscaleTrace { batchId?: string | undefined; productId?: string | undefined; identifier?: string | undefined; shot?: number | undefined; channel?: string | undefined }

/**
 * The colour of `crop` (in a `sourceWidth`-wide RGB buffer) enlarged to `target`: the crop is sent as
 * a lossless PNG (no second JPEG generation before the model; the service accepts PNG and JPEG), the
 * 2x JPEG that comes back is checked to be exactly 2x and taken to `target` with Lanczos (up or down).
 * Returns raw RGB (3 bytes per pixel) and the call time, or null after a logged warning on any failure.
 */
export async function upscaledRgb(upscaler: Upscaler, rgb: Buffer, sourceWidth: number, crop: { x: number; y: number; w: number; h: number }, target: Size, trace: UpscaleTrace = {}): Promise<{ rgb: Buffer; ms: number } | null> {
  const started = Date.now();
  try {
    const sourceHeight = rgb.length / 3 / sourceWidth;
    const png = await sharp(rgb, { raw: { width: sourceWidth, height: sourceHeight, channels: 3 } }).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer();
    const result = await upscaler.upscale(png, "image/png");
    const meta = await sharp(result.jpeg).metadata();
    if (meta.width !== crop.w * UPSCALE_FACTOR || meta.height !== crop.h * UPSCALE_FACTOR) throw new Error(`The upscale service returned ${meta.width} x ${meta.height} for a ${crop.w} x ${crop.h} crop.`);
    const out = await sharp(result.jpeg).removeAlpha().toColourspace("srgb").resize(target.w, target.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
    if (out.info.channels !== 3 || out.data.length !== target.w * target.h * 3) throw new Error("The upscaled image could not be read as RGB.");
    console.info(JSON.stringify({ event: "catalog_upscale", ...trace, model: upscaler.model, ms: result.ms, wallMs: Date.now() - started, crop: `${crop.w}x${crop.h}`, target: `${target.w}x${target.h}` }));
    return { rgb: out.data, ms: result.ms };
  } catch (error) {
    console.warn(JSON.stringify({ severity: "WARNING", message: "upscale failed; used the plain enlargement", ...trace, wallMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** `cutout` (an RGBA PNG of `size`) with its colour replaced by `rgb`; the alpha (Lanczos, as on the plain path) is kept byte for byte. */
export async function withColour(cutout: Buffer, rgb: Buffer, size: Size): Promise<Buffer> {
  const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== size.w || info.height !== size.h || info.channels !== 4) throw new Error("Cut-out and upscaled colour sizes differ.");
  for (let i = 0; i < size.w * size.h; i++) rgb.copy(data, i * 4, i * 3, i * 3 + 3);
  return sharp(data, { raw: { width: size.w, height: size.h, channels: 4 } }).png().toBuffer();
}
