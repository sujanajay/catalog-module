// Shadow quality (spec 10 section 4). A shadow is every canvas pixel outside the product that is
// darker than the background. Where the product type allows one it must look like a contact shadow:
// inside the spec 05 band, no straight hard edge, darkness falling off smoothly with distance from
// the silhouette, never a slab. Where the product type forbids one, none may exist.
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
/** Mean darkness may rise by at most this much from one distance bin to the next (noise), or in total. */
export const MONOTONE_STEP_TOLERANCE = 2;
export const MONOTONE_TOTAL_TOLERANCE = 4;
/** Darkest shadow pixel allowed: spec 05 SHADOW_MAX_DARKNESS (0.6 of the background luma) plus JPEG error. */
export const MAX_DARKNESS = 0.65;
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

  // Slab guard.
  const darkest = max / bg;
  out.push(judge(darkest <= MAX_DARKNESS, "shadow.darkness", S, who, Math.round(darkest * 100) / 100, MAX_DARKNESS, "share of background luma", `The darkest shadow pixel is ${(darkest * 100).toFixed(0)}% of the background luma.`));

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
    out.push(judge(worstRise <= MONOTONE_STEP_TOLERANCE && totalRise <= MONOTONE_TOTAL_TOLERANCE, "shadow.monotone", S, who, Math.round(worstRise * 10) / 10, MONOTONE_STEP_TOLERANCE, "luma rise per px", worstRise > MONOTONE_STEP_TOLERANCE || totalRise > MONOTONE_TOTAL_TOLERANCE ? `Shadow darkness rises again further from the product (worst step ${worstRise.toFixed(1)}, total ${totalRise.toFixed(1)}).` : "Shadow darkness falls off steadily from the silhouette."));
  } else out.push(notRun("shadow.monotone", S, who, "Too few shadow pixels to measure the gradient."));
  return out;
}
