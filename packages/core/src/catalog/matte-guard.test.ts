import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { backgroundRegion, checkMatteIntegrity, detectTextImage, heldInHand, passthroughMatte, resolveMatte, type MatteVariant } from "./matte-guard";
import { components } from "./evals/image";
import { renderSource, type Matte, type Prepared } from "./render";
import { analyseBackground } from "./shadow";
import { shadowSynthesisAllowed } from "./qa/policy";

type RGB = [number, number, number];
const W = 400, H = 600;
/** Deterministic pseudo-random grain (leather, knit): neighbouring pixels differ by up to +-24. */
const grain = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 49 - 24;
const clamp = (v: number) => Math.max(0, Math.min(255, v));

function image(paint: (x: number, y: number) => RGB): Pick<Prepared, "width" | "height" | "rgb"> {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.set(paint(x, y), (y * W + x) * 3);
  return { width: W, height: H, rgb };
}
function prepared(img: Pick<Prepared, "width" | "height" | "rgb">): Prepared {
  return { ...img, alphaSource: null, background: analyseBackground(img.rgb, img.width, img.height), flags: [], sourceMime: "image/png" };
}
const matteOf = (keep: (x: number, y: number) => boolean, model = "first"): Matte => {
  const alpha = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (keep(x, y)) alpha[y * W + x] = 255;
  return { alpha, width: W, height: H, model, ms: 1, source: "model", target: "cpu", sentLongSide: 1024 };
};
const inRect = (x: number, y: number, x0: number, y0: number, w: number, h: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

/** Orange leather filling the frame with a gold logo in the middle (French Connection close-up). */
const leather = (x: number, y: number): RGB => inRect(x, y, 150, 250, 100, 100) ? [214, 180, 90] : [clamp(225 + grain(x, y)), clamp(110 + grain(x, y)), clamp(40 + grain(x, y))];
/** The same close-up pasted on a white canvas with a white strip at the top (the brand's layout). */
const leatherWithStrip = (x: number, y: number): RGB => y < 40 ? [255, 255, 255] : leather(x, y);
/** A logo-only matte: what a salient-object model returns for a frame-filling close-up. */
const logoOnly = (model = "first") => matteOf((x, y) => inRect(x, y, 150, 250, 100, 100), model);

describe("cut-out integrity guard", () => {
  it("rejects a matte that keeps only the logo of a frame-filling close-up", () => {
    const p = image(leather);
    expect(backgroundRegion(p).frameFilling).toBe(true);
    const verdict = checkMatteIntegrity(p, logoOnly());
    expect(verdict.ok).toBe(false);
    expect(verdict.overallLoss).toBeGreaterThan(0.5);
  });

  it("accepts a good matte of a textured object on a plain background, and on a pasted studio photo with a wall", () => {
    const object = (x: number, y: number) => inRect(x, y, 100, 120, 200, 360);
    const plain = image((x, y) => object(x, y) ? [clamp(60 + grain(x, y)), clamp(40 + grain(x, y)), clamp(30 + grain(x, y))] : [255, 255, 255]);
    expect(checkMatteIntegrity(plain, matteOf(object)).ok).toBe(true);
    // White canvas strip on top, then a grey studio wall with a soft gradient: the wall is background, not product.
    const studio = image((x, y) => y < 30 ? [255, 255, 255] : object(x, y) ? [clamp(60 + grain(x, y)), 40, 30] : [Math.round(200 + y / 40), Math.round(196 + y / 40), Math.round(190 + y / 40)]);
    const verdict = checkMatteIntegrity(studio, matteOf(object));
    expect(verdict).toMatchObject({ ok: true, frameFilling: false });
    expect(verdict.overallLoss).toBeLessThan(0.01);
  });

  it("passes a transparent source's own alpha and an untouched first matte without any step", async () => {
    const p = image(leather), attempts: MatteVariant[] = [];
    const resolved = await resolveMatte({ prepared: p, first: { ...logoOnly(), source: "alpha_source" }, handRule: true, attempt: async v => { attempts.push(v); return null; } });
    expect(resolved).toMatchObject({ passthrough: false, actions: [] });
    expect(attempts).toEqual([]);
  });
});

describe("resolution ladder", () => {
  it("climbs second model, padded first, padded second, then passes the whole frame through with no holes", async () => {
    const p = image(leather), attempts: MatteVariant[] = [];
    const resolved = await resolveMatte({ prepared: p, first: logoOnly(), handRule: true, attempt: async v => { attempts.push(v); return logoOnly(v); } });
    expect(attempts).toEqual(["second", "padded_first", "padded_second"]);
    expect(resolved.actions.map(a => `${a.step}:${a.result}`)).toEqual(["matte_check:failed", "second_matte:failed", "padded_matte:failed", "padded_matte:failed", "matte_passthrough:passed"]);
    expect(resolved.actions.every(a => a.trigger.join() === "product_removed")).toBe(true);
    expect(resolved.passthrough).toBe(true);
    // Frame-filling: every pixel is product, so there is nothing to hole or float.
    expect(resolved.matte.alpha.every(v => v === 255)).toBe(true);
    expect(checkMatteIntegrity(p, resolved.matte).ok).toBe(true);
  });

  it("stops at the first matte that keeps the product (a padded frame)", async () => {
    const p = image(leather);
    const resolved = await resolveMatte({ prepared: p, first: logoOnly(), handRule: true, attempt: async v => v === "padded_first" ? matteOf(() => true, "first") : null });
    expect(resolved.passthrough).toBe(false);
    expect(resolved.actions.map(a => `${a.step}:${a.result}`)).toEqual(["matte_check:failed", "second_matte:skipped", "padded_matte:passed"]);
  });

  it("the pass-through keeps the canvas strip as background, the rest solid, in one piece", () => {
    const p = image(leatherWithStrip), matte = passthroughMatte(p);
    for (let x = 0; x < W; x++) { expect(matte.alpha[5 * W + x]).toBe(0); expect(matte.alpha[300 * W + x]).toBe(255); }
    // No holes and no floating fragments: the opaque part is one component, and so is the background.
    const opaque = new Uint8Array(W * H), clear = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { opaque[i] = matte.alpha[i]! > 128 ? 1 : 0; clear[i] = matte.alpha[i]! > 128 ? 0 : 1; }
    expect(components(opaque, W, H).sizes.length - 1).toBe(1);
    expect(components(clear, W, H).sizes.length - 1).toBe(1);
  });

  it("the pass-through of a photo with a stray speck and an enclosed gap has no fragment and no hole", () => {
    const p = image((x, y) => inRect(x, y, 5, 5, 6, 6) ? [20, 20, 20] : inRect(x, y, 100, 100, 200, 400) && !inRect(x, y, 180, 250, 40, 40) ? [clamp(60 + grain(x, y)), 50, 40] : [255, 255, 255]);
    const matte = passthroughMatte(p);
    expect(matte.alpha[8 * W + 8]).toBe(0);
    expect(matte.alpha[270 * W + 200]).toBe(255);
  });
});

describe("close-up of a trim over skin (Penti Z91D419FC9238E844BF77Z_4)", () => {
  // White canvas strips top and bottom; inside, smooth skin on the left, a textured trim, dark green linen on the right.
  // The skin is smooth and reaches the border band, so the source alone takes it for background.
  const trim = (x: number) => x >= 150 && x < 210;
  const closeUp = image((x, y) => y < 30 || y >= H - 30 ? [255, 255, 255] : x < 150 ? [226, 186, 168] : trim(x) ? [clamp(120 + grain(x, y) * 4), clamp(120 + grain(x, y) * 4), clamp(110 + grain(x, y) * 4)] : [clamp(20 + grain(x, y)), clamp(60 + grain(x, y)), clamp(50 + grain(x, y))]);
  const inside = (y: number) => y >= 30 && y < H - 30;
  /** The live defect: the matte keeps the trim, the fabric and the lower skin, and drops the upper skin. */
  const partialSkin = matteOf((x, y) => inside(y) && (x >= 150 || y >= 300));

  it("rejects a matte that cuts through the skin, and keeps a complete one", () => {
    expect(backgroundRegion(closeUp).frameFilling).toBe(false);
    const partial = checkMatteIntegrity(closeUp, partialSkin, { handRule: false });
    expect(partial.ok).toBe(false);
    expect(partial.worstCellLoss).toBeGreaterThan(0.5);
    expect(checkMatteIntegrity(closeUp, matteOf((_x, y) => inside(y)), { handRule: false }).ok).toBe(true);
  });

  it("ends in a pass-through that keeps the skin when every model cuts through it", async () => {
    const resolved = await resolveMatte({ prepared: closeUp, first: partialSkin, handRule: false, attempt: async v => ({ ...partialSkin, model: v }) });
    expect(resolved.passthrough).toBe(true);
    for (const [x, y] of [[40, 100], [40, 400], [300, 100], [180, 300]] as const) expect(resolved.matte.alpha[y * W + x]).toBe(255);
    expect(resolved.matte.alpha[5 * W + 200]).toBe(0);
  });
});

describe("size charts and text-only images", () => {
  /** A white page with a title, a table of rows of small dark glyphs and grid lines (the Penti size chart). */
  const chart = image((x, y) => {
    const row = Math.floor((y - 80) / 24), inTable = row >= 0 && row < 16 && x >= 40 && x < 360;
    if (inTable && ((y - 80) % 24 === 0 || x % 107 === 40)) return [200, 200, 200];
    if (inTable && (y - 80) % 24 >= 8 && (y - 80) % 24 < 16 && (x - 40) % 10 < 6) return [30, 30, 30];
    if (y >= 30 && y < 50 && x >= 150 && x < 250 && x % 14 < 9) return [200, 60, 90];
    return [255, 250, 250];
  });

  it("recognises a size chart", () => {
    expect(detectTextImage(chart)).toMatchObject({ text: true });
  });

  it("does not take a product photo or a dark frame-filling close-up for text", () => {
    const shoe = image((x, y) => inRect(x, y, 60, 220, 280, 160) ? [clamp(90 + grain(x, y)), 90, 100] : [255, 255, 255]);
    expect(detectTextImage(shoe).text).toBe(false);
    // Sequins on navy: many small bright marks in rows, but no light page.
    const sequins = image((x, y) => (x % 20 < 6 && y % 20 < 6) ? [220, 220, 230] : [30, 35, 80]);
    expect(detectTextImage(sequins).text).toBe(false);
  });
});

describe("hand-held products", () => {
  /** An upright orange bag held by a hand that enters from the left frame edge and covers part of the bag. */
  const bag = (x: number, y: number) => inRect(x, y, 80, 150, 260, 300);
  const hand = (x: number, y: number) => inRect(x, y, 0, 260, 130, 50);
  const held = image((x, y) => hand(x, y) ? [235, 190, 170] : bag(x, y) ? [clamp(225 + grain(x, y)), clamp(110 + grain(x, y)), 40] : [255, 255, 255]);

  it("sees the hand the matte dropped and the notch it leaves", () => {
    const cut = matteOf((x, y) => bag(x, y) && !hand(x, y));
    const result = heldInHand(held, cut.alpha);
    expect(result.held).toBe(true);
    expect(result.droppedShare).toBeGreaterThan(0.02);
    // A large notch rejects the cut-out (pass-through preferred); apparel never applies the hand rule.
    expect(checkMatteIntegrity(held, cut).ok).toBe(false);
    expect(heldInHand(image((x, y) => bag(x, y) ? [225, 110, 40] : [255, 255, 255]), matteOf(bag).alpha).held).toBe(false);
  });

  it("never synthesises a contact shadow for a hand-held product", async () => {
    const p = prepared(held), cut = matteOf((x, y) => bag(x, y) && !hand(x, y));
    const free = prepared(image((x, y) => bag(x, y) ? [clamp(225 + grain(x, y)), clamp(110 + grain(x, y)), 40] : [255, 255, 255]));
    const allowed = (q: Prepared, m: Matte) => shadowSynthesisAllowed("bag_accessory", []) && !heldInHand(q, m.alpha).held;
    const standing = await renderSource({ prepared: free, matte: matteOf(bag), channel: "amazon", shotNumber: 2, productType: "bag_accessory", synthesiseShadow: allowed(free, matteOf(bag)) });
    expect(standing.flags).toContain("shadow_synthesised");
    const inHand = await renderSource({ prepared: p, matte: cut, channel: "amazon", shotNumber: 2, productType: "bag_accessory", synthesiseShadow: allowed(p, cut) });
    expect(inHand.flags).not.toContain("shadow_synthesised");
    expect(shadowSynthesisAllowed("bag_accessory", ["matte_passthrough"])).toBe(false);
    expect((await sharp(inHand.jpeg!).metadata()).format).toBe("jpeg");
  });
});
