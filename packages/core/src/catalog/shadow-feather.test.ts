import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNEL_RULES_VERSION } from "./channels";
import { preservedDarkness, shadowLayer } from "./shadow";
import { renderKeyInputs } from "./render";
import type { BBox, CanvasPlan, Matte, Prepared } from "./render";

/** A stepped black sole with a real cast shadow and negligible antialiased mask tails. */
function featheredSole(): { prepared: Prepared; matte: Matte; box: BBox; plan: CanvasPlan } {
  const width = 120, height = 120;
  const rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  const paint = (x: number, y: number, value: number) => rgb.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
  for (let y = 75; y < 91; y++) for (let x = 20; x < 100; x++) paint(x, y, 90);
  for (let y = 20; y < 75; y++) for (let x = 25; x < 95; x++) { paint(x, y, 20); alpha[y * width + x] = 255; }
  // The right sole sits lower, keeping the antialiased left contact edge inside the bbox.
  for (let y = 75; y < 80; y++) for (let x = 60; x < 95; x++) { paint(x, y, 20); alpha[y * width + x] = 255; }
  for (let x = 30; x < 46; x++) { alpha[75 * width + x] = 8; alpha[76 * width + x] = 2; }
  // Above the established silhouette threshold, both source and destination must stay protected.
  alpha[75 * width + 50] = 11;
  alpha[76 * width + 50] = 128;
  const box = { x: 25, y: 20, w: 70, h: 60 };
  return {
    prepared: { width, height, rgb, alphaSource: null, background: { uniform: true, color: [255, 255, 255], stdev: 0 }, flags: [], sourceMime: "image/jpeg" },
    matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null },
    box,
    plan: { w: width, h: height, lowResolution: false, safeBox: { x: 10, y: 10, w: 100, h: 100 }, scale: 1, placedX: box.x, placedY: box.y, detailShot: false, sourceBox: box, productBox: box },
  };
}

describe("preserved shadow at a feathered product edge", () => {
  it("invalidates cached renders when the silhouette-shadow rules change", () => {
    const identity = { sourceSha256: "same-source", channel: "noon" as const, policyId: "same-policy", policyUpdatedAt: "2026-10-18T00:00:00Z", n: 2 };
    const before = renderKeyInputs({ ...identity, rulesVersion: "1" });
    const current = renderKeyInputs({ ...identity, rulesVersion: CHANNEL_RULES_VERSION });
    expect(current).toBe(`same-source|noon|${CHANNEL_RULES_VERSION}|same-policy+2026-10-18T00:00:00Z|2`);
    expect(current).not.toBe(before);
  });

  it("keeps native shadow connected through negligible alpha tails without measuring product pixels", () => {
    const { prepared, matte, box } = featheredSole();
    const darkness = preservedDarkness(prepared, matte, box, "footwear");
    expect(darkness, "The real contact shadow must be preserved, not replaced by synthesis").not.toBeNull();
    for (const y of [75, 76, 77]) expect(darkness![y * prepared.width + 35], `Native shadow must continue through contact row ${y}`).toBe(153);
    for (let i = 0; i < matte.alpha.length; i++) if (matte.alpha[i]! > 10) expect(darkness![i], `Measured product pixel ${i} must not become shadow`).toBe(0);
  });

  it("keeps the projected contact edge dark, opaque product pixels unchanged, and margins clean", async () => {
    const { prepared, matte, box, plan } = featheredSole();
    const shadow = await shadowLayer(prepared, matte, box, plan, "footwear", "#E0E0E0", matte.alpha);
    expect(shadow.flags).toEqual([]);
    expect(shadow.layer).not.toBeNull();
    const grey = await sharp(shadow.layer!).toColourspace("b-w").raw().toBuffer();
    expect(grey.length).toBe(plan.w * plan.h);
    for (const y of [75, 76, 77]) expect(grey[y * plan.w + 35], `Projected contact row ${y} must retain the native shadow`).toBe(102);
    for (let i = 0; i < matte.alpha.length; i++) if (matte.alpha[i]! > 10) expect(grey[i], `Product pixel ${i} must have a neutral shadow layer`).toBe(255);
    for (let y = 0; y < plan.h; y++) for (let x = 0; x < plan.w; x++) if (x < 10 || x >= 110 || y < 10 || y >= 110) expect(grey[y * plan.w + x]).toBe(255);

    const rgba = Buffer.alloc(plan.w * plan.h * 4);
    for (let i = 0; i < matte.alpha.length; i++) { prepared.rgb.copy(rgba, i * 4, i * 3, i * 3 + 3); rgba[i * 4 + 3] = matte.alpha[i]!; }
    const product = await sharp(rgba, { raw: { width: plan.w, height: plan.h, channels: 4 } }).png().toBuffer();
    const composite = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: "#E0E0E0" } }).composite([{ input: shadow.layer!, blend: "multiply" }, { input: product, blend: "over" }]).removeAlpha().raw().toBuffer();
    for (const y of [75, 76, 77]) {
      const value = composite[(y * plan.w + 35) * 3]!;
      expect(value, `Row ${y} must not contain the gray slit`).toBeGreaterThanOrEqual(88);
      expect(value, `Row ${y} must stay connected to the native shadow`).toBeLessThanOrEqual(91);
    }
    for (let i = 0; i < matte.alpha.length; i++) if (matte.alpha[i] === 255) for (let c = 0; c < 3; c++) expect(composite[i * 3 + c]).toBe(prepared.rgb[i * 3 + c]);
  });
});
