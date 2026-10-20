/**
 * In-process drivers (the tier 5 smoke, the eval and QA check jobs) call the chunk handler directly
 * instead of through Cloud Tasks. A chunk that answers 503 "retry" (for example while the cut-out
 * services are cold after min-instances 0) is retried by Cloud Tasks with backoff in production;
 * these helpers give the in-process drivers the same behaviour so a cold start is not a failure.
 */

/** Waits between retries: 5 s, 10 s, 20 s, 30 s, then every 30 s. */
export const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;
/** How long a chunk may keep answering "retry" before the driver gives up. */
export const CHUNK_RETRY_BUDGET_MS = 10 * 60_000;
/** How long the cut-out services may take to report a default after a cold start. */
export const COLD_START_BUDGET_MS = 5 * 60_000;

export function retryDelayMs(retry: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, retry), RETRY_DELAYS_MS.length - 1)]!;
}

export interface RetryClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  budgetMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultLog = (message: string, fields?: Record<string, unknown>) => console.info(JSON.stringify({ message, ...fields }));

export interface TaskResult { httpStatus: number; outcome: string }

/**
 * Runs a task handler until it answers anything other than 503 "retry", waiting like Cloud Tasks
 * between calls. When the budget would be exceeded it returns the last "retry" result, so the
 * caller's own check fails with that outcome.
 */
export async function runUntilSettled<T extends TaskResult>(
  run: () => Promise<T>,
  opts: RetryClock & { label?: string; reason?: () => string | undefined } = {},
): Promise<T> {
  const now = opts.now ?? Date.now, sleep = opts.sleep ?? realSleep, log = opts.log ?? defaultLog;
  const budget = opts.budgetMs ?? CHUNK_RETRY_BUDGET_MS;
  const started = now();
  for (let retry = 0; ; retry++) {
    const result = await run();
    if (result.httpStatus !== 503 || result.outcome !== "retry") return result;
    const waitMs = retryDelayMs(retry), elapsedMs = now() - started;
    if (elapsedMs + waitMs > budget) {
      log("task retry budget exhausted", { task: opts.label, retries: retry, elapsedMs, reason: opts.reason?.() });
      return result;
    }
    log("task retry", { task: opts.label, retry: retry + 1, outcome: result.outcome, reason: opts.reason?.(), waitMs, elapsedMs });
    await sleep(waitMs);
  }
}

/**
 * Polls the cut-out services' health until they report a default model, with the same backoff, so
 * a cold start is waited out once before the first chunk and its duration shows in the log.
 */
export async function waitForCutOutDefault(matting: { health(): Promise<{ default: string }> }, opts: RetryClock = {}): Promise<number> {
  const now = opts.now ?? Date.now, sleep = opts.sleep ?? realSleep, log = opts.log ?? defaultLog;
  const budget = opts.budgetMs ?? COLD_START_BUDGET_MS;
  const started = now();
  for (let retry = 0; ; retry++) {
    let reason: string | undefined;
    try {
      if ((await matting.health()).default) {
        const elapsedMs = now() - started;
        log("cut-out service warm", { elapsedMs, checks: retry + 1 });
        return elapsedMs;
      }
      reason = "no default reported yet";
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    const waitMs = retryDelayMs(retry), elapsedMs = now() - started;
    if (elapsedMs + waitMs > budget) throw new Error(`The cut-out service did not report a default within ${Math.round(budget / 1000)} seconds (${reason}).`);
    log("cut-out service not warm yet", { check: retry + 1, reason, waitMs, elapsedMs });
    await sleep(waitMs);
  }
}
