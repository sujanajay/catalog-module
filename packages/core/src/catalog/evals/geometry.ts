// Geometry per channel against the channel table (spec 10 section 3): format, canvas, every edge
// pixel, margins, centring, nothing outside the allowed area, product pixels copied not regenerated.
import sharp from "sharp";
import { MAX_OUTPUT_BYTES } from "../channels";
import { effectiveMinimum } from "../render";
import { delta, dilate, dropSpecks, inBox, luma, maskBox, SPECK_PX, type Mask } from "./image";
import type { OutputContext } from "./context";
import { ALPHA_EDGE } from "./context";
import { judge, notRun, type CheckResult, type CheckSubject } from "./types";

/** A flat colour survives a quality-70 4:4:4 JPEG round trip within this per-channel error. */
export const EDGE_TOLERANCE = 8;
/** Pixels this far from the canvas colour are "not background" for the outside and margin checks. */
export const FOREGROUND_DELTA = 12;
/** JPEG ringing lives within this many pixels of the product edge. */
export const EDGE_RING_PX = 4;
/** The measured extent counts only clearly foreground pixels (compliance's BG_TOLERANCE), so ringing never widens it. */
export const EXTENT_DELTA = 24;
/** Placement tolerance for margins, centring and the measured extent (soft matte edges move the visible edge by a pixel or two). */
export const PLACEMENT_TOLERANCE_PX = 4;
/** A product pixel is where it should be when the output matches the source resampled there within this per-channel error (lanczos plus JPEG). */
export const SOURCE_MATCH_DELTA = 24;
/**
 * The measured extent may differ from the half-coverage box by PLACEMENT_TOLERANCE_PX plus one source pixel at the
 * output scale: the matte's soft edge straddles the half-coverage line by up to a source pixel on each side, and that
 * pixel is `scale` canvas pixels wide after resampling.
 */
export const extentTolerance = (scale: number) => PLACEMENT_TOLERANCE_PX + Math.ceil(scale);
/** Centring and anchoring move by half of what the extent moves, so their tolerance adds half a source pixel. */
export const centreTolerance = (scale: number) => PLACEMENT_TOLERANCE_PX + Math.ceil(scale / 2);
/** Product pixels must match the source within this mean per-channel error (lanczos + JPEG). */
export const COPY_MEAN_DELTA = 8;
/** Non-detail Styli shots of one product must share the scale within this ratio. */
export const UNIFORM_SCALE_TOLERANCE = 0.005;

const G = "geometry" as const;

export async function checkGeometry(ctx: OutputContext): Promise<CheckResult[]> {
  const { subject: s, spec, canvas, background, productBox, safeBox, product } = ctx;
  const who: CheckSubject = { identifier: s.identifier, n: s.n, channel: s.channel };
  const out: CheckResult[] = [];
  const meta = await sharp(s.jpeg).metadata();
  const formatProblems = [
    !s.jpeg.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && "magic bytes",
    meta.format !== "jpeg" && "format", meta.chromaSubsampling !== "4:4:4" && "chroma subsampling", meta.space !== "srgb" && "colour space",
    !meta.hasProfile && "ICC profile", meta.hasAlpha && "alpha channel", s.jpeg.length > MAX_OUTPUT_BYTES && "size over 2,000,000 bytes",
    meta.density !== spec.dpi && `density ${meta.density} (wants ${spec.dpi})`,
  ].filter((p): p is string => typeof p === "string");
  out.push(judge(!formatProblems.length, "geometry.format", G, who, formatProblems.join(", ") || "ok", "jpeg, 4:4:4, srgb, icc, no alpha, <= 2 MB, dpi", "", formatProblems.length ? `Format problems: ${formatProblems.join(", ")}.` : "sRGB JPEG 4:4:4 with ICC at the channel DPI, under 2 MB."));

  const min = effectiveMinimum(spec), target = spec.targetCanvas;
  const canvasOk = spec.fixedCanvas
    ? canvas.w === target.w && canvas.h === target.h
    : canvas.w >= min.w && canvas.h >= min.h && canvas.w <= target.w && canvas.h <= target.h && Math.abs(canvas.h - canvas.w * target.h / target.w) <= 1 && canvas.w % 2 === 0 && canvas.h % 2 === 0;
  out.push(judge(canvasOk && canvas.w === s.placement.w && canvas.h === s.placement.h, "geometry.canvas", G, who, `${canvas.w}x${canvas.h}`, spec.fixedCanvas ? `${target.w}x${target.h}` : `${min.w}x${min.h}..${target.w}x${target.h}, aspect ${target.w}:${target.h} within 1 px, even`, "px", spec.fixedCanvas ? "Fixed canvas must match exactly." : "Adaptive canvas must sit between the minimum and the target with the target aspect."));

  // Every edge pixel and the whole 2% border band must be background, unless the product itself sits there on a zero-margin side.
  const bx = Math.max(4, Math.ceil(canvas.w * 0.02)), by = Math.max(4, Math.ceil(canvas.h * 0.02));
  const zero = { top: safeBox.y === 0, bottom: safeBox.y + safeBox.h === canvas.h, left: safeBox.x === 0, right: safeBox.x + safeBox.w === canvas.w };
  const allowed = dilate(product, canvas.w, canvas.h, EDGE_RING_PX);
  let edgeBad = 0, edgeWorst = 0, bandBad = 0;
  const bandMask = new Uint8Array(canvas.w * canvas.h);
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
    const inBand = x < bx || y < by || x >= canvas.w - bx || y >= canvas.h - by;
    if (!inBand) continue;
    const i = y * canvas.w + x, d = delta(canvas.rgb, i, background);
    if (d <= EDGE_TOLERANCE) continue;
    const touching = (y < by && zero.top) || (y >= canvas.h - by && zero.bottom) || (x < bx && zero.left) || (x >= canvas.w - bx && zero.right);
    if (allowed[i] && touching) continue;
    bandMask[i] = 1;
  }
  // A lone ringing pixel next to a sharp product edge is not a dirty band; a line or a blob is.
  const bandBadMask = dropSpecks(bandMask, canvas.w, canvas.h, 4);
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
    const i = y * canvas.w + x;
    if (!bandBadMask[i]) continue;
    if (x === 0 || y === 0 || x === canvas.w - 1 || y === canvas.h - 1) { edgeBad++; edgeWorst = Math.max(edgeWorst, delta(canvas.rgb, i, background)); } else bandBad++;
  }
  out.push(judge(edgeBad === 0, "geometry.edges", G, who, edgeBad, 0, "edge pixels off background", edgeBad ? `${edgeBad} edge pixels differ from the background by up to ${edgeWorst} (tolerance ${EDGE_TOLERANCE}).` : "Every edge pixel is the channel background."));
  out.push(judge(bandBad === 0, "geometry.border_band", G, who, bandBad, 0, "band pixels off background", bandBad ? `${bandBad} pixels in the 2% border band are not background.` : "The border band is clean."));

  // Nothing but the product (and, where allowed, its shadow) outside the product's ring; nothing in the required margins.
  const ring = dilate(product, canvas.w, canvas.h, EDGE_RING_PX), outsideMask = new Uint8Array(canvas.w * canvas.h), safeMask = new Uint8Array(canvas.w * canvas.h);
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
    const i = y * canvas.w + x, d = delta(canvas.rgb, i, background);
    if (d <= FOREGROUND_DELTA) continue;
    // Darkening without colour is shadow; the shadow checks judge it, so it is not "outside the product" here.
    if (!inBox(safeBox, x, y) && (d > EXTENT_DELTA || !ring[i])) safeMask[i] = 1;
    if (!shadowLikePixel(ctx, i) && !ring[i]) outsideMask[i] = 1;
  }
  let outside = 0, outsideSafe = 0;
  for (const v of dropSpecks(outsideMask, canvas.w, canvas.h, SPECK_PX)) outside += v;
  for (const v of dropSpecks(safeMask, canvas.w, canvas.h, SPECK_PX)) outsideSafe += v;
  out.push(judge(outside === 0, "geometry.outside_product", G, who, outside, 0, "pixels", outside ? `${outside} non-background pixels lie outside the product${ctx.shadowAllowed ? " (shadow-like darkening excluded)" : ""}.` : "Nothing but the product and its shadow is on the canvas."));
  out.push(judge(outsideSafe === 0, "geometry.inside_safe_box", G, who, outsideSafe, 0, "pixels", outsideSafe ? `${outsideSafe} pixels reach into the required margins.` : "Nothing reaches into the required margins."));

  // Measured extent: the box of the product pixels that are visibly where the plan put them (visibleProduct), against the
  // box of the half-coverage mask. A white sole on a white canvas is present when it matches the source there; a vanished
  // coloured part is not.
  const visible = visibleProduct(ctx, ring), expected = maskBox(ctx.half, canvas.w, canvas.h), measured = maskBox(visible, canvas.w, canvas.h);
  if (!expected || !measured) {
    out.push(notRun("geometry.extent", G, who, "No product pixels were found on the canvas."));
    // No half-coverage pixel at all is a translucent or empty matte (eval run 3, penti: ZBE55F7B86F158FEA0EB9Z n=5 at alpha 40 to 60): nothing of the product was copied.
    if (!expected) out.push(judge(false, "geometry.pixels_copied", G, who, 0, 1, "opaque source pixels", "No opaque product pixels (alpha 250 or more) reach the canvas: the matte is translucent or empty, so nothing of the product was copied (eval run 3, penti: ZBE55F7B86F158FEA0EB9Z n=5 published as a ghost at effective alpha 0.22)."));
    return out;
  }
  const x0 = measured.x, y0 = measured.y, x1 = measured.x + measured.w - 1, y1 = measured.y + measured.h - 1;
  const sides = { left: Math.abs(x0 - expected.x), top: Math.abs(y0 - expected.y), right: Math.abs(x1 - (expected.x + expected.w - 1)), bottom: Math.abs(y1 - (expected.y + expected.h - 1)) };
  const extentWorst = Math.max(...Object.values(sides)), tolerance = extentTolerance(s.placement.scale);
  out.push(judge(extentWorst <= tolerance, "geometry.extent", G, who, extentWorst, tolerance, "px", `Measured product extent differs from the planned placement by up to ${extentWorst} px (left ${sides.left}, top ${sides.top}, right ${sides.right}, bottom ${sides.bottom}; tolerance ${PLACEMENT_TOLERANCE_PX} px plus a source pixel at scale ${s.placement.scale.toFixed(2)}).`));

  // Margins: the planned product box must respect every required margin (within 1 px of rounding).
  const m = { top: productBox.y, bottom: canvas.h - productBox.y - productBox.h, left: productBox.x, right: canvas.w - productBox.x - productBox.w };
  const need = { top: safeBox.y, bottom: canvas.h - safeBox.y - safeBox.h, left: safeBox.x, right: canvas.w - safeBox.x - safeBox.w };
  const short = (["top", "bottom", "left", "right"] as const).filter(side => m[side] < need[side] - 1);
  out.push(judge(!short.length, "geometry.margins", G, who, `t${m.top} b${m.bottom} l${m.left} r${m.right}`, `t${need.top} b${need.bottom} l${need.left} r${need.right}`, "px", short.length ? `Margins too small on ${short.join(", ")}.` : "Every required margin is kept."));

  // Centring and anchor from the measured extent (what a reviewer sees), not the plan. A side cut in the source is placed
  // flush with the canvas edge by rule (CHANNEL_RULES_VERSION 7), so centring on a cut axis is not a measurement.
  const measuredW = x1 - x0 + 1, measuredH = y1 - y0 + 1, centreTol = centreTolerance(s.placement.scale);
  const cutX = ctx.cut.left || ctx.cut.right, cutY = ctx.cut.top || ctx.cut.bottom;
  const centreOff = Math.abs((x0 + x1 + 1) / 2 - canvas.w / 2);
  const fullWidth = measuredW >= safeBox.w - 1;
  if (cutX) out.push(notRun("geometry.centred", G, who, "The product is cut at the left or right of the source and placed flush with that edge by rule."));
  else out.push(judge(fullWidth || centreOff <= centreTol, "geometry.centred", G, who, Math.round(centreOff * 10) / 10, centreTol, "px", `Horizontal centre is ${centreOff.toFixed(1)} px from the canvas centre.`));
  if (cutY) out.push(notRun("geometry.anchor", G, who, "The product is cut at the top or bottom of the source and placed flush with that edge by rule."));
  else if (spec.anchor === "bottom-centre") {
    const bottomGap = canvas.h - 1 - y1, want = canvas.h - safeBox.y - safeBox.h;
    out.push(judge(Math.abs(bottomGap - want) <= centreTol, "geometry.anchor", G, who, bottomGap, want, "px from the bottom", `The lowest product row sits ${bottomGap} px above the bottom edge (Styli guide: ${want}).`));
  } else {
    const fullHeight = measuredH >= safeBox.h - 1;
    const vOff = Math.abs((y0 + y1 + 1) / 2 - (safeBox.y + safeBox.h / 2));
    out.push(judge(fullHeight || vOff <= centreTol, "geometry.anchor", G, who, Math.round(vOff * 10) / 10, centreTol, "px", `Vertical centre is ${vOff.toFixed(1)} px from the safe-box centre.`));
  }
  if (spec.id === "noon" && ctx.sourceBox.w > ctx.sourceBox.h) {
    const sideMin = Math.min(x0, canvas.w - 1 - x1), want = Math.ceil(canvas.w * 0.05);
    if (cutX) out.push(notRun("geometry.noon_wide", G, who, "The wide shot is cut at the left or right of the source and placed flush with that edge by rule."));
    else out.push(judge(sideMin >= want - 1, "geometry.noon_wide", G, who, sideMin, want, "px", `Wide Noon shot keeps ${sideMin} px at the narrower side (needs ${want}).`));
  }

  // Product pixels are copied, never regenerated: the output's opaque product pixels, averaged back onto the source grid
  // (every canvas pixel into the source pixel it was resampled from), must equal the source there. Comparing on the
  // source grid removes the resampling kernel from the number (eval run 3, anta: 8.4 on a fine knit at 1.85x with a 2
  // luma fit error in an independent alignment, lanczos against bilinear, not an offset).
  const { source } = ctx.subject, { sourceCrop } = ctx, sw = source.w, sh = source.h;
  const sums = new Float64Array(sw * sh * 3), counts = new Uint32Array(sw * sh);
  for (let y = 0; y < productBox.h; y++) for (let x = 0; x < productBox.w; x++) {
    const cx = productBox.x + x, cy = productBox.y + y;
    if (cx < 0 || cy < 0 || cx >= canvas.w || cy >= canvas.h) continue;
    const ci = cy * canvas.w + cx;
    if (ctx.expectedAlpha[ci]! < 250) continue;
    const ix = Math.floor(sourceCrop.x + (x + 0.5) * sourceCrop.w / productBox.w), iy = Math.floor(sourceCrop.y + (y + 0.5) * sourceCrop.h / productBox.h);
    if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) continue;
    const s = iy * sw + ix;
    for (let c = 0; c < 3; c++) sums[s * 3 + c] = sums[s * 3 + c]! + canvas.rgb[ci * 3 + c]!;
    counts[s] = counts[s]! + 1;
  }
  let sum = 0, count = 0, big = 0;
  for (let s = 0; s < counts.length; s++) {
    if (!counts[s]) continue;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(sums[s * 3 + c]! / counts[s]! - source.rgb[s * 3 + c]!));
    sum += d; count++; if (d > 48) big++;
  }
  if (count) {
    const mean = sum / count;
    out.push(judge(mean <= COPY_MEAN_DELTA && big / count <= 0.01, "geometry.pixels_copied", G, who, Math.round(mean * 10) / 10, COPY_MEAN_DELTA, "mean delta", `Product pixels differ from the source by ${mean.toFixed(1)} on average over ${count} source pixels; ${(100 * big / count).toFixed(2)}% differ by more than 48.`));
  } else out.push(judge(false, "geometry.pixels_copied", G, who, 0, 1, "opaque source pixels", "No opaque product pixels (alpha 250 or more) reach the canvas: the matte is translucent or empty, so nothing of the product was copied (eval run 3, penti: ZBE55F7B86F158FEA0EB9Z n=5 published as a ghost at effective alpha 0.22)."));
  return out;
}

/** Achromatic darkening where a shadow is allowed: judged by the shadow checks, never as product or as a stray. */
export function shadowLikePixel(ctx: OutputContext, i: number, chromaMax = SHADOW_CHROMA_MAX): boolean {
  if (!ctx.shadowAllowed) return false;
  const r = ctx.canvas.rgb[i * 3]!, g = ctx.canvas.rgb[i * 3 + 1]!, b = ctx.canvas.rgb[i * 3 + 2]!;
  return luma(r, g, b) < luma(...ctx.background) && Math.max(r, g, b) - Math.min(r, g, b) < chromaMax;
}
/** Darkening with less chroma than this is achromatic (a shadow); next to a coloured product's edge JPEG ringing lends the shadow up to twice that. */
export const SHADOW_CHROMA_MAX = 12;
export const SHADOW_RING_CHROMA_MAX = 24;

/** Largest per-channel difference between the canvas pixel `i` and the source resampled there (Infinity outside the product box). */
export function sourceDelta(ctx: OutputContext, x: number, y: number): number {
  const { productBox, sourceRgb, canvas } = ctx, px = x - productBox.x, py = y - productBox.y;
  if (px < 0 || py < 0 || px >= productBox.w || py >= productBox.h) return Infinity;
  const i = (y * canvas.w + x) * 3, pi = (py * productBox.w + px) * 3;
  return Math.max(Math.abs(canvas.rgb[i]! - sourceRgb[pi]!), Math.abs(canvas.rgb[i + 1]! - sourceRgb[pi + 1]!), Math.abs(canvas.rgb[i + 2]! - sourceRgb[pi + 2]!));
}

/**
 * The product pixels that are visibly where the plan put them. A pixel counts when it is inside the half-coverage
 * mask and matches the source resampled there (SOURCE_MATCH_DELTA), which keeps a white sole on a white canvas, or
 * when it is clearly not canvas background (EXTENT_DELTA) within EDGE_RING_PX of the mask, which keeps the soft
 * blended edge; a contact shadow touching the sole is not product.
 */
export function visibleProduct(ctx: OutputContext, ring = dilate(ctx.product, ctx.canvas.w, ctx.canvas.h, EDGE_RING_PX)): Mask {
  const { canvas, background, product, half } = ctx, out = new Uint8Array(canvas.w * canvas.h);
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
    const i = y * canvas.w + x;
    if (!ring[i]) continue;
    if (half[i] && sourceDelta(ctx, x, y) <= SOURCE_MATCH_DELTA) { out[i] = 1; continue; }
    if (delta(canvas.rgb, i, background) > EXTENT_DELTA && !(shadowLikePixel(ctx, i) && !product[i])) out[i] = 1;
  }
  return out;
}

/** Styli: non-detail shots of one product must share one scale (spec 05 planProduct). */
export function checkUniformScale(identifier: string, shots: { n: number; scale: number; detailShot: boolean }[]): CheckResult {
  const who: CheckSubject = { identifier, n: null, channel: "styli" };
  const scales = shots.filter(s => !s.detailShot).map(s => s.scale);
  if (scales.length < 2) return notRun("geometry.uniform_scale", G, who, "Fewer than two non-detail Styli shots.");
  const spread = Math.max(...scales) / Math.min(...scales) - 1;
  return judge(spread <= UNIFORM_SCALE_TOLERANCE, "geometry.uniform_scale", G, who, Math.round(spread * 1e4) / 1e4, UNIFORM_SCALE_TOLERANCE, "ratio spread", `Styli scales of the product's angles spread by ${(spread * 100).toFixed(2)}%.`);
}
export { ALPHA_EDGE };
