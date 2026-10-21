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

/**
 * Spec 11 4.2: each served model's ONNX export, as the first 8 hex of its sha256 (printed by the Dockerfile's
 * upscale-models stage, recorded in services/matting/README.md). Bumped whenever an export changes, so the outputs
 * it made re-render once; a redeploy with the same export keeps every key.
 */
export const UPSCALE_MODEL_VERSIONS: Readonly<Record<string, string>> = { "realesrgan-x2plus": "e828354d", "swinir-x2": "9f4a3f85" };
/** The render_key part that names the upscaler, its export and the recombination; present only when the upscaler was used. */
export const upscalerKey = (model: string): string => `u:${model}@${UPSCALE_MODEL_VERSIONS[model] ?? "unknown"}:${UPSCALER_VERSION}`;

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
 * The upload to /upscale: JPEG quality 95 with 4:4:4 chroma (no colour subsampling). About a quarter of a lossless
 * PNG's bytes for the cross-region transfer; at this quality the difference to the source is about one level,
 * far below what the x2 model or the fidelity gate's bars resolve, and the sources are JPEGs already.
 */
export const UPSCALE_UPLOAD_JPEG = { quality: 95, chromaSubsampling: "4:4:4" } as const;
export async function upscaleUpload(rgb: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg(UPSCALE_UPLOAD_JPEG).toBuffer();
}

/** The x2 colour of a whole source photo (raw RGB, exactly twice the source in both axes) and the service time. */
export interface SourceX2 { rgb: Buffer; width: number; height: number; ms: number }
/**
 * One upscale call per source photo (spec 11 assumption 3): the first channel that needs it starts the call, every
 * other channel and every auto-resolve re-render of the same photo (the same `Prepared.rgb` buffer) reuses the
 * result, a failure included (null: the plain path for every output of that photo). Weakly held, so the x2 image
 * goes when the photo's buffers do.
 */
const sourceX2Cache = new WeakMap<Upscaler, WeakMap<Buffer, Promise<SourceX2 | null>>>();
export function sourceX2(upscaler: Upscaler, rgb: Buffer, width: number, trace: UpscaleTrace = {}): { result: Promise<SourceX2 | null>; reused: boolean } {
  let perUpscaler = sourceX2Cache.get(upscaler);
  if (!perUpscaler) { perUpscaler = new WeakMap(); sourceX2Cache.set(upscaler, perUpscaler); }
  const cached = perUpscaler.get(rgb);
  if (cached) return { result: cached, reused: true };
  const result = (async (): Promise<SourceX2 | null> => {
    const started = Date.now(), height = rgb.length / 3 / width;
    try {
      const reply = await upscaler.upscale(await upscaleUpload(rgb, width, height), "image/jpeg");
      const out = await sharp(reply.jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
      if (out.info.width !== width * UPSCALE_FACTOR || out.info.height !== height * UPSCALE_FACTOR || out.info.channels !== 3) throw new Error(`The upscale service returned ${out.info.width} x ${out.info.height} for a ${width} x ${height} photo.`);
      console.info(JSON.stringify({ event: "catalog_upscale", ...trace, model: upscaler.model, ms: reply.ms, wallMs: Date.now() - started, source: `${width}x${height}` }));
      return { rgb: out.data, width: out.info.width, height: out.info.height, ms: reply.ms };
    } catch (error) {
      console.warn(JSON.stringify({ severity: "WARNING", message: "upscale failed; used the plain enlargement", ...trace, wallMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  })();
  perUpscaler.set(rgb, result);
  return { result, reused: false };
}

/**
 * The colour of `crop` (in a `sourceWidth`-wide RGB buffer) enlarged to `target`: cut at doubled coordinates from
 * the photo's one x2 image (sourceX2) and taken to `target` with Lanczos3 (up or down). Returns raw RGB (3 bytes per
 * pixel), the service time and whether the x2 image was shared with an earlier output, or null on any failure.
 */
export async function upscaledRgb(upscaler: Upscaler, rgb: Buffer, sourceWidth: number, crop: { x: number; y: number; w: number; h: number }, target: Size, trace: UpscaleTrace = {}): Promise<{ rgb: Buffer; ms: number; reused: boolean } | null> {
  const { result, reused } = sourceX2(upscaler, rgb, sourceWidth, trace), x2 = await result;
  if (!x2) return null;
  try {
    const f = UPSCALE_FACTOR;
    const out = await sharp(x2.rgb, { raw: { width: x2.width, height: x2.height, channels: 3 } }).extract({ left: crop.x * f, top: crop.y * f, width: crop.w * f, height: crop.h * f }).resize(target.w, target.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
    if (out.length !== target.w * target.h * 3) throw new Error("The upscaled image could not be read as RGB.");
    return { rgb: out, ms: x2.ms, reused };
  } catch (error) {
    console.warn(JSON.stringify({ severity: "WARNING", message: "upscale failed; used the plain enlargement", ...trace, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}
