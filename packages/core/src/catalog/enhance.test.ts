import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { enlargeCutout, enlargementOf, innerAlpha, sharpenAfterEnlarge, sharpenParams, sharpenWeight, SHARPEN, SHARPEN_ALPHA_FLOOR, SHARPEN_ALPHA_FULL, SHARPEN_EDGE_PX } from "./enhance";

type Box = { x: number; y: number; w: number; h: number };

/** A photo with a hard vertical edge (dark left, light right), a textured square and a matte with a soft edge. */
function photo(width: number, height: number) {
  const rgb = Buffer.alloc(width * height * 3), rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, texture = x > width * 0.6 && y < height / 2 ? ((x * 7 + y * 13) % 5) * 12 : 0;
    const value = (x < width / 2 ? 40 : 200) - texture;
    rgb[i * 3] = value; rgb[i * 3 + 1] = value; rgb[i * 3 + 2] = Math.max(0, value - 20);
    const alpha = Math.max(0, Math.min(255, Math.round((Math.min(x, y, width - 1 - x, height - 1 - y) - 2) * 64)));
    rgb.copy(rgba, i * 4, i * 3, i * 3 + 3); rgba[i * 4 + 3] = alpha;
  }
  return { rgb, rgba, width, height };
}
const plainLanczos = (rgba: Buffer, width: number, height: number, crop: Box, to: { w: number; h: number }) =>
  sharp(rgba, { raw: { width, height, channels: 4 } }).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).resize(to.w, to.h, { kernel: "lanczos3" });
const raw = (png: Buffer) => sharp(png).raw().toBuffer();
const channel = (pixels: Buffer, c: number) => Buffer.from(pixels.filter((_, i) => i % 4 === c));

describe("sharpening after enlargement", () => {
  it("chooses no sharpening at scale <= 1 and a conservative, capped amount above it", () => {
    expect(sharpenParams(1)).toBeNull(); expect(sharpenParams(0.5)).toBeNull();
    const at = sharpenParams(1.5)!;
    expect(at.sigma).toBeCloseTo(0.9); expect(at.m2).toBeCloseTo(0.6); expect(at).toMatchObject({ m1: 0, x1: SHARPEN.x1, y2: SHARPEN.y2, y3: SHARPEN.y3 });
    expect(sharpenParams(1.1)!.m2).toBeLessThan(at.m2);
    expect(sharpenParams(12)).toMatchObject({ sigma: 1, m2: SHARPEN.amountMax });
    expect(enlargementOf({ w: 800, h: 1200 }, { w: 1200, h: 1800 })).toBe(1.5);
    expect(enlargementOf({ w: 800, h: 1200 }, { w: 799, h: 1201 })).toBeGreaterThan(1);
  });

  it("returns the very same RGB buffer at scale <= 1", async () => {
    const rgb = Buffer.alloc(12 * 3, 90);
    expect(await sharpenAfterEnlarge(rgb, { w: 4, h: 3 }, 1)).toBe(rgb);
  });

  it.each([[{ w: 80, h: 60 }], [{ w: 40, h: 30 }]])("is byte-identical to plain Lanczos when the product is not enlarged (%o)", async to => {
    const { rgb, rgba, width, height } = photo(80, 60), crop = { x: 0, y: 0, w: 80, h: 60 };
    const ours = await enlargeCutout({ rgba, rgb, width, height, crop, to });
    expect(ours.equals(await plainLanczos(rgba, width, height, crop, to).png().toBuffer())).toBe(true);
  });

  it("sharpens the colour of an enlarged product and keeps its alpha exactly", async () => {
    const { rgb, rgba, width, height } = photo(80, 60), crop = { x: 0, y: 0, w: 80, h: 60 }, to = { w: 120, h: 90 };
    const ours = await raw(await enlargeCutout({ rgba, rgb, width, height, crop, to }));
    const plain = await plainLanczos(rgba, width, height, crop, to).raw().toBuffer();
    expect(channel(ours, 3).equals(channel(plain, 3))).toBe(true);
    expect([0, 1, 2].some(c => !channel(ours, c).equals(channel(plain, c)))).toBe(true);
    // The partly transparent silhouette edge keeps its plain Lanczos colour (no rim on the new background).
    for (let i = 0; i < to.w * to.h; i++) if (plain[i * 4 + 3]! <= SHARPEN_ALPHA_FLOOR) for (let c = 0; c < 3; c++) expect(ours[i * 4 + c]).toBe(plain[i * 4 + c]);
  });

  it("weights the sharpening by alpha: all of it from 250, none at or below the floor, a ramp between", () => {
    expect(sharpenWeight(255)).toBe(1); expect(sharpenWeight(SHARPEN_ALPHA_FULL)).toBe(1);
    expect(sharpenWeight(SHARPEN_ALPHA_FLOOR)).toBe(0); expect(sharpenWeight(0)).toBe(0);
    const mid = sharpenWeight((SHARPEN_ALPHA_FLOOR + SHARPEN_ALPHA_FULL) / 2);
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1);
    // The weight is read on the lowest alpha within 2 px, so the product next to the outline is left alone.
    const rgba = Buffer.alloc(7 * 1 * 4, 255); rgba[3 * 4 + 3] = 0;
    expect([...innerAlpha(rgba, { w: 7, h: 1 }, SHARPEN_EDGE_PX)]).toEqual([255, 0, 0, 0, 0, 0, 255]);
  });

  it("sharpens a model-matted cut-out (interior alpha 240 to 254, soft edge): alpha byte for byte, no rim on the edge", async () => {
    // A real-like model matte: never 255 inside (a sigmoid output peaks at 240 to 254), a 3 px soft edge to 0.
    const width = 80, height = 120, rgb = Buffer.alloc(width * height * 3), rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, v = ((x >> 2) + (y >> 2)) % 2 ? 60 : 190, d = Math.min(x, y, width - 1 - x, height - 1 - y) - 6;
      const interior = 240 + ((x * 7 + y * 3) % 15), alpha = d < 0 ? 0 : d < 3 ? Math.round(interior * (d + 1) / 4) : interior;
      rgb.fill(v, i * 3, i * 3 + 3); rgba.fill(v, i * 4, i * 4 + 3); rgba[i * 4 + 3] = alpha;
    }
    const crop = { x: 0, y: 0, w: width, h: height }, to = { w: 120, h: 180 };
    const ours = await raw(await enlargeCutout({ rgba, rgb, width, height, crop, to }));
    const plain = await plainLanczos(rgba, width, height, crop, to).raw().toBuffer();
    expect(channel(ours, 3).equals(channel(plain, 3))).toBe(true);
    // Lanczos alone leaves almost no pixel at exactly 255 here, which is why "fully opaque only" never sharpened.
    let at255 = 0, inside = 0;
    for (let i = 0; i < to.w * to.h; i++) { if (plain[i * 4 + 3] === 255) at255++; if (plain[i * 4 + 3]! >= SHARPEN_ALPHA_FULL) inside++; }
    expect(at255).toBeLessThan(inside / 4);
    // A measurable gradient increase inside the product (green channel, horizontal neighbours both inside).
    const gradient = (b: Buffer) => { let sum = 0, n = 0; for (let y = 0; y < to.h; y++) for (let x = 1; x < to.w; x++) { const i = y * to.w + x; if (plain[i * 4 + 3]! >= SHARPEN_ALPHA_FULL && plain[(i - 1) * 4 + 3]! >= SHARPEN_ALPHA_FULL) { sum += Math.abs(b[i * 4 + 1]! - b[(i - 1) * 4 + 1]!); n++; } } return sum / n; };
    expect(gradient(ours)).toBeGreaterThan(gradient(plain) * 1.03);
    // No new rim: every edge pixel (alpha at or below the floor) and the 2 px of product next to it keep their plain
    // Lanczos colour exactly, and the
    // ramp pixels move by at most their share of the capped overshoot (y3 6 L*, a few levels per channel).
    let edge = 0;
    const inner = innerAlpha(plain, to, SHARPEN_EDGE_PX);
    for (let i = 0; i < to.w * to.h; i++) {
      const a = plain[i * 4 + 3]!;
      if (inner[i]! <= SHARPEN_ALPHA_FLOOR) for (let c = 0; c < 3; c++) expect(ours[i * 4 + c]).toBe(plain[i * 4 + c]);
      if (a > 0 && a <= SHARPEN_ALPHA_FLOOR) { edge++; for (let c = 0; c < 3; c++) expect(ours[i * 4 + c]).toBe(plain[i * 4 + c]); }
      else if (a < SHARPEN_ALPHA_FULL) for (let c = 0; c < 3; c++) expect(Math.abs(ours[i * 4 + c]! - plain[i * 4 + c]!)).toBeLessThanOrEqual(Math.ceil(16 * sharpenWeight(a)));
    }
    expect(edge).toBeGreaterThan(0);
  });

  it("keeps the change against plain Lanczos within 2 px of a hard edge, with bounded overshoot and no clipping", async () => {
    const width = 60, height = 40, rgb = Buffer.alloc(width * height * 3), rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) { const v = i % width < 30 ? 40 : 200; rgb.fill(v, i * 3, i * 3 + 3); rgba.fill(v, i * 4, i * 4 + 3); }
    const crop = { x: 0, y: 0, w: width, h: height };
    for (const to of [{ w: 90, h: 60 }, { w: 180, h: 120 }]) {
      const ours = await raw(await enlargeCutout({ rgba, rgb, width, height, crop, to }));
      const plain = await plainLanczos(rgba, width, height, crop, to).raw().toBuffer();
      const row = Math.floor(to.h / 2), at = (b: Buffer, x: number) => b[(row * to.w + x) * 4 + 1]!;
      // The plain transition zone: columns where plain Lanczos already moved away from the two flat values.
      const zone = Array.from({ length: to.w }, (_, x) => x).filter(x => Math.abs(at(plain, x) - 40) > 1 && Math.abs(at(plain, x) - 200) > 1 || (x > 0 && Math.abs(at(plain, x) - at(plain, x - 1)) > 1));
      const lo = Math.min(...zone), hi = Math.max(...zone);
      for (let x = 0; x < to.w; x++) {
        const diff = Math.abs(at(ours, x) - at(plain, x));
        if (x < lo - 2 || x > hi + 2) expect(diff).toBe(0);
        expect(at(ours, x)).toBeGreaterThanOrEqual(40 - 20); expect(at(ours, x)).toBeLessThanOrEqual(200 + 20);
      }
      expect([...ours].some((v, i) => i % 4 !== 3 && (v === 0 || v === 255))).toBe(false);
    }
  });

  it("leaves flat areas untouched", async () => {
    const width = 20, height = 20, rgb = Buffer.alloc(width * height * 3, 128), rgba = Buffer.alloc(width * height * 4, 128);
    for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = 255;
    const crop = { x: 0, y: 0, w: width, h: height }, to = { w: 40, h: 40 };
    const ours = await raw(await enlargeCutout({ rgba, rgb, width, height, crop, to }));
    expect(ours.equals(await plainLanczos(rgba, width, height, crop, to).raw().toBuffer())).toBe(true);
  });
});

describe("truthful low_resolution copy (spec 11 4.1)", () => {
  it("names the delivered size on a fixed canvas and the minimum on an adaptive one, in qa/reasons.ts and types.ts", async () => {
    const { flagDetails } = await import("./qa/reasons");
    const { flagReason } = await import("./types");
    const fixed = "The original is 800 x 1200. Trendyol images are delivered at 1200 x 1800, so this one was enlarged and may look soft.";
    expect(flagDetails("low_resolution", { channel: "Trendyol", w: 800, h: 1200, min: 800, deliverW: 1200, deliverH: 1800 }).why).toBe(fixed);
    expect(flagReason("low_resolution", { channel: "Trendyol", w: 800, h: 1200, min: 800, deliverW: 1200, deliverH: 1800 })).toContain(fixed);
    const adaptive = "The original is 300 x 300. Noon wants at least 1480 px, so this one may look soft.";
    expect(flagDetails("low_resolution", { channel: "Noon", w: 300, h: 300, min: 1480 }).why).toBe(adaptive);
    expect(flagReason("low_resolution", { channel: "Noon", w: 300, h: 300, min: 1480 })).toContain(adaptive);
    for (const text of [flagDetails("low_resolution", { channel: "Trendyol", w: 800, h: 1200, min: 800, deliverW: 1200, deliverH: 1800 }).why]) expect(text).not.toMatch(/at least 1800/);
  });
});
