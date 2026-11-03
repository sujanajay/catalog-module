// M6-F2-R3 (M6-S4): the worker's shutdown. Cloud Run sends SIGTERM and kills the instance 10 seconds later (a traffic
// shift drains the old revision; a scale-in or a host move ends an instance). From SIGTERM on the worker is draining:
// - a new task delivery is answered 503 at once (server.ts), so the queue sends it again to a live instance; the
//   handler never ran, so nothing is counted;
// - a chunk delivery starts no new photo (chunk.ts budgetLeft): the photo in hand finishes, the delivery saves what it
//   did and queues the rest, as at the end of its time budget;
// - an enlargement call in flight gives its counted call back and releases its claim (enlarge.ts, an onDrain hook),
//   so the queue's re-send makes it again and the cut-off delivery is never a counted failure;
// - anything still running when the process exits is left to its lease (chunks, ingest placing) or claim
//   (enlargements), which lapses and is recovered by the next delivery or the sweep, as for a crash.

/** How long index.ts waits for in-flight requests before it exits: inside Cloud Run's 10 s SIGTERM grace. */
export const DRAIN_GRACE_MS = 8_000;

type DrainHook = () => Promise<void> | void;

let draining = false;
const hooks = new Set<DrainHook>();

/** True from SIGTERM on (startDrain). */
export function isDraining(): boolean {
  return draining;
}

/** Registers `hook` to run once when draining starts; returns its removal. A hook added while draining runs at once. */
export function onDrain(hook: DrainHook): () => void {
  if (draining) {
    void Promise.resolve().then(hook).catch(() => undefined);
    return () => undefined;
  }
  hooks.add(hook);
  return () => void hooks.delete(hook);
}

/**
 * Starts draining: every hook runs once, together, and is awaited up to `withinMs` (a hook that fails or runs longer is
 * left behind; the process exit ends it). Idempotent.
 */
export async function startDrain(withinMs = DRAIN_GRACE_MS / 2): Promise<void> {
  if (draining) return;
  draining = true;
  const running = [...hooks].map((hook) => Promise.resolve().then(hook).catch(() => undefined));
  hooks.clear();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(running), new Promise<void>((resolve) => { timer = setTimeout(resolve, withinMs); })]);
  clearTimeout(timer);
}

/** Tests only: back to serving, no hooks. */
export function resetDrain(): void {
  draining = false;
  hooks.clear();
}
