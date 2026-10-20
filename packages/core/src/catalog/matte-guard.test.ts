import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { backgroundRegion, BUSY_BORDER_MAX_SHARE, busyBorderShare, checkMatteIntegrity, detectTextImage, heldInHand, keptBackground, passthroughMatte, resolveMatte, type MatteVariant } from "./matte-guard";
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
