// Result classification for the load report (spec 09 section 4.1, spec 17 3.1.1): every output must end
// `verified`, `needs_attention`, `skipped` or `failed` with a reason, or wait with its held product (a held
// sibling: `staged`, no decision, on a product whose change is `pending_attention`). A staged output the operator
// decided on (use as is, remove, replaced) is the operator's end. Anything else is silent. The production
// invariant silent_outputs (invariants/checks.ts) applies the same rule in SQL; a parity test keeps them equal.
import { isHeldSibling } from "../pipeline/report";

export interface OutputLike { id: string; status: string; reason: string | null; channel: string; n: number; productId: string; decision: string | null; isLive: boolean }

export interface Classified {
  byStatus: Record<string, number>;
  /** Outputs that ended: verified, needs_attention, skipped, failed with a reason, or staged with an operator decision. */
  ended: number;
  /** Good outputs of held products, waiting with the product for the operator. Expected, counted apart. */
  heldSiblings: { id: string; productId: string }[];
  /** Outputs neither ended nor explained by a hold, or `failed` without a reason. Must be empty. */
  silent: { id: string; status: string }[];
  failed: { id: string; productId: string; channel: string; n: number; reason: string }[];
  errorsByReason: Record<string, number>;
}

const ENDED = new Set(["verified", "needs_attention", "skipped", "failed"]);

/** `holds`: the ids of the batch's held products (catalog_batch_products.change = 'pending_attention'). */
export function classifyOutputs(outputs: readonly OutputLike[], holds: ReadonlySet<string>): Classified {
  const result: Classified = { byStatus: {}, ended: 0, heldSiblings: [], silent: [], failed: [], errorsByReason: {} };
  for (const o of outputs) {
    result.byStatus[o.status] = (result.byStatus[o.status] ?? 0) + 1;
    const reason = o.reason?.trim() ?? "";
    if (o.status === "staged" && !o.decision && isHeldSibling(o, holds)) { result.heldSiblings.push({ id: o.id, productId: o.productId }); continue; }
    const decided = o.status === "staged" && !!o.decision;
    if ((!ENDED.has(o.status) && !decided) || (o.status === "failed" && !reason)) { result.silent.push({ id: o.id, status: o.status }); continue; }
    result.ended += 1;
    if (o.status === "failed") {
      result.failed.push({ id: o.id, productId: o.productId, channel: o.channel, n: o.n, reason });
      result.errorsByReason[reason] = (result.errorsByReason[reason] ?? 0) + 1;
    }
  }
  return result;
}

/** The load report's completion line. Only the silent count fails a pass. */
export function completionLine(c: Pick<Classified, "heldSiblings" | "silent">): string {
  return `Held with the product (waiting for the operator): ${c.heldSiblings.length}. Silent outputs (must be none): ${c.silent.length}.`;
}
