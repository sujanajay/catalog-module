import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { MattingClient, parseUpscaleHealth } from "./matte";
import { enlargementFactors, enlargementNeeds, planCanvas, planProduct, renderKeyInputs, renderSource, shotEnlargementRegion, shotGeometry, trimRules, type Matte, type Prepared } from "./render";
import { analyseBackground } from "./shadow";
import { enlargeCutout } from "./enhance";
import { DEFAULT_UPSCALE_MAX_PIXELS, DEFAULT_UPSCALE_MIN_SCALE, enlargeRegion, ENLARGE_REGION_MARGIN_PX, formatRegion, gpuUrlsFromEnv, hasSourceX2, LEGACY_UPSCALE_MIN_SCALE, parseRegion, UPSCALE_X4_MIN_SCALE, upscaleFactorFor, upscaleMaxPixels, upscalerFactor, upscalersFor, otherTargetUpscalerId, primeSourceX2, shouldUpscale, sourceX2, storedUpscaler, StoredEnlargementMissingError, upscaleConfigFromEnv, upscaledRgb, upscalerId, upscalerKey, upscaleTargetFromEnv, UPSCALER_VERSION, type Upscaler } from "./upscale";
import { configuredUpscalerId, renderKey, renderKeys, rerenderedKey, upscaledRenderKey } from "./pipeline/publish";
import { upscaledNotes } from "./pipeline/report";
import { flagDetails } from "./qa/reasons";
import { holdsAtRender, INFORMATION_FLAGS } from "./qa/triage";
import { INFORMATION_FLAGS as EVAL_INFORMATION_FLAGS } from "./evals/attention";
import { RENDER_FLAGS } from "./auto-resolve";
import { ENLARGEMENT_FAILED_SENTENCE, flagReason, UPSCALED_SENTENCE } from "./types";

const MODEL = "swinir-x2", MODEL_X4 = "swinir-x4";
/** An 800x1200 photo with a 400x600 product: Trendyol (exactly 1200x1800) enlarges it 3x. */
function fixture(width = 800, height = 1200, box = { x: 200, y: 300, w: 400, h: 600 }): { prepared: Prepared; matte: Matte } {
  const rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = y * width + x; rgb[i * 3] = 160; rgb[i * 3 + 1] = 30; rgb[i * 3 + 2] = 50;
    // A soft left edge, so the alpha has more than two values.
    alpha[i] = x - box.x < 8 ? 64 + 24 * (x - box.x) : 255;
  }
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/png" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}
/** A fake upscaler answering a solid green JPEG of exactly `factor` times the sent image. */
function fakeUpscaler(factor = 2, fail?: Error, model = MODEL, serves: 2 | 4 = 2): Upscaler & { calls: { w: number; h: number; type: string }[] } {
  const calls: { w: number; h: number; type: string }[] = [];
  return { model, minScale: DEFAULT_UPSCALE_MIN_SCALE, factor: serves, calls, async upscale(image, type) {
    const meta = await sharp(image).metadata(); calls.push({ w: meta.width!, h: meta.height!, type });
    if (fail) throw fail;
    return { jpeg: await sharp({ create: { width: meta.width! * factor, height: meta.height! * factor, channels: 3, background: { r: 0, g: 200, b: 0 } } }).jpeg({ quality: 95 }).toBuffer(), ms: 42 };
  } };
}
const pixel = async (jpeg: Buffer, x: number, y: number) => { const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * info.channels; return [data[i]!, data[i + 1]!, data[i + 2]!]; };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => undefined); warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe("upscale decision", () => {
  it("is off unless UPSCALE_MODEL names a model, with a 1.0 default threshold (spec 18 quality: every enlargement)", () => {
    expect(DEFAULT_UPSCALE_MIN_SCALE).toBe(1);
    expect(upscaleConfigFromEnv({})).toEqual({ model: null, x4Model: null, minScale: 1 });
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: "  ", UPSCALE_MIN_SCALE: "" })).toEqual({ model: null, x4Model: null, minScale: 1 });
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MIN_SCALE: "1.8" })).toEqual({ model: MODEL, x4Model: null, minScale: 1.8 });
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MIN_SCALE: "0.5" }).minScale).toBe(1);
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MIN_SCALE: "abc" }).minScale).toBe(1);
    // The x4 model only rides with an x2 model; "off" or empty is none.
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MODEL_X4: MODEL_X4 }).x4Model).toBe(MODEL_X4);
    for (const x4 of ["off", " ", ""]) expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MODEL_X4: x4 }).x4Model).toBeNull();
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL_X4: MODEL_X4 }).x4Model).toBeNull();
  });
  it("triggers only above the threshold, never at it", () => {
    expect(shouldUpscale(1.5, 1.5)).toBe(false);
    expect(shouldUpscale(1.5000001, 1.5)).toBe(true);
    expect(shouldUpscale(3, 1.5)).toBe(true);
    expect(shouldUpscale(1.2, 1.5)).toBe(false);
    expect(shouldUpscale(Infinity, 1.5)).toBe(false);
  });
  it("triggers on an exact-size channel enlarging an 800x1200 photo, never on a capped variable canvas", () => {
    const trendyol = planCanvas(CHANNELS.trendyol, { x: 200, y: 300, w: 400, h: 600 }, { w: 800, h: 1200 }, {});
    expect([trendyol.w, trendyol.h, trendyol.scale]).toEqual([1200, 1800, 3]);
    expect(shouldUpscale(trendyol.scale, 1.5)).toBe(true);
    // Trendyol from the 800x1200 frame itself: 1.5x exactly, at the threshold, so the plain path.
    expect(shouldUpscale(planCanvas(CHANNELS.trendyol, { x: 0, y: 0, w: 800, h: 1200 }, { w: 800, h: 1200 }, {}).scale, 1.5)).toBe(false);
    for (const spec of Object.values(CHANNELS).filter(c => !c.fixedCanvas)) for (const side of [500, 701, 900, 1237, 1600, 2800]) for (const box of [{ x: 0, y: 0, w: side / 2, h: side }, { x: 0, y: 0, w: side, h: Math.round(side / 3) }]) {
      const plan = planCanvas(spec, box, { w: side * 2, h: side * 2 }, {});
      if (!plan.lowResolution) expect(shouldUpscale(plan.scale, 1.5), `${spec.id} ${side}`).toBe(false);
    }
  });
});

describe("render with the upscaler", () => {
  it("sends the whole photo as JPEG 95 4:4:4, takes the colour from the 2x answer, keeps the exact size and flags it", async () => {
    const { prepared, matte } = fixture(), upscaler = fakeUpscaler();
    const out = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler, trace: { batchId: "b1", productId: "p1" } });
    expect(out.status).toBe("ok");
    expect(upscaler.calls).toEqual([{ w: 800, h: 1200, type: "image/jpeg" }]);
    const meta = await sharp(out.jpeg!).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1800]);
    expect(out.flags).toContain("upscaled");
    expect(out.upscale).toEqual({ model: MODEL, ms: 42 });
    const [r, g, b] = await pixel(out.jpeg!, 600, 900);
    expect(g).toBeGreaterThan(150); expect(r).toBeLessThan(60); expect(b).toBeLessThan(60);
    // The product notes are model-free; no sentence names the upscaler.
    expect(out.notes.join(" ")).not.toMatch(/esrgan|swinir/i);
  });
  it("calls the service once per photo, shared by every channel and re-render of that photo", async () => {
    const { prepared, matte } = fixture(), upscaler = fakeUpscaler();
    const sent: Buffer[] = [], spy: Upscaler = { model: upscaler.model, minScale: upscaler.minScale, upscale: async (image, type) => { sent.push(image); return upscaler.upscale(image, type); } };
    const trendyol = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: spy });
    const centrepoint = await renderSource({ prepared, matte, channel: "centrepoint", shotNumber: 1, productType: "other", upscaler: spy });
    const again = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: spy });
    expect(centrepoint.plan.scale).toBeGreaterThan(1.5);
    for (const out of [trendyol, centrepoint, again]) expect(out.flags).toContain("upscaled");
    expect(upscaler.calls).toHaveLength(1);
    expect(await sharp(sent[0]!).metadata()).toMatchObject({ format: "jpeg", chromaSubsampling: "4:4:4", width: 800, height: 1200 });
    expect(trendyol.upscale).toEqual({ model: MODEL, ms: 42 }); expect(centrepoint.upscale).toEqual({ model: MODEL, ms: 42, reused: true });
    expect(again.jpeg!.equals(trendyol.jpeg!)).toBe(true);
    // A failed call is not retried for the photo's other channels: they are all held (spec 18).
    const { prepared: p2, matte: m2 } = fixture(), failing = fakeUpscaler(2, new Error("down"));
    for (const channel of ["trendyol", "centrepoint"] as const) expect((await renderSource({ prepared: p2, matte: m2, channel, shotNumber: 1, productType: "other", upscaler: failing })).flags).toContain("enlargement_failed");
    expect(failing.calls).toHaveLength(1);
  });
  it("spec 18: off keeps the plain path with no flag; a failing or wrong-size upscaler holds the output with enlargement_failed, never a silent plain resize", async () => {
    const { prepared, matte } = fixture();
    const plain = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other" });
    expect(plain.flags).not.toContain("upscaled"); expect(plain.flags).not.toContain("enlargement_failed"); expect(plain.upscale).toBeUndefined();
    const failing = fakeUpscaler(2, new Error("Upscale failed: Background removal service returned 503."));
    const held = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler: failing, trace: { batchId: "b1", productId: "p1" } });
    expect(failing.calls).toHaveLength(1);
    expect(held.flags).not.toContain("upscaled"); expect(held.upscale).toBeUndefined();
    expect(held.flags).toContain("enlargement_failed");
    expect(holdsAtRender(held.flags)).toBe(true);
    expect(held.notes).toContain(ENLARGEMENT_FAILED_SENTENCE);
    // The plain image stays only for the operator to look at; the hold keeps it out of the sheet.
    expect(held.jpeg!.equals(plain.jpeg!)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ message: "catalog enlargement missing", batchId: "b1", productId: "p1", shot: 2, channel: "trendyol" });
    expect(line).not.toContain("plain enlargement");
    // A wrong-size answer is a failure too.
    const wrong = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler: fakeUpscaler(3) });
    expect(wrong.flags).not.toContain("upscaled"); expect(wrong.flags).toContain("enlargement_failed");
    // Noon caps this photo at 1.5x: with the threshold of 1.5 (before spec 18 quality) the upscaler is never asked and
    // nothing is flagged.
    const unused = { ...fakeUpscaler(), minScale: LEGACY_UPSCALE_MIN_SCALE }, noon = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "other", upscaler: unused });
    const noonPlain = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "other" });
    expect(noon.plan.scale).toBeLessThanOrEqual(1.5); expect(unused.calls).toHaveLength(0); expect(noon.flags).not.toContain("upscaled");
    expect(noon.flags).toEqual(noonPlain.flags); expect(noon.bytes).toBe(noonPlain.bytes);
  });
  it("spec 18: the stored upscaler never calls a service; a primed x2 image makes the upscaled output, an unprimed photo is held", async () => {
    const { prepared, matte } = fixture(), stored = storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE);
    const x2 = await sharp({ create: { width: 1600, height: 2400, channels: 3, background: { r: 0, g: 200, b: 0 } } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    expect(await primeSourceX2(stored, prepared.rgb, prepared.width, x2)).toBe(true);
    const out = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler: stored });
    expect(out.flags).toContain("upscaled"); expect(out.flags).not.toContain("enlargement_failed");
    expect(out.upscale).toMatchObject({ model: `${MODEL}+cpu`, ms: 0 });
    const [r, g, b] = await pixel(out.jpeg!, 600, 900);
    expect(g).toBeGreaterThan(150); expect(r).toBeLessThan(60); expect(b).toBeLessThan(60);
    // The same bytes through an inline upscaler give the same image: the stored path changes nothing but who calls.
    const inline = await renderSource({ ...fixture(), channel: "trendyol", shotNumber: 2, productType: "other", upscaler: fakeUpscaler() });
    expect(out.jpeg!.equals(inline.jpeg!)).toBe(true);
    // Another prepared photo (its own buffer) has no stored image: held, and no service exists to call.
    const other = fixture();
    const missing = await renderSource({ prepared: other.prepared, matte: other.matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler: stored });
    expect(missing.flags).toContain("enlargement_failed"); expect(missing.flags).not.toContain("upscaled");
    await expect(stored.upscale(Buffer.alloc(1), "image/jpeg")).rejects.toBeInstanceOf(StoredEnlargementMissingError);
    // A stored image that is not exactly 2x the prepared photo is refused (it counts as missing).
    const odd = await sharp({ create: { width: 1601, height: 2400, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
    expect(await primeSourceX2(stored, other.prepared.rgb, other.prepared.width, odd)).toBe(false);
  });
  it("recombines the upscaled colour with the plain Lanczos alpha, unchanged", async () => {
    const { prepared, matte } = fixture(), crop = { x: 200, y: 300, w: 400, h: 600 }, size = { w: 1200, h: 1800 };
    const rgba = Buffer.alloc(prepared.width * prepared.height * 4);
    for (let i = 0; i < matte.alpha.length; i++) { prepared.rgb.copy(rgba, i * 4, i * 3, i * 3 + 3); rgba[i * 4 + 3] = matte.alpha[i]!; }
    const plain = await sharp(rgba, { raw: { width: prepared.width, height: prepared.height, channels: 4 } }).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).resize(size.w, size.h, { kernel: "lanczos3" }).png().toBuffer();
    const enlarged = await upscaledRgb(fakeUpscaler(), prepared.rgb, prepared.width, crop, size);
    expect(enlarged!.reused).toBe(false);
    expect(enlarged!.rgb.length).toBe(size.w * size.h * 3);
    const mixed = await enlargeCutout({ rgba, rgb: prepared.rgb, width: prepared.width, height: prepared.height, crop, to: size, upscaled: enlarged!.rgb });
    const alpha = async (png: Buffer) => sharp(png).extractChannel(3).raw().toBuffer();
    expect((await alpha(mixed)).equals(await alpha(plain))).toBe(true);
    // Spec 18 quality: the colour is the upscaler's, never sharpened (the old residual sharpening is gone).
    const colour = (await sharp(mixed).raw().toBuffer());
    for (let i = 0; i < size.w * size.h; i++) for (let c = 0; c < 3; c++) if (colour[i * 4 + c] !== enlarged!.rgb[i * 3 + c]) expect.fail(`pixel ${i} channel ${c} differs`);
  });
});

describe("render_key", () => {
  const input = { sourceSha256: "abc", channel: "trendyol" as const, n: 1, policyKey: "default|birefnet-general" };
  it("keeps today's key without the upscaler and names the upscaler and its version when used", () => {
    const plain = renderKey(input);
    expect(renderKey({ ...input, upscaler: null })).toBe(plain);
    expect(renderKey({ ...input, upscaler: MODEL })).toBe(upscaledRenderKey(plain, MODEL));
    expect(renderKey({ ...input, upscaler: MODEL })).not.toBe(plain);
    expect(renderKey({ ...input, upscaler: MODEL_X4 })).not.toBe(renderKey({ ...input, upscaler: MODEL }));
    expect(UPSCALER_VERSION).toBe("2");
    expect(upscalerKey(MODEL)).toBe(`u:${MODEL}@9f4a3f85:${UPSCALER_VERSION}`);
    expect(upscalerKey(MODEL_X4)).toBe(`u:${MODEL_X4}@f477a052:${UPSCALER_VERSION}`);
    // Spec 18 quality: with the x4 model configured, an output upscaled by either model counts as unchanged.
    expect(renderKeys(input, [MODEL, MODEL_X4])).toEqual([plain, upscaledRenderKey(plain, MODEL), upscaledRenderKey(plain, `${MODEL}+cpu`), upscaledRenderKey(plain, MODEL_X4), upscaledRenderKey(plain, `${MODEL_X4}+cpu`)]);
    expect(renderKeys(input, null)).toEqual([plain]);
    // Spec 16: an image the same model made on the other service (GPU or CPU) also counts as unchanged.
    expect(renderKeys(input, MODEL)).toEqual([plain, upscaledRenderKey(plain, MODEL), upscaledRenderKey(plain, `${MODEL}+cpu`)]);
    expect(renderKeys(input, `${MODEL}+cpu`)).toEqual([plain, upscaledRenderKey(plain, `${MODEL}+cpu`), upscaledRenderKey(plain, MODEL)]);
    // A re-render keeps the row's key in step with its `upscaled` flag, both ways.
    const up = upscaledRenderKey(plain, MODEL), recompute = () => plain;
    expect(rerenderedKey({ renderKey: plain, flags: [] }, MODEL, recompute)).toBe(up);
    expect(rerenderedKey({ renderKey: up, flags: ["upscaled"] }, MODEL, recompute)).toBe(up);
    expect(rerenderedKey({ renderKey: up, flags: ["upscaled"] }, undefined, recompute)).toBe(plain);
    expect(rerenderedKey({ renderKey: plain, flags: [] }, null, recompute)).toBe(plain);
    // Spec 16 3.1.3: the GPU id keeps today's key byte for byte; the CPU id gets its own; a row upscaled before and
    // re-made on the CPU takes the CPU key from its recomputed plain key.
    expect(upscalerId(MODEL, "gpu")).toBe(MODEL);
    expect(upscalerKey(`${MODEL}+cpu`)).toBe(`u:${MODEL}@9f4a3f85:${UPSCALER_VERSION}:cpu`);
    expect(otherTargetUpscalerId(`${MODEL}+cpu`)).toBe(MODEL);
    const cpuUp = upscaledRenderKey(plain, `${MODEL}+cpu`);
    expect(cpuUp).not.toBe(up);
    expect(rerenderedKey({ renderKey: up, flags: ["upscaled"] }, `${MODEL}+cpu`, recompute)).toBe(cpuUp);
    expect(rerenderedKey({ renderKey: plain, flags: [] }, `${MODEL}+cpu`, recompute)).toBe(cpuUp);
    const k = { sourceSha256: "abc", channel: "trendyol" as const, rulesVersion: "7", policyId: "p", policyUpdatedAt: "t", n: 1 };
    expect(renderKeyInputs(k)).toBe("abc|trendyol|7|p+t|1");
    expect(renderKeyInputs({ ...k, upscaler: MODEL })).toBe(`abc|trendyol|7|p+t|1|u:${MODEL}@9f4a3f85:${UPSCALER_VERSION}`);
  });
});

describe("upscaled flag copy", () => {
  it("is an information flag with a model-free sheet note", () => {
    expect(UPSCALED_SENTENCE).toBe("Enlarged with a quality pass to meet this marketplace's size.");
    for (const set of [INFORMATION_FLAGS, EVAL_INFORMATION_FLAGS, RENDER_FLAGS] as ReadonlySet<string>[]) expect(set.has("upscaled")).toBe(true);
    expect(flagDetails("upscaled")).toEqual({ why: UPSCALED_SENTENCE, whatToDo: "Nothing to do." });
    expect(flagReason("upscaled")).toBe(`${UPSCALED_SENTENCE} Nothing to do.`);
    const o = (channel: "trendyol" | "noon", n: number, status = "staged", flags: ("upscaled" | "cut_in_source")[] = ["upscaled"]) => ({ channel, n, status: status as "staged", flags });
    expect(upscaledNotes([o("trendyol", 3), o("trendyol", 1), o("trendyol", 2, "failed"), o("noon", 1, "staged", ["cut_in_source"])]))
      .toEqual([`Trendyol img 1 and 3: ${UPSCALED_SENTENCE}`]);
    expect(upscaledNotes([])).toEqual([]);
    expect([UPSCALED_SENTENCE, ...upscaledNotes([o("trendyol", 1)])].join(" ")).not.toMatch(/esrgan|swinir|realesr/i);
  });
});

describe("matting client upscale target (spec 18 H3: the client never calls /upscale)", () => {
  type Route = (init: RequestInit & { signal: AbortSignal }) => Promise<Response> | Response;
  const health = (target: "cpu" | "gpu", upscale?: unknown) => Response.json({ ok: true, models: [{ id: "general", inputSize: 64, target }], default: "general", version: target, ...(upscale === undefined ? {} : { upscale }) });
  const listed = { models: [{ id: MODEL, available: true, scale: 2 }, { id: MODEL_X4, available: false, scale: 4 }], default: MODEL };
  function client(upscaleRoute: Route, opts: { gpu?: boolean; upscale?: unknown } = {}) {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url); calls.push(u);
      if (u.endsWith("/health")) return health(u.includes(":2") ? "gpu" : "cpu", u.includes(":2") ? ("upscale" in opts ? opts.upscale : listed) : undefined);
      return upscaleRoute(init as RequestInit & { signal: AbortSignal });
    }) as unknown as typeof globalThis.fetch;
    const c = new MattingClient({ services: [{ baseUrl: "http://127.0.0.1:1", target: "cpu" }, ...(opts.gpu === false ? [] : [{ baseUrl: "http://127.0.0.1:2", target: "gpu" as const }])], fetch });
    return { c, calls };
  }
  it("types the health upscale section of the GPU service", async () => {
    expect(parseUpscaleHealth(undefined)).toBeNull();
    expect(parseUpscaleHealth({ models: [{ id: MODEL, available: true, scale: 2 }, { id: "", available: true, scale: 2 }, { id: "x", available: "yes", scale: 2 }] })).toEqual({ models: [{ id: MODEL, available: true, scale: 2 }], default: null });
    const { c, calls } = client(() => new Response("{}", { status: 500 }));
    expect((await c.health()).upscale).toEqual(listed);
    expect(calls.filter(u => u.includes("/upscale"))).toEqual([]);
    expect("upscale" in c).toBe(false);
  });
  it("the upscale target is the CPU cut-out service when UPSCALE_URL names it (spec 16 3.1.3)", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => health(String(url).includes(":2") ? "gpu" : "cpu", listed)) as unknown as typeof globalThis.fetch;
    const services = [{ baseUrl: "http://127.0.0.1:1", target: "cpu" as const }, { baseUrl: "http://127.0.0.1:2", target: "gpu" as const }];
    const cpu = new MattingClient({ services, fetch, upscaleUrl: "http://127.0.0.1:1/" });
    expect(cpu.upscaleTarget).toBe("cpu");
    // The worker's upscaler carries the CPU id, so its render_key differs from a GPU-made image's.
    expect(upscalerId(MODEL, cpu.upscaleTarget)).toBe(`${MODEL}+cpu`);
    // Unset keeps the GPU service; spec 18 H2: an URL that names no matting service is the dedicated CPU service.
    expect(new MattingClient({ services, fetch, upscaleUrl: null }).upscaleTarget).toBe("gpu");
    expect(new MattingClient({ services, fetch, upscaleUrl: "https://elsewhere.example" }).upscaleTarget).toBe("cpu");
    expect(warn).not.toHaveBeenCalled();
    // Without a GPU service, the CPU service named by UPSCALE_URL still upscales.
    expect(new MattingClient({ services: [services[0]!], fetch, upscaleUrl: "http://127.0.0.1:1" }).upscaleTarget).toBe("cpu");
  });
  it("never reads the dedicated CPU service when UPSCALE_URL names no matting service: the enlarge stage calls it (spec 18 H2)", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url); calls.push(u);
      return health(u.includes(":2") ? "gpu" : "cpu", u.includes(":3") ? listed : undefined);
    }) as unknown as typeof globalThis.fetch;
    const services = [{ baseUrl: "http://127.0.0.1:1", target: "cpu" as const }, { baseUrl: "http://127.0.0.1:2", target: "gpu" as const }];
    const c = new MattingClient({ services, fetch, upscaleUrl: "http://127.0.0.1:3/" });
    // Its render keys stay the CPU ones.
    expect(c.upscaleTarget).toBe("cpu");
    expect(upscalerId(MODEL, c.upscaleTarget)).toBe(`${MODEL}+cpu`);
    // No /health fan-out to it: the cut-out services alone.
    expect((await c.health()).models.map((m) => m.target).sort()).toEqual(["cpu", "gpu"]);
    expect(calls.some((u) => u.includes(":3"))).toBe(false);
  });
  it("one parser for the GPU URLs (matting client and upscale target)", () => {
    expect(gpuUrlsFromEnv({})).toEqual([]);
    expect(gpuUrlsFromEnv({ MATTING_GPU_URL: "https://gpu.example/" })).toEqual(["https://gpu.example"]);
    expect(gpuUrlsFromEnv({ MATTING_GPU_URLS: " https://a.example/, ,https://b.example,https://a.example", MATTING_GPU_URL: "https://ignored.example" }))
      .toEqual(["https://a.example", "https://b.example"]);
  });
  it("reads the target from UPSCALE_URL against MATTING_URL", () => {
    expect(upscaleTargetFromEnv({})).toBe("gpu");
    expect(upscaleTargetFromEnv({ UPSCALE_URL: "https://cpu.example/", MATTING_URL: "https://cpu.example" })).toBe("cpu");
    expect(upscaleTargetFromEnv({ UPSCALE_URL: "https://gpu.example", MATTING_URL: "https://cpu.example", MATTING_GPU_URL: "https://gpu.example/" })).toBe("gpu");
    expect(upscaleTargetFromEnv({ UPSCALE_URL: "https://gpu-b.example", MATTING_GPU_URLS: "https://gpu-a.example, https://gpu-b.example", MATTING_GPU_URL: "https://ignored.example" })).toBe("gpu");
    // Spec 18 H2: the dedicated CPU service catalog-upscale (no matting service) keeps the CPU render keys.
    const dedicated = { UPSCALE_MODEL: MODEL, UPSCALE_URL: "https://catalog-upscale-abc-el.a.run.app", MATTING_URL: "https://cpu.example", MATTING_GPU_URL: "https://gpu.example" };
    expect(upscaleTargetFromEnv(dedicated)).toBe("cpu");
    expect(configuredUpscalerId(dedicated)).toBe(`${MODEL}+cpu`);
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_URL: "https://cpu.example", MATTING_URL: "https://cpu.example" })).toEqual({ model: MODEL, x4Model: null, minScale: 1, target: "cpu" });
    expect(configuredUpscalerId({ UPSCALE_MODEL: MODEL, UPSCALE_URL: "https://cpu.example", MATTING_URL: "https://cpu.example" })).toBe(`${MODEL}+cpu`);
    expect(configuredUpscalerId({ UPSCALE_MODEL: MODEL })).toBe(MODEL);
    expect(configuredUpscalerId({})).toBeNull();
  });
});

describe("spec 18: enlargementNeeds, decided at the matte stage", () => {
  const shot = (f: ReturnType<typeof fixture>) => ({ width: f.prepared.width, height: f.prepared.height, rgb: f.prepared.rgb, alpha: f.matte.alpha, model: f.matte.model });
  it("is a superset of the render's decision on the product's canvas, with and without the judged cut", async () => {
    // Two shots of one product: a small product inside the frame and one cut at every edge (the largest canvas).
    const shots = [fixture(400, 600, { x: 100, y: 150, w: 200, h: 300 }), fixture(600, 600, { x: 0, y: 0, w: 600, h: 600 })];
    const channels = ["trendyol", "noon", "styli", "amazon"] as const;
    const needs = enlargementNeeds(channels, shots.map(shot), "other", DEFAULT_UPSCALE_MIN_SCALE);
    const geometry = shots.flatMap(({ prepared, matte }) => { const g = shotGeometry(matte.alpha, prepared.width, prepared.height, { rgb: prepared.rgb, ...trimRules("other", matte) }); return g ? [g] : []; });
    let used = 0;
    for (const [i, { prepared, matte }] of shots.entries()) for (const ch of channels) {
      const canvas = planProduct(CHANNELS[ch], geometry).canvas;
      for (const ctx of [{ canvas }, { canvas, judgedCut: true }]) {
        const up = fakeUpscaler();
        await renderSource({ prepared, matte, channel: ch, shotNumber: i + 1, productType: "other", upscaler: up, ...ctx });
        if (up.calls.length) { used++; expect(needs[i], `shot ${i + 1} on ${ch} ${JSON.stringify(ctx)}`).toBe(true); }
      }
    }
    expect(used).toBeGreaterThan(0);
  }, 120_000);
  it("is false where no channel enlarges past the threshold: noon's own canvas, a large photo, no product found", () => {
    const one = fixture();
    expect(enlargementNeeds(["trendyol"], [shot(one)], "other", DEFAULT_UPSCALE_MIN_SCALE)).toEqual([true]);
    // Noon picks a canvas that keeps this photo at 1.5x or less (the render test above): nothing to enlarge with the
    // old 1.5 threshold, the x2 image with spec 18 quality's 1.0.
    expect(enlargementNeeds(["noon"], [shot(one)], "other", LEGACY_UPSCALE_MIN_SCALE)).toEqual([false]);
    expect(enlargementNeeds(["noon"], [shot(one)], "other", DEFAULT_UPSCALE_MIN_SCALE)).toEqual([true]);
    expect(enlargementNeeds(["noon", "trendyol"], [shot(one)], "other", LEGACY_UPSCALE_MIN_SCALE)).toEqual([true]);
    const big = fixture(2400, 3600, { x: 300, y: 300, w: 1800, h: 3000 });
    expect(enlargementNeeds(Object.keys(CHANNELS) as (keyof typeof CHANNELS)[], [shot(big)], "other", LEGACY_UPSCALE_MIN_SCALE)).toEqual([false]);
    // Spec 18 quality: from 1.0x, the largest canvases (up to 3000x3000) enlarge even this 1800x3000 box a little.
    expect(enlargementNeeds(Object.keys(CHANNELS) as (keyof typeof CHANNELS)[], [shot(big)], "other", DEFAULT_UPSCALE_MIN_SCALE)).toEqual([true]);
    expect(enlargementNeeds(["trendyol"], [{ ...shot(one), alpha: Buffer.alloc(one.matte.alpha.length) }, shot(big)], "other", LEGACY_UPSCALE_MIN_SCALE)).toEqual([false, false]);
  });
});

describe("spec 18 quality: AI enlargement above 1.0x, x2/x4 routing, crop before upscaling", () => {
  const shot = (f: ReturnType<typeof fixture>) => ({ width: f.prepared.width, height: f.prepared.height, rgb: f.prepared.rgb, alpha: f.matte.alpha, model: f.matte.model });
  /** Trendyol (1200x1800) enlarges a 2:3 product box `1200 / w` times. */
  const at = (scale: number) => { const w = Math.round(1200 / scale), h = w * 1.5; return fixture(w + 200, h + 300, { x: 100, y: 150, w, h }); };
  /** A nearest-neighbour `f`x of `region` of a prepared photo, as a lossless PNG: every source pixel becomes f x f. */
  async function nearest(rgb: Buffer, width: number, region: { x: number; y: number; w: number; h: number }, f: number): Promise<Buffer> {
    const out = Buffer.alloc(region.w * f * region.h * f * 3);
    for (let y = 0; y < region.h * f; y++) for (let x = 0; x < region.w * f; x++) {
      const from = ((region.y + Math.floor(y / f)) * width + region.x + Math.floor(x / f)) * 3;
      rgb.copy(out, (y * region.w * f + x) * 3, from, from + 3);
    }
    return sharp(out, { raw: { width: region.w * f, height: region.h * f, channels: 3 } }).png().toBuffer();
  }

  it("routes 1.0 < s <= 2.0 to x2 (x4 only as a fallback) and s > 2.0 to x4; without x4 the x2 makes every enlargement", () => {
    const x2 = fakeUpscaler(), x4 = fakeUpscaler(4, undefined, MODEL_X4, 4);
    expect(UPSCALE_X4_MIN_SCALE).toBe(2);
    expect(upscalersFor(1.2, x2, x4)).toEqual([x2, x4]);
    expect(upscalersFor(2, x2, x4)).toEqual([x2, x4]);
    expect(upscalersFor(2.01, x2, x4)).toEqual([x4]);
    expect(upscalersFor(3, x2, null)).toEqual([x2]);
    expect([upscalerFactor(MODEL), upscalerFactor(`${MODEL}+cpu`), upscalerFactor(MODEL_X4), upscalerFactor(`${MODEL_X4}+cpu`)]).toEqual([2, 2, 4, 4]);
  });
  it("the render uses x2 at 1.2x and 1.5x and x4 at 2.5x, one call per photo per model, and flags it upscaled", async () => {
    for (const [scale, model] of [[1.2, MODEL], [1.5, MODEL], [2.5, MODEL_X4]] as const) {
      const { prepared, matte } = at(scale), x2 = fakeUpscaler(), x4 = fakeUpscaler(4, undefined, MODEL_X4, 4);
      const outs = [];
      for (const n of [1, 2]) outs.push(await renderSource({ prepared, matte, channel: "trendyol", shotNumber: n, productType: "other", upscaler: x2, upscalerX4: x4 }));
      expect(outs[0]!.plan.scale).toBeCloseTo(scale, 2);
      for (const out of outs) { expect(out.flags).toContain("upscaled"); expect(out.flags).not.toContain("enlargement_failed"); expect(out.upscale?.model).toBe(model); }
      expect([x2.calls.length, x4.calls.length], `${scale}x`).toEqual(model === MODEL ? [1, 0] : [0, 1]);
      expect(outs[1]!.upscale?.reused).toBe(true);
    }
  });
  it("holds a 1.2x enlargement with enlargement_failed when the upscaler fails or no image is stored: never a silent plain resize", async () => {
    const { prepared, matte } = at(1.2);
    const failing = fakeUpscaler(2, new Error("Upscale failed: 503."));
    const held = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: failing });
    expect(held.plan.scale).toBeCloseTo(1.2, 2);
    expect(held.flags).toContain("enlargement_failed"); expect(held.flags).not.toContain("upscaled"); expect(holdsAtRender(held.flags)).toBe(true);
    const unprimed = await renderSource({ ...at(1.2), channel: "trendyol", shotNumber: 1, productType: "other", upscaler: storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE), upscalerX4: storedUpscaler(upscalerId(MODEL_X4, "cpu"), DEFAULT_UPSCALE_MIN_SCALE) });
    expect(unprimed.flags).toContain("enlargement_failed");
    // With the old 1.5 threshold the same photo took the plain path, unflagged: what spec 18 quality removes.
    const legacy = await renderSource({ ...at(1.2), channel: "trendyol", shotNumber: 1, productType: "other", upscaler: { ...fakeUpscaler(), minScale: LEGACY_UPSCALE_MIN_SCALE } });
    expect(legacy.flags).not.toContain("enlargement_failed"); expect(legacy.flags).not.toContain("upscaled");
  });
  it("the x4 image stands in at or below 2.0x when no x2 image exists (a uniform scale may place a photo lower than planned)", async () => {
    const { prepared, matte } = at(1.5), x2 = storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE), x4 = storedUpscaler(upscalerId(MODEL_X4, "cpu"), DEFAULT_UPSCALE_MIN_SCALE);
    expect(await primeSourceX2(x4, prepared.rgb, prepared.width, await nearest(prepared.rgb, prepared.width, { x: 0, y: 0, w: prepared.width, h: prepared.height }, 4))).toBe(true);
    expect(hasSourceX2(x2, prepared.rgb)).toBe(false);
    const out = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: x2, upscalerX4: x4 });
    expect(out.flags).toContain("upscaled"); expect(out.upscale?.model).toBe(`${MODEL_X4}+cpu`);
    // Above 2.0x the x2 image alone never makes the output.
    const big = at(3), y2 = storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE), y4 = storedUpscaler(upscalerId(MODEL_X4, "cpu"), DEFAULT_UPSCALE_MIN_SCALE);
    expect(await primeSourceX2(y2, big.prepared.rgb, big.prepared.width, await nearest(big.prepared.rgb, big.prepared.width, { x: 0, y: 0, w: big.prepared.width, h: big.prepared.height }, 2))).toBe(true);
    expect((await renderSource({ ...big, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: y2, upscalerX4: y4 })).flags).toContain("enlargement_failed");
  }, 60_000);
  it("matte alignment is exact: an image of the product region gives byte for byte the output of an image of the whole photo, at x2 and x4", async () => {
    for (const [scale, model, f] of [[1.5, MODEL, 2], [3, MODEL_X4, 4]] as const) {
      const one = at(scale), { prepared, matte } = one;
      const region = shotEnlargementRegion(shot(one), "other")!;
      const box = shotGeometry(matte.alpha, prepared.width, prepared.height, { rgb: prepared.rgb, ...trimRules("other", matte) })!.box;
      // The product box plus the margin, inside the photo, and well short of the whole photo.
      expect(region).toEqual(enlargeRegion([box], prepared.width, prepared.height));
      expect(region.x).toBe(Math.max(0, box.x - ENLARGE_REGION_MARGIN_PX)); expect(region.w * region.h).toBeLessThan(prepared.width * prepared.height);
      expect(parseRegion(formatRegion(region))).toEqual(region);
      const render = async (r: typeof region) => {
        const x2 = storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE), x4 = storedUpscaler(upscalerId(MODEL_X4, "cpu"), DEFAULT_UPSCALE_MIN_SCALE);
        expect(await primeSourceX2(f === 4 ? x4 : x2, prepared.rgb, prepared.width, await nearest(prepared.rgb, prepared.width, r, f), r)).toBe(true);
        return renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: x2, upscalerX4: x4 });
      };
      const whole = await render({ x: 0, y: 0, w: prepared.width, h: prepared.height }), cropped = await render(region);
      expect(cropped.flags).toContain("upscaled"); expect(cropped.upscale?.model).toBe(`${model}+cpu`);
      expect(cropped.jpeg!.equals(whole.jpeg!), `${scale}x`).toBe(true);
      // An image whose region misses the crop is never used: the output is held.
      const missed = await render({ x: 0, y: 0, w: 50, h: 50 });
      expect(missed.flags).toContain("enlargement_failed"); expect(missed.flags).not.toContain("upscaled");
    }
  }, 120_000);
  it("refuses a stored image that is not the model's scale times its region, or whose region lies outside the photo", async () => {
    const { prepared } = at(1.5), x4 = storedUpscaler(upscalerId(MODEL_X4, "cpu"), DEFAULT_UPSCALE_MIN_SCALE), r = { x: 10, y: 10, w: 100, h: 120 };
    expect(await primeSourceX2(x4, prepared.rgb, prepared.width, await nearest(prepared.rgb, prepared.width, r, 2), r)).toBe(false);
    expect(await primeSourceX2(x4, prepared.rgb, prepared.width, await nearest(prepared.rgb, prepared.width, r, 4), { ...r, x: prepared.width - 50 })).toBe(false);
    expect(await primeSourceX2(x4, prepared.rgb, prepared.width, await nearest(prepared.rgb, prepared.width, r, 4), r)).toBe(true);
    for (const bad of ["", "1,2,3", "1,2,0,4", "-1,0,4,4", "a,b,c,d"]) expect(parseRegion(bad)).toBeNull();
  });
  it("enlargementFactors: the x2 image up to 2.0x and the x4 image above, per photo across its channels", () => {
    const one = fixture();
    expect(enlargementFactors(["trendyol"], [shot(one)], "other", DEFAULT_UPSCALE_MIN_SCALE, true)).toEqual([[4]]);
    expect(enlargementFactors(["trendyol"], [shot(one)], "other", DEFAULT_UPSCALE_MIN_SCALE, false)).toEqual([[2]]);
    expect(enlargementFactors(["noon"], [shot(one)], "other", DEFAULT_UPSCALE_MIN_SCALE, true)).toEqual([[2]]);
    expect(enlargementFactors(["noon"], [shot(one)], "other", LEGACY_UPSCALE_MIN_SCALE, true)).toEqual([[]]);
    expect(enlargementFactors(["noon", "trendyol"], [shot(one)], "other", DEFAULT_UPSCALE_MIN_SCALE, true)).toEqual([[2, 4]]);
  });
});

describe("2026-10-29 review fixes: per-model caps, one band rule, region edges, stored images decoded per crop", () => {
  const shot = (f: ReturnType<typeof fixture>) => ({ width: f.prepared.width, height: f.prepared.height, rgb: f.prepared.rgb, alpha: f.matte.alpha, model: f.matte.model });
  const CAPS = { UPSCALE_MAX_PIXELS: "8000000", UPSCALE_MAX_PIXELS_X4: "6400000" };
  it("P1-3: each model has its own cap; the x4 cap falls back to the x2 cap, both to the service default", () => {
    expect([upscaleMaxPixels(2, CAPS), upscaleMaxPixels(4, CAPS)]).toEqual([8_000_000, 6_400_000]);
    expect([upscaleMaxPixels(2, { UPSCALE_MAX_PIXELS: "8000000" }), upscaleMaxPixels(4, { UPSCALE_MAX_PIXELS: "8000000" })]).toEqual([8_000_000, 8_000_000]);
    expect([upscaleMaxPixels(2, {}), upscaleMaxPixels(4, { UPSCALE_MAX_PIXELS_X4: "x" })]).toEqual([DEFAULT_UPSCALE_MAX_PIXELS, DEFAULT_UPSCALE_MAX_PIXELS]);
  });
  it("P1-3, the reproduced case: a 2500 px square product in a 2700 px photo on Centrepoint at 1.2x is a 6.57 MP x2 job, inside the x2 cap", () => {
    // The fixture's first 8 columns are a soft edge below the box threshold, so the box seen is 2500 x 2500 at (100, 100).
    const big = fixture(2700, 2700, { x: 92, y: 100, w: 2508, h: 2500 });
    const plan = planCanvas(CHANNELS.centrepoint, { x: 100, y: 100, w: 2500, h: 2500 }, { w: 2700, h: 2700 }, {});
    expect(plan.scale).toBeCloseTo(1.2, 2);
    expect(enlargementFactors(["centrepoint"], [shot(big)], "other", DEFAULT_UPSCALE_MIN_SCALE, true)).toEqual([[2]]);
    const region = shotEnlargementRegion(shot(big), "other")!;
    expect(region).toEqual({ x: 68, y: 68, w: 2564, h: 2564 });
    expect(region.w * region.h).toBe(6_574_096);
    // Above the x4 cap (the one shared cap that held it), inside the x2 cap its job uses.
    expect(region.w * region.h).toBeGreaterThan(upscaleMaxPixels(4, CAPS));
    expect(region.w * region.h).toBeLessThanOrEqual(upscaleMaxPixels(2, CAPS));
  }, 60_000);
  it("P2-11: one band rule for the matte stage and the render; a UPSCALE_MODEL_X4 that is not an x4 model is no x4 model", () => {
    expect([upscaleFactorFor(1.2, true), upscaleFactorFor(2, true), upscaleFactorFor(2 + 1e-12, true), upscaleFactorFor(2.01, true), upscaleFactorFor(3, false)]).toEqual([2, 2, 2, 4, 2]);
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MODEL_X4: MODEL_X4 }).x4Model).toBe(MODEL_X4);
    for (const typo of ["swinir-4x", "swinir-x2", "off", ""]) expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MODEL_X4: typo }).x4Model, typo).toBeNull();
  });
  it("P2-10: the region is the union of differing boxes plus the margin, clamped at 0 and at the photo's width and height", () => {
    const plain = { x: 10, y: 40, w: 100, h: 50 }, judged = { x: 30, y: 20, w: 150, h: 60 };
    expect(enlargeRegion([plain, judged], 400, 300)).toEqual({ x: 0, y: 0, w: 180 + 32, h: 90 + 32 });
    expect(enlargeRegion([{ x: 300, y: 200, w: 90, h: 95 }], 400, 300)).toEqual({ x: 268, y: 168, w: 132, h: 132 });
    expect(enlargeRegion([{ x: 0, y: 0, w: 400, h: 300 }], 400, 300)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(enlargeRegion([], 400, 300)).toBeNull();
    // The judged (relaxed cut) box and the plain box differ; the region holds both.
    const one = fixture();
    const boxes = [false, true].map((judgedCut) => shotGeometry(one.matte.alpha, 800, 1200, { rgb: one.prepared.rgb, judgedCut, ...trimRules("other", one.matte) })!.box);
    const region = shotEnlargementRegion(shot(one), "other")!;
    for (const box of boxes) expect(region.x <= box.x && region.y <= box.y && region.x + region.w >= box.x + box.w && region.y + region.h >= box.y + box.h).toBe(true);
  });
  it("P2-8: a primed stored image stays a JPEG and is decoded for each crop, with the same output as before", async () => {
    const { prepared, matte } = fixture(500, 700, { x: 50, y: 50, w: 400, h: 600 });
    const region = shotEnlargementRegion(shot({ prepared, matte }), "other")!;
    const x2 = storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE);
    const jpeg = await sharp(prepared.rgb, { raw: { width: 500, height: 700, channels: 3 } }).extract({ left: region.x, top: region.y, width: region.w, height: region.h }).resize(region.w * 2, region.h * 2, { kernel: "nearest" }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    expect(await primeSourceX2(x2, prepared.rgb, 500, jpeg, region)).toBe(true);
    const primed = (await sourceX2(x2, prepared.rgb, 500).result)!;
    expect(primed.rgb).toBeUndefined(); expect(primed.jpeg).toBe(jpeg);
    const crop = { x: 60, y: 60, w: 300, h: 400 }, to = { w: 450, h: 600 };
    const first = await upscaledRgb(x2, prepared.rgb, 500, crop, to), second = await upscaledRgb(x2, prepared.rgb, 500, crop, to);
    const decoded = await sharp(jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer();
    const expected = await sharp(decoded, { raw: { width: region.w * 2, height: region.h * 2, channels: 3 } }).extract({ left: (crop.x - region.x) * 2, top: (crop.y - region.y) * 2, width: crop.w * 2, height: crop.h * 2 }).resize(to.w, to.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
    expect(first!.rgb.equals(expected)).toBe(true);
    expect(second!.rgb.equals(expected)).toBe(true);
    // A JPEG that does not decode is no image: the crop fails (the render then holds), it never throws.
    const bad = storedUpscaler(upscalerId(MODEL, "cpu"), DEFAULT_UPSCALE_MIN_SCALE), other = fixture(500, 700, { x: 50, y: 50, w: 400, h: 600 });
    expect(await primeSourceX2(bad, other.prepared.rgb, 500, Buffer.concat([jpeg.subarray(0, 600)]), region)).toBe(true);
    expect(await upscaledRgb(bad, other.prepared.rgb, 500, crop, to)).toBeNull();
  }, 60_000);
});
