import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "./types";
import {
  assertTestPrefix,
  assertWithinProduct,
  batchPrefix,
  brandSlug,
  derivedPath,
  enlargedPath,
  normalizeKey,
  parseShotName,
  productPrefix,
  publicObjectPath,
  publicUrl,
  sanitizeSegment,
  renumberShots,
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

  it("spec 18: the stored enlargement sits next to the matte under the batch prefix, never under raw or the public layout", () => {
    const prefix = batchPrefix("uspa", "b1", true);
    expect(enlargedPath(prefix, "ABC123", 2, "swinir-x2+cpu")).toBe(`${prefix}/derived/ABC123/ABC123_2.swinir-x2-cpu.x2.jpg`);
    expect(derivedPath(prefix, "ABC123", 2, "matte")).toBe(`${prefix}/derived/ABC123/ABC123_2.matte.png`);
    expect(enlargedPath(prefix, "ABC123", 2, "swinir-x2+cpu")).not.toMatch(/\/raw\/|^catalog\//);
    // The key names the upscaler, so another model's image is another object.
    expect(enlargedPath(prefix, "ABC123", 2, "realesrgan-x2plus")).toBe(`${prefix}/derived/ABC123/ABC123_2.realesrgan-x2plus.x2.jpg`);
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

describe("parseShotName", () => {
  const cases: [string, string, number | null, "" | "_rect" | "_square"][] = [
    ["ABC123_1.jpg", "ABC123", 1, ""],
    ["ABC123-2.JPG", "ABC123", 2, ""],
    ["ABC123_03.png", "ABC123", 3, ""],
    ["ABC 123_1.jpg", "ABC 123", 1, ""],
    ["7055653305_1.jpg", "7055653305", 1, ""],
    ["ABC123_rect_1.jpg", "ABC123", 1, "_rect"],
    ["ABC123_1_square.jpg", "ABC123", 1, "_square"],
    ["ABC123_100.jpg", "ABC123", 100, ""],
    ["IMG_2041.heic", "IMG_2041", null, ""],
    ["ONLY-SHOES_Autumnwinter_5079628_15380145.jpg", "ONLY-SHOES_Autumnwinter_5079628_15380145", null, ""],
    ["ABC123.jpg", "ABC123", null, ""],
    ["ABC123_2_v3.jpg", "ABC123_2", 3, ""],
    ["ABC123_square.jpg", "ABC123", null, "_square"],
    ["photos/sub/ABC123_4.jpeg", "ABC123", 4, ""],
    ["photos\\sub\\ABC123-04.png", "ABC123", 4, ""],
  ];
  it.each(cases)("%s", (name, identifier, n, suffix) => {
    const r = parseShotName(name);
    expect(r).toMatchObject({ identifier, n, suffix });
  });

  it("returns the stem without the extension", () => {
    expect(parseShotName("ABC 123_1.jpg").stem).toBe("ABC 123_1");
    expect(parseShotName("ABC123").stem).toBe("ABC123");
  });

  it("a purely numeric stem has no identifier of its own", () => {
    expect(parseShotName("02.jpg")).toMatchObject({ identifier: "", n: 2 });
    expect(parseShotName("8905701361431.jpg")).toMatchObject({ identifier: "8905701361431", n: null });
  });
});

describe("renumberShots", () => {
  it("renumbers _1, _2, _4 to positions 1, 2, 3 with numbering_gap naming shot 3", () => {
    const files = ["ABC123_4.jpg", "ABC123_1.jpg", "ABC123_2.jpg"];
    const r = renumberShots(files, (f) => parseShotName(f).n ?? 1);
    expect(r.shots.map((s) => [s.item, s.n, s.original])).toEqual([
      ["ABC123_1.jpg", 1, 1],
      ["ABC123_2.jpg", 2, 2],
      ["ABC123_4.jpg", 3, 4],
    ]);
    expect(r.missing).toEqual([3]);
    expect(r.flag).toBe("numbering_gap");
    expect(r.note).toBe("Shot numbers 3 are missing in the upload; images shifted left in this row.");
  });

  it("no gap gives no flag, and arrival order never matters", () => {
    const a = renumberShots([3, 1, 2], (x) => x);
    const b = renumberShots([1, 2, 3], (x) => x);
    expect(a.shots).toEqual(b.shots);
    expect(a.flag).toBeNull();
    expect(a.note).toBeNull();
  });

  it("lists every missing number", () => {
    expect(renumberShots([2, 5], (x) => x).missing).toEqual([1, 3, 4]);
  });
});

describe("path helpers", () => {
  it("shotStem takes two arguments and no path carries a version", () => {
    expect(shotStem.length).toBe(2);
    expect(publicObjectPath("uspa", "ABC123", "noon", 2, false)).not.toContain("b1");
  });

  it("publicObjectPath always ends in lowercase .jpg", () => {
    for (const ch of CHANNEL_IDS) {
      for (const key of ["ABC123", "abc123", "ABC 123", "X.JPG"]) {
        expect(publicObjectPath("uspa", key, ch, 1, false).endsWith(".jpg")).toBe(true);
      }
    }
  });

  it("productPrefix ends with /", () => {
    expect(productPrefix("uspa", "ABC123", true)).toBe("catalog-test/uspa/ABC123/");
  });

  it("matches the spec path examples", () => {
    expect(publicUrl("image-links-agent-public", publicObjectPath("uspa", "ABC123", "noon", 2, false))).toBe(
      "https://storage.googleapis.com/image-links-agent-public/catalog/uspa/ABC123/noon/ABC123_2.jpg",
    );
  });
});
