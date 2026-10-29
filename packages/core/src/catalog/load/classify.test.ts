import { describe, expect, it } from "vitest";
import { deliveredLinks } from "../pipeline/report";
import { classifyOutputs, completionLine, type OutputLike } from "./classify";
import { ENLARGEMENT_FAILED_SENTENCE } from "../types";

const out = (id: string, productId: string, status: string, extra: Partial<OutputLike> = {}): OutputLike =>
  ({ id, productId, status, reason: null, channel: "noon", n: 1, decision: null, isLive: false, ...extra });

describe("classifyOutputs with holds (spec 17 3.1.1)", () => {
  it("a staged output with no decision on a held product is a held sibling, not silent", () => {
    const c = classifyOutputs([
      out("a1", "held", "needs_attention", { reason: "Check the edge." }),
      out("a2", "held", "staged"),
      out("a3", "held", "staged"),
      out("b1", "ok", "verified", { isLive: true }),
    ], new Set(["held"]));
    expect(c.heldSiblings.map(s => s.id)).toEqual(["a2", "a3"]);
    expect(c.silent).toEqual([]);
    expect(c.ended).toBe(2);
    expect(completionLine(c)).toBe("Held with the product (waiting for the operator): 2. Silent outputs (must be none): 0.");
  });

  it("spec 18: an output held with enlargement_failed is a hold that ended, never silent; its staged siblings wait with it", () => {
    const c = classifyOutputs([
      out("e1", "big", "needs_attention", { channel: "trendyol", reason: ENLARGEMENT_FAILED_SENTENCE }),
      out("e2", "big", "staged"),
    ], new Set(["big"]));
    expect(c.silent).toEqual([]);
    expect(c.ended).toBe(1);
    expect(c.heldSiblings.map(s => s.id)).toEqual(["e2"]);
  });

  it("a staged output on a product that is not held is silent", () => {
    const c = classifyOutputs([out("a1", "p", "staged"), out("a2", "held", "staged")], new Set(["held"]));
    expect(c.silent.map(s => s.id)).toEqual(["a1"]);
    expect(c.heldSiblings.map(s => s.id)).toEqual(["a2"]);
    expect(completionLine(c)).toBe("Held with the product (waiting for the operator): 1. Silent outputs (must be none): 1.");
  });

  it("failed without a reason is silent, also on a held product; pending is silent; a decided staged output has ended", () => {
    const c = classifyOutputs([
      out("f1", "held", "failed"),
      out("f2", "held", "failed", { reason: "  " }),
      out("f3", "p", "failed", { reason: "Uploaded file could not be read back from the public link" }),
      out("p1", "held", "pending"),
      out("d1", "held", "staged", { decision: "use_as_is" }),
    ], new Set(["held"]));
    expect(c.silent.map(s => s.id)).toEqual(["f1", "f2", "p1"]);
    expect(c.ended).toBe(2);
    expect(c.failed.map(f => f.id)).toEqual(["f3"]);
    expect(c.errorsByReason).toEqual({ "Uploaded file could not be read back from the public link": 1 });
    expect(c.heldSiblings).toEqual([]);
  });

  it("uses the same waiting definition as deliveredLinks", () => {
    const outputs = [out("a1", "held", "staged"), out("a2", "held", "staged"), out("b1", "ok", "staged")];
    const held = new Set(["held"]);
    const links = deliveredLinks({ batchId: "b", channels: ["noon"], heldProductIds: held, outputs: outputs.map(o => ({ ...o, status: o.status as "staged", batchId: "b", channel: "noon" as const, publicUrl: "" })) });
    expect(classifyOutputs(outputs, held).heldSiblings).toHaveLength(links.held);
  });
});
