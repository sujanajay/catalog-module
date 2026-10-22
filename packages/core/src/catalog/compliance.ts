import sharp from "sharp";
import { backgroundFor, channel, MAX_OUTPUT_BYTES } from "./channels";
import { effectiveMinimum, hexColor, NO_CUT, safeBoxFor, type BBox, type CanvasPlan } from "./render";
import { borderBand } from "./shadow";
import type { ChannelId } from "./types";

// Flat quality-70 and high-contrast quality-90 JPEG round trips are tested against this bound.
// Keep below 31 so white product pixels on the prescribed grey still count as foreground.
export const BG_TOLERANCE = 24;
/**
 * The Styli guide (styli_anchor) is judged on the product (anchorBounds): where the render's foreground mask (the placed
 * cut-out's alpha) is at least this, the matte's half-alpha silhouette, together with what is seen (more than
 * BG_TOLERANCE off the canvas colour) inside the cut-out. A white or pale grey product is barely seen on the #E0E0E0
 * canvas (white cotton photographs at 240 to 250), so the seen pixels alone leave out whole parts of it; the soft outer
 * fade below this alpha is left to what is seen. Without a mask (a re-check of a stored JPEG) only what is seen counts.
 */
export const ANCHOR_MASK_ALPHA = 128;
/** The sentence an operator reads when a Styli render is not on the guide (the code `styli_anchor` stays in `failures`). */
export const STYLI_ANCHOR_SENTENCE = "The product was not standing centred on Styli's bottom guide.";
/**
 * What "the product" is for the Styli guide, for the placement (render.ts visibleAnchorShift) and the check alike: the box
 * of the product pixels in `rgb` (3 bytes per pixel, w x h), with `mask` the cut-out's alpha at the same pixels. A
 * product pixel is where the mask is at least ANCHOR_MASK_ALPHA, or where the mask is above 0 and the pixel is seen
 * (more than BG_TOLERANCE off `background`): the half-alpha silhouette plus the part of its soft edge that shows. A
 * pixel where the mask is 0 is never the product, whatever it shows. A floor shadow kept from the source photo
 * (shadow.ts preservedDarkness) is composited outside the cut-out and darkens the canvas there, on a model photo mostly
 * to one side of the feet: counting it (batch b8a99c1b, 2026-10-21, nine Styli renders with a kept shadow seen 2 to
 * 20 px beyond one side of the silhouette) put the measured centre 1.5 to 2.5 px off the guide, while the placement,
 * which only ever saw the cut-out, had the product centred, so `styli_anchor` failed for pixels no one calls the
 * product. The background and margin checks still see every pixel, shadow included. Without a mask (a re-check of a
 * stored JPEG alone) only what is seen counts, as close as the JPEG allows. Null when no pixel is the product.
 */
export function anchorBounds(rgb: Buffer, w: number, h: number, background: [number, number, number], mask: Buffer | null): BBox | null {
  if (rgb.length < w * h * 3 || (mask && mask.length !== w * h)) throw new Error("anchorBounds: the pixel buffers do not match the size");
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = mask ? mask[i]! : 1;
    if (!a) continue;
    if (a < ANCHOR_MASK_ALPHA) {
      const o = i * 3, delta = Math.max(Math.abs(rgb[o]! - background[0]), Math.abs(rgb[o + 1]! - background[1]), Math.abs(rgb[o + 2]! - background[2]));
      if (delta <= BG_TOLERANCE) continue;
    }
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/**
 * A JPEG codes the picture in 8 x 8 pixel blocks, and the round trip of a hard, saturated edge spreads a faint tint into
 * the rest of its block (never past it). A product as wide as Styli's safe box (2042 px, a square product) sits with its
 * sides on the safe box's edges, so a red, blue, yellow or green product left 1 to 6 px of that tint just outside the
 * guide in the corner blocks (more than BG_TOLERANCE off the canvas colour), and `inside_safe_box` and `background`
 * failed at any scale for a pixel no one can see (2026-10-22). So a seen pixel that is not the product but shares a
 * block with the product (the render's foreground mask above 0) is the product's own compression bleed and is not
 * judged; a product or shadow pixel in a block of its own still is. Without a mask every seen pixel is judged.
 */
export const JPEG_BLOCK_PX = 8;
const blockIndex = (w: number, x: number, y: number) => Math.floor(y / JPEG_BLOCK_PX) * Math.ceil(w / JPEG_BLOCK_PX) + Math.floor(x / JPEG_BLOCK_PX);
/** One byte per JPEG block (row-major, JPEG_BLOCK_PX square, the last row and column partial): 1 where a pixel is the product. */
function productBlocks(w: number, h: number, isProduct: (x: number, y: number) => boolean): Uint8Array {
  const blocks = new Uint8Array(Math.ceil(w / JPEG_BLOCK_PX) * Math.ceil(h / JPEG_BLOCK_PX));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isProduct(x, y)) blocks[blockIndex(w, x, y)] = 1;
  return blocks;
}
export interface ComplianceInput { jpeg: Buffer; channel: ChannelId; shotNumber: number; plan: CanvasPlan; identifier: string; n: number; publicObjectPath: string; foregroundMask?: Buffer }
/**
 * What the check measured, kept with the failures so a repair can compute its fix from the numbers (07 4.6a):
 * `seen` is the product's box as the check sees it (seen pixels plus the half-alpha silhouette), `outside` how many
 * px of it lie past the safe box per side (0 inside), `anchorDelta` the move (canvas px) that would put a Styli
 * product on its guide (null off Styli or where a cut side fixes the axis), `bandBreach` whether the border band
 * holds a wrong colour outside the product. Never shown to operators.
 */
export interface Measured {
  canvas: { w: number; h: number }; safe: BBox; seen: BBox | null;
  outside: { top: number; bottom: number; left: number; right: number };
  anchorDelta: { dx: number; dy: number } | null; bandBreach: boolean; bytes: number;
}
export type ComplianceCode = "magic" | "bytes" | "trendyol_name" | "extension" | "format" | "dims" | "density" | "background" | "inside_safe_box" | "styli_anchor" | "noon_wide";
/** Codes our own encoder settings decide (not the photo): a second identical failure is a code fault, held for the technical team, never dropped (07 4.6a). */
export const ENCODER_CODES: readonly ComplianceCode[] = ["dims", "density", "format", "magic", "extension", "trendyol_name"];
/** The rule codes of a `failures` list ("code: sentence"). */
export const failureCodes = (failures: readonly string[]): ComplianceCode[] => failures.map(f => f.split(":")[0] as ComplianceCode);
export async function checkOutput(input: ComplianceInput): Promise<{ ok: boolean; failures: string[]; measured: Measured }> {
  const { jpeg, plan } = input, spec = channel(input.channel), failures: string[] = [];
  const fail = (code: ComplianceCode, sentence: string) => failures.push(`${code}: ${sentence}`);
  const measured: Measured = { canvas: { w: plan.w, h: plan.h }, safe: plan.safeBox, seen: null, outside: { top: 0, bottom: 0, left: 0, right: 0 }, anchorDelta: null, bandBreach: false, bytes: jpeg.length };
  if (!jpeg.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) fail("magic", "The file is not a JPEG.");
  if (jpeg.length > MAX_OUTPUT_BYTES) fail("bytes", `Could not get ${input.identifier}_${input.n} for ${input.channel} under 2 MB.`);
  if (input.publicObjectPath.includes(" ")) fail("trendyol_name", "The output path contains spaces.");
  if (!input.publicObjectPath.endsWith(".jpg")) fail("extension", "The output path must end in lowercase .jpg.");
  try {
    const meta = await sharp(jpeg).metadata();
    if (meta.format !== "jpeg" || meta.chromaSubsampling !== "4:4:4" || meta.space !== "srgb" || !meta.hasProfile || meta.hasAlpha) fail("format", "Use an sRGB JPEG with a colour profile and 4:4:4 colour sampling.");
    const w = meta.width!, h = meta.height!, min = effectiveMinimum(spec), target = spec.targetCanvas;
    if (w !== plan.w || h !== plan.h || (spec.fixedCanvas ? w !== target.w || h !== target.h : w < min.w || h < min.h || w > target.w || h > target.h || Math.abs(h - w * target.h / target.w) > 1)) fail("dims", "The image dimensions do not meet this marketplace's canvas rules.");
    if (meta.density !== spec.dpi) fail("density", `The image must use ${spec.dpi} DPI.`);
    const { data } = await sharp(jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const source = plan.sourceBox, wide = source ? source.w > source.h : (plan.productBox?.w ?? 0) > (plan.productBox?.h ?? 0);
    // A side cut in the source sits flush with the canvas edge (margin 0 on that side only).
    const cut = plan.cut ?? NO_CUT, safe = safeBoxFor(spec, { w, h }, wide, cut), band = borderBand(w, h), color = hexColor(backgroundFor(spec.id, input.shotNumber));
    measured.canvas = { w, h }; measured.safe = safe;
    let backgroundBad = false, outside = false, bandBad = false, x0 = w, x1 = -1, y0 = h, y1 = -1, ax0 = w, ax1 = -1, ay0 = h, ay1 = -1;
    const mask = input.foregroundMask?.length === w * h ? input.foregroundMask : null, product = plan.productBox;
    const isProduct = (x: number, y: number) => mask ? mask[y * w + x]! > 0 : !!product && x >= product.x && x < product.x + product.w && y >= product.y && y < product.y + product.h;
    // Only the mask says which pixels are the product; the plan's box alone could forgive a moved product's edge.
    const holdsProduct = mask ? productBlocks(w, h, isProduct) : null;
    // Every pixel that is seen, the shadow included, must keep to the safe box and off the border band.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const offset = (y * w + x) * 3;
      // The half-alpha silhouette counts toward the measured box even where it barely shows (a white product on the grey canvas).
      if (mask && mask[y * w + x]! >= ANCHOR_MASK_ALPHA) { ax0 = Math.min(ax0, x); ax1 = Math.max(ax1, x); ay0 = Math.min(ay0, y); ay1 = Math.max(ay1, y); }
      const delta = Math.max(Math.abs(data[offset]! - color[0]), Math.abs(data[offset + 1]! - color[1]), Math.abs(data[offset + 2]! - color[2]));
      if (delta <= BG_TOLERANCE) continue;
      const foreground = isProduct(x, y);
      // Compression bleed of the product's own edge (JPEG_BLOCK_PX), not a product or shadow pixel.
      if (!foreground && holdsProduct?.[blockIndex(w, x, y)]) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      const inSafe = x >= safe.x && x < safe.x + safe.w && y >= safe.y && y < safe.y + safe.h;
      if (!inSafe) { outside = true; backgroundBad = true; }
      const inBand = x < band.x || x >= w - band.x || y < band.y || y >= h - band.y;
      if (inBand && !foreground) { backgroundBad = true; bandBad = true; }
    }
    measured.bandBreach = bandBad;
    if (backgroundBad) fail("background", "The exposed background or margin has the wrong colour.");
    if (outside) fail("inside_safe_box", "The product or shadow reaches outside the required margins.");
    // The measured box a refit works from (07 4.6a): every judged pixel, the shadow included, and the half-alpha silhouette.
    const sx0 = Math.min(x0, ax0), sx1 = Math.max(x1, ax1), sy0 = Math.min(y0, ay0), sy1 = Math.max(y1, ay1);
    if (sx1 >= 0) {
      measured.seen = { x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1 };
      measured.outside = { top: Math.max(0, safe.y - sy0), bottom: Math.max(0, sy1 + 1 - safe.y - safe.h), left: Math.max(0, safe.x - sx0), right: Math.max(0, sx1 + 1 - safe.x - safe.w) };
    }
    if (spec.id === "styli") {
      // The product's box for the guide is the same box the placement used (anchorBounds): never the shadow.
      const box = anchorBounds(data, w, h, color, mask);
      const px0 = box?.x ?? w, px1 = box ? box.x + box.w - 1 : -1, py0 = box?.y ?? h, py1 = box ? box.y + box.h - 1 : -1;
      // The move onto the guide (the `reshift` repair), measured on that same box: only an axis with no cut side can move.
      if (box) measured.anchorDelta = { dx: cut.left || cut.right ? 0 : Math.round(w / 2 - (px0 + px1 + 1) / 2), dy: cut.top || cut.bottom ? 0 : (h - 450) - (py1 + 1) };
      const styliVertical = cut.bottom ? Math.abs(py1 + 1 - h) <= 1 : cut.top ? py0 <= 1 : Math.abs(py1 + 1 - (h - 450)) <= 1;
      const styliHorizontal = cut.left && !cut.right ? px0 <= 1 : cut.right && !cut.left ? px1 + 1 >= w - 1 : Math.abs((px0 + px1 + 1) / 2 - w / 2) <= 1;
      if (!box || !styliVertical || !styliHorizontal) fail("styli_anchor", STYLI_ANCHOR_SENTENCE);
    }
    if (spec.id === "noon" && wide && ((!cut.left && x0 < Math.ceil(w * 0.05)) || (!cut.right && x1 + 1 > Math.floor(w * 0.95)))) fail("noon_wide", "Wide Noon shots need at least 5% side margins.");
  } catch { fail("format", "The encoded image cannot be decoded."); }
  return { ok: failures.length === 0, failures, measured };
}
