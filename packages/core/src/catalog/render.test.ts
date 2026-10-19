import { describe, expect, it } from "vitest";
import { bbox, planCanvas } from "./render";
import { CHANNELS } from "./channels";
import sharp from "sharp";
import { CHANNEL_IDS } from "./types";
import { prepare, renderSource, renderKeyInputs, planProduct, safeBoxFor, UnsupportedSourceError, type Prepared, type Matte } from "./render";
import { checkOutput, BG_TOLERANCE } from "./compliance";
import { analyseBackground, preservedDarkness, shadowLayer, SHADOW_MAX_DARKNESS } from "./shadow";
import { contactSheet } from "./contact-sheet";

function fixture(width = 800, height = 800, box = { x: 200, y: 200, w: 400, h: 400 }): { prepared: Prepared; matte: Matte } {
  const rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) { const i = y * width + x; rgb[i * 3] = 160; rgb[i * 3 + 1] = 30; rgb[i * 3 + 2] = 50; alpha[i] = 255; }
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/png" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}

describe("render geometry", () => {
  it("keeps the target aspect while satisfying both Trendyol minima", () => {
    const plan = planCanvas(CHANNELS.trendyol, { x: 0, y: 0, w: 100, h: 100 }, { w: 100, h: 100 }, {});
    expect([plan.w, plan.h]).toEqual([600, 900]);
    expect(plan.lowResolution).toBe(true);
  });
  it("preserves the exact odd Styli height", () => {
    expect(planCanvas(CHANNELS.styli, { x: 0, y: 0, w: 2000, h: 2400 }, { w: 3000, h: 3000 }, {}).h).toBe(3123);
  });
  it("finds the tight alpha box above the threshold", () => {
    expect(bbox(Buffer.from([0, 0, 0, 0, 255, 0]), 3, 2)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(bbox(Buffer.alloc(6), 3, 2)).toBeNull();
  });
  it.each(CHANNEL_IDS)("keeps %s geometry and fits tall, wide and detail shots", id => {
    for (const side of [300, 533, 800, 1237, 2800]) for (const box of [{ x: 0, y: 0, w: side / 2, h: side }, { x: 0, y: 0, w: side, h: side / 3 }]) {
      const spec = CHANNELS[id], plan = planCanvas(spec, box, { w: side * 2, h: side * 2 }, {});
      expect(plan.w).toBeGreaterThanOrEqual(spec.minCanvas.w); expect(plan.h).toBeGreaterThanOrEqual(spec.minCanvas.h);
      expect(Math.abs(plan.h - plan.w * spec.targetCanvas.h / spec.targetCanvas.w)).toBeLessThanOrEqual(1);
      expect(plan.productBox!.x).toBeGreaterThanOrEqual(plan.safeBox.x);
      expect(plan.productBox!.y + plan.productBox!.h).toBeLessThanOrEqual(plan.safeBox.y + plan.safeBox.h);
      if (!spec.fixedCanvas) { expect(plan.w % 2).toBe(0); expect(plan.h % 2).toBe(0); }
      if (!plan.lowResolution && !spec.fixedCanvas) expect(plan.scale).toBeLessThanOrEqual(1.5);
    }
  });
  it("uses Noon side guides only for wide products", () => {
    expect(safeBoxFor(CHANNELS.noon, { w: 1000, h: 1400 }, false).x).toBe(0);
    expect(safeBoxFor(CHANNELS.noon, { w: 1000, h: 1400 }, true).x).toBe(50);
  });
  it("excludes detail angles from uniform scale and never forces cropping", () => {
    const shots = [{ box: { x: 0, y: 0, w: 1000, h: 2000 }, source: { w: 3000, h: 3000 } }, { box: { x: 0, y: 0, w: 1500, h: 2400 }, source: { w: 3000, h: 3000 } }];
    const expected = Math.min(...shots.map(s => planCanvas(CHANNELS.styli, s.box, s.source, {}).scale));
    expect(planProduct(CHANNELS.styli, [...shots, { box: { x: 0, y: 0, w: 30, h: 30 }, source: { w: 30, h: 30 } }]).uniformScale).toBe(expected);
    expect(expected).toBe(2223 / 2400);
    expect(planCanvas(CHANNELS.styli, shots[0]!.box, shots[0]!.source, { uniformScale: 100 }).scale).toBeLessThan(100);
  });
});

describe("prepare", () => {
  it("uses PNG transparency and identifies small sources", async () => {
    const png = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const p = await prepare(png, "alpha.png", async b => b);
    expect(p.flags).toEqual(["alpha_source", "small_source"]); expect(p.alphaSource![0]).toBeLessThan(255); expect(p.rgb.length).toBe(400 * 200 * 3);
  });
  it("auto-orients a JPEG and converts CMYK into RGB", async () => {
    const jpg = await sharp({ create: { width: 60, height: 100, channels: 3, background: "red" } }).toColourspace("cmyk").withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const p = await prepare(jpg, "rotated.jpg", async b => b);
    expect([p.width, p.height]).toEqual([100, 60]); expect(p.rgb.length).toBe(100 * 60 * 3); expect(p.alphaSource).toBeNull();
  });
  it("decodes AVIF and the first GIF frame", async () => {
    const image = sharp({ create: { width: 20, height: 30, channels: 3, background: "blue" } });
    for (const bytes of [await image.clone().avif().toBuffer(), await image.clone().gif().toBuffer()]) expect((await prepare(bytes, "image", async b => b)).height).toBe(30);
  });
  it("converts a sniffed HEIC through the injected converter", async () => {
    const header = Buffer.alloc(28); header.writeUInt32BE(28); header.write("ftypheic", 4); header.write("heicmif1", 16);
    let called = false;
    const p = await prepare(header, "a.heic", async () => { called = true; return sharp({ create: { width: 20, height: 30, channels: 3, background: "white" } }).png().toBuffer(); });
    expect(called).toBe(true); expect(p.sourceMime).toBe("image/heic");
  });
  it("reports BMP, unknown and corrupt inputs without crashing a batch", async () => {
    await expect(prepare(Buffer.from("BMbad"), "bad.bmp", async b => b)).rejects.toThrow("bad.bmp is a BMP file. Save it as JPEG or PNG and add it again.");
    await expect(prepare(Buffer.from("garbage"), "bad.png", async b => b)).rejects.toBeInstanceOf(UnsupportedSourceError);
  });
});

describe("render and encoded compliance", () => {
  it.each(CHANNEL_IDS)("renders %s shots 1 and 2, skipping small Styli", async id => {
    const source = fixture();
    for (const shotNumber of [1, 2]) {
      const output = await renderSource({ ...source, channel: id, shotNumber, productType: "apparel_model" });
      if (id === "styli") { expect(output.status).toBe("skipped"); expect(output.jpeg).toBeNull(); }
      else { expect(output.compliance.failures).toEqual([]); expect(output.status).toBe("ok"); }
    }
  });
  it("anchors high-resolution Styli on its exact bottom guide", async () => {
    const output = await renderSource({ ...fixture(2000, 2400, { x: 700, y: 200, w: 600, h: 1800 }), channel: "styli", shotNumber: 1, productType: "apparel_model" });
    expect(output.compliance.failures).toEqual([]); expect(output.status).toBe("ok");
    expect(output.plan.productBox!.y + output.plan.productBox!.h).toBe(2673);
  });
  it("gives soft-source attention sentences and a stable render key", async () => {
    const output = await renderSource({ ...fixture(300, 300, { x: 100, y: 100, w: 100, h: 100 }), channel: "noon", shotNumber: 1, productType: "apparel_model" });
    expect(output.status).toBe("ok"); expect(output.attention!.why).toContain("300 x 300. Noon wants at least 900 px");
    expect(renderKeyInputs({ sourceSha256: "abc", channel: "noon", rulesVersion: "1", policyId: "p", policyUpdatedAt: "now", n: 2 })).toBe("abc|noon|1|p+now|2");
  });
  it("fails an empty matte with the source sentence", async () => {
    const source = fixture(); source.matte.alpha.fill(0);
    expect((await renderSource({ ...source, channel: "noon", shotNumber: 1, productType: "other" })).notes).toContain("No product was found in this photo.");
  });
  it("catches wrong backgrounds, format, density, paths and dimensions independently", async () => {
    const source = fixture(), plan = planCanvas(CHANNELS.noon, { x: 200, y: 200, w: 400, h: 400 }, { w: 800, h: 800 }, {});
    const jpeg = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: "#FFFFFF" } }).withDensity(96).jpeg({ chromaSubsampling: "4:2:0" }).toBuffer();
    const check = await checkOutput({ jpeg, channel: "noon", shotNumber: 1, plan: { ...plan, w: plan.w + 1 }, identifier: "a", n: 1, publicObjectPath: "space here.JPG" });
    for (const code of ["format", "dims", "density", "background", "inside_safe_box", "trendyol_name", "extension"]) expect(check.failures.some(f => f.startsWith(code + ":")), code).toBe(true);
    expect(source.prepared.width).toBe(800);
  });
  it("accepts foreground on zero-margin edges", async () => {
    const output = await renderSource({ ...fixture(800, 800, { x: 0, y: 100, w: 800, h: 600 }), channel: "amazon", shotNumber: 1, productType: "apparel_flat" });
    expect(output.status).toBe("ok"); expect(output.plan.productBox!.x).toBe(0);
  });
  it("bounds JPEG round-trip background error at quality 70", async () => {
    for (const color of [224, 255]) {
      const jpeg = await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: color, g: color, b: color } } }).jpeg({ quality: 70, chromaSubsampling: "4:4:4" }).toBuffer();
      const raw = await sharp(jpeg).raw().toBuffer(); expect(Math.max(...raw.map(v => Math.abs(v - color)))).toBeLessThanOrEqual(BG_TOLERANCE);
    }
  });
  it("bounds quality-90 high-contrast edge ringing without hiding white products", async () => {
    const rgb = Buffer.alloc(80 * 80 * 3, 224);
    for (let y = 17; y < 57; y++) for (let x = 17; x < 57; x++) { const i = (y * 80 + x) * 3; rgb[i] = 160; rgb[i + 1] = 30; rgb[i + 2] = 50; }
    const jpeg = await sharp(rgb, { raw: { width: 80, height: 80, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
    const raw = await sharp(jpeg).raw().toBuffer(); let max = 0;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if (!(x >= 17 && x < 57 && y >= 17 && y < 57)) for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(raw[(y * 80 + x) * 3 + c]! - 224));
    expect(max).toBeLessThanOrEqual(BG_TOLERANCE); expect(BG_TOLERANCE).toBeLessThan(31);
  });
  it("re-encodes already compliant JPEG pixels without repositioning", async () => {
    const source = fixture(1000, 1000, { x: 200, y: 200, w: 600, h: 600 });
    const original = await sharp(source.prepared.rgb, { raw: { width: 1000, height: 1000, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    source.prepared = await prepare(original, "ready.jpg", async b => b);
    const output = await renderSource({ ...source, channel: "amazon", shotNumber: 1, productType: "apparel_flat" });
    expect(output.flags).toContain("passthrough"); expect(output.status).toBe("ok"); expect(output.plan.productBox).toEqual({ x: 200, y: 200, w: 600, h: 600 });
    const raw = await sharp(output.jpeg!).raw().toBuffer(); expect(Math.abs(raw[(500 * 1000 + 500) * 3]! - source.prepared.rgb[(500 * 1000 + 500) * 3]!)).toBeLessThanOrEqual(BG_TOLERANCE);
  });
  it("detects a shifted white product in a required margin and a wrong Styli anchor", async () => {
    const plan = planCanvas(CHANNELS.styli, { x: 700, y: 200, w: 600, h: 1800 }, { w: 2000, h: 2400 }, {}), box = plan.productBox!;
    const patch = await sharp({ create: { width: box.w, height: box.h, channels: 3, background: "white" } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: "#E0E0E0" } }).composite([{ input: patch, left: box.x, top: box.y + 10 }]).withDensity(300).withIccProfile("srgb").jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
    const check = await checkOutput({ jpeg, channel: "styli", shotNumber: 1, plan, identifier: "white", n: 1, publicObjectPath: "white_1.jpg" });
    for (const code of ["background", "inside_safe_box", "styli_anchor"]) expect(check.failures.some(f => f.startsWith(code + ":"))).toBe(true);
  });
  it("detects Noon wide side violations and malformed magic", async () => {
    const plan = planCanvas(CHANNELS.noon, { x: 100, y: 200, w: 600, h: 200 }, { w: 800, h: 800 }, {});
    const jpeg = await sharp({ create: { width: plan.w, height: plan.h, channels: 3, background: "red" } }).withDensity(72).withIccProfile("srgb").jpeg({ chromaSubsampling: "4:4:4" }).toBuffer();
    const args = { channel: "noon" as const, shotNumber: 1, plan, identifier: "a", n: 1, publicObjectPath: "a_1.jpg" };
    expect((await checkOutput({ ...args, jpeg })).failures.some(f => f.startsWith("noon_wide:"))).toBe(true);
    expect((await checkOutput({ ...args, jpeg: Buffer.from("not JPEG") })).failures.some(f => f.startsWith("magic:"))).toBe(true);
  });
  it("steps quality to the floor and reports an identifier-specific byte failure", async () => {
    const source = fixture(3000, 3000, { x: 0, y: 0, w: 3000, h: 3000 });
    let state = 7;
    for (let i = 0; i < source.prepared.rgb.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) | 0; source.prepared.rgb[i] = state >>> 24; }
    source.prepared.background.uniform = false;
    const output = await renderSource({ ...source, channel: "centrepoint", shotNumber: 2, identifier: "NOISE", productType: "apparel_flat" });
    expect(output.status).toBe("failed"); expect(output.jpeg).toBeNull(); expect(output.quality).toBe(70); expect(output.bytes).toBeGreaterThan(2_000_000);
    expect(output.notes).toContain("bytes: Could not get NOISE_2 for centrepoint under 2 MB.");
  });
  it("encodes deterministic bytes on repeat", async () => {
    const input = { ...fixture(), channel: "noon" as const, shotNumber: 1, productType: "footwear" as const };
    const a = await renderSource(input), b = await renderSource(input);
    expect(a.status).toBe("ok"); expect(a.jpeg).toEqual(b.jpeg);
  });
  it("creates contact-sheet JPEGs including escaped labels", async () => {
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).jpeg().toBuffer();
    expect((await sharp(await contactSheet([{ jpeg, label: "A <B> & C" }], 3)).metadata()).format).toBe("jpeg");
  });
});

describe("shadow decisions", () => {
  it("preserves only a contact-connected component and clamps darkness", () => {
    const { prepared, matte } = fixture(100, 100, { x: 30, y: 30, w: 40, h: 40 });
    for (let y = 70; y < 78; y++) for (let x = 35; x < 65; x++) prepared.rgb.fill(0, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
    prepared.rgb.fill(0, 0, 15);
    const dark = preservedDarkness(prepared, matte, { x: 30, y: 30, w: 40, h: 40 }, "footwear")!;
    expect(dark[71 * 100 + 40]).toBe(Math.round(SHADOW_MAX_DARKNESS * 255)); expect(dark[0]).toBe(0); expect(dark[50 * 100 + 50]).toBe(0);
  });
  it("synthesises footwear but never apparel for alpha sources", async () => {
    const source = fixture(); source.matte.source = "alpha_source";
    const box = { x: 200, y: 200, w: 400, h: 400 }, plan = planCanvas(CHANNELS.noon, box, { w: 800, h: 800 }, {});
    expect((await shadowLayer(source.prepared, source.matte, box, plan, "footwear", "#E0E0E0")).flags).toEqual(["shadow_synthesised"]);
    expect((await shadowLayer(source.prepared, source.matte, box, plan, "apparel_flat", "#E0E0E0")).flags).toEqual(["no_shadow_source"]);
  });
});
