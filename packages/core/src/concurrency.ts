// Small helpers for running async work a few at a time (spec 16 F3).

/** `fn` over `items` with at most `limit` running at once; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * `fn` over `items` with at most `limit` running at once, for work that must not be cut off half way (a photo
 * in a chunk delivery). No new item starts once `stop()` answers true or an earlier item threw; every started
 * item still finishes, and only then is the first error rethrown, so nothing keeps running after the caller
 * has moved on. Returns the index of the first item that did not start, or null when every item ran.
 */
export async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>, stop: () => boolean = () => false): Promise<number | null> {
  let next = 0, failed = false, firstError: unknown, notStarted: number | null = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      if (stop()) { notStarted ??= next; return; }
      const i = next++;
      try { await fn(items[i]!, i); }
      catch (error) { if (!failed) { failed = true; firstError = error; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  if (failed) throw firstError;
  return notStarted;
}

/** A one-at-a-time lock: `run` waits for every earlier `run` to settle. */
export function serialLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** A positive whole number from the environment, or the fallback. */
export function positiveIntEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : fallback;
}
