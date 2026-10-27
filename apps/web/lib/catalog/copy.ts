// Pure copy helpers shared by server pages and client components (no server imports here).
import { RUPEES_NOT_CONFIGURED } from "@catalog/core/catalog/cost";
import { styliSkipText } from "@catalog/core/catalog/pipeline/status";

/** The operator's sentence when the ingest hand-off to the worker queue failed for a transient reason. */
export const HAND_OFF_RETRY = "The upload could not be handed to processing. Please try again.";
/** The same failure when trying again will not help (for example a missing queue permission). */
export const HAND_OFF_FAILED = "The upload could not be handed to processing. Email sujan@opptra.com if this keeps happening.";

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

// ---- Spec 14a (F1 error page, F9 draft and failed screens, F4 part 1 way back); parent 14 section 6 rows "A". ----
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
export function hasNotStarted(batch: { status: string; startedAt: Date | string | null }): boolean {
  return batch.startedAt === null && ["draft", "ingesting", "failed"].includes(batch.status);
}
/** A batch the operator can still set up in the wizard: draft or collecting, never started. */
export function canContinueSettingUp(batch: { status: string; startedAt: Date | string | null }): boolean {
  return batch.startedAt === null && ["draft", "ingesting"].includes(batch.status);
}
// ---- End of spec 14a copy. ----

export type BatchSource ="Drive folder" | "Google Sheet" | "links" | "zip" | "upload";

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

/** The Overview line while files are collected, worded for the batch's source. */
export function collectingText(source: BatchSource): string {
  const first = source === "zip" ? "Unpacking your zip." : source === "upload" ? "Checking your uploaded files." : "Copying your files.";
  return `${first} Processing starts by itself. You can close this page.`;
}
