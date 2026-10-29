// Spec 11 (render integration): a learned 2x upscale of the product colour, used only where a channel's plan
// enlarges a photo beyond UPSCALE_MIN_SCALE (today the exact-size channels, such as Trendyol 1200x1800 from an
// 800x1200 source, and a variable canvas held at its minimum by a small photo). Off unless UPSCALE_MODEL names a
// model. Spec 18: the worker's render never calls the service. The enlarge task makes the photo's x2 image once and
// stores it; the render primes this module's cache with the stored bytes (primeSourceX2) and its upscaler
// (storedUpscaler) answers every other request with StoredEnlargementMissingError. A missing or failed x2 leaves
// `upscaled` off and the render flags `enlargement_failed` (render.ts), which holds the output: a plain resize never
// stands in, except with UPSCALE_MODEL=off, where no upscaler exists and the plain path is the only one. The model
// id never reaches operator copy: the flag sentences are model-free (types.ts) and the id lives only in render_key,
// x2_model and engineering logs.
import sharp from "sharp";
import type { Size } from "./channels";
import { log } from "../log";

/** Bumped when the request or the recombination changes; part of render_key when the upscaler was used. */
export const UPSCALER_VERSION = "1";
/** The enlargement above which the upscaler is used when UPSCALE_MODEL is set (equal to MAX_UPSCALE, the variable canvases' cap). */
export const DEFAULT_UPSCALE_MIN_SCALE = 1.5;
/** The service always returns exactly this factor (POST /upscale?scale=2). */
export const UPSCALE_FACTOR = 2;

export interface UpscaleConfig { model: string | null; minScale: number; /** Which matting service upscales (spec 16 3.1.3); absent is the GPU service. */ target?: UpscaleTarget }
/** The matting service that answers /upscale: the GPU service (spec 11) or the CPU cut-out service (spec 16). */
export type UpscaleTarget = "cpu" | "gpu";

const normalisedUrl = (url: string | undefined): string => (url ?? "").trim().replace(/\/+$/, "");
/**
 * The GPU matting service URLs (spec 16 3.1.5): `MATTING_GPU_URLS` (comma list) or else the single `MATTING_GPU_URL`,
 * without trailing slashes, empty entries or repeats. The one parser for the matting client and the upscale target.
 */
export function gpuUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MATTING_GPU_URLS?.trim() ? env.MATTING_GPU_URLS.split(",") : [env.MATTING_GPU_URL ?? ""];
  return [...new Set(raw.map(normalisedUrl).filter(Boolean))];
}
/**
 * Spec 16 3.1.3: `UPSCALE_URL` equal to `MATTING_URL` (the CPU cut-out service) moves the upscaler to the CPU. Spec 18
 * H2: so does any other URL that is not a GPU matting service (`MATTING_GPU_URLS`, else `MATTING_GPU_URL`), which is
 * the dedicated CPU service catalog-upscale; same model and export on CPU, so it keeps the `+cpu` render keys. Unset,
 * empty or a GPU service URL keeps the GPU service, as the matting client does.
 */
export function upscaleTargetFromEnv(env: NodeJS.ProcessEnv = process.env): UpscaleTarget {
  const url = normalisedUrl(env.UPSCALE_URL);
  if (!url) return "gpu";
  return gpuUrlsFromEnv(env).includes(url) ? "gpu" : "cpu";
}

/** `UPSCALE_MODEL` (unset or empty: off), `UPSCALE_MIN_SCALE` (default 1.5; a value that is not a number of at least 1 keeps the default) and the target from `UPSCALE_URL`. */
export function upscaleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UpscaleConfig {
  const model = env.UPSCALE_MODEL?.trim() || null;
  const raw = env.UPSCALE_MIN_SCALE?.trim(), parsed = raw ? Number(raw) : NaN;
  const target = upscaleTargetFromEnv(env);
  return { model, minScale: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_UPSCALE_MIN_SCALE, ...(target === "cpu" ? { target } : {}) };
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
/**
 * The upscaler id that goes into render_key and the render result: the model id for the GPU service (spec 11, so
 * every key made there stays the same) and `<model>+cpu` for the CPU service (spec 16 3.1.3: CPU and GPU float
 * results can differ in the last bits, so a CPU-made image has its own key and never silently replaces a GPU one).
 * Engineering only; never shown to an operator.
 */
export const CPU_UPSCALER_SUFFIX = "+cpu";
export function upscalerId(model: string, target: UpscaleTarget = "gpu"): string { return target === "cpu" ? `${model}${CPU_UPSCALER_SUFFIX}` : model; }
/** True for an upscaler id made by upscalerId(model, "cpu"). */
export function isCpuUpscalerId(id: string): boolean { return id.endsWith(CPU_UPSCALER_SUFFIX); }
/** The id of the same model on the other service, for the keys a live output may carry (renderKeys). */
export function otherTargetUpscalerId(id: string): string { return isCpuUpscalerId(id) ? id.slice(0, -CPU_UPSCALER_SUFFIX.length) : upscalerId(id, "cpu"); }
/** The render_key part that names the upscaler (an upscalerId), its export and the recombination; present only when the upscaler was used. */
export const upscalerKey = (id: string): string => {
  const cpu = isCpuUpscalerId(id), model = cpu ? id.slice(0, -CPU_UPSCALER_SUFFIX.length) : id;
  return `u:${model}@${UPSCALE_MODEL_VERSIONS[model] ?? "unknown"}:${UPSCALER_VERSION}${cpu ? ":cpu" : ""}`;
};

/** What the render needs: one 2x JPEG for one image. Throws on any failure. */
export interface Upscaler {
  /** The upscalerId (model id, plus "+cpu" on the CPU service): what render_key and the logs carry. */
  readonly model: string;
  readonly minScale: number;
  /** `trace` names the batch and product for the service's log lines (MattingTrace headers). */
  upscale(image: Buffer, contentType: "image/png" | "image/jpeg", trace?: { batchId?: string | undefined; productId?: string | undefined }): Promise<{ jpeg: Buffer; ms: number }>;
}

/** Spec 18: the render asked for an x2 image no enlarge task stored (or one that did not match the photo). */
export class StoredEnlargementMissingError extends Error {
  constructor() { super("No stored enlargement for this photo."); this.name = "StoredEnlargementMissingError"; }
}

/**
 * Spec 18 3.3.5: the worker's render upscaler. It names the upscaler (render keys stay `u:<model>@<hash>`) but never
 * calls a service: an x2 image comes only from primeSourceX2, and any other request fails, which the render turns into
 * `enlargement_failed`. `id` is an upscalerId (the model, plus "+cpu" when a CPU service makes the stored images).
 */
export function storedUpscaler(id: string, minScale: number): Upscaler {
  return { model: id, minScale, upscale: async () => { throw new StoredEnlargementMissingError(); } };
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
 * One x2 image per source photo (spec 11 assumption 3): the first channel that needs it starts the call (or, in the
 * worker, finds the stored image primeSourceX2 put here), every other channel and every auto-resolve re-render of the
 * same photo (the same `Prepared.rgb` buffer) reuses the result, a failure included (null: `enlargement_failed` on
 * every output of that photo that needs it). Weakly held, so the x2 image goes when the photo's buffers do.
 */
const sourceX2Cache = new WeakMap<Upscaler, WeakMap<Buffer, Promise<SourceX2 | null>>>();
function cacheFor(upscaler: Upscaler): WeakMap<Buffer, Promise<SourceX2 | null>> {
  let perUpscaler = sourceX2Cache.get(upscaler);
  if (!perUpscaler) { perUpscaler = new WeakMap(); sourceX2Cache.set(upscaler, perUpscaler); }
  return perUpscaler;
}
/**
 * Spec 18 3.3.5: primes the x2 image of the prepared photo whose colour is `rgb` (`width` wide) from its stored JPEG.
 * Returns false and primes nothing when the image is not exactly twice the photo in both axes (it then counts as
 * missing). `ms` is 0: the service time and its cost row belong to the enlarge task, not to the render.
 */
export async function primeSourceX2(upscaler: Upscaler, rgb: Buffer, width: number, x2Jpeg: Buffer): Promise<boolean> {
  const height = rgb.length / 3 / width;
  const out = await sharp(x2Jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (out.info.width !== width * UPSCALE_FACTOR || out.info.height !== height * UPSCALE_FACTOR || out.info.channels !== 3) return false;
  cacheFor(upscaler).set(rgb, Promise.resolve({ rgb: out.data, width: out.info.width, height: out.info.height, ms: 0 }));
  return true;
}
export function sourceX2(upscaler: Upscaler, rgb: Buffer, width: number, trace: UpscaleTrace = {}): { result: Promise<SourceX2 | null>; reused: boolean } {
  const perUpscaler = cacheFor(upscaler);
  const cached = perUpscaler.get(rgb);
  if (cached) return { result: cached, reused: true };
  const result = (async (): Promise<SourceX2 | null> => {
    const started = Date.now(), height = rgb.length / 3 / width;
    try {
      const reply = await upscaler.upscale(await upscaleUpload(rgb, width, height), "image/jpeg", { batchId: trace.batchId, productId: trace.productId });
      const out = await sharp(reply.jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
      if (out.info.width !== width * UPSCALE_FACTOR || out.info.height !== height * UPSCALE_FACTOR || out.info.channels !== 3) throw new Error(`The upscale service returned ${out.info.width} x ${out.info.height} for a ${width} x ${height} photo.`);
      log("INFO", "catalog_upscale", { ...trace, model: upscaler.model, ms: reply.ms, wallMs: Date.now() - started, source: `${width}x${height}` });
      return { rgb: out.data, width: out.info.width, height: out.info.height, ms: reply.ms };
    } catch (error) {
      log("WARNING", "catalog enlargement missing", { ...trace, model: upscaler.model, wallMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  })();
  perUpscaler.set(rgb, result);
  return { result, reused: false };
}

/**
 * The colour of `crop` (in a `sourceWidth`-wide RGB buffer) enlarged to `target`: cut at doubled coordinates from
 * the photo's one x2 image (sourceX2) and taken to `target` with Lanczos3 (up or down). Returns raw RGB (3 bytes per
 * pixel), the service time and whether the x2 image was shared with an earlier output, or null on any failure (the
 * render then flags `enlargement_failed`).
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
    log("WARNING", "catalog enlargement missing", { ...trace, model: upscaler.model, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
