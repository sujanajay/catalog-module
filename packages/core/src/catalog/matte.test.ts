import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alphaFromPng, BREAKER_COOLDOWN_MS, BREAKER_FAILURES, busyWaitMs, floodFillMatte, MattingClient, mattingClientFromEnv, matteFor, TRACE_HEADERS } from "./matte";
import type { Prepared } from "./render";

function prepared(): Prepared {
  const rgb = Buffer.alloc(48 * 32 * 3, 255);
  for (let y = 8; y < 24; y++) for (let x = 12; x < 36; x++) rgb.fill(20, (y * 48 + x) * 3, (y * 48 + x) * 3 + 3);
  return { rgb, width: 48, height: 32, alphaSource: null, background: { uniform: true, color: [255, 255, 255], stdev: 0 }, flags: [], sourceMime: "image/jpeg" };
}
const servers: Server[] = [];
async function service(target: "cpu" | "gpu", ids = ["general"], inputSize: number | "native" = 64) {
  const state = { fail: false, calls: 0, convert: 0, sent: 0, headers: [] as string[], last: null as Buffer | null, statuses: [] as number[], delayMs: 0, active: 0, peak: 0 };
  const server = createServer(async (req, res) => {
    if (req.url === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, models: ids.map((id) => ({ id, inputSize, target })), default: ids[0], version: target })); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    state.headers.push(req.headers.authorization ?? "");
    if (req.url === "/convert") { state.convert++; res.statusCode = 500; res.end(); return; }
    state.calls++;
    if (state.fail) { res.statusCode = 503; res.end(); return; }
    const status = state.statuses.shift();
    if (status) { res.statusCode = status; res.end(); return; }
    state.active++; state.peak = Math.max(state.peak, state.active);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    state.active--;
    const request = new Request("http://localhost", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks) });
    const file = (await request.formData()).get("file") as File;
    state.last = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(state.last).metadata();
    state.sent = Math.max(metadata.width!, metadata.height!);
    const mask = await sharp({ create: { width: metadata.width!, height: metadata.height!, channels: 3, background: "white" } }).greyscale().png().toBuffer();
    res.setHeader("x-ms", "12"); res.end(mask);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address() as { port: number };
  return { ...state, state, baseUrl: `http://127.0.0.1:${address.port}`, target };
}
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

describe("matting client", () => {
  it("prefers GPU, sizes its PNG by health and upscales the mask to source dimensions", async () => {
    const cpu = await service("cpu", ["general", "cpu-only"]), gpu = await service("gpu");
    const client = new MattingClient({ services: [cpu, gpu] });
    const result = await client.matte(prepared(), "general");
    expect(result).toMatchObject({ width: 48, height: 32, target: "gpu", sentLongSide: 64, ms: 12 });
    expect(result.alpha.length).toBe(48 * 32); expect(gpu.state.sent).toBe(64); expect(cpu.state.calls).toBe(0);
    expect((await client.matte(prepared(), "cpu-only")).target).toBe("cpu");
    await expect(client.matte(prepared(), "missing")).rejects.toThrow("Unknown background removal model");
  });
  it("frames the photo in a white border for a padded matte and crops the mask back to the photo", async () => {
    const cpu = await service("cpu"), client = new MattingClient({ services: [cpu] });
    const result = await client.matte(prepared(), "general", { padFraction: 0.2 });
    // 48x32 plus 10 px each side is 68x52, sent at the model's 64 px long side.
    const sent = await sharp(cpu.state.last!).raw().toBuffer({ resolveWithObject: true });
    expect([sent.info.width, sent.info.height]).toEqual([64, 49]);
    expect([...sent.data.subarray(0, 3)]).toEqual([255, 255, 255]);
    expect(result).toMatchObject({ width: 48, height: 32, sentLongSide: 64 });
    expect(result.alpha.length).toBe(48 * 32);
    expect(Math.min(...result.alpha)).toBeGreaterThan(240);
    // matteFor passes the option through.
    expect((await matteFor(prepared(), client, "general", { padFraction: 0.2 })).alpha.length).toBe(48 * 32);
  });
  it.each([1024, 2048, "native"] as const)("uses advertised %s input size and native bounds", async (size) => {
    const cpu = await service("cpu", ["test"], size), client = new MattingClient({ services: [cpu] });
    await client.health();
    expect([300, 1000, 5000].map((n) => client.sendLongSide("test", { w: n, h: 100 }))).toEqual(size === "native" ? [288, 992, 2304] : [size, size, size]);
  });
  it("keeps breakers separate, falls back safely, and closes a recovered half-open service", async () => {
    const cpu = await service("cpu"), gpu = await service("gpu"), client = new MattingClient({ services: [cpu, gpu] });
    gpu.state.fail = true;
    for (let i = 0; i < BREAKER_FAILURES; i++) expect((await matteFor(prepared(), client)).target).toBe("cpu");
    expect(client.breakers.gpu?.state).toBe("open"); expect(client.breaker.state).toBe("closed");
    // Log contract: key `message` (never `event`), WARNING when open, no batchId (the breaker is process-wide), and
    // (spec 17 3.3.5) the model and status of the call that opened it.
    const opened = vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((l) => l.message === "matting_breaker");
    expect(opened).toEqual([{ severity: "WARNING", message: "matting_breaker", service: "gpu", state: "open", model: "general", status: 503 }]);
    cpu.state.fail = true;
    for (let i = 0; i < BREAKER_FAILURES; i++) expect((await matteFor(prepared(), client)).source).toBe("floodfill");
    expect(client.breaker.state).toBe("open");
    const p = prepared(); p.background.uniform = false;
    await expect(matteFor(p, client)).rejects.toThrow("background is not plain");
    gpu.state.fail = false;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + BREAKER_COOLDOWN_MS + 1);
    expect((await matteFor(prepared(), client)).target).toBe("gpu"); expect(client.breakers.gpu).toMatchObject({ state: "closed", failures: 0, openedAt: null });
    const recovered = vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((l) => l.message === "matting_breaker" && l.service === "gpu");
    expect(recovered).toEqual([{ severity: "INFO", message: "matting_breaker", service: "gpu", state: "half-open" }, { severity: "INFO", message: "matting_breaker", service: "gpu", state: "closed" }]);
  });
  it("counts failures per (service, model) while another model keeps the service healthy (spec 17 3.3.5)", async () => {
    const cpu = await service("cpu", ["general", "bria"]), gpu = await service("gpu", ["general", "bria"]);
    const client = new MattingClient({ services: [cpu, gpu] });
    const warnings = () => vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    // bria always fails on the GPU (500), general always works: the GPU breaker never opens, bria still falls back.
    for (let i = 0; i < BREAKER_FAILURES + 1; i++) {
      gpu.state.statuses.push(500);
      expect((await client.matte(prepared(), "bria")).target).toBe("cpu");
      expect((await client.matte(prepared(), "general")).target).toBe("gpu");
    }
    expect(client.breakers.gpu).toMatchObject({ state: "closed", failures: 0 });
    expect(client.modelFailures).toEqual([{ service: "gpu", model: "bria", failures: BREAKER_FAILURES + 1 }]);
    expect(warnings()).toEqual([{ severity: "WARNING", message: "matting_model_failing", service: "gpu", model: "bria", status: 500, failures: BREAKER_FAILURES }]);
    // A success of that model on that service clears its count.
    expect((await client.matte(prepared(), "bria")).target).toBe("gpu");
    expect(client.modelFailures).toEqual([]);
  });
  it("names the model and a missing status when a timeout opens the breaker", async () => {
    const cpu = await service("cpu"), gpu = await service("gpu");
    gpu.state.delayMs = 3000;
    const client = new MattingClient({ services: [cpu, gpu], timeoutMs: 1000 });
    await client.health();
    for (let i = 0; i < BREAKER_FAILURES; i++) expect((await client.matte(prepared(), "general")).target).toBe("cpu");
    const opened = vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((l) => l.message === "matting_breaker");
    expect(opened).toEqual([{ severity: "WARNING", message: "matting_breaker", service: "gpu", state: "open", model: "general", status: null }]);
  });
  it("takes the GPU services in turn (spec 16 3.1.5)", async () => {
    const cpu = await service("cpu"), a = await service("gpu"), b = await service("gpu");
    const client = new MattingClient({ services: [cpu, a, b] });
    for (let i = 0; i < 4; i++) expect((await client.matte(prepared(), "general")).target).toBe("gpu");
    expect([a.state.calls, b.state.calls, cpu.state.calls]).toEqual([2, 2, 0]);
    expect((await client.health()).models).toEqual([{ id: "general", inputSize: 64, target: "cpu" }, { id: "general", inputSize: 64, target: "gpu" }]);
    // One service down: its breaker opens, the other GPU service keeps every photo.
    a.state.fail = true;
    for (let i = 0; i < 2 * BREAKER_FAILURES; i++) expect((await client.matte(prepared(), "general")).target).toBe("gpu");
    expect(client.gpuBreakers.map((x) => x.state)).toEqual(["open", "closed"]);
    expect(cpu.state.calls).toBe(0);
  });
  it("waits after a busy GPU answer, and only three busy answers in a row reach the CPU service", async () => {
    const cpu = await service("cpu"), gpu = await service("gpu");
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = new MattingClient({ services: [cpu, gpu], sleep });
    gpu.state.statuses.push(429);
    expect((await client.matte(prepared(), "general")).target).toBe("gpu");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(1000); expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(3000);
    expect(client.breakers.gpu).toMatchObject({ failures: 0, state: "closed" });
    gpu.state.statuses.push(429, 429, 429);
    expect((await client.matte(prepared(), "general")).target).toBe("cpu");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(client.breakers.gpu!.failures).toBe(1);
    expect([busyWaitMs(0), busyWaitMs(1)]).toEqual([1000, 3000]);
  });
  it("keeps at most the in-flight limit of calls on one GPU service", async () => {
    const cpu = await service("cpu"), gpu = await service("gpu");
    gpu.state.delayMs = 40;
    const client = new MattingClient({ services: [cpu, gpu], inflightPerService: 2 });
    const results = await Promise.all(Array.from({ length: 5 }, () => client.matte(prepared(), "general")));
    expect(results.every((r) => r.target === "gpu")).toBe(true);
    expect(gpu.state.peak).toBe(2);
  });
  it("builds the worker client from the environment", async () => {
    const cpu = await service("cpu"), a = await service("gpu"), b = await service("gpu");
    const list = mattingClientFromEnv({ MATTING_URL: cpu.baseUrl, MATTING_GPU_URLS: `${a.baseUrl}, ${b.baseUrl}/`, MATTING_GPU_URL: "http://ignored.example", UPSCALE_URL: cpu.baseUrl });
    expect(list.gpuBreakers).toHaveLength(2); expect(list.upscaleTarget).toBe("cpu");
    const single = mattingClientFromEnv({ MATTING_URL: cpu.baseUrl, MATTING_GPU_URL: a.baseUrl });
    expect(single.gpuBreakers).toHaveLength(1); expect(single.upscaleTarget).toBe("gpu");
    expect(mattingClientFromEnv({ MATTING_URL: cpu.baseUrl }).gpuBreakers).toHaveLength(0);
    expect(() => new MattingClient({ services: [cpu, { baseUrl: cpu.baseUrl, target: "cpu" }] })).toThrow("only one CPU");
  });
  it("convert bypasses the breaker and failures do not increment it", async () => {
    const cpu = await service("cpu"), client = new MattingClient({ services: [cpu] });
    await expect(client.convert(Buffer.from("heic"))).rejects.toThrow();
    expect(cpu.state.convert).toBe(1); expect(client.breaker.failures).toBe(0);
  });
  it("uses a separate OIDC audience for each remote URL and none for local hosts", async () => {
    const audiences: string[] = [];
    const local = await service("cpu");
    await new MattingClient({ services: [local], idToken: async (a) => { audiences.push(a); return "fake"; } }).health();
    expect(audiences).toEqual([]);
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake");
      const target = String(input).includes("gpu") ? "gpu" : "cpu";
      return Response.json({ ok: true, models: [{ id: "general", inputSize: 1024, target }], default: "general", version: "test" });
    });
    await new MattingClient({ services: [{ baseUrl: "https://cpu.example", target: "cpu" }, { baseUrl: "https://gpu.example", target: "gpu" }], fetch: fakeFetch, idToken: async (a) => { audiences.push(a); return "fake"; } }).health();
    expect(audiences.sort()).toEqual(["https://cpu.example", "https://gpu.example"]);
  });
  it("finishes healthy CPU discovery when GPU token acquisition never resolves", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ok: true, models: [{ id: "general", inputSize: 64, target: "cpu" }], default: "general", version: "cpu" }));
    const client = new MattingClient({
      services: [{ baseUrl: "https://cpu.example", target: "cpu" }, { baseUrl: "https://gpu.example", target: "gpu" }],
      timeoutMs: 10, fetch: request,
      idToken: async (audience) => audience.includes("gpu") ? new Promise<string>(() => {}) : "cpu-token",
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([client.health(), new Promise<"pending">((resolve) => { watchdog = setTimeout(() => resolve("pending"), 200); })]);
      expect(result).toMatchObject({ ok: true, default: "general", versions: { cpu: "cpu", gpu: null } });
      expect(client.breakers.gpu).toMatchObject({ failures: 1, state: "closed" });
      expect(client.breaker.failures).toBe(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(String(request.mock.calls[0]![0])).toBe("https://cpu.example/health");
      expect(new Headers(request.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer cpu-token");
    } finally { clearTimeout(watchdog); }
  });
  it("rejects expired conversion authentication and never sends a late token", async () => {
    let releaseToken!: (value: string) => void;
    const request = vi.fn<typeof fetch>();
    const client = new MattingClient({
      services: [{ baseUrl: "https://cpu.example", target: "cpu" }], timeoutMs: 10, fetch: request,
      idToken: () => new Promise<string>((resolve) => { releaseToken = resolve; }),
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.convert(Buffer.from("heic")).then(() => "sent", (error: unknown) => error),
        new Promise<"pending">((resolve) => { watchdog = setTimeout(() => resolve("pending"), 200); }),
      ]);
      expect(result).toMatchObject({ name: "TimeoutError" });
      releaseToken("late-token");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(request).not.toHaveBeenCalled();
      expect(client.breaker.failures).toBe(0);
    } finally { clearTimeout(watchdog); }
  });
  it("refuses a worker client without a CPU URL", () => expect(() => new MattingClient({ services: [] })).toThrow("MATTING_URL"));
  it("falls back when CPU discovery is unavailable even while GPU health is available", async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url).includes("cpu") ? new Response(null, { status: 503 }) : Response.json({ ok: true, models: [{ id: "general", inputSize: 64, target: "gpu" }], default: "general", version: "test" }));
    const client = new MattingClient({ services: [{ baseUrl: "http://localhost/cpu", target: "cpu" }, { baseUrl: "http://localhost/gpu", target: "gpu" }], fetch: request });
    expect((await matteFor(prepared(), client)).source).toBe("floodfill");
  });
  it("falls back for total discovery outage, but refuses a nonuniform source", async () => {
    const client = new MattingClient({ services: [{ baseUrl: "http://localhost", target: "cpu" }], fetch: async () => { throw new Error("connection refused"); } });
    expect((await matteFor(prepared(), client)).source).toBe("floodfill");
    const p = prepared(); p.background.uniform = false;
    await expect(matteFor(p, client)).rejects.toThrow("background is not plain");
  });
  it("keeps request rejections outside the breaker and returns successful conversion bytes", async () => {
    const client = new MattingClient({ services: [{ baseUrl: "http://localhost", target: "cpu" }], fetch: async (url) => {
      if (String(url).endsWith("/health")) return Response.json({ ok: true, models: [{ id: "test", inputSize: 64, target: "cpu" }], default: "test", version: "test" });
      if (String(url).endsWith("/convert")) return new Response("converted");
      return new Response(null, { status: 400 });
    } });
    await expect(matteFor(prepared(), client)).rejects.toThrow("rejected (400)");
    expect(client.breaker.failures).toBe(0);
    expect((await client.convert(Buffer.from("heic"))).toString()).toBe("converted");
  });
  it("counts a timed-out matte as one service failure", async () => {
    const client = new MattingClient({ services: [{ baseUrl: "http://localhost", target: "cpu" }], timeoutMs: 10, fetch: async (url, init) => {
      if (String(url).endsWith("/health")) return Response.json({ ok: true, models: [{ id: "test", inputSize: 64, target: "cpu" }], default: "test", version: "test" });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    } });
    expect((await matteFor(prepared(), client)).source).toBe("floodfill"); expect(client.breaker.failures).toBe(1);
  });
});

it("flood fills border-connected background, keeps product interior and prefers source alpha", async () => {
  const p = prepared(), matte = floodFillMatte(p);
  expect(matte.alpha[0]).toBe(0); expect(matte.alpha[16 * 48 + 24]).toBe(255);
  p.alphaSource = Buffer.alloc(48 * 32, 123);
  expect(await matteFor(p, null)).toMatchObject({ source: "alpha_source", alpha: p.alphaSource });
  const png = await sharp(Buffer.from([0, 255]), { raw: { width: 2, height: 1, channels: 1 } }).png().toBuffer();
  expect(await alphaFromPng(png)).toEqual({ alpha: Buffer.from([0, 255]), width: 2, height: 1 });
});

describe("per-call trace headers", () => {
  const upscale = { models: [{ id: "x2", available: true, scale: 2 }], default: "x2" };
  function recorder() {
    const seen: { path: string; batch: string | null; product: string | null }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const u = new URL(String(url)), headers = new Headers(init?.headers);
      seen.push({ path: u.pathname, batch: headers.get(TRACE_HEADERS.batchId), product: headers.get(TRACE_HEADERS.productId) });
      const target = u.hostname === "cpu.local" ? "cpu" : "gpu";
      if (u.pathname === "/health") return Response.json({ ok: true, models: [{ id: "general", inputSize: 64, target }], default: "general", version: "v", ...(target === "gpu" ? { upscale } : {}) });
      if (u.pathname === "/matte") return new Response(new Uint8Array(await sharp({ create: { width: 64, height: 43, channels: 3, background: "white" } }).png().toBuffer()), { headers: { "x-ms": "5" } });
      if (u.pathname === "/upscale") return new Response(new Uint8Array([1, 2, 3]), { headers: { "x-upscale-ms": "7" } });
      return new Response(new Uint8Array([9]));
    });
    return { seen, client: new MattingClient({ services: [{ baseUrl: "http://cpu.local", target: "cpu" }, { baseUrl: "http://gpu.local", target: "gpu" }], fetch, idToken: async () => "token" }) };
  }
  it("sends x-catalog-batch and x-catalog-product on /matte, /convert and /upscale, and not on /health", async () => {
    const { seen, client } = recorder(), trace = { batchId: "b1", productId: "p1" };
    expect((await matteFor(prepared(), client, "general", {}, trace)).source).toBe("model");
    await client.convert(Buffer.from([1]), trace);
    await client.upscale(Buffer.from([1]), { model: "x2", contentType: "image/jpeg" }, trace);
    const traced = seen.filter((s) => s.path !== "/health");
    expect(traced.map((s) => s.path)).toEqual(["/matte", "/convert", "/upscale"]);
    expect(traced.every((s) => s.batch === "b1" && s.product === "p1")).toBe(true);
    expect(seen.filter((s) => s.path === "/health").every((s) => s.batch === null && s.product === null)).toBe(true);
  });
  it("sends no trace headers when the caller gives no ids", async () => {
    const { seen, client } = recorder();
    await client.matte(prepared(), "general"); await client.convert(Buffer.from([1]));
    expect(seen.every((s) => s.batch === null && s.product === null)).toBe(true);
  });
});
