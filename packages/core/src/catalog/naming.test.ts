import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "./types";
import {
  assertTestPrefix,
  assertWithinProduct,
  brandSlug,
  normalizeKey,
  productPrefix,
  publicObjectPath,
  publicUrl,
  sanitizeSegment,
  shotStem,
} from "./naming";

describe("naming helpers", () => {
  it("normalises keys and segments", () => {
    expect(normalizeKey("ABC-123")).toBe("ABC123");
    expect(normalizeKey("abc_123")).toBe("ABC123");
    expect(sanitizeSegment("ABC 123")).toBe("ABC_123");
    expect(brandSlug("USPA")).toBe("uspa");
  });

  it("builds public paths with lowercase .jpg and no version or batch id", () => {
    expect(productPrefix("uspa", "ABC123", false)).toBe("catalog/uspa/ABC123/");
    expect(shotStem("ABC123", 2)).toBe("ABC123_2");
    for (const ch of CHANNEL_IDS) {
      const p = publicObjectPath("uspa", "ABC123", ch, 2, false);
      expect(p).toBe(`catalog/uspa/ABC123/${ch}/ABC123_2.jpg`);
      expect(p).not.toMatch(/_v\d/);
    }
    expect(publicObjectPath("uspa", "ABC123", "noon", 1, true)).toMatch(/^catalog-test\//);
  });

  it("publicUrl has no spaces and round-trips through URL", () => {
    const u = publicUrl("image-links-agent-public", "catalog/uspa/A B/noon/A B_1.jpg");
    expect(u).not.toContain(" ");
    expect(new URL(u).href).toBe(u);
  });

  it("assertWithinProduct guards the product prefix", () => {
    expect(() => assertWithinProduct("catalog/uspa/ABC123/noon/ABC123_1.jpg", "catalog/uspa/ABC123/")).not.toThrow();
    expect(() => assertWithinProduct("catalog/uspa/ABC124/noon/ABC124_1.jpg", "catalog/uspa/ABC123/")).toThrow();
    expect(() => assertWithinProduct("eval/uspa/ABC123/noon/ABC123_1.jpg", "eval/uspa/ABC123/")).toThrow();
    expect(() => assertWithinProduct("catalog/uspa/ABC123/noon/ABC123_1.jpg", "catalog/uspa/ABC12")).toThrow();
    expect(() => assertWithinProduct("catalog/uspa/ABC123/../ABC124/noon/x.jpg", "catalog/uspa/ABC123/")).toThrow();
  });

  it("assertTestPrefix allows only catalog-test/", () => {
    expect(() => assertTestPrefix("catalog-test/run-1/")).not.toThrow();
    expect(() => assertTestPrefix("catalog/uspa/")).toThrow();
  });
});
