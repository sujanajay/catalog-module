// Cut-out integrity (spec 10 section 5): the matte is compared with an independent estimate of the
// product taken from the source's own colours, region by region, so a lost strap or lace shows up
// even when the rest of the silhouette is right; then the output is checked for background left
// around the product, a colour fringe from the source background, and holes. `checkMatte` needs only
// the source and the matte, so the matting bake-off scores every model with the same bar.
import { components, delta, dilate, erode, lumaAt, maskCount, thresholdMask, type Mask } from "./image";
import { ALPHA_EDGE, type OutputContext } from "./context";
import { SHADOW_RING_CHROMA_MAX, shadowLikePixel } from "./geometry";
import { judge, notRun, type CheckResult, type CheckSubject, type Raster } from "./types";
import { bbox } from "../render";
import { SHADOW_BAND_ABOVE } from "../shadow";

/** Source pixels farther than this from the source background are product (colour estimate). */
export const SOURCE_FOREGROUND_DELTA = 30;
/** A source pixel is read as the source's own cast shadow (not product) when it is nearly grey and no darker than this share of the background luma. */
export const SHADOW_CHROMA_MAX = 24;
export const SHADOW_MIN_LUMA_SHARE = 0.55;
/** Lower share of the silhouette where any unmatted darkening up to this chroma is the contact shadow. */
export const SHADOW_ZONE_SHARE = 0.4;
export const SHADOW_ZONE_CHROMA_MAX = 72;
/**
 * A floor reflection: a thin band of the product's own colour under the matte's lowest row in its column (eval run 2,
 * Anta bd-112621603-1: 1 to 7 source px of faded pink under the sole, chroma up to 92). It is lighter than the product it
 * mirrors and never more saturated than it, so a lost sole part (the lime midsole of bd-112625546-12, chroma 100 to 150
 * under a black outsole) still counts. The band is at most REFLECTION_MAX_SHARE of the frame height, never under 8 px.
 */
export const REFLECTION_MAX_SHARE = 0.015;
export const REFLECTION_CHROMA_SLACK = 12;
/** Grid over the product's bounding box for the per-region loss measurement. */
export const REGION_GRID = 6;
/** A region needs at least this many estimated product pixels to be measured. */
export const REGION_MIN_PIXELS = 200;
/** Share of estimated product pixels the matte may drop, per region and overall. */
export const REGION_LOSS_MAX = 0.01;
export const GLOBAL_LOSS_MAX = 0.003;
/** Thin structures (removed by a radius-2 opening) may lose at most this share. */
export const THIN_LOSS_MAX = 0.1;
export const THIN_MIN_PIXELS = 100;
/**
 * Share of product pixels (alpha > 10) the colour estimate (dilated BACKGROUND_KEPT_DILATE_PX) says are plain source
 * background. Eval run 2 (anta.footwear, 584 matted outputs): the matte's own soft fringe (alpha 10 to 60) sits 2 to 3
 * px beyond the colour estimate on every colour shoe, invisible on the canvas: p50 0.13%, p90 0.69%, p95 0.86%, max
 * 1.48% (a 450 px copy, shorter perimeter) with the estimate dilated 2 px; a model that keeps a 90 px strip of
 * background beside the product measures over 15%.
 */
export const BACKGROUND_KEPT_MAX = 0.01;
export const BACKGROUND_KEPT_DILATE_PX = 3;
/** Share of the 3 px ring around the product that is not canvas background (outside the shadow band). */
export const HALO_RING_MAX = 0.02;
/** Share of soft-edge pixels that still carry the source background colour. */
export const FRINGE_MAX = 0.01;
/** Holes: interior regions the matte drops, as a share of the estimated product area. */
export const HOLE_MIN_SHARE = 0.0005;
/** See-through: interior product pixels whose alpha dips under this (faint patches inside a body). */
export const SEE_THROUGH_ALPHA = 200;
export const SEE_THROUGH_MAX = 0.002;
/** Mean width of the soft alpha band along the silhouette (over-blurred edges look like a halo). */
export const EDGE_SOFTNESS_MAX_PX = 3;

const C = "cutout" as const;

export interface MatteInput { identifier: string; n: number; source: Raster; sourceBackground: { uniform: boolean; color: [number, number, number] }; alpha: Buffer }

/** Product estimate from the source colours: far from the border colour, minus shadow-like achromatic darkening under the matte. */
export function estimateForeground(input: MatteInput, sourceBox: { y: number; h: number }): { mask: Mask; count: number } {
  const { source, sourceBackground: bgInfo, alpha } = input, bg = bgInfo.color;
  const w = source.w, h = source.h, raw = new Uint8Array(w * h);
  const bgLuma = lumaAt(Buffer.from(bg), 0), zoneTop = sourceBox.y + sourceBox.h * (1 - SHADOW_ZONE_SHARE);
  // Per column: the matte's lowest row and the mean luma and chroma of its lowest three matted rows (what a floor
  // reflection under that column mirrors).
  const colBottom = new Int32Array(w).fill(-1), colLuma = new Float32Array(w), colChroma = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let rows = 0;
    for (let y = h - 1; y >= 0 && rows < 3; y--) {
      const i = y * w + x;
      if (alpha[i]! <= ALPHA_EDGE) { if (rows) break; continue; }
      if (!rows) colBottom[x] = y;
      const r = source.rgb[i * 3]!, g = source.rgb[i * 3 + 1]!, b = source.rgb[i * 3 + 2]!;
      colLuma[x] = colLuma[x]! + lumaAt(source.rgb, i) / 3; colChroma[x] = colChroma[x]! + (Math.max(r, g, b) - Math.min(r, g, b)) / 3; rows++;
    }
  }
  const reflectionDepth = Math.max(8, Math.round(h * REFLECTION_MAX_SHARE));
  for (let i = 0; i < raw.length; i++) {
    if (delta(source.rgb, i, bg) <= SOURCE_FOREGROUND_DELTA) continue;
    const r = source.rgb[i * 3]!, g = source.rgb[i * 3 + 1]!, b = source.rgb[i * 3 + 2]!, l = lumaAt(source.rgb, i), chroma = Math.max(r, g, b) - Math.min(r, g, b);
    // The source's own cast shadow, not product: outside the lower zone of the silhouette only a soft
    // grey darkening counts; inside it (where a contact shadow is dark and picks up colour bleed from
    // the sole) any unmatted darkening does. Dark product parts elsewhere stay in the estimate.
    const x = i % w, y = (i - x) / w, inZone = y >= zoneTop;
    let shadowLike = l < bgLuma && (inZone ? chroma < SHADOW_ZONE_CHROMA_MAX : chroma < SHADOW_CHROMA_MAX && l >= bgLuma * SHADOW_MIN_LUMA_SHARE);
    // A floor reflection under the matte's lowest row: a thin, lighter, no more saturated copy of the product above it.
    if (!shadowLike && inZone && l < bgLuma && colBottom[x]! >= 0 && y > colBottom[x]! && y - colBottom[x]! <= reflectionDepth && l > colLuma[x]! && chroma <= colChroma[x]! + REFLECTION_CHROMA_SLACK) shadowLike = true;
    if (shadowLike && alpha[i]! <= ALPHA_EDGE) continue;
    raw[i] = 1;
  }
  // Drop specks (sensor noise, dust) smaller than 0.02% of the frame.
  const { labels, sizes } = components(raw, w, h), minSize = Math.max(16, Math.round(w * h * 0.0002));
  const mask = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) if (raw[i] && sizes[labels[i]!]! >= minSize) mask[i] = 1;
  return { mask, count: maskCount(mask) };
}

export interface MatteMetrics {
  regionLoss: number | null; globalLoss: number | null; thinLoss: number | null; backgroundKept: number | null; holes: number | null; seeThrough: number | null; edgeSoftness: number | null;
  /** Against the other models' majority (bake-off only): share of consensus product this matte drops, and share of this matte the consensus calls background. */
  consensusLoss?: number | null; consensusExtra?: number | null;
}

/** Majority of the other mattes (alpha over one half) versus this one, for the bake-off. */
export function consensusMetrics(alpha: Buffer, others: readonly Buffer[]): { consensusLoss: number; consensusExtra: number } {
  if (!others.length) return { consensusLoss: 0, consensusExtra: 0 };
  let consensus = 0, lost = 0, mine = 0, extra = 0;
  const need = Math.ceil(others.length / 2);
  for (let i = 0; i < alpha.length; i++) {
    let votes = 0;
    for (const o of others) if (o[i]! > 128) votes++;
    const agreed = votes >= need, here = alpha[i]! > ALPHA_EDGE;
    if (agreed) { consensus++; if (!here) lost++; }
    if (here) { mine++; if (votes === 0) extra++; }
  }
  return { consensusLoss: consensus ? lost / consensus : 0, consensusExtra: mine ? extra / mine : 0 };
}

/** The matte-only checks; `metrics` carries the raw numbers for ranking models. */
export function checkMatte(input: MatteInput, channel: CheckSubject["channel"] = null): { results: CheckResult[]; metrics: MatteMetrics } {
  const who: CheckSubject = { identifier: input.identifier, n: input.n, channel };
  const metrics: MatteMetrics = { regionLoss: null, globalLoss: null, thinLoss: null, backgroundKept: null, holes: null, seeThrough: null, edgeSoftness: null };
  const out: CheckResult[] = [], w = input.source.w, h = input.source.h, alpha = input.alpha;
  const sourceBox = bbox(alpha, w, h);
  if (!input.sourceBackground.uniform || !sourceBox) { out.push(notRun("cutout.pixels_lost", C, who, sourceBox ? "The source background is not uniform, so no independent product estimate is possible." : "The matte holds no product.")); return { results: out, metrics }; }
  const { mask: fg, count } = estimateForeground(input, sourceBox);
  const matted = thresholdMask(alpha, ALPHA_EDGE);
  if (count < REGION_MIN_PIXELS) { out.push(notRun("cutout.pixels_lost", C, who, "Too few product pixels can be told from the background by colour.")); return { results: out, metrics }; }

  // Per-region loss over a grid on the estimate's bounding box.
  let gx0 = w, gy0 = h, gx1 = -1, gy1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fg[y * w + x]) { gx0 = Math.min(gx0, x); gy0 = Math.min(gy0, y); gx1 = Math.max(gx1, x); gy1 = Math.max(gy1, y); }
  const cellW = (gx1 - gx0 + 1) / REGION_GRID, cellH = (gy1 - gy0 + 1) / REGION_GRID;
  const total = new Uint32Array(REGION_GRID * REGION_GRID), lost = new Uint32Array(REGION_GRID * REGION_GRID);
  let lostAll = 0;
  for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) {
    const i = y * w + x; if (!fg[i]) continue;
    const cell = Math.min(REGION_GRID - 1, Math.floor((y - gy0) / cellH)) * REGION_GRID + Math.min(REGION_GRID - 1, Math.floor((x - gx0) / cellW));
    total[cell] = total[cell]! + 1; if (!matted[i]) { lost[cell] = lost[cell]! + 1; lostAll++; }
  }
  let worst = 0, worstCell = -1;
  for (let c = 0; c < total.length; c++) if (total[c]! >= REGION_MIN_PIXELS) { const share = lost[c]! / total[c]!; if (share > worst) { worst = share; worstCell = c; } }
  const globalShare = lostAll / count;
  metrics.regionLoss = worst; metrics.globalLoss = globalShare;
  out.push(judge(worst <= REGION_LOSS_MAX && globalShare <= GLOBAL_LOSS_MAX, "cutout.pixels_lost", C, who, Math.round(worst * 1e4) / 1e4, REGION_LOSS_MAX, "share lost in the worst region", `Worst region (row ${Math.floor(worstCell / REGION_GRID) + 1}, column ${worstCell % REGION_GRID + 1} of ${REGION_GRID}x${REGION_GRID}) loses ${(worst * 100).toFixed(2)}% of its product pixels; overall ${(globalShare * 100).toFixed(2)}%.`));

  // Thin parts: what a radius-2 opening removes (straps, laces, hair, heels).
  const opened = dilate(erode(fg, w, h, 2), w, h, 2);
  let thin = 0, thinLost = 0;
  for (let i = 0; i < fg.length; i++) if (fg[i] && !opened[i]) { thin++; if (!matted[i]) thinLost++; }
  if (thin >= THIN_MIN_PIXELS) { metrics.thinLoss = thinLost / thin; out.push(judge(thinLost / thin <= THIN_LOSS_MAX, "cutout.thin_parts", C, who, Math.round(thinLost / thin * 1e3) / 1e3, THIN_LOSS_MAX, "share of thin pixels lost", `${(100 * thinLost / thin).toFixed(1)}% of ${thin} thin product pixels (straps, laces, hair) are missing from the cut-out.`)); }
  else out.push(notRun("cutout.thin_parts", C, who, "The product has no thin structures to measure."));

  // Background kept inside the matte: matted pixels the colour estimate (dilated 2 px) does not cover and that match the source background.
  // White product parts carry no colour evidence, so only background-coloured matte pixels outside the
  // silhouette's span (no product evidence left and right, or above and below) count as kept background.
  const near = dilate(fg, w, h, BACKGROUND_KEPT_DILATE_PX), rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1), colMin = new Int32Array(w).fill(h), colMax = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fg[y * w + x]) { if (x < rowMin[y]!) rowMin[y] = x; if (x > rowMax[y]!) rowMax[y] = x; if (y < colMin[x]!) colMin[x] = y; if (y > colMax[x]!) colMax[x] = y; }
  let kept = 0, mattedCount = 0;
  for (let i = 0; i < fg.length; i++) if (matted[i]) {
    mattedCount++;
    const x = i % w, y = (i - x) / w, enclosed = x > rowMin[y]! && x < rowMax[y]! && y > colMin[x]! && y < colMax[x]!;
    if (!near[i] && !enclosed && delta(input.source.rgb, i, input.sourceBackground.color) <= 10) kept++;
  }
  const keptShare = mattedCount ? kept / mattedCount : 0;
  metrics.backgroundKept = keptShare;
  out.push(judge(keptShare <= BACKGROUND_KEPT_MAX, "cutout.background_kept", C, who, Math.round(keptShare * 1e4) / 1e4, BACKGROUND_KEPT_MAX, "share of matte that is source background", `${(keptShare * 100).toFixed(2)}% of the cut-out is plain source background.`));

  // Holes and see-through patches: the interior of the estimate the matte drops or thins.
  const interior = erode(fg, w, h, 3), holeMask = new Uint8Array(fg.length);
  let interiorCount = 0, seeThrough = 0;
  for (let i = 0; i < fg.length; i++) if (interior[i]) { interiorCount++; if (!matted[i]) holeMask[i] = 1; if (alpha[i]! < SEE_THROUGH_ALPHA) seeThrough++; }
  const holes = components(holeMask, w, h).sizes.slice(1).filter(size => size >= count * HOLE_MIN_SHARE).length;
  metrics.holes = holes;
  out.push(judge(holes === 0, "cutout.holes", C, who, holes, 0, "holes", holes ? `${holes} hole(s) inside the product where the cut-out dropped pixels.` : "No holes inside the product."));
  const seeShare = interiorCount ? seeThrough / interiorCount : 0;
  metrics.seeThrough = seeShare;
  out.push(judge(seeShare <= SEE_THROUGH_MAX, "cutout.see_through", C, who, Math.round(seeShare * 1e4) / 1e4, SEE_THROUGH_MAX, "share of interior under alpha 200", `${(seeShare * 100).toFixed(2)}% of the product interior is partly transparent in the matte.`));

  // Edge softness: soft alpha pixels per unit of silhouette length.
  const boundary = dilate(matted, w, h, 1);
  let soft = 0, edgeLength = 0;
  for (let i = 0; i < alpha.length; i++) { if (alpha[i]! > ALPHA_EDGE && alpha[i]! < 245) soft++; if (boundary[i] && !matted[i]) edgeLength++; }
  const softness = edgeLength ? soft / edgeLength : 0;
  metrics.edgeSoftness = softness;
  out.push(judge(softness <= EDGE_SOFTNESS_MAX_PX, "cutout.edge_softness", C, who, Math.round(softness * 100) / 100, EDGE_SOFTNESS_MAX_PX, "px of soft edge", `The soft edge band averages ${softness.toFixed(2)} px wide.`));
  return { results: out, metrics };
}

/** The output is the photo itself (spec 07 pass-through): the matte was not used, so matte-against-photo checks do not apply. */
export const PASSTHROUGH_FLAGS: readonly string[] = ["matte_passthrough", "passthrough"];

export function checkCutout(ctx: OutputContext): CheckResult[] {
  const { subject: s, canvas, background, product, band, productBox } = ctx;
  const who: CheckSubject = { identifier: s.identifier, n: s.n, channel: s.channel };
  const passthrough = s.flags.some(f => PASSTHROUGH_FLAGS.includes(f));
  const out: CheckResult[] = checkMatte({ identifier: s.identifier, n: s.n, source: s.source, sourceBackground: s.sourceBackground, alpha: s.alpha }, s.channel).results
    .map(r => (passthrough && r.id === "cutout.background_kept" ? notRun(r.id, C, who, "The photo is kept whole by rule (pass-through), so its own background inside the matte is not kept background.") : r));

  // Halo ring on the canvas: the 3 px ring around the product must be canvas background. Where a shadow is allowed, a
  // kept photographic shadow runs up the sides and in front of the product to SHADOW_BAND_ABOVE of its height above the
  // band (the render's continueBeyondBand), so achromatic darkening there (with the chroma JPEG ringing lends it next to
  // a coloured product) is the shadow, not a halo; a coloured ring or any ring higher up the silhouette counts.
  const ring = dilate(product, canvas.w, canvas.h, 3), reach = Math.ceil(productBox.h * SHADOW_BAND_ABOVE);
  let ringPixels = 0, ringBad = 0;
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) {
    const i = y * canvas.w + x;
    if (!ring[i] || product[i]) continue;
    if (ctx.shadowAllowed && y >= band.y - reach && x >= band.x && x < band.x + band.w && shadowLikePixel(ctx, i, SHADOW_RING_CHROMA_MAX)) continue;
    ringPixels++; if (delta(canvas.rgb, i, background) > 12) ringBad++;
  }
  const haloShare = ringPixels ? ringBad / ringPixels : 0;
  out.push(judge(haloShare <= HALO_RING_MAX, "cutout.halo", C, who, Math.round(haloShare * 1e4) / 1e4, HALO_RING_MAX, "share of the ring off background", `${(haloShare * 100).toFixed(2)}% of the 3 px ring around the product is not canvas background${ctx.shadowAllowed ? " (shadow-like darkening in the shadow band excluded)" : ""}.`));

  // Colour fringe: soft-edge pixels that still show the source background colour, when it differs from the canvas.
  const sbg = s.sourceBackground.color;
  if (passthrough) out.push(notRun("cutout.fringe", C, who, "The photo is kept whole by rule (pass-through); its own background is not a fringe."));
  else if (!s.sourceBackground.uniform) out.push(notRun("cutout.fringe", C, who, "The source has no uniform border, so a fringe in its colour cannot be told from the product."));
  else if (Math.max(Math.abs(sbg[0] - background[0]), Math.abs(sbg[1] - background[1]), Math.abs(sbg[2] - background[2])) <= 20) out.push(notRun("cutout.fringe", C, who, "Source and canvas backgrounds match, so a fringe cannot be told apart."));
  else {
    let edge = 0, fringe = 0;
    for (let i = 0; i < ctx.expectedAlpha.length; i++) {
      const a = ctx.expectedAlpha[i]!;
      if (a <= ALPHA_EDGE || a > 200) continue;
      edge++; if (delta(canvas.rgb, i, sbg) <= 10) fringe++;
    }
    const share = edge ? fringe / edge : 0;
    out.push(judge(share <= FRINGE_MAX, "cutout.fringe", C, who, Math.round(share * 1e4) / 1e4, FRINGE_MAX, "share of soft-edge pixels in the source background colour", `${(share * 100).toFixed(2)}% of the soft edge carries the source background colour.`));
  }
  return out;
}
