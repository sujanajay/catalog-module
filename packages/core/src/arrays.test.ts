import { describe, expect, it } from "vitest";
import { maxOf, minOf, pushAll } from "./arrays";

// Larger than the about 125k arguments one call can take on Node 22 (M1-S5 review P1).
const BIG = 210_000;

describe("array helpers for lists that grow with a batch", () => {
  it("spreading a list this size into a call overflows the stack (the failure the helpers avoid)", () => {
    const list = Array.from({ length: BIG }, (_, i) => i);
    expect(() => Math.min(...list)).toThrow(RangeError);
    expect(() => [].push(...(list as never[]))).toThrow(RangeError);
  });

  it("finds the smallest and largest of 210k numbers, and null for none", () => {
    const list = Array.from({ length: BIG }, (_, i) => BIG - i);
    expect(minOf(list)).toBe(1);
    expect(maxOf(list)).toBe(BIG);
    expect(minOf([])).toBeNull();
    expect(maxOf([])).toBeNull();
    expect(minOf([-3, 0, 2])).toBe(-3);
  });

  it("appends 210k entries", () => {
    const out = ["a"];
    expect(pushAll(out, Array.from({ length: BIG }, () => "b"))).toBe(out);
    expect(out).toHaveLength(BIG + 1);
  });
});
