import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MattingClient } from "./matte";

beforeEach(() => {
  vi.useFakeTimers();
  // Native AbortSignal.timeout does not use Vitest's clock. Preserve its abort semantics
  // with a timer-controlled signal so this regression takes milliseconds, not minutes.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function delayedHealth(delayMs: number, timeoutMs?: number) {
  let signal: AbortSignal | null | undefined;
  const request: typeof fetch = async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ ok: true, models: [{ id: "general", inputSize: 1024, target: "cpu" }], default: "general", version: "cold-start" })), delayMs);
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const client = new MattingClient({ services: [{ baseUrl: "http://localhost:8080", target: "cpu" }], fetch: request, timeoutMs });
  return { client, signal: () => signal };
}

it("discovers the model after the measured 64,094 ms CPU readiness delay", async () => {
  const { client } = delayedHealth(64_094);
  const health = client.health();
  await vi.advanceTimersByTimeAsync(64_094);
  expect(await health).toMatchObject({ ok: true, default: "general", models: [{ id: "general", inputSize: 1024, target: "cpu" }] });
  expect(client.breaker.failures).toBe(0);
});

it("still aborts health discovery at the 180-second default deadline", async () => {
  const { client, signal } = delayedHealth(180_001);
  const health = client.health();
  await vi.advanceTimersByTimeAsync(179_999);
  expect(signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal()?.aborted).toBe(true);
  expect(await health).toMatchObject({ ok: false, models: [] });
  expect(client.breaker.failures).toBe(1);
});

it("retains an explicit shorter timeout for callers that need it", async () => {
  const { client, signal } = delayedHealth(64_094, 20);
  const health = client.health();
  await vi.advanceTimersByTimeAsync(20);
  expect(signal()?.aborted).toBe(true);
  expect(await health).toMatchObject({ ok: false, models: [] });
});
