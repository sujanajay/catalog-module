import { describeError, isTransientDbError, retryTransient } from "../../retry";

export interface PollOptions<T> {
  /** One read of the state (for the load driver: the batch row and its chunks). */
  read: () => Promise<T>;
  /** True when the state is terminal. */
  isEnd: (value: T) => boolean;
  /** Epoch ms after which polling stops without an end state. */
  deadline: number;
  intervalMs: number;
  /** Attempts per read, the first included (default 5, backoff 1, 2, 4, 8 s). */
  tries?: number;
  onValue?: (value: T) => void;
  /** Called when a read still fails after its retries; polling goes on. */
  onError?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollResult<T> { ended: boolean; last: T | null; errors: string[] }

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Polls until the state is terminal or the deadline passes. Each read retries transient database
 * errors with backoff; a read that still fails is recorded and the next poll goes ahead, so one
 * failed query never ends the wait (the first load run died on a single "too many connections").
 */
export async function pollUntilEnd<T>(o: PollOptions<T>): Promise<PollResult<T>> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? realSleep, errors: string[] = [];
  let last: T | null = null;
  for (;;) {
    try {
      last = await retryTransient(() => o.read(), { tries: o.tries ?? 5, isTransient: isTransientDbError, sleep });
      o.onValue?.(last);
      if (o.isEnd(last)) return { ended: true, last, errors };
    } catch (err) {
      const message = describeError(err);
      errors.push(message);
      o.onError?.(message);
    }
    if (now() > o.deadline) return { ended: false, last, errors };
    await sleep(o.intervalMs);
  }
}
