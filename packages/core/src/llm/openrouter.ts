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
  retry: RetryPolicy | undefined;
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
    retry: deps.retry,
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

/** The Retry-After header in ms (delta seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const ra = res.headers.get("retry-after")?.trim();
  if (!ra) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : null;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function retryDelay(res: Response, base: number): number {
  const ra = retryAfterMs(res);
  return ra === null ? base : Math.min(ra, MAX_RETRY_AFTER_MS);
}

/** A shared allowance of back-off waiting; every wait is taken off `remainingMs`. */
export interface BackoffBudget { remainingMs: number }

/**
 * Back-off on 429 and 5xx for one request: wait `delaysMs[i]` (with +/- `jitter` spread) before
 * retry i+1, or the Retry-After header when the server sends one. A wait never exceeds the smallest
 * remaining budget; when none is left the last error is thrown. Without a policy the client keeps
 * its default: one retry after `retryDelayMs` or Retry-After (capped at 30 s).
 */
export interface RetryPolicy {
  delaysMs: readonly number[];
  /** Fraction of spread around each delay (0.2 = +/- 20%). Default 0. */
  jitter?: number;
  /** Every budget must allow the wait; each wait is taken off all of them. */
  budgets?: BackoffBudget[];
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1). Default Math.random. */
  random?: () => number;
  /** Called before each wait: the failed attempt's status, the wait and any Retry-After. */
  onRetry?: (info: { attempt: number; status: number; waitMs: number; retryAfterMs: number | null }) => void;
}

/** The wait before the next attempt, or null to give up. */
function policyWait(policy: RetryPolicy, retry: number, res: Response): { waitMs: number; retryAfterMs: number | null } | null {
  if (retry >= policy.delaysMs.length) return null;
  const ra = retryAfterMs(res);
  const base = policy.delaysMs[retry]!, spread = policy.jitter ?? 0;
  const jittered = Math.round(base * (1 + spread * (2 * (policy.random ?? Math.random)() - 1)));
  const want = ra ?? jittered;
  const left = Math.min(Infinity, ...(policy.budgets ?? []).map((b) => b.remainingMs));
  // A Retry-After beyond what is left means the next attempt would come too early to help: give up.
  if (left <= 0 || (ra !== null && ra > left)) return null;
  return { waitMs: Math.max(0, Math.min(want, left)), retryAfterMs: ra };
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

    if (isRetryable(res.status)) {
      if (r.retry) {
        const next = policyWait(r.retry, attempt - 1, res);
        if (next) {
          for (const b of r.retry.budgets ?? []) b.remainingMs -= next.waitMs;
          r.retry.onRetry?.({ attempt, status: res.status, ...next });
          await (r.retry.sleep ?? sleep)(next.waitMs);
          continue;
        }
      } else if (attempt === 1) {
        await sleep(retryDelay(res, r.retryDelayMs));
        continue;
      }
    }
    const bodySnippet = snippet(text, r.apiKey);
    throw new OpenRouterError(`OpenRouter POST ${path} failed: HTTP ${res.status} ${bodySnippet}`, {
      status: res.status,
      bodySnippet,
      path,
    });
  }
}

/** POST /chat/completions. Returns the parsed JSON response. Retries on 429 or 5xx (once, or per `deps.retry`). */
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
