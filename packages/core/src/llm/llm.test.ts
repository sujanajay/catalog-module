import { describe, expect, it } from "vitest";
import { addCosts, callLlm, callLlmJson, imageParts, LlmJsonError, LlmResponseError, parseJsonLoose, type LlmCallOptions } from "./llm";
import { chatText, mockFetch } from "./mocks";
import { parseDataUrl, readCost, stripBase64, sumUsage } from "./util";

const deps = { apiKey: "test-key", retryDelayMs: 1 };
const opts = { model: "test/model" };

type ChatBody = { model: string; messages: { role: string; content: unknown }[]; usage: { include: boolean }; temperature?: number; max_tokens?: number };

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences", () => {
    expect(parseJsonLoose('```json\n{"verdict": "pass", "n": [1,2]}\n```')).toEqual({ verdict: "pass", n: [1, 2] });
  });

  it("ignores leading and trailing prose", () => {
    const text = 'Sure! Here is the result:\n{"reason": "a {curly} string", "nested": {"x": "}"}}\nHope that helps.';
    expect(parseJsonLoose(text)).toEqual({ reason: "a {curly} string", nested: { x: "}" } });
  });

  it("tolerates trailing commas but not inside strings", () => {
    expect(parseJsonLoose('{"a": [1, 2,], "b": "x,}", }')).toEqual({ a: [1, 2], b: "x,}" });
  });

  it("handles escaped quotes in strings", () => {
    expect(parseJsonLoose('{"t": "reads \\"GLOW\\" }"}')).toEqual({ t: 'reads "GLOW" }' });
  });

  it("strips a BOM", () => {
    expect(parseJsonLoose('﻿{"a":2}')).toEqual({ a: 2 });
  });

  it("skips an unparseable brace group and finds the next object", () => {
    expect(parseJsonLoose('Note {not json} then {"ok": true}')).toEqual({ ok: true });
  });

  it("throws a typed error with a snippet on garbage", () => {
    let err: unknown;
    try {
      parseJsonLoose("I cannot comply with this request.");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LlmJsonError);
    expect((err as LlmJsonError).snippet).toContain("cannot comply");
    expect(() => parseJsonLoose('{"a": 1')).toThrow(LlmJsonError);
    expect(() => parseJsonLoose("[1,2,3]")).toThrow(LlmJsonError);
  });
});

describe("callLlm", () => {
  it("throws when no model is given, before any request", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: chatText("x") } }]);
    await expect(callLlm([{ role: "user", content: "hi" }], {} as LlmCallOptions, { ...deps, fetch: f })).rejects.toThrow(/model is required/);
    await expect(callLlm([{ role: "user", content: "hi" }], { model: "  " }, { ...deps, fetch: f })).rejects.toThrow(/model is required/);
    await expect(
      callLlm([{ role: "user", content: "hi" }], undefined as unknown as LlmCallOptions, { ...deps, fetch: f }),
    ).rejects.toThrow(/model is required/);
    expect(f.calls).toHaveLength(0);
  });

  it("sends the given model, requests usage, passes options and returns cost", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: chatText("hello", 0.01) } }]);
    const r = await callLlm([{ role: "user", content: "hi" }], { ...opts, temperature: 0, maxTokens: 50 }, { ...deps, fetch: f });
    const body = f.calls[0]!.body as ChatBody;
    expect(body.model).toBe("test/model");
    expect(body.usage).toEqual({ include: true });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(50);
    expect(r).toMatchObject({ text: "hello", costUsd: 0.01, model: "test/model" });
  });

  it("defaults cost to 0 when usage has none", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: chatText("x", null) } }]);
    const r = await callLlm([{ role: "user", content: "hi" }], opts, { ...deps, fetch: f });
    expect(r.costUsd).toBe(0);
  });

  it("throws LlmResponseError on empty content, worded as LLM", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: chatText("  ") } }]);
    const err = await callLlm([{ role: "user", content: "hi" }], opts, { ...deps, fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmResponseError);
    expect((err as Error).message).toMatch(/^LLM /);
  });
});

describe("callLlmJson", () => {
  it("retries once with a JSON nudge and sums cost", async () => {
    const f = mockFetch([
      { match: "/chat/completions", times: 1, reply: { json: chatText("Sorry, verdict is pass", 0.01) } },
      { match: "/chat/completions", reply: { json: chatText('{"verdict":"pass"}', 0.02) } },
    ]);
    const r = await callLlmJson([{ role: "user", content: "go" }], (o) => o, opts, { ...deps, fetch: f });
    expect(r.value).toEqual({ verdict: "pass" });
    expect(r.calls).toBe(2);
    expect(r.costUsd).toBeCloseTo(0.03);
    expect(r.usage.total_tokens).toBe(1400);
    const second = f.calls[1]!.body as ChatBody;
    const last = second.messages[second.messages.length - 1]!;
    expect(String(last.content)).toContain("Return only valid JSON");
    expect(second.messages[second.messages.length - 2]!.role).toBe("assistant");
  });

  it("gives up after the second bad reply", async () => {
    const f = mockFetch([{ match: "/chat/completions", reply: { json: chatText("nope") } }]);
    await expect(callLlmJson([{ role: "user", content: "go" }], (o) => o, opts, { ...deps, fetch: f })).rejects.toBeInstanceOf(LlmJsonError);
    expect(f.calls).toHaveLength(2);
  });
});

describe("llm util", () => {
  it("builds image parts as data URLs and parses them back", () => {
    const parts = imageParts([{ mime: "image/png", data: Buffer.from("PNG") }]);
    expect(parts).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("PNG").toString("base64")}` } }]);
    const url = (parts[0] as { image_url: { url: string } }).image_url.url;
    expect(parseDataUrl(url)).toEqual({ mime: "image/png", data: Buffer.from("PNG") });
    expect(parseDataUrl("https://x")).toBeNull();
  });

  it("reads cost, sums usage and strips base64", () => {
    expect(readCost({ cost: 0.5 })).toBe(0.5);
    expect(readCost({})).toBeNull();
    expect(sumUsage([{ a: 1, m: "x" }, { a: 2 }])).toEqual({ a: 3, m: "x" });
    expect(addCosts([{ usage: { a: 1 }, costUsd: 1 }, { usage: { a: 2 }, costUsd: 2 }])).toEqual({ usage: { a: 3 }, costUsd: 3 });
    expect(stripBase64({ u: "data:image/png;base64,AAAA", b64_json: "BBBB" })).toEqual({
      u: "data:image/png;base64,<4 chars omitted>",
      b64_json: "<4 chars omitted>",
    });
  });
});
