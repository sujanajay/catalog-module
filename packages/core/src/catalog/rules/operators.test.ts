// Tier 1: every operator of the channel rules dataset has a written meaning and a test (M5-F1-R7), and text measures
// count what a person sees (M5-F4-R7). Pure, no database.
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../channels";
import { CONTACT_PATTERNS, fmt, hasPhone, hasPhrase, isProse, OPERATORS, ruleRegex, same, type CheckContext, type CheckOutcome } from "./operators";
import { RULES_DATASET } from "./seed";
import { recordFor } from "./test-fixtures";
import { byteCount, charCount, isAllCaps, isSentenceCase, isTitleCase, keywordTerms, sentenceCount } from "./text";

const noon = CHANNELS.noon;
const ctx: CheckContext = { channel: recordFor("noon"), brandName: "Tommy Hilfiger" };
const noBrand: CheckContext = { ...ctx, brandName: null };

const run = (op: string, measured: unknown, value: unknown, c: CheckContext = ctx): CheckOutcome => OPERATORS[op]!.check(measured, value, c).outcome;

describe("operator table", () => {
  it("has a written meaning for every operator the dataset uses", () => {
    const used = [...new Set(RULES_DATASET.rules.map((r) => r.rule.operator))];
    const missing = used.filter((op) => !OPERATORS[op]);
    expect(missing).toEqual([]);
    for (const [name, spec] of Object.entries(OPERATORS)) expect(spec.meaning.length, name).toBeGreaterThan(10);
  });

  it("never writes an em dash in a meaning", () => {
    for (const spec of Object.values(OPERATORS)) expect(spec.meaning).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("value operators", () => {
  it("equals and not_equals ignore case and spacing for text, compare deeply otherwise", () => {
    expect(run("equals", "JPEG", "jpeg")).toBe("pass");
    expect(run("equals", "flat_lay", "flat lay")).toBe("pass");
    expect(run("equals", 5, 5)).toBe("pass");
    expect(run("equals", 4, 5)).toBe("fail");
    expect(run("equals", { w: 1, h: 2 }, { h: 2, w: 1 })).toBe("pass");
    expect(run("not_equals", "lifestyle", "Lifestyle")).toBe("fail");
    expect(run("not_equals", "hero", "lifestyle")).toBe("pass");
  });

  it("equals_rgb takes hex or [r, g, b]", () => {
    expect(run("equals_rgb", "#FFFFFF", [255, 255, 255])).toBe("pass");
    expect(run("equals_rgb", [240, 240, 240], [255, 255, 255])).toBe("fail");
    expect(run("equals_rgb", "white", [255, 255, 255])).toBe("fail");
    expect(run("equals_rgb", "#FFFFFF", "white")).toBe("needs_judge");
  });

  it("in_set, allowed_values and not_in work on one value or a list", () => {
    expect(run("in_set", "JPEG", ["JPEG", "PNG"])).toBe("pass");
    expect(run("in_set", "TIFF", ["JPEG", "PNG"])).toBe("fail");
    expect(run("in_set", ["JPEG", "PNG"], ["JPEG", "PNG"])).toBe("pass");
    expect(run("allowed_values", "Regular", ["regular", "slim"])).toBe("pass");
    expect(run("allowed_values", "baggy", ["regular", "slim"])).toBe("fail");
    expect(run("not_in", "black", ["black", "patterned"])).toBe("fail");
    expect(run("not_in", "white", ["black", "patterned"])).toBe("pass");
    expect(run("in_set", "x", "JPEG or PNG")).toBe("needs_judge");
    expect(run("in_set", ["JPEG", "TIFF"], ["JPEG", "PNG"])).toBe("fail");
  });
});

describe("machine-checkable values (D29)", () => {
  const unusable = (op: string, v: unknown) => OPERATORS[op]!.unusable?.(v) ?? null;
  it("knows words from values", () => {
    for (const v of ["White/Light Grey", "1:1 or 4:5", "3:4 portrait", "74-82%", "allowed", "Pure White #FFFFFF"]) expect(isProse(v), v).toBe(true);
    for (const v of ["JPEG", "sRGB", "#FFFFFF", "4:5", "flat_lay", "cm", "not_allowed", "required", 72, false]) expect(isProse(v), String(v)).toBe(false);
  });
  it("flags unusable rule values per operator", () => {
    expect(unusable("equals", "White/Light Grey")).toContain("written in words");
    expect(unusable("equals", "sRGB")).toBeNull();
    expect(unusable("not_equals", "allowed only between nose and lip")).not.toBeNull();
    expect(unusable("lte", null)).not.toBeNull();
    expect(unusable("lte", 150)).toBeNull();
    expect(unusable("between", [null, null])).not.toBeNull();
    expect(unusable("between", [4, 5])).toBeNull();
    expect(unusable("not_contains", ["competitor brand names", "subjective claims"])).toContain("kinds of words");
    expect(unusable("not_contains", ["watermark", "logo"])).toBeNull();
    expect(unusable("not_contains", ["logo", "unwanted text", "unwanted objects"])).toContain("kinds of words");
    expect(unusable("within", "big")).not.toBeNull();
    expect(unusable("matches_regex", "([")).not.toBeNull();
    expect(unusable("in_range", "ask finance")).not.toBeNull();
    expect(unusable("equals_ordered", ["Front on model"])).not.toBeNull();
  });
  it("policy words: not_allowed passes when absent or false, required when present", () => {
    for (const m of [false, "none", "no", null, "absent"]) expect(run("equals", m, "not_allowed"), String(m)).toBe("pass");
    for (const m of [true, "present", "yes"]) expect(run("equals", m, "not_allowed"), String(m)).toBe("fail");
    expect(run("equals", true, "required")).toBe("pass");
    expect(run("equals", "none", "required")).toBe("fail");
    expect(run("equals", false, "required")).toBe("fail");
  });

  it("safe margin objects are per-side minimums with a small tolerance", () => {
    const v = { top: 0.1, bottom: 0.1, left: 0.05, right: 0.05 };
    expect(run("equals", { top: 0.2, bottom: 0.1, left: 0.05, right: 0.05 }, v)).toBe("pass");
    expect(run("equals", { top: 0.0999, bottom: 0.1, left: 0.05, right: 0.05 }, v)).toBe("pass");
    expect(run("equals", { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 }, v)).toBe("fail");
    const sides = { ...v, sides_only_when_product_wider_than_tall: true };
    expect(run("equals", { top: 0.1, bottom: 0.1, left: 0, right: 0 }, sides)).toBe("pass");
    expect(run("equals", { top: 0.1, bottom: 0.1, left: 0, right: 0, wide: true }, sides)).toBe("fail");
    expect(run("equals", { top: 0.1, bottom: 0.1 }, v)).toBe("needs_judge");
  });

  it("an object compares the measured keys first and fails a wrong one before asking for the rest", () => {
    expect(run("equals", { w: 1000, h: 1800 }, { w: 1200, h: 1800, dpi: 96 })).toBe("fail");
  });

  it("equals checks a canvas spec as within and compares only the keys an object names", () => {
    const spec = { min: { w: 600, h: 800 }, target: { w: 1200, h: 1800 }, fixed: true };
    expect(run("equals", { w: 1200, h: 1800 }, spec)).toBe("pass");
    expect(run("equals", { w: 1200, h: 1600 }, spec)).toBe("fail");
    expect(run("equals", { w: 1200, h: 1800, dpi: 96, format: "JPEG" }, { w: 1200, h: 1800, dpi: 96 })).toBe("pass");
    expect(run("equals", { w: 1200, h: 1800 }, { w: 1200, h: 1800, dpi: 96 })).toBe("needs_judge");
    expect(fmt({ w: 1200, h: 1800, dpi: 96 })).toBe('{"w":1200,"h":1800,"dpi":96}');
    expect(fmt({ w: 1200, h: 1800 })).toBe("1200x1800");
  });
  it("same() compares object keys both ways", () => {
    expect(same({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(same({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});

describe("number operators", () => {
  it("compares sizes on height as well as width, and fails a number against a size limit", () => {
    expect(run("gte", { w: 1200, h: 900 }, { w: 1000, h: 1000 })).toBe("fail");
    expect(run("gte", 2000, { w: 1000, h: 1000 })).toBe("fail");
    const spec = { min: { w: 660, h: 900 }, target: { w: 1100, h: 1500 } };
    expect(run("within", { w: 700, h: 800 }, spec)).toBe("fail");
    expect(run("within", { w: 1100, h: 1400 }, { ...spec, fixed: true })).toBe("fail");
  });

  it("between includes both bounds", () => {
    expect(run("between", 5, [4, 5])).toBe("pass");
    expect(run("between", 4, [4, 5])).toBe("pass");
    expect(run("between", 5.01, [4, 5])).toBe("fail");
    expect(run("between", 5, [null, null])).toBe("needs_judge");
  });

  it("matches_channel allows 1% off the channel ratio, not more", () => {
    const t = noon.targetCanvas;
    expect(run("matches_channel", { w: Math.round(t.w * 1.005), h: t.h }, true)).toBe("pass");
    expect(run("matches_channel", { w: Math.round(t.w * 1.05), h: t.h }, true)).toBe("fail");
  });

  it("gte, lte and lt compare numbers and say the limit", () => {
    expect(OPERATORS.lte!.check(163, 150, ctx)).toEqual({ outcome: "fail", says: "allows at most 150" });
    expect(run("lte", 150, 150)).toBe("pass");
    expect(run("gte", 59, 60)).toBe("fail");
    expect(run("gte", 60, 60)).toBe("pass");
    expect(run("lt", 1000, 1000)).toBe("fail");
    expect(run("lt", 999, 1000)).toBe("pass");
  });

  it("compares sizes on both width and height", () => {
    expect(run("gte", { w: 1200, h: 1600 }, { w: 1000, h: 1000 })).toBe("pass");
    expect(run("gte", { w: 900, h: 1600 }, { w: 1000, h: 1000 })).toBe("fail");
  });

  it("fails a value that is not a number and needs a judgement for a limit that is not one", () => {
    expect(OPERATORS.lte!.check("abc", 150, ctx)).toEqual({ outcome: "fail", says: "value is not a number" });
    expect(run("lte", 10, null)).toBe("needs_judge");
    expect(run("lte", 10, "channel limit")).toBe("needs_judge");
  });

  it("between and between_max treat a null bound as open", () => {
    expect(run("between", 4, [4, 5])).toBe("pass");
    expect(run("between", 6, [4, 5])).toBe("fail");
    expect(run("between", 3, [4, 5])).toBe("fail");
    expect(run("between_max", 0, [null, 7])).toBe("pass");
    expect(run("between_max", 8, [null, 7])).toBe("fail");
    expect(run("between", 1e9, [60, null])).toBe("pass");
    expect(run("between", 5, "4 to 5")).toBe("needs_judge");
  });

  it("within checks the canvas minimum, or the exact target when fixed", () => {
    const spec = { min: { w: 660, h: 900 }, target: { w: 1100, h: 1500 } };
    expect(run("within", { w: 1100, h: 1500 }, spec)).toBe("pass");
    expect(run("within", { w: 600, h: 900 }, spec)).toBe("fail");
    expect(run("within", { w: 1200, h: 1500 }, { ...spec, fixed: true })).toBe("fail");
    expect(run("within", "big", spec)).toBe("fail");
    expect(run("within", { w: 1, h: 1 }, "large")).toBe("needs_judge");
  });

  it("classify puts the value inside the band of its class", () => {
    const bands = { flat: [0, 2.5], mid: [2.5, 7.5], high: [7.5, null] };
    expect(run("classify", { class: "mid", value: 5 }, bands)).toBe("pass");
    expect(run("classify", { class: "flat", value: 5 }, bands)).toBe("fail");
    expect(run("classify", { class: "platform", value: 5 }, bands)).toBe("fail");
    expect(run("classify", 5, bands)).toBe("fail");
  });

  it("matches_channel compares the ratio to the channel's target canvas", () => {
    const t = noon.targetCanvas;
    expect(run("matches_channel", { w: t.w * 2, h: t.h * 2 }, true)).toBe("pass");
    expect(run("matches_channel", { w: 1000, h: 1000 }, true)).toBe(t.w === t.h ? "pass" : "fail");
    expect(run("matches_channel", { w: 1, h: 1 }, true, { ...ctx, channel: null })).toBe("needs_judge");
  });
});

describe("presence operators", () => {
  it("present and required fail on nothing, empty or false", () => {
    for (const empty of [null, undefined, "", "  ", [], {}, false]) {
      expect(run("present", empty, true)).toBe("fail");
      expect(run("required", empty, true)).toBe("fail");
    }
    expect(run("present", "cotton", true)).toBe("pass");
    expect(run("present", 0, true)).toBe("pass");
    expect(OPERATORS.present!.absenceFails).toBe(true);
  });

  it("required with allowed values also checks the value", () => {
    expect(run("required", "slim", { allowed_values: ["slim", "regular"] })).toBe("pass");
    expect(run("required", "baggy", { allowed_values: ["slim", "regular"] })).toBe("fail");
  });

  it("all_present, includes and includes_fields need every listed item", () => {
    expect(run("all_present", ["chest", "length", "waist"], ["chest", "length"])).toBe("pass");
    expect(OPERATORS.all_present!.check(["chest"], ["chest", "length"], ctx)).toEqual({ outcome: "fail", says: 'needs "length" as well' });
    expect(run("all_present", { chest: 90, length: null }, ["chest", "length"])).toBe("fail");
    expect(run("includes", ["front", "back", "side"], ["front", "back"])).toBe("pass");
    expect(run("includes_fields", ["Size", "Chest"], ["size", "chest", "waist"])).toBe("fail");
  });

  it("includes_any and uses_field", () => {
    expect(run("includes_any", ["comparison chart"], ["brand story", "comparison chart"])).toBe("pass");
    expect(run("includes_any", ["banner"], ["brand story", "comparison chart"])).toBe("fail");
    expect(run("uses_field", ["size", "foot length cm"], "foot_length_cm")).toBe("pass");
    expect(run("uses_field", ["size"], "foot_length_cm")).toBe("fail");
  });

  it("all_differ_between_sizes fails two equal size rows", () => {
    expect(run("all_differ_between_sizes", [{ s: "S", chest: 90 }, { s: "M", chest: 95 }], true)).toBe("pass");
    expect(run("all_differ_between_sizes", [{ chest: 90 }, { chest: 90 }], true)).toBe("fail");
    expect(run("all_differ_between_sizes", "rows", true)).toBe("fail");
  });
});

describe("sequence operators", () => {
  it("equals_ordered matches a role prefix with A|B alternatives", () => {
    expect(run("equals_ordered", ["FL", "BK", "SD", "DT"], ["FM|FL", "BK", "SD"])).toBe("pass");
    expect(run("equals_ordered", ["BK", "FL"], ["FM|FL", "BK"])).toBe("fail");
    expect(run("equals_ordered", ["FM"], ["FM", "BK"])).toBe("fail");
    expect(run("equals_ordered", "FM,BK", ["FM", "BK"])).toBe("fail");
  });

  it("equals_ordered written as prose needs a judgement", () => {
    expect(run("equals_ordered", ["FM"], ["Front on model, full length", "Back"])).toBe("needs_judge");
  });
});

describe("text operators", () => {
  it("matches_regex reads (?i) as any case and checks every item of a list", () => {
    expect(ruleRegex("(?i)abc")!.flags).toContain("i");
    expect(run("matches_regex", "100% Cotton", "^\\d+% \\w+")).toBe("pass");
    expect(run("matches_regex", "cotton", "(?i)^COTTON$")).toBe("pass");
    expect(run("matches_regex", ["IMG_1.jpg", "bad name"], "^\\S+$")).toBe("fail");
    expect(run("matches_regex", 5, "^\\d$")).toBe("fail");
  });

  it("not_matches_regex fails on a match; a broken pattern needs a judgement", () => {
    expect(run("not_matches_regex", "Best cotton tee", "(?i)\\b(best|top)\\b")).toBe("fail");
    expect(run("not_matches_regex", "Cotton tee", "(?i)\\b(best|top)\\b")).toBe("pass");
    expect(run("not_matches_regex", "x", "([")).toBe("needs_judge");
  });

  it("not_contains finds whole words and phrases in any case", () => {
    expect(run("not_contains", "Slim fit FREE SHIPPING tee", ["free shipping"])).toBe("fail");
    expect(run("not_contains", "Freestyle tee", ["free"])).toBe("pass");
    expect(run("not_contains", ["<b>Soft</b>", "Cool"], ["<b>"])).toBe("fail");
    expect(run("not_contains", ["<b>Soft</b> cotton"], ["html"])).toBe("fail");
    expect(run("not_contains", ["Made for html lovers"], ["html"])).toBe("pass");
    expect(run("not_contains", ["**Soft** cotton"], ["markdown"])).toBe("fail");
    expect(run("not_contains", ["Soft cotton"], ["markdown"])).toBe("pass");
    expect(hasPhrase("Sale ends soon", "sale")).toBe(true);
    expect(hasPhrase("Wholesale pack", "sale")).toBe(false);
  });

  it("not_contains_pattern finds web addresses, phone numbers and emails", () => {
    const kinds = ["url", "phone", "email"];
    expect(run("not_contains_pattern", "Cotton tee, visit www.shop.example", kinds)).toBe("fail");
    expect(run("not_contains_pattern", "Call +971 50 123 4567 today", kinds)).toBe("fail");
    expect(run("not_contains_pattern", "Write to care@brand.ae", kinds)).toBe("fail");
    expect(run("not_contains_pattern", "Men's Slim Fit Cotton Polo Shirt, Navy, Size M", kinds)).toBe("pass");
    expect(run("not_contains_pattern", "x", ["fax"])).toBe("needs_judge");
    expect(Object.keys(CONTACT_PATTERNS).sort()).toEqual(["email", "phone", "url"]);
  });

  it("each contact kind finds its own pattern alone", () => {
    expect(run("not_contains_pattern", "Write to care@brandmail.xyz", ["email"])).toBe("fail");
    expect(run("not_contains_pattern", "Write to care@brandmail.xyz", ["url"])).toBe("pass");
    expect(run("not_contains_pattern", "Shop at brand.com today", ["url"])).toBe("fail");
    expect(run("not_contains_pattern", "Visit https://x.example/p", ["url"])).toBe("fail");
    expect(run("not_contains_pattern", "Pack of 3 tees", ["phone"])).toBe("pass");
  });

  it("phone numbers are told apart from sizes, barcodes and years", () => {
    for (const t of ["+971 50 123 4567", "+91 98765 43210", "050 123 4567", "0501234567", "9876543210", "Size 10 050 123 4567"]) expect(hasPhone(t), t).toBe(true);
    for (const t of ["Waist 28 30 32 34", "UK 6 7 8 9 10", "EAN 8901234567890", "Shorts 2024 2025 Collection", "2024 2025 2026", "Pack of 12345678", "Style 123456789"]) expect(hasPhone(t), t).toBe(false);
    for (const t of ["Sizes 06 08 10 12 14", "+1234567890123456", "0123456789012"]) expect(hasPhone(t), t).toBe(false);
  });

  it("checks a long run of numbers in linear time (round 2, P2-4)", () => {
    const table = Array.from({ length: 2000 }, (_, i) => String(20 + (i % 30))).join(" ");
    const t = performance.now();
    expect(hasPhone(table)).toBe(false);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("title case and sentence case, never all capitals", () => {
    expect(run("is_title_case_not_all_caps", "Men's Slim Fit Polo with Logo", true)).toBe("pass");
    expect(run("is_title_case_not_all_caps", "Men's slim fit polo", true)).toBe("fail");
    expect(run("is_title_case_not_all_caps", "MEN'S POLO SHIRT", true)).toBe("fail");
    expect(run("is_sentence_case_not_all_caps", "Soft cotton for all day wear", true)).toBe("pass");
    expect(run("is_sentence_case_not_all_caps", "soft cotton", true)).toBe("fail");
    expect(run("is_sentence_case_not_all_caps", "SOFT COTTON", true)).toBe("fail");
  });

  it("equals_brand needs the exact brand name, else a judgement", () => {
    expect(run("equals_brand", "Tommy Hilfiger Men's Polo", true)).toBe("pass");
    expect(run("equals_brand", "Men's Polo by Tommy Hilfiger", true)).toBe("fail");
    expect(run("equals_brand", "Tommy Hilfiger Polo", true, noBrand)).toBe("needs_judge");
  });
});

describe("code operators (HSN)", () => {
  it("in_range and in_set_prefix read code ranges written in prose", () => {
    expect(run("in_range", "64041190", "6401-6406")).toBe("pass");
    expect(run("in_range", "61091000", "6401-6406")).toBe("fail");
    expect(run("in_set_prefix", "6110", "6105, 6106, 6110")).toBe("pass");
    expect(run("in_set_prefix", "6111", "6105, 6106, 6110")).toBe("fail");
    expect(run("in_set_prefix", "abc", "6105")).toBe("fail");
    expect(run("in_range", "6401", "ask finance")).toBe("needs_judge");
  });
});

describe("guidance and judgement operators", () => {
  it("guidance and permissions are not checks", () => {
    for (const op of ["allowed", "suggest_from", "lte_shortest_channel_first"]) expect(run(op, "x", true)).toBe("not_applicable");
  });

  it("operators that need a judgement or missing data never pass silently", () => {
    for (const op of [
      "judge",
      "follows_formula",
      "per_channel",
      "main_keyword_within_first_chars",
      "equals_primary_keyword",
      "equals_label_on_product",
      "lte_channel_limit",
      "present_if",
      "must_match_product_type_definition_enum",
      "from_api",
      "from_template",
      "exists",
      "applied",
    ])
      expect(run(op, "anything", true), op).toBe("needs_judge");
  });
});

describe("text measures", () => {
  it("counts grapheme clusters, not code units", () => {
    expect(charCount("abc")).toBe(3);
    expect(charCount("\u{1F44D}\u{1F3FD}")).toBe(1); // thumbs up with a skin tone
    expect("\u{1F44D}\u{1F3FD}".length).toBe(4);
    expect(charCount("é")).toBe(1); // e with a combining accent
    expect(charCount("قميص")).toBe(4); // Arabic "qamis", four letters
  });

  it("counts UTF-8 bytes only for byte fields", () => {
    expect(byteCount("abc")).toBe(3);
    expect(byteCount("قميص")).toBe(8);
    expect(byteCount("\u{1F44D}")).toBe(4);
  });

  it("counts sentences and keyword terms", () => {
    expect(sentenceCount("Soft cotton. Easy care! Made to last")).toBe(3);
    expect(sentenceCount("")).toBe(0);
    expect(keywordTerms("polo, cotton polo; tee")).toEqual(["polo", "cotton polo", "tee"]);
    expect(keywordTerms("polo cotton tee")).toEqual(["polo", "cotton", "tee"]);
  });

  it("knows all capitals, title case and sentence case", () => {
    expect(isAllCaps("NEW TEE")).toBe(true);
    expect(isAllCaps("UK")).toBe(false);
    expect(isTitleCase("100% Cotton Tee for Men")).toBe(true);
    expect(isTitleCase("قميص رجالي")).toBe(true);
    expect(isSentenceCase("100% cotton")).toBe(true);
  });
});
