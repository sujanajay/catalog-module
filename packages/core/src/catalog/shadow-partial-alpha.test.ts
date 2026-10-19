import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { preservedDarkness, shadowLayer } from "./shadow";
import type { BBox, CanvasPlan, Matte, Prepared } from "./render";

// Include both sides of the old silhouette cutoff and a nearly opaque edge.
const EDGE_ALPHAS = [0, 1, 2, 8, 10, 11, 21, 64, 128, 192, 254, 255];

function darkContactEdge(): { prepared: Prepared; matte: Matte; box: BBox; plan: CanvasPlan } {
  const width = 120, height = 120, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  const paint = (x: number, y: number, value: number) => rgb.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
  // A measured dark contact shadow, continuous under an uneven black sole.
  for (let y = 75; y < 91; y++) for (let x = 20; x < 100; x++) paint(x, y, 32);
  for (let y = 20; y < 75; y++) for (let x = 25; x < 95; x++) { paint(x, y, 32); alpha[y * width + x] = 255; }
  for (let y = 75; y < 80; y++) for (let x = 60; x < 95; x++) { paint(x, y, 32); alpha[y * width + x] = 255; }
  for (let n = 0; n < EDGE_ALPHAS.length; n++) alpha[75 * width + 30 + n] = EDGE_ALPHAS[n]!;
  const box = { x: 25, y: 20, w: 70, h: 60 };
  return {
    prepared: { width, height, rgb, alphaSource: null, background: { uniform: true, color: [255, 255, 255], stdev: 0 }, flags: [], sourceMime: "image/jpeg" },
    matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null }, box,
    plan: { w: width, h: height, lowResolution: false, safeBox: { x: 10, y: 10, w: 100, h: 100 }, scale: 1, placedX: box.x, placedY: box.y, detailShot: false, sourceBox: box, productBox: box },
  };
}

describe("shadow compositing under partially transparent product edges", () => {
  it("does not mistake partially transparent apparel for a native floor shadow", async () => {
    const { prepared, matte, box, plan } = darkContactEdge();
    // Pure white source outside the product, including the area below its contact line.
    for (let i = 0; i < matte.alpha.length; i++) prepared.rgb.fill(matte.alpha[i] ? 32 : 255, i * 3, i * 3 + 3);
    // A dark partial pant edge touches the bbox bottom but carries no background shadow.
    matte.alpha[79 * prepared.width + 40] = 128;
    prepared.rgb.fill(32, (79 * prepared.width + 40) * 3, (79 * prepared.width + 40) * 3 + 3);
    expect(preservedDarkness(prepared, matte, box, "apparel_model")).toBeNull();
    const shadow = await shadowLayer(prepared, matte, box, plan, "apparel_model", "#E0E0E0", matte.alpha);
    expect(shadow.layer).toBeNull();
    expect(shadow.flags).toEqual(["no_shadow_source"]);
  });

  it("preserves connected source darkness across all partial opacities, excluding opaque product", () => {
    const { prepared, matte, box } = darkContactEdge();
    const darkness = preservedDarkness(prepared, matte, box, "footwear");
    expect(darkness).not.toBeNull();
    for (let n = 0; n < EDGE_ALPHAS.length; n++) expect(darkness![75 * prepared.width + 30 + n], `Measured contact at alpha ${EDGE_ALPHAS[n]}`).toBe(EDGE_ALPHAS[n] === 255 ? 0 : 153);
  });

  it("keeps projected partial edges shadowed at a non-unit scale while protecting every opaque pixel and margin", async () => {
    const { prepared, matte, box } = darkContactEdge();
    const plan: CanvasPlan = { w: 180, h: 180, lowResolution: false, safeBox: { x: 10, y: 10, w: 160, h: 160 }, scale: 1.5, placedX: 38, placedY: 30, detailShot: false, sourceBox: box, productBox: { x: 38, y: 30, w: 105, h: 90 } };
    const foregroundMask = await sharp(matte.alpha, { raw: { width: prepared.width, height: prepared.height, channels: 1 } }).resize(plan.w, plan.h).toColourspace("b-w").raw().toBuffer();
    const shadow = await shadowLayer(prepared, matte, box, plan, "footwear", "#E0E0E0", foregroundMask);
    expect(shadow.flags).toEqual([]);
    const grey = await sharp(shadow.layer!).toColourspace("b-w").raw().toBuffer();
    // This maps into the alpha21 contact edge; resampling changes opacity but it stays partial.
    const edge = 113 * plan.w + 54;
    expect(foregroundMask[edge]).toBeGreaterThan(10);
    expect(foregroundMask[edge]).toBeLessThan(255);
    expect(grey[edge], "Resampling must not reopen an unshadowed gray gap").toBeLessThan(200);
    for (let y = 0; y < plan.h; y++) for (let x = 0; x < plan.w; x++) {
      const i = y * plan.w + x;
      if (foregroundMask[i] === 255 || x < 10 || x >= 170 || y < 10 || y >= 170) expect(grey[i]).toBe(255);
    }
  });

  it("uses the original foreground RGB over the shadowed background without a bright threshold seam", async () => {
    const { prepared, matte, box, plan } = darkContactEdge();
    const originalRgb = Buffer.from(prepared.rgb), originalAlpha = Buffer.from(matte.alpha);
    const shadow = await shadowLayer(prepared, matte, box, plan, "footwear", "#E0E0E0", matte.alpha);
    expect(shadow.flags).toEqual([]);
    expect(shadow.layer).not.toBeNull();
    const grey = await sharp(shadow.layer!).toColourspace("b-w").raw().toBuffer();
    for (let n = 0; n < EDGE_ALPHAS.length; n++) expect(grey[75 * plan.w + 30 + n], `Background shadow at alpha ${EDGE_ALPHAS[n]}`).toBe(EDGE_ALPHAS[n] === 255 ? 255 : 102);

    const rgba = Buffer.alloc(plan.w * plan.h * 4);
    for (let i = 0; i < matte.alpha.length; i++) { prepared.rgb.copy(rgba, i * 4, i * 3, i * 3 + 3); rgba[i * 4 + 3] = matte.alpha[i]!; }
    const product = await sharp(rgba, { raw: { width: plan.w, height: plan.h, channels: 4 } }).png().toBuffer();
    const composite = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: "#E0E0E0" } }).composite([{ input: shadow.layer!, blend: "multiply" }, { input: product, blend: "over" }]).removeAlpha().raw().toBuffer();
    let previous = 91;
    for (let n = 0; n < EDGE_ALPHAS.length; n++) {
      const a = EDGE_ALPHAS[n]! / 255, i = 75 * plan.w + 30 + n;
      // Product RGB is untouched. Alpha naturally determines how much background shows through.
      const expected = 32 * a + (224 * 102 / 255) * (1 - a), actual = composite[i * 3]!;
      expect(Math.abs(actual - expected), `Correct over-composite at alpha ${EDGE_ALPHAS[n]}`).toBeLessThanOrEqual(1);
      expect(actual, `No bright seam at alpha ${EDGE_ALPHAS[n]}`).toBeLessThanOrEqual(previous);
      previous = actual;
    }
    for (let i = 0; i < matte.alpha.length; i++) {
      if (matte.alpha[i] === 255) { expect(grey[i]).toBe(255); for (let c = 0; c < 3; c++) expect(composite[i * 3 + c]).toBe(originalRgb[i * 3 + c]); }
      const x = i % plan.w, y = Math.floor(i / plan.w);
      if (x < 10 || x >= 110 || y < 10 || y >= 110) expect(grey[i]).toBe(255);
    }
    expect(prepared.rgb).toEqual(originalRgb);
    expect(matte.alpha).toEqual(originalAlpha);
  });
});
