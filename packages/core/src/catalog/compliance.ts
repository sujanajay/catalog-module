import sharp from "sharp";
import { backgroundFor, channel, MAX_OUTPUT_BYTES } from "./channels";
import { effectiveMinimum, hexColor, safeBoxFor, type CanvasPlan } from "./render";
import { borderBand } from "./shadow";
import type { ChannelId } from "./types";

// Flat quality-70 and high-contrast quality-90 JPEG round trips are tested against this bound.
// Keep below 31 so white product pixels on the prescribed grey still count as foreground.
export const BG_TOLERANCE = 24;
export interface ComplianceInput { jpeg: Buffer; channel: ChannelId; shotNumber: number; plan: CanvasPlan; identifier: string; n: number; publicObjectPath: string; foregroundMask?: Buffer }
export async function checkOutput(input: ComplianceInput): Promise<{ ok: boolean; failures: string[] }> {
  const { jpeg, plan } = input, spec = channel(input.channel), failures: string[] = [];
  const fail = (code: string, sentence: string) => failures.push(`${code}: ${sentence}`);
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
    const safe = safeBoxFor(spec, { w, h }, wide), band = borderBand(w, h), color = hexColor(backgroundFor(spec.id, input.shotNumber));
    let backgroundBad = false, outside = false, x0 = w, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const offset = (y * w + x) * 3;
      const delta = Math.max(Math.abs(data[offset]! - color[0]), Math.abs(data[offset + 1]! - color[1]), Math.abs(data[offset + 2]! - color[2]));
      if (delta <= BG_TOLERANCE) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      const inSafe = x >= safe.x && x < safe.x + safe.w && y >= safe.y && y < safe.y + safe.h;
      if (!inSafe) { outside = true; backgroundBad = true; }
      // Zero-margin edges may contain foreground. Exposed parts of the band still must be clean.
      const product = plan.productBox;
      const foregroundAtEdge = input.foregroundMask?.length === w * h ? input.foregroundMask[y * w + x]! > 0 : product && x >= product.x && x < product.x + product.w && y >= product.y && y < product.y + product.h;
      const inBand = x < band.x || x >= w - band.x || y < band.y || y >= h - band.y;
      if (inBand && !foregroundAtEdge) backgroundBad = true;
    }
    if (backgroundBad) fail("background", "The exposed background or margin has the wrong colour.");
    if (outside) fail("inside_safe_box", "The product or shadow reaches outside the required margins.");
    if (spec.id === "styli" && (Math.abs(y1 + 1 - (h - 450)) > 1 || Math.abs((x0 + x1 + 1) / 2 - w / 2) > 1)) fail("styli_anchor", "The product must be centred on the Styli bottom guide.");
    if (spec.id === "noon" && wide && (x0 < Math.ceil(w * 0.05) || x1 + 1 > Math.floor(w * 0.95))) fail("noon_wide", "Wide Noon shots need at least 5% side margins.");
  } catch { fail("format", "The encoded image cannot be decoded."); }
  return { ok: failures.length === 0, failures };
}
