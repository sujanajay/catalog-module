import type { BatchCounts, BatchStatus } from "../types";
export interface BatchState { state: "draft" | "collecting" | "processing" | "attention" | "ready" | "recheck_failed" | "failed"; pill: string; text: string; made: number; total: number; progress: number; eta: number | null; listPill: string }
export function deriveBatchState(input: { status: BatchStatus; counts: BatchCounts; source?: string; samples?: { at: Date; made: number }[]; now?: Date }): BatchState {
  const { status, counts: c } = input;
  const made = Math.min(c.outputs,c.verified + c.needsAttention + c.failed + c.skipped + c.unchanged);
  const result: BatchState = { state: "draft", pill: "Draft", text: "Check what we found and start processing.", made, total: c.outputs, progress: c.outputs ? Math.min(1, made / c.outputs) : 0, eta: null, listPill: "Draft" };
  if (status === "failed") return { ...result, state: "failed", pill: "Could not start", listPill: "Could not start", text: c.failReason ?? "Start the batch again." };
  if (status === "ingesting") return { ...result, state: "collecting", pill: "Collecting files", text: `${c.collected} of ${c.collectTotal ?? "?"} files copied from your ${input.source ?? "links"}`, listPill: `Collecting files ${c.collected} of ${c.collectTotal ?? "?"}` };
  if (["matting", "rendering", "qa", "publishing"].includes(status)) {
    const now = (input.now ?? new Date()).getTime(), samples = (input.samples ?? []).filter(s => now - s.at.getTime() <= 300_000).sort((a,b) => +a.at - +b.at);
    const first = samples[0], last = samples.at(-1);
    const rate = first && last && +last.at > +first.at ? (last.made - first.made) / ((+last.at - +first.at) / 1000) : 0;
    const eta = rate > 0 ? Math.ceil(Math.max(0, c.outputs - made) / rate) : null;
    return { ...result, state: "processing", pill: "Processing", listPill: `Processing ${made.toLocaleString("en")} of ${c.outputs.toLocaleString("en")}`, eta, text: `${made} of ${c.outputs} images made${eta === null ? "" : ` · about ${Math.ceil(eta / 60)} min left`}` };
  }
  if (status === "done") {
    if (c.attentionProducts > 0) return { ...result, state: "attention", pill: `${c.attentionProducts} products need your attention`, listPill: `Needs attention (${c.attentionProducts} products)`, text: "Everything else is done and in the sheet. Decide now or download the sheet as it is; each decision updates the sheet." };
    const planned = c.outputs - c.skipped;
    if (c.verified === planned && c.recheckOk !== null && c.recheckTotal !== null && c.recheckOk === c.recheckTotal) return { ...result, state: "ready", pill: "Ready", listPill: "Ready to download", text: `All ${planned} images are live and passed every check. Nothing needs your attention.` };
    const bad = Math.max(planned - c.verified, (c.recheckTotal ?? planned) - (c.recheckOk ?? 0));
    return { ...result, state: "recheck_failed", pill: `${bad} links did not pass the independent re-check`, listPill: `${bad} links need a check`, text: `The sheet is ready but ${bad} links did not pass the independent re-check. See Details before sharing it.` };
  }
  return result;
}
