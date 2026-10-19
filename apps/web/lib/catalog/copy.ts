// Pure copy helpers shared by server pages and client components (no server imports here).

/** "Noon", "Noon and Styli", "Noon, Namshi, Trendyol and Styli" (spec 01 section 8). */
export function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
  if (!estimate) return "Estimated cost: not available";
  return `Estimated cost: about INR ${money(estimate.inr)} (${count(estimate.images)} images, ${count(estimate.qaChecks)} quality checks)`;
}
