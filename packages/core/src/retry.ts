/**
 * Bounded retries for transient failures of Google API calls (gRPC or HTTP).
 *
 * A Cloud Run instance whose CPU is throttled between requests can find its gRPC channel reset
 * ("14 UNAVAILABLE: read ECONNRESET") on the next call. That is transient: the same call a moment
 * later succeeds. Only wrap calls that are safe to repeat (for example a Cloud Tasks createTask
 * with a task name, which the queue deduplicates).
 */

/** gRPC status codes that mean "try again": DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE. */
const TRANSIENT_GRPC_CODES = new Set([4, 8, 13, 14]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True for UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED and INTERNAL gRPC errors, HTTP 429
 * and 5xx, and socket resets or timeouts. Numbers below 100 are gRPC codes; 100 and up are HTTP.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = typeof e.status === "number" ? e.status : typeof e.response?.status === "number" ? e.response.status : undefined;
  if (typeof e.code === "number") {
    if (e.code < 100) return TRANSIENT_GRPC_CODES.has(e.code);
    return e.code === 429 || (e.code >= 500 && e.code <= 599);
  }
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  if (typeof e.code === "string" && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  const message = err instanceof Error ? err.message : "";
  return /ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
}

export interface RetryOptions {
  /** Total attempts, the first included. Default 5. */
  tries?: number;
  /** First wait; each later wait doubles, capped at maxDelayMs. Default 1000 ms. */
  baseDelayMs?: number;
  /** Default 8000 ms, so 5 tries wait 1 + 2 + 4 + 8 = 15 s at most between calls. */
  maxDelayMs?: number;
  /** Which errors are worth another try. Default isTransientError. */
  isTransient?: (err: unknown) => boolean;
  /** Test hook for the wait between tries. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn, retrying transient failures with exponential backoff. A permanent error, or the last
 * transient one, is thrown unchanged so the caller can log it and map it to plain words.
 */
export async function retryTransient<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = Math.max(1, opts.tries ?? 5);
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 8000;
  const transient = opts.isTransient ?? isTransientError;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= tries || !transient(err)) throw err;
      await sleep(Math.min(max, base * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Postgres SQLSTATE codes that mean "try again": connection exceptions (class 08), too many
 * connections (53300, which Cloud SQL reports as "remaining connection slots are reserved..."),
 * and server shutdown or restart (57P01, 57P02, 57P03).
 */
const TRANSIENT_PG_CODES = new Set(["08000", "08001", "08003", "08004", "08006", "53300", "57P01", "57P02", "57P03"]);
const TRANSIENT_PG_MESSAGE = /remaining connection slots|too many clients|Connection terminated|timeout exceeded when trying to connect|ECONNRESET|ETIMEDOUT/i;

/**
 * isTransientError for database calls. Drizzle wraps the driver error ("Failed query: ...") and
 * keeps it on `cause`, so the whole cause chain is checked.
 */
export function isTransientDbError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_PG_CODES.has(code)) return true;
    if (isTransientError(e)) return true;
    if (e instanceof Error && TRANSIENT_PG_MESSAGE.test(e.message)) return true;
  }
  return false;
}

/** An error's message followed by its cause chain, so a wrapped driver error is not lost in a log. */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = typeof e === "object" ? (e as { code?: unknown }).code : undefined;
    parts.push(`${e instanceof Error ? e.message : String(e)}${typeof code === "string" || typeof code === "number" ? ` [${code}]` : ""}`);
    if (typeof e !== "object") break;
  }
  return parts.join(" <- caused by: ");
}
