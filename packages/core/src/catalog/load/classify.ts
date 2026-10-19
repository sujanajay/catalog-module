// Result classification for the load report (spec 09 section 4.1): every output must end
// `verified`, `needs_attention`, `skipped` or `failed` with a reason; anything else is silent.
export interface OutputLike { id: string; status: string; reason: string | null; channel: string; n: number; productId: string }

export interface Classified {
  byStatus: Record<string, number>;
  failed: { id: string; productId: string; channel: string; n: number; reason: string }[];
  errorsByReason: Record<string, number>;
  /** Outputs still `pending`/`staged`, or `failed` without a reason. Must be empty. */
  silent: { id: string; status: string }[];
}

const ENDED = new Set(["verified", "needs_attention", "skipped", "failed"]);

export function classifyOutputs(outputs: readonly OutputLike[]): Classified {
  const result: Classified = { byStatus: {}, failed: [], errorsByReason: {}, silent: [] };
  for (const o of outputs) {
    result.byStatus[o.status] = (result.byStatus[o.status] ?? 0) + 1;
    const reason = o.reason?.trim() ?? "";
    if (!ENDED.has(o.status) || (o.status === "failed" && !reason)) { result.silent.push({ id: o.id, status: o.status }); continue; }
    if (o.status === "failed") {
      result.failed.push({ id: o.id, productId: o.productId, channel: o.channel, n: o.n, reason });
      result.errorsByReason[reason] = (result.errorsByReason[reason] ?? 0) + 1;
    }
  }
  return result;
}
