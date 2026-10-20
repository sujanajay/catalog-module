// Shadow quality (spec 10 section 5). A shadow is every canvas pixel outside the product that is
// darker than the background. Where the product type allows one it must look like a contact shadow:
// inside the spec 05 band, in the silhouette's feather. A synthesised shadow (`shadow_synthesised`)
// must have the spec 05 shape: no straight hard edge, darkness falling off smoothly with distance from
// the silhouette, never a slab. A kept photographic shadow has the photographer's shape, so it is
// checked against the source instead: the output's darkness must equal the source's darkness
// resampled to the placement, within a darkness bound. Where the product type forbids one, none may exist.
import { SHADOW_BAND_ABOVE, SHADOW_BAND_BELOW, SHADOW_BAND_SIDE, SHADOW_MAX_DARKNESS, SHADOW_PRESET } from "../shadow";
import { dilate, distanceFrom, dropSpecks, longestRun, lumaAt, luma, shadowFeather, SPECK_PX } from "./image";
import type { OutputContext } from "./context";
import { judge, notRun, type CheckResult, type CheckSubject } from "./types";

/** A pixel darker than the background by more than this (0..255 luma) is shadow. JPEG noise on flat grey stays under 4. */
export const SHADOW_MIN_DARK = 8;
/** Product edge ring (JPEG ringing) excluded from the darkness map. */
export const SHADOW_RING_PX = 3;
/** Forbidden shadows: the mean darkening of the band under the product must stay under this. */
export const FORBIDDEN_MEAN_DARK = 1.5;
/** A step between adjacent rows or columns larger than this is a hard edge. */
export const HARD_EDGE_STEP = 16;
/** A hard edge may not run longer than this share of the product width (rows) or height (columns), and never beyond 6 px. */
export const HARD_EDGE_MAX_SHARE = 0.05;
/** Mean darkness may rise by at most this much from one distance bin to the next (noise). */
export const MONOTONE_STEP_TOLERANCE = 2;
/**
 * Total of the positive rises over the 44 distance bins. JPEG noise alone sums to up to 4.7 on the
 * synthesised shadows of eval run 2 (185 outputs; the 8 that failed the old bar of 4 measured 4.1 to
 * 4.7 with steps under 1.5); a real rise (0.8 luma per pixel over 40 px) sums to 32.
 */
export const MONOTONE_TOTAL_TOLERANCE = 8;
/** Darkest synthesised shadow pixel allowed: spec 05 SHADOW_MAX_DARKNESS (0.6 of the background luma) plus JPEG error. */
export const MAX_DARKNESS = 0.65;
/**
 * Darkest kept photographic shadow pixel: the render clamps the source darkness at 0.6, and the product's own
 * fade (alpha under 10, outside the ring) composited over the clamped shadow adds up to 0.07 (eval run 2: 376
 * kept shadows, p50 0.63, p90 0.65, max 0.67).
 */
export const KEPT_MAX_DARKNESS = 0.7;
/** A kept shadow must match the source darkness resampled to the placement within this mean absolute luma difference. */
export const KEPT_MEAN_DIFF_MAX = 4;
/** Fewer shadow pixels than this in the band give no meaningful comparison. */
export const KEPT_MIN_PIXELS = 64;
/** Forbidden shadows are judged on firmer darkening (above ringing next to dark garments) in regions of at least this size. */
export const FORBIDDEN_MIN_DARK = 12;
export const FORBIDDEN_MIN_REGION_PX = 24;
/** Distance bins measured away from the silhouette. */
export const GRADIENT_DEPTH_PX = 48;

const S = "shadow" as const;

/** Darkness per pixel (background luma minus pixel luma, 0 when brighter), 0 inside the product and its 1 px ring. */
export function darknessMap(ctx: OutputContext, minDark = SHADOW_MIN_DARK, speck = SPECK_PX): { dark: Float32Array; count: number; max: number } {
  const { canvas, background, product } = ctx, bg = luma(...background);
  const ring = dilate(product, canvas.w, canvas.h, SHADOW_RING_PX), dark = new Float32Array(canvas.w * canvas.h), mask = new Uint8Array(dark.length);
  for (let i = 0; i < dark.length; i++) {
    if (ring[i]) continue;
    const d = bg - lumaAt(canvas.rgb, i);
    if (d > minDark) { dark[i] = d; mask[i] = 1; }
  }
  // Ringing specks next to sharp edges are not shadow.
  const kept = dropSpecks(mask, canvas.w, canvas.h, speck);
  let count = 0, max = 0;
  for (let i = 0; i < dark.length; i++) { if (!kept[i]) { dark[i] = 0; continue; } count++; if (dark[i]! > max) max = dark[i]!; }
  return { dark, count, max };
}

/** How the output carries its shadow, from the render's own flags on the output. */
export function shadowMode(flags: readonly string[]): "synthesised" | "kept" | "none" {
  if (flags.includes("shadow_synthesised")) return "synthesised";
  if (flags.includes("no_shadow_source")) return "none";
  return "kept";
}

/**
 * The darkness the source itself carries, as the render reads it (spec 05 preservedDarkness): the share by which a
 * source pixel outside the opaque matte is darker than the source background, clamped at SHADOW_MAX_DARKNESS;
 * 0 inside the opaque matte and for brighter pixels.
 */
export function sourceDarkness(ctx: OutputContext): Float32Array {
  const { source, sourceBackground, alpha } = ctx.subject, bg = luma(...sourceBackground.color), out = new Float32Array(source.w * source.h);
  if (bg <= 0) return out;
  for (let i = 0; i < out.length; i++) {
    if (alpha[i] === 255) continue;
    const d = (bg - lumaAt(source.rgb, i)) / bg;
    if (d > 0.01) out[i] = Math.min(SHADOW_MAX_DARKNESS, d);
  }
  return out;
}

/**
 * Kept photographic shadow: the output's darkness (background luma minus pixel luma) must equal the source's darkness
 * resampled to the placement (the same scale and offset as the product), compared inside the spec 05 band, outside the
 * product's ring and away from where the render fades a shadow out (the required margins, the border band and the edge
 * of the source photo, each over SHADOW_PRESET.fade of the canvas). Measured as the mean absolute difference in luma
 * over the pixels where either map shows a shadow.
 */
export function keptShadowDifference(ctx: OutputContext): { mean: number; max: number; pixels: number } {
  const { canvas, background, productBox, sourceCrop, safeBox, subject } = ctx, bg = luma(...background), src = sourceDarkness(ctx);
  const ring = dilate(ctx.product, canvas.w, canvas.h, SHADOW_RING_PX);
  const sx = productBox.w / sourceCrop.w, sy = productBox.h / sourceCrop.h;
  // Spec 05 band around the product box, in canvas pixels.
  const bx0 = Math.floor(productBox.x - productBox.w * SHADOW_BAND_SIDE), bx1 = Math.ceil(productBox.x + productBox.w * (1 + SHADOW_BAND_SIDE));
  const by0 = Math.floor(productBox.y + productBox.h * (1 - SHADOW_BAND_ABOVE)), by1 = Math.ceil(productBox.y + productBox.h * (1 + SHADOW_BAND_BELOW));
  // Where the render keeps a shadow at full strength: inside the margins, the border band and the photo's own frame, past the fade.
  const fade = Math.max(2, Math.round(SHADOW_PRESET.fade * Math.min(canvas.w, canvas.h))), bandX = Math.max(4, Math.ceil(canvas.w * 0.02)), bandY = Math.max(4, Math.ceil(canvas.h * 0.02));
  const frameX0 = productBox.x - sourceCrop.x * sx, frameX1 = frameX0 + subject.source.w * sx, frameY0 = productBox.y - sourceCrop.y * sy, frameY1 = frameY0 + subject.source.h * sy;
  const x0 = Math.max(bx0, bandX, safeBox.x, Math.ceil(frameX0)) + fade, x1 = Math.min(bx1, canvas.w - bandX, safeBox.x + safeBox.w, Math.floor(frameX1)) - fade;
  const y0 = Math.max(by0, bandY, safeBox.y, Math.ceil(frameY0)) + fade, y1 = Math.min(by1, canvas.h - bandY, safeBox.y + safeBox.h, Math.floor(frameY1)) - fade;
  const at = (x: number, y: number) => src[Math.min(subject.source.h - 1, Math.max(0, y)) * subject.source.w + Math.min(subject.source.w - 1, Math.max(0, x))]!;
  let sum = 0, max = 0, pixels = 0;
  for (let y = Math.max(0, y0); y < Math.min(canvas.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(canvas.w, x1); x++) {
    const i = y * canvas.w + x;
    if (ring[i]) continue;
    // Bilinear sample of the source darkness at this canvas pixel's centre.
    const fx = sourceCrop.x + (x - productBox.x + 0.5) / sx - 0.5, fy = sourceCrop.y + (y - productBox.y + 0.5) / sy - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const expected = bg * ((at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty);
    const observed = Math.max(0, bg - lumaAt(canvas.rgb, i));
    if (expected <= SHADOW_MIN_DARK && observed <= SHADOW_MIN_DARK) continue;
    const diff = Math.abs(expected - observed);
    sum += diff; pixels++; if (diff > max) max = diff;
  }
  return { mean: pixels ? sum / pixels : 0, max, pixels };
}

export function checkShadow(ctx: OutputContext): CheckResult[] {
  const { subject: s, canvas, band, productBox, background } = ctx;
  const who: CheckSubject = { identifier: s.identifier, n: s.n, channel: s.channel };
  const out: CheckResult[] = [];
  const { dark, count, max } = darknessMap(ctx);
  const bg = luma(...background);

  if (!ctx.shadowAllowed) {
    const firm = darknessMap(ctx, FORBIDDEN_MIN_DARK, FORBIDDEN_MIN_REGION_PX);
    let sum = 0, n = 0;
    for (let y = band.y; y < band.y + band.h; y++) for (let x = band.x; x < band.x + band.w; x++) { const i = y * canvas.w + x; if (ctx.product[i]) continue; sum += firm.dark[i]!; n++; }
    const mean = n ? sum / n : 0;
    out.push(judge(firm.count === 0 && mean <= FORBIDDEN_MEAN_DARK, "shadow.forbidden", S, who, firm.count, 0, "shadow pixels", firm.count ? `${firm.count} pixels under or around the product are darker than the background (worst ${firm.max.toFixed(0)}); apparel never gets a shadow.` : "No shadow under the product, as the spec requires for this product type."));
    return out;
  }

  if (!count) { out.push(notRun("shadow.footprint", S, who, "No shadow on this output.")); return out; }

  // Footprint: silhouette plus feather. A shadow pixel must sit within the render's feather of the
  // product mask (so it follows overhangs and insets), in the lower half of the product, and inside the band.
  const { radius } = shadowFeather(productBox), near = dilate(ctx.product, canvas.w, canvas.h, radius), lowerHalf = productBox.y + productBox.h / 2;
  let outsideBand = 0;
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) { const i = y * canvas.w + x; if (dark[i]! > 0 && (y >= band.y + band.h || !near[i] || y < lowerHalf)) outsideBand++; }
  out.push(judge(outsideBand === 0, "shadow.footprint", S, who, outsideBand, 0, "pixels outside silhouette plus feather", outsideBand ? `${outsideBand} shadow pixels lie outside the silhouette plus its feather under the product.` : "The shadow follows the silhouette within its feather."));

  // Slab guard: the darkest pixel, against the bar of the shadow's mode.
  const mode = shadowMode(s.flags), darkest = max / bg, darkBar = mode === "kept" ? KEPT_MAX_DARKNESS : MAX_DARKNESS;
  out.push(judge(darkest <= darkBar, "shadow.darkness", S, who, Math.round(darkest * 100) / 100, darkBar, "share of background luma", `The darkest ${mode === "kept" ? "kept" : "synthesised"} shadow pixel is ${(darkest * 100).toFixed(0)}% of the background luma.`));

  if (mode === "kept") {
    // A kept photographic shadow has the photographer's shape: the output must carry the source's own darkness, resampled.
    const { mean, max: worst, pixels } = keptShadowDifference(ctx);
    if (pixels < KEPT_MIN_PIXELS) out.push(notRun("shadow.kept_matches_source", S, who, `Too few shadow pixels in the band to compare with the source (${pixels}).`));
    else out.push(judge(mean <= KEPT_MEAN_DIFF_MAX, "shadow.kept_matches_source", S, who, Math.round(mean * 10) / 10, KEPT_MEAN_DIFF_MAX, "mean luma difference", mean <= KEPT_MEAN_DIFF_MAX ? `The kept shadow matches the source's shadow resampled to the placement (mean difference ${mean.toFixed(1)}, worst ${worst.toFixed(0)} over ${pixels} pixels).` : `The kept shadow differs from the source's shadow resampled to the placement by ${mean.toFixed(1)} luma on average (worst ${worst.toFixed(0)} over ${pixels} pixels): something was added or removed under the product.`));
    for (const id of ["shadow.hard_edge_horizontal", "shadow.hard_edge_vertical", "shadow.monotone"]) out.push(notRun(id, S, who, "The output keeps the photo's own shadow; its shape is compared with the source instead."));
    return out;
  }

  // Hard edges: a step of HARD_EDGE_STEP between adjacent rows (or columns) running along a line.
  const ring = dilate(ctx.product, canvas.w, canvas.h, SHADOW_RING_PX + 1);
  const rowSteps = new Uint8Array(canvas.w), colSteps = new Uint8Array(canvas.h);
  let longestRow = 0, longestCol = 0, rowAt = -1, colAt = -1;
  const y0 = Math.max(0, band.y - 2), y1 = Math.min(canvas.h - 1, band.y + band.h + 2), x0 = Math.max(0, band.x - 2), x1 = Math.min(canvas.w - 1, band.x + band.w + 2);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x <= x1; x++) { const i = y * canvas.w + x, j = i + canvas.w; rowSteps[x] = !ring[i] && !ring[j] && Math.abs(dark[i]! - dark[j]!) > HARD_EDGE_STEP ? 1 : 0; }
    const run = longestRun(rowSteps); if (run > longestRow) { longestRow = run; rowAt = y; }
  }
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y <= y1; y++) { const i = y * canvas.w + x, j = i + 1; colSteps[y] = !ring[i] && !ring[j] && Math.abs(dark[i]! - dark[j]!) > HARD_EDGE_STEP ? 1 : 0; }
    const run = longestRun(colSteps); if (run > longestCol) { longestCol = run; colAt = x; }
  }
  const rowLimit = Math.max(6, Math.round(productBox.w * HARD_EDGE_MAX_SHARE)), colLimit = Math.max(6, Math.round(productBox.h * HARD_EDGE_MAX_SHARE));
  out.push(judge(longestRow <= rowLimit, "shadow.hard_edge_horizontal", S, who, longestRow, rowLimit, "px", longestRow > rowLimit ? `A straight horizontal shadow edge ${longestRow} px long at row ${rowAt} (limit ${rowLimit}).` : "No straight horizontal shadow edge."));
  out.push(judge(longestCol <= colLimit, "shadow.hard_edge_vertical", S, who, longestCol, colLimit, "px", longestCol > colLimit ? `A straight vertical shadow edge ${longestCol} px long at column ${colAt} (limit ${colLimit}).` : "No straight vertical shadow edge."));

  // Monotone, smooth fall-off with distance from the silhouette.
  const dist = distanceFrom(ctx.product, canvas.w, canvas.h, GRADIENT_DEPTH_PX);
  const sums = new Float64Array(GRADIENT_DEPTH_PX + 1), counts = new Uint32Array(GRADIENT_DEPTH_PX + 1);
  for (let y = band.y; y < band.y + band.h; y++) for (let x = band.x; x < band.x + band.w; x++) { const i = y * canvas.w + x, d = dist[i]!; if (d <= SHADOW_RING_PX + 1 || d > GRADIENT_DEPTH_PX) continue; sums[d] = sums[d]! + dark[i]!; counts[d] = counts[d]! + 1; }
  const means: number[] = [];
  for (let d = SHADOW_RING_PX + 2; d <= GRADIENT_DEPTH_PX; d++) if (counts[d]! >= 8) means.push(sums[d]! / counts[d]!);
  if (means.length >= 4) {
    let worstRise = 0, totalRise = 0;
    for (let k = 1; k < means.length; k++) { const rise = means[k]! - means[k - 1]!; if (rise > worstRise) worstRise = rise; if (rise > 0) totalRise += rise; }
    out.push(judge(worstRise <= MONOTONE_STEP_TOLERANCE && totalRise <= MONOTONE_TOTAL_TOLERANCE, "shadow.monotone", S, who, Math.round(worstRise * 10) / 10, MONOTONE_STEP_TOLERANCE, "luma rise per px", worstRise > MONOTONE_STEP_TOLERANCE || totalRise > MONOTONE_TOTAL_TOLERANCE ? `Shadow darkness rises again further from the product (worst step ${worstRise.toFixed(1)}, total ${totalRise.toFixed(1)}; limits ${MONOTONE_STEP_TOLERANCE} and ${MONOTONE_TOTAL_TOLERANCE}).` : `Shadow darkness falls off steadily from the silhouette (worst step ${worstRise.toFixed(1)}, total rise ${totalRise.toFixed(1)}).`));
  } else out.push(notRun("shadow.monotone", S, who, "Too few shadow pixels to measure the gradient."));
  return out;
}
