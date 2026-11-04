// Tier 2 (PGlite): the M5-S1 rules store and seed. The first test is the slice's acceptance test (R1-build section 7,
// M5-F1 test 1): seed twice on an empty database gives 555 rules and 30 conflicts, version 1 and version 2, with no
// duplicates; the parity test proves the channel registry of version 1 equals today's channels.ts constants.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_NODES, seedTaxonomy } from "../../analyze/taxonomy-seed";
import type { Db } from "../../db/client";
import { catalogContentVersions, catalogRuleResults } from "../../db/schema";
import { createTestDb } from "../../db/testing";
import { CHANNEL_ORDER, CHANNELS } from "../channels";
import { CHANNEL_IDS } from "../types";
import { RULES_EXPORT_TABLES } from "./export";
import {
  CATEGORY_SCOPES,
  GATE1_NEW_RULES,
  GATE1_RULE_EDITS,
  GREY_240,
  V1_GREY,
  mapCategoryScope,
  RULES_DATASET,
  seedChannelRules,
  validateDataset,
} from "./seed";
import { buildSnapshotContent, channelSpecOf, loadSnapshot, RulesError, rulesWriteTransaction, snapshotHash } from "./store";
import type { Rule, RulesetSnapshot } from "./types";

let db: Db;
let close: () => Promise<void>;
let v1: RulesetSnapshot;
let v2: RulesetSnapshot;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

const counts = async () =>
  (
    await rows<Record<string, number>>(sql`select
      (select count(*)::int from catalog_rules) as rules,
      (select count(distinct rule_id)::int from catalog_rules) as rule_ids,
      (select count(*)::int from catalog_rule_conflicts) as conflicts,
      (select count(*)::int from catalog_rule_decisions) as decisions,
      (select count(*)::int from catalog_channel_records) as channels,
      (select count(*)::int from catalog_rulesets) as rulesets,
      (select count(*)::int from catalog_ruleset_snapshots) as snapshots`)
  )[0]!;

const rule = (snap: RulesetSnapshot, id: string): Rule => {
  const r = snap.rules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id} in v${snap.version}`);
  return r;
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedTaxonomy(db);
});

afterAll(async () => {
  await close();
});

describe("acceptance: seed twice gives 555 rules, 30 conflicts, version 1 and version 2", () => {
  it("loads the dataset as v1 and the gate-1 decisions as v2, and a second run adds and changes nothing", async () => {
    const first = await seedChannelRules(db);
    expect(first.versionsAdded).toEqual([1, 2]);
    expect(first.conflictsAdded).toBe(30);
    expect(first.channelsAdded).toBe(9);

    const after = await counts();
    // 555 dataset rules at version 1, plus v2 versions of the edited rules and the new gate-1 rules.
    expect(after.rule_ids).toBe(555 + GATE1_NEW_RULES.length);
    expect(after.rules).toBe(555 + GATE1_RULE_EDITS.length + GATE1_NEW_RULES.length);
    expect(after).toMatchObject({ conflicts: 30, decisions: 3, channels: 18, rulesets: 2, snapshots: 2 });

    const second = await seedChannelRules(db);
    expect(second).toEqual({ versionsAdded: [], rulesAdded: 0, conflictsAdded: 0, channelsAdded: 0 });
    expect(await counts()).toEqual(after);

    v1 = (await loadSnapshot(db, 1))!;
    v2 = (await loadSnapshot(db, 2))!;
    expect((await loadSnapshot(db))!.version).toBe(2);
    expect(v1.rules).toHaveLength(555);
    expect(new Set(v1.rules.map((r) => r.id)).size).toBe(555);
    expect(v1.conflicts).toHaveLength(30);
    expect(v2.conflicts).toHaveLength(30);
    expect(await rows(sql`select version, status from catalog_rulesets order by version`)).toEqual([
      { version: 1, status: "published" },
      { version: 2, status: "published" },
    ]);
  });

  it("parity: the v1 channel registry equals the channels.ts constants with the earlier grey, in the same order", () => {
    expect(v1.channels.map((c) => c.id).sort()).toEqual([...CHANNEL_IDS].sort());
    for (const id of CHANNEL_ORDER) {
      const record = v1.channels.find((c) => c.id === id)!;
      expect(channelSpecOf(record)).toEqual({ ...CHANNELS[id], background: V1_GREY });
      expect(record).toMatchObject({ version: 1, rulesetVersion: 1, status: "active", markets: [], languages: [], pushMethod: null, fileKind: null, owner: null });
    }
  });
});

describe("version 1 is the dataset as it is (M5-F1-R2)", () => {
  it("keeps every dataset field of every rule, with the defaults for the new fields", () => {
    for (const d of RULES_DATASET.rules) {
      const r = rule(v1, d.id);
      expect(r).toMatchObject({
        version: 1,
        rulesetVersion: 1,
        channel: d.channel,
        market: d.market,
        datasetScope: d.category_scope,
        component: d.component,
        field: d.rule.field,
        operator: d.rule.operator,
        value: d.rule.value,
        text: d.rule.text ?? null,
        declaredSeverity: d.severity,
        evidence: d.evidence,
        source: d.source,
        conflictsWith: d.conflicts_with,
        checkable: d.checkable,
        judgeMethod: d.judge_method ?? null,
        brandScope: "all",
        status: "active",
        confirmedBy: null,
      });
      expect(r.language).toBe(["title", "bullets", "description", "keywords"].includes(d.component) ? "en" : "any");
      expect(r.categoryScope).toEqual(mapCategoryScope(d.category_scope).categoryScope);
    }
  });

  it("loads every conflict with its topic, severity, rules, options, recommendation and reasoning, all open (M5-F2-R1)", () => {
    for (const d of RULES_DATASET.conflicts) {
      expect(v1.conflicts.find((c) => c.id === d.id)).toEqual({
        id: d.id,
        topic: d.topic,
        severity: d.severity,
        ruleIds: d.rule_ids,
        options: d.options,
        recommendation: d.recommendation,
        reasoning: d.reasoning,
        status: "open",
        decision: null,
      });
    }
  });

  it("freezes the M2 taxonomy in the snapshot, and the hash depends only on content", async () => {
    expect(v1.categories.map((c) => c.id)).toContain("fashion.apparel.upper.top");
    const { hash, publishedAt: _publishedAt, ...content } = v1;
    expect(snapshotHash(content)).toBe(hash);
    // Rebuilt today, v1 is still the same content: later versions never change an earlier one (apart from the
    // decision state, which the snapshot records only for decisions published at or before it).
    const rebuilt = await rulesWriteTransaction(db, (tx) => buildSnapshotContent(tx, 1));
    expect(rebuilt).toEqual(content);
  });
});

describe("version 2 applies the gate-1 decisions (M5-F1-R4, M5-F2-R4)", () => {
  it("C02: per-channel title lengths, confirmed; Namshi 150 and Myntra 60 warn; the 1509 typo goes", () => {
    for (const id of ["R013", "R014", "R016", "R017", "R019"]) expect(rule(v2, id)).toMatchObject({ version: 2, declaredSeverity: "block", confirmedBy: "gate1-C02", status: "active" });
    expect(rule(v2, "R013").value).toBe(150);
    expect(rule(v2, "R014").value).toBe(200);
    expect(rule(v2, "R016").value).toBe(100);
    expect(rule(v2, "R017").value).toBe(150);
    expect(rule(v2, "R015")).toMatchObject({ value: 150, declaredSeverity: "warn", confirmedBy: "gate1-C02" });
    expect(rule(v2, "R020")).toMatchObject({ value: 60, declaredSeverity: "warn", confirmedBy: "gate1-C02" });
    expect(rule(v2, "R018").status).toBe("superseded");
    const minimums = v2.rules.filter((r) => r.field === "title.length" && r.operator === "gte" && r.status === "active");
    expect(minimums.map((r) => r.channel).sort()).toEqual(["amazon", "namshi", "noon", "trendyol"]);
    for (const r of minimums) expect(r).toMatchObject({ value: 60, declaredSeverity: "warn", confirmedBy: "gate1-C02" });
    // Version 1 is untouched.
    expect(rule(v1, "R015")).toMatchObject({ declaredSeverity: "block", confirmedBy: null });
  });

  it("C02: R011 (60 to 200, warn) stays the fallback, so no channel loses its title length check (decision D19)", () => {
    expect(rule(v2, "R011")).toMatchObject({ version: 2, channel: "all", operator: "between", value: [60, 200], declaredSeverity: "warn", status: "active" });
    expect(rule(v2, "R011").reason).toMatch(/fallback/);
    const lengthRules = (channel: string) =>
      v2.rules.filter((r) => r.field === "title.length" && r.status === "active" && r.channel === channel).map((r) => r.id);
    // Channels with no title rule of their own are checked by R011 alone.
    for (const id of ["styli", "centrepoint", "sixthstreet", "vogacloset", "shein"]) expect(lengthRules(id)).toEqual([]);
    expect(lengthRules("all")).toContain("R011");
    // The four channels with a maximum of 100 or more have their own minimum, which wins over R011 (M5-F1-R8).
    for (const id of ["noon", "namshi", "trendyol", "amazon"]) {
      expect(v2.rules.some((r) => r.channel === id && r.field === "title.length" && r.operator === "gte" && r.status === "active")).toBe(true);
    }
  });

  it("C10: grey #F0F0F0 (240) on every channel, Amazon image 1 white confirmed, Shein image 1 white kept as an unconfirmed assumed rule", () => {
    expect(rule(v1, "R227").value).toBe("#E0E0E0");
    expect(rule(v2, "R227")).toMatchObject({ value: GREY_240, confirmedBy: "gate1-C10", status: "active" });
    expect(rule(v2, "R086")).toMatchObject({ value: 240, confirmedBy: "gate1-C10" });
    expect(rule(v2, "R228")).toMatchObject({ value: "#FFFFFF", channel: "amazon", confirmedBy: "gate1-C10" });
    expect(rule(v2, "R154").status).toBe("superseded");
    expect(rule(v2, "R155").status).toBe("superseded");
    // Shein image 1 white is the dataset's own R229, kept as it is (assumed, unconfirmed); no second rule for it.
    const shein = v2.rules.filter((r) => r.channel === "shein" && r.field === "image.1.background_hex" && r.status === "active");
    expect(shein.map((r) => r.id)).toEqual(["R229"]);
    expect(rule(v2, "R229")).toEqual(rule(v1, "R229"));
    expect(rule(v2, "R229")).toMatchObject({ value: "#FFFFFF", evidence: "assumed", confirmedBy: null, version: 1 });

    for (const c of v1.channels) expect(c.background).toBe("#E0E0E0");
    for (const c of v2.channels) {
      expect(c).toMatchObject({ version: 2, rulesetVersion: 2, background: GREY_240 });
      const rgb = [1, 3, 5].map((i) => parseInt(c.background.slice(i, i + 2), 16));
      for (const v of rgb) expect(v).toBeGreaterThanOrEqual(240);
      expect(c.firstImageBackground).toBe(CHANNELS[c.id as keyof typeof CHANNELS].firstImageBackground ?? null);
    }
    expect(v2.channels.find((c) => c.id === "amazon")!.firstImageBackground).toBe("#FFFFFF");
  });

  it("C27: HSN lists retired with the reason, a format-only check takes their place, warn only (owner 2026-11-04)", () => {
    for (const id of ["R528", "R529", "R530", "R531", "R532", "R533", "R534", "R535"]) {
      expect(rule(v2, id).status).toBe("retired");
      expect(rule(v2, id).reason).toMatch(/Finance has not supplied a table/);
    }
    const format = v2.rules.filter((r) => r.field === "hsn.code" && r.status === "active");
    expect(format.map((r) => [r.id, r.categoryScope, r.operator, r.value, r.declaredSeverity, r.confirmedBy])).toEqual([
      ["R527", ["all"], "matches_regex", "^\\d{4,8}$", "warn", "gate1-C27"],
      ["R560", ["fashion.apparel"], "matches_regex", "^6[12]", "warn", "gate1-C27"],
      ["R561", ["fashion.footwear"], "matches_regex", "^64", "warn", "gate1-C27"],
    ]);
    for (const r of format) expect(r.reason).toMatch(/Owner decision 2026-11-04: warn only/);
    const [digits, apparel, footwear] = format.map((r) => new RegExp(String(r.value)));
    expect(digits!.test("61091000")).toBe(true);
    expect(digits!.test("61A9")).toBe(false);
    expect(apparel!.test("6109")).toBe(true);
    expect(apparel!.test("6403")).toBe(false);
    expect(footwear!.test("6403")).toBe(true);
  });

  it("records C02, C10 and C27 as decided by the owner on 2 Nov 2026; the rest stay open (27 open, 11 high)", () => {
    const decided = v2.conflicts.filter((c) => c.status === "decided");
    expect(decided.map((c) => c.id)).toEqual(["C02", "C10", "C27"]);
    for (const c of decided) {
      expect(c.decision).toMatchObject({ id: `gate1-${c.id}`, decidedBy: "owner (gate 1)", rulesetVersion: 2 });
      expect(c.decision!.decidedAt.slice(0, 10)).toBe("2026-11-02");
    }
    const open = v2.conflicts.filter((c) => c.status === "open");
    expect(open).toHaveLength(27);
    expect(open.filter((c) => c.severity === "high")).toHaveLength(11);
    expect(v1.conflicts.filter((c) => c.status === "open")).toHaveLength(30);
  });

  it("every edit carries a reason and keeps the history: v1 rows stay, v2 rows are new versions", async () => {
    const history = await rows<{ rule_id: string; version: number; ruleset_version: number }>(
      sql`select rule_id, version, ruleset_version from catalog_rules where rule_id = 'R227' order by version`,
    );
    expect(history).toEqual([
      { rule_id: "R227", version: 1, ruleset_version: 1 },
      { rule_id: "R227", version: 2, ruleset_version: 2 },
    ]);
    for (const r of v2.rules) expect(r.reason.trim()).not.toBe("");
  });
});

describe("category scopes are M2 taxonomy node ids (M5-F1-R5, decision D9)", () => {
  it("maps every dataset scope word to nodes the M2 seed has", () => {
    const seeded = new Set(SEED_NODES.map((n) => n.id));
    for (const { nodes } of Object.values(CATEGORY_SCOPES)) for (const n of nodes) if (n !== "all") expect(seeded.has(n)).toBe(true);
    for (const r of RULES_DATASET.rules) expect(() => mapCategoryScope(r.category_scope)).not.toThrow();
  });

  it("keeps audience apart from the node and merges lists", () => {
    expect(mapCategoryScope("women_tops")).toEqual({ categoryScope: ["fashion.apparel.upper"], audience: ["women"] });
    expect(mapCategoryScope("adult_apparel")).toEqual({ categoryScope: ["fashion.apparel"], audience: ["women", "men", "unisex"] });
    expect(mapCategoryScope(["kids", "multipack"])).toEqual({ categoryScope: ["fashion.apparel.kids", "fashion.apparel.multipack"], audience: null });
    expect(mapCategoryScope(["tops", "all"])).toEqual({ categoryScope: ["all"], audience: null });
    expect(() => mapCategoryScope("garden_furniture")).toThrow(RulesError);
  });
});

describe("the seed refuses bad input", () => {
  it("fails on duplicate rule ids, naming them", () => {
    const first = RULES_DATASET.rules[0]!;
    const bad = { ...RULES_DATASET, rule_count: 556, rules: [...RULES_DATASET.rules, { ...first }] };
    expect(() => validateDataset(bad)).toThrow(/Duplicate rule ids in the dataset: R001/);
  });

  it("a conflict cannot point at a decision that does not exist", async () => {
    const insert = sql`insert into catalog_rule_conflicts (id, topic, severity, rule_ids, options, recommendation, reasoning, status, decision_id)
      values ('C99', 't', 'low', '[]', '[]', 'r', 'r', 'decided', 'no-such-decision')`;
    await expect(db.execute(insert)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/catalog_rule_conflicts_decision_id/) }) });
  });

  it("fails without the M2 taxonomy and writes nothing", async () => {
    const fresh = await createTestDb();
    try {
      await expect(seedChannelRules(fresh.db)).rejects.toThrow(/seed the M2 taxonomy first/);
      const [n] = ((await fresh.db.execute(sql`select count(*)::int as n from catalog_rulesets`)) as unknown as { rows: { n: number }[] }).rows;
      expect(n!.n).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});

describe("BigQuery export rows (M5 3.3, decision D13)", () => {
  const read = (table: string) => RULES_EXPORT_TABLES.find((t) => t.table === table)!;

  /** Every row of a table, page after page, each page starting after the previous page's cursor (keyset paging). */
  const readAll = async (table: string, limit: number) => {
    const all: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const page = await read(table).read(db, { after, limit });
      all.push(...page.rows);
      if (page.next === null) return { rows: all, pages: pages + 1 };
      after = page.next;
    }
    throw new Error("export paging did not end");
  };

  it("exports every rule version and every conflict with its decision, in keyset pages", async () => {
    const first = await read("rules").read(db, { after: null, limit: 500 });
    expect(first.rows).toHaveLength(500);
    expect(first.next).not.toBeNull();
    const rules = await readAll("rules", 200);
    expect(rules.rows).toHaveLength((await counts()).rules!);
    expect(new Set(rules.rows.map((r) => `${String(r.rule_id)}/${String(r.version)}`)).size).toBe(rules.rows.length);
    for (const row of first.rows.slice(0, 5)) for (const field of read("rules").schema) if (field.mode === "REQUIRED") expect(row[field.name]).not.toBeNull();
    const conflicts = (await readAll("conflicts", 7)).rows;
    expect(conflicts).toHaveLength(30);
    expect(conflicts.find((c) => c.conflict_id === "C10")).toMatchObject({ status: "decided", decision_id: "gate1-C10", decided_by: "owner (gate 1)" });
    expect(Object.keys(conflicts[0]!).sort()).toEqual(read("conflicts").schema.map((f) => f.name).sort());
  });

  it("exports rule results of real content only and keeps one row per check", async () => {
    const version = (isTest: boolean, hash: string) => ({
      scope: "noon" as const,
      component: "title" as const,
      source: "brand" as const,
      aiGenerated: false,
      producer: "M5",
      textValue: "Title",
      contentHash: hash,
      isTest,
      createdBy: "test",
    });
    const [real] = await db.insert(catalogContentVersions).values(version(false, "real")).returning();
    const [test] = await db.insert(catalogContentVersions).values(version(true, "test")).returning();
    const result = (contentVersionId: string) => ({
      contentVersionId,
      rulesetVersion: 2,
      channel: "noon",
      ruleId: "R013",
      ruleVersion: 2,
      outcome: "fail" as const,
      effectiveSeverity: "block" as const,
      measured: 163,
      message: "Title has 163 characters; Noon allows 150.",
    });
    await db.insert(catalogRuleResults).values([result(real!.id), result(test!.id)]);
    await db.insert(catalogRuleResults).values(result(real!.id)).onConflictDoNothing();
    const exported = (await readAll("rule_results", 100)).rows;
    expect(exported).toEqual([expect.objectContaining({ content_version_id: real!.id, rule_id: "R013", measured: "163", outcome: "fail" })]);
  });
});
