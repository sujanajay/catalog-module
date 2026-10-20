// Tier 1: which products the overwrite passes re-upload after a first pass that held a product
// (the held product keeps its batch lock, so a second delivery of it would fail the lock), the
// skipped case, the rows a crashed pass leaves behind, and the lock failure message.
import { describe, expect, it } from "vitest";
import { assertLocked, lockedProductsMessage, OVERWRITE_CHECK_IDS, overwriteFailed, overwriteNotRun, planOverwrite, type OverwriteSource } from "./overwrite";

const shots = (productId: string, count: number, offset = 0): OverwriteSource[] => Array.from({ length: count }, (_, i) => ({ id: `${productId}-${i + 1}`, productId, n: i + 1 + offset }));

describe("planOverwrite", () => {
  it("leaves the product the first pass held out of every pass and picks the shots from the released products", () => {
    const products = [{ id: "held", change: "pending_attention" }, { id: "a", change: "new" }, { id: "b", change: "new" }];
    const sources = [...shots("held", 5), ...shots("a", 3), ...shots("b", 3)];
    const planned = planOverwrite(products, sources);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.held).toEqual(["held"]);
    expect(planned.plan.productIds).toEqual(["a", "b"]);
    expect(planned.plan.sources.map(s => s.productId)).not.toContain("held");
    expect(planned.plan.sources).toHaveLength(6);
    expect(planned.plan.altered).toEqual({ id: "a-1", productId: "a", n: 1 });
    expect(planned.plan.removed).toEqual({ id: "b-3", productId: "b", n: 3 });
  });
  it("takes the removed shot from the altered product when it is the only three-shot candidate, and falls back to two shots", () => {
    const one = planOverwrite([{ id: "a", change: "new" }, { id: "b", change: "unchanged" }], [...shots("a", 3), ...shots("b", 1)]);
    expect(one.ok && one.plan.altered.id).toBe("a-1");
    expect(one.ok && one.plan.removed.id).toBe("a-3");
    const two = planOverwrite([{ id: "held", change: "pending_attention" }, { id: "c", change: "new" }], [...shots("held", 5), ...shots("c", 2)]);
    expect(two.ok && two.plan.altered.id).toBe("c-1");
    expect(two.ok && two.plan.removed.id).toBe("c-2");
  });
  it("skips with a reason when every product is held or no released product can lose a shot", () => {
    const allHeld = planOverwrite([{ id: "x", change: "pending_attention" }], shots("x", 4));
    expect(allHeld).toEqual({ ok: false, reason: "every product of the first pass is held for attention (1)", held: ["x"] });
    const singles = planOverwrite([{ id: "x", change: "pending_attention" }, { id: "y", change: "new" }], [...shots("x", 4), ...shots("y", 1)]);
    expect(singles).toEqual({ ok: false, reason: "no released product has two or more shots (1 held for attention)", held: ["x"] });
    const rows = overwriteNotRun(allHeld.ok ? "" : allHeld.reason);
    expect(rows.map(r => r.id)).toEqual([...OVERWRITE_CHECK_IDS]);
    expect(rows.every(r => r.status === "not_run" && r.ok && r.group === "overwrite")).toBe(true);
    expect(rows[0]!.detail).toBe("The overwrite passes were skipped: every product of the first pass is held for attention (1).");
  });
});

describe("a failed overwrite pass", () => {
  it("records one failed row per overwrite check carrying the error, so the first-pass checks stay", () => {
    const rows = overwriteFailed("A golden product is locked by another batch: X.");
    expect(rows.map(r => r.id)).toEqual([...OVERWRITE_CHECK_IDS]);
    expect(rows.every(r => r.status === "fail" && !r.ok && r.detail === "The overwrite passes failed: A golden product is locked by another batch: X.")).toBe(true);
  });
});

describe("the lock failure message", () => {
  it("names every busy product and the batch that holds it", () => {
    const busy = [{ productId: "p1", identifier: "evals-1-SHOE-1", batchId: "d79b538d", batchName: "catalog-test output-evals evals-1 footwear first" }, { productId: "p2", identifier: "evals-1-SHOE-2", batchId: "d79b538d", batchName: "catalog-test output-evals evals-1 footwear first" }];
    expect(lockedProductsMessage(busy)).toBe("A golden product is locked by another batch: evals-1-SHOE-1 held by batch d79b538d (catalog-test output-evals evals-1 footwear first); evals-1-SHOE-2 held by batch d79b538d (catalog-test output-evals evals-1 footwear first).");
    expect(() => assertLocked({ ok: false, busy })).toThrow(/^A golden product is locked by another batch: evals-1-SHOE-1 held by batch d79b538d/);
    expect(() => assertLocked({ ok: true })).not.toThrow();
  });
});
