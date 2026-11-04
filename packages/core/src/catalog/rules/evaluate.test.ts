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
import type { ChannelRecord, RuleResult, RulesetSnapshot, Subject } from "./types";

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

  it("a market-scoped limit beats one for every market, and a deeper category beats a shallower one", () => {
    const any = rule({ id: "ANY", channel: "amazon", component: "image", field: "image.dpi", operator: "gte", value: 72 });
    const gcc = rule({ id: "GCC", channel: "amazon", market: "GCC", component: "image", field: "image.dpi", operator: "gte", value: 300 });
    const img = (over: Partial<Subject> = {}) => subject({ channel: "amazon", component: "image", value: { dpi: 100 }, ...over });
    expect(evaluate(snapshot([any, gcc]), img()).map((r) => r.ruleId)).toEqual(["GCC"]);
    const all = rule({ id: "ALL", field: "title.length", value: 200 });
    const apparel = rule({ id: "AP", categoryScope: ["fashion.apparel"], field: "title.length", value: 150 });
    const upper = rule({ id: "UP", categoryScope: ["fashion.apparel.upper"], field: "title.length", value: 120 });
    expect(evaluate(snapshot([all, apparel]), subject()).map((r) => r.ruleId)).toEqual(["AP"]);
    expect(evaluate(snapshot([all, apparel, upper]), subject()).map((r) => r.ruleId)).toEqual(["UP"]);
  });

  it("an unusable limit never replaces a usable one", () => {
    const usable = rule({ id: "OK", field: "title.length", value: 150 });
    const unusable = rule({ id: "NULL", channel: "noon", field: "title.length", value: null });
    const res = evaluate(snapshot([usable, unusable]), subject({ value: title(160) }));
    expect(byId(res, "OK")).toMatchObject({ outcome: "fail" });
    expect(byId(res, "NULL")).toMatchObject({ outcome: "needs_judge" });
  });

  it("a per-bullet check that needs a judgement and finds no fail gives needs_judge, not pass", () => {
    const r = rule({ component: "bullets", field: "bullets.each.text", operator: "equals_brand", value: true });
    expect(evaluate(snapshot([r]), subject({ component: "bullets", value: ["a", "b"] }))[0]).toMatchObject({ outcome: "needs_judge" });
  });

  it("routeToJudge reads the rule version the result names", () => {
    const v2r = rule({ id: "J", version: 2, operator: "judge", checkable: false, judgeMethod: "new" });
    const v1r = { ...v2r, version: 1, status: "superseded" as const, judgeMethod: "old" };
    const snap = snapshot([v2r, v1r]);
    const res = evaluate(snap, subject());
    expect(routeToJudge(snap, subject(), res)[0]).toMatchObject({ ruleVersion: 2, judgeMethod: "new" });
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

  // The F4 target is 5 ms p95 per product and channel; the bound here is loose so a loaded CI runner does not flake.
  // The local median is logged in the M5-S2 report.
  it("evaluates the four text components of one product and channel well inside the time budget (median)", () => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      for (const [component, value] of [["title", title(120)], ["bullets", ["a", "b", "c", "d", "e"]], ["description", "Soft cotton. Easy care."], ["keywords", "polo, tee"]] as const)
        evaluate(v2, subject({ component, value }));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[25]!).toBeLessThan(25);
  });

  /** What a correct render for a channel measures (channels.ts numbers, grey 240 canvas, white image 1 where asked). */
  function goodImage(rec: ChannelRecord): Record<string, unknown> {
    const first = rec.firstImageBackground ?? "#F0F0F0";
    const margins = { top: rec.margins.top, bottom: rec.margins.bottom, left: rec.margins.left, right: rec.margins.right };
    return {
      "image.background.rgb_min": 240,
      "image.background.uniform": true,
      "image.background_hex": "#F0F0F0",
      "image.1.background_hex": first,
      "image.1.background": first,
      "image.1.border_or_vignette": false,
      "image.1.infographic": false,
      "image.1.overlay": [],
      "image.1.type": "hero",
      "image.overlay": [],
      "image.claims_text": [],
      "image.border": false,
      "image.printed_dates_or_swing_tags_in_primary": false,
      "image.duplicates": false,
      "image.duplicate_or_near_duplicate": false,
      "image.variant_distinct": true,
      "image.is_photograph": true,
      "image.mannequin_parts": false,
      "image.dpi": rec.dpi,
      "image.colour_space": "sRGB",
      "image.format": "JPEG",
      "image.canvas": rec.targetCanvas,
      "image.resolution": { ...rec.targetCanvas, dpi: rec.dpi },
      "image.url": "https://storage.googleapis.com/bucket/catalog/sku/1.jpg",
      ...(rec.margins.unit === "px" ? { "image.safe_margins_px": margins } : { "image.safe_margins_fraction": margins }),
    };
  }

  it("a correct image never blocks on any channel, with today's conflicts and with every conflict decided (P1 guard)", () => {
    const decided: RulesetSnapshot = { ...v2, conflicts: v2.conflicts.map((c) => ({ ...c, status: "decided" as const })) };
    for (const snap of [v2, decided])
      for (const rec of snap.channels) {
        const res = evaluate(snap, subject({ channel: rec.id, component: "image", value: goodImage(rec) }));
        expect(res.filter(blocks).map((r) => `${rec.id} ${r.ruleId}: ${r.message}`)).toEqual([]);
      }
  });

  it("image rules written in words need a judgement instead of failing (R166, R117, R133, R264, R240)", () => {
    const decided: RulesetSnapshot = { ...v2, conflicts: v2.conflicts.map((c) => ({ ...c, status: "decided" as const })) };
    const noon = evaluate(decided, subject({ component: "image", value: { "image.1.background": "#FFFFFF", "image.head_cut": "none" } }));
    for (const id of ["R166", "R117"]) expect(byId(noon, id), id).toMatchObject({ outcome: "needs_judge" });
    expect(byId(noon, "R166")!.message).toContain("written in words");
    const trendyol = evaluate(decided, subject({ channel: "trendyol", component: "image", value: { "image.1.background": "white" } }));
    expect(byId(trendyol, "R133")).toMatchObject({ outcome: "needs_judge" });
    const amazon = evaluate(decided, subject({ channel: "amazon", component: "image", value: { "image.head_cut": "none" } }));
    expect(byId(amazon, "R264")).toMatchObject({ outcome: "needs_judge" });
    const styli = evaluate(decided, subject({ channel: "styli", component: "image", value: { "image.head_cut": "none" } }));
    expect(byId(styli, "R240")).toMatchObject({ outcome: "needs_judge" });
  });

  it("canvas specs in equals rules are checked as within (R207, R209)", () => {
    const decided: RulesetSnapshot = { ...v2, conflicts: v2.conflicts.map((c) => ({ ...c, status: "decided" as const })) };
    const ok = evaluate(decided, subject({ channel: "trendyol", component: "image", value: { "image.canvas": { w: 1200, h: 1800 } } }));
    expect(byId(ok, "R207")).toMatchObject({ outcome: "pass" });
    const bad = evaluate(decided, subject({ channel: "trendyol", component: "image", value: { "image.canvas": { w: 1200, h: 1600 } } }));
    expect(byId(bad, "R207")).toMatchObject({ outcome: "fail", effectiveSeverity: "block", message: "Image canvas is 1200x1600; Trendyol needs exactly 1200x1800." });
    const styli = evaluate(decided, subject({ channel: "styli", component: "image", value: { "image.canvas": { w: 2342, h: 3123 } } }));
    expect(byId(styli, "R209")).toMatchObject({ outcome: "pass" });
  });

  it("R196 compares every key it names and needs a judgement when one was not measured (P3-2)", () => {
    const sized = evaluate(v2, subject({ channel: "trendyol", component: "image", value: { "image.resolution": { w: 1200, h: 1800 } } }));
    expect(byId(sized, "R196")).toMatchObject({ outcome: "needs_judge" });
    const full = evaluate(v2, subject({ channel: "trendyol", component: "image", value: { "image.resolution": { w: 1200, h: 1800, dpi: 96 } } }));
    expect(byId(full, "R196")).toMatchObject({ outcome: "pass" });
    const wrong = evaluate(v2, subject({ channel: "trendyol", component: "image", value: { "image.resolution": { w: 1200, h: 1800, dpi: 72 } } }));
    expect(byId(wrong, "R196")!.message).toContain('"dpi":96');
  });

  it("R028 names kinds of words, so it needs a judgement instead of passing (P2-1)", () => {
    const res = evaluate(v2, subject({ channel: "amazon", value: "Nike polo, better than Adidas, the best ever" }));
    expect(byId(res, "R028")).toMatchObject({ outcome: "needs_judge" });
    expect(routeToJudge(v2, subject({ channel: "amazon" }), res).map((r) => r.ruleId)).toContain("R028");
  });

  it("markup rules find HTML tags, not the word html (R045, R059)", () => {
    const bullets = evaluate(v2, subject({ channel: "amazon", component: "bullets", value: ["<b>Soft</b> cotton", "Easy care"] }));
    expect(byId(bullets, "R045")).toMatchObject({ outcome: "fail" });
    const plain = evaluate(v2, subject({ channel: "amazon", component: "description", value: "Soft cotton. Made for html lovers." }));
    expect(byId(plain, "R059")).toMatchObject({ outcome: "pass" });
  });

  it("sizes, barcodes and years are not phone numbers on R024 (P2-2)", () => {
    for (const text of ["Waist 28 30 32 34 Jeans", "Sizes UK 6 7 8 9 10", "EAN 8901234567890", "Shorts 2024 2025 Collection"]) {
      const res = evaluate(v2, subject({ value: text }));
      expect(byId(res, "R024"), text).toMatchObject({ outcome: "pass" });
    }
    for (const text of ["Polo, call 050 123 4567", "Polo +971501234567", "Polo 9876543210 WhatsApp", "Size 10 050 123 4567"]) {
      const res = evaluate(v2, subject({ value: text }));
      expect(byId(res, "R024"), text).toMatchObject({ outcome: "fail" });
    }
  });

  it("an unusable Noon description limit does not hide the usable fallback (P2-3)", () => {
    const res = evaluate(v2, subject({ component: "description", value: "Soft cotton. ".repeat(140) }));
    expect(byId(res, "R052")).toMatchObject({ outcome: "fail" });
    expect(byId(res, "R053")).toMatchObject({ outcome: "needs_judge" });
  });

  it("Arabic content shows each English text rule as not checked, never an empty list (P2-4, D30)", () => {
    const res = evaluate(v2, subject({ language: "ar", value: "\u0642\u0645\u064A\u0635 www.shop.com +971501234567" }));
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.outcome === "not_applicable")).toBe(true);
    expect(byId(res, "R024")!.message).toBe("Not checked: rule R024 has no Arabic version yet (M5-S6).");
    const image = evaluate(v2, subject({ language: "ar", component: "image", value: { "image.background.rgb_min": 200 } }));
    expect(byId(image, "R086")).toMatchObject({ outcome: "fail" });
  });
});
