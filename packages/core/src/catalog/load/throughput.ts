// Spec 16 F4: the load report's throughput fields, shared by the local scale model and any load run that has
// per-image finish times and per-task durations.
import { percentile } from "./timing";

/** Images finished per minute in each 5-minute window from `startMs` (index 0 is minutes 0 to 5). */
export function imagesPerMinuteBy5Min(finishedAtMs: readonly number[], startMs = 0): number[] {
  const windows: number[] = [];
  for (const at of finishedAtMs) {
    const i = Math.max(0, Math.floor((at - startMs) / 300_000));
    while (windows.length <= i) windows.push(0);
    windows[i]! += 1;
  }
  return windows.map((n) => Math.round((n / 5) * 10) / 10);
}

/** p50 and p95 per stage of task durations in ms (0 for a stage with none). */
export function stageTaskMs(durations: Readonly<Record<string, readonly number[]>>): Record<string, { p50: number; p95: number; n: number }> {
  return Object.fromEntries(Object.entries(durations).map(([stage, ms]) => [stage, { p50: percentile(ms, 50) ?? 0, p95: percentile(ms, 95) ?? 0, n: ms.length }]));
}

/** The best average images per minute over any `minutes`-long run of whole minutes. */
export function bestMinutesRate(finishedAtMs: readonly number[], minutes: number, startMs = 0): number {
  const perMinute: number[] = [];
  for (const at of finishedAtMs) {
    const i = Math.max(0, Math.floor((at - startMs) / 60_000));
    while (perMinute.length <= i) perMinute.push(0);
    perMinute[i]! += 1;
  }
  let best = 0;
  for (let i = 0; i + minutes <= perMinute.length; i++) best = Math.max(best, perMinute.slice(i, i + minutes).reduce((a, b) => a + b, 0) / minutes);
  return best;
}
