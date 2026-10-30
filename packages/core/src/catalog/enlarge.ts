// Spec 18 H2: the client of the dedicated CPU enlargement service catalog-upscale (POST /upscale?model=<id>&scale=<2 or 4>).
// Unlike the render's upscale path through MattingClient (upscale.ts), it never reads /health and has no breaker:
// a slow or busy service is waited for and retried, never switched off. Its timeout is the service's own request
// timeout plus 30 s (UPSCALE_TIMEOUT_S, set by infra/deploy.sh from infra/lib/shape.sh, which sizes it from the
// measured p95 and the largest photo the service takes), so the client never gives up on a call the service is still allowed to finish. Retries back off
// exponentially on busy (429, Cloud Run's own no-instance 500 or 503), timeout, transport errors and other 5xx. Every attempt ends by the
// caller's deadline (by default the enlarge task's: ENLARGE_DISPATCH_DEADLINE_SEC from the call): its timeout is clamped to the time
// left, and no attempt starts with less than ENLARGE_ATTEMPT_FLOOR_MS left. The service's own "upscale model
// unavailable" 503 is no busy answer: it is retried once, after 60 s. A bad image (400, 413) and an auth or route
// refusal (401, 403, 404) are never retried. Spec 18 H3 calls it from the durable enlargement task, one attempt per
// task delivery.
// Spec 18 enlargement lifecycle 3.4: every failure says what it proves. `ownBody` is true when the answer carried the
// service's own JSON error body (app.py `{"error": ...}`): the service itself answered. `transport` names a failure
// before any answer: "refused" and "dns" prove the service absent, "reset" and "other" prove nothing (a crash-shaped
// failure). probeUpscaleHealth reads /health the same way, for the handler's probe before a call and its re-probe after
// an unexplained failure.
import { Agent, fetch as undiciFetch } from "undici";
import { setTraceHeaders, type MattingTrace } from "./matte";
import { bearerFor, googleIdTokenFor, raceAbort, type IdTokenFor } from "../id-token";
import { ENLARGE_DISPATCH_DEADLINE_SEC } from "../tasks";

/** The client waits this much longer than the service may run, so the service's own timeout always comes first. */
export const ENLARGE_CLIENT_MARGIN_MS = 30_000;
/** What the task keeps after the call has given up: writing its outcome before the dispatch deadline. */
export const ENLARGE_TASK_MARGIN_MS = 30_000;
/**
 * The service's request timeout when UPSCALE_TIMEOUT_S is unset or invalid, and the most it may be: the enlarge
 * task's dispatch deadline minus both margins (1800 - 30 - 30 = 1740 s). infra/lib/shape.sh UPSCALE_TIMEOUT_MAX_S must
 * equal it (a test reads both).
 */
export const DEFAULT_UPSCALE_TIMEOUT_S = ENLARGE_DISPATCH_DEADLINE_SEC - (ENLARGE_CLIENT_MARGIN_MS + ENLARGE_TASK_MARGIN_MS) / 1000;
/** The wait before the one retry after the service said its upscale model is unavailable (it may still be loading). */
export const ENLARGE_UNAVAILABLE_RETRY_MS = 60_000;
/** Spec 18 3.2.3 backoff between attempts: 10 s, 20 s, 40 s, then 60 s, each with up to 50% jitter off. */
export const ENLARGE_BACKOFF_BASE_MS = 10_000;
export const ENLARGE_BACKOFF_MAX_MS = 60_000;
/** Attempts at most when the caller gives no deadline. */
export const ENLARGE_MAX_ATTEMPTS = 5;
/**
 * The shortest attempt worth starting: with less time left before the caller's deadline the call is not made and a
 * timeout is thrown (no attempt counted on the service). Above it, an attempt's timeout is clamped to the time left.
 */
export const ENLARGE_ATTEMPT_FLOOR_MS = 60_000;

/** The service's request timeout in seconds from `UPSCALE_TIMEOUT_S` (a whole number from 1 to 1740; else 1740). */
export function upscaleServerTimeoutS(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UPSCALE_TIMEOUT_S?.trim());
  return Number.isInteger(n) && n >= 1 && n <= DEFAULT_UPSCALE_TIMEOUT_S ? n : DEFAULT_UPSCALE_TIMEOUT_S;
}

/** One attempt's client timeout: the service's timeout plus ENLARGE_CLIENT_MARGIN_MS. */
export function enlargeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return upscaleServerTimeoutS(env) * 1000 + ENLARGE_CLIENT_MARGIN_MS;
}

export type EnlargeErrorKind = "busy" | "unavailable" | "timeout" | "bad_input" | "rejected" | "server";

/** A failure before any answer: refused or a DNS error (the service is absent), a reset or another transport error. */
export type EnlargeTransport = "refused" | "dns" | "reset" | "other";
/** Every failure of enlargeViaService. `retryable` says whether a later attempt (now or in a retried task) may pass. */
export class EnlargeError extends Error {
  /** Spec 18 lifecycle: the answer carried the service's own JSON error body. */
  ownBody = false;
  /** Spec 18 lifecycle: the transport failure before any answer, when there was one. */
  transport: EnlargeTransport | null = null;
  constructor(message: string, readonly kind: EnlargeErrorKind, readonly status: number | null, readonly retryable: boolean, readonly attempts: number) {
    super(message);
    this.name = new.target.name;
  }
}
/**
 * Cloud Run refused the request before any instance handled it: a 429 (the service never answers 429 itself), or a
 * 500 or 503 whose body is Cloud Run's own "no available instance", "maximum container instance limit" or "instance
 * could not start" text (CLOUD_RUN_NOT_HANDLED). No upscale work was done, so it is a delay that never counts.
 */
export class EnlargeBusyError extends EnlargeError {
  constructor(status: number, attempts: number) { super(`The enlargement service is busy (${status}).`, "busy", status, true, attempts); }
}
/**
 * Spec 18 lifecycle 3.4 step 9, positive proof that no instance handled the request: the answer texts Cloud Run sends
 * itself when it aborts a request before an instance takes it (docs.cloud.google.com/run/docs/troubleshooting, read
 * 2026-10-30: 429 and 500 "The request was aborted because there was no available instance", 503 "...has reached its
 * maximum container instance limit", 500 "...the instance could not start successfully"). A 500 or 503 with any other
 * body (an instance killed for memory, "connection to the instance had an error") reached an instance: unexplained.
 */
export const CLOUD_RUN_NOT_HANDLED = /no available instance|maximum container instance limit|instance could not start/i;
/**
 * The service's own 503 "upscale model <id> unavailable" (services/matting/app.py): the model is not served there or
 * failed to load. Not busy: retried once within a call after ENLARGE_UNAVAILABLE_RETRY_MS, and never by a later task
 * (a deploy problem, like a refusal).
 */
export class EnlargeModelUnavailableError extends EnlargeError {
  constructor(attempts: number) { super("The enlargement service cannot serve this upscale model (503).", "unavailable", 503, false, attempts); }
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
  /** The model's scale (2 or 4, spec 18 quality); default 2. */
  scale?: number;
  /** One attempt's timeout; default enlargeTimeoutMs() (UPSCALE_TIMEOUT_S + 30 s). Clamped to the time left before `deadlineAt`. */
  timeoutMs?: number;
  /** Aborts the call and every retry (the task is ending); the abort reason is thrown as it is. */
  signal?: AbortSignal;
  /**
   * Epoch ms after which no attempt may still be running (any margin the caller needs after the call is already taken
   * off). Each attempt's timeout is clamped to the time left, and none starts with less than ENLARGE_ATTEMPT_FLOOR_MS
   * left. Default: the enlarge task's dispatch deadline counted from this call, now + ENLARGE_DISPATCH_DEADLINE_SEC -
   * ENLARGE_TASK_MARGIN_MS; a caller that knows when its task started passes its own.
   */
  deadlineAt?: number;
  /** Attempts at most (default ENLARGE_MAX_ATTEMPTS), a secondary cap after the deadline. */
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
/**
 * The default fetch's dispatcher: undici's own headers and body timeouts (300 s each by default) are off, so an
 * attempt's only limit is its AbortSignal timeout (the service's timeout + 30 s, up to 1770 s). Without it fetch gives up
 * on a slow enlargement at 300 s while the service keeps working on it. As safe-url.ts pinnedFetch does.
 */
let enlargeAgent: Agent | undefined;
const defaultFetch: typeof fetch = (input, init) => {
  enlargeAgent ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return undiciFetch(input as string, { ...(init as object), dispatcher: enlargeAgent }) as unknown as Promise<Response>;
};

/** The ID token could not be minted (the metadata server); a retryable server error. */
class TokenMintError extends Error {}

/**
 * True for an answer with the service's own JSON error body (app.py: `{"error": ...}`), such as its "upscale model <id>
 * unavailable" 503; Cloud Run's own 503 (no instance) and a proxy's 5xx carry none.
 */
async function hasOwnBody(response: Response): Promise<boolean> {
  return (await answerBody(response)).own;
}
/** The answer's body once: whether it is the service's own JSON error body, and its text (for CLOUD_RUN_NOT_HANDLED). */
async function answerBody(response: Response): Promise<{ own: boolean; text: string }> {
  let text = "";
  try { text = await response.text(); } catch { return { own: false, text }; }
  try {
    const body = JSON.parse(text) as unknown;
    return { own: !!body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string", text };
  } catch { return { own: false, text }; }
}
/** The transport failure under a fetch error (undici puts the system error in `cause`). */
export function transportOf(error: unknown): EnlargeTransport {
  const codes: string[] = [];
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
  }
  if (codes.includes("ECONNREFUSED")) return "refused";
  if (codes.some((c) => c === "ENOTFOUND" || c === "EAI_AGAIN" || c === "EAI_NONAME")) return "dns";
  if (codes.some((c) => c === "ECONNRESET" || c === "UND_ERR_SOCKET" || c === "EPIPE" || c === "UND_ERR_CLOSED")) return "reset";
  return "other";
}

/** One attempt: the answer, or a typed EnlargeError. The caller's abort is rethrown as its reason. */
async function attemptOnce(req: EnlargeRequest, timeoutMs: number, attempts: number, deps: Required<Pick<EnlargeDeps, "fetch" | "idToken" | "now">>): Promise<EnlargeResult> {
  const base = req.url.trim().replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const started = deps.now();
  const callerAborted = () => req.signal?.aborted === true;
  try {
    const headers = new Headers({ "content-type": "image/jpeg" });
    setTraceHeaders(headers, req.trace);
    const minted = bearerFor(base, deps.idToken).catch((error: unknown) => { throw new TokenMintError(error instanceof Error ? error.name : "error"); });
    const bearer = await raceAbort(minted, signal);
    if (bearer) headers.set("Authorization", bearer);
    const response = await deps.fetch(`${base}/upscale?model=${encodeURIComponent(req.model)}&scale=${req.scale ?? 2}`, { method: "POST", body: new Uint8Array(req.jpeg), headers, signal });
    if (response.status === 429) throw new EnlargeBusyError(response.status, attempts);
    if (response.status === 400 || response.status === 413) throw new EnlargeBadInputError(response.status, attempts);
    if (response.status >= 500) {
      const body = await answerBody(response);
      if (response.status === 503 && body.own) throw withOwnBody(new EnlargeModelUnavailableError(attempts));
      // Spec 18 lifecycle 3.4 step 9: Cloud Run's own refusal (no instance took the request) is busy; any other 5xx
      // without the service's body (an instance killed by this input: memory, a crash) is a server failure.
      if (!body.own && CLOUD_RUN_NOT_HANDLED.test(body.text)) throw new EnlargeBusyError(response.status, attempts);
      throw body.own ? withOwnBody(new EnlargeServerError(`HTTP ${response.status}`, response.status, attempts)) : new EnlargeServerError(`HTTP ${response.status}`, response.status, attempts);
    }
    if (!response.ok) throw new EnlargeRejectedError(response.status, attempts);
    const jpeg = Buffer.from(await response.arrayBuffer());
    if (!jpeg.length) throw new EnlargeServerError("empty answer", response.status, attempts);
    const ms = Number(response.headers.get("x-upscale-ms"));
    return { jpeg, ms: Number.isFinite(ms) && ms > 0 ? ms : deps.now() - started, model: response.headers.get("x-upscale-model") ?? req.model, attempts };
  } catch (error) {
    if (callerAborted()) throw req.signal!.reason;
    if (error instanceof EnlargeError) throw error;
    if (timeout.aborted) throw new EnlargeTimeoutError(timeoutMs, attempts);
    if (error instanceof TokenMintError) throw new EnlargeServerError("no ID token", null, attempts);
    const failure = new EnlargeServerError(error instanceof Error ? error.name : "transport error", null, attempts);
    failure.transport = transportOf(error);
    throw failure;
  }
}
function withOwnBody<E extends EnlargeError>(error: E): E { error.ownBody = true; return error; }

/**
 * Spec 18 lifecycle 3.4 step 7 and 9, what one GET /health proves about the upscale service and `model`:
 * - "ok": it answered 200 and lists the model as available (or does not list models: an older service).
 * - "absent": positive proof it cannot serve now: connection refused, a DNS error, its own 503 body, or a 200 that
 *   lists the model as unavailable (not loaded, paused).
 * - "busy": 429 (every instance is working: the service is up).
 * - "no_instance": a 503 or another 5xx without its own body (Cloud Run could not give an instance): proves nothing.
 * - "timeout": no answer within `timeoutMs` (a cold start may take that long): proves nothing.
 * - "unknown": any other answer or failure: proves nothing.
 */
export type UpscaleProbe = "ok" | "absent" | "busy" | "no_instance" | "timeout" | "unknown";
export async function probeUpscaleHealth(req: { url: string; model: string; timeoutMs: number }, deps: Pick<EnlargeDeps, "fetch" | "idToken"> = {}): Promise<UpscaleProbe> {
  const base = req.url.trim().replace(/\/+$/, ""), timeout = AbortSignal.timeout(req.timeoutMs);
  const fetchFn = deps.fetch ?? defaultFetch, idToken = deps.idToken ?? (sharedIdToken ??= googleIdTokenFor());
  try {
    const headers = new Headers();
    const bearer = await raceAbort(bearerFor(base, idToken), timeout);
    if (bearer) headers.set("Authorization", bearer);
    const response = await fetchFn(`${base}/health`, { method: "GET", headers, signal: timeout });
    if (response.status === 429) return "busy";
    if (response.status >= 500) return response.status === 503 && await hasOwnBody(response) ? "absent" : "no_instance";
    if (!response.ok) return "unknown";
    const body = await response.json().catch(() => null) as { upscale?: { models?: { id?: unknown; available?: unknown }[] } } | null;
    const listed = body?.upscale?.models?.find((m) => m.id === req.model);
    return listed && listed.available === false ? "absent" : "ok";
  } catch (error) {
    if (timeout.aborted) return "timeout";
    const transport = transportOf(error);
    return transport === "refused" || transport === "dns" ? "absent" : "unknown";
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
  const io = { fetch: deps.fetch ?? defaultFetch, idToken: deps.idToken ?? (sharedIdToken ??= googleIdTokenFor()), now };
  const requestedMs = req.timeoutMs ?? enlargeTimeoutMs();
  const maxAttempts = Math.max(1, req.maxAttempts ?? ENLARGE_MAX_ATTEMPTS);
  const deadlineAt = req.deadlineAt ?? now() + ENLARGE_DISPATCH_DEADLINE_SEC * 1000 - ENLARGE_TASK_MARGIN_MS;
  // The attempt's timeout: the requested one, or the time left before the deadline when that is shorter (the task's
  // deadline already counts the time spent before the call: reads, download, prepare). A clamped attempt may give up
  // on a call the service is still allowed to finish; that beats never calling at all (2026-10-29 review, P0).
  const attemptMs = (): number => Math.min(requestedMs, deadlineAt - now());
  if (attemptMs() < Math.min(requestedMs, ENLARGE_ATTEMPT_FLOOR_MS)) throw new EnlargeTimeoutError(Math.max(0, attemptMs()), 0);
  let unavailableRetried = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce(req, attemptMs(), attempt, io);
    } catch (error) {
      if (!(error instanceof EnlargeError) || attempt >= maxAttempts) throw error;
      let wait: number;
      if (error instanceof EnlargeModelUnavailableError) {
        // Once, after 60 s (a model still loading); a second refusal stands.
        if (unavailableRetried) throw error;
        unavailableRetried = true;
        wait = ENLARGE_UNAVAILABLE_RETRY_MS;
      } else {
        if (!error.retryable) throw error;
        wait = enlargeBackoffMs(attempt, random());
      }
      // Never start an attempt shorter than the floor after the wait: an abandoned call keeps running on the service
      // and holds its slot (2026-10-29).
      if (deadlineAt - (now() + wait) < Math.min(requestedMs, ENLARGE_ATTEMPT_FLOOR_MS)) throw error;
      await sleep(wait, req.signal);
    }
  }
}
