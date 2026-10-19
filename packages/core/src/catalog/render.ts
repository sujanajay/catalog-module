import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { backgroundFor, channel, DETAIL_SHOT_BBOX_FRACTION, JPEG_QUALITY_MIN, JPEG_QUALITY_START, JPEG_QUALITY_STEP, MAX_OUTPUT_BYTES, MAX_UPSCALE, MIN_SOURCE_LONG_SIDE_PX, STYLI_SKIP_LOW_RESOLUTION, type ChannelSpec, type Size } from "./channels";
import type { ChannelId, OutputFlag, ProductType } from "./types";
import { ALPHA_BBOX_THRESHOLD, analyseBackground, borderPixels, shadowLayer } from "./shadow";
import { BG_TOLERANCE, checkOutput } from "./compliance";

export interface Prepared { width: number; height: number; rgb: Buffer; alphaSource: Buffer | null; background: { uniform: boolean; color: [number, number, number]; stdev: number }; flags: OutputFlag[]; sourceMime: string }
export interface Matte { alpha: Buffer; width: number; height: number; model: string; ms: number; source: "model" | "alpha_source" | "floodfill"; target: "cpu" | "gpu" | null; sentLongSide: number | null }
export interface BBox { x: number; y: number; w: number; h: number }
export interface CanvasPlan { w: number; h: number; lowResolution: boolean; safeBox: BBox; scale: number; placedX: number; placedY: number; detailShot: boolean; sourceBox?: BBox; productBox?: BBox }
export interface RenderInput { prepared: Prepared; matte: Matte; channel: ChannelId; shotNumber: number; productType: ProductType; uniformScale?: number; identifier?: string; publicObjectPath?: string; /** false forbids a synthesised shadow (05 rule 3); absent leaves the product-type rule. */ synthesiseShadow?: boolean }
export interface RenderOutput { jpeg: Buffer | null; status: "ok" | "skipped" | "failed"; plan: CanvasPlan; quality: number; bytes: number; flags: OutputFlag[]; notes: string[]; attention: { why: string; what: string } | null; compliance: { ok: boolean; failures: string[] } }
export interface RenderKeyInputs { sourceSha256: string; channel: ChannelId; rulesVersion: string; policyId: string; policyUpdatedAt: string; n: number }

export { ALPHA_BBOX_THRESHOLD } from "./shadow";
export class UnsupportedSourceError extends Error { readonly flags: OutputFlag[] = ["unsupported"]; }

export async function prepare(buf: Buffer, originalName: string, convert: (buf: Buffer) => Promise<Buffer>): Promise<Prepared> {
  let mime: string | undefined;
  try { mime = (await fileTypeFromBuffer(buf))?.mime; } catch { /* Report malformed signatures as corrupt sources. */ }
  if (mime === "image/bmp" || buf.subarray(0, 2).toString() === "BM") throw new UnsupportedSourceError(`${originalName} is a BMP file. Save it as JPEG or PNG and add it again.`);
  try {
    if (!mime?.startsWith("image/")) throw new Error("Unknown image format");
    if (/hei[cf]/.test(mime)) { buf = await convert(buf); mime = "image/heic"; }
    const { data, info } = await sharp(buf, { pages: 1, failOn: "warning", autoOrient: true }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgb = Buffer.alloc(info.width * info.height * 3), alpha = Buffer.alloc(info.width * info.height);
    let transparent = false;
    for (let i = 0; i < alpha.length; i++) { data.copy(rgb, i * 3, i * 4, i * 4 + 3); alpha[i] = data[i * 4 + 3]!; transparent ||= alpha[i]! < 255; }
    const flags: OutputFlag[] = [];
    if (transparent) flags.push("alpha_source");
    if (Math.max(info.width, info.height) < MIN_SOURCE_LONG_SIDE_PX) flags.push("small_source");
    return { width: info.width, height: info.height, rgb, alphaSource: transparent ? alpha : null, background: analyseBackground(rgb, info.width, info.height), flags, sourceMime: mime };
  } catch { throw new UnsupportedSourceError(`${originalName} is corrupt (cannot be decoded).`); }
}

export function bbox(alpha: Buffer, width: number, height: number, threshold = ALPHA_BBOX_THRESHOLD): BBox | null {
  if (alpha.length !== width * height) throw new Error("Matte dimensions do not match its alpha pixels");
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[y * width + x]! > threshold) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function safeBoxFor(spec: ChannelSpec, canvas: Size, wide: boolean): BBox {
  const m = spec.margins, horizontal = !m.sidesOnlyWhenWide || wide;
  const left = horizontal ? Math.ceil(m.left * (m.unit === "fraction" ? canvas.w : 1)) : 0;
  const right = horizontal ? Math.ceil(m.right * (m.unit === "fraction" ? canvas.w : 1)) : 0;
  const top = Math.ceil(m.top * (m.unit === "fraction" ? canvas.h : 1));
  const bottom = Math.ceil(m.bottom * (m.unit === "fraction" ? canvas.h : 1));
  return { x: left, y: top, w: canvas.w - left - right, h: canvas.h - top - bottom };
}

export function effectiveMinimum(spec: ChannelSpec): Size {
  if (spec.fixedCanvas) return spec.targetCanvas;
  const fraction = Math.max(spec.minCanvas.w / spec.targetCanvas.w, spec.minCanvas.h / spec.targetCanvas.h);
  let size = proportionalCanvas(spec, fraction, true);
  while (size.h < spec.minCanvas.h || size.w < spec.minCanvas.w) size = proportionalCanvas(spec, (size.w + 2) / spec.targetCanvas.w, true);
  return size;
}

function proportionalCanvas(spec: ChannelSpec, fraction: number, roundUp: boolean): Size {
  const even = (n: number) => (roundUp ? Math.ceil(n / 2) : Math.floor(n / 2)) * 2;
  const w = Math.min(Math.floor(spec.targetCanvas.w / 2) * 2, even(spec.targetCanvas.w * fraction));
  const h = Math.min(Math.floor(spec.targetCanvas.h / 2) * 2, Math.round(w * spec.targetCanvas.h / spec.targetCanvas.w / 2) * 2);
  return { w, h };
}

export function planCanvas(spec: ChannelSpec, box: BBox, source: Size, opts: { uniformScale?: number }): CanvasPlan {
  const fit = (size: Size) => { const safe = safeBoxFor(spec, size, box.w > box.h); return Math.min(safe.w / box.w, safe.h / box.h); };
  const min = effectiveMinimum(spec), target = spec.targetCanvas;
  const lowResolution = fit(min) > MAX_UPSCALE;
  let size = target;
  if (!spec.fixedCanvas) {
    const fraction = Math.max(min.w / target.w, min.h / target.h, Math.min(1, MAX_UPSCALE / fit(target)));
    size = lowResolution ? min : proportionalCanvas(spec, fraction, false);
    if (size.w < min.w || size.h < min.h) size = min;
    while (!lowResolution && fit(size) > MAX_UPSCALE && size.w > min.w) size = proportionalCanvas(spec, (size.w - 2) / target.w, false);
  }
  const safeBox = safeBoxFor(spec, size, box.w > box.h);
  const detailShot = box.w / source.w > DETAIL_SHOT_BBOX_FRACTION || box.h / source.h > DETAIL_SHOT_BBOX_FRACTION;
  const scale = Math.min(fit(size), spec.uniformScaleDefault && !detailShot ? opts.uniformScale ?? Infinity : Infinity);
  const w = Math.max(1, Math.min(safeBox.w, Math.round(box.w * scale))), h = Math.max(1, Math.min(safeBox.h, Math.round(box.h * scale)));
  const placedX = safeBox.x + Math.round((safeBox.w - w) / 2), placedY = safeBox.y + (spec.anchor === "bottom-centre" ? safeBox.h - h : Math.round((safeBox.h - h) / 2));
  return { ...size, safeBox, lowResolution, scale, placedX, placedY, detailShot, sourceBox: box, productBox: { x: placedX, y: placedY, w, h } };
}

export function planProduct(spec: ChannelSpec, shots: { box: BBox; source: Size }[]): { uniformScale: number } {
  const fits = shots.map(s => planCanvas(spec, s.box, s.source, {})).filter(p => !p.detailShot).map(p => p.scale);
  return { uniformScale: fits.length ? Math.min(...fits) : 1 };
}

export async function renderSource(input: RenderInput): Promise<RenderOutput> {
  const { prepared: p, matte, shotNumber } = input, spec = channel(input.channel);
  if (matte.width !== p.width || matte.height !== p.height) throw new Error("Matte and source dimensions must match");
  const box = bbox(matte.alpha, p.width, p.height);
  const plan = planCanvas(spec, box ?? { x: 0, y: 0, w: p.width, h: p.height }, { w: p.width, h: p.height }, input);
  const result: RenderOutput = { jpeg: null, status: "failed", plan, quality: JPEG_QUALITY_START, bytes: 0, flags: [...p.flags], notes: [], attention: null, compliance: { ok: false, failures: [] } };
  if (!box) { result.notes.push("No product was found in this photo."); return result; }
  if (matte.source === "floodfill") result.flags.push("fallback_matte");
  if (plan.lowResolution) {
    result.flags.push("low_resolution");
    if (spec.id === "styli" && STYLI_SKIP_LOW_RESOLUTION) { result.status = "skipped"; result.notes.push("Skipped for Styli: the photo is smaller than Styli needs."); return result; }
    const min = spec.id === "trendyol" ? effectiveMinimum(spec) : spec.minCanvas;
    result.attention = { why: `The original is ${p.width} x ${p.height}. ${spec.label} wants at least ${min.h > min.w ? min.h : min.w} px, so this one may look soft.`, what: "It will upload, but ask the brand for a larger photo if you can. The other marketplaces are fine with it." };
  }
  if (spec.uniformScaleDefault && !plan.detailShot && input.uniformScale !== undefined && input.uniformScale > plan.scale) result.notes.push("Could not keep the same size as the other angles without cutting; fitted instead");
  const color = backgroundFor(spec.id, shotNumber), product = plan.productBox!;
  const rgbColor = hexColor(color);
  const passthrough = p.sourceMime === "image/jpeg" && !p.alphaSource && p.width === plan.w && p.height === plan.h && box.x >= plan.safeBox.x && box.y >= plan.safeBox.y && box.x + box.w <= plan.safeBox.x + plan.safeBox.w && box.y + box.h <= plan.safeBox.y + plan.safeBox.h && borderPixels(p.width, p.height).every(i => rgbColor.every((v, c) => Math.abs(p.rgb[i * 3 + c]! - v) <= BG_TOLERANCE));
  let image: Buffer;
  const foregroundMask = Buffer.alloc(plan.w * plan.h);
  if (passthrough) {
    result.flags.push("passthrough"); image = await sharp(p.rgb, { raw: { width: p.width, height: p.height, channels: 3 } }).png().toBuffer();
    plan.productBox = { ...box }; plan.placedX = box.x; plan.placedY = box.y;
    matte.alpha.copy(foregroundMask);
  } else {
    const rgba = Buffer.alloc(p.width * p.height * 4);
    for (let i = 0; i < matte.alpha.length; i++) { p.rgb.copy(rgba, i * 4, i * 3, i * 3 + 3); rgba[i * 4 + 3] = matte.alpha[i]!; }
    const cutout = await sharp(rgba, { raw: { width: p.width, height: p.height, channels: 4 } }).extract({ left: box.x, top: box.y, width: box.w, height: box.h }).resize(product.w, product.h, { kernel: "lanczos3" }).png().toBuffer();
    const cutoutAlpha = await sharp(cutout).extractChannel(3).raw().toBuffer();
    for (let y = 0; y < product.h; y++) cutoutAlpha.copy(foregroundMask, (product.y + y) * plan.w + product.x, y * product.w, (y + 1) * product.w);
    let shadow = await shadowLayer(p, matte, box, plan, input.productType, color, foregroundMask);
    if (input.synthesiseShadow === false && shadow.flags.includes("shadow_synthesised")) shadow = { layer: null, flags: ["no_shadow_source"] };
    result.flags.push(...shadow.flags);
    image = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: color } }).composite([...(shadow.layer ? [{ input: shadow.layer, blend: "multiply" as const }] : []), { input: cutout, left: product.x, top: product.y, blend: "over" }]).png().toBuffer();
  }
  let jpeg: Buffer = Buffer.alloc(0);
  for (let quality = JPEG_QUALITY_START; quality >= JPEG_QUALITY_MIN; quality -= JPEG_QUALITY_STEP) {
    result.quality = quality;
    jpeg = await sharp(image).withDensity(spec.dpi).withIccProfile("srgb").jpeg({ quality, chromaSubsampling: "4:4:4" }).toBuffer();
    if (jpeg.length <= MAX_OUTPUT_BYTES) break;
  }
  result.bytes = jpeg.length;
  const identifier = input.identifier ?? "photo";
  result.compliance = await checkOutput({ jpeg, channel: spec.id, shotNumber, plan, identifier, n: shotNumber, publicObjectPath: input.publicObjectPath ?? `${encodeURIComponent(identifier)}_${shotNumber}.jpg`, foregroundMask });
  if (!result.compliance.ok) { result.flags.push("failed_compliance"); result.notes.push(...result.compliance.failures); return result; }
  result.jpeg = jpeg; result.status = "ok";
  return result;
}

export async function renderAllChannels(prepared: Prepared, matte: Matte, channels: ChannelId[], ctx: Omit<RenderInput, "prepared" | "matte" | "channel">): Promise<Record<ChannelId, RenderOutput>> {
  const outputs = {} as Record<ChannelId, RenderOutput>;
  for (const id of channels) outputs[id] = await renderSource({ ...ctx, prepared, matte, channel: id });
  return outputs;
}
export function renderKeyInputs(i: RenderKeyInputs): string { return `${i.sourceSha256}|${i.channel}|${i.rulesVersion}|${i.policyId}+${i.policyUpdatedAt}|${i.n}`; }
export function hexColor(value: string): [number, number, number] { return [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16)) as [number, number, number]; }
