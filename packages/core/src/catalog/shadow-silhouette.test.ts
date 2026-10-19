import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "./channels";
import { bbox, planCanvas, renderSource, type CanvasPlan, type Matte, type Prepared } from "./render";
import { analyseBackground, cutAtBottom, preservedDarkness, shadowLayer, SHADOW_BAND_ABOVE, SHADOW_PRESET } from "./shadow";

// A standing model on white: a wide upper body, two trouser legs and two feet that stop 15 px above
// the frame bottom (like the French Connection full-length shots).
function model(opts: { legsTo?: number; height?: number } = {}): { prepared: Prepared; matte: Matte } {
  const width = 400, height = opts.height ?? 600, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  const paint = (x0: number, x1: number, y0: number, y1: number, value: number) => {
    for (let y = y0; y < Math.min(height, y1); y++) for (let x = x0; x < x1; x++) { const i = y * width + x; rgb.fill(value, i * 3, i * 3 + 3); alpha[i] = 255; }
  };
  paint(40, 360, 40, 400, 200);
  const legsTo = opts.legsTo ?? 560;
  paint(150, 195, 400, legsTo, 20); paint(205, 250, 400, legsTo, 20);
  // Feet whose soles round off toward the floor, 15 px above the frame bottom.
  if (opts.legsTo === undefined) for (let y = 560; y < 585; y++) {
    const half = Math.round(16 * Math.sqrt(1 - ((y - 560) / 25) ** 2));
    paint(174 - half, 174 + half, y, y + 1, 60); paint(226 - half, 226 + half, y, y + 1, 60);
  }
  return {
    prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" },
    matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null },
  };
}

async function layerOf(prepared: Prepared, matte: Matte, channel: keyof typeof CHANNELS, background = "#E0E0E0"): Promise<{ grey: Buffer; plan: CanvasPlan; flags: string[] }> {
  const box = bbox(matte.alpha, prepared.width, prepared.height)!, plan = planCanvas(CHANNELS[channel], box, { w: prepared.width, h: prepared.height }, {});
  const shadow = await shadowLayer(prepared, matte, box, plan, "other", background);
  expect(shadow.layer).not.toBeNull();
  return { grey: await sharp(shadow.layer!).toColourspace("b-w").raw().toBuffer(), plan, flags: shadow.flags };
}

describe("synthesised contact shadow follows the silhouette", () => {
  // Noon and Namshi keep a 10% bottom margin; Trendyol puts the feet in the border band.
  it.each(["noon", "namshi", "trendyol", "sixthstreet"] as const)("has no hard edge anywhere on %s", async channel => {
    const { prepared, matte } = model();
    const { grey, plan, flags } = await layerOf(prepared, matte, channel);
    expect(flags).toEqual(["shadow_synthesised"]);
    let steepest = 0, darkest = 255;
    for (let y = 0; y < plan.h; y++) for (let x = 0; x < plan.w; x++) {
      const v = grey[y * plan.w + x]!; darkest = Math.min(darkest, v);
      if (x + 1 < plan.w) steepest = Math.max(steepest, Math.abs(v - grey[y * plan.w + x + 1]!));
      if (y + 1 < plan.h) steepest = Math.max(steepest, Math.abs(v - grey[(y + 1) * plan.w + x]!));
    }
    expect(darkest, "The shadow must exist").toBeLessThan(250);
    // The rectangular clip used to drop 30 to 60 grey levels between neighbouring pixels.
    expect(steepest, "Neighbouring shadow pixels may differ only by a feathered step").toBeLessThanOrEqual(6);
    // No straight horizontal edge: no row may hold a long run of shadow sitting on a much lighter row.
    let longest = 0;
    for (let y = 1; y < plan.h; y++) {
      let run = 0;
      for (let x = 0; x < plan.w; x++) { run = grey[y * plan.w + x]! < 250 && grey[(y - 1) * plan.w + x]! - grey[y * plan.w + x]! > 4 ? run + 1 : 0; longest = Math.max(longest, run); }
    }
    expect(longest, "Longest straight horizontal shadow edge").toBeLessThan(plan.w * 0.05);
  });

  it("stays within the legs' footprint plus its feather, never under the wide upper body", async () => {
    const { prepared, matte } = model();
    const { grey, plan } = await layerOf(prepared, matte, "noon");
    const product = plan.productBox!, box = plan.sourceBox!, scale = product.w / box.w;
    const depth = SHADOW_PRESET.spread * Math.min(product.w, product.h);
    const sigmaX = Math.max(SHADOW_PRESET.softness * product.w, depth / 2), sigmaY = depth / 2;
    const left = product.x + (150 - box.x) * scale - 3 * sigmaX - 1, right = product.x + (250 - box.x) * scale + 3 * sigmaX + 1;
    expect(right - left, "The footprint is the legs, far narrower than the body").toBeLessThan(product.w * 0.75);
    const top = product.y + product.h - 4 * sigmaY - 1;
    let x0 = plan.w, x1 = -1, y0 = plan.h;
    for (let y = 0; y < plan.h; y++) for (let x = 0; x < plan.w; x++) if (255 - grey[y * plan.w + x]! > 1) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); }
    expect(x1, "The shadow must exist").toBeGreaterThan(0);
    expect(x0, "Shadow reaches left of the footprint").toBeGreaterThanOrEqual(left);
    expect(x1, "Shadow reaches right of the footprint").toBeLessThanOrEqual(right);
    expect(y0, "Shadow climbs above the contact").toBeGreaterThanOrEqual(top);
    // Under the upper body only, outside the legs' feather, the canvas is untouched.
    const bodyOnly = Math.round(product.x + (60 - box.x) * scale);
    for (let y = 0; y < plan.h; y++) expect(grey[y * plan.w + bodyOnly]).toBe(255);
  });

  it("keeps required margins and the border band exact on every channel", async () => {
    const { prepared, matte } = model();
    for (const channel of ["noon", "namshi", "trendyol", "centrepoint", "sixthstreet", "shein"] as const) {
      const output = await renderSource({ prepared, matte, channel, shotNumber: 2, productType: "other" });
      expect(output.compliance, channel).toEqual({ ok: true, failures: [] });
      expect(output.flags).toContain("shadow_synthesised");
    }
  });
});

describe("photos cut off at the bottom of the frame", () => {
  it("detects a product running into the last row, and a straight cut over a thin white strip", () => {
    expect(cutAtBottom(model({ legsTo: 600 }).matte)).toBe(true);
    // Cut at the knees, then padded with 10 px of white: a long straight edge just above the frame bottom.
    expect(cutAtBottom(model({ legsTo: 590 }).matte)).toBe(true);
    // A flared dress hem ending 1.5% above a cut through the legs (the French Connection dress shot).
    const dress = model({ legsTo: 590 }).matte;
    for (let y = 400; y < 580; y++) for (let x = 100; x < 300; x++) dress.alpha[y * 400 + x] = 255;
    expect(cutAtBottom(dress)).toBe(true);
  });

  it("does not mistake feet standing near the bottom, or a stray edge pixel, for a cut", () => {
    const { matte } = model();
    expect(cutAtBottom(matte)).toBe(false);
    matte.alpha[599 * 400 + 10] = 255; matte.alpha[599 * 400 + 11] = 200;
    expect(cutAtBottom(matte)).toBe(false);
  });

  it("gets no shadow of either kind and is flagged complete_product", async () => {
    const { prepared, matte } = model({ legsTo: 590 });
    const box = bbox(matte.alpha, prepared.width, prepared.height)!, plan = planCanvas(CHANNELS.noon, box, { w: 400, h: 600 }, {});
    for (const type of ["other", "footwear", "apparel_model"] as const) expect(await shadowLayer(prepared, matte, box, plan, type, "#E0E0E0")).toEqual({ layer: null, flags: ["complete_product", "no_shadow_source"] });
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "other" });
    expect(output.flags).toContain("complete_product");
    expect(output.flags).not.toContain("shadow_synthesised");
    expect(output.compliance.ok).toBe(true);
  });
});

describe("preserved shadow beyond the measuring band", () => {
  it("fades out past the band instead of stopping on a straight line", () => {
    const width = 200, height = 240, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
    // A real soft shadow beside and under a shoe, reaching well above the band's top edge.
    for (let y = 150; y < 215; y++) for (let x = 30; x < 170; x++) rgb.fill(200, (y * width + x) * 3, (y * width + x) * 3 + 3);
    for (let y = 100; y < 200; y++) for (let x = 50; x < 150; x++) { const i = y * width + x; rgb.fill(30, i * 3, i * 3 + 3); alpha[i] = 255; }
    const prepared: Prepared = { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" };
    const matte: Matte = { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null };
    const box = { x: 50, y: 100, w: 100, h: 100 }, top = box.y + Math.floor(box.h * (1 - SHADOW_BAND_ABOVE)), reach = Math.round(box.h * SHADOW_BAND_ABOVE);
    const dark = preservedDarkness(prepared, matte, box, "footwear")!;
    expect(dark).not.toBeNull();
    const at = (x: number, y: number) => dark[y * width + x]!;
    expect(at(45, top)).toBeGreaterThan(0);
    expect(at(45, top - 1), "No step at the band's top edge").toBeGreaterThanOrEqual(at(45, top) * 0.9);
    for (let y = top - 1; y > top - reach; y--) expect(at(45, y)).toBeLessThanOrEqual(at(45, y + 1));
    expect(at(45, top - reach), "Fully faded one band height above").toBe(0);
  });
});
