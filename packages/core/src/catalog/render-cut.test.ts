import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "./channels";
import { checkOutput } from "./compliance";
import { NO_CUT, planCanvas, planProduct, renderSource, shotGeometry, type Matte, type Prepared } from "./render";
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
