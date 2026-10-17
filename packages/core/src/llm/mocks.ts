// Test helpers: a scriptable fetch mock and a canned chat response. No vitest dependency, so any
// package's tests can import it (`@catalog/core/llm/mocks`). Unmatched requests throw, so a test can
// never fall through to the network.

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body when the body was JSON, raw string otherwise, undefined if none. */
  body: unknown;
}

export type MockReply = Response | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

export interface MockHandler {
  /** Substring of the URL, a RegExp, or a predicate. */
  match: string | RegExp | ((call: RecordedCall) => boolean);
  method?: string;
  /** Static reply, or a function of the call. */
  reply: MockReply | ((call: RecordedCall) => MockReply | Promise<MockReply>);
  /** Use this handler at most N times (default unlimited). Handlers are tried in order. */
  times?: number;
}

export type MockFetch = typeof fetch & { calls: RecordedCall[] };

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function toResponse(r: MockReply): Response {
  if (r instanceof Response) return r;
  if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: r.headers });
  return jsonResponse(r.json ?? {}, r.status ?? 200, r.headers);
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

/** Build a fetch mock. Every call is recorded on `.calls`. */
export function mockFetch(handlers: MockHandler[]): MockFetch {
  const remaining = handlers.map((h) => h.times ?? Infinity);
  const calls: RecordedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw string */
      }
    }
    const call: RecordedCall = { url, method: (init?.method ?? "GET").toUpperCase(), headers: headersToRecord(init?.headers), body };
    calls.push(call);
    for (let idx = 0; idx < handlers.length; idx++) {
      const h = handlers[idx]!;
      if ((remaining[idx] ?? 0) <= 0) continue;
      if (h.method && h.method.toUpperCase() !== call.method) continue;
      const ok =
        typeof h.match === "string" ? url.includes(h.match) : h.match instanceof RegExp ? h.match.test(url) : h.match(call);
      if (!ok) continue;
      remaining[idx] = (remaining[idx] ?? 0) - 1;
      const reply = typeof h.reply === "function" ? await h.reply(call) : h.reply;
      return toResponse(reply);
    }
    throw new Error(`mockFetch: no handler for ${call.method} ${url}`);
  };
  return Object.assign(fn, { calls }) as MockFetch;
}

/** Chat completion response whose message content is `text`. */
export function chatText(text: string, cost: number | null = 0.002) {
  const usage: Record<string, unknown> = { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 };
  if (cost !== null) usage.cost = cost;
  return { id: "gen-text", choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }], usage };
}
