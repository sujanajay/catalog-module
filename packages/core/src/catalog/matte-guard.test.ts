import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { backgroundRegion, BUSY_BORDER_MAX_SHARE, BUSY_EDGE_DENSITY_MIN, BUSY_PLAIN_EDGE_MAX, BUSY_PLAIN_TONES_MIN, busyBorderReading, busyBorderShare, checkMatteIntegrity, detectTextImage, GUARD_OPAQUE_MIN_SHARE, heldInHand, keptBackground, PASSTHROUGH_PRODUCT_LOSS_MAX, passthroughGuide, passthroughMatte, passthroughProductLoss, readsAsScenery, recoverSoleStrip, resolveMatte, wholePhotoMatte, type MatteVariant } from "./matte-guard";
import { hasCutBandNote } from "./channels";
import { components } from "./evals/image";
import { PASSTHROUGH_MODEL, renderSource, type Matte, type Prepared } from "./render";
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

describe("close-up of a trim between skin and a plain garment panel (Penti Z91D419FC9238E844BF77Z_4, gate 3c)", () => {
  // As above, but the dark green fabric right of the trim is smooth linen (as in the real photo), so the
  // source alone takes it for background too: a smooth region touching the frame edge.
  const trim = (x: number) => x >= 150 && x < 210;
  const noise = (x: number, y: number) => grain(x, y) >> 3;
  const panel = image((x, y) => y < 30 || y >= H - 30 ? [255, 255, 255] : x < 150 ? [226, 186, 168] : trim(x) ? [clamp(120 + grain(x, y) * 4), clamp(120 + grain(x, y) * 4), clamp(110 + grain(x, y) * 4)] : [clamp(12 + noise(x, y)), clamp(30 + noise(x, y)), clamp(32 + noise(x, y))]);
  const inside = (y: number) => y >= 30 && y < H - 30;
  const at = (m: Matte, x: number, y: number) => m.alpha[y * W + x];

  it("treats the smooth fabric as a background candidate in the source", () => {
    const region = backgroundRegion(panel);
    expect(region.frameFilling).toBe(false);
    expect(region.background[300 * W + 320]).toBe(1);
  });

  it("rejects a matte that keeps the skin and trim but cuts the fabric panel through", () => {
    const ragged = matteOf((x, y) => inside(y) && x < 280);
    const verdict = checkMatteIntegrity(panel, ragged, { handRule: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.worstCellLoss).toBeGreaterThan(0.5);
    expect(checkMatteIntegrity(panel, matteOf((_x, y) => inside(y)), { handRule: false }).ok).toBe(true);
  });

  it("ends in a pass-through that keeps skin, trim and the whole fabric panel", async () => {
    // The live ladder: the first matte cuts the skin and keeps a sliver of the fabric, the padded one keeps the fabric and cuts the skin.
    const first = matteOf((x, y) => inside(y) && ((x >= 150 && x < 240) || (x < 150 && y >= 350)));
    const padded = matteOf((x, y) => inside(y) && (x >= 150 || y >= 300), "padded");
    const resolved = await resolveMatte({ prepared: panel, first, handRule: false, attempt: async v => v === "padded_first" ? padded : null });
    expect(resolved.passthrough).toBe(true);
    for (const [x, y] of [[40, 100], [40, 400], [180, 300], [230, 100], [320, 300], [W - 1, 300], [380, H - 40]] as const) expect(at(resolved.matte, x, y)).toBe(255);
    expect(at(resolved.matte, 200, 5)).toBe(0);
    expect(at(resolved.matte, 200, H - 5)).toBe(0);
  });

  it("does not keep a coloured backdrop that no matte kept", () => {
    // A product on a smooth pink wall, pasted on a white canvas: a good matte keeps the product only.
    const studio = image((x, y) => y < 30 || y >= H - 30 ? [255, 255, 255] : inRect(x, y, 120, 150, 160, 300) ? [clamp(60 + grain(x, y)), clamp(50 + grain(x, y)), clamp(40 + grain(x, y))] : [clamp(230 + noise(x, y)), clamp(170 + noise(x, y)), clamp(180 + noise(x, y))]);
    const good = matteOf((x, y) => inRect(x, y, 120, 150, 160, 300));
    expect(checkMatteIntegrity(studio, good, { handRule: false }).ok).toBe(true);
    const pass = passthroughMatte(studio, [good]);
    expect(at(pass, 20, 300)).toBe(0);
    expect(at(pass, 200, 300)).toBe(255);
  });

  it("does not take a white region kept on a white canvas for a panel", () => {
    // A white garment on a white wall: the matte keeps half of one white smooth region; that region stays background.
    const white = image((x, y) => inRect(x, y, 150, 200, 100, 200) ? [clamp(70 + grain(x, y)), clamp(70 + grain(x, y)), clamp(70 + grain(x, y))] : [250, 250, 250]);
    const half = matteOf(x => x < 200);
    expect(at(passthroughMatte(white, [half]), 20, 20)).toBe(0);
  });
});

describe("pass-through recolours only the true background (Penti Z91D419FC9238E844BF77Z_4, gate 3d)", () => {
  const at = (m: Matte, x: number, y: number) => m.alpha[y * W + x]!;
  const textured = (x: number, y: number): RGB => [clamp(40 + grain(x, y)), clamp(60 + grain(x, y)), clamp(50 + grain(x, y))];

  it("keeps a light strap touching the frame edge, and the skin below it", async () => {
    // As the gate 3c close-up, plus a near-white strap running off the left frame edge low in the photo,
    // with a sliver of skin between it and the white canvas strip (the live defect: both became flat canvas).
    const strap = (y: number) => y >= 548 && y < 560;
    const closeUp = image((x, y) => y < 30 || y >= H - 30 ? [255, 255, 255] : x < 150 ? (strap(y) ? [211, 209, 220] : [226, 186, 168]) : x < 210 ? [clamp(120 + grain(x, y) * 4), clamp(120 + grain(x, y) * 4), clamp(110 + grain(x, y) * 4)] : textured(x, y));
    const inside = (y: number) => y >= 30 && y < H - 30;
    const partial = matteOf((x, y) => inside(y) && (x >= 150 || y >= 300));
    const resolved = await resolveMatte({ prepared: closeUp, first: partial, handRule: false, attempt: async v => ({ ...partial, model: v }) });
    expect(resolved).toMatchObject({ passthrough: true, busyBackground: false });
    for (let x = 0; x < 150; x += 7) for (const y of [550, 555, 562, 565]) expect(at(resolved.matte, x, y)).toBe(255);
    for (let x = 0; x < W; x += 7) { expect(at(resolved.matte, x, 10)).toBe(0); expect(at(resolved.matte, x, H - 10)).toBe(0); }
  });

  it("recolours a plain white background fully, up to the product edge", () => {
    // A round product (no canvas strip can be trimmed off its sides): every white pixel, also next to its edge, is recoloured.
    const round = (x: number, y: number) => (x - 200) ** 2 + (y - 300) ** 2 < 150 ** 2;
    const p = image((x, y) => round(x, y) ? textured(x, y) : [255, 255, 255]);
    const matte = passthroughMatte(p);
    let kept = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!round(x, y) && at(matte, x, y) > 0) kept++;
    expect(kept).toBe(0);
    expect(at(matte, 200, 300)).toBe(255);
  });

  it("recolours a thin white gap between the product and the frame edge", () => {
    // An L-shaped product: a bar 3 px from the left edge, and a foot that runs off the left and bottom edges.
    const product = (x: number, y: number) => inRect(x, y, 3, 100, 250, 400) || inRect(x, y, 0, 500, 300, 100);
    const p = image((x, y) => product(x, y) ? textured(x, y) : [255, 255, 255]);
    const matte = passthroughMatte(p);
    for (let y = 100; y < 500; y += 5) for (let x = 0; x < 3; x++) expect(at(matte, x, y)).toBe(0);
    expect(at(matte, 100, 300)).toBe(255);
    expect(at(matte, 0, H - 1)).toBe(255);
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

  /**
   * The Penti bra chart (Z659062EFB3FB0720BF56Z): a pink header band and pale pink header cells joined
   * to the grid lines make one mark over 6% of the frame, and their fill outweighs the glyph ink.
   */
  const tintedChart = image((x, y) => {
    const inTable = x >= 20 && x < 380 && y >= 100 && y < 520;
    if (!inTable) return y >= 40 && y < 60 && x >= 150 && x < 250 && x % 14 < 9 ? [240, 80, 110] : [255, 250, 250];
    if (y === 100 || y === 519 || x === 20 || x === 379) return [120, 120, 120];
    if (y < 140) return y >= 116 && y < 124 && x >= 180 && x < 220 && x % 10 < 6 ? [255, 255, 255] : [249, 81, 114];
    if (y % 34 === 140 % 34 || (x - 20) % 60 === 0) return [120, 120, 120];
    const glyphRow = (y - 140) % 34 >= 13 && (y - 140) % 34 < 21 && (x - 20) % 60 > 5 && (x - 20) % 60 < 55 && x % 10 < 6;
    if (glyphRow) return [30, 30, 30];
    return y < 174 ? [250, 200, 215] : [255, 255, 255];
  });

  it("recognises a size chart with a tinted header band and table cells", () => {
    expect(detectTextImage(tintedChart)).toMatchObject({ text: true });
    // Caught on the second reading only: the tinted band and cells are read as page.
    expect(detectTextImage(tintedChart).tintedRegions).toBeGreaterThan(0);
  });

  it("does not take a flat tinted product with a printed logo for a chart", () => {
    const logo = (x: number, y: number) => inRect(x, y, 150, 260, 100, 40) && (y - 260) % 14 < 8 && x % 10 < 6;
    // A flat pink tee (body and sleeves) with a two-line logo, on a pale pink page.
    const tee = (x: number, y: number) => inRect(x, y, 110, 180, 180, 300) || (y >= 180 && y < 260 && x >= 60 - (y - 180) / 4 && x < 340 + (y - 180) / 4);
    const shirt = image((x, y) => tee(x, y) ? (logo(x, y) ? [255, 255, 255] : [235, 120, 150]) : [252, 242, 242]);
    expect(detectTextImage(shirt).text).toBe(false);
    // A rectangular flat pink box: a filled rectangle with the same logo is not a table.
    const box = image((x, y) => inRect(x, y, 80, 180, 240, 240) ? (logo(x, y) ? [30, 30, 30] : [235, 120, 150]) : [255, 255, 255]);
    expect(detectTextImage(box).text).toBe(false);
  });

  it("still recognises a flat white chart on the first reading", () => {
    expect(detectTextImage(chart)).toMatchObject({ text: true, tintedRegions: 0 });
  });

  /** A tee (body and sleeves) on a white page, painted by `fill`. */
  const tee = (x: number, y: number) => inRect(x, y, 110, 180, 180, 300) || (y >= 180 && y < 260 && x >= 60 - (y - 180) / 4 && x < 340 + (y - 180) / 4);
  const teePhoto = (fill: (x: number, y: number) => RGB) => image((x, y) => tee(x, y) ? fill(x, y) : [255, 255, 255]);

  it("does not take a striped or colour-block garment for a chart", () => {
    // Navy and white stripes: each navy stripe is a flat wide rectangle on the white page.
    expect(detectTextImage(teePhoto((_x, y) => Math.floor(y / 12) % 2 ? [40, 50, 120] : [255, 255, 255])).text).toBe(false);
    // Navy and red stripes: one large mark of two flat colours.
    expect(detectTextImage(teePhoto((_x, y) => Math.floor(y / 12) % 2 ? [40, 50, 120] : [200, 40, 50])).text).toBe(false);
    // Colour blocks: three flat rectangular panels.
    expect(detectTextImage(teePhoto((_x, y) => y < 260 ? [230, 60, 60] : y < 380 ? [250, 210, 60] : [40, 90, 200])).text).toBe(false);
  });

  it("does not take a product with a small printed logo for a chart", () => {
    const logo = (x: number, y: number) => inRect(x, y, 170, 300, 60, 22) && (y - 300) % 14 < 8 && x % 8 < 5;
    expect(detectTextImage(teePhoto((x, y) => logo(x, y) ? [250, 250, 250] : [30, 30, 30])).text).toBe(false);
  });

  it("does not take a tinted box printed with a block of text for a chart", () => {
    // Ten lines of small dark glyphs on a flat pink face: a chart's tinted table would read like this,
    // but there is no text on the plain page around it, so it is never read a second time.
    const text = (x: number, y: number) => y >= 180 && y < 420 && (y - 180) % 24 < 8 && x >= 80 && x < 320 && x % 10 < 6;
    const box = image((x, y) => inRect(x, y, 60, 150, 280, 300) ? (text(x, y) ? [30, 30, 30] : [235, 120, 150]) : [255, 255, 255]);
    expect(detectTextImage(box)).toMatchObject({ text: false, tintedRegions: 0 });
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

describe("thin coloured sliver along a dark sole (Anta bd-112625546-12 shot 5, eval run 2)", () => {
  /** A sole view: a dark grained outsole on white with a lime midsole sliver, 6 px, along its bottom edge (the interior rule alone measures 15% lost in its cell). */
  const sole = (x: number, y: number) => inRect(x, y, 60, 240, 280, 120);
  const sliver = (x: number, y: number) => inRect(x, y, 120, 360, 160, 6);
  const photo = (strip: RGB) => image((x, y) => sole(x, y) ? [clamp(40 + grain(x, y)), clamp(40 + grain(x, y)), clamp(44 + grain(x, y))] : sliver(x, y) ? strip : [255, 255, 255]);
  const lime: RGB = [138, 156, 32];

  it("counts the dropped sliver as lost product, though most of it lies in the estimate's edge band", () => {
    const verdict = checkMatteIntegrity(photo(lime), matteOf(sole));
    expect(verdict.ok).toBe(false);
    expect(verdict.worstCellLoss).toBeGreaterThan(0.2);
    expect(checkMatteIntegrity(photo(lime), matteOf((x, y) => sole(x, y) || sliver(x, y))).ok).toBe(true);
  });

  it("still takes a dark grey strip under the sole for the source's own shadow", () => {
    expect(checkMatteIntegrity(photo([70, 70, 74]), matteOf(sole)).ok).toBe(true);
  });

  it("accepts a good matte whose edge sits a pixel inside a strongly coloured product", () => {
    const red = image((x, y) => sole(x, y) ? [clamp(200 + grain(x, y)), clamp(40 + grain(x, y)), 50] : [255, 255, 255]);
    expect(checkMatteIntegrity(red, matteOf((x, y) => inRect(x, y, 61, 241, 278, 118))).ok).toBe(true);
  });

  it("climbs the ladder to the pass-through, which keeps the sliver, when every model drops it", async () => {
    const p = photo(lime), attempts: MatteVariant[] = [];
    const resolved = await resolveMatte({ prepared: p, first: matteOf(sole), handRule: true, attempt: async v => { attempts.push(v); return matteOf(sole, v); } });
    expect(attempts).toEqual(["second", "padded_first", "padded_second"]);
    expect(resolved.passthrough).toBe(true);
    expect(resolved.matte.alpha[362 * W + 200]).toBeGreaterThan(240);
    expect(resolved.matte.alpha[380 * W + 200]).toBe(0);
  });
});

describe("busy background (French Connection ZEE79259BBFD83FFA1DB0Z shot 5, eval run 2)", () => {
  // Two models on a tennis court: a textured hedge across the top, a plain grey wall, an orange court below, a
  // textured net post between the models and a racket on the court. Every model matte keeps the two models only.
  const models = (x: number, y: number) => inRect(x, y, 60, 150, 100, 450) || inRect(x, y, 240, 150, 100, 450);
  const scenery = (x: number, y: number) => y < 60 || inRect(x, y, 195, 250, 10, 350) || inRect(x, y, 160, 420, 30, 30);
  const court = image((x, y) => models(x, y) ? [clamp(30 + grain(x, y)), clamp(30 + grain(x, y)), clamp(34 + grain(x, y))]
    : scenery(x, y) ? [clamp(70 + grain(x, y) * 2), clamp(110 + grain(x, y) * 2), clamp(50 + grain(x, y))]
    : y < 250 ? [190, 188, 182] : [233, 124, 86]);
  const kept = (model = "first") => matteOf(models, model);

  it("rejects every matte (the scenery is product by the source alone), and holds the photo whole instead of a ragged pass-through", async () => {
    expect(backgroundRegion(court).frameFilling).toBe(false);
    expect(checkMatteIntegrity(court, kept(), { handRule: false }).ok).toBe(false);
    const resolved = await resolveMatte({ prepared: court, first: kept(), handRule: false, attempt: async v => kept(v) });
    expect(resolved).toMatchObject({ passthrough: false, busyBackground: true });
    expect(resolved.actions.map(a => `${a.step}:${a.result}`)).toEqual(["matte_check:failed", "second_matte:failed", "padded_matte:failed", "padded_matte:failed", "matte_passthrough:failed"]);
    expect(resolved.actions.at(-1)!.detail).toMatch(/busy background/);
    // The whole photo as it is: nothing recoloured, nothing cut out.
    expect(resolved.matte.model).toBe(PASSTHROUGH_MODEL);
    expect(resolved.matte.alpha.every(v => v === 255)).toBe(true);
  });

  it("measures the scenery a pass-through would leave in the border band", () => {
    const tried = [kept()], share = busyBorderShare(court, passthroughMatte(court, tried), tried);
    expect(share).toBeGreaterThan(BUSY_BORDER_MAX_SHARE);
    // The same models on a plain studio backdrop: the recolour replaces the whole band.
    const studio = image((x, y) => models(x, y) ? [clamp(30 + grain(x, y)), 30, 34] : [235, 235, 235]);
    expect(busyBorderShare(studio, passthroughMatte(studio, tried), tried)).toBe(0);
  });

  it("still passes a frame-filling close-up through whole (no backdrop to replace)", async () => {
    const resolved = await resolveMatte({ prepared: image(leather), first: logoOnly(), handRule: true, attempt: async v => logoOnly(v) });
    expect(resolved).toMatchObject({ passthrough: true, busyBackground: false });
  });

  it("renders the held photo whole, never trimmed, on a square canvas", async () => {
    const resolved = await resolveMatte({ prepared: court, first: kept(), handRule: false, attempt: async v => kept(v) });
    const output = await renderSource({ prepared: prepared(court), matte: resolved.matte, channel: "centrepoint", shotNumber: 2, productType: "apparel_model" });
    expect(output.plan.sourceCrop).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(output.plan.productBox!.h).toBe(output.plan.h);
    expect(output.plan.productBox!.w).toBeLessThan(output.plan.w);
  });
});

describe("kept background chunk below the base (French Connection Z15276411CE85C2E728DEZ shot 4, eval run 2)", () => {
  // A candle (off-white wax with green leaves) on pure white; the live defect: a matte that also keeps a white
  // wedge of the backdrop below the base at the bottom left.
  const candle = (x: number, y: number) => inRect(x, y, 40, 200, 320, 200);
  const wedge = (x: number, y: number) => inRect(x, y, 40, 400, 140, 30);
  const photo = (base: RGB) => image((x, y) => candle(x, y) ? [clamp(205 + grain(x, y) / 2), clamp(210 + grain(x, y)), clamp(195 + grain(x, y) / 2)] : wedge(x, y) ? base : [255, 255, 255]);
  const white = photo([255, 255, 255]);
  const withChunk = (model = "first") => matteOf((x, y) => candle(x, y) || wedge(x, y), model);
  const clean = (model = "first") => matteOf(candle, model);

  it("rejects a matte that keeps a region of the backdrop colour hanging below the product", () => {
    const chunk = keptBackground(white, withChunk().alpha, backgroundRegion(white));
    expect(chunk.frameShare).toBeGreaterThan(0.003);
    expect(chunk.keptShare).toBeGreaterThan(0.02);
    const verdict = checkMatteIntegrity(white, withChunk(), { handRule: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/^kept background/);
    expect(checkMatteIntegrity(white, clean(), { handRule: false }).ok).toBe(true);
  });

  it("accepts a pale product part of its own shade at the bottom (a white sole, a pale hem)", () => {
    const sole = photo([238, 238, 236]);
    expect(checkMatteIntegrity(sole, withChunk(), { handRule: false }).ok).toBe(true);
  });

  it("ignores a white label inside the product and a speck at the edge", () => {
    const label = image((x, y) => inRect(x, y, 150, 330, 100, 60) ? [255, 255, 255] : candle(x, y) ? [clamp(205 + grain(x, y) / 2), 210, 195] : [255, 255, 255]);
    expect(checkMatteIntegrity(label, clean(), { handRule: false }).ok).toBe(true);
    expect(checkMatteIntegrity(white, matteOf((x, y) => candle(x, y) || inRect(x, y, 40, 400, 20, 10)), { handRule: false }).ok).toBe(true);
    // A halo ring of backdrop around the whole silhouette is the judge's halo, not a chunk below the base.
    expect(checkMatteIntegrity(white, matteOf((x, y) => inRect(x, y, 30, 190, 340, 220)), { handRule: false }).ok).toBe(true);
  });

  it("climbs the ladder past the matte with the chunk to a clean one", async () => {
    const resolved = await resolveMatte({ prepared: white, first: withChunk(), handRule: false, attempt: async v => v === "padded_second" ? clean(v) : withChunk(v) });
    expect(resolved).toMatchObject({ passthrough: false, busyBackground: false });
    expect(resolved.matte.model).toBe("padded_second");
    expect(resolved.matte.alpha[415 * W + 100]).toBe(0);
  });
});

describe("busy background is scenery, not a close-up whose mattes dropped the product (gate 3f, French Connection Z02B2EE44E3A08044B816Z)", () => {
  // Pebbled leather: a dark pebble every 20 pixels (edge density about 0.2, two tones), the fine grain of one material.
  const pebble = (x: number, y: number) => (x * 7 + y * 13) % 20 === 0;
  const leatherAt = (x: number, y: number): RGB => pebble(x, y) ? [165, 50, 0] : [225, 110, 40];
  // The close-up as the brand ships it: pasted on a white canvas with 40 px strips at the top and bottom, a white
  // backdrop sliver above the zip in the top left corner, the gold letters in the middle.
  const sliver = (x: number, y: number) => y < 40 + 120 - x * 0.5;
  const closeUp = image((x, y) => y < 40 || y >= H - 40 ? [255, 255, 255] : inRect(x, y, 150, 250, 100, 100) ? [214, 180, 90] : sliver(x, y) ? [255, 255, 255] : leatherAt(x, y));
  const letters = (model = "first") => matteOf((x, y) => inRect(x, y, 150, 250, 100, 100), model);

  it("passes the close-up through whole when every matte keeps only the letters (no hold)", async () => {
    const region = backgroundRegion(closeUp);
    expect(region.frameFilling).toBe(false);
    expect(region.rect).toEqual({ x0: 0, y0: 40, x1: W - 1, y1: H - 41 });
    const tried = [letters()], reading = busyBorderReading(closeUp, passthroughMatte(closeUp, tried), tried, region);
    // Over the share bar (the rule before gate 3f held it), but it reads as one material.
    expect(reading.share).toBeGreaterThan(BUSY_BORDER_MAX_SHARE);
    expect(reading.edgeDensity).toBeGreaterThan(BUSY_PLAIN_EDGE_MAX);
    expect(reading.edgeDensity).toBeLessThan(BUSY_EDGE_DENSITY_MIN);
    expect(reading.scenery).toBe(false);
    const resolved = await resolveMatte({ prepared: closeUp, first: letters(), handRule: true, attempt: async v => v === "padded_first" ? letters(v) : null });
    expect(resolved).toMatchObject({ passthrough: true, busyBackground: false });
    expect(resolved.actions.at(-1)!.detail).toMatch(/one material or one plain colour, not scenery/);
    // The leather is kept, the white sliver and the canvas strips are not.
    expect(resolved.matte.alpha[400 * W + 4]).toBe(255);
    expect(resolved.matte.alpha[45 * W + 10]).toBe(0);
    expect(resolved.matte.alpha[10 * W + 200]).toBe(0);
  });

  it("reads plain band pixels in one colour as a backdrop kept whole and plain pixels in several tones as scenery", () => {
    const object = (x: number, y: number) => inRect(x, y, 100, 200, 200, 200), tried = [matteOf(object)], all = matteOf(() => true);
    // A plain pale yellow dress behind a held bag (shot 1): one colour.
    const dress = image((x, y) => object(x, y) ? [225, 110, 40] : [245, 236, 208]);
    expect(busyBorderReading(dress, all, tried)).toMatchObject({ edgeDensity: 0, tones: 1, scenery: false });
    // A wall darkening towards the top over a wooden table (the lifestyle candle Z011CB57531CA8FA0CBDDZ shot 1): plain, many tones.
    const room = image((x, y) => object(x, y) ? [240, 230, 200] : y < 420 ? [clamp(90 + y / 3), clamp(75 + y / 4), clamp(65 + y / 5)] : [185, 132, 85]);
    const reading = busyBorderReading(room, all, tried);
    expect(reading.edgeDensity).toBeLessThan(BUSY_PLAIN_EDGE_MAX);
    expect(reading.tones).toBeGreaterThanOrEqual(BUSY_PLAIN_TONES_MIN);
    expect(reading.scenery).toBe(true);
  });

  it("separates the measured gate and golden photos (edge density, tones of the band pixels no cut-out kept)", () => {
    // Held: tennis court ZEE79259BBFD83FFA1DB0Z shot 5 (all policies), lifestyle candle Z011CB57531CA8FA0CBDDZ shot 1 (other, bag, model photo).
    for (const [edges, tones] of [[0.509, 60], [0.507, 55], [0.0, 11], [0.01, 31], [0.01, 30]] as const) expect(readsAsScenery(edges, tones)).toBe(true);
    // Passed through: Z02B2EE44E3A08044B816Z shots 1, 3 and 6, Z5A0B7DE13FC67EDEAC9DZ shot 5 (leather close-up).
    for (const [edges, tones] of [[0.0, 4], [0.249, 24], [0.198, 30], [0.134, 9]] as const) expect(readsAsScenery(edges, tones)).toBe(false);
  });

  it("keeps a held photo whole but drops the brand's canvas strips, so it is fitted with the band note, never framed in white", async () => {
    // The court scene pasted on a white canvas with 40 px strips at the top and bottom.
    const models = (x: number, y: number) => inRect(x, y, 60, 150, 100, 400) || inRect(x, y, 240, 150, 100, 400);
    const scene = (x: number, y: number) => y < 100 || inRect(x, y, 195, 250, 10, 300);
    const pasted = image((x, y) => y < 40 || y >= H - 40 ? [255, 255, 255] : models(x, y) ? [clamp(30 + grain(x, y)), clamp(30 + grain(x, y)), clamp(34 + grain(x, y))]
      : scene(x, y) ? [clamp(70 + grain(x, y) * 2), clamp(110 + grain(x, y) * 2), clamp(50 + grain(x, y))] : y < 250 ? [190, 188, 182] : [233, 124, 86]);
    const kept = (model = "first") => matteOf(models, model);
    const resolved = await resolveMatte({ prepared: pasted, first: kept(), handRule: false, attempt: async v => kept(v) });
    expect(resolved).toMatchObject({ passthrough: false, busyBackground: true });
    expect(resolved.actions.at(-1)!.detail).toMatch(/edge density 0\.\d\d, \d+ tones, read as scenery/);
    const alpha = resolved.matte.alpha;
    expect(alpha[10 * W + 200]).toBe(0);
    expect(alpha[(H - 10) * W + 200]).toBe(0);
    expect(alpha[40 * W]).toBe(255);
    expect(alpha[(H - 41) * W + W - 1]).toBe(255);
    expect(wholePhotoMatte(pasted).alpha.equals(alpha)).toBe(true);
    // "Use as is" on a grey canvas: the photo is fitted (never trimmed), its cut sides float, and the band note says so.
    const output = await renderSource({ prepared: prepared(pasted), matte: resolved.matte, channel: "noon", shotNumber: 2, productType: "apparel_model" });
    expect(output.flags).toContain("cut_in_source");
    expect(output.plan.sourceCrop).toEqual({ x: 0, y: 40, w: W, h: H - 80 });
    expect(hasCutBandNote(output.notes.join("; "))).toBe(true);
  });
});

describe("coloured sole strip the matte drops (Anta bd-112625546-12 shot 5, eval run 3 M1)", () => {
  // A grey upper on a black outsole on a white floor, x 60 to 339; under the outsole a lime strip (rows 441 to 447).
  const shoe = (x: number, y: number, below: (y: number) => RGB | null): RGB => {
    if (x < 60 || x >= 340) return [255, 255, 255];
    if (y >= 250 && y < 400) return [clamp(150 + grain(x, y) / 4), 150, 150];
    if (y >= 400 && y <= 440) return [30, 30, 32];
    return below(y) ?? [255, 255, 255];
  };
  const lime = (y: number): RGB | null => y >= 441 && y <= 447 ? [130, 150, 20] : null;
  // The same shoe with no strip and a floor reflection: a grey gap row, then a 2 px pink line.
  const reflected = (y: number): RGB | null => y >= 441 && y <= 442 ? [204, 205, 204] : y >= 443 && y <= 444 ? [187, 108, 95] : null;
  const keptTo = (bottom: number) => matteOf((x, y) => x >= 60 && x < 340 && y >= 250 && y <= bottom);
  const at = (m: Buffer, x: number, y: number) => m[y * W + x]!;

  it("gives back the lower rows of the strip, opaque, with one antialiased edge pixel", () => {
    const p = image((x, y) => shoe(x, y, lime)), matte = keptTo(444);
    const r = recoverSoleStrip(p, matte.alpha);
    expect(r.recovered).toBe(280 * 3);
    for (const x of [60, 200, 339]) {
      expect([at(r.alpha, x, 445), at(r.alpha, x, 446), at(r.alpha, x, 447)]).toEqual([255, 255, 128]);
      expect(at(r.alpha, x, 448)).toBe(0);
    }
    expect(at(matte.alpha, 200, 446)).toBe(0);
  });

  it("smooths a ragged strip end so neighbouring columns end at most 1 px apart, never past the coloured strip", () => {
    // The strip's lower edge jumps between rows 444 and 447 from column to column (JPEG and matte noise).
    const ragged = (x: number) => 444 + [0, 3, 1, 3, 0, 2, 3, 1][x % 8]!;
    const p = image((x, y) => shoe(x, y, yy => yy >= 441 && yy <= ragged(x) ? [130, 150, 20] : null)), r = recoverSoleStrip(p, keptTo(442).alpha);
    expect(r.recovered).toBeGreaterThan(280);
    const ends: number[] = [];
    for (let x = 60; x < 340; x++) {
      let y = 448; while (y > 442 && at(r.alpha, x, y) === 0) y--;
      expect(y).toBeLessThanOrEqual(ragged(x));
      ends.push(y);
    }
    for (let k = 1; k < ends.length; k++) expect(Math.abs(ends[k]! - ends[k - 1]!)).toBeLessThanOrEqual(1);
  });

  it("does not give back a reflection line under a grey gap, a floor, or a short coloured blob", async () => {
    const p = image((x, y) => shoe(x, y, reflected));
    expect(recoverSoleStrip(p, keptTo(440).alpha).changed).toBe(0);
    expect(recoverSoleStrip(image((x, y) => shoe(x, y, () => null)), keptTo(440).alpha).changed).toBe(0);
    // A coloured contact smudge 10 px wide (under 10% of the shoe's width) is not a strip along the sole.
    const blob = image((x, y) => shoe(x, y, yy => x >= 200 && x < 210 && yy <= 446 ? [134, 67, 51] : null));
    expect(recoverSoleStrip(blob, keptTo(440).alpha).changed).toBe(0);
  });

  it("runs on the winning matte for footwear only", async () => {
    const p = image((x, y) => shoe(x, y, lime)), first = keptTo(444);
    const footwear = await resolveMatte({ prepared: p, first, handRule: true, soleStrip: true, attempt: async () => null });
    expect(footwear.soleStripRecovered).toBe(280 * 3);
    expect(at(footwear.matte.alpha, 200, 445)).toBe(255);
    const other = await resolveMatte({ prepared: p, first, handRule: true, attempt: async () => null });
    expect(other.soleStripRecovered).toBe(0);
    expect(other.matte.alpha).toBe(first.alpha);
  });
});

describe("translucent ghost matte (Penti ZBE55F7B86F158FEA0EB9Z shot 5, eval run 3)", () => {
  /** A matte with its own alpha per pixel. */
  const alphaOf = (value: (x: number, y: number) => number, model = "first"): Matte => {
    const alpha = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) alpha[y * W + x] = value(x, y);
    return { alpha, width: W, height: H, model, ms: 1, source: "model", target: "cpu", sentLongSide: 1024 };
  };
  const textured = (x: number, y: number): RGB => [clamp(70 + grain(x, y)), clamp(50 + grain(x, y)), clamp(40 + grain(x, y))];
  const body = (x: number, y: number) => inRect(x, y, 100, 120, 200, 360);
  const onWhite = image((x, y) => body(x, y) ? textured(x, y) : [255, 255, 255]);
  /** Distance in pixels from (x, y) inside the body to the body's nearest side. */
  const inset = (x: number, y: number) => Math.min(x - 100, 299 - x, y - 120, 479 - y);

  it("rejects a matte that keeps a frame-filling close-up at alpha 50 everywhere (it drops nothing and keeps nothing)", () => {
    const p = image(leather), verdict = checkMatteIntegrity(p, alphaOf(() => 50), { handRule: false });
    expect(verdict).toMatchObject({ ok: false, frameFilling: true, overallLoss: 0, opaqueShare: 0 });
    expect(verdict.detail).toMatch(/^translucent/);
  });

  it("rejects a uniformly translucent matte of a product on a plain backdrop", () => {
    const verdict = checkMatteIntegrity(onWhite, alphaOf((x, y) => body(x, y) ? 60 : 0), { handRule: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/^translucent/);
  });

  it("accepts an opaque matte with soft 2 px edges", () => {
    const soft = alphaOf((x, y) => !body(x, y) ? 0 : inset(x, y) === 0 ? 85 : inset(x, y) === 1 ? 170 : 255);
    const verdict = checkMatteIntegrity(onWhite, soft, { handRule: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.opaqueShare).toBe(1);
  });

  it("accepts a sheer panel at the edge (an opaque body with a see-through sleeve)", () => {
    // A dress: an opaque torso and a wider skirt, and a blue chiffon sleeve beside the torso that the matte keeps
    // at alpha 110. The sleeve sits inside the dress's outline, clear of the border band.
    const dress = (x: number, y: number) => inRect(x, y, 100, 120, 200, 180) || inRect(x, y, 40, 300, 320, 180);
    const sleeve = (x: number, y: number) => inRect(x, y, 300, 140, 50, 160);
    const p = image((x, y) => dress(x, y) ? textured(x, y) : sleeve(x, y) ? [70, 100, 180] : [255, 255, 255]);
    const verdict = checkMatteIntegrity(p, alphaOf((x, y) => dress(x, y) ? 255 : sleeve(x, y) ? 110 : 0), { handRule: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.opaqueShare).toBeLessThan(0.95);
    expect(verdict.opaqueShare).toBeGreaterThan(GUARD_OPAQUE_MIN_SHARE);
  });

  it("climbs the ladder past the ghost to the first opaque matte", async () => {
    const ghost = (model: string) => alphaOf(() => 50, model);
    const resolved = await resolveMatte({ prepared: image(leather), first: ghost("first"), handRule: false, attempt: async v => v === "padded_first" ? alphaOf(() => 255, v) : ghost(v) });
    expect(resolved).toMatchObject({ passthrough: false, busyBackground: false });
    expect(resolved.matte.model).toBe("padded_first");
    expect(resolved.actions.map(a => `${a.step}:${a.result}`)).toEqual(["matte_check:failed", "second_matte:failed", "padded_matte:passed"]);
  });
});

describe("white garment on a near-white wall (Vero Moda Z40E29CD878FAA726501DZ shot 1, eval run 3)", () => {
  // A white top (242, 13 levels off the wall, inside the 16-level border-colour flood) over dark trousers that
  // run off the bottom edge, on a flat 229 grey wall.
  const top = (x: number, y: number) => inRect(x, y, 120, 100, 160, 230);
  const trousers = (x: number, y: number) => inRect(x, y, 140, 330, 120, 270);
  const dark = (x: number, y: number): RGB => [clamp(70 + grain(x, y)), clamp(50 + grain(x, y)), clamp(40 + grain(x, y))];
  const p = image((x, y) => top(x, y) ? [242, 241, 239] : trousers(x, y) ? dark(x, y) : [229, 229, 229]);
  const at = (m: Matte, x: number, y: number) => m.alpha[y * W + x]!;
  const clean = (model = "first") => matteOf((x, y) => top(x, y) || trousers(x, y), model);
  // What every deployed matte did: the garment plus a wedge of wall beside the trousers (a kept background chunk).
  const withChunk = (model = "first") => matteOf((x, y) => top(x, y) || trousers(x, y) || inRect(x, y, 260, 450, 40, 50), model);

  it("measures how much of the product every matte kept the border-colour flood would take", () => {
    const region = backgroundRegion(p), guide = passthroughGuide(p, region, [clean()]);
    // The agreed product is the top and the trousers, 3 px in.
    expect(guide.product[200 * W + 200]).toBe(1);
    expect(guide.product[400 * W + 200]).toBe(1);
    expect(guide.product[101 * W + 200]).toBe(0);
    // The flood takes the white top with the wall: that is the loss, about the top's share of the product.
    expect(at(passthroughMatte(p, [clean()]), 200, 200)).toBe(0);
    const loss = passthroughProductLoss(p, [clean()], region, guide);
    expect(loss).toBeGreaterThan(0.4);
    expect(loss).toBeLessThan(0.6);
    // A dark product on the same wall loses nothing.
    const dark2 = image((x, y) => top(x, y) || trousers(x, y) ? dark(x, y) : [229, 229, 229]);
    expect(passthroughProductLoss(dark2, [clean()])).toBe(0);
  });

  it("does not count a kept background chunk as product", () => {
    const guide = passthroughGuide(p, backgroundRegion(p), [withChunk()]);
    expect(guide.product[475 * W + 280]).toBe(0);
    expect(guide.product[200 * W + 200]).toBe(1);
  });

  it("holds the photo whole when a pass-through would recolour the product (loss over the bound)", async () => {
    expect(passthroughProductLoss(p, [withChunk(), withChunk("second")])).toBeGreaterThan(PASSTHROUGH_PRODUCT_LOSS_MAX);
    const resolved = await resolveMatte({ prepared: p, first: withChunk(), handRule: false, attempt: async v => withChunk(v) });
    expect(resolved).toMatchObject({ passthrough: false, busyBackground: true, soleStripRecovered: 0 });
    const last = resolved.actions.at(-1)!;
    expect(last).toMatchObject({ step: "matte_passthrough", result: "failed", trigger: ["product_removed", "leftover_background"] });
    expect(last.detail).toMatch(/^background matches the product/);
    expect(resolved.matte.alpha.equals(wholePhotoMatte(p).alpha)).toBe(true);
    expect(at(resolved.matte, 200, 200)).toBe(255);
  });

  it("still passes a dark product with the same chunk through (no loss)", async () => {
    const darkPhoto = image((x, y) => top(x, y) || trousers(x, y) ? dark(x, y) : [229, 229, 229]);
    expect(passthroughProductLoss(darkPhoto, [withChunk()])).toBe(0);
    const resolved = await resolveMatte({ prepared: darkPhoto, first: withChunk(), handRule: false, attempt: async v => withChunk(v) });
    expect(resolved).toMatchObject({ passthrough: true, busyBackground: false });
    expect(at(resolved.matte, 280, 475)).toBe(0);
  });
});
