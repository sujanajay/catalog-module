// Pure copy helpers shared by server pages and client components (no server imports here).
import { RUPEES_NOT_CONFIGURED } from "@catalog/core/catalog/cost";
import { intakeTimeText, PHASE_WORDS, phaseCount, shownPhase, styliSkipText } from "@catalog/core/catalog/pipeline/status";
import type { BatchCounts, BatchStatus } from "@catalog/core/catalog/types";

/** The operator's sentence when the ingest hand-off to the worker queue failed for a transient reason. */
export const HAND_OFF_RETRY = "The upload could not be handed to processing. Please try again.";
/** The same failure when trying again will not help (for example a missing queue permission). */
export const HAND_OFF_FAILED = "The upload could not be handed to processing. Email sujan@opptra.com if this keeps happening.";

// Platform errors (spec 14c F11 part 1; parent copy register "Platform error"): an API call answered
// with a page that is not JSON, such as the load balancer's HTML timeout page.
export const PLATFORM_TIMEOUT = "The server did not answer in time. Your files are safe. Reload this page to continue.";
export const PLATFORM_ERROR = "This did not finish. Reload this page and try again.";
/** Spec 18 lifecycle 3.6: the warning before "Use as is" on a photo that could not be enlarged (never names a model). */
export function plainWarningText(channelLabels: readonly string[]): string {
  return `This photo could not be enlarged. If you use it as it is, the ${listAnd(channelLabels)} images will be stretched and may look soft. Use it anyway?`;
}
export const PLAIN_WARNING_ACCEPT = "Use anyway";
export const PLAIN_WARNING_CANCEL = "Cancel";
export const TRY_AGAIN_LABEL = "Try again";
export const TRY_AGAIN_TOAST = "Enlarging this photo again. It comes back here if it fails again.";
export const TRY_AGAIN_STATUS = "Enlarging again";
/** The sentence for a non-JSON answer: the timeout one for 502, 503 and 504, the general one otherwise. */
export const platformErrorText = (status: number) => (status === 502 || status === 503 || status === 504 ? PLATFORM_TIMEOUT : PLATFORM_ERROR);

/** "Noon", "Noon and Styli", "Noon, Namshi, Trendyol and Styli" (spec 01 section 8). */
export function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Picks the singular or plural phrase for a count: plural(1, "product needs", "products need"). */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Two decimals with thousands separators, for INR and USD figures. */
export function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Whole numbers with thousands separators ("1,240"). */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export interface CostEstimate { usd: number; inr: number; images: number; qaChecks: number }

/** The wizard step 4 line (spec 07 4.11, spec 01 step 4). */
export function estimateText(estimate: CostEstimate | null | undefined): string {
  if (!estimate) return `Estimated cost: not available. ${RUPEES_NOT_CONFIGURED}.`;
  return `Estimated cost: about INR ${money(estimate.inr)} (${count(estimate.images)} images, ${count(estimate.qaChecks)} quality checks)`;
}

/**
 * The Ready banner for a batch where an operator kept flagged photos with "Use as is" (spec 07 4.7:
 * those photos are live "kept as is"); the plain "passed every check" sentence would be untrue then.
 */
export function readyText(images: number, keptPhotos: number, styliSkipped = 0): string {
  const live = `All ${count(images)} ${plural(images, "image is", "images are")} live`;
  const tail = styliSkipped > 0 ? styliSkipText(styliSkipped) : "Nothing needs your attention.";
  if (keptPhotos <= 0) return `${live} and passed every check. ${tail}`;
  return `${live}. ${count(keptPhotos)} ${plural(keptPhotos, "photo was", "photos were")} kept as is after a decision; everything else passed every check. ${tail}`;
}

/** The error page under /catalog (F1). The batch sentence and link show only when a batch id is known. */
export const ERROR_HEADING = "Something went wrong on our side.";
export const ERROR_BATCH_SAFE = "Your batch is safe; nothing was lost.";
export const ERROR_OPEN_BATCH = "Open this batch";
export const ERROR_ALL_BATCHES = "All batches";
export const ERROR_TRY_AGAIN = "Try this page again";
/** The batch page's way back into the wizard for a batch that has not started (F4 part 1). */
export const CONTINUE_SETTING_UP = "Continue setting up";
export const continueSettingUpHref = (batchId: string) => `/catalog/new?batch=${encodeURIComponent(batchId)}`;
/** The draft banner once the grouping is ready to check. */
export const DRAFT_READY_TEXT = "Ready to check. Press Continue setting up to see the grouping and choose marketplaces.";
/** The "How this works" paragraph of a batch that is still being set up. */
export const HOW_THIS_WORKS_DRAFT = "This batch has not started. Continue setting it up to check the grouping, choose marketplaces and start. Nothing is processed and nothing is charged until you press Start.";
/** The Compare and Links sheet tabs of a batch that has not started. */
export function notStartedText(photos: number, products: number): string {
  return `This batch has not started. ${count(photos)} ${plural(photos, "photo", "photos")} found for ${count(products)} ${plural(products, "product", "products")}; nothing has been made yet.`;
}
/** The batch header's time for a batch that has not started ("started" would be false). */
export const createdText = (time: string, email: string) => `created ${time} by ${email}`;
/** The brand page when no product is shown: the query is named only when there is one. */
export function brandEmptyText(brand: string, query: string): string {
  const q = query.trim();
  return q ? `No products of ${brand} match ${q}.` : `No products of ${brand} yet.`;
}
/** A failed row in the batch list shows this much of the reason; the full reason is on hover. */
export const LIST_REASON_CHARS = 120;
export function shortReason(reason: string): string {
  return reason.length <= LIST_REASON_CHARS ? reason : `${reason.slice(0, LIST_REASON_CHARS).trimEnd()}...`;
}
/** A batch that never reached Start: draft, collecting, or failed before it started. */
export function hasNotStarted(batch: { status: BatchStatus; startedAt: Date | string | null }): boolean {
  return batch.startedAt === null && ["draft", "ingesting", "failed"].includes(batch.status);
}
/**
 * A batch the operator can still set up in the wizard: a draft or collecting batch that has not started.
 * A failed batch is reopened first (Fix and continue, spec 14c F8); a cancelled one never opens the wizard.
 */
export function canContinueSettingUp(batch: { status: BatchStatus; startedAt: Date | string | null }): boolean {
  return hasNotStarted(batch) && batch.status !== "failed";
}
/** A batch that can be cancelled (spec 14c F4 part 2): a draft, a collecting batch, or one that failed before Start. */
export const canCancel = hasNotStarted;

// "Your unfinished batches" and Cancel (spec 14c F4 part 2; parent copy register "List section",
// "Batch page" and "Cancel confirmation").
export const UNFINISHED_HEADING = "Your unfinished batches";
export const CONTINUE = "Continue";
export const CANCEL = "Cancel";
export const FIX_AND_CONTINUE = "Fix and continue";
export const SHOW_CANCELLED = "Show cancelled";
export const CANCEL_THIS_BATCH = "Cancel this batch";
export const cancelConfirmText = (name: string) => `Cancel ${name}? Nothing was processed and nothing was charged.`;
export const YES_CANCEL = "Yes, cancel";
export const KEEP_IT = "Keep it";
/** The age of an unfinished row: "created 5 minutes ago". */
export const createdAgoText = (age: string) => `created ${age}`;
/** The banner and Overview line of a cancelled batch (the failed batch's existing sentence, true of a cancelled one too). */
export const NOTHING_PROCESSED = "Nothing was processed and nothing was charged.";

export type BatchSource = "Drive folder" | "Google Sheet" | "links" | "zip" | "upload";

/**
 * Where a batch's files came from, for the collecting banner ("files copied from your <source>", spec 06)
 * and the Overview line. Remote sources win, because those are the ones the batch must not depend on.
 */
export function batchSource(kinds: readonly string[]): BatchSource {
  if (kinds.includes("drive_folder")) return "Drive folder";
  if (kinds.includes("google_sheet")) return "Google Sheet";
  if (kinds.includes("url_list") || kinds.includes("sheet")) return "links";
  if (kinds.includes("zip")) return "zip";
  return "upload";
}

/** Wizard step 2: a sheet uploaded but not read yet. */
export const SHEET_READING_TEXT = "Reading your sheet. The columns will appear here when it has been read.";
/** The leaving line from release C (steps 2 to 4 while collecting, batch page overview): nothing starts by itself. */
export const LEAVING_LINE = "You can close this page. Find this batch under Your unfinished batches and press Continue when it is ready.";
/** The fixed sentences of steps 2 and 3 while collecting, shown until the poll has a live count. */
export const STEP2_COLLECTING_TEXT = "Collecting files. The grouping will appear here when the files are ready.";
export const STEP3_COLLECTING_TEXT = "Collecting files. Continue when the grouping is ready.";
/**
 * Wizard steps 2 and 3 while collecting: the polled batch state's live count and time ("Downloading photos
 * 612 of 1,400, about 7 min left", spec 14c F6), or the step's fixed sentence before a count exists (no files listed yet, so never "0 of 0")
 * or once stalled (the stall alert says that), then the leaving line. Never a product count.
 */
export function wizardCollectingText(state: { state: string; text: string; stalled?: boolean } | null | undefined, collectTotal: number | null | undefined, fallback: string): string {
  const live = state && state.state === "collecting" && !state.stalled && (collectTotal ?? 0) > 0 ? `${state.text.replace(/\.$/, "")}.` : fallback;
  return `${live} ${LEAVING_LINE}`;
}

/**
 * Where a collecting or placing batch is (spec 14c F6): the phase words, "<done> of <total>" once the
 * total is known (never "0 of 0"), and the measured time ("" until a rate is measured). Rows written
 * before the worker wrote `phase` take the source's phase.
 */
export function intakeProgress(counts: BatchCounts, now: Date, source?: string): { counted: string; done: number; total: number | null; time: string } {
  const phase = shownPhase(counts.phase, source);
  const { done, total } = phaseCount(counts, phase);
  return { counted: total ? `${PHASE_WORDS[phase]} ${count(done)} of ${count(total)}` : PHASE_WORDS[phase], done, total: total || null, time: intakeTimeText(counts, now) };
}
/**
 * The batch page banner while collecting: "<phase words> <done> of <total> from your <source>, about <m>
 * min left". Phase words that already name the source ("Unpacking your zip", "Reading your sheet",
 * "Checking your uploaded files") are not followed by it again.
 */
export function collectingBannerText(counts: BatchCounts, source: BatchSource, now: Date): string {
  const { counted, time } = intakeProgress(counts, now, source);
  const phase = shownPhase(counts.phase, source);
  const from = phase === "downloading" || phase === "placing" ? ` from your ${source}` : "";
  return `${counted}${from}${time ? `, ${time}` : ""}`;
}
/** The Overview line while files are collected, worded for the batch's source. */
export function collectingText(source: BatchSource): string {
  const first = source === "zip" ? "Unpacking your zip." : source === "upload" ? "Checking your uploaded files." : "Copying your files.";
  return `${first} ${LEAVING_LINE}`;
}

// Link failures (spec 14b F5 part 1; parent copy register "Link failures card" and "Batch page").
export const LINK_FAILURES_HEADING = "Links that could not be downloaded";
/** The link failures card when the system retried some links itself (spec 14d F5 part 2); `attempts` is the highest attempt count. */
export const retriedText = (attempts: number) => `Transient problems were tried ${count(attempts)} times.`;
export const RETRY_LINKS = "Try the failed links again";
/** "<total> of <links> links could not be downloaded (<products> products affected)." */
export function linkFailuresSummary(total: number, links: number, products: number): string {
  return `${count(total)} of ${count(links)} ${plural(links, "link", "links")} could not be downloaded (${count(products)} ${plural(products, "product", "products")} affected).`;
}
export const showAllText = (total: number) => `Show all ${count(total)}`;
/** Whether "Try the failed links again" is offered: some links failed and at least one may work on a second try. */
export const canRetryLinks = (failures: { total: number; temporary: number } | null | undefined) => !!failures && failures.total > 0 && failures.temporary > 0;
/** The toast after the failed links were handed back to collection. */
export const RETRY_LINKS_STARTED = "Trying the failed links again.";
