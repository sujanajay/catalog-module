// Spec 18 H2: the catalog-upscale client with a fake fetch: no network, no /health, no breaker.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPSCALE_TIMEOUT_S, EnlargeBadInputError, EnlargeBusyError, enlargeBackoffMs, EnlargeError, EnlargeRejectedError, EnlargeServerError,
  enlargeTimeoutMs, EnlargeTimeoutError, enlargeViaService, upscaleServerTimeoutS, type EnlargeDeps,
} from "./enlarge";

const URL_ = "https://catalog-upscale-abc-el.a.run.app";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const X2 = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

type Answer = number | "ok" | "hang" | "throw";
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
    const r = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2" }, s.deps);
    expect(r.attempts).toBe(5);
    expect(s.sleeps).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it("never retries a bad image or a refused call", async () => {
    for (const [status, type] of [[400, EnlargeBadInputError], [413, EnlargeBadInputError], [403, EnlargeRejectedError], [404, EnlargeRejectedError]] as const) {
      const s = fakeService([status, "ok"]);
      const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2" }, s.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ status, retryable: false, attempts: 1 });
      expect(s.calls).toHaveLength(1);
    }
  });

  it("gives up after the attempt cap with the last typed error", async () => {
    const s = fakeService([503]);
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", maxAttempts: 3 }, s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeBusyError);
    expect(error).toMatchObject({ kind: "busy", status: 503, retryable: true, attempts: 3 });
    expect(s.calls).toHaveLength(3);
    expect(s.sleeps).toEqual([10_000, 20_000]);
  });

  it("times out an attempt at its timeout, as a retryable timeout", async () => {
    const s = fakeService(["hang"]);
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 20, maxAttempts: 2 }, s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeTimeoutError);
    expect(error).toMatchObject({ kind: "timeout", retryable: true, attempts: 2 });
    expect(s.calls).toHaveLength(2);
  });

  it("starts an attempt only when it fits whole before the deadline", async () => {
    // 100 s attempts, a deadline 150 s away; the fake clock moves only with the backoff waits. Retry 1: 10 + 100 = 110
    // s fits; retry 2: 10 + 20 + 100 = 130 s fits; retry 3: 30 + 40 + 100 = 170 s does not, so the busy error stands.
    const s = fakeService([503]);
    const deadlineAt = s.now() + 150_000;
    const error = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 100_000, deadlineAt, maxAttempts: 10 }, s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlargeBusyError);
    expect(s.calls).toHaveLength(3);
    expect(s.sleeps).toEqual([10_000, 20_000]);
    // A deadline that cannot fit even one attempt makes no call at all.
    const late = fakeService(["ok"]);
    const none = await enlargeViaService({ url: URL_, jpeg: JPEG, model: "swinir-x2", timeoutMs: 100_000, deadlineAt: late.now() + 50_000 }, late.deps).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(EnlargeTimeoutError);
    expect(late.calls).toHaveLength(0);
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
    for (const bad of ["0", "900", "6.5", "ten", ""]) expect(upscaleServerTimeoutS({ UPSCALE_TIMEOUT_S: bad })).toBe(840);
    expect(enlargeTimeoutMs({ UPSCALE_TIMEOUT_S: "660" })).toBe(690_000);
    expect(enlargeTimeoutMs({})).toBe(870_000);
  });

  it("backs off exponentially with up to half off for jitter, capped at 60 s (10, 20, 40, 60)", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => enlargeBackoffMs(a, 0))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    expect(enlargeBackoffMs(1, 1)).toBe(5_000);
    expect(enlargeBackoffMs(3, 0.5)).toBe(30_000);
  });
});
