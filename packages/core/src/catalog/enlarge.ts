// Spec 18 H2: the client of the dedicated CPU enlargement service catalog-upscale (POST /upscale?model=<id>&scale=2).
// Unlike the render's upscale path through MattingClient (upscale.ts), it never reads /health and has no breaker:
// a slow or busy service is waited for and retried, never switched off. Its timeout is the service's own request
// timeout plus 30 s (UPSCALE_TIMEOUT_S, set by infra/deploy.sh from infra/lib/shape.sh, which sizes it from the
// measured p95), so the client never gives up on a call the service is still allowed to finish. Retries back off
// exponentially on busy (429, 503), timeout, transport errors and other 5xx, and start only while the caller's
// deadline still fits a whole attempt. A bad image (400, 413) and an auth or route refusal (401, 403, 404) are never
// retried. Not wired into the render yet (spec 18 H3 calls it from the durable enlargement task).
import { TRACE_HEADERS, type MattingTrace } from "./matte";
import { bearerFor, googleIdTokenFor, type IdTokenFor } from "../id-token";

/** The service's request timeout when UPSCALE_TIMEOUT_S is unset or invalid: the most shape.sh allows. */
export const DEFAULT_UPSCALE_TIMEOUT_S = 840;
/** The client waits this much longer than the service may run, so the service's own timeout always comes first. */
export const ENLARGE_CLIENT_MARGIN_MS = 30_000;
/** Spec 18 3.2.3 backoff between attempts: 10 s, 20 s, 40 s, then 60 s, each with up to 50% jitter off. */
export const ENLARGE_BACKOFF_BASE_MS = 10_000;
export const ENLARGE_BACKOFF_MAX_MS = 60_000;
/** Attempts at most when the caller gives no deadline. */
export const ENLARGE_MAX_ATTEMPTS = 5;

/** The service's request timeout in seconds from `UPSCALE_TIMEOUT_S` (a whole number from 1 to 840; else 840). */
export function upscaleServerTimeoutS(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UPSCALE_TIMEOUT_S?.trim());
  return Number.isInteger(n) && n >= 1 && n <= DEFAULT_UPSCALE_TIMEOUT_S ? n : DEFAULT_UPSCALE_TIMEOUT_S;
}

/** One attempt's client timeout: the service's timeout plus ENLARGE_CLIENT_MARGIN_MS. */
export function enlargeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return upscaleServerTimeoutS(env) * 1000 + ENLARGE_CLIENT_MARGIN_MS;
}

export type EnlargeErrorKind = "busy" | "timeout" | "bad_input" | "rejected" | "server";

/** Every failure of enlargeViaService. `retryable` says whether a later attempt (now or in a retried task) may pass. */
export class EnlargeError extends Error {
  constructor(message: string, readonly kind: EnlargeErrorKind, readonly status: number | null, readonly retryable: boolean, readonly attempts: number) {
    super(message);
    this.name = new.target.name;
  }
}
/** 429 or 503: every instance is working, or the service is starting. */
export class EnlargeBusyError extends EnlargeError {
  constructor(status: number, attempts: number) { super(`The enlargement service is busy (${status}).`, "busy", status, true, attempts); }
}
/** No answer within the attempt's timeout. */
export class EnlargeTimeoutError extends EnlargeError {
  constructor(timeoutMs: number, attempts: number) { super(`The enlargement service did not answer within ${Math.round(timeoutMs / 1000)} s.`, "timeout", null, true, attempts); }
}
/** 400 or 413: the image cannot be enlarged as sent (not a JPEG or PNG, too many pixels, too large). Never retried. */
export class EnlargeBadInputError extends EnlargeError {
  constructor(status: number, attempts: number) { super(`The enlargement service refused this image (${status}).`, "bad_input", status, false, attempts); }
}
/** 401, 403, 404 or another 4xx: the call itself is refused (identity, route). Never retried; a deploy or IAM problem. */
export class EnlargeRejectedError extends EnlargeError {
  constructor(status: number, attempts: number) { super(`The enlargement service rejected the call (${status}).`, "rejected", status, false, attempts); }
}
/** Another 5xx, a transport failure or an empty answer. */
export class EnlargeServerError extends EnlargeError {
  constructor(detail: string, status: number | null, attempts: number) { super(`The enlargement service failed (${detail}).`, "server", status, true, attempts); }
}

export interface EnlargeRequest {
  /** The service URL (catalog-upscale's UPSCALE_URL), without a trailing path. */
  url: string;
  /** The upload: JPEG bytes (quality 95, 4:4:4 as upscaleUpload makes them). */
  jpeg: Buffer;
  model: string;
  /** One attempt's timeout; default enlargeTimeoutMs() (UPSCALE_TIMEOUT_S + 30 s). */
  timeoutMs?: number;
  /** Aborts the call and every retry (the task is ending); the abort reason is thrown as it is. */
  signal?: AbortSignal;
  /** Epoch ms after which no attempt may still be running; an attempt starts only if it fits whole. Default: none. */
  deadlineAt?: number;
  /** Attempts at most (default ENLARGE_MAX_ATTEMPTS). */
  maxAttempts?: number;
  trace?: MattingTrace;
}

export interface EnlargeDeps {
  fetch?: typeof fetch;
  idToken?: IdTokenFor;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface EnlargeResult {
  /** The 2x JPEG as the service returned it (the caller verifies its size). */
  jpeg: Buffer;
  /** Service-side tiling and inference ms (X-Upscale-Ms), else the last attempt's wall time. */
  ms: number;
  /** The model the service used (X-Upscale-Model), else the one asked for. */
  model: string;
  attempts: number;
}

/** The wait before attempt `attempt + 1` (attempt counts from 1): base x 2^(attempt-1), capped, minus up to 50% jitter. */
export function enlargeBackoffMs(attempt: number, random: number = Math.random()): number {
  const full = Math.min(ENLARGE_BACKOFF_MAX_MS, ENLARGE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(full * (1 - 0.5 * Math.min(1, Math.max(0, random))));
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

let sharedIdToken: IdTokenFor | null = null;

/** One attempt: the answer, or a typed EnlargeError. The caller's abort is rethrown as its reason. */
async function attemptOnce(req: EnlargeRequest, timeoutMs: number, attempts: number, deps: Required<Pick<EnlargeDeps, "fetch" | "idToken" | "now">>): Promise<EnlargeResult> {
  const base = req.url.trim().replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const started = deps.now();
  const callerAborted = () => req.signal?.aborted === true;
  try {
    const headers = new Headers({ "content-type": "image/jpeg" });
    if (req.trace?.batchId) headers.set(TRACE_HEADERS.batchId, req.trace.batchId);
    if (req.trace?.productId) headers.set(TRACE_HEADERS.productId, req.trace.productId);
    const bearer = await bearerFor(base, deps.idToken);
    signal.throwIfAborted();
    if (bearer) headers.set("Authorization", bearer);
    const response = await deps.fetch(`${base}/upscale?model=${encodeURIComponent(req.model)}&scale=2`, { method: "POST", body: new Uint8Array(req.jpeg), headers, signal });
    if (response.status === 429 || response.status === 503) throw new EnlargeBusyError(response.status, attempts);
    if (response.status === 400 || response.status === 413) throw new EnlargeBadInputError(response.status, attempts);
    if (response.status >= 500) throw new EnlargeServerError(`HTTP ${response.status}`, response.status, attempts);
    if (!response.ok) throw new EnlargeRejectedError(response.status, attempts);
    const jpeg = Buffer.from(await response.arrayBuffer());
    if (!jpeg.length) throw new EnlargeServerError("empty answer", response.status, attempts);
    const ms = Number(response.headers.get("x-upscale-ms"));
    return { jpeg, ms: Number.isFinite(ms) && ms > 0 ? ms : deps.now() - started, model: response.headers.get("x-upscale-model") ?? req.model, attempts };
  } catch (error) {
    if (callerAborted()) throw req.signal!.reason;
    if (error instanceof EnlargeError) throw error;
    if (timeout.aborted) throw new EnlargeTimeoutError(timeoutMs, attempts);
    throw new EnlargeServerError(error instanceof Error ? error.name : "transport error", null, attempts);
  }
}

/**
 * One enlargement on catalog-upscale, with retries. Resolves with the 2x JPEG, or throws the last EnlargeError (its
 * `retryable` tells the caller whether a later task attempt may pass) or the caller's abort reason.
 */
export async function enlargeViaService(req: EnlargeRequest, deps: EnlargeDeps = {}): Promise<EnlargeResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const io = { fetch: deps.fetch ?? fetch, idToken: deps.idToken ?? (sharedIdToken ??= googleIdTokenFor()), now };
  const timeoutMs = req.timeoutMs ?? enlargeTimeoutMs();
  const maxAttempts = Math.max(1, req.maxAttempts ?? ENLARGE_MAX_ATTEMPTS);
  if (req.deadlineAt !== undefined && now() + timeoutMs > req.deadlineAt) {
    throw new EnlargeTimeoutError(timeoutMs, 0);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce(req, timeoutMs, attempt, io);
    } catch (error) {
      if (!(error instanceof EnlargeError) || !error.retryable || attempt >= maxAttempts) throw error;
      const wait = enlargeBackoffMs(attempt, random());
      // Never start an attempt that could not run to its full timeout: an abandoned call keeps running on the
      // service and holds its slot (2026-10-29).
      if (req.deadlineAt !== undefined && now() + wait + timeoutMs > req.deadlineAt) throw error;
      await sleep(wait, req.signal);
    }
  }
}
