// Spec 16 F3: AI check pacing. No live OpenRouter call: every fetch here is a fake.
import { afterEach, describe, expect, it } from "vitest";
import { LLM_LIMIT_STEP_MS, LlmLimiter, resetSharedLlmLimiter, sharedLlmLimiter } from "./limiter";
import { callLlm } from "./llm";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });

afterEach(() => resetSharedLlmLimiter());

describe("LlmLimiter", () => {
  it("caps 100 parallel callers at the limit and serves all of them", async () => {
    const limiter = new LlmLimiter(6);
    let inflight = 0, peak = 0;
    const fetch = limiter.wrap(async () => { inflight++; peak = Math.max(peak, inflight); await pause(1 + Math.random() * 3); inflight--; return reply(); });
    const results = await Promise.all(Array.from({ length: 100 }, () => fetch("https://example.test")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBe(6);
    expect(limiter.active()).toBe(0);
  });

  it("halves after a 429, holds for a minute, then adds one a minute back up to the cap", () => {
    let t = 0;
    const limiter = new LlmLimiter(6, () => t);
    expect(limiter.limit()).toBe(6);
    limiter.rateLimited();
    expect(limiter.limit()).toBe(3);
    t += LLM_LIMIT_STEP_MS - 1;
    expect(limiter.limit()).toBe(3);
    t += 1;
    expect(limiter.limit()).toBe(4);
    limiter.rateLimited();
    expect(limiter.limit()).toBe(2);
    limiter.rateLimited(); limiter.rateLimited();
    expect(limiter.limit()).toBe(1);
    t += 10 * LLM_LIMIT_STEP_MS;
    expect(limiter.limit()).toBe(6);
  });

  it("a 429 answer through the wrapped fetch lowers the cap; waiting callers still all finish", async () => {
    const limiter = new LlmLimiter(4);
    let calls = 0, inflight = 0, peakAfter = 0;
    const fetch = limiter.wrap(async () => {
      const call = ++calls; inflight++;
      if (call > 4) peakAfter = Math.max(peakAfter, inflight);
      await pause(call === 1 ? 1 : 5); inflight--;
      return call === 1 ? new Response("", { status: 429 }) : reply();
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => fetch("https://example.test")));
    expect(results.filter((r) => r.status === 429)).toHaveLength(1);
    expect(limiter.limit()).toBe(2);
    expect(peakAfter).toBeLessThanOrEqual(4);
  });


  it("a burst of 429s for requests sent together halves the cap once", async () => {
    const limiter = new LlmLimiter(6);
    const fetch = limiter.wrap(async () => { await pause(2); return new Response("", { status: 429 }); });
    await Promise.all(Array.from({ length: 6 }, () => fetch("https://example.test")));
    expect(limiter.limit()).toBe(3);
  });
});

describe("callLlm pacing", () => {
  it("unset LLM_INFLIGHT_PER_INSTANCE: no limiter (today)", () => {
    expect(sharedLlmLimiter({})).toBeNull();
    resetSharedLlmLimiter();
    expect(sharedLlmLimiter({ LLM_INFLIGHT_PER_INSTANCE: "6" })?.max).toBe(6);
  });

  it("each HTTP attempt of callLlm holds one place under the given limiter", async () => {
    const limiter = new LlmLimiter(2);
    let inflight = 0, peak = 0;
    const fetch = (async () => { inflight++; peak = Math.max(peak, inflight); await pause(3); inflight--; return reply(); }) as typeof globalThis.fetch;
    await Promise.all(Array.from({ length: 10 }, () => callLlm([{ role: "user", content: "hi" }], { model: "test/model" }, { apiKey: "k", fetch, limiter })));
    expect(peak).toBe(2);
  });
});
