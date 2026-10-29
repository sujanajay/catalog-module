import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { MattingClient, parseUpscaleHealth, UpscaleUnavailableError } from "./matte";
import { planCanvas, renderKeyInputs, renderSource, type Matte, type Prepared } from "./render";
import { analyseBackground } from "./shadow";
import { enlargeCutout, sharpenAfterEnlarge } from "./enhance";
import { createUpscaler, DEFAULT_UPSCALE_MIN_SCALE, gpuUrlsFromEnv, otherTargetUpscalerId, shouldUpscale, upscaleConfigFromEnv, upscaledRgb, upscalerId, upscalerKey, upscaleTargetFromEnv, UPSCALER_VERSION, type Upscaler } from "./upscale";
import { configuredUpscalerId, renderKey, renderKeys, rerenderedKey, upscaledRenderKey } from "./pipeline/publish";
import { upscaledNotes } from "./pipeline/report";
import { flagDetails } from "./qa/reasons";
import { INFORMATION_FLAGS } from "./qa/triage";
import { INFORMATION_FLAGS as EVAL_INFORMATION_FLAGS } from "./evals/attention";
import { RENDER_FLAGS } from "./auto-resolve";
import { flagReason, UPSCALED_SENTENCE } from "./types";

const MODEL = "realesrgan-x2plus";
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
function fakeUpscaler(factor = 2, fail?: Error): Upscaler & { calls: { w: number; h: number; type: string }[] } {
  const calls: { w: number; h: number; type: string }[] = [];
  return { model: MODEL, minScale: DEFAULT_UPSCALE_MIN_SCALE, calls, async upscale(image, type) {
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
  it("is off unless UPSCALE_MODEL names a model, with a 1.5 default threshold", () => {
    expect(upscaleConfigFromEnv({})).toEqual({ model: null, minScale: 1.5 });
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: "  ", UPSCALE_MIN_SCALE: "" })).toEqual({ model: null, minScale: 1.5 });
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MIN_SCALE: "1.8" })).toEqual({ model: MODEL, minScale: 1.8 });
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MIN_SCALE: "0.5" }).minScale).toBe(1.5);
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_MIN_SCALE: "abc" }).minScale).toBe(1.5);
    const client = { upscale: vi.fn() };
    expect(createUpscaler(client, { model: null, minScale: 1.5 })).toBeNull();
    expect(createUpscaler(client, { model: MODEL, minScale: 1.5 })).toMatchObject({ model: MODEL, minScale: 1.5 });
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
    // A failed call is not retried for the photo's other channels: they all take the plain path.
    const { prepared: p2, matte: m2 } = fixture(), failing = fakeUpscaler(2, new Error("down"));
    for (const channel of ["trendyol", "centrepoint"] as const) expect((await renderSource({ prepared: p2, matte: m2, channel, shotNumber: 1, productType: "other", upscaler: failing })).flags).not.toContain("upscaled");
    expect(failing.calls).toHaveLength(1);
  });
  it("keeps the plain path, byte for byte, when the upscaler is off, below the threshold or failing", async () => {
    const { prepared, matte } = fixture();
    const plain = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other" });
    expect(plain.flags).not.toContain("upscaled"); expect(plain.upscale).toBeUndefined();
    const failing = fakeUpscaler(2, new UpscaleUnavailableError("Upscale failed: Background removal service returned 503."));
    const fellBack = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler: failing, trace: { batchId: "b1", productId: "p1" } });
    expect(failing.calls).toHaveLength(1);
    expect(fellBack.flags).not.toContain("upscaled"); expect(fellBack.upscale).toBeUndefined();
    expect(fellBack.jpeg!.equals(plain.jpeg!)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ batchId: "b1", productId: "p1", shot: 2, channel: "trendyol" });
    expect(line).not.toContain(MODEL);
    // A wrong-size answer is a failure too.
    const wrong = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 2, productType: "other", upscaler: fakeUpscaler(3) });
    expect(wrong.flags).not.toContain("upscaled"); expect(wrong.jpeg!.equals(plain.jpeg!)).toBe(true);
    // Noon caps this photo at 1.5x: the upscaler is never asked.
    const unused = fakeUpscaler(), noon = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "other", upscaler: unused });
    const noonPlain = await renderSource({ prepared, matte, channel: "noon", shotNumber: 2, productType: "other" });
    expect(noon.plan.scale).toBeLessThanOrEqual(1.5); expect(unused.calls).toHaveLength(0);
    expect(noon.flags).toEqual(noonPlain.flags); expect(noon.bytes).toBe(noonPlain.bytes);
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
    // The colour is the upscaler's, sharpened only on opaque pixels with the residual factor (3x / 2 = 1.5x).
    const colour = (await sharp(mixed).raw().toBuffer()), sharpened = await sharpenAfterEnlarge(enlarged!.rgb, size, 1.5), a = await alpha(plain);
    for (const i of [0, Math.floor(size.w * size.h / 2), size.w * size.h - 1]) for (let c = 0; c < 3; c++) expect(colour[i * 4 + c]).toBe((a[i] === 255 ? sharpened : enlarged!.rgb)[i * 3 + c]);
  });
});

describe("render_key", () => {
  const input = { sourceSha256: "abc", channel: "trendyol" as const, n: 1, policyKey: "default|birefnet-general" };
  it("keeps today's key without the upscaler and names the upscaler and its version when used", () => {
    const plain = renderKey(input);
    expect(renderKey({ ...input, upscaler: null })).toBe(plain);
    expect(renderKey({ ...input, upscaler: MODEL })).toBe(upscaledRenderKey(plain, MODEL));
    expect(renderKey({ ...input, upscaler: MODEL })).not.toBe(plain);
    expect(renderKey({ ...input, upscaler: "swinir-x2" })).not.toBe(renderKey({ ...input, upscaler: MODEL }));
    expect(upscalerKey(MODEL)).toBe(`u:${MODEL}@e828354d:${UPSCALER_VERSION}`);
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
    expect(upscalerKey(`${MODEL}+cpu`)).toBe(`u:${MODEL}@e828354d:${UPSCALER_VERSION}:cpu`);
    expect(otherTargetUpscalerId(`${MODEL}+cpu`)).toBe(MODEL);
    const cpuUp = upscaledRenderKey(plain, `${MODEL}+cpu`);
    expect(cpuUp).not.toBe(up);
    expect(rerenderedKey({ renderKey: up, flags: ["upscaled"] }, `${MODEL}+cpu`, recompute)).toBe(cpuUp);
    expect(rerenderedKey({ renderKey: plain, flags: [] }, `${MODEL}+cpu`, recompute)).toBe(cpuUp);
    const k = { sourceSha256: "abc", channel: "trendyol" as const, rulesVersion: "7", policyId: "p", policyUpdatedAt: "t", n: 1 };
    expect(renderKeyInputs(k)).toBe("abc|trendyol|7|p+t|1");
    expect(renderKeyInputs({ ...k, upscaler: MODEL })).toBe(`abc|trendyol|7|p+t|1|u:${MODEL}@e828354d:1`);
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

describe("matting client upscale", () => {
  type Route = (init: RequestInit & { signal: AbortSignal }) => Promise<Response> | Response;
  const health = (target: "cpu" | "gpu", upscale?: unknown) => Response.json({ ok: true, models: [{ id: "general", inputSize: 64, target }], default: "general", version: target, ...(upscale === undefined ? {} : { upscale }) });
  const listed = { models: [{ id: MODEL, available: true, scale: 2 }, { id: "swinir-x2", available: false, scale: 2 }], default: MODEL };
  async function jpeg2x(body: BodyInit | null | undefined) { const meta = await sharp(Buffer.from(body as Uint8Array)).metadata(); return sharp({ create: { width: meta.width! * 2, height: meta.height! * 2, channels: 3, background: "green" } }).jpeg().toBuffer(); }
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
  const image = () => sharp({ create: { width: 10, height: 6, channels: 3, background: "white" } }).png().toBuffer();

  it("types the health upscale section and posts the image to the GPU service", async () => {
    expect(parseUpscaleHealth(undefined)).toBeNull();
    expect(parseUpscaleHealth({ models: [{ id: MODEL, available: true, scale: 2 }, { id: "", available: true, scale: 2 }, { id: "x", available: "yes", scale: 2 }] })).toEqual({ models: [{ id: MODEL, available: true, scale: 2 }], default: null });
    let seen: { type: string | null; url?: string } = { type: null };
    const { c, calls } = client(async init => { seen = { type: new Headers(init.headers).get("content-type") }; return new Response(new Uint8Array(await jpeg2x(init.body)), { headers: { "content-type": "image/jpeg", "x-upscale-model": MODEL, "x-upscale-ms": "321" } }); });
    expect((await c.health()).upscale).toEqual(listed);
    const r = await c.upscale(await image(), { model: MODEL, contentType: "image/png" });
    expect(r).toMatchObject({ model: MODEL, ms: 321 });
    const meta = await sharp(r.jpeg).metadata(); expect([meta.width, meta.height]).toEqual([20, 12]);
    expect(seen.type).toBe("image/png");
    expect(calls.filter(u => u.includes("/upscale"))).toEqual([`http://127.0.0.1:2/upscale?model=${MODEL}&scale=2`]);
  });
  it("never asks without a GPU service or for a model the service does not list as available", async () => {
    const route = vi.fn(() => new Response("{}", { status: 500 }));
    await expect(client(route, { gpu: false }).c.upscale(await image(), { model: MODEL, contentType: "image/png" })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    await expect(client(route).c.upscale(await image(), { model: "swinir-x2", contentType: "image/png" })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    await expect(client(route, { upscale: undefined }).c.upscale(await image(), { model: MODEL, contentType: "image/png" })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    expect(route).not.toHaveBeenCalled();
  });
  it("retries a 503 once after the wait, then gives up and counts one breaker failure", async () => {
    const sleep = vi.fn(async () => undefined);
    let n = 0;
    const ok = client(async init => (++n === 1 ? Response.json({ error: "busy" }, { status: 503 }) : new Response(new Uint8Array(await jpeg2x(init.body)))));
    await expect(ok.c.upscale(await image(), { model: MODEL, contentType: "image/png", sleep })).resolves.toMatchObject({ model: MODEL });
    expect(sleep).toHaveBeenCalledWith(5000); expect(n).toBe(2);
    const down = client(() => Response.json({ error: "unavailable" }, { status: 503 }));
    await expect(down.c.upscale(await image(), { model: MODEL, contentType: "image/png", sleep })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    expect(down.calls.filter(u => u.includes("/upscale"))).toHaveLength(2);
    expect(down.c.upscaleBreaker.failures).toBe(1); expect(down.c.breakers.gpu!.failures).toBe(0);
    // A rejected request (too large) is not the service's fault: no retry, no breaker failure.
    const big = client(() => Response.json({ error: "too large" }, { status: 413 }));
    await expect(big.c.upscale(await image(), { model: MODEL, contentType: "image/png", sleep })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    expect(big.calls.filter(u => u.includes("/upscale"))).toHaveLength(1); expect(big.c.upscaleBreaker.failures).toBe(0);
    // Repeated service failures open the upscale breaker only: the call is skipped, matting is untouched.
    for (let i = 1; i < 5; i++) await expect(down.c.upscale(await image(), { model: MODEL, contentType: "image/png", sleep })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    expect(down.c.upscaleBreaker.openedAt).not.toBeNull(); expect(down.c.breakers.gpu!.state).toBe("closed");
    const before = down.calls.filter(u => u.includes("/upscale")).length;
    await expect(down.c.upscale(await image(), { model: MODEL, contentType: "image/png", sleep })).rejects.toThrow("paused");
    expect(down.calls.filter(u => u.includes("/upscale"))).toHaveLength(before);
  });
  it("times out without a retry and skips the call while the GPU breaker is open", async () => {
    const hang: Route = init => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const slow = client(hang);
    await expect(slow.c.upscale(await image(), { model: MODEL, contentType: "image/png", timeoutMs: 30 })).rejects.toBeInstanceOf(UpscaleUnavailableError);
    expect(slow.calls.filter(u => u.includes("/upscale"))).toHaveLength(1);
    slow.c.breakers.gpu!.state = "open"; slow.c.breakers.gpu!.openedAt = Date.now();
    await expect(slow.c.upscale(await image(), { model: MODEL, contentType: "image/png", timeoutMs: 30 })).rejects.toThrow("paused");
    expect(slow.calls.filter(u => u.includes("/upscale"))).toHaveLength(1);
  });
  it("sends /upscale to the CPU cut-out service when UPSCALE_URL names it (spec 16 3.1.3)", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url); calls.push(u);
      if (u.endsWith("/health")) return health(u.includes(":2") ? "gpu" : "cpu", listed);
      return new Response(new Uint8Array(await jpeg2x(init!.body)), { headers: { "x-upscale-ms": "6100" } });
    }) as unknown as typeof globalThis.fetch;
    const services = [{ baseUrl: "http://127.0.0.1:1", target: "cpu" as const }, { baseUrl: "http://127.0.0.1:2", target: "gpu" as const }];
    const cpu = new MattingClient({ services, fetch, upscaleUrl: "http://127.0.0.1:1/" });
    expect(cpu.upscaleTarget).toBe("cpu");
    await expect(cpu.upscale(await image(), { model: MODEL, contentType: "image/png" })).resolves.toMatchObject({ ms: 6100 });
    expect(calls.filter(u => u.includes("/upscale"))).toEqual([`http://127.0.0.1:1/upscale?model=${MODEL}&scale=2`]);
    // The worker's upscaler carries the CPU id, so its render_key differs from a GPU-made image's.
    expect(createUpscaler(cpu, { model: MODEL, minScale: 1.5 })!.model).toBe(`${MODEL}+cpu`);
    // Unset keeps the GPU service; spec 18 H2: an URL that names no matting service is the dedicated CPU service.
    expect(new MattingClient({ services, fetch, upscaleUrl: null }).upscaleTarget).toBe("gpu");
    expect(new MattingClient({ services, fetch, upscaleUrl: "https://elsewhere.example" }).upscaleTarget).toBe("cpu");
    expect(warn).not.toHaveBeenCalled();
    // Without a GPU service, the CPU service named by UPSCALE_URL still upscales.
    expect(new MattingClient({ services: [services[0]!], fetch, upscaleUrl: "http://127.0.0.1:1" }).upscaleTarget).toBe("cpu");
  });
  it("never calls the dedicated CPU service when UPSCALE_URL names no matting service: the enlarge stage does (spec 18 H2)", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url); calls.push(u);
      if (u.endsWith("/health")) return health(u.includes(":2") ? "gpu" : "cpu", u.includes(":3") ? listed : undefined);
      return new Response(new Uint8Array(await jpeg2x(init!.body)), { headers: { "x-upscale-ms": "90000" } });
    }) as unknown as typeof globalThis.fetch;
    const services = [{ baseUrl: "http://127.0.0.1:1", target: "cpu" as const }, { baseUrl: "http://127.0.0.1:2", target: "gpu" as const }];
    const c = new MattingClient({ services, fetch, upscaleUrl: "http://127.0.0.1:3/" });
    // Its render keys stay the CPU ones; the call itself is an explicit refusal, never a request.
    expect(c.upscaleTarget).toBe("cpu");
    expect(createUpscaler(c, { model: MODEL, minScale: 1.5 })!.model).toBe(`${MODEL}+cpu`);
    await expect(c.upscale(await image(), { model: MODEL, contentType: "image/png" })).rejects.toThrow("served by the enlarge stage");
    // No /health fan-out to it and no breaker state: the cut-out services alone.
    expect((await c.health()).models.map((m) => m.target).sort()).toEqual(["cpu", "gpu"]);
    expect(calls.some((u) => u.includes(":3"))).toBe(false);
    expect(c.upscaleBreaker).toEqual({ failures: 0, openedAt: null });
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
    expect(upscaleConfigFromEnv({ UPSCALE_MODEL: MODEL, UPSCALE_URL: "https://cpu.example", MATTING_URL: "https://cpu.example" })).toEqual({ model: MODEL, minScale: 1.5, target: "cpu" });
    expect(configuredUpscalerId({ UPSCALE_MODEL: MODEL, UPSCALE_URL: "https://cpu.example", MATTING_URL: "https://cpu.example" })).toBe(`${MODEL}+cpu`);
    expect(configuredUpscalerId({ UPSCALE_MODEL: MODEL })).toBe(MODEL);
    expect(configuredUpscalerId({})).toBeNull();
  });
  it("falls back to the plain bytes in the render on a 503 and on a timeout", async () => {
    const { prepared, matte } = fixture();
    const plain = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other" });
    const down = client(() => Response.json({ error: "unavailable" }, { status: 503 }));
    const viaClient = (c: MattingClient, extra: { timeoutMs?: number } = {}): Upscaler => ({ model: MODEL, minScale: 1.5, upscale: async (img, contentType) => c.upscale(img, { model: MODEL, contentType, sleep: async () => undefined, ...extra }) });
    const a = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: viaClient(down.c) });
    const hang = client(init => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
    const b = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: viaClient(hang.c, { timeoutMs: 30 }) });
    for (const out of [a, b]) { expect(out.flags).not.toContain("upscaled"); expect(out.upscale).toBeUndefined(); expect(out.jpeg!.equals(plain.jpeg!)).toBe(true); }
    expect(warn).toHaveBeenCalledTimes(2);
    // The worker's upscaler goes through the same client.
    const ok = client(async init => new Response(new Uint8Array(await jpeg2x(init.body)), { headers: { "x-upscale-ms": "7" } }));
    const up = await renderSource({ prepared, matte, channel: "trendyol", shotNumber: 1, productType: "other", upscaler: createUpscaler(ok.c, { model: MODEL, minScale: 1.5 }) });
    expect(up.flags).toContain("upscaled"); expect(up.upscale).toEqual({ model: MODEL, ms: 7 });
  });
});
