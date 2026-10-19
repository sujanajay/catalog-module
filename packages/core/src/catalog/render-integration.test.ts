import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "./channels";
import { bbox, planCanvas, prepare, renderSource, type Matte, type Prepared } from "./render";
import { analyseBackground, preservedDarkness, shadowLayer, SHADOW_SYNTH_INTENSITY_GREY, SHADOW_SYNTH_INTENSITY_WHITE } from "./shadow";
import { shadowSynthesisAllowed } from "./qa/policy";
import type { OutputFlag, ProductType } from "./types";

function source(): { prepared: Prepared; matte: Matte } {
  const width = 120, height = 160, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  for (let y = 30; y < 130; y++) for (let x = 40; x < 80; x++) {
    const i = y * width + x;
    rgb.set([40, 70, 100], i * 3);
    alpha[i] = 255;
  }
  return { prepared: { rgb, width, height, sourceMime: "image/png", alphaSource: null, background: analyseBackground(rgb, width, height), flags: [] }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}

describe("renderer integration edge cases", () => {
  it("prepares only the first of two distinct GIF frames", async () => {
    const width = 32, height = 24, pixels = Buffer.alloc(width * height * 2 * 3);
    for (let i = 0; i < width * height; i++) { pixels.set([255, 0, 0], i * 3); pixels.set([0, 0, 255], (width * height + i) * 3); }
    const gif = await sharp(pixels, { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif({ delay: [100, 100] }).toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const prepared = await prepare(gif, "two-frames.gif", async (b) => b);
    expect([prepared.width, prepared.height]).toEqual([width, height]);
    expect([...prepared.rgb.subarray(0, 3)]).toEqual([255, 0, 0]);
  });

  it("drops a faint source shadow, synthesises footwear and leaves apparel unshadowed", async () => {
    const { prepared, matte } = source(), box = bbox(matte.alpha, prepared.width, prepared.height)!;
    for (let y = 130; y < 140; y++) for (let x = 40; x < 80; x++) prepared.rgb.fill(250, (y * prepared.width + x) * 3, (y * prepared.width + x) * 3 + 3);
    expect(preservedDarkness(prepared, matte, box, "footwear")).toBeNull();
    const plan = planCanvas(CHANNELS.noon, box, { w: prepared.width, h: prepared.height }, {});
    const footwear = await shadowLayer(prepared, matte, box, plan, "footwear", "#E0E0E0");
    expect(footwear.flags).toEqual(["shadow_synthesised"]);
    expect(footwear.layer).not.toBeNull();
    expect(await shadowLayer(prepared, matte, box, plan, "apparel_model", "#E0E0E0")).toEqual({ layer: null, flags: ["no_shadow_source"] });
  });

  it("uses distinct white and grey synthesis intensities and keeps required borders clean", async () => {
    const { prepared, matte } = source(), box = bbox(matte.alpha, prepared.width, prepared.height)!;
    const plan = planCanvas(CHANNELS.noon, box, { w: prepared.width, h: prepared.height }, {});
    const peaks: number[] = [];
    for (const background of ["#E0E0E0", "#FFFFFF"]) {
      const { layer } = await shadowLayer(prepared, matte, box, plan, "footwear", background);
      const pixels = await sharp(layer!).toColourspace("b-w").raw().toBuffer();
      peaks.push((255 - pixels.reduce((min, value) => Math.min(min, value), 255)) / 255);
      for (let x = 0; x < plan.w; x++) { expect(pixels[x]).toBe(255); expect(pixels[(plan.h - 1) * plan.w + x]).toBe(255); }
    }
    expect(peaks[0]).toBeGreaterThan(peaks[1]!);
    expect(peaks[0]).toBeLessThanOrEqual(SHADOW_SYNTH_INTENSITY_GREY + 1 / 255);
    expect(peaks[1]).toBeLessThanOrEqual(SHADOW_SYNTH_INTENSITY_WHITE + 1 / 255);
    expect(peaks[0]! / peaks[1]!).toBeCloseTo(SHADOW_SYNTH_INTENSITY_GREY / SHADOW_SYNTH_INTENSITY_WHITE, 1);
  });

  it("synthesises for a tall other product on nonuniform background", async () => {
    const { prepared, matte } = source();
    prepared.background = { uniform: false, color: [255, 255, 255], stdev: 30 };
    const box = bbox(matte.alpha, prepared.width, prepared.height)!;
    expect(preservedDarkness(prepared, matte, box, "other")).toBeNull();
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 1, productType: "other" });
    expect(output.flags).toContain("shadow_synthesised");
    expect(output.compliance).toEqual({ ok: true, failures: [] });
  });

  it("keeps an asymmetric soft mask whole and inside its safe box", async () => {
    const { prepared, matte } = source();
    for (let y = 30; y < 130; y++) for (let x = 40; x < 80; x++) {
      const i = y * prepared.width + x;
      if (x > 50 && y < 80) { matte.alpha[i] = 0; prepared.rgb.fill(255, i * 3, i * 3 + 3); }
      else if (x === 40 || y === 129) matte.alpha[i] = 80;
    }
    const original = Buffer.from(matte.alpha), output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 1, productType: "apparel_model" });
    expect(output.status).toBe("ok");
    expect(output.compliance).toEqual({ ok: true, failures: [] });
    expect(matte.alpha).toEqual(original);
    expect(output.plan.sourceBox).toEqual({ x: 40, y: 30, w: 40, h: 100 });
    expect(output.plan.productBox!.y).toBeGreaterThanOrEqual(output.plan.safeBox.y);
    expect(output.plan.productBox!.y + output.plan.productBox!.h).toBeLessThanOrEqual(output.plan.safeBox.y + output.plan.safeBox.h);
  });

  // The tall product on plain white with no cast shadow is the French Connection case: every
  // synthesising type would add a contact shadow, so only the decision input keeps it off.
  it.each<[string, ProductType | null, OutputFlag[], boolean]>([
    ["an apparel_model classification", "apparel_model", [], false],
    ["a footwear classification", "footwear", [], true],
    ["a missing classification", null, [], false],
    ["the auto placeholder", "auto", [], false],
    ["a failed or mocked classification", "other", ["type_unknown"], false],
  ])("renders %s with the shadow the classification allows", async (_label, productType, flags, synthesised) => {
    const { prepared, matte } = source(), synthesiseShadow = shadowSynthesisAllowed(productType, flags);
    expect(synthesiseShadow).toBe(synthesised);
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 1, productType: productType ?? "other", synthesiseShadow });
    expect(output.flags.includes("shadow_synthesised")).toBe(synthesised);
    if (!synthesised) expect(output.flags).toContain("no_shadow_source");
    expect(output.compliance).toEqual({ ok: true, failures: [] });
  });

  it("keeps the product-type rule when no decision input is given", async () => {
    const { prepared, matte } = source();
    expect((await renderSource({ prepared, matte, channel: "noon", shotNumber: 1, productType: "footwear" })).flags).toContain("shadow_synthesised");
  });
});
