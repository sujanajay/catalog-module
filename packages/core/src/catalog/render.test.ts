import { afterEach, describe, expect, it, vi } from "vitest";
import { bbox, planCanvas } from "./render";
import { CHANNELS } from "./channels";
import sharp from "sharp";
import { CHANNEL_IDS } from "./types";
import { prepare, renderSource, renderKeyInputs, planProduct, safeBoxFor, UnsupportedSourceError, visibleAnchorShift, NO_CUT, type Prepared, type Matte } from "./render";
import { checkOutput, BG_TOLERANCE } from "./compliance";
import { analyseBackground, preservedDarkness, shadowLayer, SHADOW_MAX_DARKNESS } from "./shadow";
import { contactSheet } from "./contact-sheet";
import type { Upscaler } from "./upscale";

function fixture(width = 800, height = 800, box = { x: 200, y: 200, w: 400, h: 400 }): { prepared: Prepared; matte: Matte } {
  const rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) { const i = y * width + x; rgb[i * 3] = 160; rgb[i * 3 + 1] = 30; rgb[i * 3 + 2] = 50; alpha[i] = 255; }
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/png" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}

describe("render geometry", () => {
  it("delivers Trendyol at exactly its accepted 1200x1800, flagging a small source as information", () => {
    const plan = planCanvas(CHANNELS.trendyol, { x: 0, y: 0, w: 100, h: 100 }, { w: 100, h: 100 }, {});
    expect([plan.w, plan.h]).toEqual([1200, 1800]);
    expect(plan.lowResolution).toBe(true);
    expect(plan.scale).toBe(12);
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
  it("tells the truth about Trendyol's size: its minimum, the size we deliver, and that the photo was enlarged", async () => {
    const output = await renderSource({ ...fixture(300, 300, { x: 100, y: 100, w: 100, h: 100 }), channel: "trendyol", shotNumber: 1, productType: "apparel_model" });
    expect(output.status).toBe("ok"); expect(output.flags).toContain("low_resolution");
    expect(output.attention!.why).toBe("The original is 300 x 300. Trendyol images are delivered at 1200 x 1800, so this one was enlarged and may look soft.");
    expect(output.attention!.why).not.toContain("wants at least");
    expect(output.attention!.what).toBe("It will upload, but ask the brand for a larger photo if you can. The other marketplaces are fine with it.");
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

describe("Styli judged on the upscaled size", () => {
  /** A fake x2 upscaler answering a solid colour JPEG of exactly twice the sent image; `fail` makes every call throw. */
  const fakeUpscaler = (fail = false): Upscaler & { calls: number } => {
    const up = { model: "fake-x2", minScale: 1.5, calls: 0, async upscale(image: Buffer) {
      up.calls++;
      if (fail) throw new Error("down");
      const meta = await sharp(image).metadata();
      return { jpeg: await sharp({ create: { width: meta.width! * 2, height: meta.height! * 2, channels: 3, background: { r: 160, g: 30, b: 50 } } }).jpeg({ quality: 95 }).toBuffer(), ms: 1 };
    } };
    return up;
  };
  // An 800x1200 photo whose product needs 2.47x on Styli: over the 1.5x cap alone, 1.24x after the x2 upscale.
  const medium = () => fixture(800, 1200, { x: 150, y: 150, w: 500, h: 900 });
  const quiet = () => { vi.spyOn(console, "info").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); };
  afterEach(() => vi.restoreAllMocks());

  it("makes an 800x1200 photo for Styli with the upscaler, flagged upscaled", async () => {
    quiet();
    const upscaler = fakeUpscaler(), output = await renderSource({ ...medium(), channel: "styli", shotNumber: 2, productType: "apparel_model", upscaler });
    expect(output.status).toBe("ok"); expect(output.jpeg).not.toBeNull();
    expect(output.flags).toContain("upscaled"); expect(output.flags).not.toContain("cut_in_source");
    expect(upscaler.calls).toBe(1);
    expect(output.notes).not.toContain("Skipped for Styli: the photo is smaller than Styli needs.");
  });
  it("skips the same photo for Styli without the upscaler, with the agreed note", async () => {
    const output = await renderSource({ ...medium(), channel: "styli", shotNumber: 2, productType: "apparel_model" });
    expect(output.status).toBe("skipped"); expect(output.jpeg).toBeNull();
    expect(output.notes).toEqual(["Skipped for Styli: the photo is smaller than Styli needs."]);
  });
  it("still makes it when the upscale call fails at render time, flagged low_resolution with the soft note", async () => {
    quiet();
    const output = await renderSource({ ...medium(), channel: "styli", shotNumber: 2, productType: "apparel_model", upscaler: fakeUpscaler(true) });
    expect(output.status).toBe("ok"); expect(output.flags).toContain("low_resolution"); expect(output.flags).not.toContain("upscaled");
    expect(output.attention?.why).toMatch(/may look soft/);
  });
  it("still skips a 400x600 photo for Styli with the upscaler", async () => {
    const upscaler = fakeUpscaler(), output = await renderSource({ ...fixture(400, 600, { x: 75, y: 75, w: 250, h: 450 }), channel: "styli", shotNumber: 2, productType: "apparel_model", upscaler });
    expect(output.status).toBe("skipped"); expect(output.notes).toEqual(["Skipped for Styli: the photo is smaller than Styli needs."]);
    expect(output.flags).not.toContain("cut_in_source"); expect(upscaler.calls).toBe(0);
  });

  // The D4 live check (batch 29d25c7b, five 800x1200 Penti photos): every Styli output failed styli_anchor once the
  // x2 upscaler let them through. A model matte fades out over a pixel or two; enlarged about 2x on Styli that fade is
  // several canvas px of alpha above the box threshold that look like the grey canvas, so the product that is seen
  // stood above the guide and off centre. A dark coat with a soft one-pixel matte edge, a near-white cuff on its left
  // (barely visible on #E0E0E0) and anti-aliased source colours, as a camera and a matting model give them.
  const softSilhouette = (): { prepared: Prepared; matte: Matte } => {
    const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
    const coverage = (x: number, y: number, cx: number, cy: number, ax: number, ay: number) => Math.max(0, Math.min(1, 0.5 + (1 - Math.hypot((x - cx) / ax, (y - cy) / ay)) * Math.min(ax, ay)));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const coat = coverage(x, y, 410, 615, 170, 555), cuff = coverage(x, y, 250, 640, 30, 45), a = Math.max(coat, cuff), i = y * width + x;
      const colour = coat >= cuff ? [30, 30, 35] : [250, 248, 244];
      alpha[i] = Math.round(a * 255);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(colour[c]! * a + 255 * (1 - a));
    }
    return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "gpu", sentLongSide: null } };
  };
  /** A real x2 enlargement (Lanczos3) of the photo the render sends, as the service returns it. */
  const lanczosUpscaler = (): Upscaler => ({ model: "fake-x2", minScale: 1.5, async upscale(image: Buffer) {
    const meta = await sharp(image).metadata();
    return { jpeg: await sharp(image).resize(meta.width! * 2, meta.height! * 2, { kernel: "lanczos3" }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer(), ms: 1 };
  } });
  it("puts an upscaled 800x1200 photo's visible product on the Styli bottom guide, centred", async () => {
    quiet();
    const output = await renderSource({ ...softSilhouette(), channel: "styli", shotNumber: 2, productType: "apparel_model", upscaler: lanczosUpscaler() });
    expect(output.flags).toContain("upscaled"); expect(output.plan.scale).toBeGreaterThan(1.5);
    expect(output.compliance.failures).toEqual([]); expect(output.status).toBe("ok");
    // The compliance check run again on the delivered JPEG agrees.
    const check = await checkOutput({ jpeg: output.jpeg!, channel: "styli", shotNumber: 2, plan: output.plan, identifier: "coat", n: 2, publicObjectPath: "coat_2.jpg" });
    expect(check.failures).toEqual([]);
  });
  it("keeps the same photo on the guide on the plain path when the upscale call fails", async () => {
    quiet();
    const output = await renderSource({ ...softSilhouette(), channel: "styli", shotNumber: 2, productType: "apparel_model", upscaler: { ...lanczosUpscaler(), async upscale() { throw new Error("down"); } } });
    expect(output.flags).not.toContain("upscaled"); expect(output.compliance.failures).toEqual([]); expect(output.status).toBe("ok");
  });
  it("never lifts or moves a source cut at the bottom off the canvas edge", async () => {
    quiet();
    // The same coat cut by the frame at the bottom (a model cut mid-shin): its cut edge stays flush with the canvas bottom.
    const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = Math.max(0, Math.min(1, 0.5 + (1 - Math.hypot((x - 410) / 170, (y - 900) / 850)) * 170)), i = y * width + x;
      alpha[i] = Math.round(a * 255);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(30 * a + 255 * (1 - a));
    }
    const source = { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model" as const, target: "gpu" as const, sentLongSide: null } };
    const output = await renderSource({ ...source, channel: "styli", shotNumber: 2, productType: "apparel_model", upscaler: lanczosUpscaler() });
    expect(output.flags).toContain("cut_in_source"); expect(output.plan.cut?.bottom).toBe(true);
    expect(output.plan.productBox!.y + output.plan.productBox!.h).toBe(output.plan.h);
    expect(output.compliance.failures).toEqual([]); expect(output.status).toBe("ok");
    // Directly: a bottom (or top) cut never moves vertically, whatever the fade shows; a side cut never moves sideways.
    const raw = Buffer.alloc(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i++) { raw.fill(30, i * 4, i * 4 + 3); raw[i * 4 + 3] = i < 30 * 40 ? 255 : 20; }
    const fade = await sharp(raw, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
    const box = { x: 1000, y: 3083, w: 40, h: 40 }, safe = { x: 150, y: 450, w: 2042, h: 2673 }, canvas = { w: 2342, h: 3123 };
    expect((await visibleAnchorShift(fade, box, safe, canvas, [224, 224, 224], { ...NO_CUT, bottom: true }, 2)).dy).toBe(0);
    expect((await visibleAnchorShift(fade, { ...box, x: 0 }, safe, canvas, [224, 224, 224], { ...NO_CUT, left: true }, 2)).dx).toBe(0);
  });
  it("does not move a product that is barely seen on the grey canvas; the check holds it as before", async () => {
    quiet();
    // A pale grey shirt (#EAEAEA, under BG_TOLERANCE from #E0E0E0) with a dark logo high on its left chest.
    const width = 800, height = 1200, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
    for (let y = 100; y < 1100; y++) for (let x = 250; x < 550; x++) {
      const i = y * width + x, logo = x >= 300 && x < 360 && y >= 250 && y < 300;
      alpha[i] = 255; rgb.fill(logo ? 20 : 234, i * 3, i * 3 + 3);
    }
    const source = { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/jpeg" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model" as const, target: "gpu" as const, sentLongSide: null } };
    const output = await renderSource({ ...source, channel: "styli", shotNumber: 2, productType: "apparel_flat", upscaler: lanczosUpscaler() });
    const planned = planCanvas(CHANNELS.styli, { x: 250, y: 100, w: 300, h: 1000 }, { w: width, h: height }, {});
    expect(output.plan.productBox).toEqual(planned.productBox);
    expect(output.compliance.failures.some(f => f.startsWith("styli_anchor:"))).toBe(true); expect(output.status).toBe("failed");
    // Nothing seen at all (the whole cut-out the canvas grey): no move.
    const blank = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 224, g: 224, b: 224, alpha: 1 } } }).png().toBuffer();
    expect(await visibleAnchorShift(blank, { x: 1000, y: 2633, w: 40, h: 40 }, { x: 150, y: 450, w: 2042, h: 2223 }, { w: 2342, h: 3123 }, [224, 224, 224], NO_CUT, 2)).toEqual({ dx: 0, dy: 0 });
  });
  it("keeps a moved cut-out on the canvas with what is seen inside the safe box, for a product as tall as the safe box", async () => {
    // A dark product filling the safe box height, its last 6 rows a faint fade: it moves down only into the margin.
    const w = 600, h = 2223, raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; raw[i] = raw[i + 1] = raw[i + 2] = 30; raw[i + 3] = y < h - 6 ? 255 : 20; }
    const cutout = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const product = { x: 870, y: 450, w, h }, safe = { x: 150, y: 450, w: 2042, h: 2223 }, canvas = { w: 2342, h: 3123 };
    const { dx, dy } = await visibleAnchorShift(cutout, product, safe, canvas, [224, 224, 224], NO_CUT, 2);
    expect(dy).toBe(5); expect(dx).toBe(1);
    expect(product.y + dy).toBeGreaterThanOrEqual(safe.y); expect(product.y + dy + h).toBeLessThanOrEqual(canvas.h);
    expect(product.y + dy + (h - 6)).toBeLessThanOrEqual(safe.y + safe.h);
  });
});
