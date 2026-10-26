import { when } from "@/components/ui";
import type { ChangeKind } from "@catalog/core/catalog/types";
import type { ProductCompare } from "../../lib/catalog/compare";

export const CHANGE_LABELS: Record<ChangeKind, string> = { new: "First delivered", updated: "Pictures replaced", unchanged: "Pictures unchanged", shots_removed: "Photos removed", reordered: "Photos reordered", pending_attention: "Needs attention", failed: "Could not be made" };
/** The link that opens a batch's Compare tab on this product. */
export const compareLink = (batchId: string, identifier: string) => `/catalog/${batchId}?${new URLSearchParams({ tab: "compare", q: identifier })}`;

/** "Batches that touched this product", newest first, each opening that batch's comparison for this product. */
export default function ProductBatches({ batches, identifier }: { batches: ProductCompare["batches"]; identifier: string }) {
  return <section><h2>Batches that touched this product</h2>{!batches.length ? <p>None yet.</p> : <ul className="history">{batches.map(b => <li key={b.id}>{when(b.finishedAt ?? b.createdAt)} · <a href={compareLink(b.id, identifier)}>{b.name}</a> · {CHANGE_LABELS[b.change]}</li>)}</ul>}</section>;
}
