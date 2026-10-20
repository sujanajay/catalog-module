import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "./channels";
import { checkOutput } from "./compliance";
import { CUT_FILL_MAX_TRIM, CUT_FILL_TRIM_SLACK, detailFeatures, NO_CUT, PASSTHROUGH_MODEL, planCanvas, planProduct, renderSource, shotGeometry, trimRoom, trimRules, type Matte, type Prepared } from "./render";
import { analyseBackground } from "./shadow";

// A brand photo already cropped mid-body inside a thin white border: 800x1200, a 10 px border, the
// body opaque (254, as real mattes peak) down to row 1185, then the matte's soft fade into the border.
function cutModel(opts: { width?: number; height?: number; border?: number; legWidth?: number } = {}): { prepared: Prepared; matte: Matte } {
  const width = opts.width ?? 800, height = opts.height ?? 1200, border = opts.border ?? 10, bodyBottom = height - border - 5;
  const rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  const set = (x: number, y: number, a: number) => { const i = y * width + x; alpha[i] = a; rgb[i * 3] = 40; rgb[i * 3 + 1] = 70; rgb[i * 3 + 2] = 140; };
  for (let y = 300; y <= bodyBottom; y++) {
    // A shirt 300 px wide, then (optionally) a single narrow leg below row 900.
    const half = opts.legWidth !== undefined && y > 900 ? opts.legWidth / 2 : 150;
    for (let x = 400 - half; x < 400 + half; x++) set(x, y, 254);
  }
  [200, 150, 100, 50].forEach((a, k) => { for (let x = 250; x < 550; x++) if (opts.legWidth === undefined) set(x, bodyBottom + 1 + k, a); });
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}

type Rgb = [number, number, number];
// An 800x1200 frame: a uniform pad of `padDepth` px top and bottom (`sidePad` at the sides) around a photo of colour
// `photo` (`sidePhoto` within 40 px of its sides); a body 400 px wide from row 300 and two legs of 80 px (20% of the
// box) cut straight at the photo's bottom edge, the matte fading over the last 3 rows.
function padded(o: { pad: Rgb; photo: Rgb; padDepth: number; sidePad?: number; sidePhoto?: Rgb }) {
  const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height), side = o.sidePad ?? 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inPhoto = y >= o.padDepth && y < height - o.padDepth && x >= side && x < width - side;
    rgb.set(!inPhoto ? o.pad : o.sidePhoto && (x < side + 40 || x >= width - side - 40) ? o.sidePhoto : o.photo, (y * width + x) * 3);
  }
  const bottom = height - o.padDepth - 1;
  const paint = (x0: number, x1: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) for (let x = x0; x < x1; x++) { const i = y * width + x; alpha[i] = 254; rgb.set([40, 70, 140], i * 3); } };
  paint(200, 600, 300, 800); paint(260, 340, 801, bottom); paint(460, 540, 801, bottom);
  [60, 120, 180].forEach((a, k) => { for (const x0 of [260, 460]) for (let x = x0; x < x0 + 80; x++) alpha[(bottom - k) * width + x] = a; });
  return { width, height, rgb, alpha };
}

// A full-length model on white with the feet 13 px above the frame bottom (the bd- and Z11AA shoe shots): rounded
// soles, or flat soles; the second shoe stands 20 px higher.
function standing(sole: "rounded" | "flat") {
  const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  const paint = (x0: number, x1: number, y0: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * width + x; alpha[i] = 254; rgb.set([30, 30, 30], i * 3); } };
  const floor = height - 13;
  paint(220, 580, 100, 700); paint(300, 360, 700, floor - 40); paint(440, 500, 700, floor - 40);
  for (let y = floor - 40; y < floor; y++) {
    const half = sole === "rounded" ? Math.round(30 * Math.sqrt(1 - ((y - (floor - 40)) / 40) ** 2)) : 30;
    paint(330 - half, 330 + half, y, y + 1);
    if (y < floor - 20) paint(470 - half, 470 + half, y, y + 1);
  }
  return { width, height, rgb, alpha };
}

// A model cut at the waist and thighs on pure white, padded by the brand with a 66 px white band top and bottom
// (Penti Z10DE shot 1): the torso starts on row 66 and, with `leftCut`, runs off the left frame edge; two thighs end
// on row 1133. Nothing but the product's own straight edges shows where the photo ended.
function whiteBandCrop(leftCut: boolean) {
  const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  const paint = (x0: number, x1: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) for (let x = x0; x < x1; x++) { const i = y * width + x; alpha[i] = 254; rgb.set([200, 150, 120], i * 3); } };
  paint(leftCut ? 0 : 60, 700, 66, 700); paint(120, 360, 701, 1133); paint(420, 660, 701, 1133);
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" } satisfies Prepared, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } satisfies Matte };
}

describe("cut in source", () => {
  it("finds a straight opaque cut inside the white border and trims the matte's fade beyond it", () => {
    const { matte } = cutModel(), shot = shotGeometry(matte.alpha, matte.width, matte.height)!;
    expect(shot.cut).toEqual({ top: false, bottom: true, left: false, right: false });
    expect(shot.box).toEqual({ x: 250, y: 300, w: 300, h: 1185 - 300 + 1 });
  });
  it("ignores products with room around them", () => {
    const framed = cutModel({ border: 200 });
    expect(shotGeometry(framed.matte.alpha, framed.matte.width, framed.matte.height, { rgb: framed.prepared.rgb })!.cut).toEqual(NO_CUT);
  });
  it("finds a narrow cut the old 25% run rule missed: one leg cut at the shin, 20% of the box", () => {
    const leg = cutModel({ legWidth: 60 });
    expect(shotGeometry(leg.matte.alpha, leg.matte.width, leg.matte.height, { rgb: leg.prepared.rgb })!.cut.bottom).toBe(true);
  });
  it("finds two legs cut at the knee inside a light grey pad around a grey photo (Vero Moda, Penti)", () => {
    const shot = padded({ pad: [235, 235, 235], photo: [205, 205, 205], padDepth: 60 });
    const geometry = shotGeometry(shot.alpha, shot.width, shot.height, { rgb: shot.rgb })!;
    expect(geometry.cut).toEqual({ top: false, bottom: true, left: false, right: false });
    // Trimmed to where the cut turns opaque, past the 3 px fade.
    expect(geometry.box.y + geometry.box.h).toBe(shot.height - 60 - 3);
    // The 60 px band is deeper than the thin border: without the pixels it is not known to be a pad.
    expect(shotGeometry(shot.alpha, shot.width, shot.height)!.cut.bottom).toBe(false);
  });
  it("finds the cut of a letterboxed photo whose background is the pad colour, from the photo corner", () => {
    // White pad 9 px at the sides and 89 px top and bottom; the photo is white at the bottom, grey near its sides.
    const shot = padded({ pad: [255, 255, 255], photo: [255, 255, 255], padDepth: 89, sidePad: 9, sidePhoto: [228, 228, 228] });
    expect(shotGeometry(shot.alpha, shot.width, shot.height, { rgb: shot.rgb })!.cut.bottom).toBe(true);
  });
  it("never flags a standing model's feet near the frame bottom", () => {
    for (const sole of ["rounded", "flat"] as const) {
      const shot = standing(sole);
      expect(shotGeometry(shot.alpha, shot.width, shot.height, { rgb: shot.rgb })!.cut, sole).toEqual(NO_CUT);
    }
  });
  it("on a judge-confirmed cut also takes a deep band of the photo's own colour as the pad", () => {
    const shot = padded({ pad: [255, 255, 255], photo: [255, 255, 255], padDepth: 66 });
    expect(shotGeometry(shot.alpha, shot.width, shot.height, { rgb: shot.rgb })!.cut.bottom).toBe(false);
    expect(shotGeometry(shot.alpha, shot.width, shot.height, { rgb: shot.rgb, judgedCut: true })!.cut.bottom).toBe(true);
  });
  it("takes a deep band of the photo's own colour as the pad when the product is cut at a perpendicular frame edge", () => {
    const crop = whiteBandCrop(true), { alpha, width, height } = crop.matte;
    const geometry = shotGeometry(alpha, width, height, { rgb: crop.prepared.rgb })!;
    expect(geometry.cut).toEqual({ top: true, bottom: true, left: true, right: false });
    expect(geometry.box).toEqual({ x: 0, y: 66, w: 700, h: 1068 });
    // Without a frame cut the same straight edges may be a flat-laid hem: the deep white band stays margin.
    const framed = whiteBandCrop(false);
    expect(shotGeometry(framed.matte.alpha, width, height, { rgb: framed.prepared.rgb })!.cut).toEqual(NO_CUT);
  });
  it.each(["noon", "namshi", "trendyol"] as const)("renders the white-band crop flush top and bottom on %s", async id => {
    const output = await renderSource({ ...whiteBandCrop(true), channel: id, shotNumber: 1, productType: "apparel_model" });
    expect(output.status).toBe("ok");
    expect(output.compliance.failures).toEqual([]);
    const box = output.plan.productBox!;
    expect([box.y, box.y + box.h]).toEqual([0, output.plan.h]);
  });
  it("puts the cut flush with the canvas edge and keeps the other margins", () => {
    const { matte } = cutModel(), shot = shotGeometry(matte.alpha, matte.width, matte.height)!;
    for (const id of ["noon", "namshi", "amazon", "trendyol", "styli"] as const) {
      const plan = planCanvas(CHANNELS[id], shot.box, shot.source, { cut: shot.cut }), box = plan.productBox!;
      expect(box.y + box.h, id).toBe(plan.h);
      if (id === "noon" || id === "namshi") expect(box.y).toBeGreaterThanOrEqual(Math.ceil(plan.h * 0.1));
      if (id === "styli") expect(box.y).toBeGreaterThanOrEqual(450);
    }
  });
  it.each(["noon", "amazon", "styli"] as const)("renders a cut shot on %s flush, compliant and not held", async id => {
    const source = id === "styli" ? cutModel({ width: 1600, height: 2400, border: 20 }) : cutModel();
    const output = await renderSource({ ...source, channel: id, shotNumber: 2, productType: "apparel_model" });
    expect(output.compliance.failures).toEqual([]);
    expect(output.status).toBe("ok");
    expect(output.flags).toContain("cut_in_source");
    const box = output.plan.productBox!;
    expect(box.y + box.h).toBe(output.plan.h);
    // The bottom canvas row is product colour where the cut is, not the margin grey.
    const raw = await sharp(output.jpeg!).raw().toBuffer({ resolveWithObject: true });
    const at = ((raw.info.height - 1) * raw.info.width + Math.round(box.x + box.w / 2)) * 3;
    expect(raw.data[at + 2]! - raw.data[at]!).toBeGreaterThan(60);
  });
  it("accepts the flush edge only on the cut side", async () => {
    const { matte } = cutModel(), shot = shotGeometry(matte.alpha, matte.width, matte.height)!;
    const plan = planCanvas(CHANNELS.noon, shot.box, shot.source, { cut: shot.cut }), box = plan.productBox!;
    const patch = await sharp({ create: { width: box.w, height: box.h, channels: 3, background: "#284682" } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: "#E0E0E0" } }).composite([{ input: patch, left: box.x, top: box.y }]).withDensity(72).withIccProfile("srgb").jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
    const args = { jpeg, channel: "noon" as const, shotNumber: 1, identifier: "cut", n: 1, publicObjectPath: "cut_1.jpg" };
    expect((await checkOutput({ ...args, plan })).failures).toEqual([]);
    const uncut = { ...plan, cut: { top: false, bottom: false, left: false, right: false } };
    expect((await checkOutput({ ...args, plan: uncut })).failures.some(f => f.startsWith("inside_safe_box:"))).toBe(true);
  });
});

describe("one canvas per product and channel", () => {
  it("gives every angle the largest canvas the formula gives any of them", async () => {
    const small = { box: { x: 0, y: 0, w: 400, h: 600 }, source: { w: 1000, h: 1000 } }, large = { box: { x: 0, y: 0, w: 600, h: 900 }, source: { w: 1000, h: 1000 } };
    const own = [small, large].map(s => planCanvas(CHANNELS.noon, s.box, s.source, {}));
    expect(own[0]!.w).toBeLessThan(own[1]!.w);
    const { canvas } = planProduct(CHANNELS.noon, [small, large]);
    expect(canvas).toEqual({ w: own[1]!.w, h: own[1]!.h });
    const raised = planCanvas(CHANNELS.noon, small.box, small.source, { canvas });
    expect([raised.w, raised.h]).toEqual([canvas.w, canvas.h]);
    expect(raised.lowResolution).toBe(own[0]!.lowResolution);
  });
  it("renders a shot on the product canvas", async () => {
    const source = cutModel({ border: 200 }), canvas = { w: 1080, h: 1480 };
    const output = await renderSource({ ...source, channel: "noon", shotNumber: 1, productType: "apparel_model", canvas });
    expect(output.compliance.failures).toEqual([]);
    expect([output.plan.w, output.plan.h]).toEqual([1080, 1480]);
  });
});

describe("shadow along a cut edge", () => {
  it("never synthesises a contact shadow under a bottom edge cut in the source", async () => {
    const output = await renderSource({ ...cutModel(), channel: "noon", shotNumber: 2, productType: "bag_accessory" });
    expect(output.flags).toContain("cut_in_source");
    expect(output.flags).not.toContain("shadow_synthesised");
    expect(output.compliance.failures).toEqual([]);
  });
  it("keeps a bag held by a hand cut at the left edge centred on Trendyol, with no synthesised shadow below it", async () => {
    // The French Connection bag shot 1: the hand holding the bag is cut by the photo's left edge.
    const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
    for (let y = 300; y < 800; y++) for (let x = 0; x < 380; x++) { const i = y * width + x; alpha[i] = 254; rgb.set([230, 110, 40], i * 3); }
    const prepared: Prepared = { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" };
    const matte: Matte = { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null };
    const output = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "bag_accessory" });
    expect(output.flags).toContain("cut_in_source");
    expect(output.flags).not.toContain("shadow_synthesised");
    const box = output.plan.productBox!;
    expect(Math.abs(box.y - (output.plan.h - box.y - box.h))).toBeLessThanOrEqual(1);
    // Nothing darker than the canvas below the bag: the gap under it equals the gap above it.
    const raw = await sharp(output.jpeg!).raw().toBuffer({ resolveWithObject: true });
    const below = ((box.y + box.h + 30) * raw.info.width + Math.round(box.x + box.w / 2)) * 3;
    expect(raw.data[below]!).toBeGreaterThanOrEqual(0xe0 - 3);
  });
});

// A photo cut on the given sides inside a 10 px white border (the French Connection and Anta close-ups): an
// opaque product `w` x `h` inside the border with a hard straight edge on every cut side; an uncut side is a wavy
// outline 60 px inside the border (a hem or a sleeve), so it never reads as a cut.
function photoCut(w: number, h: number, sides: Partial<Record<"top" | "bottom" | "left" | "right", boolean>>) {
  const border = 10, width = w + 2 * border, height = h + 2 * border, inset = (cut?: boolean, i = 0) => cut ? 0 : 60 + Math.round(20 * Math.sin(i / 200) ** 2);
  const rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  for (let y = border; y < border + h; y++) for (let x = border; x < border + w; x++) {
    if (x < border + inset(sides.left, y) || x >= border + w - inset(sides.right, y) || y < border + inset(sides.top, x) || y >= border + h - inset(sides.bottom, x)) continue;
    const i = y * width + x; alpha[i] = 254; rgb.set([40, 70, 140], i * 3);
  }
  const prepared: Prepared = { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" };
  const matte: Matte = { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null };
  return { prepared, matte };
}

describe("a product cut on both ends of an axis fills it", () => {
  const ALL = { top: true, bottom: true, left: true, right: true };
  it.each(["trendyol", "noon", "namshi"] as const)("renders a full-bleed photo wider than the %s canvas with no band beside any cut edge", async id => {
    // 780 x 1068 (FC Z02B shot 1) on 2:3 Trendyol and 1:1.37 Noon/Namshi: fitting left a 157 px (Trendyol) band above the top cut.
    const output = await renderSource({ ...photoCut(780, 1068, ALL), channel: id, shotNumber: 2, productType: "apparel_model" });
    expect(output.compliance.failures).toEqual([]);
    expect(output.flags).toContain("cut_in_source");
    expect(output.notes).toEqual([]);
    expect(output.plan.productBox).toEqual({ x: 0, y: 0, w: output.plan.w, h: output.plan.h });
    // Every canvas edge row and column is product colour, not the grey canvas.
    const raw = await sharp(output.jpeg!).raw().toBuffer({ resolveWithObject: true }), W = raw.info.width, H = raw.info.height;
    const blue = (x: number, y: number) => raw.data[(y * W + x) * 3 + 2]! - raw.data[(y * W + x) * 3]! > 60;
    for (const [x, y] of [[W >> 1, 0], [W >> 1, H - 1], [0, H >> 1], [W - 1, H >> 1]] as const) expect(blue(x, y), `${id} ${x},${y}`).toBe(true);
  });
  it("renders a square full-bleed close-up on the 2:3 Trendyol canvas flush top and bottom (Anta shots 4-5), trimming a third off its cut sides", () => {
    const box = { x: 0, y: 0, w: 800, h: 800 }, plan = planCanvas(CHANNELS.trendyol, box, { w: 800, h: 800 }, { cut: ALL });
    expect(plan.productBox).toEqual({ x: 0, y: 0, w: 1200, h: 1800 });
    expect(plan.sourceCrop).toEqual({ x: 133, y: 0, w: 533, h: 800 });
  });
  it("trims only the cut side when the other side of that axis is an uncut outline", () => {
    const box = { x: 10, y: 10, w: 780, h: 1068 }, cut = { top: true, bottom: true, left: true, right: false };
    const plan = planCanvas(CHANNELS.trendyol, box, { w: 800, h: 1200 }, { cut });
    expect(plan.productBox).toEqual({ x: 0, y: 0, w: 1200, h: 1800 });
    // All of the overflow comes off the left (cut); the right outline ends where it did.
    expect(plan.sourceCrop!.x + plan.sourceCrop!.w).toBe(box.x + box.w);
    expect(plan.sourceCrop!.x).toBeGreaterThan(box.x);
  });
  it("never trims an uncut outline: cut top and bottom only, it is fitted and the output says the top does not reach the edge", async () => {
    const source = photoCut(900, 1068, { top: true, bottom: true });
    const output = await renderSource({ ...source, channel: "trendyol", shotNumber: 2, productType: "apparel_model" });
    expect(output.compliance.failures).toEqual([]);
    expect(output.plan.cut).toEqual({ top: true, bottom: true, left: false, right: false });
    expect(output.plan.sourceCrop).toEqual(output.plan.sourceBox);
    expect(output.plan.productBox!.y + output.plan.productBox!.h).toBe(output.plan.h);
    expect(output.notes).toEqual(["The original photo is cut at the top, but on Trendyol the product cannot reach that edge of the image without trimming more of it, so a band shows there."]);
  });
  it("never trims more than a third: a very wide strip cut top and bottom is fitted", () => {
    const box = { x: 0, y: 0, w: 1200, h: 300 }, plan = planCanvas(CHANNELS.trendyol, box, { w: 1200, h: 300 }, { cut: ALL });
    expect(plan.sourceCrop).toEqual(box);
    expect(plan.productBox!.w).toBe(1200);
  });
  it("leaves an uncut product exactly as before: fitted, nothing trimmed", () => {
    const box = { x: 100, y: 100, w: 600, h: 900 };
    for (const id of ["noon", "namshi", "trendyol", "amazon", "styli"] as const) {
      const plan = planCanvas(CHANNELS[id], box, { w: 1000, h: 1200 }, {});
      expect(plan.sourceCrop, id).toEqual(box);
      expect(plan.scale, id).toBeCloseTo(Math.min(plan.safeBox.w / box.w, plan.safeBox.h / box.h), 12);
    }
  });
});

describe("the Trendyol canvas on a square full-bleed close-up a pixel off square", () => {
  const ALL = { top: true, bottom: true, left: true, right: true };
  it("fills the 2:3 canvas when the matte's soft edge makes the box 797 x 796 (Anta bd-152638122-2 shot 5)", () => {
    // 33.4% off the sides: just over a third, within CUT_FILL_TRIM_SLACK. Before the slack a 600 px band sat above the top cut.
    const box = { x: 2, y: 2, w: 797, h: 796 }, plan = planCanvas(CHANNELS.trendyol, box, { w: 800, h: 800 }, { cut: ALL });
    expect(plan.productBox).toEqual({ x: 0, y: 0, w: 1200, h: 1800 });
    expect(plan.trimBlocked).toEqual([]);
    expect(1 - plan.sourceCrop!.w / box.w).toBeGreaterThan(CUT_FILL_MAX_TRIM);
    expect(1 - plan.sourceCrop!.w / box.w).toBeLessThanOrEqual(CUT_FILL_MAX_TRIM + CUT_FILL_TRIM_SLACK);
  });
  it("still fits a box that needs clearly more than a third, and says a band shows", async () => {
    // 840 x 796 needs 36.8% off the sides on 2:3.
    const box = { x: 0, y: 0, w: 840, h: 796 }, plan = planCanvas(CHANNELS.trendyol, box, { w: 840, h: 796 }, { cut: ALL });
    expect(plan.sourceCrop).toEqual(box);
    expect(plan.productBox!.y).toBeGreaterThan(0);
    const output = await renderSource({ ...photoCut(840, 796, ALL), channel: "trendyol", shotNumber: 2, productType: "apparel_model" });
    expect(output.notes.join(" ")).toContain("The original photo is cut at the top, but on Trendyol the product cannot reach that edge");
  });
});

// An 800 x 800 (or 800 x `height`) close-up of dark fabric cut on all four sides (Anta bd-162637307S-2 shot 4), with soft
// folds and fine grain, optionally a white outlined logo whose box is `logo`, or a long white stripe down the frame.
function closeUp(opts: { height?: number; logo?: { x: number; y: number; w: number; h: number }; stripe?: boolean; cut?: Partial<Record<"top" | "bottom" | "left" | "right", boolean>> } = {}) {
  const width = 800, height = opts.height ?? 800, rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height, 255);
  const cut = { top: true, bottom: true, left: true, right: true, ...opts.cut };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // A fold: a slow light gradient (no sharp edge); grain: +-4 levels.
    const v = Math.round(35 + 25 * Math.sin((x + y) / 90) + ((x * 7 + y * 13) % 9) - 4);
    rgb.set([v, v, v + 4], (y * width + x) * 3);
  }
  // An uncut top or bottom: the product ends on a wavy hem 60 px inside the frame, on white.
  for (const side of ["top", "bottom"] as const) if (!cut[side]) for (let x = 0; x < width; x++) for (let d = 0; d < 60 + Math.round(15 * Math.sin(x / 70) ** 2); d++) { const y = side === "top" ? d : height - 1 - d, i = y * width + x; alpha[i] = 0; rgb.set([255, 255, 255], i * 3); }
  const paint = (x: number, y: number) => rgb.set([235, 235, 235], (y * width + x) * 3);
  if (opts.logo) {
    const { x: lx, y: ly, w: lw, h: lh } = opts.logo;
    for (let y = ly; y < ly + lh; y++) for (let x = lx; x < lx + lw; x++) if (x < lx + 4 || x >= lx + lw - 4 || y < ly + 4 || y >= ly + lh - 4 || Math.abs((x - lx) * lh - (y - ly) * lw) < 3 * lh) paint(x, y);
  }
  if (opts.stripe) for (let y = 0; y < height; y++) for (let x = 120; x < 132; x++) paint(x, y);
  const prepared: Prepared = { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" };
  const matte: Matte = { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null };
  return { prepared, matte };
}

describe("a cut-fill trim never cuts through a logo", () => {
  const LOGO = { x: 110, y: 470, w: 76, h: 120 };
  it("finds a compact high-contrast logo and nothing in soft folds, fine grain or a stripe across the frame", () => {
    const plain = closeUp(), box = { x: 0, y: 0, w: 800, h: 800 };
    expect(detailFeatures(plain.prepared.rgb, plain.matte.alpha, 800, box)).toEqual([]);
    const striped = closeUp({ stripe: true });
    expect(detailFeatures(striped.prepared.rgb, striped.matte.alpha, 800, box)).toEqual([]);
    const logo = closeUp({ logo: LOGO }), features = detailFeatures(logo.prepared.rgb, logo.matte.alpha, 800, box);
    expect(features).toHaveLength(1);
    const f = features[0]!;
    expect(f.x).toBeLessThanOrEqual(LOGO.x);
    expect(f.x + f.w).toBeGreaterThanOrEqual(LOGO.x + LOGO.w - 2);
    // The trim off the left stops short of the logo; nothing limits the right.
    const room = trimRoom(logo.prepared.rgb, logo.matte.alpha, 800, box);
    expect(room.left).toBeLessThan(LOGO.x);
    expect(room.right).toBeLessThan(800 - LOGO.x - LOGO.w);
    expect(room.right).toBeGreaterThan(560);
  });
  it("ignores a logo the frame already cuts", () => {
    const cutLogo = closeUp({ logo: { x: 0, y: 470, w: 76, h: 120 } }), box = { x: 0, y: 0, w: 800, h: 800 };
    expect(trimRoom(cutLogo.prepared.rgb, cutLogo.matte.alpha, 800, box)).toEqual({ top: 800, bottom: 800, left: 800, right: 800 });
  });
  it.each(["noon", "namshi", "trendyol"] as const)("on %s takes the trim off the other cut side and stays flush on every side", async id => {
    const source = closeUp({ logo: LOGO }), geometry = shotGeometry(source.matte.alpha, 800, 800, { rgb: source.prepared.rgb })!;
    expect(geometry.cut).toEqual({ top: true, bottom: true, left: true, right: true });
    const output = await renderSource({ ...source, channel: id, shotNumber: 2, productType: "apparel_model" });
    expect(output.compliance.failures).toEqual([]);
    expect(output.notes).toEqual([]);
    expect(output.plan.productBox).toEqual({ x: 0, y: 0, w: output.plan.w, h: output.plan.h });
    const crop = output.plan.sourceCrop!;
    // The whole logo is drawn, and the left loses less than an even split would take.
    expect(crop.x).toBeLessThan(LOGO.x);
    expect(crop.x).toBeLessThanOrEqual(geometry.trimRoom!.left);
    expect(crop.x).toBeLessThan((800 - crop.w) / 2);
    expect([crop.y, crop.h]).toEqual([0, 800]);
  });
  it("fits instead, with a truthful note, when the only cut side to trim holds the logo (French Connection Z02B2 shot 4)", async () => {
    // Uncut at the top (a hem), cut left, right and bottom; a logo near the bottom. A square canvas fills the width and would
    // trim the bottom through the logo: it is fitted, the uncut top is never trimmed, and the note names the band.
    const source = closeUp({ height: 1100, logo: { x: 300, y: 900, w: 120, h: 110 }, cut: { top: false } });
    const geometry = shotGeometry(source.matte.alpha, 800, 1100, { rgb: source.prepared.rgb })!;
    expect(geometry.cut).toEqual({ top: false, bottom: true, left: true, right: true });
    for (const id of ["amazon", "centrepoint"] as const) {
      const output = await renderSource({ ...source, channel: id, shotNumber: 2, productType: "bag_accessory" });
      expect(output.compliance.failures, id).toEqual([]);
      expect(output.plan.trimBlocked, id).toEqual(["bottom"]);
      expect(output.plan.sourceCrop, id).toEqual(geometry.box);
      expect(output.flags, id).toContain("cut_in_source");
      expect(output.notes, id).toEqual([`The original photo is cut at the left and right, but on ${CHANNELS[id].label} filling those edges would cut through a logo or detail near the bottom edge, so a band shows there to keep it whole.`]);
    }
    // Without the logo the same photo fills the square canvas, trimming the bottom only.
    const plain = closeUp({ height: 1100, cut: { top: false } }), output = await renderSource({ ...plain, channel: "amazon", shotNumber: 2, productType: "bag_accessory" });
    expect(output.plan.trimBlocked).toEqual([]);
    expect(output.plan.sourceCrop!.y).toBe(output.plan.sourceBox!.y);
    expect(output.plan.sourceCrop!.h).toBeLessThan(output.plan.sourceBox!.h);
  });
  it("plans the product canvas with the same room (planProduct)", () => {
    const source = closeUp({ height: 1100, logo: { x: 300, y: 900, w: 120, h: 110 }, cut: { top: false } });
    const geometry = shotGeometry(source.matte.alpha, 800, 1100, { rgb: source.prepared.rgb })!;
    expect(geometry.trimRoom!.bottom).toBeLessThan(1100 - 1010);
    const own = planCanvas(CHANNELS.amazon, geometry.box, geometry.source, { cut: geometry.cut, trimRoom: geometry.trimRoom });
    expect(planProduct(CHANNELS.amazon, [geometry]).canvas).toEqual({ w: own.w, h: own.h });
  });
});

describe("a cut-fill trim never takes a head, and never trims a pass-through (French Connection ZEE79259BBFD83FFA1DB0Z shot 5, eval run 2)", () => {
  // A 2:3 close-up cut on all four sides: on a square canvas filling the width needs a third of the height trimmed.
  const tall = () => closeUp({ height: 1200 });
  it("takes the whole trim off the bottom of a model photo; the top (the head) is never trimmed", async () => {
    for (const id of ["centrepoint", "amazon", "shein"] as const) {
      const output = await renderSource({ ...tall(), channel: id, shotNumber: 2, productType: "apparel_model" });
      expect(output.compliance.failures, id).toEqual([]);
      expect(output.plan.productBox, id).toEqual({ x: 0, y: 0, w: output.plan.w, h: output.plan.h });
      expect(output.plan.sourceCrop!.y, id).toBe(0);
      expect(output.plan.sourceCrop!.h, id).toBeLessThan(1200);
      expect(output.notes, id).toEqual([]);
    }
    // Any other product type still splits the trim between the two cut sides.
    const shoe = await renderSource({ ...tall(), channel: "centrepoint", shotNumber: 2, productType: "footwear" });
    expect(shoe.plan.sourceCrop!.y).toBeGreaterThan(0);
  });
  it("fits a model photo when the bottom alone cannot take the trim (a logo low down), with the plain band note", async () => {
    const source = closeUp({ height: 1200, logo: { x: 300, y: 1000, w: 120, h: 110 } });
    const output = await renderSource({ ...source, channel: "centrepoint", shotNumber: 2, productType: "apparel_model" });
    expect(output.plan.sourceCrop).toEqual(output.plan.sourceBox);
    expect(output.notes).toEqual(["The original photo is cut at the left and right, but on Centrepoint filling those edges would cut through a logo or detail near the bottom edge, so a band shows there to keep it whole."]);
  });
  it("never trims a pass-through or whole-photo matte: it is fitted with the band note", async () => {
    const source = tall(), matte: Matte = { ...source.matte, model: PASSTHROUGH_MODEL };
    expect(trimRules("footwear", matte)).toEqual({ noTrim: true, protectTop: false });
    const geometry = shotGeometry(matte.alpha, 800, 1200, { rgb: source.prepared.rgb, ...trimRules("footwear", matte) })!;
    expect(geometry.trimRoom).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    for (const productType of ["apparel_model", "footwear"] as const) {
      const output = await renderSource({ prepared: source.prepared, matte, channel: "amazon", shotNumber: 2, productType });
      expect(output.compliance.failures, productType).toEqual([]);
      expect(output.plan.sourceCrop, productType).toEqual(output.plan.sourceBox);
      expect(output.plan.productBox!.h, productType).toBe(output.plan.h);
      expect(output.notes, productType).toEqual(["The original photo is cut at the left and right, but on Amazon the product cannot reach that edge of the image without trimming more of it, so a band shows there."]);
    }
    // The product canvas is planned with the same rule.
    const own = planCanvas(CHANNELS.amazon, geometry.box, geometry.source, { cut: geometry.cut, trimRoom: geometry.trimRoom });
    expect(planProduct(CHANNELS.amazon, [geometry]).canvas).toEqual({ w: own.w, h: own.h });
  });
});
