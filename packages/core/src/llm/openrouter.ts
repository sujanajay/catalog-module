// Low-level OpenRouter HTTP client (chat completions only). Never logs or embeds the API key in errors.
// Tests always inject `deps.fetch`; live calls happen only in the Cloud Run jobs gated by LIVE_SMOKE=1.
import type { OpenRouterDeps } from "./types";

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_APP_NAME = "catalog-module";
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 30_000;
const BODY_SNIPPET_LEN = 500;

export class OpenRouterError extends Error {
  /** HTTP status, or 0 for network errors and timeouts. */
  readonly status: number;
  /** First ~500 chars of the response body (key redacted). */
  readonly bodySnippet: string;
  readonly path: string;

  constructor(message: string, opts: { status: number; bodySnippet?: string; path: string; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "OpenRouterError";
    this.status = opts.status;
    this.bodySnippet = opts.bodySnippet ?? "";
    this.path = opts.path;
  }
}

interface Resolved {
  apiKey: string | undefined;
  fetch: typeof fetch;
  baseUrl: string;
  appName: string;
  timeoutMs: number;
  retryDelayMs: number;
}

function resolve(deps: OpenRouterDeps = {}): Resolved {
  const f = deps.fetch ?? globalThis.fetch;
  if (typeof f !== "function") throw new Error("No fetch implementation available");
  return {
    apiKey: deps.apiKey ?? process.env.OPENROUTER_API_KEY,
    fetch: f,
    baseUrl: (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    appName: deps.appName ?? DEFAULT_APP_NAME,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryDelayMs: deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  };
}

function redact(text: string, key: string | undefined): string {
  let out = text;
  if (key) out = out.split(key).join("[REDACTED]");
  return out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
}

function snippet(text: string, key: string | undefined): string {
  const r = redact(text, key);
  return r.length > BODY_SNIPPET_LEN ? `${r.slice(0, BODY_SNIPPET_LEN)}...` : r;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function retryDelay(res: Response, base: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  }
  return base;
}

const isRetryable = (status: number) => status === 429 || status >= 500;

async function post<T>(path: string, body: unknown, deps?: OpenRouterDeps): Promise<T> {
  const r = resolve(deps);
  if (!r.apiKey) throw new OpenRouterError("OPENROUTER_API_KEY is not set", { status: 0, path });
  const headers: Record<string, string> = {
    "HTTP-Referer": `https://${r.appName}`,
    "X-Title": r.appName,
    Authorization: `Bearer ${r.apiKey}`,
    "Content-Type": "application/json",
  };
  const url = `${r.baseUrl}${path}`;
  const payload = JSON.stringify(body);

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await r.fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(r.timeoutMs) });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const msg = timedOut
        ? `OpenRouter POST ${path} timed out after ${r.timeoutMs}ms`
        : `OpenRouter POST ${path} network error: ${redact(String((err as Error)?.message ?? err), r.apiKey)}`;
      throw new OpenRouterError(msg, { status: 0, path });
    }

    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new OpenRouterError(`OpenRouter ${path} returned non-JSON body`, {
          status: res.status,
          bodySnippet: snippet(text, r.apiKey),
          path,
        });
      }
    }

    if (attempt === 1 && isRetryable(res.status)) {
      await sleep(retryDelay(res, r.retryDelayMs));
      continue;
    }
    const bodySnippet = snippet(text, r.apiKey);
    throw new OpenRouterError(`OpenRouter POST ${path} failed: HTTP ${res.status} ${bodySnippet}`, {
      status: res.status,
      bodySnippet,
      path,
    });
  }
}

/** POST /chat/completions. Returns the parsed JSON response. Retries once on 429 or 5xx. */
export function chatCompletion<T = ChatCompletionResponse>(body: Record<string, unknown>, deps?: OpenRouterDeps): Promise<T> {
  return post<T>("/chat/completions", body, deps);
}

// ---- Response shape (loose; only the fields we read) ----

export interface ChatContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | ChatContentPart[] | null;
      refusal?: string | null;
      images?: { type?: string; image_url?: { url?: string } }[];
    };
  }[];
  usage?: Record<string, unknown> & { cost?: number };
  error?: { message?: string; code?: unknown };
}
