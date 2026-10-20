import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alphaFromPng, BREAKER_COOLDOWN_MS, BREAKER_FAILURES, floodFillMatte, MattingClient, matteFor } from "./matte";
import type { Prepared } from "./render";

function prepared(): Prepared {
  const rgb = Buffer.alloc(48 * 32 * 3, 255);
  for (let y = 8; y < 24; y++) for (let x = 12; x < 36; x++) rgb.fill(20, (y * 48 + x) * 3, (y * 48 + x) * 3 + 3);
  return { rgb, width: 48, height: 32, alphaSource: null, background: { uniform: true, color: [255, 255, 255], stdev: 0 }, flags: [], sourceMime: "image/jpeg" };
}
const servers: Server[] = [];
async function service(target: "cpu" | "gpu", ids = ["general"], inputSize: number | "native" = 64) {
  const state = { fail: false, calls: 0, convert: 0, sent: 0, headers: [] as string[], last: null as Buffer | null };
  const server = createServer(async (req, res) => {
    if (req.url === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, models: ids.map((id) => ({ id, inputSize, target })), default: ids[0], version: target })); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    state.headers.push(req.headers.authorization ?? "");
    if (req.url === "/convert") { state.convert++; res.statusCode = 500; res.end(); return; }
    state.calls++;
    if (state.fail) { res.statusCode = 503; res.end(); return; }
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
beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
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
    cpu.state.fail = true;
    for (let i = 0; i < BREAKER_FAILURES; i++) expect((await matteFor(prepared(), client)).source).toBe("floodfill");
    expect(client.breaker.state).toBe("open");
    const p = prepared(); p.background.uniform = false;
    await expect(matteFor(p, client)).rejects.toThrow("background is not plain");
    gpu.state.fail = false;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + BREAKER_COOLDOWN_MS + 1);
    expect((await matteFor(prepared(), client)).target).toBe("gpu"); expect(client.breakers.gpu).toMatchObject({ state: "closed", failures: 0, openedAt: null });
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
