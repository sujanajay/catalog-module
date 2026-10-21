// Shadow quality (spec 10 section 5). A shadow is every canvas pixel outside the product that is
// darker than the background. Where the product type allows one it must look like a contact shadow:
// inside the spec 05 band, in the silhouette's feather. A synthesised shadow (`shadow_synthesised`)
// must have the spec 05 shape: no straight hard edge, darkness falling off smoothly with distance from
// the silhouette, never a slab. A kept photographic shadow has the photographer's shape, so it is
// checked against the source instead: the output's darkness must equal the source's darkness
// resampled to the placement, within a darkness bound. Where the product type forbids one, none may exist.
import { preservedDarkness, SHADOW_BAND_ABOVE, SHADOW_BAND_BELOW, SHADOW_BAND_SIDE, SHADOW_MAX_DARKNESS, SHADOW_PRESET } from "../shadow";
import { ALPHA_EDGE } from "./context";
import { dilate, distanceFrom, dropSpecks, longestRun, lumaAt, luma, shadowFeather, SPECK_PX, thresholdMask } from "./image";
import { APPAREL_TYPES, shadowMode, type OutputContext } from "./context";
import { info, judge, notRun, type CheckResult, type CheckSubject } from "./types";
import type { Mask } from "./image";

export { shadowMode };

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
/**
 * A kept shadow must match the darkness the render's own rule keeps from the source (preservedDarkness: the components
 * connected to the contact line, continued past the band with its fade) within this mean absolute luma difference,
 * compared on the source grid (the output's darkness averaged over the canvas pixels of each source pixel) at the best
 * of a KEPT_REGISTRATION_PX registration search, outside the product ring (KEPT_RING_SOURCE_PX source pixels). Eval run 3
 * (anta, 376 kept shadows): the canvas-resolution comparison against the whole source darkness measured p50 3.7, p75
 * 11.6, max 66.9 against the bar of 4 set on the synthetic shadow; the same matte measured 6.3 to 31.8 across channels
 * while its darkness maps equalled the source on every channel (a 1 source px contact line scaled 1.6 to 4.8x is a 200
 * luma step, one pixel of registration costs about 3 luma of mean), and a raised toe's detached shadow, dropped by the
 * render's contact-line rule, measured 52 to 67. The bar stays at 4 until run 4 measures the new metric on real photos.
 */
export const KEPT_MEAN_DIFF_MAX = 4;
export const KEPT_REGISTRATION_PX = 1;
export const KEPT_RING_SOURCE_PX = 3;
/** Fewer shadow pixels than this in the band give no meaningful comparison. */
export const KEPT_MIN_PIXELS = 64;
/** Forbidden shadows are judged on firmer darkening (above ringing next to dark garments) in regions of at least this size. */
export const FORBIDDEN_MIN_DARK = 12;
export const FORBIDDEN_MIN_REGION_PX = 24;
/** Distance bins measured away from the silhouette. */
export const GRADIENT_DEPTH_PX = 48;
/** Kept darkness over this share of the background luma (about 5 luma on white) belongs to the render's kept-darkness mask. */
export const KEPT_MASK_MIN_DARKNESS = 0.02;
/**
 * Expected synthesis (section 15c): the types whose policy synthesises a contact shadow when the source has none
 * (SPEC.md: footwear always; bags and hardline "preserve else synthesise (upright)"); a product stands on a contact line
 * when the columns covered by its lowest CONTACT_LINE_ROWS_SHARE of box rows span more than CONTACT_LINE_MIN_COVERAGE of
 * the box width. Eval run 3: 16 standing-bag and 40 candle outputs on white carry no shadow because the render's upright
 * test is box.h > box.w; the spec's rule is pose, and the suite had no check that noticed a missing synthesised shadow.
 */
export const SYNTHESIS_TYPES: ReadonlySet<string> = new Set(["footwear", "bag_accessory", "other"]);
export const CONTACT_LINE_ROWS_SHARE = 0.02;
export const CONTACT_LINE_MIN_COVERAGE = 0.4;

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
 * The darkness the render keeps (spec 05 preservedDarkness: the source's darkness outside the opaque matte, in the band,
 * connected to the contact line, continued past the band with its fade), as a 0..1 map over the source; the plain source
 * darkness (sourceDarkness) where the render's rule does not apply (no uniform border).
 */
export function expectedKeptDarkness(ctx: OutputContext): Float32Array {
  const { source, sourceBackground, alpha, productType } = ctx.subject;
  const kept = preservedDarkness(
    { width: source.w, height: source.h, rgb: source.rgb, alphaSource: null, background: { ...sourceBackground, stdev: 0 }, flags: [], sourceMime: "image/jpeg" },
    { alpha, width: source.w, height: source.h, model: "evals", ms: 0, source: "model", target: null, sentLongSide: null },
    ctx.sourceBox, productType);
  if (!kept) return sourceDarkness(ctx);
  const out = new Float32Array(kept.length);
  for (let i = 0; i < kept.length; i++) out[i] = kept[i]! / 255;
  return out;
}

/**
 * Kept photographic shadow: the output's darkness (background luma minus pixel luma) must equal the darkness the render's
 * own rule keeps from the source (expectedKeptDarkness), compared on the source grid: every canvas pixel inside the spec
 * 05 band and away from where the render fades a shadow out (the required margins, the border band and the edge of the
 * source photo, each over SHADOW_PRESET.fade of the canvas) is averaged into the source pixel it was resampled from, so
 * the channel's scale and rounding do not enter the number; source pixels within KEPT_RING_SOURCE_PX of the product are
 * left out, and the expectation is read at the best offset of a KEPT_REGISTRATION_PX search. Measured as the mean
 * absolute difference in luma over the source pixels where either map shows a shadow.
 */
export function keptShadowDifference(ctx: OutputContext): { mean: number; max: number; pixels: number } {
  const { canvas, background, productBox, sourceCrop, safeBox, subject } = ctx, bg = luma(...background), src = expectedKeptDarkness(ctx);
  const sw = subject.source.w, sh = subject.source.h;
  const sx = productBox.w / sourceCrop.w, sy = productBox.h / sourceCrop.h;
  // Spec 05 band around the product box, in canvas pixels.
  const bx0 = Math.floor(productBox.x - productBox.w * SHADOW_BAND_SIDE), bx1 = Math.ceil(productBox.x + productBox.w * (1 + SHADOW_BAND_SIDE));
  const by0 = Math.floor(productBox.y + productBox.h * (1 - SHADOW_BAND_ABOVE)), by1 = Math.ceil(productBox.y + productBox.h * (1 + SHADOW_BAND_BELOW));
  // Where the render keeps a shadow at full strength: inside the margins, the border band and the photo's own frame, past the fade.
  const fade = Math.max(2, Math.round(SHADOW_PRESET.fade * Math.min(canvas.w, canvas.h))), bandX = Math.max(4, Math.ceil(canvas.w * 0.02)), bandY = Math.max(4, Math.ceil(canvas.h * 0.02));
  const frameX0 = productBox.x - sourceCrop.x * sx, frameX1 = frameX0 + subject.source.w * sx, frameY0 = productBox.y - sourceCrop.y * sy, frameY1 = frameY0 + subject.source.h * sy;
  const x0 = Math.max(bx0, bandX, safeBox.x, Math.ceil(frameX0)) + fade, x1 = Math.min(bx1, canvas.w - bandX, safeBox.x + safeBox.w, Math.floor(frameX1)) - fade;
  const y0 = Math.max(by0, bandY, safeBox.y, Math.ceil(frameY0)) + fade, y1 = Math.min(by1, canvas.h - bandY, safeBox.y + safeBox.h, Math.floor(frameY1)) - fade;
  // The output's darkness on the source grid: the mean over the canvas pixels each source pixel was resampled to.
  const sums = new Float64Array(sw * sh), counts = new Uint32Array(sw * sh);
  for (let y = Math.max(0, y0); y < Math.min(canvas.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(canvas.w, x1); x++) {
    const ix = Math.floor(sourceCrop.x + (x - productBox.x + 0.5) / sx), iy = Math.floor(sourceCrop.y + (y - productBox.y + 0.5) / sy);
    if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) continue;
    const s = iy * sw + ix;
    sums[s] = sums[s]! + Math.max(0, bg - lumaAt(canvas.rgb, y * canvas.w + x)); counts[s] = counts[s]! + 1;
  }
  const ring = dilate(thresholdMask(subject.alpha, ALPHA_EDGE), sw, sh, KEPT_RING_SOURCE_PX);
  const at = (x: number, y: number) => src[Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))]!;
  let best = { mean: Infinity, max: 0, pixels: 0 };
  for (let dy = -KEPT_REGISTRATION_PX; dy <= KEPT_REGISTRATION_PX; dy++) for (let dx = -KEPT_REGISTRATION_PX; dx <= KEPT_REGISTRATION_PX; dx++) {
    let sum = 0, max = 0, pixels = 0;
    for (let s = 0; s < counts.length; s++) {
      if (!counts[s] || ring[s]) continue;
      const x = s % sw, y = (s - x) / sw, expected = bg * at(x + dx, y + dy), observed = sums[s]! / counts[s]!;
      if (expected <= SHADOW_MIN_DARK && observed <= SHADOW_MIN_DARK) continue;
      const diff = Math.abs(expected - observed);
      sum += diff; pixels++; if (diff > max) max = diff;
    }
    const mean = pixels ? sum / pixels : 0;
    if (mean < best.mean || (dx === 0 && dy === 0 && mean === best.mean)) best = { mean, max, pixels };
  }
  return best.mean === Infinity ? { mean: 0, max: 0, pixels: 0 } : best;
}

/**
 * The render's own kept darkness (expectedKeptDarkness) on the canvas, as a mask of the canvas pixels whose source pixel
 * the render keeps darker than KEPT_MASK_MIN_DARKNESS, grown by one source pixel at the scale plus the ring; null unless
 * the output is in kept mode where a shadow is allowed, or when the render keeps nothing. Eval run 3 (vero_moda): 97 halo
 * fails (2.1 to 37.5%) and 64 footprint fails (23 to 171,831 px) on exactly the 20 photos that keep a source shadow (flat
 * lays photographed with a shadow all around the garment, full-body shots with a long floor shadow); the outputs match
 * the source and the checks counted the shadow the render was told to keep on the sides the band does not cover.
 */
const keptMasks = new WeakMap<OutputContext, Mask | null>();
export function keptShadowCanvasMask(ctx: OutputContext): Mask | null {
  const cached = keptMasks.get(ctx);
  if (cached !== undefined) return cached;
  let out: Mask | null = null;
  if (ctx.shadowAllowed && shadowMode(ctx.subject.flags) === "kept") {
    const { canvas, productBox, sourceCrop, subject } = ctx, src = expectedKeptDarkness(ctx), sw = subject.source.w, sh = subject.source.h;
    const sx = productBox.w / sourceCrop.w, sy = productBox.h / sourceCrop.h, raw = new Uint8Array(canvas.w * canvas.h);
    let any = false;
    for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
      const ix = Math.floor(sourceCrop.x + (x - productBox.x + 0.5) / sx), iy = Math.floor(sourceCrop.y + (y - productBox.y + 0.5) / sy);
      if (ix < 0 || iy < 0 || ix >= sw || iy >= sh || src[iy * sw + ix]! <= KEPT_MASK_MIN_DARKNESS) continue;
      raw[y * canvas.w + x] = 1; any = true;
    }
    out = any ? dilate(raw, canvas.w, canvas.h, Math.ceil(subject.placement.scale) + SHADOW_RING_PX) : null;
  }
  keptMasks.set(ctx, out);
  return out;
}

/** Share of the product box's columns the matte covers in its lowest CONTACT_LINE_ROWS_SHARE of rows: a contact line, or a hanging or hand-held product. */
export function contactLineCoverage(alpha: Buffer, source: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }): number {
  const rows = Math.max(1, Math.round(box.h * CONTACT_LINE_ROWS_SHARE));
  let covered = 0;
  for (let x = box.x; x < Math.min(source.w, box.x + box.w); x++) {
    for (let y = Math.max(box.y, box.y + box.h - rows); y < Math.min(source.h, box.y + box.h); y++) if (alpha[y * source.w + x]! > ALPHA_EDGE) { covered++; break; }
  }
  return box.w ? covered / box.w : 0;
}

/**
 * No shadow on an output whose policy synthesises one: a failure when the render's own rule says synthesise (footwear, or
 * a box taller than wide) and nothing was drawn on a product standing on a contact line; information when the product
 * stands on a contact line but is wider than tall, because SPEC.md's "upright pose" and the render's box.h > box.w
 * disagree there (OPEN owner question, section 15c) and the live run is not failed on a decision the owner has not taken.
 * Not run on apparel (never synthesised), on a source cut at the bottom (no contact line to draw on), when the output
 * carries a shadow flag, or when the product does not stand on a contact line (hand-held, hanging, on a model).
 */
export function expectedSynthesis(ctx: OutputContext, who: CheckSubject, shadowPixels: number): CheckResult {
  const id = "shadow.expected_synthesis", { subject: s, sourceBox: box, cut } = ctx, mode = shadowMode(s.flags);
  if (!SYNTHESIS_TYPES.has(s.productType)) return notRun(id, S, who, "The policy never synthesises a shadow for this product type.");
  if (mode !== "none") return notRun(id, S, who, mode === "synthesised" ? "The render synthesised a shadow." : "The render kept the photo's own shadow (no shadow flag).");
  if (shadowPixels) return notRun(id, S, who, "The output carries darkening under the product, judged with the synthesised bars.");
  if (cut.bottom) return notRun(id, S, who, "The product is cut at the bottom of the source: there is no contact line to synthesise a shadow on.");
  const coverage = contactLineCoverage(s.alpha, s.source, box), pct = `${(coverage * 100).toFixed(0)}%`;
  if (coverage <= CONTACT_LINE_MIN_COVERAGE) return notRun(id, S, who, `The product does not stand on a contact line (its lowest rows cover ${pct} of the box width: hand-held, hanging or on a model), so no shadow is expected.`);
  const upright = box.h > box.w;
  if (s.productType === "footwear" || upright) return judge(false, id, S, who, "none drawn", "synthesised", "shadow", `The policy says synthesise (${s.productType === "footwear" ? "footwear" : `an upright product, ${box.w}x${box.h} box`}), the source carries no measurable shadow and the product stands on a contact line covering ${pct} of its box, but no shadow was drawn.`);
  return info(id, S, who, `${box.w}x${box.h} box, contact line ${pct}`, "upright pose (SPEC.md) against taller than wide (render)", "contact-line coverage", `OPEN owner question: SPEC.md synthesises a shadow for a bag or hardline product in an upright pose; the render's test is box.h > box.w, and this product stands on a contact line (${pct} of its box width) while wider than tall, so nothing was drawn. Recorded as information until the owner decides.`);
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

  // Apparel in kept mode (SPEC.md preserve_only): the photo's own shadow is allowed and compared with the source below;
  // only a synthesised shadow is forbidden, and that fails above (no_shadow_source or shadow_synthesised flags).
  if (APPAREL_TYPES.has(s.productType)) out.push(notRun("shadow.forbidden", S, who, "The output keeps the photo's own shadow (SPEC.md: a measurable source shadow is preserved for every type; only synthesis is forbidden on apparel), so it is compared with the source instead."));

  out.push(expectedSynthesis(ctx, who, count));
  if (!count) { out.push(notRun("shadow.footprint", S, who, "No shadow on this output.")); return out; }


  // Footprint: silhouette plus feather. A shadow pixel must sit within the render's feather of the
  // product mask (so it follows overhangs and insets), in the lower half of the product, and inside the band.
  // In kept mode the render's own kept-darkness mask (keptShadowCanvasMask) is the photographer's shadow on every side of
  // the product, so only darkening outside both the feather and that mask counts.
  const { radius } = shadowFeather(productBox), near = dilate(ctx.product, canvas.w, canvas.h, radius), lowerHalf = productBox.y + productBox.h / 2, kept = keptShadowCanvasMask(ctx);
  let outsideBand = 0;
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) { const i = y * canvas.w + x; if (dark[i]! > 0 && !kept?.[i] && (y >= band.y + band.h || !near[i] || y < lowerHalf)) outsideBand++; }
  out.push(judge(outsideBand === 0, "shadow.footprint", S, who, outsideBand, 0, "pixels outside silhouette plus feather", outsideBand ? `${outsideBand} shadow pixels lie outside the silhouette plus its feather under the product${kept ? " and outside the render's kept-darkness mask" : ""}.` : `The shadow follows the silhouette within its feather${kept ? " and the render's kept-darkness mask" : ""}.`));

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
