import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNEL_RULES_VERSION } from "./channels";
import { renderKeys } from "./pipeline/publish";
import { bbox, renderSource, type Matte, type Prepared } from "./render";
import { analyseBackground, floorPatchShare, FLOOR_PATCH_MAX_SHARE, preservedDarkness } from "./shadow";
import type { ProductType } from "./types";

const W = 600, H = 800, WALL = 230;
const BOX = { x: 270, y: 100, w: 60, h: 550 };

/** A person on a studio floor: a light wall, optionally a floor a few levels darker (from `inX` on the frame's columns, the whole width by default), and a real dark shadow under the feet. */
function studio(floorLevels: number, inX: (x: number) => boolean = () => true, contactTone = 170): { prepared: Prepared; matte: Matte } {
  const rgb = Buffer.alloc(W * H * 3, WALL), alpha = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let v = WALL;
    if (y >= 500 && inX(x)) v -= floorLevels;
    const contact = ((x - 300) / 50) ** 2 + ((y - 650) / 35) ** 2;
    if (contact < 1) v = contactTone;
    rgb.fill(v, i * 3, i * 3 + 3);
    if (x >= BOX.x && x < BOX.x + BOX.w && y >= BOX.y && y < BOX.y + BOX.h) { rgb.set([40, 60, 90], i * 3); alpha[i] = 255; }
  }
  return {
    prepared: { rgb, width: W, height: H, sourceMime: "image/png", alphaSource: null, background: analyseBackground(rgb, W, H), flags: [] },
    matte: { alpha, width: W, height: H, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null },
  };
}

/** A garment laid flat, nearly as wide as the frame, on a floor `floorLevels` under the wall, with a real shadow under the middle of its hem. */
function wideGarment(boxW: number, floorLevels: number): { prepared: Prepared; matte: Matte } {
  const rgb = Buffer.alloc(W * H * 3, WALL), alpha = Buffer.alloc(W * H), x0 = (W - boxW) >> 1, bottom = BOX.y + BOX.h;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let v = WALL;
    if (y >= 500) v -= floorLevels;
    if (((x - W / 2) / 100) ** 2 + ((y - bottom) / 30) ** 2 < 1) v = 170;
    rgb.fill(v, i * 3, i * 3 + 3);
    if (x >= x0 && x < x0 + boxW && y >= BOX.y && y < bottom) { rgb.set([40, 60, 90], i * 3); alpha[i] = 255; }
  }
  return {
    prepared: { rgb, width: W, height: H, sourceMime: "image/png", alphaSource: null, background: analyseBackground(rgb, W, H), flags: [] },
    matte: { alpha, width: W, height: H, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null },
  };
}

/** A tall boot on a plain floor with a real shadow so soft and wide that its fade reads as floor tone beside the product. */
function softBoot(sigma: number): { prepared: Prepared; matte: Matte } {
  const size = 800, x0 = 340, x1 = 460, y0 = 140, y1 = 660;
  const rgb = Buffer.alloc(size * size * 3, WALL), alpha = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, d = Math.exp(-0.5 * (((x - 400) / sigma) ** 2 + ((y - y1) / 26) ** 2));
    rgb.fill(Math.round(WALL - 40 * d), i * 3, i * 3 + 3);
    if (x >= x0 && x < x1 && y >= y0 && y < y1) { rgb.set([40, 30, 25], i * 3); alpha[i] = 255; }
  }
  return {
    prepared: { rgb, width: size, height: size, sourceMime: "image/png", alphaSource: null, background: analyseBackground(rgb, size, size), flags: [] },
    matte: { alpha, width: size, height: size, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null },
  };
}

describe("a toned floor is not a contact shadow", () => {
  for (const type of ["apparel_model", "apparel_flat"] as ProductType[]) {
    it(`${type}: keeps the shadow at the feet and none of the floor far from them`, () => {
      const { prepared, matte } = studio(12), box = bbox(matte.alpha, W, H)!;
      expect(prepared.background.uniform).toBe(true);
      const kept = preservedDarkness(prepared, matte, box, type)!;
      expect(kept).not.toBeNull();
      // The real shadow under the feet stays at its own darkness.
      expect(kept[660 * W + 300]).toBeGreaterThan(0.2 * 255);
      // The same floor tone at the frame's corners, connected to the feet, does not.
      for (const [x, y] of [[20, 780], [580, 780], [100, 620], [500, 620]] as const) expect(kept[y * W + x]).toBe(0);
    });
  }

  it("reads a shadow against the floor beside it, so an even floor leaves nothing around the feet", () => {
    const { prepared, matte } = studio(12), kept = preservedDarkness(prepared, matte, bbox(matte.alpha, W, H)!, "apparel_model")!;
    expect(kept[690 * W + 334]).toBe(0);
    expect(kept[640 * W + 250]).toBe(0);
    // The real shadow is measured above the floor's own tone: its 60 levels under the wall are 48 above the floor.
    expect(kept[660 * W + 300]! / 255).toBeCloseTo(48 / WALL, 1);
  });

  it("keeps a faint shadow on a toned floor, read above the floor, and still drops the same faint shadow on a plain floor", () => {
    const toned = studio(12, undefined, WALL - 12 - 8), plain = studio(0, undefined, WALL - 8);
    expect(preservedDarkness(toned.prepared, toned.matte, bbox(toned.matte.alpha, W, H)!, "apparel_model")).not.toBeNull();
    expect(preservedDarkness(plain.prepared, plain.matte, bbox(plain.matte.alpha, W, H)!, "apparel_model")).toBeNull();
  });

  it("reads the floor on a side the other side's tone differs from", () => {
    // The floor is toned only on the right of the frame: the left side keeps its own zero, the right subtracts.
    const { prepared, matte } = studio(12, x => x >= 300), kept = preservedDarkness(prepared, matte, bbox(matte.alpha, W, H)!, "apparel_model")!;
    expect(kept[660 * W + 300]! / 255).toBeGreaterThan(0.1);
    expect(kept[700 * W + 420]).toBe(0);
  });

  it("fills a part of the band the flood could not reach, so the shadow has no clean rectangle in it", () => {
    const { prepared, matte } = studio(0), box = bbox(matte.alpha, W, H)!;
    // Clean under the product inside the band, and a dark path that leaves the band below it (the band ends at row 788) and comes back up on the right.
    const paint = (x: number, y: number, v: number) => { if (x < BOX.x || x >= BOX.x + BOX.w || y >= BOX.y + BOX.h) prepared.rgb.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3); };
    for (let y = 500; y < H; y++) for (let x = 0; x < W; x++) paint(x, y, WALL);
    const dark = (x: number, y: number) => (x >= 250 && x < 270 && y >= 640 && y < H) || (y >= 790 && x >= 250 && x < 370) || (x >= 331 && x < 370 && y >= 620 && y < H);
    for (let y = 500; y < H; y++) for (let x = 0; x < W; x++) if (dark(x, y)) paint(x, y, 190);
    for (let x = BOX.x; x < 300; x++) for (let y = 650; y < 652; y++) paint(x, y, 190);
    for (let x = 250; x < 300; x++) for (let y = 650; y < 652; y++) paint(x, y, 190);
    const kept = preservedDarkness(prepared, matte, box, "apparel_model")!;
    // x 331 to 335 is inside the band, beside the product; only the way round leads there.
    expect(kept[640 * W + 333]).toBeGreaterThan(0);
  });

  for (const boxW of [420, 540, 576]) it(`reads the floor at the frame's edges under a garment ${boxW} of ${W} wide, where both samples fall off the frame`, () => {
    const { prepared, matte } = wideGarment(boxW, 12), box = bbox(matte.alpha, W, H)!;
    expect(prepared.background.uniform).toBe(true);
    const kept = preservedDarkness(prepared, matte, box, "apparel_flat")!;
    // Under the hem, off the real shadow: only floor tone, which is no shadow.
    const left = W / 2 - boxW / 2 + 4;
    expect(kept[(BOX.y + BOX.h + 60) * W + left]).toBe(0);
    // The real shadow under the hem stays, read above the floor.
    expect(kept[(BOX.y + BOX.h + 5) * W + W / 2]! / 255).toBeCloseTo(48 / WALL, 1);
  });

  it("keeps a wide garment's real shadow on a plain floor, where the frame's edges read no tone", () => {
    const { prepared, matte } = wideGarment(540, 0), kept = preservedDarkness(prepared, matte, bbox(matte.alpha, W, H)!, "apparel_flat")!;
    expect(kept[(BOX.y + BOX.h + 5) * W + W / 2]! / 255).toBeCloseTo(60 / WALL, 1);
  });

  it("still fades the floor tone past the band instead of stopping on a straight line", () => {
    // A pool of tone that ends before the floor samples beside the band.
    const { prepared, matte } = studio(12, x => x >= 211 && x < 389), kept = preservedDarkness(prepared, matte, bbox(matte.alpha, W, H)!, "apparel_model")!;
    // Beside the right edge of the band (x 336 for this box) the tone falls off over the next pixels.
    const row = 690, inBand = kept[row * W + 334]!, nearEdge = kept[row * W + 345]!, further = kept[row * W + 375]!, past = kept[row * W + 395]!;
    expect(inBand).toBeGreaterThan(nearEdge);
    expect(nearEdge).toBeGreaterThan(further);
    expect(past).toBe(0);
  });
});

describe("floorPatchShare", () => {
  const w = 100, h = 100, product = { x: 40, y: 20, w: 20, h: 60 }, bg = [240, 240, 240] as const;
  const layer = (paint: (x: number, y: number) => number) => { const b = Buffer.alloc(w * h, 255); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = paint(x, y); return b; };
  /** The layer value that takes the 240 canvas down by this many levels. */
  const levels = (n: number) => Math.round(255 - n * 255 / 240);
  const block = (n: number) => layer((x, y) => (x < 10 && y >= 70 && y < 80 ? levels(n) : 255));

  it("counts floor tone in the lower half, beside the product box and its margin", () => {
    expect(floorPatchShare(block(5), w, h, bg, product)).toBeCloseTo(0.01);
  });
  it("leaves out the upper half", () => {
    expect(floorPatchShare(layer((x, y) => (x < 10 && y < 10 ? levels(5) : 255)), w, h, bg, product)).toBe(0);
  });
  it("leaves out the product's columns and their 3% margin, so a real shadow under a hem does not count", () => {
    expect(floorPatchShare(layer((x, y) => (y >= 50 && x >= 37 && x < 63 ? levels(5) : 255)), w, h, bg, product)).toBe(0);
    expect(floorPatchShare(layer((x, y) => (y >= 50 && y < 60 && x === 36 ? levels(5) : 255)), w, h, bg, product)).toBeCloseTo(0.001);
  });
  it("leaves out tone under the low bound and a real shadow over the high bound", () => {
    expect(floorPatchShare(block(1), w, h, bg, product)).toBe(0);
    expect(floorPatchShare(block(40), w, h, bg, product)).toBe(0);
  });
});

describe("the render leaves out a kept shadow that would leave a patch", () => {
  it("drops the shadow on its own, with a clean canvas, no flag for triage and no failed rule", async () => {
    // Tone the band keeps: it ends before the floor samples beside the band, so floorTone cannot read it. Only the check can stop it.
    const { prepared, matte } = studio(15, x => x >= 211 && x < 389);
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "apparel_model" });
    const measured = output.compliance.measured!;
    expect(measured.floorPatch?.dropped).toBe(true);
    expect(measured.floorPatch!.share).toBeGreaterThanOrEqual(FLOOR_PATCH_MAX_SHARE);
    expect(measured.shadow).toBe("none");
    expect(output.flags).toEqual(["no_shadow_source"]);
    expect(output.status).toBe("ok");
    const { data, info } = await sharp(output.jpeg!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Beside the feet, where the patch would be: the canvas colour, within JPEG noise.
    const product = output.plan.productBox!, y = product.y + product.h + 5, x = Math.max(0, product.x - 60);
    expect(data[(y * info.width + x) * 3]).toBeGreaterThanOrEqual(239);
  });

  it("keeps a real contact shadow where the floor is plain", async () => {
    const { prepared, matte } = studio(0);
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "apparel_model" });
    const measured = output.compliance.measured!;
    expect(measured.shadow).toBe("kept");
    expect(measured.floorPatch).toMatchObject({ dropped: false });
    expect(measured.floorPatch!.share).toBeLessThan(FLOOR_PATCH_MAX_SHARE);
    expect(output.flags).not.toContain("no_shadow_source");
    const { data, info } = await sharp(output.jpeg!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const product = output.plan.productBox!, under = product.y + product.h - 30, x = product.x - 4;
    expect(data[(under * info.width + x) * 3]).toBeLessThan(225);
  });

  for (const productType of ["footwear", "bag_accessory"] as ProductType[]) it(`${productType}: a dropped shadow goes to the synthesis rule, so a boot with a soft real shadow is not left without one`, async () => {
    const { prepared, matte } = softBoot(200);
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType });
    const measured = output.compliance.measured!;
    expect(measured.floorPatch?.dropped).toBe(true);
    expect(measured.shadow).toBe("synthesised");
    expect(output.flags).toContain("shadow_synthesised");
    expect(output.flags).not.toContain("no_shadow_source");
  });

  it("a dropped shadow on a shoe stays off when synthesis is off for this render", async () => {
    const { prepared, matte } = softBoot(200);
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "footwear", synthesiseShadow: false });
    expect(output.compliance.measured!.floorPatch?.dropped).toBe(true);
    expect(output.compliance.measured!.shadow).toBe("none");
    expect(output.flags).toContain("no_shadow_source");
  });

  it("does not measure when the source shadow is already off", async () => {
    const { prepared, matte } = studio(12);
    const output = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "apparel_model", keepSourceShadow: false });
    expect(output.compliance.measured!.floorPatch).toBeUndefined();
    expect(output.compliance.measured!.shadow).toBe("none");
  });
});

describe("existing outputs are made again", () => {
  it("a live image under the previous rules version no longer counts as unchanged", () => {
    expect(CHANNEL_RULES_VERSION).toBe("11");
    const input = { sourceSha256: "a".repeat(64), channel: "noon" as const, n: 1, policyKey: "default|m" };
    const live = renderKeys({ ...input, rulesVersion: "10+c2" }, null), now = renderKeys({ ...input, rulesVersion: `${CHANNEL_RULES_VERSION}+c2` }, null);
    expect(now.some(key => live.includes(key))).toBe(false);
  });
});
