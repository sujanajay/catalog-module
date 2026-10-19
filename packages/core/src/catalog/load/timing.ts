// Timing math for the load report (spec 09 section 4.1). Chunk rows advance their stage in place,
// so the driver samples them while it polls; stage windows are derived from those samples.
import type { CHUNK_STAGES } from "../../db/schema";

export const LOAD_TARGET_MS = 2 * 60 * 60 * 1000;
type Stage = (typeof CHUNK_STAGES)[number];

/** Nearest-rank percentile (p in 0..100); null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export interface ChunkSample { at: Date; chunks: { id: string; stage: Stage; status: string; startedAt: Date | null; finishedAt?: Date | null }[] }

/**
 * Per stage: from the earliest start seen in that stage (a running chunk's `startedAt`, or the
 * sample time for a queued one) to the latest end (a finished chunk's `finishedAt`, or the sample
 * time while a chunk is still queued or running in it); accurate to one poll interval.
 */
export function stageWindows(samples: readonly ChunkSample[]): Partial<Record<Stage, { startAt: Date; endAt: Date; ms: number }>> {
  const out: Partial<Record<Stage, { startAt: Date; endAt: Date; ms: number }>> = {};
  for (const sample of samples) {
    for (const chunk of sample.chunks) {
      if (chunk.status === "queued" && !chunk.startedAt) continue;
      const ended = chunk.status === "done" || chunk.status === "failed";
      const start = chunk.startedAt && chunk.status !== "queued" ? chunk.startedAt : sample.at;
      const end = ended ? chunk.finishedAt ?? sample.at : sample.at;
      const w = out[chunk.stage];
      const startAt = w && w.startAt <= start ? w.startAt : start;
      const endAt = w && w.endAt >= end ? w.endAt : end;
      out[chunk.stage] = { startAt, endAt, ms: Math.max(0, endAt.getTime() - startAt.getTime()) };
    }
  }
  return out;
}

/** Items per minute over a window; null when the window is empty. */
export function perMinute(count: number, ms: number): number | null {
  return ms > 0 ? Math.round((count / (ms / 60_000)) * 10) / 10 : null;
}

/** Wall time from "Start processing" to the end state, and whether it is inside the 2-hour target. */
export function againstTarget(startedAt: Date, finishedAt: Date, targetMs = LOAD_TARGET_MS): { ms: number; withinTarget: boolean } {
  const ms = finishedAt.getTime() - startedAt.getTime();
  return { ms, withinTarget: ms <= targetMs };
}

/** "1 h 05 min" style duration for the report. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000), h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
