// Tier 1 and 2: evaluate(snapshot, subject) (M5-F4). The pure tests use hand-built snapshots; the planted cases of the
// M5-S2 row (R1-build section 7) run on the real seeded ruleset v2 from PGlite: a 163-character Noon title blocks on
// R013 and only warns on Namshi (R015), the open-conflict rule R037 warns and names C04, and the playbook block R024
// warns.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTaxonomy } from "../../analyze/taxonomy-seed";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { blocks, effectiveSeverity, evaluate, routeToJudge } from "./evaluate";
import { seedChannelRules } from "./seed";
import { loadSnapshot } from "./store";
import { conflict, rule, snapshot } from "./test-fixtures";
import type { RuleResult, RulesetSnapshot, Subject } from "./types";

const subject = (over: Partial<Subject> = {}): Subject => ({
  channel: "noon",
  market: "AE",
  brandId: "brand-1",
  categoryPath: ["fashion", "fashion.apparel", "fashion.apparel.upper"],
  language: "en",
  component: "title",
  contentVersionId: "cv-1",
  value: "Men's Slim Fit Cotton Polo Shirt",
  ...over,
});

const byId = (results: RuleResult[], id: string) => results.find((r) => r.ruleId === id);
const title = (n: number) => "Men's Slim Fit Cotton Polo Shirt ".repeat(10).slice(0, n);

describe("effective severity (M5-F4-R2, every branch)", () => {
  const open = [conflict("C04", ["X"])];
  it("1. a rule in an open conflict warns, whatever else it says", () => {
    const r = rule({ id: "X", declaredSeverity: "block", evidence: "documented", confirmedBy: "gate1-C01" });
    expect(effectiveSeverity(r, open)).toEqual({ severity: "warn", judge: false, note: "Warn only while conflict C04 is open." });
  });
  it("1. a decided conflict does not count", () => {
    const r = rule({ id: "X", declaredSeverity: "block", evidence: "documented" });
    expect(effectiveSeverity(r, [conflict("C04", ["X"], "decided")]).severity).toBe("block");
  });
  it("2. a rule that is not checkable needs a judgement and never blocks", () => {
    const r = rule({ declaredSeverity: "block", evidence: "documented", checkable: false });
    expect(effectiveSeverity(r, [])).toMatchObject({ severity: "warn", judge: true });
  });
  it("3. a block with documented or reported evidence blocks", () => {
    expect(effectiveSeverity(rule({ declaredSeverity: "block", evidence: "documented" }), []).severity).toBe("block");
    expect(effectiveSeverity(rule({ declaredSeverity: "block", evidence: "reported" }), []).severity).toBe("block");
  });
  it("3. a confirmed playbook or assumed block blocks", () => {
    expect(effectiveSeverity(rule({ declaredSeverity: "block", evidence: "playbook", confirmedBy: "gate1-C02" }), []).severity).toBe("block");
    expect(effectiveSeverity(rule({ declaredSeverity: "block", evidence: "assumed", confirmedBy: "gate1-C10" }), []).severity).toBe("block");
  });
  it("4. an unconfirmed playbook or assumed block warns", () => {
    expect(effectiveSeverity(rule({ declaredSeverity: "block", evidence: "playbook" }), [])).toEqual({
      severity: "warn",
      judge: false,
      note: "Warn only until a channel confirms it (source: playbook).",
    });
    expect(effectiveSeverity(rule({ declaredSeverity: "block", evidence: "assumed" }), []).severity).toBe("warn");
  });
  it("5. otherwise the declared severity", () => {
    expect(effectiveSeverity(rule({ declaredSeverity: "warn", evidence: "documented" }), [])).toEqual({ severity: "warn", judge: false, note: null });
    expect(effectiveSeverity(rule({ declaredSeverity: "warn", evidence: "playbook" }), []).severity).toBe("warn");
  });
});

describe("evaluate (pure)", () => {
  it("returns a fail with a plain message in characters, and block means not offered", () => {
    const r = rule({ channel: "noon", declaredSeverity: "block", evidence: "documented" });
    const [res] = evaluate(snapshot([r]), subject({ value: title(163) }));
    expect(res).toEqual({
      ruleId: r.id,
      ruleVersion: 1,
      outcome: "fail",
      effectiveSeverity: "block",
      measured: 163,
      message: "Title has 163 characters; Noon allows at most 150.",
    });
    expect(blocks(res!)).toBe(true);
  });

  it("counts grapheme clusters for length", () => {
    const r = rule({ value: 3 });
    const [res] = evaluate(snapshot([r]), subject({ value: "a\u{1F44D}\u{1F3FD}é" }));
    expect(res).toMatchObject({ outcome: "pass", measured: 3 });
  });

  it("counts bytes where the field says bytes", () => {
    const r = rule({ component: "keywords", field: "keywords.bytes", value: 250 });
    const [res] = evaluate(snapshot([r]), subject({ component: "keywords", value: "ق".repeat(126) }));
    expect(res).toMatchObject({ outcome: "fail", measured: 252, message: "Keywords has 252 bytes; Every channel allows at most 250." });
  });

  it("checks each bullet and names the first that fails", () => {
    const r = rule({ channel: "noon", component: "bullets", field: "bullets.each.length", value: 80 });
    const [res] = evaluate(snapshot([r]), subject({ component: "bullets", value: ["Soft cotton", "x".repeat(95), "y".repeat(90)] }));
    expect(res).toMatchObject({ outcome: "fail", measured: [11, 95, 90], message: "Bullet 2 has 95 characters; Noon allows at most 80." });
  });

  it("counts bullets and keyword terms", () => {
    const count = rule({ component: "bullets", field: "bullets.count", operator: "between", value: [4, 5] });
    expect(evaluate(snapshot([count]), subject({ component: "bullets", value: ["a", "b", "c"] }))[0]).toMatchObject({ outcome: "fail", measured: 3 });
    const terms = rule({ component: "keywords", field: "keywords.count", operator: "between_max", value: [null, 2] });
    expect(evaluate(snapshot([terms]), subject({ component: "keywords", value: "polo, tee, shirt" }))[0]).toMatchObject({ outcome: "fail", measured: 3 });
  });

  it("reads measured facts by the full field name or by the name under the component", () => {
    const rgb = rule({ component: "image", field: "image.background.rgb_min", operator: "gte", value: 240 });
    const dpi = rule({ component: "image", field: "image.dpi", operator: "gte", value: 72 });
    const res = evaluate(snapshot([rgb, dpi]), subject({ component: "image", value: { "image.background.rgb_min": 238, dpi: 300 } }));
    expect(byId(res, rgb.id)).toMatchObject({ outcome: "fail", measured: 238 });
    expect(byId(res, dpi.id)).toMatchObject({ outcome: "pass", measured: 300 });
  });

  it("reads nested facts", () => {
    const r = rule({ component: "image", field: "image.1.background_hex", operator: "equals", value: "#FFFFFF" });
    const [res] = evaluate(snapshot([r]), subject({ component: "image", value: { 1: { background_hex: "#ffffff" } } }));
    expect(res).toMatchObject({ outcome: "pass", measured: "#ffffff" });
  });

  it("says not measured for a fact the caller did not give, except presence rules, which fail", () => {
    const rgb = rule({ component: "image", field: "image.background.rgb_min", operator: "gte", value: 240 });
    const care = rule({ component: "attributes", field: "attributes.care", operator: "required", value: true });
    expect(evaluate(snapshot([rgb]), subject({ component: "image", value: {} }))[0]).toMatchObject({
      outcome: "not_applicable",
      message: "Not measured: image.background.rgb_min.",
    });
    expect(evaluate(snapshot([care]), subject({ component: "attributes", value: { colour: "navy" } }))[0]).toMatchObject({ outcome: "fail", measured: null });
  });

  it("fails a value of the wrong type with a plain message and never throws", () => {
    const r = rule({ component: "image", field: "image.dpi", operator: "gte", value: 72 });
    const [res] = evaluate(snapshot([r]), subject({ component: "image", value: { dpi: "high" } }));
    expect(res).toMatchObject({ outcome: "fail", message: 'Image dpi is "high"; value is not a number.' });
  });

  it("turns a crash inside a check into needs_judge", () => {
    const r = rule({ component: "attributes", field: "attributes.x", operator: "equals", value: 1 });
    const hostile = { get "attributes.x"() { throw new Error("boom"); } };
    expect(evaluate(snapshot([r]), subject({ component: "attributes", value: hostile }))[0]).toMatchObject({ outcome: "needs_judge" });
  });

  it("makes rules with an unknown operator needs_judge, never pass", () => {
    const r = rule({ operator: "made_up" });
    expect(evaluate(snapshot([r]), subject())[0]).toMatchObject({ outcome: "needs_judge", message: "Title length: rule " + r.id + " needs a judgement (no check for made_up)." });
  });

  it("routes checkable false rules to a judgement", () => {
    const r = rule({ field: "title.relevance", operator: "judge", checkable: false, judgeMethod: "llm", declaredSeverity: "block" });
    const res = evaluate(snapshot([r]), subject());
    expect(res[0]).toMatchObject({ outcome: "needs_judge", effectiveSeverity: "warn" });
    expect(routeToJudge(snapshot([r]), subject(), res)).toEqual([
      {
        ruleId: r.id,
        ruleVersion: 1,
        rulesetVersion: 9,
        channel: "noon",
        component: "title",
        field: "title.relevance",
        judgeMethod: "llm",
        contentVersionId: "cv-1",
        question: res[0]!.message,
      },
    ]);
  });

  it("names the open conflict in the message of a rule that only warns because of it", () => {
    const r = rule({ id: "R900", channel: "noon", declaredSeverity: "block", evidence: "documented" });
    const [res] = evaluate(snapshot([r], [conflict("C04", ["R900"])]), subject({ value: title(163) }));
    expect(res).toMatchObject({ outcome: "fail", effectiveSeverity: "warn" });
    expect(res!.message).toBe("Title has 163 characters; Noon allows at most 150. Warn only while conflict C04 is open.");
    expect(blocks(res!)).toBe(false);
  });

  it("skips retired, superseded and draft rules, and other components", () => {
    const rules = [rule({ status: "retired" }), rule({ status: "superseded" }), rule({ status: "draft" }), rule({ component: "bullets", field: "bullets.count" })];
    expect(evaluate(snapshot(rules), subject())).toEqual([]);
  });

  it("returns nothing for a channel that is not in the snapshot", () => {
    expect(evaluate(snapshot([rule({})]), subject({ channel: "myntra" }))).toEqual([]);
  });
});

describe("scope (M5-F1-R8)", () => {
  it("applies a rule by channel, market, brand and language", () => {
    const rules = [
      rule({ id: "CH", channel: "namshi" }),
      rule({ id: "MK", market: "IN" }),
      rule({ id: "GCC", market: "GCC", field: "title.text", operator: "not_contains", value: ["sale"] }),
      rule({ id: "BR", brandScope: "brand-2", field: "title.case", operator: "is_title_case_not_all_caps", value: true }),
      rule({ id: "AR", language: "ar", field: "title.bytes" }),
    ];
    const ids = evaluate(snapshot(rules), subject()).map((r) => r.ruleId);
    expect(ids).toEqual(["GCC"]);
  });

  it("applies category rules to the subject's node and its parents", () => {
    const upper = rule({ id: "UP", categoryScope: ["fashion.apparel.upper"], field: "title.text", operator: "not_contains", value: ["x"] });
    const shoes = rule({ id: "SH", categoryScope: ["fashion.footwear"], field: "title.case", operator: "is_title_case_not_all_caps", value: true });
    const apparel = rule({ id: "AP", categoryScope: ["fashion.apparel"], field: "title.bytes" });
    const ids = evaluate(snapshot([upper, shoes, apparel]), subject({ categoryPath: ["fashion.apparel.upper"] })).map((r) => r.ruleId);
    expect(ids.sort()).toEqual(["AP", "UP"]);
  });

  it("gives category rules not_applicable when the category is unknown, and still applies rules for all", () => {
    const upper = rule({ id: "UP", categoryScope: ["fashion.apparel.upper"], field: "title.text", operator: "not_contains", value: ["x"] });
    const shoes = rule({ id: "SH", categoryScope: ["fashion.footwear"], field: "title.case", operator: "is_title_case_not_all_caps", value: true });
    const all = rule({ id: "ALL", field: "title.bytes" });
    const res = evaluate(snapshot([upper, shoes, all]), subject({ categoryPath: ["fashion.apparel.unknown"] }));
    expect(byId(res, "UP")).toMatchObject({ outcome: "not_applicable", message: "Category unknown: rule UP applies to some categories only." });
    expect(byId(res, "SH")).toBeUndefined();
    expect(byId(res, "ALL")).toMatchObject({ outcome: "pass" });
    expect(evaluate(snapshot([shoes]), subject({ categoryPath: [] }))[0]).toMatchObject({ outcome: "not_applicable" });
  });

  it("gives audience rules not_applicable when the audience is unknown", () => {
    const women = rule({ id: "W", audience: ["women"], field: "title.bytes" });
    expect(evaluate(snapshot([women]), subject())[0]).toMatchObject({ outcome: "not_applicable", message: "Audience unknown: rule W applies to some audiences only." });
    expect(evaluate(snapshot([women]), subject({ audience: "women" }))[0]).toMatchObject({ outcome: "pass" });
    expect(evaluate(snapshot([women]), subject({ audience: "men" }))).toEqual([]);
  });

  it("the most specific limit of the same field wins; equally specific limits all apply", () => {
    const fallback = rule({ id: "R011", field: "title.length", operator: "between", value: [60, 200] });
    const max = rule({ id: "R013", channel: "noon", value: 150 });
    const min = rule({ id: "R556", channel: "noon", operator: "gte", value: 60 });
    const brand = rule({ id: "B", channel: "noon", brandScope: "brand-1", value: 120 });
    expect(evaluate(snapshot([fallback, max, min]), subject()).map((r) => r.ruleId).sort()).toEqual(["R013", "R556"]);
    expect(evaluate(snapshot([fallback, max, min]), subject({ channel: "amazon" })).map((r) => r.ruleId)).toEqual(["R011"]);
    expect(evaluate(snapshot([fallback, max, min, brand]), subject()).map((r) => r.ruleId)).toEqual(["B"]);
  });

  it("a channel's exact value replaces a fallback range on the same field", () => {
    const range = rule({ id: "R030", component: "bullets", field: "bullets.count", operator: "between", value: [4, 5] });
    const exact = rule({ id: "R031", channel: "noon", component: "bullets", field: "bullets.count", operator: "equals", value: 5 });
    expect(evaluate(snapshot([range, exact]), subject({ component: "bullets", value: ["a"] })).map((r) => r.ruleId)).toEqual(["R031"]);
  });

  it("prohibitions add up instead of replacing each other", () => {
    const url = rule({ id: "URL", field: "title.text", operator: "not_contains_pattern", value: ["url"] });
    const words = rule({ id: "WORDS", channel: "noon", field: "title.text", operator: "not_contains", value: ["sale"] });
    expect(evaluate(snapshot([url, words]), subject()).map((r) => r.ruleId).sort()).toEqual(["URL", "WORDS"]);
  });

  it("matches GCC rules to AE and SA and needs a market for market rules", () => {
    const gcc = rule({ id: "G", market: "GCC" });
    expect(evaluate(snapshot([gcc]), subject({ market: "SA" }))[0]?.ruleId).toBe("G");
    expect(evaluate(snapshot([gcc]), subject({ market: "IN" }))).toEqual([]);
    expect(evaluate(snapshot([gcc]), subject({ market: null }))[0]).toMatchObject({ outcome: "not_applicable", message: "Market unknown: rule G applies to some markets only." });
  });
});

describe("planted cases on ruleset v2 (M5-S2 acceptance)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let v2: RulesetSnapshot;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedTaxonomy(db);
    await seedChannelRules(db);
    v2 = (await loadSnapshot(db, 2))!;
  });

  afterAll(async () => {
    await close();
  });

  it("a 163-character Noon title fails R013 and blocks", () => {
    const res = evaluate(v2, subject({ value: title(163) }));
    expect(byId(res, "R013")).toMatchObject({ outcome: "fail", effectiveSeverity: "block", measured: 163, message: "Title has 163 characters; Noon allows at most 150." });
    expect(res.filter(blocks).map((r) => r.ruleId)).toEqual(["R013"]);
    expect(byId(res, "R011")).toBeUndefined();
  });

  it("the same title on Namshi does not block; R015 warns", () => {
    const res = evaluate(v2, subject({ channel: "namshi", value: title(163) }));
    expect(res.filter(blocks)).toEqual([]);
    expect(byId(res, "R015")).toMatchObject({ outcome: "fail", effectiveSeverity: "warn" });
    expect(byId(res, "R014")).toMatchObject({ outcome: "pass", effectiveSeverity: "block" });
  });

  it("R037 is in open conflict C04: a long Noon bullet warns and the message names C04", () => {
    const res = evaluate(v2, subject({ component: "bullets", value: ["Soft cotton", "x".repeat(95)] }));
    const r037 = byId(res, "R037");
    expect(r037).toMatchObject({ outcome: "fail", effectiveSeverity: "warn" });
    expect(r037!.message).toContain("C04");
    expect(res.filter(blocks)).toEqual([]);
  });

  it("R024 is a playbook block: a phone number in the title warns", () => {
    const res = evaluate(v2, subject({ value: "Men's Polo Shirt, call +971 50 123 4567" }));
    expect(byId(res, "R024")).toMatchObject({ outcome: "fail", effectiveSeverity: "warn" });
    expect(byId(res, "R024")!.message).toContain("Warn only until a channel confirms it");
  });

  it("R227 is the render default, not a literal check (D21); R086 checks the grey", () => {
    const res = evaluate(v2, subject({ component: "image", value: { "image.background_hex": "#F2F2F2", "image.background.rgb_min": 242 } }));
    expect(byId(res, "R227")).toMatchObject({ outcome: "not_applicable" });
    expect(byId(res, "R086")).toMatchObject({ outcome: "pass" });
  });

  it("evaluates every component of the real ruleset without throwing", () => {
    const values: Record<string, unknown> = { title: title(80), bullets: ["Soft cotton"], description: "Soft. Cotton.", keywords: "polo, tee", image: {}, attributes: {}, size_chart: {}, a_plus: {}, video: {}, file: {} };
    for (const channel of v2.channels.map((c) => c.id))
      for (const [component, value] of Object.entries(values))
        expect(() => evaluate(v2, subject({ channel, component: component as Subject["component"], value }))).not.toThrow();
  });

  it("takes under 5 ms per product and channel for the text components (median)", () => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      for (const [component, value] of [["title", title(120)], ["bullets", ["a", "b", "c", "d", "e"]], ["description", "Soft cotton. Easy care."], ["keywords", "polo, tee"]] as const)
        evaluate(v2, subject({ component, value }));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[25]!).toBeLessThan(5);
  });
});
