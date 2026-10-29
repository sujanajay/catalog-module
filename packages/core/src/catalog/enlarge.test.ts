// Spec 18 H2: the catalog-upscale client with a fake fetch: no network, no /health, no breaker.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPSCALE_TIMEOUT_S, ENLARGE_ATTEMPT_FLOOR_MS, ENLARGE_TASK_MARGIN_MS, ENLARGE_UNAVAILABLE_RETRY_MS, EnlargeBadInputError, EnlargeBusyError, enlargeBackoffMs, EnlargeError,
  EnlargeModelUnavailableError, EnlargeRejectedError, EnlargeServerError, enlargeTimeoutMs, EnlargeTimeoutError, enlargeViaService, upscaleServerTimeoutS,
  type EnlargeDeps,
} from "./enlarge";
import { ENLARGE_DISPATCH_DEADLINE_SEC } from "../tasks";

// The default fetch is undici's with a dispatcher whose own timeouts are off; tests that pass no fetch reach this fake.
const undici = vi.hoisted(() => {
  const agents: unknown[] = [];
  return {
    agents,
    Agent: vi.fn(function (this: { options: unknown }, options: unknown) { this.options = options; agents.push(this); }),
    fetch: vi.fn(async (_url: string, _init: Record<string, unknown>) => new Response(new Uint8Array([0xff, 0xd8, 9, 0xff, 0xd9]), { headers: { "x-upscale-ms": "5" } })),
  };
});
vi.mock("undici", () => ({ Agent: undici.Agent, fetch: undici.fetch }));

afterEach(() => { vi.useRealTimers(); });

const URL_ = "https://catalog-upscale-abc-el.a.run.app";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const X2 = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

type Answer = number | "ok" | "hang" | "throw" | "unavailable";
/** A fake fetch answering one entry of `answers` per call (the last repeats); records every call. */
function fakeService(answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer === "hang") {
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }
    if (answer === "throw") throw new TypeError("fetch failed");
    // The service's own 503 (app.py upscale_error); a plain 503 below is Cloud Run's busy answer.
    if (answer === "unavailable") return Response.json({ error: "upscale model swinir-x2 unavailable" }, { status: 503 });
    if (answer === "ok") return new Response(new Uint8Array(X2), { headers: { "content-type": "image/jpeg", "x-upscale-ms": "118000", "x-upscale-model": "swinir-x2" } });
    return Response.json({ error: "x" }, { status: answer });
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps: EnlargeDeps = {
    fetch, idToken: async (audience) => `token-for-${audience}`, random: () => 0,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock,
  };
  return { calls, sleeps, deps, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("enlargeViaService", () => {
  it("posts the JPEG with an ID token for the service URL and returns the service's answer", async () => {
    const s = fakeService(["ok"]);
    const r = await enlargeViaService({ url: `${URL_}/`, jpeg: JPEG, model: "swinir-x2", trace: { batchId: "b1", productId: "p1" } }, s.deps);
    expect(r).toEqual({ jpeg: X2, ms: 118000, model: "swinir-x2", attempts: 1 });
    expect(s.calls).toHaveLength(1);
    const { url, init } = s.calls[0]!;
    expect(url).toBe(`${URL_}/upscale?model=swinir-x2&scale=2`);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer token-for-${URL_}`);
    expect(headers.get("content-type")).toBe("image/jpeg");
    expect(headers.get("x-catalog-batch")).toBe("b1");
    expect(headers.get("x-catalog-product")).toBe("p1");
    // Never /health: the call itself is the only request.
    expect(s.calls.some((c) => c.url.endsWith("/health"))).toBe(false);
  });

  it("uses the service URL as the audience also for a candidate tag URL, and no token on localhost", async () => {
    const s = fakeService(["ok"]);
    await enlargeViaService({ url: "https://measure-4c-4t-1r---catalog-upscale-abc-el.a.run.app", jpeg: JPEG, model: "swinir-x2" }, s.deps);
    expect(new Headers(s.calls[0]!.init.headers).get("authorization")).toBe(`Bearer token-for-${URL_}`);
    await enlargeViaService({ url: "http://127.0.0.1:8081", jpeg: JPEG, model: "swinir-x2" }, s.deps);
    expect(new Headers(s.calls[1]!.init.headers).get("authorization")).toBeNull();
  });

  it("retries busy, server errors and transport failures with exponential backoff, then succeeds", async () => {
    const s = fakeService([429, 503, 500, "throw", "ok"]);
    const r = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 60_000 }, s.deps);
    expect(r.attempts).toBe(5);
    expect(s.sleeps).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it("the default fetch is undici's with headers and body timeouts off, so only the attempt timeout limits a call", async () => {
    const r = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2" }, { idToken: async () => "t" });
    expect(r.attempts).toBe(1);
    expect(undici.fetch).toHaveBeenCalledTimes(1);
    const init = undici.fetch.mock.calls[0]![1];
    expect(undici.agents).toHaveLength(1);
    expect(init.dispatcher).toBe(undici.agents[0]);
    expect((undici.agents[0] as { options: unknown }).options).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // One shared dispatcher for every call.
    await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2" }, { idToken: async () => "t" });
    expect(undici.Agent).toHaveBeenCalledTimes(1);
    expect(undici.fetch.mock.calls[1]![1].dispatcher).toBe(undici.agents[0]);
  });

  it("never retries a bad image or a refused call", async () => {
    for (const [status, type] of [[400, EnlargeBadInputError], [413, EnlargeBadInputError], [401, EnlargeRejectedError], [403, EnlargeRejectedError], [404, EnlargeRejectedError]] as const) {
      const s = fakeService([status, "ok"]);
      const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2" }, s.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ status, retryable: false, attempts: 1 });
      expect(s.calls).toHaveLength(1);
    }
  });

  it("gives up after the attempt cap with the last typed error", async () => {
    for (const status of [503, 429]) {
      const s = fakeService([status]);
      const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 60_000, maxAttempts: 3 }, s.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EnlargeBusyError);
      expect(error).toMatchObject({ kind: "busy", status, retryable: true, attempts: 3 });
      expect(s.calls).toHaveLength(3);
      expect(s.sleeps).toEqual([10_000, 20_000]);
    }
  });

  it("the deadline defaults to the enlarge task's dispatch deadline from the call; the attempt cap is only a second limit", async () => {
    // 400 s attempts within the default 1770 s: 0-400, 410-810, 830-1230, 1270-1670; a fifth would start after a 60 s
    // wait with 40 s left, under ENLARGE_ATTEMPT_FLOOR_MS.
    const s = fakeService([503]);
    const started = s.now();
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 400_000, maxAttempts: 10 }, {
      ...s.deps, fetch: (async (url: string, init: RequestInit) => { s.advance(400_000); return s.deps.fetch!(url, init); }) as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeBusyError);
    expect(s.calls).toHaveLength(4);
    expect(s.now() - started).toBeLessThanOrEqual(ENLARGE_DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS);
    // With today's default timeout (1770 s, as long as the 1770 s left) the attempt is clamped to the time left, and a
    // busy answer is retried while at least ENLARGE_ATTEMPT_FLOOR_MS is left (2026-10-29 review, P0).
    const one = fakeService([503]);
    const only = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", maxAttempts: 3 }, one.deps).catch((e: unknown) => e);
    expect(only).toMatchObject({ kind: "busy", attempts: 3 });
    expect(one.calls).toHaveLength(3);
  });

  it("the service's own model-unavailable 503 is not busy: one retry after 60 s, then a typed non-retryable error", async () => {
    const s = fakeService(["unavailable"]);
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 60_000, maxAttempts: 5 }, s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeModelUnavailableError);
    expect(error).toMatchObject({ kind: "unavailable", status: 503, retryable: false, attempts: 2 });
    expect(s.calls).toHaveLength(2);
    expect(s.sleeps).toEqual([ENLARGE_UNAVAILABLE_RETRY_MS]);
    // A model that loads meanwhile passes on the retry.
    const later = fakeService(["unavailable", "ok"]);
    await expect(enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 60_000 }, later.deps)).resolves.toMatchObject({ attempts: 2 });
  });

  it("a token-mint failure is a retryable server error and sends nothing", async () => {
    const s = fakeService(["ok"]);
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", maxAttempts: 1 }, {
      ...s.deps, idToken: async () => { throw new Error("metadata server down"); },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeServerError);
    expect(error).toMatchObject({ kind: "server", retryable: true, attempts: 1 });
    expect((error as Error).message).not.toContain("metadata server down");
    expect(s.calls).toHaveLength(0);
  });

  it("a token mint that hangs ends with the attempt's timeout, not later", async () => {
    const s = fakeService(["ok"]);
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 20, maxAttempts: 1 }, {
      ...s.deps, idToken: () => new Promise<string>(() => undefined),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeTimeoutError);
    expect(s.calls).toHaveLength(0);
  });

  it("times out an attempt at its timeout, as a retryable timeout", async () => {
    const s = fakeService(["hang"]);
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 20, maxAttempts: 2 }, s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeTimeoutError);
    expect(error).toMatchObject({ kind: "timeout", retryable: true, attempts: 2 });
    expect(s.calls).toHaveLength(2);
  });

  it("clamps each attempt's timeout to the time left and starts none with less than the floor left", async () => {
    // 100 s attempts, a deadline 150 s away; the fake clock moves only with the backoff waits. Attempt 2 starts at 10 s
    // (140 s left), 3 at 30 s (120 s), 4 at 70 s (80 s left: clamped to 80 s); after the next 60 s wait only 20 s would
    // be left, below the 60 s floor, so the busy error stands.
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      const s = fakeService([503]);
      const deadlineAt = s.now() + 150_000;
      const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 100_000, deadlineAt, maxAttempts: 10 }, s.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EnlargeBusyError);
      expect(s.calls).toHaveLength(4);
      expect(s.sleeps).toEqual([10_000, 20_000, 40_000]);
      expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([100_000, 100_000, 100_000, 80_000]);
    } finally { timeouts.mockRestore(); }
    // Less than the floor left before the deadline: no call at all.
    const late = fakeService(["ok"]);
    const none = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 100_000, deadlineAt: late.now() + ENLARGE_ATTEMPT_FLOOR_MS - 1 }, late.deps).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(EnlargeTimeoutError);
    expect(late.calls).toHaveLength(0);
    // The floor and above: one call, its timeout the time left.
    const edge = fakeService(["ok"]);
    await expect(enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 100_000, deadlineAt: edge.now() + ENLARGE_ATTEMPT_FLOOR_MS }, edge.deps)).resolves.toMatchObject({ attempts: 1 });
  });

  it("rethrows the caller's abort as it is and stops retrying", async () => {
    const s = fakeService(["hang"]);
    const controller = new AbortController();
    const reason = new Error("task ending");
    const pending = enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", signal: controller.signal, timeoutMs: 60_000 }, s.deps);
    setTimeout(() => controller.abort(reason), 5);
    await expect(pending).rejects.toBe(reason);
    expect(s.calls).toHaveLength(1);
  });

  it("an abort during a backoff wait ends the call there (default sleep, fake timers): exactly one fetch", async () => {
    vi.useFakeTimers();
    const s = fakeService([503, "ok"]);
    const controller = new AbortController();
    const reason = new Error("task ending");
    const { sleep: _sleep, ...deps } = s.deps;
    const pending = enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", signal: controller.signal, timeoutMs: 60_000 }, { ...deps, now: Date.now });
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.calls).toHaveLength(1);
    controller.abort(reason);
    expect(await settled).toBe(reason);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls).toHaveLength(1);
  });

  it("the default sleep waits the backoff (fake timers)", async () => {
    vi.useFakeTimers();
    const s = fakeService([503, "ok"]);
    const { sleep: _sleep, ...deps } = s.deps;
    const pending = enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 60_000 }, { ...deps, now: Date.now });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ attempts: 2 });
    expect(s.calls).toHaveLength(2);
  });

  it("an empty 200 is a server error", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })) as unknown as typeof globalThis.fetch;
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", maxAttempts: 1 }, { fetch, idToken: async () => "t" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeServerError);
    expect(error).toBeInstanceOf(EnlargeError);
  });
});

describe("enlargement timeouts", () => {
  it("the client waits the service timeout plus 30 s", () => {
    expect(upscaleServerTimeoutS({})).toBe(DEFAULT_UPSCALE_TIMEOUT_S);
    expect(upscaleServerTimeoutS({ UPSCALE_TIMEOUT_S: "660" })).toBe(660);
    for (const bad of ["0", "1800", "6.5", "ten", ""]) expect(upscaleServerTimeoutS({ UPSCALE_TIMEOUT_S: bad })).toBe(1740);
    expect(enlargeTimeoutMs({ UPSCALE_TIMEOUT_S: "660" })).toBe(690_000);
    expect(enlargeTimeoutMs({})).toBe(1_770_000);
  });

  it("the service timeout's ceiling comes from the enlarge task deadline and equals infra/lib/shape.sh UPSCALE_TIMEOUT_MAX_S", () => {
    expect(DEFAULT_UPSCALE_TIMEOUT_S).toBe(1740);
    const shape = fs.readFileSync(fileURLToPath(new URL("../../../../infra/lib/shape.sh", import.meta.url)), "utf8");
    const row = /^\s*UPSCALE_TIMEOUT_MAX_S=(\d+)\s*$/m.exec(shape);
    expect(row, "UPSCALE_TIMEOUT_MAX_S= in infra/lib/shape.sh").not.toBeNull();
    expect(Number(row![1])).toBe(DEFAULT_UPSCALE_TIMEOUT_S);
  });

  it("backs off exponentially with up to half off for jitter, capped at 60 s (10, 20, 40, 60)", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => enlargeBackoffMs(a, 0))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    expect(enlargeBackoffMs(1, 1)).toBe(5_000);
    expect(enlargeBackoffMs(3, 0.5)).toBe(30_000);
  });
});
