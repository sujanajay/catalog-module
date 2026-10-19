// Pure copy helpers shared by server pages and client components (no server imports here).
import { RUPEES_NOT_CONFIGURED } from "@catalog/core/catalog/cost";

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
export function readyText(images: number, keptPhotos: number): string {
  const live = `All ${count(images)} ${plural(images, "image is", "images are")} live`;
  if (keptPhotos <= 0) return `${live} and passed every check. Nothing needs your attention.`;
  return `${live}. ${count(keptPhotos)} ${plural(keptPhotos, "photo was", "photos were")} kept as is after a decision; everything else passed every check. Nothing needs your attention.`;
}

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

/** The Overview line while files are collected, worded for the batch's source. */
export function collectingText(source: BatchSource): string {
  if (source === "zip") return "We unpack your zip first. Processing starts automatically.";
  if (source === "upload") return "We check your uploaded files first. Processing starts automatically.";
  const from = source === "links" ? "your links" : `the ${source}`;
  return `We copy your files first so the batch does not depend on ${from} later. Processing starts automatically.`;
}
