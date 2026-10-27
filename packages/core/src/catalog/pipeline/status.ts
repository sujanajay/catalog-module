import type { BatchCounts, BatchStatus, ChannelId, IntakePhase } from "../types";
export const QA_CAP_BANNER = "The quality check stopped early because the spending limit was reached.";
/** "1 product needs" / "3 products need": picks the singular or plural phrase for a count. */
const plural = (n: number, one: string, many: string) => n === 1 ? one : many;
/** Whole numbers with thousands separators ("1,400"). */
const num = (n: number) => n.toLocaleString("en-US");
export interface BatchState {
  state: "draft" | "collecting" | "processing" | "attention" | "ready" | "recheck_failed" | "failed" | "cancelled";
  pill: string; text: string; made: number; total: number; progress: number; eta: number | null; listPill: string; qualityLine?: string;
  /** Collecting with no progress for COLLECT_STALL_MS: the page offers "Try again". */ stalled?: boolean;
  /**
   * The state words of an unfinished batch (spec 14c F4 part 2, "Your unfinished batches"): "Ready to check",
   * "Placing photos 300 of 1,400, about 3 min left", "Could not start: <reason>", "Cancelled 2 days ago".
   * For a started batch it is the list pill.
   */
  intake: string;
  /** Failed before Start (`failed`, `startedAt` null): the batch offers "Fix and continue" (spec 14c F8). */
  fixable?: boolean;
}
/** A batch that failed before Start can be reopened (spec 14c F8). `startedAt` must be read from the row. */
export function failedBeforeStart(batch: { status: BatchStatus; startedAt: Date | string | null }): boolean {
  return batch.status === "failed" && batch.startedAt === null;
}

// --- Intake words and time (spec 14c F4 part 2 and F6) -------------------------------------------
export const NOTHING_ADDED_TEXT = "Nothing added yet";
export const READY_TO_CHECK_TEXT = "Ready to check";
export const READY_TO_START_TEXT = "Ready to start";
export const NEEDS_INPUT_TEXT = "Needs your input: which column holds the identifier?";
/** A draft with inputs that were never handed to collecting (step 1 Continue not pressed, or its hand-off failed). Not in the parent copy register: proposed in the 14c c1 report. */
export const NOT_COLLECTED_TEXT = "Added, not collected yet";
export const pendingUploadsText = (n: number) => `${num(n)} ${plural(n, "file", "files")} did not finish uploading`;
export const couldNotStartText = (reason: string | null | undefined) => `Could not start: ${reason ?? "Start the batch again."}`;
export const cancelledText = (age: string) => `Cancelled ${age}`;
/** A draft the sweep cancelled after `days` days without a write (spec 14d F12). */
export const expiredText = (days: number) => `Expired after ${num(days)} ${plural(days, "day", "days")} with no activity`;
/** The words of each phase while collecting or placing; a count "<done> of <total>" follows them. */
export const PHASE_WORDS: Record<"downloading" | "reading" | "unpacking" | "checking" | "placing", string> = {
  downloading: "Downloading photos",
  reading: "Reading your sheet",
  unpacking: "Unpacking your zip",
  checking: "Checking your uploaded files",
  placing: "Placing photos",
};
/** The collecting phase a batch's source implies, for rows written before the worker wrote `phase` (as `collectingText` picks today). */
export function sourcePhase(source: string | undefined): "downloading" | "unpacking" | "checking" {
  return source === "zip" ? "unpacking" : source === "upload" ? "checking" : "downloading";
}
/** The phase whose words and count an `ingesting` batch shows: the stored one, else the source's. `ready` and `needs_input` while still `ingesting` are the end of placing. */
export function shownPhase(phase: IntakePhase | null | undefined, source?: string): keyof typeof PHASE_WORDS {
  if (phase === "placing" || phase === "ready" || phase === "needs_input") return "placing";
  if (phase === "downloading" || phase === "reading" || phase === "unpacking" || phase === "checking") return phase;
  return sourcePhase(source);
}
/** The done count and total of a phase: `placed` of `placeTotal` while placing, else `collected` of `collectTotal`. */
export function phaseCount(c: BatchCounts, phase: keyof typeof PHASE_WORDS): { done: number; total: number | null } {
  return phase === "placing" ? { done: c.placed ?? 0, total: c.placeTotal ?? null } : { done: c.collected, total: c.collectTotal };
}
/** Samples must be at least this far apart before a rate is measured. */
export const RATE_MIN_SPAN_MS = 20_000;
/**
 * The time left of the current intake phase (spec 14c F6): from the last sample of the current phase and
 * the latest earlier one at least RATE_MIN_SPAN_MS before it, the rate per minute; "about <m> min left"
 * with m = ceil((total - done) / rate) less the minutes since the last sample, "a few minutes left" under
 * 2 min. Empty when the phase or its total is unknown, fewer than two current-phase samples exist, or
 * nothing moved between them. Never fitted: no text until a rate is measured.
 */
export function intakeTimeText(c: BatchCounts, now: Date): string {
  if (!c.phase) return "";
  const phase = shownPhase(c.phase);
  const samples = (c.rate ?? []).filter((s) => s.phase === c.phase).map((s) => ({ at: new Date(s.at).getTime(), done: s.done })).filter((s) => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  const last = samples.at(-1);
  const first = last && samples.filter((s) => last.at - s.at >= RATE_MIN_SPAN_MS).at(-1);
  const { done, total } = phaseCount(c, phase);
  if (!last || !first || !total) return "";
  const perMinute = (last.done - first.done) / ((last.at - first.at) / 60_000);
  if (!(perMinute > 0)) return "";
  const minutes = Math.max(0, total - Math.max(done, last.done)) / perMinute - Math.max(0, now.getTime() - last.at) / 60_000;
  return minutes < 2 ? "a few minutes left" : `about ${Math.ceil(minutes)} min left`;
}
/** "just now", "5 minutes ago", "3 hours ago", "2 days ago": the age in the unfinished list and "Cancelled <age>". */
export function ageText(at: Date | string, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute", "minutes")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, "hour", "hours")} ago`;
  const days = Math.floor(hours / 24);
  return `${num(days)} ${plural(days, "day", "days")} ago`;
}
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
 * The Ready clause for Styli pairs not made because the photo is too small (spec 07 R8, batches before 2026-10-22,
 * when Styli still skipped photos for their size): the banner must
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
/** Draft words: what an operator returning to an unfinished draft must do next (spec 14c F4 part 2). Without `uploads` the input checks are skipped. */
function draftWords(c: BatchCounts, channels: readonly ChannelId[] | undefined, uploads: readonly { status: string }[] | undefined): string {
  const inputs = uploads?.filter((u) => u.status !== "removed");
  const pending = inputs?.filter((u) => u.status === "pending").length ?? 0;
  if (pending > 0) return pendingUploadsText(pending);
  if (inputs && !inputs.length) return NOTHING_ADDED_TEXT;
  if (c.phase === "needs_input") return NEEDS_INPUT_TEXT;
  if (!c.previewReady) return NOT_COLLECTED_TEXT;
  return channels?.length ? READY_TO_START_TEXT : READY_TO_CHECK_TEXT;
}
/** Cancelled words: "Expired after <N> days with no activity" for a draft the sweep cancelled (spec 14d F12), else "Cancelled <age>". */
function cancelledWords(input: { updatedAt?: Date | string; now?: Date; expired?: { days: number } | null }): string {
  if (input.expired) return expiredText(input.expired.days);
  return input.updatedAt === undefined ? "Cancelled" : cancelledText(ageText(input.updatedAt, input.now ?? new Date()));
}
export interface BatchStateInput {
  status: BatchStatus; counts: BatchCounts; source?: string; samples?: { at: Date; made: number }[]; now?: Date; updatedAt?: Date | string;
  /** Pass the row's value: `null` marks a failed batch as failed before Start (`fixable`); left out, it never is. */ startedAt?: Date | string | null;
  /** Styli outputs skipped as too small; counts.skipped also holds removed and chart skips. */ styliSkipped?: number;
  /** The batch's channels: a ready draft with channels reads "Ready to start". */ channels?: readonly ChannelId[];
  /** The batch's uploads (any status): pending and missing inputs are named in `intake`; left out, those checks are skipped. */ uploads?: readonly { status: string }[];
  /** `options.expired`: a cancelled batch the sweep expired reads "Expired after <N> days with no activity". */ expired?: { days: number } | null;
}
export function deriveBatchState(input: BatchStateInput): BatchState {
  const state = derive(input);
  // A started batch is never in the unfinished list; its words are its list pill.
  return ["processing", "attention", "ready", "recheck_failed"].includes(state.state) ? { ...state, intake: state.listPill } : state;
}
function derive(input: BatchStateInput): BatchState {
  const { status, counts: c } = input;
  const made = Math.min(c.outputs,Number((c as BatchCounts & {staged?:number}).staged ?? 0) + c.verified + c.needsAttention + c.failed + c.skipped + c.unchanged);
  const result: BatchState = { state: "draft", pill: "Draft", text: "Check what we found and start processing.", made, total: c.outputs, progress: c.outputs ? Math.min(1, made / c.outputs) : 0, eta: null, listPill: "Draft", intake: draftWords(c, input.channels, input.uploads) };
  if (status === "cancelled") {
    const words = cancelledWords(input);
    return { ...result, state: "cancelled", pill: "Cancelled", listPill: "Cancelled", text: words, intake: words };
  }
  if (status === "failed") return { ...result, state: "failed", pill: "Could not start", listPill: "Could not start", text: c.failReason ?? "Start the batch again.", intake: couldNotStartText(c.failReason), ...(input.startedAt === null ? { fixable: true } : {}) };
  if (status === "ingesting") {
    const now = input.now ?? new Date();
    const stalled = input.updatedAt !== undefined && now.getTime() - new Date(input.updatedAt).getTime() > COLLECT_STALL_MS;
    const phase = shownPhase(c.phase, input.source), { done, total } = phaseCount(c, phase);
    const counted = total ? `${PHASE_WORDS[phase]} ${num(done)} of ${num(total)}` : PHASE_WORDS[phase];
    const time = intakeTimeText(c, now);
    const text = stalled ? COLLECT_STALLED_TEXT : time ? `${counted}, ${time}` : counted;
    return { ...result, state: "collecting", pill: "Collecting files", text, listPill: counted, intake: text, made: done, total: total ?? 0, progress: total ? Math.min(1, done / total) : 0, ...(stalled ? { stalled } : {}) };
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
export type WizardStep = 1 | 2 | 3 | 4;
/** The step an existing batch opens at: 1 while inputs are pending or missing; 2 while collecting, placing, waiting for a column, or ready without channels; 3 never (it is reached from 2 by Continue); 4 when ready with channels. */
export function wizardStepFor(batch: { status: BatchStatus; channels: ChannelId[]; counts: BatchCounts }, uploads: { status: string }[]): WizardStep {
  // "removed" arrives with release B; a removed upload is not an input.
  const inputs = uploads.filter((u) => u.status !== "removed");
  if (!inputs.length || inputs.some((u) => u.status === "pending")) return 1;
  if (batch.status === "ingesting") return 2;
  // A draft that was never handed to collecting (or whose hand-off failed) waits on step 1's Continue.
  if (!batch.counts.previewReady) return 1;
  return batch.channels.length ? 4 : 2;
}
