import { describe, expect, it } from "vitest";
import { jsonResponse, mockFetch } from "./mocks";
import { chatCompletion, OpenRouterError } from "./openrouter";

const KEY = "sk-or-test-SECRET123";
const base = { apiKey: KEY, retryDelayMs: 1 };

describe("openrouter client", () => {
  it("POSTs chat completions with auth and app headers to the default base URL", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: { ok: 1 } } }]);
    const res = await chatCompletion({ model: "m" }, { ...base, fetch: f });
    expect(res).toEqual({ ok: 1 });
    const c = f.calls[0]!;
    expect(c.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(c.method).toBe("POST");
    expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(c.headers["x-title"]).toBe("catalog-module");
    expect(c.headers["http-referer"]).toContain("catalog-module");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.body).toEqual({ model: "m" });
  });

  it("honours a custom baseUrl", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: {} } }]);
    await chatCompletion({}, { ...base, fetch: f, baseUrl: "http://x/api/v1/" });
    expect(f.calls[0]!.url).toBe("http://x/api/v1/chat/completions");
  });

  it("reads OPENROUTER_API_KEY from env when not given, and refuses without one", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = "env-key";
      const f = mockFetch([{ match: "/chat", reply: { json: {} } }]);
      await chatCompletion({}, { fetch: f });
      expect(f.calls[0]!.headers.authorization).toBe("Bearer env-key");
      delete process.env.OPENROUTER_API_KEY;
      await expect(chatCompletion({}, { fetch: f })).rejects.toThrow(/OPENROUTER_API_KEY/);
      expect(f.calls).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it("throws OpenRouterError with status and body snippet on 400, no retry, key redacted", async () => {
    const f = mockFetch([
      { match: "/chat", reply: { status: 400, json: { error: { message: `bad input; key was ${KEY}; Bearer ${KEY}` } } } },
    ]);
    const err = await chatCompletion({}, { ...base, fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    const e = err as OpenRouterError;
    expect(e.status).toBe(400);
    expect(e.path).toBe("/chat/completions");
    expect(e.bodySnippet).toContain("bad input");
    expect(e.bodySnippet).toContain("[REDACTED]");
    expect(e.message).toContain("HTTP 400");
    expect(e.message).not.toContain(KEY);
    expect(e.bodySnippet).not.toContain(KEY);
    expect(f.calls).toHaveLength(1);
  });

  it("redacts the key from network errors", async () => {
    const f = (async () => {
      throw new Error(`socket closed while sending ${KEY}`);
    }) as unknown as typeof fetch;
    const err = (await chatCompletion({}, { ...base, fetch: f }).catch((e: unknown) => e)) as OpenRouterError;
    expect(err.status).toBe(0);
    expect(err.message).not.toContain(KEY);
  });

  it("retries once on 429 honouring retry-after, then succeeds", async () => {
    const f = mockFetch([
      { match: "/chat", times: 1, reply: { status: 429, json: { error: "rate" }, headers: { "retry-after": "0" } } },
      { match: "/chat", reply: { json: { ok: true } } },
    ]);
    await expect(chatCompletion({}, { ...base, fetch: f })).resolves.toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  it("retries only once on 5xx then throws", async () => {
    const f = mockFetch([{ match: "/chat", reply: () => jsonResponse({ error: "boom" }, 502) }]);
    const err = (await chatCompletion({}, { ...base, fetch: f }).catch((e: unknown) => e)) as OpenRouterError;
    expect(err.status).toBe(502);
    expect(f.calls).toHaveLength(2);
  });

  it("maps timeouts to OpenRouterError status 0", async () => {
    const f = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
      })) as typeof fetch;
    const err = (await chatCompletion({}, { ...base, fetch: f, timeoutMs: 10 }).catch((e: unknown) => e)) as OpenRouterError;
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/timed out/);
  });

  it("mockFetch throws on unmatched requests (never hits the network)", async () => {
    const f = mockFetch([]);
    await expect(chatCompletion({}, { ...base, fetch: f })).rejects.toThrow(/no handler/);
  });
});
