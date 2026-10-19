import type { BatchCounts, BatchStatus } from "../types";
export const QA_CAP_BANNER = "The quality check stopped early because the spending limit was reached.";
/** "1 product needs" / "3 products need": picks the singular or plural phrase for a count. */
const plural = (n: number, one: string, many: string) => n === 1 ? one : many;
export interface BatchState { state: "draft" | "collecting" | "processing" | "attention" | "ready" | "recheck_failed" | "failed"; pill: string; text: string; made: number; total: number; progress: number; eta: number | null; listPill: string; qualityLine?: string; /** Collecting with no progress for COLLECT_STALL_MS: the page offers "Try again". */ stalled?: boolean }
/**
 * A collecting batch whose row has not changed for this long is stalled. Every ingest call writes
 * the batch's counts (which moves updated_at), and one call is cut off by the 15-minute task
 * deadline at the latest, so 10 minutes of silence almost always means the hand-off or the task
 * chain was lost. "Try again" re-runs the hand-off idempotently, so an early press costs nothing.
 */
export const COLLECT_STALL_MS = 10 * 60_000;
export const COLLECT_STALLED_TEXT = "Collecting files stopped: nothing has moved for more than 10 minutes. Press Try again to hand the files to processing again.";
/**
 * The processing total is wizard step 4's "images will be made": it leaves out skipped pairs (too
 * small for Styli, or removed) and unchanged pairs; this clause names them so nothing goes unmentioned.
 */
function notMade(c: BatchCounts): string {
  const parts = [c.skipped > 0 ? `${c.skipped} skipped (too small for Styli or removed)` : "", c.unchanged > 0 ? `${c.unchanged} unchanged` : ""].filter(Boolean);
  return parts.length ? `, not counting ${parts.join(" and ")}` : "";
}
export function deriveBatchState(input: { status: BatchStatus; counts: BatchCounts; source?: string; samples?: { at: Date; made: number }[]; now?: Date; updatedAt?: Date | string }): BatchState {
  const { status, counts: c } = input;
  const made = Math.min(c.outputs,Number((c as BatchCounts & {staged?:number}).staged ?? 0) + c.verified + c.needsAttention + c.failed + c.skipped + c.unchanged);
  const result: BatchState = { state: "draft", pill: "Draft", text: "Check what we found and start processing.", made, total: c.outputs, progress: c.outputs ? Math.min(1, made / c.outputs) : 0, eta: null, listPill: "Draft" };
  if (status === "failed") return { ...result, state: "failed", pill: "Could not start", listPill: "Could not start", text: c.failReason ?? "Start the batch again." };
  if (status === "ingesting") {
    const stalled = input.updatedAt !== undefined && (input.now ?? new Date()).getTime() - new Date(input.updatedAt).getTime() > COLLECT_STALL_MS;
    return { ...result, state: "collecting", pill: "Collecting files", text: stalled ? COLLECT_STALLED_TEXT : `${c.collected} of ${c.collectTotal ?? "?"} files copied from your ${input.source ?? "links"}`, listPill: `Collecting files ${c.collected} of ${c.collectTotal ?? "?"}`, ...(stalled ? { stalled } : {}) };
  }
  if (["matting", "rendering", "qa", "publishing"].includes(status)) {
    const now = (input.now ?? new Date()).getTime(), samples = (input.samples ?? []).filter(s => now - s.at.getTime() <= 300_000).sort((a,b) => +a.at - +b.at);
    const first = samples[0], last = samples.at(-1);
    const rate = first && last && +last.at > +first.at ? (last.made - first.made) / ((+last.at - +first.at) / 1000) : 0;
    const eta = rate > 0 ? Math.ceil(Math.max(0, c.outputs - made) / rate) : null;
    // Skipped and unchanged pairs are not made, so they count on neither side: the figure is wizard step 4's "images will be made".
    const planned = Math.max(0, c.outputs - c.skipped - c.unchanged), done = Math.min(planned, Math.max(0, made - c.skipped - c.unchanged));
    return { ...result, state: "processing", pill: "Processing", made: done, total: planned, progress: planned ? Math.min(1, done / planned) : 0, listPill: `Processing ${done.toLocaleString("en")} of ${planned.toLocaleString("en")}`, eta,...(status === "qa" ? {qualityLine:"Quality check running"}:{}), text: `${done} of ${planned} ${plural(planned, "image", "images")} made${notMade(c)}${eta === null ? "" : ` · about ${Math.ceil(eta / 60)} min left`}` };
  }
  if (status === "done") {
    const capped = (c as BatchCounts & { qaCapped?: boolean }).qaCapped ? ` ${QA_CAP_BANNER}` : "";
    if (c.attentionProducts > 0) return { ...result, state: "attention", pill: `${c.attentionProducts} ${plural(c.attentionProducts, "product needs", "products need")} your attention`, listPill: `Needs attention (${c.attentionProducts} ${plural(c.attentionProducts, "product", "products")})`, text: `Everything else is done and in the sheet. Decide now or download the sheet as it is; each decision updates the sheet.${capped}` };
    const planned = c.outputs - c.skipped;
    if (c.verified === planned && c.recheckOk !== null && c.recheckTotal !== null && c.recheckOk === c.recheckTotal) return { ...result, state: "ready", pill: "Ready", listPill: "Ready to download", text: `All ${planned} ${plural(planned, "image is", "images are")} live and passed every check. Nothing needs your attention.` };
    const bad = Math.max(planned - c.verified, (c.recheckTotal ?? planned) - (c.recheckOk ?? 0));
    return { ...result, state: "recheck_failed", pill: `${bad} ${plural(bad, "link", "links")} did not pass the independent re-check`, listPill: `${bad} ${plural(bad, "link needs", "links need")} a check`, text: `The sheet is ready but ${bad} ${plural(bad, "link", "links")} did not pass the independent re-check. See Details before sharing it.` };
  }
  return result;
}
