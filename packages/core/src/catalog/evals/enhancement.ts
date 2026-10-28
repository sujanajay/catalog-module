// Spec 11 workstream D: the enhancement fidelity gate. A spec 10 style check set that decides whether
// an image upscaler may be enabled. Every golden photo with a long side of at least 1,600 px is shrunk
// 2x (lanczos3), restored by the baseline (lanczos3 2x plus an unsharp mask) and by every candidate
// model on the GPU service's POST /upscale, and each restoration is measured against the original on
// the product area. The bars are per candidate; the verdict names one winner or "none passes".
//
// Metrics (all pure TypeScript on raw 8-bit rasters, like the other checkers; no image library):
// - SSIM on grey, 8x8 windows at a 4 px stride, windows at least half inside the product area.
// - LPIPS stand-in: a multi-scale gradient-structure distance (1 minus the mean gradient-magnitude
//   similarity map over three dyadic scales; GMSD-like). A learned LPIPS needs an ONNX runtime and
//   weights this repo does not ship. TODO(spec 11): replace with LPIPS once an ONNX runtime is allowed.
// - CIEDE2000 mean and p95 over the product area (sRGB to Lab, D65).
// - Texture: local variance per 16 px cell; invented texture when the candidate/original ratio is over
//   1.5, flattening when under 0.6; a photo is flagged when more than 5% of its product cells are.
// - Text and logo: the three highest edge-density 128 px regions of the original, SSIM per region.
// - Halo: mean absolute grey difference in a 3 px band around the product edge.
// - Determinism (two calls, identical bytes), timing (service and wall p50 and p95, cold start) and the
//   error rate come from the runner's call log.
// Product area: pixels further than 12 levels from the source's border-median colour (spec 10's colour
// estimate), specks under 12 px dropped, grown by 2 px. It is independent of the matting models and
// needs no service call; the whole frame is used when the estimate is implausible (under 2% or over
// 98% of the frame, a lifestyle photo or a frame-filling close-up).
import sharp from "sharp";
import { GoogleAuth } from "google-auth-library";
import { CHANNELS, MAX_UPSCALE, type ChannelSpec, type Size } from "../channels";
import { NO_CUT, safeBoxFor, type BBox } from "../render";
import { sharpenAfterEnlarge } from "../enhance";
import { upscaleUpload } from "../upscale";
import { cloudRunAudience } from "../../cloud-run";
import { borderMedian, decodeRaster, delta, dilate, dropSpecks, erode, lumaAt, maskCount, SPECK_PX, type Mask } from "./image";
import type { Raster } from "./types";

export const ENHANCEMENT_CANDIDATES: readonly string[] = ["realesrgan-x2plus", "swinir-x2"];
export const BASELINE_METHOD = "baseline";
export const UPSCALE_SCALE = 2;
export const QUALIFYING_LONG_SIDE_PX = 1600;
export const FALLBACK_LONG_SIDE_PX = 1400;
export const MIN_QUALIFYING_PHOTOS = 20;
export const LPIPS_STAND_IN_LABEL = "LPIPS stand-in (multi-scale gradient-structure distance; lower is better)";

export const SSIM_WINDOW_PX = 8;
export const SSIM_STRIDE_PX = 4;
export const PRODUCT_DELTA = 12;
export const PRODUCT_SHARE_MIN = 0.02;
export const PRODUCT_SHARE_MAX = 0.98;
export const TEXTURE_CELL_PX = 16;
export const TEXTURE_INVENTED_RATIO = 1.5;
export const TEXTURE_FLATTENED_RATIO = 0.6;
export const TEXTURE_CELL_SHARE_MAX = 0.05;
/** Variance floor (levels squared) so JPEG noise on a flat cell never reads as invented texture. */
export const TEXTURE_VARIANCE_FLOOR = 4;
export const TEXT_REGION_PX = 128;
export const TEXT_REGIONS = 3;
export const HALO_BAND_PX = 3;

/** The bars, per candidate (spec 11 D). */
export const GATE_BARS = {
  betterShareMin: 0.8,
  deMeanMax: 2,
  textSsimDropMax: 0.01,
  textureFlagShareMax: 0.05,
  haloExtraMax: 1,
  determinismMin: 1,
  errorRateMax: 0.01,
  p95MsMax: 10_000,
} as const;

// --- Rasters ----------------------------------------------------------------------------------------

export const greyOf = (r: Raster): Float32Array => { const g = new Float32Array(r.w * r.h); for (let i = 0; i < g.length; i++) g[i] = lumaAt(r.rgb, i); return g; };

/** Crops a raster to even dimensions so a 2x restoration of its half matches it exactly. */
export function evenCrop(r: Raster): Raster {
  const w = r.w - (r.w % 2), h = r.h - (r.h % 2);
  if (w === r.w && h === r.h) return r;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) r.rgb.copy(rgb, y * w * 3, y * r.w * 3, y * r.w * 3 + w * 3);
  return { w, h, rgb };
}

const rawSharp = (r: Raster) => sharp(r.rgb, { raw: { width: r.w, height: r.h, channels: 3 } });

/**
 * The gate's input: the original shrunk by `scale` with lanczos3, and the upload the render sends for it
 * (upscale.ts upscaleUpload: JPEG quality 95, 4:4:4), so a candidate is measured on what production sends.
 */
export async function shrinkForGate(original: Raster, scale = UPSCALE_SCALE): Promise<{ raster: Raster; upload: Buffer }> {
  const w = Math.round(original.w / scale), h = Math.round(original.h / scale);
  const { data, info } = await rawSharp(original).resize(w, h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  const raster = { w: info.width, h: info.height, rgb: data };
  return { raster, upload: await upscaleUpload(raster.rgb, raster.w, raster.h) };
}

/**
 * Baseline restoration, exactly the render's plain path (enhance.ts): lanczos3 enlargement, then
 * sharpenAfterEnlarge(rgb, size, scale), the shared unsharp mask with the production parameters for this factor.
 * The render applies that sharpening on the fully opaque product pixels; the gate measures the product area.
 */
export async function baselineUpscale(input: Raster, scale = UPSCALE_SCALE): Promise<Raster> {
  const size = { w: input.w * scale, h: input.h * scale };
  const enlarged = await rawSharp(input).resize(size.w, size.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  return { ...size, rgb: await sharpenAfterEnlarge(enlarged, size, scale) };
}

// --- Product area -----------------------------------------------------------------------------------

export interface ProductArea { mask: Mask; share: number; method: "colour_estimate" | "whole_frame" }

/** See the file comment: the colour estimate against the border median, or the whole frame when implausible. */
export function productArea(r: Raster): ProductArea {
  const { w, h } = r, bg = borderMedian(r), raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = delta(r.rgb, i, bg) > PRODUCT_DELTA ? 1 : 0;
  const mask = dilate(dropSpecks(raw, w, h, SPECK_PX), w, h, 2), share = maskCount(mask) / (w * h);
  if (share < PRODUCT_SHARE_MIN || share > PRODUCT_SHARE_MAX) return { mask: new Uint8Array(w * h).fill(1), share: 1, method: "whole_frame" };
  return { mask, share, method: "colour_estimate" };
}

// --- SSIM -------------------------------------------------------------------------------------------

/** Mean SSIM on grey over 8x8 windows at a 4 px stride; with a mask, only windows at least half inside it. */
export function ssim(a: Float32Array, b: Float32Array, w: number, h: number, mask?: Mask): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, n = SSIM_WINDOW_PX * SSIM_WINDOW_PX;
  let total = 0, windows = 0;
  for (let y = 0; y + SSIM_WINDOW_PX <= h; y += SSIM_STRIDE_PX) for (let x = 0; x + SSIM_WINDOW_PX <= w; x += SSIM_STRIDE_PX) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, inside = 0;
    for (let j = 0; j < SSIM_WINDOW_PX; j++) {
      let i = (y + j) * w + x;
      for (let k = 0; k < SSIM_WINDOW_PX; k++, i++) { if (mask) inside += mask[i]!; const va = a[i]!, vb = b[i]!; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; }
    }
    if (mask && inside * 2 < n) continue;
    const ma = sa / n, mb = sb / n, va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    windows++;
  }
  return windows ? total / windows : 1;
}

// --- Gradient structure (LPIPS stand-in) ---------------------------------------------------------------

/** Sobel gradient magnitude; zero on the one-pixel border. */
export function gradientMagnitude(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (g[i - w + 1]! + 2 * g[i + 1]! + g[i + w + 1]!) - (g[i - w - 1]! + 2 * g[i - 1]! + g[i + w - 1]!);
    const gy = (g[i + w - 1]! + 2 * g[i + w]! + g[i + w + 1]!) - (g[i - w - 1]! + 2 * g[i - w]! + g[i - w + 1]!);
    out[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return out;
}

function halve(g: Float32Array, w: number, h: number): { g: Float32Array; w: number; h: number } {
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2), out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) { const i = 2 * y * w + 2 * x; out[y * hw + x] = (g[i]! + g[i + 1]! + g[i + w]! + g[i + w + 1]!) / 4; }
  return { g: out, w: hw, h: hh };
}
function halveMask(m: Mask, w: number, h: number): Mask {
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2), out = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) { const i = 2 * y * w + 2 * x; out[y * hw + x] = m[i]! + m[i + 1]! + m[i + w]! + m[i + w + 1]! >= 2 ? 1 : 0; }
  return out;
}

/**
 * LPIPS stand-in: 1 minus the mean gradient-magnitude similarity (2 g1 g2 + c) / (g1^2 + g2^2 + c), c = 170
 * on the 0 to 255 scale, averaged over three dyadic scales. 0 for identical images; blur, invented texture
 * and ringing all raise it. Not a learned perceptual metric; named as a stand-in wherever it is reported.
 */
export function gradientStructureDistance(a: Float32Array, b: Float32Array, w: number, h: number, mask?: Mask, scales = 3): number {
  let ga = a, gb = b, gm = mask, gw = w, gh = h, sum = 0, used = 0;
  const c = 170;
  for (let s = 0; s < scales; s++) {
    if (gw < 16 || gh < 16) break;
    const da = gradientMagnitude(ga, gw, gh), db = gradientMagnitude(gb, gw, gh);
    let t = 0, n = 0;
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) { const i = y * gw + x; if (gm && !gm[i]) continue; const p = da[i]!, q = db[i]!; t += (2 * p * q + c) / (p * p + q * q + c); n++; }
    if (n) { sum += 1 - t / n; used++; }
    const na = halve(ga, gw, gh), nb = halve(gb, gw, gh);
    if (gm) gm = halveMask(gm, gw, gh);
    ga = na.g; gb = nb.g; gw = na.w; gh = na.h;
  }
  return used ? sum / used : 0;
}

// --- CIEDE2000 ----------------------------------------------------------------------------------------

const LINEAR = Float64Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** sRGB (D65) to CIE Lab. */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LINEAR[r]!, G = LINEAR[g]!, B = LINEAR[b]!;
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047, y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B, z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(lab1: readonly [number, number, number], lab2: readonly [number, number, number]): number {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (a: number, b: number) => { if (a === 0 && b === 0) return 0; const h = deg(Math.atan2(b, a)); return h < 0 ? h + 360 : h; };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
  const Lmp = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hmp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hmp += hmp < 360 ? 360 : -360; hmp /= 2; }
  const T = 1 - 0.17 * Math.cos(rad(hmp - 30)) + 0.24 * Math.cos(rad(2 * hmp)) + 0.32 * Math.cos(rad(3 * hmp + 6)) - 0.2 * Math.cos(rad(4 * hmp - 63));
  const dTheta = 30 * Math.exp(-(((hmp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lmp - 50) ** 2) / Math.sqrt(20 + (Lmp - 50) ** 2), SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

/** Mean and p95 CIEDE2000 between two rasters of the same size over the mask. */
export function deltaEStats(a: Raster, b: Raster, mask?: Mask): { mean: number; p95: number } {
  const n = mask ? maskCount(mask) : a.w * a.h, values = new Float32Array(n);
  let k = 0, sum = 0;
  for (let i = 0; i < a.w * a.h; i++) {
    if (mask && !mask[i]) continue;
    const o = i * 3, d = deltaE2000(srgbToLab(a.rgb[o]!, a.rgb[o + 1]!, a.rgb[o + 2]!), srgbToLab(b.rgb[o]!, b.rgb[o + 1]!, b.rgb[o + 2]!));
    values[k++] = d; sum += d;
  }
  if (!k) return { mean: 0, p95: 0 };
  values.sort();
  return { mean: sum / k, p95: values[Math.min(k - 1, Math.floor(0.95 * k))]! };
}

// --- Texture -------------------------------------------------------------------------------------------

export interface TextureResult { cells: number; invented: number; flattened: number; inventedShare: number; flattenedShare: number; flagged: boolean }

/** Local variance per 16 px cell (cells at least half inside the mask); see the file comment for the ratios. */
export function textureCells(a: Float32Array, b: Float32Array, w: number, h: number, mask?: Mask, cell = TEXTURE_CELL_PX): TextureResult {
  let cells = 0, invented = 0, flattened = 0;
  const n = cell * cell;
  for (let y = 0; y + cell <= h; y += cell) for (let x = 0; x + cell <= w; x += cell) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, inside = 0;
    for (let j = 0; j < cell; j++) { let i = (y + j) * w + x; for (let k = 0; k < cell; k++, i++) { if (mask) inside += mask[i]!; const va = a[i]!, vb = b[i]!; sa += va; sb += vb; saa += va * va; sbb += vb * vb; } }
    if (mask && inside * 2 < n) continue;
    cells++;
    const va = Math.max(0, saa / n - (sa / n) ** 2), vb = Math.max(0, sbb / n - (sb / n) ** 2);
    const ratio = (vb + TEXTURE_VARIANCE_FLOOR) / (va + TEXTURE_VARIANCE_FLOOR);
    if (ratio > TEXTURE_INVENTED_RATIO) invented++;
    else if (ratio < TEXTURE_FLATTENED_RATIO && va >= TEXTURE_VARIANCE_FLOOR) flattened++;
  }
  const inventedShare = cells ? invented / cells : 0, flattenedShare = cells ? flattened / cells : 0;
  return { cells, invented, flattened, inventedShare, flattenedShare, flagged: inventedShare + flattenedShare > TEXTURE_CELL_SHARE_MAX };
}

// --- Text and logo regions -----------------------------------------------------------------------------

/** The `count` highest edge-density non-overlapping `size` px windows of the original, at least half inside the mask. */
export function textRegions(g: Float32Array, w: number, h: number, mask?: Mask, count = TEXT_REGIONS, size = TEXT_REGION_PX): BBox[] {
  if (w < size || h < size) return [];
  const grad = gradientMagnitude(g, w, h), W = w + 1;
  const sumG = new Float64Array((w + 1) * (h + 1)), sumM = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) { let rowG = 0, rowM = 0; for (let x = 1; x <= w; x++) { const i = (y - 1) * w + (x - 1); rowG += grad[i]!; rowM += mask ? mask[i]! : 1; sumG[y * W + x] = sumG[(y - 1) * W + x]! + rowG; sumM[y * W + x] = sumM[(y - 1) * W + x]! + rowM; } }
  const area = (s: Float64Array, x: number, y: number) => s[(y + size) * W + x + size]! - s[y * W + x + size]! - s[(y + size) * W + x]! + s[y * W + x]!;
  const stride = size / 4, candidates: { box: BBox; density: number }[] = [];
  for (let y = 0; y + size <= h; y += stride) for (let x = 0; x + size <= w; x += stride) {
    if (area(sumM, x, y) * 2 < size * size) continue;
    candidates.push({ box: { x, y, w: size, h: size }, density: area(sumG, x, y) / (size * size) });
  }
  candidates.sort((p, q) => q.density - p.density);
  const chosen: BBox[] = [];
  const overlaps = (a: BBox, b: BBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const c of candidates) { if (chosen.length >= count) break; if (!chosen.some(o => overlaps(o, c.box))) chosen.push(c.box); }
  return chosen;
}

export function cropGrey(g: Float32Array, w: number, box: BBox): Float32Array {
  const out = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) out.set(g.subarray((box.y + y) * w + box.x, (box.y + y) * w + box.x + box.w), y * box.w);
  return out;
}
export const regionSsim = (a: Float32Array, b: Float32Array, w: number, box: BBox) => ssim(cropGrey(a, w, box), cropGrey(b, w, box), box.w, box.h);

// --- Halo -------------------------------------------------------------------------------------------------

/** The band `px` either side of the product edge. */
export function edgeBand(mask: Mask, w: number, h: number, px = HALO_BAND_PX): Mask {
  const outer = dilate(mask, w, h, px), inner = erode(mask, w, h, px), band = new Uint8Array(w * h);
  for (let i = 0; i < band.length; i++) band[i] = outer[i]! && !inner[i] ? 1 : 0;
  return band;
}
export function meanAbsDiff(a: Float32Array, b: Float32Array, where?: Mask): number {
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i++) { if (where && !where[i]) continue; sum += Math.abs(a[i]! - b[i]!); n++; }
  return n ? sum / n : 0;
}

// --- Per photo ----------------------------------------------------------------------------------------------

export interface MethodMetrics {
  ssim: number;
  /** The LPIPS stand-in (gradient-structure distance); lower is better. */
  lpipsStandIn: number;
  deMean: number; deP95: number;
  texture: TextureResult;
  /** SSIM per text/logo region, in the order of `textRegions`. */
  textRegions: number[];
  /** Mean absolute grey difference in the 3 px band around the product edge (levels). */
  halo: number;
}

export interface PhotoGeometry { grey: Float32Array; area: ProductArea; band: Mask; regions: BBox[] }

/** Everything the metrics need from the original once. */
export function photoGeometry(original: Raster): PhotoGeometry {
  const grey = greyOf(original), area = productArea(original);
  return { grey, area, band: edgeBand(area.mask, original.w, original.h), regions: textRegions(grey, original.w, original.h, area.mask) };
}

/** Measures one restoration against the original; the restoration must have the original's size. */
export function measureRestoration(original: Raster, geometry: PhotoGeometry, restored: Raster): MethodMetrics {
  if (restored.w !== original.w || restored.h !== original.h) throw new Error(`Restoration is ${restored.w}x${restored.h}, the original ${original.w}x${original.h}.`);
  const { w, h } = original, g = greyOf(restored), mask = geometry.area.mask;
  const de = deltaEStats(original, restored, mask);
  return {
    ssim: ssim(geometry.grey, g, w, h, mask),
    lpipsStandIn: gradientStructureDistance(geometry.grey, g, w, h, mask),
    deMean: de.mean, deP95: de.p95,
    texture: textureCells(geometry.grey, g, w, h, mask),
    textRegions: geometry.regions.map(box => regionSsim(geometry.grey, g, w, box)),
    halo: meanAbsDiff(geometry.grey, g, geometry.band),
  };
}

// --- Endpoint client ----------------------------------------------------------------------------------------

export class UpscaleError extends Error { constructor(message: string, readonly status: number | null) { super(message); } }
export interface UpscaleResult { jpeg: Buffer; model: string | null; serviceMs: number | null; wallMs: number; width: number; height: number }
export interface UpscaleClientOptions { baseUrl: string; fetch?: typeof fetch; idToken?: (audience: string) => Promise<string>; timeoutMs?: number }

/**
 * POST /upscale?model=<id>&scale=2 on the GPU matting service: raw PNG or JPEG body, image/jpeg response
 * with X-Upscale-Model and X-Upscale-Ms. Authenticated like MattingClient (a Google id token for the
 * service URL; none for localhost).
 */
export class UpscaleClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;
  private readonly token: (audience: string) => Promise<string>;
  constructor(private readonly opts: UpscaleClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.request = opts.fetch ?? fetch;
    const auth = new GoogleAuth();
    this.token = opts.idToken ?? (async audience => (await auth.getIdTokenClient(audience)).idTokenProvider.fetchIdToken(audience));
  }
  private async headers(contentType?: string): Promise<Headers> {
    const url = new URL(this.baseUrl), headers = new Headers();
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!local) headers.set("Authorization", `Bearer ${await this.token(cloudRunAudience(this.baseUrl))}`);
    if (contentType) headers.set("Content-Type", contentType);
    return headers;
  }
  /** GET /health; `upscale.models` lists the upscalers (ids as strings or `{ id }` objects). */
  async health(): Promise<{ ok: boolean; models: string[] }> {
    const response = await this.request(`${this.baseUrl}/health`, { headers: await this.headers(), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
    if (!response.ok) throw new UpscaleError(`Health returned ${response.status}.`, response.status);
    const body = await response.json() as { ok?: boolean; upscale?: { models?: (string | { id: string })[] } };
    return { ok: body.ok !== false, models: (body.upscale?.models ?? []).map(m => (typeof m === "string" ? m : m.id)) };
  }
  async upscale(image: Buffer, model: string, scale = UPSCALE_SCALE, contentType = "image/png"): Promise<UpscaleResult> {
    const started = performance.now();
    const response = await this.request(`${this.baseUrl}/upscale?model=${encodeURIComponent(model)}&scale=${scale}`, { method: "POST", body: new Uint8Array(image), headers: await this.headers(contentType), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000) });
    if (!response.ok) throw new UpscaleError(`Upscale returned ${response.status}.`, response.status);
    const jpeg = Buffer.from(await response.arrayBuffer()), wallMs = performance.now() - started;
    const ms = response.headers.get("x-upscale-ms"), meta = await sharp(jpeg).metadata();
    return { jpeg, model: response.headers.get("x-upscale-model"), serviceMs: ms === null || ms === "" || Number.isNaN(Number(ms)) ? null : Number(ms), wallMs, width: meta.width ?? 0, height: meta.height ?? 0 };
  }
}

// --- Records and the verdict ---------------------------------------------------------------------------------

export interface CallRecord { ok: boolean; wallMs: number; serviceMs: number | null; error?: string }
export interface CandidateRecord {
  /** Null when no call succeeded. */
  metrics: MethodMetrics | null;
  calls: CallRecord[];
  /** Both calls succeeded and returned identical bytes; null when fewer than two succeeded. */
  deterministic: boolean | null;
}
export interface PhotoRecord {
  identifier: string; n: number; brand: string; width: number; height: number;
  productShare: number; productMethod: ProductArea["method"];
  baseline: MethodMetrics;
  candidates: Record<string, CandidateRecord>;
}

export interface Bar { id: string; label: string; measured: number | string | null; threshold: number | string; ok: boolean; detail: string }
export interface Timing { calls: number; coldStartMs: number | null; wallP50: number | null; wallP95: number | null; serviceP50: number | null; serviceP95: number | null }
export interface MethodMeans { photos: number; ssim: number; lpipsStandIn: number; deMean: number; deP95: number; halo: number; textureFlagged: number }
export interface CandidateSummary { method: string; means: MethodMeans; timing: Timing; errorRate: number; determinism: number | null; bars: Bar[]; pass: boolean }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

export function methodMeans(metrics: MethodMetrics[]): MethodMeans {
  return { photos: metrics.length, ssim: mean(metrics.map(m => m.ssim)), lpipsStandIn: mean(metrics.map(m => m.lpipsStandIn)), deMean: mean(metrics.map(m => m.deMean)), deP95: mean(metrics.map(m => m.deP95)), halo: mean(metrics.map(m => m.halo)), textureFlagged: metrics.filter(m => m.texture.flagged).length };
}

/** Timing over the successful calls; the first call is the cold start and is left out of the percentiles when there are others. */
export function timingOf(calls: CallRecord[]): Timing {
  const ok = calls.filter(c => c.ok);
  const cold = ok[0]?.wallMs ?? null, warm = ok.length > 1 ? ok.slice(1) : ok;
  const service = warm.map(c => c.serviceMs).filter((v): v is number => v !== null);
  return { calls: calls.length, coldStartMs: cold, wallP50: percentile(warm.map(c => c.wallMs), 0.5), wallP95: percentile(warm.map(c => c.wallMs), 0.95), serviceP50: percentile(service, 0.5), serviceP95: percentile(service, 0.95) };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Every bar for one candidate against the baseline, over the photos where the candidate has metrics. */
export function summariseCandidate(method: string, photos: PhotoRecord[]): CandidateSummary {
  const pairs = photos.flatMap(p => { const c = p.candidates[method]; return c?.metrics ? [{ photo: p, base: p.baseline, cand: c.metrics }] : []; });
  const calls = photos.flatMap(p => p.candidates[method]?.calls ?? []);
  const determinismPairs = photos.map(p => p.candidates[method]?.deterministic).filter((v): v is boolean => v !== null && v !== undefined);
  const means = methodMeans(pairs.map(p => p.cand)), baseMeans = methodMeans(pairs.map(p => p.base)), timing = timingOf(calls);
  const errorRate = calls.length ? calls.filter(c => !c.ok).length / calls.length : 1;
  const determinism = determinismPairs.length ? determinismPairs.filter(Boolean).length / determinismPairs.length : null;
  const n = pairs.length;
  const ssimBetter = pairs.filter(p => p.cand.ssim > p.base.ssim).length / Math.max(1, n);
  const lpipsBetter = pairs.filter(p => p.cand.lpipsStandIn < p.base.lpipsStandIn).length / Math.max(1, n);
  const deWorst = Math.max(0, ...pairs.map(p => p.cand.deMean));
  const textDrops = pairs.flatMap(p => p.cand.textRegions.map((s, i) => p.base.textRegions[i]! - s));
  const textWorst = textDrops.length ? Math.max(...textDrops) : 0;
  const textureShare = n ? pairs.filter(p => p.cand.texture.flagged).length / n : 0;
  const haloExtra = means.halo - baseMeans.halo;
  const bar = (id: string, label: string, ok: boolean, measured: number | string | null, threshold: number | string, detail: string): Bar => ({ id, label, measured, threshold, ok: ok && n > 0, detail });
  const bars: Bar[] = [
    bar("ssim_share", "SSIM better than baseline, share of photos", ssimBetter >= GATE_BARS.betterShareMin, round(ssimBetter), GATE_BARS.betterShareMin, `${pct(ssimBetter)} of ${n} photos score higher SSIM than the baseline.`),
    bar("ssim_mean", "SSIM better than baseline on the mean", means.ssim > baseMeans.ssim, round(means.ssim), `> ${round(baseMeans.ssim)}`, `Mean SSIM ${round(means.ssim)} against the baseline's ${round(baseMeans.ssim)}.`),
    bar("lpips_share", "LPIPS stand-in better than baseline, share of photos", lpipsBetter >= GATE_BARS.betterShareMin, round(lpipsBetter), GATE_BARS.betterShareMin, `${pct(lpipsBetter)} of ${n} photos score a lower gradient-structure distance than the baseline (stand-in).`),
    bar("lpips_mean", "LPIPS stand-in better than baseline on the mean", means.lpipsStandIn < baseMeans.lpipsStandIn, round(means.lpipsStandIn), `< ${round(baseMeans.lpipsStandIn)}`, `Mean stand-in distance ${round(means.lpipsStandIn)} against the baseline's ${round(baseMeans.lpipsStandIn)}.`),
    bar("de_mean", "CIEDE2000 mean under 2 on every photo", deWorst < GATE_BARS.deMeanMax, round(deWorst, 3), `< ${GATE_BARS.deMeanMax}`, `Worst per-photo mean dE2000 over the product area is ${round(deWorst, 3)}.`),
    bar("text_logo", "No text/logo region worse than baseline by more than 0.01 SSIM", textWorst <= GATE_BARS.textSsimDropMax, round(textWorst), `<= ${GATE_BARS.textSsimDropMax}`, `Largest SSIM drop against the baseline over ${textDrops.length} text/logo regions is ${round(textWorst)}.`),
    bar("texture", "Texture flags on at most 5% of photos", textureShare <= GATE_BARS.textureFlagShareMax, round(textureShare), `<= ${GATE_BARS.textureFlagShareMax}`, `${pct(textureShare)} of photos have invented or flattened texture in more than 5% of their product cells.`),
    bar("halo", "Halo at the product edge not worse than baseline + 1 level", haloExtra <= GATE_BARS.haloExtraMax, round(means.halo, 3), `<= ${round(baseMeans.halo + GATE_BARS.haloExtraMax, 3)}`, `Mean edge-band difference ${round(means.halo, 3)} levels against the baseline's ${round(baseMeans.halo, 3)}.`),
    bar("determinism", "Determinism 100% (two calls, identical bytes)", determinism === 1, determinism === null ? null : round(determinism), GATE_BARS.determinismMin, determinism === null ? "No photo had two successful calls." : `${pct(determinism)} of ${determinismPairs.length} repeated calls returned identical bytes.`),
    bar("error_rate", "Error rate under 1%", errorRate < GATE_BARS.errorRateMax, round(errorRate), `< ${GATE_BARS.errorRateMax}`, `${calls.filter(c => !c.ok).length} of ${calls.length} calls failed.`),
    bar("p95", "Wall p95 under 10 s (cold start excluded)", timing.wallP95 !== null && timing.wallP95 < GATE_BARS.p95MsMax, timing.wallP95 === null ? null : Math.round(timing.wallP95), `< ${GATE_BARS.p95MsMax}`, `Wall p50 ${timing.wallP50 === null ? "n/a" : Math.round(timing.wallP50)} ms, p95 ${timing.wallP95 === null ? "n/a" : Math.round(timing.wallP95)} ms; service p50 ${timing.serviceP50 === null ? "n/a" : Math.round(timing.serviceP50)} ms, p95 ${timing.serviceP95 === null ? "n/a" : Math.round(timing.serviceP95)} ms; cold start ${timing.coldStartMs === null ? "n/a" : Math.round(timing.coldStartMs)} ms.`),
  ];
  return { method, means, timing, errorRate, determinism, bars, pass: bars.every(b => b.ok) };
}

export interface Verdict { winner: string | null; line: string }

/** The winner is the passing candidate with the highest mean SSIM (ties: lower stand-in distance). */
export function verdictOf(candidates: CandidateSummary[]): Verdict {
  const passing = candidates.filter(c => c.pass).sort((a, b) => b.means.ssim - a.means.ssim || a.means.lpipsStandIn - b.means.lpipsStandIn);
  const winner = passing[0];
  if (!winner) return { winner: null, line: `Enhancement gate: none passes (${candidates.map(c => `${c.method} fails ${c.bars.filter(b => !b.ok).map(b => b.id).join(", ") || "nothing"}`).join("; ") || "no candidates"}).` };
  return { winner: winner.method, line: `Enhancement gate: winner ${winner.method} (mean SSIM ${round(winner.means.ssim)} over ${winner.means.photos} photos${passing.length > 1 ? `; also passing: ${passing.slice(1).map(c => c.method).join(", ")}` : ""}).` };
}

// --- The share of photos that need enlargement -------------------------------------------------------------------

export type EnlargementChannel = Pick<ChannelSpec, "targetCanvas" | "margins" | "fixedCanvas"> & { id: string };
export interface ChannelNeed { channel: string; canvas: Size; photos: number; needing: number; share: number; scaleP50: number | null }
export interface EnlargementNeed { max: number; channels: ChannelNeed[]; anyChannel: { photos: number; needing: number; share: number } }

/** The scale that fits the whole photo into the channel's safe box on its fixed canvas (the product box is never larger, so this is a lower bound of the real enlargement). */
export function enlargementFor(ch: EnlargementChannel, photo: Size): number {
  const safe = safeBoxFor(ch as unknown as ChannelSpec, ch.targetCanvas, photo.w > photo.h, NO_CUT);
  return Math.min(safe.w / photo.w, safe.h / photo.h);
}

/** Over every photo, per exact-size channel: how many would need more than `max` enlargement. */
export function countNeedsEnlargement(photos: readonly Size[], channels: readonly EnlargementChannel[] = Object.values(CHANNELS), max = MAX_UPSCALE): EnlargementNeed {
  const fixed = channels.filter(c => c.fixedCanvas), needingAny = new Set<number>();
  const rows = fixed.map(ch => {
    const scales = photos.map(p => enlargementFor(ch, p));
    let needing = 0;
    scales.forEach((s, i) => { if (s > max) { needing++; needingAny.add(i); } });
    return { channel: ch.id, canvas: ch.targetCanvas, photos: photos.length, needing, share: photos.length ? needing / photos.length : 0, scaleP50: percentile(scales, 0.5) };
  });
  return { max, channels: rows, anyChannel: { photos: photos.length, needing: needingAny.size, share: photos.length ? needingAny.size / photos.length : 0 } };
}

// --- Selection and the report ---------------------------------------------------------------------------------------

export interface Selection { minLongSide: number; counts: { at1600: number; at1400: number; atChosen: number }; fallback: boolean; note: string }

/** Photos with a long side of at least 1,600 px; 1,400 px when fewer than 20 qualify; an explicit minimum overrides both. */
export function selectQualifying<T extends Size>(photos: readonly T[], explicitMin?: number): { chosen: T[]; selection: Selection } {
  const longSide = (p: Size) => Math.max(p.w, p.h);
  const at = (min: number) => photos.filter(p => longSide(p) >= min);
  const at1600 = at(QUALIFYING_LONG_SIDE_PX).length, at1400 = at(FALLBACK_LONG_SIDE_PX).length;
  let min = explicitMin ?? QUALIFYING_LONG_SIDE_PX, fallback = false;
  if (explicitMin === undefined && at1600 < MIN_QUALIFYING_PHOTOS) { min = FALLBACK_LONG_SIDE_PX; fallback = true; }
  const chosen = at(min);
  const note = explicitMin !== undefined ? `Minimum long side ${min} px set by flag: ${chosen.length} of ${photos.length} photos qualify (${at1600} at 1,600 px, ${at1400} at 1,400 px).`
    : fallback ? `Only ${at1600} of ${photos.length} photos reach 1,600 px (fewer than ${MIN_QUALIFYING_PHOTOS}), so photos of at least 1,400 px are accepted: ${chosen.length} qualify.`
      : `${chosen.length} of ${photos.length} photos have a long side of at least 1,600 px.`;
  return { chosen, selection: { minLongSide: min, counts: { at1600, at1400, atChosen: chosen.length }, fallback, note } };
}

export interface EnhancementReport {
  run: string; startedAt: string; finishedAt: string; endpoint: string | null; scale: number;
  selection: Selection; qualifying: { identifier: string; n: number; brand: string; width: number; height: number }[];
  needsEnlargement: EnlargementNeed;
  productArea: string; metrics: Record<string, string>;
  baseline: { method: string; means: MethodMeans };
  candidates: CandidateSummary[];
  photos: PhotoRecord[];
  verdict: Verdict;
  notes: string[];
}

export const METRIC_NOTES: Record<string, string> = {
  ssim: "SSIM on grey, 8x8 windows, 4 px stride, windows at least half inside the product area.",
  lpipsStandIn: LPIPS_STAND_IN_LABEL + ". TODO(spec 11): replace with a learned LPIPS once an ONNX runtime is allowed.",
  deltaE: "CIEDE2000 (sRGB to Lab, D65) per product pixel; mean and p95 per photo.",
  texture: "Local variance per 16 px product cell; invented when the ratio to the original is over 1.5, flattened when under 0.6 (floor 4 levels squared); photo flagged above 5% of cells.",
  textLogo: "The three highest edge-density 128 px regions of the original (Sobel), SSIM per region; OCR skipped (no light OCR library in this repo).",
  halo: "Mean absolute grey difference in the 3 px band either side of the product edge, compared with the baseline's.",
  timing: "X-Upscale-Ms (service) and wall time per call; the first call of each candidate is the cold start and is excluded from the p50 and p95.",
};

const fmt = (v: number | string | null, places = 4) => (v === null ? "n/a" : typeof v === "string" ? v : String(round(v, places)));
const ms = (v: number | null) => (v === null ? "n/a" : `${Math.round(v)} ms`);

export function reportMarkdown(r: EnhancementReport): string {
  const lines: string[] = [];
  lines.push(`# Enhancement fidelity gate ${r.run}`, "", `Endpoint: ${r.endpoint ?? "none"}; scale ${r.scale}x; started ${r.startedAt}, finished ${r.finishedAt}.`, "", `**${r.verdict.line}**`, "");
  lines.push("## Photos", "", r.selection.note, "", "| Photo | Brand | Size |", "|---|---|---|", ...r.qualifying.map(q => `| ${q.identifier} n=${q.n} | ${q.brand} | ${q.width}x${q.height} |`), "");
  lines.push("## Share of photos that need enlargement", "", `Photos needing more than ${r.needsEnlargement.max}x on at least one exact-size channel: ${r.needsEnlargement.anyChannel.needing} of ${r.needsEnlargement.anyChannel.photos} (${pct(r.needsEnlargement.anyChannel.share)}). The scale fits the whole photo into the channel's safe box, a lower bound of the product's real enlargement.`, "", "| Channel | Canvas | Needing | Share | Scale p50 |", "|---|---|---|---|---|", ...r.needsEnlargement.channels.map(c => `| ${c.channel} | ${c.canvas.w}x${c.canvas.h} | ${c.needing} of ${c.photos} | ${pct(c.share)} | ${fmt(c.scaleP50, 2)} |`), "");
  lines.push("## Bars per candidate", "");
  for (const c of r.candidates) {
    lines.push(`### ${c.method}: ${c.pass ? "PASS" : "FAIL"}`, "", "| Bar | Measured | Threshold | Result | Detail |", "|---|---|---|---|---|", ...c.bars.map(b => `| ${b.label} | ${fmt(b.measured)} | ${b.threshold} | ${b.ok ? "pass" : "fail"} | ${b.detail} |`), "");
    lines.push(`Timing: ${c.timing.calls} calls, cold start ${ms(c.timing.coldStartMs)}, wall p50 ${ms(c.timing.wallP50)} / p95 ${ms(c.timing.wallP95)}, service p50 ${ms(c.timing.serviceP50)} / p95 ${ms(c.timing.serviceP95)}.`, "");
  }
  lines.push("## Means", "", "| Method | Photos | SSIM | LPIPS stand-in | dE2000 mean | dE2000 p95 | Halo (levels) | Texture flags |", "|---|---|---|---|---|---|---|---|");
  const row = (m: string, x: MethodMeans) => `| ${m} | ${x.photos} | ${fmt(x.ssim)} | ${fmt(x.lpipsStandIn)} | ${fmt(x.deMean, 3)} | ${fmt(x.deP95, 3)} | ${fmt(x.halo, 3)} | ${x.textureFlagged} |`;
  lines.push(row(r.baseline.method, r.baseline.means), ...r.candidates.map(c => row(c.method, c.means)), "");
  lines.push("## Per photo", "", "| Photo | Method | SSIM | LPIPS stand-in | dE mean | dE p95 | Texture (inv/flat) | Text regions | Halo | Deterministic |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const p of r.photos) {
    const line = (m: string, x: MethodMetrics, det: string) => `| ${p.identifier} n=${p.n} | ${m} | ${fmt(x.ssim)} | ${fmt(x.lpipsStandIn)} | ${fmt(x.deMean, 3)} | ${fmt(x.deP95, 3)} | ${pct(x.texture.inventedShare)}/${pct(x.texture.flattenedShare)}${x.texture.flagged ? " flag" : ""} | ${x.textRegions.map(s => round(s, 3)).join(", ") || "none"} | ${fmt(x.halo, 3)} | ${det} |`;
    lines.push(line(BASELINE_METHOD, p.baseline, "n/a"));
    for (const [m, c] of Object.entries(p.candidates)) lines.push(c.metrics ? line(m, c.metrics, c.deterministic === null ? "n/a" : c.deterministic ? "yes" : "no") : `| ${p.identifier} n=${p.n} | ${m} | failed: ${c.calls.map(k => k.error).filter(Boolean).join("; ") || "no successful call"} | | | | | | | |`);
  }
  lines.push("", "## Method", "", `Product area: ${r.productArea}`, "", ...Object.entries(r.metrics).map(([k, v]) => `- ${k}: ${v}`), "", ...r.notes.map(n => `- ${n}`), "");
  return lines.join("\n");
}

/** Decodes endpoint bytes to a raster for measurement. */
export const decodeRestoration = (bytes: Buffer): Promise<Raster> => decodeRaster(bytes);
