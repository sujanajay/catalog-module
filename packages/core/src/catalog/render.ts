import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { backgroundFor, channel, DETAIL_SHOT_BBOX_FRACTION, JPEG_QUALITY_MIN, JPEG_QUALITY_START, JPEG_QUALITY_STEP, MAX_OUTPUT_BYTES, MAX_UPSCALE, MIN_SOURCE_LONG_SIDE_PX, STYLI_SKIP_LOW_RESOLUTION, type ChannelSpec, type Size } from "./channels";
import type { ChannelId, OutputFlag, ProductType } from "./types";
import { ALPHA_BBOX_THRESHOLD, analyseBackground, borderPixels, shadowLayer } from "./shadow";
import { BG_TOLERANCE, checkOutput } from "./compliance";

export interface Prepared { width: number; height: number; rgb: Buffer; alphaSource: Buffer | null; background: { uniform: boolean; color: [number, number, number]; stdev: number }; flags: OutputFlag[]; sourceMime: string }
export interface Matte { alpha: Buffer; width: number; height: number; model: string; ms: number; source: "model" | "alpha_source" | "floodfill"; target: "cpu" | "gpu" | null; sentLongSide: number | null }
export interface BBox { x: number; y: number; w: number; h: number }
export interface CanvasPlan { w: number; h: number; lowResolution: boolean; safeBox: BBox; scale: number; placedX: number; placedY: number; detailShot: boolean; sourceBox?: BBox; productBox?: BBox; cut?: CutEdges }
/** `canvas`: the product's one canvas on this channel (planProduct), so every angle shares one size. */
export interface RenderInput { prepared: Prepared; matte: Matte; channel: ChannelId; shotNumber: number; productType: ProductType; uniformScale?: number; canvas?: Size; identifier?: string; publicObjectPath?: string; /** false forbids a synthesised shadow (05 rule 3); absent leaves the product-type rule. */ synthesiseShadow?: boolean;
  /** Below 1 shrinks the fitted product by this factor (the auto-resolve ladder's smaller fit); absent is 1. */ fitScale?: number;
  /** The judge saw a cut at the frame edge that the cut rule missed: shotGeometry relaxes its truncation share. */ judgedCut?: boolean }
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

/** Sides where the product was already cut in the source photo (see shotGeometry). */
export interface CutEdges { top: boolean; bottom: boolean; left: boolean; right: boolean }
export const NO_CUT: CutEdges = Object.freeze({ top: false, bottom: false, left: false, right: false });
export const anyCut = (cut: CutEdges | undefined): boolean => !!cut && (cut.top || cut.bottom || cut.left || cut.right);
/** Mattes peak at 254-255 inside the product, so a cut line counts as opaque from this alpha. */
export const CUT_EDGE_OPAQUE_ALPHA = 250;
/** A pad line (the brand's band around the real photo) is a frame line this uniform ... */
export const CUT_EDGE_PAD_STDEV = 6;
/** ... whose mean colour stays within this distance per channel of the outermost line (any colour, not only white). */
export const CUT_EDGE_PAD_TOLERANCE = 10;
/** A pad the colour of the photo's own background is told apart only as the thin border: this fraction of the frame. */
export const CUT_EDGE_BORDER_FRACTION = 0.03;
export const CUT_EDGE_BORDER_MIN_PX = 4;
/** A pad that ends on a photo of another background colour (a letterbox) may be this deep. */
export const CUT_EDGE_PAD_MAX_FRACTION = 0.15;
/** A perpendicular band's inner line shows the photo starting within this many px of a band's inner edge: the photo's corner. */
export const CUT_EDGE_LETTERBOX_TOLERANCE_PX = 4;
/** The cut line may sit this far inside the pad's inner edge: the matte's soft fade into the pad. */
export const CUT_EDGE_FRINGE_FRACTION = 0.01;
export const CUT_EDGE_FRINGE_MIN_PX = 6;
/** Signal 1, a straight edge: the opaque matte starts on one line, allowing this much jitter inwards ... */
export const CUT_EDGE_JITTER_PX = 2;
/** ... over at least one run this long (a fraction of the frame side, with a floor in px). */
export const CUT_EDGE_MIN_STRAIGHT_FRACTION = 0.02;
export const CUT_EDGE_MIN_STRAIGHT_PX = 8;
/** Signal 2, a truncated silhouette: the straight edge holds this share of the silhouette width ... */
export const CUT_EDGE_TRUNCATION_RATIO = 0.6;
/** ... measured this many lines further in (a foot or a rounded hem narrows towards its edge; a cut does not). */
export const CUT_EDGE_INSET_PX = 10;
/**
 * Where the band is the colour of the photo's own background (no visible photo edge), the edge must also hold
 * this share of the product box side: the lowest shoe of a standing model (10-17% measured) is flat over
 * 10 lines like a cut, while two shins or a hem cut at the frame span a third or more.
 */
export const CUT_EDGE_MIN_SHARE = 0.2;
/** The relaxed share when the judge saw a cut at the frame edge that the rule missed. */
export const CUT_EDGE_JUDGED_RATIO = 0.4;

type Side = "top" | "bottom" | "left" | "right";
const SIDES: readonly Side[] = ["top", "bottom", "left", "right"];

export interface ShotGeometry { box: BBox; source: Size; cut: CutEdges }
export interface ShotGeometryOptions {
  /** The source pixels (RGB, 3 bytes per pixel): finds the pad band around the real photo. Without them only the thin border counts. */
  rgb?: Buffer | undefined;
  /**
   * The judge saw a cut at the frame edge that the rule missed: the truncation share drops to CUT_EDGE_JUDGED_RATIO and
   * a deep band of the photo's own background colour counts as a pad.
   */
  judgedCut?: boolean | undefined;
}

/** Pixel index of position `i` along the frame line at depth `d` from `side`. */
function lineIndex(side: Side, d: number, i: number, width: number, height: number): number {
  return side === "top" ? d * width + i : side === "bottom" ? (height - 1 - d) * width + i : side === "left" ? i * width + d : i * width + (width - 1 - d);
}

/**
 * The pad band on each side: the outermost frame lines that are uniform (CUT_EDGE_PAD_STDEV) and the
 * colour of the outermost line (CUT_EDGE_PAD_TOLERANCE), any colour. `photoEdge` is true when the
 * band ends on a photo whose own background (where the matte is transparent, between the other
 * sides' bands) is another colour, or on a line the product fills, or when the outermost line is
 * not uniform at all: the band's inner edge is then the real photo's frame edge.
 */
export function padBands(rgb: Buffer, alpha: Buffer, width: number, height: number): Record<Side, { depth: number; photoEdge: boolean }> {
  const depths = {} as Record<Side, { depth: number; colour: number[] | null; max: number }>;
  for (const side of SIDES) {
    const horizontal = side === "top" || side === "bottom", length = horizontal ? width : height, max = Math.floor((horizontal ? height : width) * CUT_EDGE_PAD_MAX_FRACTION);
    const lineStats = (d: number) => {
      const sum = [0, 0, 0], squares = [0, 0, 0];
      for (let i = 0; i < length; i++) { const p = lineIndex(side, d, i, width, height) * 3; for (let c = 0; c < 3; c++) { const v = rgb[p + c]!; sum[c]! += v; squares[c]! += v * v; } }
      const mean = sum.map(t => t / length), variance = squares.reduce((t, q, c) => t + q / length - mean[c]! ** 2, 0) / 3;
      return { mean, stdev: Math.sqrt(Math.max(0, variance)) };
    };
    const outer = lineStats(0);
    if (outer.stdev > CUT_EDGE_PAD_STDEV) { depths[side] = { depth: 0, colour: null, max }; continue; }
    let depth = 1;
    for (; depth <= max; depth++) { const line = lineStats(depth); if (line.stdev > CUT_EDGE_PAD_STDEV || line.mean.some((v, c) => Math.abs(v - outer.mean[c]!) > CUT_EDGE_PAD_TOLERANCE)) break; }
    depths[side] = { depth, colour: outer.mean, max };
  }
  const result = {} as Record<Side, { depth: number; photoEdge: boolean }>;
  for (const side of SIDES) {
    const { depth, colour, max } = depths[side], horizontal = side === "top" || side === "bottom";
    if (!colour) { result[side] = { depth, photoEdge: true }; continue; }
    if (depth > max) { result[side] = { depth, photoEdge: false }; continue; }
    // Two lines in, past the JPEG blend of the pad edge, between the other sides' bands: the photo's own background.
    const [a, b] = horizontal ? [depths.left, depths.right] : [depths.top, depths.bottom], length = horizontal ? width : height;
    // Only thin perpendicular bands are skipped: a deeper one may end on the product itself, not on the photo.
    const qThin = Math.max(CUT_EDGE_BORDER_MIN_PX, Math.ceil(length * CUT_EDGE_BORDER_FRACTION));
    const from = a.depth <= qThin ? a.depth : 0, to = length - (b.depth <= qThin ? b.depth : 0);
    const probe = Math.min((horizontal ? height : width) - 1, depth + 2), background = [0, 0, 0];
    let count = 0;
    for (let i = from; i < to; i++) { const k = lineIndex(side, probe, i, width, height); if (alpha[k]! <= ALPHA_BBOX_THRESHOLD) { count++; for (let c = 0; c < 3; c++) background[c]! += rgb[k * 3 + c]!; } }
    const differs = count < (to - from) * 0.1 || background.some((t, c) => Math.abs(t / count - colour[c]!) > CUT_EDGE_PAD_TOLERANCE);
    // Or a thin perpendicular band's inner line shows the photo starting exactly here: the photo's corner.
    const corner = (horizontal ? [depths.left, depths.right] : [depths.top, depths.bottom]).some((q, k) => {
      if (q.depth < 1 || q.depth > qThin || !q.colour) return false;
      const qSide: Side = horizontal ? (k ? "right" : "left") : (k ? "bottom" : "top"), qDepth = Math.min(q.depth + 2, (horizontal ? width : height) - 1);
      const content = (p: number) => { const at = horizontal ? (side === "top" ? p : height - 1 - p) : (side === "left" ? p : width - 1 - p); const k2 = lineIndex(qSide, qDepth, at, width, height) * 3; return colour.some((v, c) => Math.abs(rgb[k2 + c]! - v) > CUT_EDGE_PAD_TOLERANCE); };
      for (let p = 0; p <= max + CUT_EDGE_LETTERBOX_TOLERANCE_PX; p++) if (content(p) && content(p + 1) && content(p + 2) && content(p + 3)) return Math.abs(p - depth) <= CUT_EDGE_LETTERBOX_TOLERANCE_PX;
      return false;
    });
    result[side] = { depth, photoEdge: differs || corner };
  }
  return result;
}

/**
 * The product box of a shot and the edges where the product was already cut in the source (a model
 * cut mid-shin, a head-and-shoulders crop). Per side:
 * 1. The pad band (padBands): brands often place the real photo inside a uniform band of any colour.
 *    A side can be cut only where the product reaches the band's inner edge (the frame edge when
 *    there is no band), allowing the matte's soft fade (CUT_EDGE_FRINGE_FRACTION). A band the colour
 *    of the photo's own background counts only as the thin border (CUT_EDGE_BORDER_FRACTION).
 * 2. Two signals on the first product line inside the band, stepping inwards through the fade: a
 *    straight edge (a run of opaque matte, alpha >= CUT_EDGE_OPAQUE_ALPHA, starting on that line
 *    within CUT_EDGE_JITTER_PX, at least CUT_EDGE_MIN_STRAIGHT_FRACTION of the side long) AND a
 *    truncated silhouette (the straight edge holds at least CUT_EDGE_TRUNCATION_RATIO of the
 *    silhouette width CUT_EDGE_INSET_PX lines further in; CUT_EDGE_JUDGED_RATIO with
 *    `opts.judgedCut`). A foot or a rounded hem narrows towards its edge and fails the second
 *    signal; two legs cut at the knee pass both.
 * The box is trimmed to the cut line, so the hard cut, not the matte's fade beyond it, meets the
 * canvas edge. Nothing of the product inside the cut line is removed.
 */
export function shotGeometry(alpha: Buffer, width: number, height: number, opts: ShotGeometryOptions = {}): ShotGeometry | null {
  const tight = bbox(alpha, width, height);
  if (!tight) return null;
  const cut = { ...NO_CUT }, ratio = opts.judgedCut ? CUT_EDGE_JUDGED_RATIO : CUT_EDGE_TRUNCATION_RATIO;
  const fringe = Math.max(CUT_EDGE_FRINGE_MIN_PX, Math.ceil(Math.max(width, height) * CUT_EDGE_FRINGE_FRACTION));
  // Depth of the product box edge from each frame edge; a cut side moves to its cut line.
  const pads = opts.rgb ? padBands(opts.rgb, alpha, width, height) : null;
  const lines: Record<Side, number> = { top: tight.y, bottom: height - tight.y - tight.h, left: tight.x, right: width - tight.x - tight.w };
  for (const side of SIDES) {
    const horizontal = side === "top" || side === "bottom", across = horizontal ? height : width, outer = lines[side];
    const from = horizontal ? tight.x : tight.y, to = horizontal ? tight.x + tight.w : tight.y + tight.h;
    const thin = Math.max(CUT_EDGE_BORDER_MIN_PX, Math.ceil(across * CUT_EDGE_BORDER_FRACTION));
    const pad = pads?.[side] ?? { depth: Math.min(outer, thin), photoEdge: false };
    // A band deeper than the thin border is a pad only when it ends on the real photo's edge (padBands), or when the
    // judge saw the cut: a cut-out on white with nothing but the product's own straight edge to show the photo ended.
    if (pad.depth > thin && !((pad.photoEdge || opts.judgedCut) && pad.depth <= across * CUT_EDGE_PAD_MAX_FRACTION)) continue;
    if (outer > pad.depth + fringe) continue;
    const at = (d: number, i: number) => alpha[lineIndex(side, d, i, width, height)]!;
    const minStraight = Math.max(CUT_EDGE_MIN_STRAIGHT_PX, Math.ceil((horizontal ? width : height) * CUT_EDGE_MIN_STRAIGHT_FRACTION));
    const last = across - 1;
    // Per position along the side: where the silhouette starts (alpha above half) and where the matte
    // turns opaque behind it (the soft fade); Infinity when not within the search depth.
    const half = new Float64Array(to - from).fill(Infinity), solid = new Float64Array(to - from).fill(Infinity);
    for (let i = from; i < to; i++) {
      let d = outer;
      for (; d <= Math.min(outer + fringe, last); d++) if (at(d, i) > 127) { half[i - from] = d; break; }
      if (Number.isFinite(half[i - from]!)) for (; d <= Math.min(half[i - from]! + fringe, last); d++) if (at(d, i) >= CUT_EDGE_OPAQUE_ALPHA) { solid[i - from] = d; break; }
    }
    const line = Math.min(...half);
    if (!Number.isFinite(line) || line + CUT_EDGE_INSET_PX > last) continue;
    // Signal 1: positions whose silhouette starts on the outermost line (within the jitter) and turns opaque behind it.
    let edge = 0, run = 0, longest = 0, silhouette = 0;
    const solids: number[] = [];
    for (let i = from; i < to; i++) {
      if (half[i - from]! <= line + CUT_EDGE_JITTER_PX && Number.isFinite(solid[i - from]!)) { edge++; run++; longest = Math.max(longest, run); solids.push(solid[i - from]!); } else run = 0;
      if (at(line + CUT_EDGE_INSET_PX, i) > 127) silhouette++;
    }
    // Signal 2: the edge holds most of the silhouette further in. The box is trimmed to where the cut turns opaque.
    // Without a photo edge (the band is the photo's own background colour) a flat sole looks the same over 10 lines:
    // the edge must also span CUT_EDGE_MIN_SHARE of the product box there.
    const share = pad.photoEdge ? 0 : CUT_EDGE_MIN_SHARE * (to - from);
    if (longest >= minStraight && edge >= silhouette * ratio && edge >= share) { cut[side] = true; lines[side] = solids.sort((a, b) => a - b)[solids.length >> 1]!; }
  }
  const box = { x: lines.left, y: lines.top, w: width - lines.left - lines.right, h: height - lines.top - lines.bottom };
  return { box: box.w > 0 && box.h > 0 ? box : tight, source: { w: width, h: height }, cut };
}

/** The canvas minus the channel's margins; a side cut in the source gets margin 0 so the cut sits flush with the canvas edge. */
export function safeBoxFor(spec: ChannelSpec, canvas: Size, wide: boolean, cut: CutEdges = NO_CUT): BBox {
  const m = spec.margins, horizontal = !m.sidesOnlyWhenWide || wide;
  const left = horizontal && !cut.left ? Math.ceil(m.left * (m.unit === "fraction" ? canvas.w : 1)) : 0;
  const right = horizontal && !cut.right ? Math.ceil(m.right * (m.unit === "fraction" ? canvas.w : 1)) : 0;
  const top = cut.top ? 0 : Math.ceil(m.top * (m.unit === "fraction" ? canvas.h : 1));
  const bottom = cut.bottom ? 0 : Math.ceil(m.bottom * (m.unit === "fraction" ? canvas.h : 1));
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

/**
 * `opts.canvas` (planProduct) raises an adaptive canvas to the product's one canvas on this channel;
 * `opts.cut` places each cut side flush with the canvas edge (margin 0 there, other margins kept);
 * `opts.fitScale` (below 1) shrinks the product by that factor inside the same canvas.
 */
export function planCanvas(spec: ChannelSpec, box: BBox, source: Size, opts: { uniformScale?: number | undefined; canvas?: Size | undefined; cut?: CutEdges | undefined; fitScale?: number | undefined }): CanvasPlan {
  const cut = opts.cut ?? NO_CUT, wide = box.w > box.h;
  const fit = (size: Size) => { const safe = safeBoxFor(spec, size, wide, cut); return Math.min(safe.w / box.w, safe.h / box.h); };
  const min = effectiveMinimum(spec), target = spec.targetCanvas;
  const lowResolution = fit(min) > MAX_UPSCALE;
  let size = target;
  if (!spec.fixedCanvas) {
    const fraction = Math.max(min.w / target.w, min.h / target.h, Math.min(1, MAX_UPSCALE / fit(target)));
    size = lowResolution ? min : proportionalCanvas(spec, fraction, false);
    if (size.w < min.w || size.h < min.h) size = min;
    while (!lowResolution && fit(size) > MAX_UPSCALE && size.w > min.w) size = proportionalCanvas(spec, (size.w - 2) / target.w, false);
    if (opts.canvas && opts.canvas.w > size.w && opts.canvas.w <= target.w && opts.canvas.h <= target.h) size = { w: opts.canvas.w, h: opts.canvas.h };
  }
  const safeBox = safeBoxFor(spec, size, wide, cut);
  const detailShot = box.w / source.w > DETAIL_SHOT_BBOX_FRACTION || box.h / source.h > DETAIL_SHOT_BBOX_FRACTION;
  // `fitScale` (below 1) shrinks the product inside the same canvas; anchoring and cut edges are unchanged.
  const scale = Math.min(fit(size), spec.uniformScaleDefault && !detailShot ? opts.uniformScale ?? Infinity : Infinity) * Math.min(1, opts.fitScale ?? 1);
  const w = Math.max(1, Math.min(safeBox.w, Math.round(box.w * scale))), h = Math.max(1, Math.min(safeBox.h, Math.round(box.h * scale)));
  // A cut side is anchored to its canvas edge; with both opposite sides cut, the bottom wins vertically and the product stays centred horizontally.
  const placedX = safeBox.x + (cut.left && !cut.right ? 0 : cut.right && !cut.left ? safeBox.w - w : Math.round((safeBox.w - w) / 2));
  const placedY = safeBox.y + (cut.bottom || (!cut.top && spec.anchor === "bottom-centre") ? safeBox.h - h : cut.top ? 0 : Math.round((safeBox.h - h) / 2));
  return { ...size, safeBox, lowResolution, scale, placedX, placedY, detailShot, sourceBox: box, productBox: { x: placedX, y: placedY, w, h }, cut: { ...cut } };
}

/**
 * One plan per product and channel: `uniformScale` (min fit over non-detail shots, used where
 * `uniformScaleDefault`) and `canvas`, the largest canvas the formula gives any of the product's
 * shots (never above the target), so every angle of a product shares one size on a channel.
 */
export function planProduct(spec: ChannelSpec, shots: { box: BBox; source: Size; cut?: CutEdges }[]): { uniformScale: number; canvas: Size } {
  const plans = shots.map(s => planCanvas(spec, s.box, s.source, { cut: s.cut }));
  const fits = plans.filter(p => !p.detailShot).map(p => p.scale);
  const canvas = plans.reduce<Size>((most, p) => (p.w > most.w ? { w: p.w, h: p.h } : most), { w: 0, h: 0 });
  return { uniformScale: fits.length ? Math.min(...fits) : 1, canvas: canvas.w ? canvas : spec.targetCanvas };
}

export async function renderSource(input: RenderInput): Promise<RenderOutput> {
  const { prepared: p, matte, shotNumber } = input, spec = channel(input.channel);
  if (matte.width !== p.width || matte.height !== p.height) throw new Error("Matte and source dimensions must match");
  const geometry = shotGeometry(matte.alpha, p.width, p.height, { rgb: p.rgb, judgedCut: input.judgedCut }), box = geometry?.box ?? null, cut = geometry?.cut ?? NO_CUT;
  const plan = planCanvas(spec, box ?? { x: 0, y: 0, w: p.width, h: p.height }, { w: p.width, h: p.height }, { uniformScale: input.uniformScale, canvas: input.canvas, cut, fitScale: input.fitScale });
  const result: RenderOutput = { jpeg: null, status: "failed", plan, quality: JPEG_QUALITY_START, bytes: 0, flags: [...p.flags], notes: [], attention: null, compliance: { ok: false, failures: [] } };
  if (!box) { result.notes.push("No product was found in this photo."); return result; }
  if (matte.source === "floodfill") result.flags.push("fallback_matte");
  if (anyCut(cut)) result.flags.push("cut_in_source");
  if (plan.lowResolution) {
    result.flags.push("low_resolution");
    if (spec.id === "styli" && STYLI_SKIP_LOW_RESOLUTION) { result.status = "skipped"; result.notes.push("Skipped for Styli: the photo is smaller than Styli needs."); return result; }
    const min = spec.id === "trendyol" ? effectiveMinimum(spec) : spec.minCanvas;
    result.attention = { why: `The original is ${p.width} x ${p.height}. ${spec.label} wants at least ${min.h > min.w ? min.h : min.w} px, so this one may look soft.`, what: "It will upload, but ask the brand for a larger photo if you can. The other marketplaces are fine with it." };
  }
  if (spec.uniformScaleDefault && !plan.detailShot && input.uniformScale !== undefined && input.uniformScale > plan.scale) result.notes.push("Could not keep the same size as the other angles without cutting; fitted instead");
  const color = backgroundFor(spec.id, shotNumber), product = plan.productBox!;
  const rgbColor = hexColor(color);
  const passthrough = p.sourceMime === "image/jpeg" && !p.alphaSource && !anyCut(cut) && (input.fitScale ?? 1) >= 1 && p.width === plan.w && p.height === plan.h && box.x >= plan.safeBox.x && box.y >= plan.safeBox.y && box.x + box.w <= plan.safeBox.x + plan.safeBox.w && box.y + box.h <= plan.safeBox.y + plan.safeBox.h && borderPixels(p.width, p.height).every(i => rgbColor.every((v, c) => Math.abs(p.rgb[i * 3 + c]! - v) <= BG_TOLERANCE));
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
    // Never a synthesised contact shadow on a photo cut in the source on any side (a bag held in a cropped hand, a
    // close-up filling the photo): nothing stands on a floor there, and the shadow below makes the centred product
    // look off-centre.
    if ((input.synthesiseShadow === false || anyCut(cut)) && shadow.flags.includes("shadow_synthesised")) shadow = { layer: null, flags: ["no_shadow_source"] };
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
