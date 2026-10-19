import type { BatchCounts, BatchStatus } from "../types";
export const QA_CAP_BANNER = "The quality check stopped early because the spending limit was reached.";
/** "1 product needs" / "3 products need": picks the singular or plural phrase for a count. */
const plural = (n: number, one: string, many: string) => n === 1 ? one : many;
export interface BatchState { state: "draft" | "collecting" | "processing" | "attention" | "ready" | "recheck_failed" | "failed"; pill: string; text: string; made: number; total: number; progress: number; eta: number | null; listPill: string; qualityLine?: string }
/**
 * The processing total counts every photo and marketplace pair, while the wizard's "images will be made"
 * leaves out Styli skips and unchanged pairs; this clause names them so the two figures reconcile.
 */
function notMade(c: BatchCounts): string {
  const parts = [c.skipped > 0 ? `${c.skipped} skipped` : "", c.unchanged > 0 ? `${c.unchanged} unchanged` : ""].filter(Boolean);
  return parts.length ? `, including ${parts.join(" and ")}` : "";
}
export function deriveBatchState(input: { status: BatchStatus; counts: BatchCounts; source?: string; samples?: { at: Date; made: number }[]; now?: Date }): BatchState {
  const { status, counts: c } = input;
  const made = Math.min(c.outputs,Number((c as BatchCounts & {staged?:number}).staged ?? 0) + c.verified + c.needsAttention + c.failed + c.skipped + c.unchanged);
  const result: BatchState = { state: "draft", pill: "Draft", text: "Check what we found and start processing.", made, total: c.outputs, progress: c.outputs ? Math.min(1, made / c.outputs) : 0, eta: null, listPill: "Draft" };
  if (status === "failed") return { ...result, state: "failed", pill: "Could not start", listPill: "Could not start", text: c.failReason ?? "Start the batch again." };
  if (status === "ingesting") return { ...result, state: "collecting", pill: "Collecting files", text: `${c.collected} of ${c.collectTotal ?? "?"} files copied from your ${input.source ?? "links"}`, listPill: `Collecting files ${c.collected} of ${c.collectTotal ?? "?"}` };
  if (["matting", "rendering", "qa", "publishing"].includes(status)) {
    const now = (input.now ?? new Date()).getTime(), samples = (input.samples ?? []).filter(s => now - s.at.getTime() <= 300_000).sort((a,b) => +a.at - +b.at);
    const first = samples[0], last = samples.at(-1);
    const rate = first && last && +last.at > +first.at ? (last.made - first.made) / ((+last.at - +first.at) / 1000) : 0;
    const eta = rate > 0 ? Math.ceil(Math.max(0, c.outputs - made) / rate) : null;
    return { ...result, state: "processing", pill: "Processing", listPill: `Processing ${made.toLocaleString("en")} of ${c.outputs.toLocaleString("en")}`, eta,...(status === "qa" ? {qualityLine:"Quality check running"}:{}), text: `${made} of ${c.outputs} ${plural(c.outputs, "image", "images")} made${notMade(c)}${eta === null ? "" : ` · about ${Math.ceil(eta / 60)} min left`}` };
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
