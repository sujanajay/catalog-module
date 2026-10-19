import { describe, expect, it } from "vitest";
import { estimateJudgeCost, parsePriceListing, usdPerCheck } from "./judges";

describe("judge budget", () => {
  const listing = parsePriceListing({ data: [
    { id: "cheap/judge", pricing: { prompt: "0.0000001", completion: "0.0000004", image: "0", request: "0" } },
    { id: "dear/judge", pricing: { prompt: "0.0000003", completion: "0.0000025", image: "0.001", request: "0" } },
  ] });
  it("uses each model's own listing price, never one constant", () => {
    const cheap = usdPerCheck("cheap/judge", listing), dear = usdPerCheck("dear/judge", listing);
    expect(cheap).toBeCloseTo((6000 * 1e-7 + 500 * 4e-7) * 2, 10);
    expect(dear).toBeGreaterThan(cheap);
    const estimate = estimateJudgeCost({ "cheap/judge": 10, "dear/judge": 10 }, listing);
    expect(estimate.perModel["cheap/judge"]).toBeCloseTo(10 * cheap, 10);
    expect(estimate.totalUsd).toBeCloseTo(10 * cheap + 10 * dear, 10);
  });
  it("refuses a model the listing has no price for", () => {
    expect(() => usdPerCheck("missing/judge", listing)).toThrow(/no entry/);
  });
});
