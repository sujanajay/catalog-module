import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "./channels";
import { checkOutput } from "./compliance";
import { planCanvas, planProduct, renderSource, shotGeometry, type Matte, type Prepared } from "./render";
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

describe("cut in source", () => {
  it("finds a straight opaque cut inside the white border and trims the matte's fade beyond it", () => {
    const { matte } = cutModel(), shot = shotGeometry(matte.alpha, matte.width, matte.height)!;
    expect(shot.cut).toEqual({ top: false, bottom: true, left: false, right: false });
    expect(shot.box).toEqual({ x: 250, y: 300, w: 300, h: 1185 - 300 + 1 });
  });
  it("ignores products with room around them and runs shorter than a quarter of the box", () => {
    const framed = cutModel({ border: 200 }).matte;
    expect(shotGeometry(framed.alpha, framed.width, framed.height)!.cut).toEqual({ top: false, bottom: false, left: false, right: false });
    const leg = cutModel({ legWidth: 60 }).matte; // 60 px of a 300 px box: 20%
    expect(shotGeometry(leg.alpha, leg.width, leg.height)!.cut.bottom).toBe(false);
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
