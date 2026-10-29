// Spec 11 (render integration): a learned upscale of the product colour, used wherever a channel's plan enlarges a
// photo beyond UPSCALE_MIN_SCALE. Off unless UPSCALE_MODEL names a model. Spec 18: the worker's render never calls the
// service. The enlarge task makes the photo's upscaled images once and stores them; the render primes this module's
// cache with the stored bytes (primeSourceX2) and its upscalers (storedUpscaler) answer every other request with
// StoredEnlargementMissingError. A missing or failed image leaves `upscaled` off and the render flags
// `enlargement_failed` (render.ts), which holds the output: a plain resize never stands in, except with
// UPSCALE_MODEL=off, where no upscaler exists and the plain path is the only one. The model id never reaches operator
// copy: the flag sentences are model-free (types.ts) and the id lives only in render_key, x2_model and engineering logs.
//
// Spec 18 quality (2026-10-29 bake-off, owner: "pixelated"): every enlargement above 1.0x uses the upscaler (it was
// 1.5x). Up to 2.0x the x2 model (UPSCALE_MODEL, SwinIR-S x2) makes the colour, then Lanczos to the product size; above
// 2.0x one x4 pass (UPSCALE_MODEL_X4, SwinIR-S x4), then a Lanczos downscale, replacing x2 plus a Lanczos stretch plus
// an unsharp mask. AI output is never sharpened. x2 stays below 2.0x because it was more faithful there on the ground
// truth set (+1.0 to +1.4 dB PSNR, deltaE 0.63 against 1.35 to 1.51), so a photo used on both sides of 2.0x gets one
// image of each model, each made once and shared by every channel of the photo. The upscaler sees only the product's
// box plus a margin (enlargeRegion), not the whole photo; the stored image records that region, and the render cuts
// each channel's crop out of it at the model's scale.
import sharp from "sharp";
import type { Size } from "./channels";
import { log } from "../log";

/**
 * Bumped when the request or the recombination changes; part of render_key when the upscaler was used. 2: the product
 * region instead of the whole photo, x4 above 2.0x, no sharpening of the upscaler's colour (spec 18 quality).
 */
export const UPSCALER_VERSION = "2";
/** The enlargement above which the upscaler is used when UPSCALE_MODEL is set: every enlargement (spec 18 quality; 1.5 before). */
export const DEFAULT_UPSCALE_MIN_SCALE = 1.0;
/** The threshold batches made before spec 18 quality used (options.enlargement without minScale). */
export const LEGACY_UPSCALE_MIN_SCALE = 1.5;
/** Above this enlargement the x4 model makes the colour (when UPSCALE_MODEL_X4 is set); at or below it the x2 model. */
export const UPSCALE_X4_MIN_SCALE = 2.0;
/** The scale of the x2 model; the default for an upscaler that names none. */
export const UPSCALE_FACTOR = 2;
/** The factors the service's models upscale by (services/matting/app.py UPSCALE_SCALES). */
export type UpscaleFactor = 2 | 4;
/** Each served model's fixed scale. */
export const UPSCALE_MODEL_FACTORS: Readonly<Record<string, UpscaleFactor>> = { "swinir-x2": 2, "swinir-x4": 4 };
/**
 * The margin (source px) around the product box that the upscaler also sees. The service tiles with 32 px of real
 * context around every kept pixel (UPSCALE_OVERLAP in services/matting/app.py) and reflects the image beyond its edge;
 * with this margin no pixel the render uses lies within 32 px of the region's edge, so it sees real context there too.
 */
export const ENLARGE_REGION_MARGIN_PX = 32;

export interface UpscaleConfig {
  model: string | null;
  /** Spec 18 quality: the x4 model used above UPSCALE_X4_MIN_SCALE (UPSCALE_MODEL_X4); null: the x2 model everywhere. */
  x4Model?: string | null;
  minScale: number;
  /** Which matting service upscales (spec 16 3.1.3); absent is the GPU service. */ target?: UpscaleTarget;
}
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

/**
 * `UPSCALE_MODEL` (unset or empty: off), `UPSCALE_MODEL_X4` (unset, empty or "off": no x4 model; ignored when
 * UPSCALE_MODEL is off), `UPSCALE_MIN_SCALE` (default 1.0; a value that is not a number of at least 1 keeps the
 * default) and the target from `UPSCALE_URL`. A `UPSCALE_MODEL_X4` that is not a served x4 model
 * (UPSCALE_MODEL_FACTORS) counts as no x4 model: the x2 model then makes every enlargement, so a mistyped value never
 * names x2-scale images as the x4 band's.
 */
export function upscaleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UpscaleConfig {
  const model = env.UPSCALE_MODEL?.trim() || null;
  const x4 = env.UPSCALE_MODEL_X4?.trim();
  const raw = env.UPSCALE_MIN_SCALE?.trim(), parsed = raw ? Number(raw) : NaN;
  const target = upscaleTargetFromEnv(env);
  return { model, x4Model: model && x4 && UPSCALE_MODEL_FACTORS[x4] === 4 ? x4 : null, minScale: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_UPSCALE_MIN_SCALE, ...(target === "cpu" ? { target } : {}) };
}

/** The service's own default for the largest image it takes (services/matting/app.py), when no cap is set. */
export const DEFAULT_UPSCALE_MAX_PIXELS = 24_000_000;
/**
 * Spec 18 quality (2026-10-29 review P1-3): the largest image (width x height, before the model's scale) the upscale
 * service takes for a model of `factor`. Each model has its own cap, sized to the timeout by its own time per pixel
 * (infra/lib/shape.sh): `UPSCALE_MAX_PIXELS` for the x2 model, `UPSCALE_MAX_PIXELS_X4` for the x4 model (unset:
 * `UPSCALE_MAX_PIXELS`). Unset, the service's default. The service applies the same caps (app.py).
 */
export function upscaleMaxPixels(factor: UpscaleFactor, env: NodeJS.ProcessEnv = process.env): number {
  const read = (raw: string | undefined): number | null => { const v = Number(raw?.trim()); return raw?.trim() && Number.isInteger(v) && v > 0 ? v : null; };
  const x2 = read(env.UPSCALE_MAX_PIXELS) ?? DEFAULT_UPSCALE_MAX_PIXELS;
  return factor === 4 ? read(env.UPSCALE_MAX_PIXELS_X4) ?? x2 : x2;
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
export const UPSCALE_MODEL_VERSIONS: Readonly<Record<string, string>> = { "swinir-x2": "9f4a3f85", "swinir-x4": "f477a052" };
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
/** The model id of an upscalerId (without the "+cpu" suffix): what the service is asked for. */
export function upscalerModel(id: string): string { return isCpuUpscalerId(id) ? id.slice(0, -CPU_UPSCALER_SUFFIX.length) : id; }
/** The scale of an upscalerId's model (UPSCALE_MODEL_FACTORS; 2 for a model it does not list). */
export function upscalerFactor(id: string): UpscaleFactor { return UPSCALE_MODEL_FACTORS[upscalerModel(id)] ?? UPSCALE_FACTOR; }
/** The render_key part that names the upscaler (an upscalerId), its export and the recombination; present only when the upscaler was used. */
export const upscalerKey = (id: string): string => {
  const cpu = isCpuUpscalerId(id), model = cpu ? id.slice(0, -CPU_UPSCALER_SUFFIX.length) : id;
  return `u:${model}@${UPSCALE_MODEL_VERSIONS[model] ?? "unknown"}:${UPSCALER_VERSION}${cpu ? ":cpu" : ""}`;
};

/** What the render needs: one upscaled JPEG for one image (`factor` times its size). Throws on any failure. */
export interface Upscaler {
  /** The upscalerId (model id, plus "+cpu" on the CPU service): what render_key and the logs carry. */
  readonly model: string;
  readonly minScale: number;
  /** The model's scale; absent is 2 (UPSCALE_FACTOR). */
  readonly factor?: UpscaleFactor;
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
  return { model: id, minScale, factor: upscalerFactor(id), upscale: async () => { throw new StoredEnlargementMissingError(); } };
}

/** The scale of an Upscaler (2 when it names none). */
export const factorOf = (upscaler: Upscaler): UpscaleFactor => upscaler.factor ?? UPSCALE_FACTOR;

/**
 * Spec 18 quality: the one band rule. The model scale that makes an enlargement of `scale` (already above the
 * threshold): 4 above UPSCALE_X4_MIN_SCALE when an x4 model is configured (`x4`), else 2. The matte stage's decision
 * (render.ts enlargementFactors) and the render's choice (upscalersFor) both read it.
 */
export function upscaleFactorFor(scale: number, x4: boolean): UpscaleFactor {
  return x4 && scale > UPSCALE_X4_MIN_SCALE + 1e-9 ? 4 : 2;
}

/**
 * Spec 18 quality: which upscalers may make the colour of an enlargement of `scale`, best first. Above
 * UPSCALE_X4_MIN_SCALE only the x4 model (x2 plus a Lanczos stretch is what the bake-off replaced); at or below it the
 * x2 model, then the x4 model (x4 plus a Lanczos downscale is still a faithful enlargement, so a photo the matte stage
 * planned only above 2.0x and the render places lower, as a uniform scale may, is not held). Without an x4 model the
 * x2 model makes every enlargement.
 */
export function upscalersFor(scale: number, x2: Upscaler, x4: Upscaler | null | undefined): Upscaler[] {
  if (!x4) return [x2];
  return upscaleFactorFor(scale, true) === 4 ? [x4] : [x2, x4];
}

/** A rectangle of the prepared photo, in its pixels. */
export interface EnlargeRegion { x: number; y: number; w: number; h: number }
/**
 * The part of a `width` x `height` photo the upscaler sees: the union of `boxes` (the product's box as the render may
 * place it) grown by ENLARGE_REGION_MARGIN_PX on every side, inside the photo. Null without a box.
 */
export function enlargeRegion(boxes: readonly EnlargeRegion[], width: number, height: number, margin = ENLARGE_REGION_MARGIN_PX): EnlargeRegion | null {
  if (!boxes.length) return null;
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin), y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin);
  const x1 = Math.min(width, Math.max(...boxes.map((b) => b.x + b.w)) + margin), y1 = Math.min(height, Math.max(...boxes.map((b) => b.y + b.h)) + margin);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
/** True when `inner` lies inside `outer`. */
export const regionContains = (outer: EnlargeRegion, inner: EnlargeRegion): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
/** "x,y,w,h", the stored image's `region` metadata. */
export const formatRegion = (r: EnlargeRegion): string => `${r.x},${r.y},${r.w},${r.h}`;
/** The `region` metadata back as a region; null when it is not four whole numbers with a positive size. */
export function parseRegion(text: string | null | undefined): EnlargeRegion | null {
  const parts = (text ?? "").split(",").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0)) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Ids for the logs; never shown to an operator. */
export interface UpscaleTrace { batchId?: string | undefined; productId?: string | undefined; identifier?: string | undefined; shot?: number | undefined; channel?: string | undefined }

/**
 * The upload to /upscale: JPEG quality 95 with 4:4:4 chroma (no colour subsampling). About a quarter of a lossless
 * PNG's bytes for the cross-region transfer; at this quality the difference to the source is about one level,
 * far below what the x2 model or the fidelity gate's bars resolve, and the sources are JPEGs already.
 */
export const UPSCALE_UPLOAD_JPEG = { quality: 95, chromaSubsampling: "4:4:4" } as const;
export async function upscaleUpload(rgb: Buffer, width: number, height: number, region?: EnlargeRegion | null): Promise<Buffer> {
  const image = sharp(rgb, { raw: { width, height, channels: 3 } });
  return (region ? image.extract({ left: region.x, top: region.y, width: region.w, height: region.h }) : image).jpeg(UPSCALE_UPLOAD_JPEG).toBuffer();
}

/**
 * The upscaled colour of one region of a source photo (exactly `factor` times the region in both axes; the whole photo
 * when the service made it inline) and the service time. 2026-10-29 review P2-8: a stored image stays the JPEG it was
 * stored as (`jpeg`) and is decoded for each crop (sourcePixels), so a product's primed x4 images (48 B per region
 * pixel once decoded) never all sit in the worker's memory at once; an image a service call made inline keeps its
 * pixels (`rgb`).
 */
export interface SourceX2 { rgb?: Buffer; jpeg?: Buffer; width: number; height: number; ms: number; factor: UpscaleFactor; region: EnlargeRegion }
/** The raw RGB of an upscaled image: its pixels, or its stored JPEG decoded (the same decode for every crop). */
async function sourcePixels(x2: SourceX2): Promise<Buffer> {
  if (x2.rgb) return x2.rgb;
  const out = await sharp(x2.jpeg!).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (out.info.width !== x2.width || out.info.height !== x2.height || out.info.channels !== 3) throw new Error("The stored enlargement could not be read as RGB.");
  return out.data;
}
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
 * Spec 18 3.3.5: primes the upscaled image of the prepared photo whose colour is `rgb` (`width` wide) from its stored
 * JPEG, made from `region` of the photo (the whole photo when absent: images stored before spec 18 quality). Returns
 * false and primes nothing when the region does not lie in the photo or the image is not exactly the upscaler's
 * factor times the region in both axes (it then counts as missing). `ms` is 0: the service time and its cost row
 * belong to the enlarge task, not to the render.
 */
export async function primeSourceX2(upscaler: Upscaler, rgb: Buffer, width: number, x2Jpeg: Buffer, region?: EnlargeRegion | null): Promise<boolean> {
  const height = rgb.length / 3 / width, f = factorOf(upscaler);
  const r = region ?? { x: 0, y: 0, w: width, h: height };
  if (!regionContains({ x: 0, y: 0, w: width, h: height }, r)) return false;
  // The header only: the pixels are decoded for each crop (sourcePixels), which also refuses a JPEG that does not decode.
  const meta = await sharp(x2Jpeg).metadata();
  if (meta.width !== r.w * f || meta.height !== r.h * f) return false;
  cacheFor(upscaler).set(rgb, Promise.resolve({ jpeg: x2Jpeg, width: r.w * f, height: r.h * f, ms: 0, factor: f, region: r }));
  return true;
}
/** True when this upscaler has an image (primed, or a call under way) for the prepared photo whose colour is `rgb`. */
export function hasSourceX2(upscaler: Upscaler, rgb: Buffer): boolean { return cacheFor(upscaler).has(rgb); }
export function sourceX2(upscaler: Upscaler, rgb: Buffer, width: number, trace: UpscaleTrace = {}): { result: Promise<SourceX2 | null>; reused: boolean } {
  const perUpscaler = cacheFor(upscaler);
  const cached = perUpscaler.get(rgb);
  if (cached) return { result: cached, reused: true };
  const result = (async (): Promise<SourceX2 | null> => {
    const started = Date.now(), height = rgb.length / 3 / width, f = factorOf(upscaler);
    try {
      const reply = await upscaler.upscale(await upscaleUpload(rgb, width, height), "image/jpeg", { batchId: trace.batchId, productId: trace.productId });
      const out = await sharp(reply.jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
      if (out.info.width !== width * f || out.info.height !== height * f || out.info.channels !== 3) throw new Error(`The upscale service returned ${out.info.width} x ${out.info.height} for a ${width} x ${height} photo.`);
      log("INFO", "catalog_upscale", { ...trace, model: upscaler.model, ms: reply.ms, wallMs: Date.now() - started, source: `${width}x${height}` });
      return { rgb: out.data, width: out.info.width, height: out.info.height, ms: reply.ms, factor: f, region: { x: 0, y: 0, w: width, h: height } };
    } catch (error) {
      log("WARNING", "catalog enlargement missing", { ...trace, model: upscaler.model, wallMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  })();
  perUpscaler.set(rgb, result);
  return { result, reused: false };
}

/**
 * The colour of `crop` (in a `sourceWidth`-wide RGB buffer) enlarged to `target`: cut from the photo's one image of
 * this upscaler (sourceX2) at the crop's coordinates inside the image's region times the model's factor, and taken to
 * `target` with Lanczos3 (up or down). Returns raw RGB (3 bytes per pixel), the service time and whether the image
 * was shared with an earlier output, or null on any failure, a crop outside the image's region included (the render
 * then tries its next upscaler or flags `enlargement_failed`).
 */
export async function upscaledRgb(upscaler: Upscaler, rgb: Buffer, sourceWidth: number, crop: { x: number; y: number; w: number; h: number }, target: Size, trace: UpscaleTrace = {}): Promise<{ rgb: Buffer; ms: number; reused: boolean } | null> {
  const { result, reused } = sourceX2(upscaler, rgb, sourceWidth, trace), x2 = await result;
  if (!x2) return null;
  try {
    const f = x2.factor, r = x2.region;
    if (!regionContains(r, crop)) throw new Error(`The crop ${formatRegion(crop)} lies outside the enlarged region ${formatRegion(r)}.`);
    const out = await sharp(await sourcePixels(x2), { raw: { width: x2.width, height: x2.height, channels: 3 } }).extract({ left: (crop.x - r.x) * f, top: (crop.y - r.y) * f, width: crop.w * f, height: crop.h * f }).resize(target.w, target.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
    if (out.length !== target.w * target.h * 3) throw new Error("The upscaled image could not be read as RGB.");
    return { rgb: out, ms: x2.ms, reused };
  } catch (error) {
    log("WARNING", "catalog enlargement missing", { ...trace, model: upscaler.model, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
