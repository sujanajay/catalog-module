// Geometry per channel against the channel table (spec 10 section 3): format, canvas, every edge
// pixel, margins, centring, nothing outside the allowed area, product pixels copied not regenerated.
import sharp from "sharp";
import { MAX_OUTPUT_BYTES } from "../channels";
import { effectiveMinimum } from "../render";
import { delta, dilate, dropSpecks, inBox, luma, maskBox, projectRgb, SPECK_PX } from "./image";
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
export const PLACEMENT_TOLERANCE_PX = 3;
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

  // Measured extent: non-background pixels outside the shadow band (shadows are checked separately).
  let x0 = canvas.w, y0 = canvas.h, x1 = -1, y1 = -1;
  const ring = dilate(product, canvas.w, canvas.h, EDGE_RING_PX), outsideMask = new Uint8Array(canvas.w * canvas.h), safeMask = new Uint8Array(canvas.w * canvas.h);
  const bgLuma = luma(...background);
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
    const i = y * canvas.w + x, d = delta(canvas.rgb, i, background);
    if (d <= FOREGROUND_DELTA) continue;
    // Darkening without colour is shadow; the shadow checks judge it, so it is not "outside the product" here.
    const r = canvas.rgb[i * 3]!, g = canvas.rgb[i * 3 + 1]!, b = canvas.rgb[i * 3 + 2]!;
    const shadowLike = ctx.shadowAllowed && luma(r, g, b) < bgLuma && Math.max(r, g, b) - Math.min(r, g, b) < 12;
    if (!inBox(safeBox, x, y) && (d > EXTENT_DELTA || !ring[i])) safeMask[i] = 1;
    if (!shadowLike && !ring[i]) outsideMask[i] = 1;
    // The measured extent is what sits where the product should be: clearly foreground pixels inside the product's ring (a contact shadow touching the sole is not product).
    if (d <= EXTENT_DELTA || !ring[i] || (shadowLike && !product[i])) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  let outside = 0, outsideSafe = 0;
  for (const v of dropSpecks(outsideMask, canvas.w, canvas.h, SPECK_PX)) outside += v;
  for (const v of dropSpecks(safeMask, canvas.w, canvas.h, SPECK_PX)) outsideSafe += v;
  out.push(judge(outside === 0, "geometry.outside_product", G, who, outside, 0, "pixels", outside ? `${outside} non-background pixels lie outside the product${ctx.shadowAllowed ? " (shadow-like darkening excluded)" : ""}.` : "Nothing but the product and its shadow is on the canvas."));
  out.push(judge(outsideSafe === 0, "geometry.inside_safe_box", G, who, outsideSafe, 0, "pixels", outsideSafe ? `${outsideSafe} pixels reach into the required margins.` : "Nothing reaches into the required margins."));

  const expected = maskBox(product, canvas.w, canvas.h);
  if (!expected || x1 < 0) { out.push(notRun("geometry.extent", G, who, "No product pixels were found on the canvas.")); return out; }
  const sides = { left: Math.abs(x0 - expected.x), top: Math.abs(y0 - expected.y), right: Math.abs(x1 - (expected.x + expected.w - 1)), bottom: Math.abs(y1 - (expected.y + expected.h - 1)) };
  const extentWorst = Math.max(...Object.values(sides));
  out.push(judge(extentWorst <= PLACEMENT_TOLERANCE_PX, "geometry.extent", G, who, extentWorst, PLACEMENT_TOLERANCE_PX, "px", `Measured product extent differs from the planned placement by up to ${extentWorst} px (left ${sides.left}, top ${sides.top}, right ${sides.right}, bottom ${sides.bottom}).`));

  // Margins: the planned product box must respect every required margin (within 1 px of rounding).
  const m = { top: productBox.y, bottom: canvas.h - productBox.y - productBox.h, left: productBox.x, right: canvas.w - productBox.x - productBox.w };
  const need = { top: safeBox.y, bottom: canvas.h - safeBox.y - safeBox.h, left: safeBox.x, right: canvas.w - safeBox.x - safeBox.w };
  const short = (["top", "bottom", "left", "right"] as const).filter(side => m[side] < need[side] - 1);
  out.push(judge(!short.length, "geometry.margins", G, who, `t${m.top} b${m.bottom} l${m.left} r${m.right}`, `t${need.top} b${need.bottom} l${need.left} r${need.right}`, "px", short.length ? `Margins too small on ${short.join(", ")}.` : "Every required margin is kept."));

  // Centring and anchor from the measured extent (what a reviewer sees), not the plan.
  const measuredW = x1 - x0 + 1, measuredH = y1 - y0 + 1;
  const centreOff = Math.abs((x0 + x1 + 1) / 2 - canvas.w / 2);
  const fullWidth = measuredW >= safeBox.w - 1;
  out.push(judge(fullWidth || centreOff <= PLACEMENT_TOLERANCE_PX, "geometry.centred", G, who, Math.round(centreOff * 10) / 10, PLACEMENT_TOLERANCE_PX, "px", `Horizontal centre is ${centreOff.toFixed(1)} px from the canvas centre.`));
  if (spec.anchor === "bottom-centre") {
    const bottomGap = canvas.h - 1 - y1, want = canvas.h - safeBox.y - safeBox.h;
    out.push(judge(Math.abs(bottomGap - want) <= PLACEMENT_TOLERANCE_PX, "geometry.anchor", G, who, bottomGap, want, "px from the bottom", `The lowest product row sits ${bottomGap} px above the bottom edge (Styli guide: ${want}).`));
  } else {
    const fullHeight = measuredH >= safeBox.h - 1;
    const vOff = Math.abs((y0 + y1 + 1) / 2 - (safeBox.y + safeBox.h / 2));
    out.push(judge(fullHeight || vOff <= PLACEMENT_TOLERANCE_PX, "geometry.anchor", G, who, Math.round(vOff * 10) / 10, PLACEMENT_TOLERANCE_PX, "px", `Vertical centre is ${vOff.toFixed(1)} px from the safe-box centre.`));
  }
  if (spec.id === "noon" && ctx.sourceBox.w > ctx.sourceBox.h) {
    const sideMin = Math.min(x0, canvas.w - 1 - x1), want = Math.ceil(canvas.w * 0.05);
    out.push(judge(sideMin >= want - 1, "geometry.noon_wide", G, who, sideMin, want, "px", `Wide Noon shot keeps ${sideMin} px at the narrower side (needs ${want}).`));
  }

  // Product pixels are copied, never regenerated: compare the output with the resampled source inside the product.
  const sourceRgb = await projectRgb(s.source, ctx.sourceBox, productBox);
  let sum = 0, count = 0, big = 0;
  for (let y = 0; y < productBox.h; y++) for (let x = 0; x < productBox.w; x++) {
    const cx = productBox.x + x, cy = productBox.y + y;
    if (cx < 0 || cy < 0 || cx >= canvas.w || cy >= canvas.h) continue;
    const ci = cy * canvas.w + cx;
    if (ctx.expectedAlpha[ci]! < 250) continue;
    const pi = y * productBox.w + x;
    const d = Math.max(Math.abs(canvas.rgb[ci * 3]! - sourceRgb[pi * 3]!), Math.abs(canvas.rgb[ci * 3 + 1]! - sourceRgb[pi * 3 + 1]!), Math.abs(canvas.rgb[ci * 3 + 2]! - sourceRgb[pi * 3 + 2]!));
    sum += d; count++; if (d > 48) big++;
  }
  if (count) {
    const mean = sum / count;
    out.push(judge(mean <= COPY_MEAN_DELTA && big / count <= 0.01, "geometry.pixels_copied", G, who, Math.round(mean * 10) / 10, COPY_MEAN_DELTA, "mean delta", `Product pixels differ from the source by ${mean.toFixed(1)} on average; ${(100 * big / count).toFixed(2)}% differ by more than 48.`));
  } else out.push(notRun("geometry.pixels_copied", G, who, "No opaque product pixels to compare."));
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
