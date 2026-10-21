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
/**
 * How long a batch usually takes, in whole minutes, from the images wizard step 4 will make. Fitted on
 * measured runs: 10 images took 1 to 3.5 min, 5,032 images took 43 min. The low end is rounded so a
 * tiny batch reads "about 1 to 5 minutes"; the high end is rounded up so it stays a ceiling.
 */
export function waitRangeMinutes(images: number): { low: number; high: number } {
  const n = Math.max(0, images);
  return { low: Math.max(1, Math.round(1 + n / 120)), high: Math.ceil(4 + n / 90) };
}
/** Wizard step 4, before Start. */
export function waitText(images: number): string {
  const { low, high } = waitRangeMinutes(images);
  return `This usually takes about ${low} to ${high} minutes. After you press Start you can close this page; the batch keeps going, and you can come back to it any time from All batches.`;
}
export const ANOTHER_BATCH_RUNNING = "Another batch is running; yours may wait behind it.";
export const CLOSE_PAGE_TEXT = "You can close this page and come back; nothing stops.";
export const STARTING_SERVICES_TEXT = "Starting the image services. The first pictures usually take a minute or two on the first batch after a quiet spell.";
/**
 * The Ready clause for Styli pairs not made because the photo is too small (spec 07 R8): the banner must
 * not hide them. Its count is only those Styli skips, never removed, replaced or size-chart skips.
 */
export function styliSkipText(skipped: number): string {
  return `${skipped} Styli ${plural(skipped, "image was", "images were")} not made because the ${plural(skipped, "photo is", "photos are")} too small for Styli even after enlargement (see the notes column).`;
}
/**
 * The time left while processing, worked out from when Start was pressed and how many images are made,
 * so it is the same on every reload. Before 10% is made the measured rate means little, so the usual
 * range for the batch size is shown, less the time already spent; after that the measured rate decides.
 */
export function timeLeftText(input: { planned: number; done: number; startedAt: Date | string; now: Date }): string {
  const elapsedMin = Math.max(0, (input.now.getTime() - new Date(input.startedAt).getTime()) / 60_000);
  if (input.planned <= 0 || input.done < input.planned * 0.1) {
    const { low, high } = waitRangeMinutes(input.planned);
    const lo = Math.max(1, Math.round(low - elapsedMin)), hi = Math.max(lo, Math.ceil(high - elapsedMin));
    return lo === hi ? `about ${lo} min left` : `about ${lo} to ${hi} min left`;
  }
  const perMinute = input.done / Math.max(elapsedMin, 1 / 60);
  return `about ${Math.max(1, Math.ceil((input.planned - input.done) / perMinute))} min left`;
}
export function deriveBatchState(input: { status: BatchStatus; counts: BatchCounts; source?: string; samples?: { at: Date; made: number }[]; now?: Date; updatedAt?: Date | string; startedAt?: Date | string | null; /** Styli outputs skipped as too small; counts.skipped also holds removed and chart skips. */ styliSkipped?: number }): BatchState {
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
    // The server's figure from startedAt survives reloads; browser samples are only a fallback without one.
    const left = input.startedAt ? timeLeftText({ planned, done, startedAt: input.startedAt, now: new Date(now) }) : eta === null ? "" : `about ${Math.ceil(eta / 60)} min left`;
    return { ...result, state: "processing", pill: "Processing", made: done, total: planned, progress: planned ? Math.min(1, done / planned) : 0, listPill: `Processing ${done.toLocaleString("en")} of ${planned.toLocaleString("en")}`, eta,...(status === "qa" ? {qualityLine:"Quality check running"}:{}), text: [`${done} of ${planned} ${plural(planned, "image", "images")} made${notMade(c)}${left ? ` · ${left}` : ""}.`, CLOSE_PAGE_TEXT, ...(status === "matting" && done === 0 ? [STARTING_SERVICES_TEXT] : [])].join(" ") };
  }
  if (status === "done") {
    const capped = (c as BatchCounts & { qaCapped?: boolean }).qaCapped ? ` ${QA_CAP_BANNER}` : "";
    if (c.attentionProducts > 0) return { ...result, state: "attention", pill: `${c.attentionProducts} ${plural(c.attentionProducts, "product needs", "products need")} your attention`, listPill: `Needs attention (${c.attentionProducts} ${plural(c.attentionProducts, "product", "products")})`, text: `Everything else is done and in the sheet. Decide now or download the sheet as it is; each decision updates the sheet.${capped}` };
    const planned = c.outputs - c.skipped;
    if (c.verified === planned && c.recheckOk !== null && c.recheckTotal !== null && c.recheckOk === c.recheckTotal) return { ...result, state: "ready", pill: "Ready", listPill: "Ready to download", text: `All ${planned} ${plural(planned, "image is", "images are")} live and passed every check. ${(input.styliSkipped ?? 0) > 0 ? styliSkipText(input.styliSkipped!) : "Nothing needs your attention."}` };
    const bad = Math.max(planned - c.verified, (c.recheckTotal ?? planned) - (c.recheckOk ?? 0));
    return { ...result, state: "recheck_failed", pill: `${bad} ${plural(bad, "link", "links")} did not pass the independent re-check`, listPill: `${bad} ${plural(bad, "link needs", "links need")} a check`, text: `The sheet is ready but ${bad} ${plural(bad, "link", "links")} did not pass the independent re-check. See Details before sharing it.` };
  }
  return result;
}
