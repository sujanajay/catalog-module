// AI check pacing (spec 16 F3): a per-process cap on OpenRouter requests in flight that backs off by itself.
// OpenRouter sets no fixed request limit on paid models; a 429 comes from the upstream provider, so our own
// pacing is the control. AIMD: a 429 halves the cap for a minute, then it grows back by one a minute.

/** How long a cut holds before the cap starts growing again, and the time per step back up. */
export const LLM_LIMIT_STEP_MS = 60_000;

export class LlmLimiter {
  private inflight = 0;
  private floor: number;
  private cutAt: number | null = null;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly max: number, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(max) || max < 1) throw new Error("LlmLimiter: max must be a positive whole number");
    this.floor = max;
  }

  /** The cap now: `max`, or after a 429 half of the cap then, plus one per full minute since. */
  limit(): number {
    if (this.cutAt === null) return this.max;
    const grown = this.floor + Math.floor((this.now() - this.cutAt) / LLM_LIMIT_STEP_MS);
    if (grown >= this.max) { this.cutAt = null; this.floor = this.max; return this.max; }
    return grown;
  }

  /** Requests in flight now. */
  active(): number { return this.inflight; }

  /** A 429 answer: the cap halves (at least 1) from what it is now. */
  rateLimited(): void {
    this.floor = Math.max(1, Math.floor(this.limit() / 2));
    this.cutAt = this.now();
  }

  /** Waits for a free place under the cap; the returned function frees it (once). */
  async acquire(): Promise<() => void> {
    while (this.inflight >= this.limit()) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inflight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight -= 1;
      this.wake();
    };
  }

  /** Wakes as many waiters as there are free places; each re-checks the cap. */
  private wake(): void {
    for (let free = this.limit() - this.inflight; free > 0 && this.waiting.length; free--) this.waiting.shift()!();
  }

  /** `fetch` with one place held for each HTTP attempt; a 429 answer lowers the cap. */
  wrap(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      const release = await this.acquire();
      try {
        const response = await fetchImpl(input, init);
        if (response.status === 429) this.rateLimited();
        return response;
      } finally {
        release();
      }
    };
  }
}

let shared: LlmLimiter | null | undefined;

/** The process's limiter from `LLM_INFLIGHT_PER_INSTANCE` (unset or invalid: none, no limit, today's behaviour). */
export function sharedLlmLimiter(env: NodeJS.ProcessEnv = process.env): LlmLimiter | null {
  if (shared === undefined) {
    const n = Number(env.LLM_INFLIGHT_PER_INSTANCE);
    shared = Number.isInteger(n) && n > 0 ? new LlmLimiter(n) : null;
  }
  return shared;
}

/** Tests: forget the process limiter so the next call reads the environment again. */
export function resetSharedLlmLimiter(): void { shared = undefined; }
