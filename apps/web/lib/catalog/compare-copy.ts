import type { ChannelId } from "@catalog/core/catalog/types";

/**
 * The batch page tabs a link can open with ?tab= (the attention tab still shows only while it applies).
 * Kept here, not in the client BatchTabs module, so the server page reads the real list.
 */
export const LINKABLE_TABS = ["overview", "attention", "compare", "sheet", "details"] as const;

/** Photo lines per page on the Compare tab. */
export const COMPARE_PAGE_SIZE = 25;

/** A cell's state, in filter order. "waiting" is a batch still running; it has no filter of its own. */
export const COMPARE_GRADES = ["passed", "repaired", "attention", "failed", "unchanged"] as const;
export type CompareGrade = typeof COMPARE_GRADES[number] | "waiting";
export const GRADE_LABELS: Record<CompareGrade, string> = {
  passed: "Passed", repaired: "Repaired", attention: "Needs attention", failed: "Could not be made", unchanged: "Unchanged", waiting: "Not made yet",
};

export interface CompareCell {
  channel: ChannelId;
  outputId: string | null;
  url: string | null;
  grade: CompareGrade;
  /** The output was made in an earlier batch: this batch had the same photo and made nothing new. */
  unchanged: boolean;
  /** Set on a skipped output (a size chart, for example): left out on purpose. */
  skipped: boolean;
  why: string;
}
