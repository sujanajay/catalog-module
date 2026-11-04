// M5-S1 seed (M5-F1-R1 to R5, M5-F2-R1, R4): the channel rules dataset of 2026-11-02 becomes ruleset version 1 exactly
// as the dataset has it, with the channel registry from channels.ts; the gate-1 decisions (C02, C10, C27) become ruleset
// version 2. Written by the migrate job (apps/worker/src/migrate.ts) after the M2 taxonomy seed, "check then insert":
// a version already present is never rewritten, so running it twice adds nothing and changes nothing.
//
// The dataset file is a verbatim copy of .runs/2026-11-02-channel-rules.json (decision D12). Its category words map to
// M2 taxonomy node ids through CATEGORY_SCOPES (decision D9); the dataset's own word is kept in `datasetScope`.
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogChannelRecords, catalogRuleConflicts, catalogRuleDecisions, catalogRules, catalogRulesets, catalogTaxonomyNodes } from "../../db/schema";
import { CHANNEL_ORDER, CHANNELS } from "../channels";
import dataset from "./seed/channel-rules-2026-11-02.json";
import { openRulesetVersion, publishRulesetVersion, RulesError, rulesWriteTransaction } from "./store";
import {
  ALL_SCOPE,
  type ConflictSeverity,
  type EvidenceGrade,
  type RuleAudience,
  type RuleComponent,
  type RuleLanguage,
  type RuleMarket,
  type RuleSeverity,
} from "./types";

type RuleInsert = typeof catalogRules.$inferInsert;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const SEED_BY = "seed";

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

export interface DatasetRule {
  id: string;
  channel: string;
  market: string | null;
  category_scope: string | string[];
  component: string;
  rule: { field: string; operator: string; value: unknown; text?: string };
  severity: string;
  evidence: string;
  source: string;
  conflicts_with: string[];
  checkable: boolean;
  judge_method?: string;
}

export interface DatasetConflict {
  id: string;
  topic: string;
  rule_ids: string[];
  severity: string;
  options: string[];
  recommendation: string;
  reasoning: string;
}

export interface RulesDataset {
  rule_count: number;
  conflict_count: number;
  rules: DatasetRule[];
  conflicts: DatasetConflict[];
}

export const RULES_DATASET = dataset as unknown as RulesDataset;

/**
 * Dataset category words to M2 taxonomy node ids (M5-F1-R5, decision D9). Audience words (women_tops, adult_apparel)
 * map to the garment node plus an audience list, because M2 records audience as an attribute, not a node. "default" is
 * the apparel default of the shot specs, so it scopes to all apparel and a more specific node wins (M5-F1-R8).
 * "vendor" (Amazon vendor accounts) and "generic" (generic size labels) are not categories; they scope to all.
 */
export const CATEGORY_SCOPES: Record<string, { nodes: string[]; audience?: RuleAudience[] }> = {
  all: { nodes: [ALL_SCOPE] },
  vendor: { nodes: [ALL_SCOPE] },
  generic: { nodes: [ALL_SCOPE] },
  apparel: { nodes: ["fashion.apparel"] },
  default: { nodes: ["fashion.apparel"] },
  default_tops_knitwear_nightwear_sports_tops: { nodes: ["fashion.apparel"] },
  adult_apparel: { nodes: ["fashion.apparel"], audience: ["women", "men", "unisex"] },
  tops: { nodes: ["fashion.apparel.upper"] },
  women_tops: { nodes: ["fashion.apparel.upper"], audience: ["women"] },
  men_tops: { nodes: ["fashion.apparel.upper"], audience: ["men"] },
  unisex_tops: { nodes: ["fashion.apparel.upper"], audience: ["unisex"] },
  outerwear: { nodes: ["fashion.apparel.upper.jacket_coat"] },
  outerwear_jackets_coats: { nodes: ["fashion.apparel.upper.jacket_coat"] },
  sports_tops_incl_sports_bras: { nodes: ["fashion.apparel.upper.sports_top"] },
  activewear: { nodes: ["fashion.apparel.upper.sports_top", "fashion.apparel.lower.sports_bottom"] },
  dresses_jumpsuits: { nodes: ["fashion.apparel.full"] },
  bottoms: { nodes: ["fashion.apparel.lower"] },
  bottoms_sports_bottoms: { nodes: ["fashion.apparel.lower"] },
  denim: { nodes: ["fashion.apparel.lower.bottom"] },
  innerwear: { nodes: ["fashion.apparel.intimates_swim"] },
  lingerie_underwear: { nodes: ["fashion.apparel.intimates_swim.lingerie_underwear"] },
  bras: { nodes: ["fashion.apparel.intimates_swim.lingerie_underwear"] },
  swimwear: { nodes: ["fashion.apparel.intimates_swim.swimwear"] },
  kids: { nodes: ["fashion.apparel.kids"] },
  multipack: { nodes: ["fashion.apparel.multipack"] },
  footwear: { nodes: ["fashion.footwear"] },
  accessories: { nodes: ["fashion.accessories"] },
  curtains: { nodes: ["home.textile.curtains"] },
};

/** The node ids and audience of a dataset scope (a word or a list of words). Throws on a word with no mapping. */
export function mapCategoryScope(scope: string | string[]): { categoryScope: string[]; audience: RuleAudience[] | null } {
  const words = Array.isArray(scope) ? scope : [scope];
  const nodes = new Set<string>();
  const audience = new Set<RuleAudience>();
  let anyAudience = false;
  for (const word of words) {
    const mapped = CATEGORY_SCOPES[word];
    if (!mapped) throw new RulesError(`The dataset category "${word}" has no taxonomy node. Add it to CATEGORY_SCOPES.`);
    for (const n of mapped.nodes) nodes.add(n);
    if (mapped.audience) for (const a of mapped.audience) audience.add(a);
    else anyAudience = true;
  }
  const categoryScope = nodes.has(ALL_SCOPE) ? [ALL_SCOPE] : [...nodes];
  return { categoryScope, audience: anyAudience || audience.size === 0 ? null : [...audience] };
}

/** M5-F1-R2: text rules default to English; every other rule applies to any language. */
const TEXT_COMPONENTS: readonly string[] = ["title", "bullets", "description", "keywords"];

const V1_REASON = "Loaded from the channel rules dataset of 2026-11-02 (M5-F1-R1).";

/** One dataset rule as rule version 1 of ruleset version 1, every dataset field kept as it is (M5-F1-R2). */
export function ruleFromDataset(r: DatasetRule): RuleInsert {
  const { categoryScope, audience } = mapCategoryScope(r.category_scope);
  return {
    ruleId: r.id,
    version: 1,
    rulesetVersion: 1,
    channel: r.channel,
    market: r.market as RuleMarket | null,
    categoryScope,
    datasetScope: r.category_scope,
    audience,
    brandScope: "all",
    language: (TEXT_COMPONENTS.includes(r.component) ? "en" : "any") as RuleLanguage,
    component: r.component as RuleComponent,
    field: r.rule.field,
    operator: r.rule.operator,
    value: r.rule.value,
    text: r.rule.text ?? null,
    declaredSeverity: r.severity as RuleSeverity,
    evidence: r.evidence as EvidenceGrade,
    confirmedBy: null,
    source: r.source,
    conflictsWith: r.conflicts_with,
    checkable: r.checkable,
    judgeMethod: r.judge_method ?? null,
    status: "active",
    reason: V1_REASON,
    createdBy: SEED_BY,
  };
}

/** Fails the seed on duplicate ids or counts that disagree with the dataset header (M5-F1 edge cases). */
export function validateDataset(data: RulesDataset): void {
  const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const ruleDupes = dupes(data.rules.map((r) => r.id));
  if (ruleDupes.length) throw new RulesError(`Duplicate rule ids in the dataset: ${ruleDupes.join(", ")}.`);
  const conflictDupes = dupes(data.conflicts.map((c) => c.id));
  if (conflictDupes.length) throw new RulesError(`Duplicate conflict ids in the dataset: ${conflictDupes.join(", ")}.`);
  if (data.rules.length !== data.rule_count) throw new RulesError(`The dataset says ${data.rule_count} rules but holds ${data.rules.length}.`);
  if (data.conflicts.length !== data.conflict_count) throw new RulesError(`The dataset says ${data.conflict_count} conflicts but holds ${data.conflicts.length}.`);
  const ids = new Set(data.rules.map((r) => r.id));
  const unknown = data.conflicts.flatMap((c) => c.rule_ids.filter((id) => !ids.has(id)).map((id) => `${c.id}:${id}`));
  if (unknown.length) throw new RulesError(`Conflicts name rules the dataset does not have: ${unknown.join(", ")}.`);
}

// ---------------------------------------------------------------------------
// Ruleset version 2: the gate-1 decisions (M5-F1-R4, M5-F2-R4)
// ---------------------------------------------------------------------------

/** Gate 1 was decided by the owner on 2 Nov 2026 (noon India time, so the date reads the same in UTC and IST). */
const GATE1_AT = new Date("2026-11-02T06:30:00.000Z");
const GATE1_BY = "owner (gate 1)";

export interface Gate1Decision {
  id: string;
  conflictId: string;
  option: string;
  reason: string;
}

export const GATE1_DECISIONS: Gate1Decision[] = [
  {
    id: "gate1-C02",
    conflictId: "C02",
    option: "Noon 150 (block); Namshi 200 (block) and 150 (warn); Trendyol 100; Amazon 150 (1509 read as a typo); Myntra block above 90, warn above 60; the 60 minimum is a warn only where the channel maximum is 100 or more.",
    reason: "Gate 1 owner decision (M5-F1-R4).",
  },
  {
    id: "gate1-C10",
    conflictId: "C10",
    option: "Background grey at RGB 240 or more (default #F0F0F0) for every channel image; image 1 pure white #FFFFFF on Amazon.",
    reason: "Gate 1 owner decision (M5-F1-R4). Shein image 1 white is kept as an assumed rule, not confirmed (decision D2).",
  },
  {
    id: "gate1-C27",
    conflictId: "C27",
    option: "HSN check is format only: digits, 4 to 8 long; chapter 61 or 62 for apparel, 64 for footwear. The playbook HSN lists are retired.",
    reason: "Gate 1 owner decision (M5-F1-R4).",
  },
];

export const GREY_240 = "#F0F0F0";
/**
 * The canvas grey of ruleset version 1, the value the render used before gate 1 (dataset rule R227 v1). channels.ts now
 * holds GREY_240 (M3-S1), so version 1 keeps this value explicitly and stays what was live then (M3 decision D14).
 */
export const V1_GREY = "#E0E0E0";

type RuleEdit = { ruleId: string; patch: Partial<RuleInsert>; reason: string };

const confirm = (decision: string, ids: string[], reason: string): RuleEdit[] => ids.map((ruleId) => ({ ruleId, patch: { confirmedBy: decision }, reason }));
const setStatus = (status: "superseded" | "retired", ids: string[], reason: string): RuleEdit[] => ids.map((ruleId) => ({ ruleId, patch: { status }, reason }));

const C02 = "C02 decided at gate 1 (2 Nov 2026).";
const C10 = "C10 decided at gate 1 (2 Nov 2026): grey RGB 240 or more for every channel image, Amazon image 1 white.";
const C27 = "C27 decided at gate 1 (2 Nov 2026): HSN check is format only.";
/** Owner decision (Sujan, 2026-11-04, "Warn only"): the HSN format and chapter checks warn, they never block. */
const HSN_WARN_ONLY = "Owner decision 2026-11-04: warn only.";

/** Edits to existing rules in ruleset version 2. Rules of the three conflicts not listed here keep version 1. */
export const GATE1_RULE_EDITS: RuleEdit[] = [
  ...confirm("gate1-C02", ["R013", "R014", "R016", "R017", "R019"], C02),
  { ruleId: "R015", patch: { declaredSeverity: "warn", confirmedBy: "gate1-C02" }, reason: `${C02} Namshi 150 is a warning; 200 blocks.` },
  { ruleId: "R020", patch: { declaredSeverity: "warn", confirmedBy: "gate1-C02" }, reason: `${C02} Myntra warns above 60 and blocks above 90.` },
  ...setStatus("superseded", ["R018"], `${C02} Amazon "1509" is read as a typo of 150 (R017).`),
  // Manager decision D19: R011 stays the fallback for every channel without its own title length rule (Styli,
  // Centrepoint, 6th Street, VogaCloset, Shein), so no channel loses a check; a channel rule wins where one exists.
  {
    ruleId: "R011",
    patch: {},
    reason: `${C02} Kept as the fallback for channels with no title length rule of their own; R556 to R559 and the channel maximums win where they exist (decision D19).`,
  },
  ...confirm("gate1-C10", ["R086", "R117", "R125", "R133", "R149", "R166", "R228"], C10),
  {
    ruleId: "R227",
    patch: { value: GREY_240, text: "Canvas colour for every channel image: light grey #F0F0F0 (RGB 240 or more); image 1 on Amazon is #FFFFFF", confirmedBy: "gate1-C10" },
    reason: `${C10} #E0E0E0 (224) fails the 240 rule.`,
  },
  ...setStatus("superseded", ["R154", "R155"], `${C10} Image 1 on Namshi and Trendyol is the light grey, not white.`),
  // R527 is the dataset's own format check (digits, 4 to 8 long); R535 is a playbook HSN range outside the conflict list.
  { ruleId: "R527", patch: { declaredSeverity: "warn", confirmedBy: "gate1-C27" }, reason: `${C27} ${HSN_WARN_ONLY}` },
  ...setStatus("retired", ["R528", "R529", "R530", "R531", "R532", "R533", "R534", "R535"], `${C27} Finance has not supplied a table.`),
];

const newRule = (r: Omit<RuleInsert, "version" | "rulesetVersion" | "createdBy" | "brandScope" | "datasetScope" | "audience" | "conflictsWith" | "judgeMethod" | "status" | "market"> & Partial<RuleInsert>): RuleInsert => ({
  version: 1,
  rulesetVersion: 2,
  createdBy: SEED_BY,
  brandScope: "all",
  datasetScope: null,
  audience: null,
  conflictsWith: [],
  judgeMethod: null,
  status: "active",
  market: null,
  ...r,
});

const titleMin = (ruleId: string, channel: string) =>
  newRule({
    ruleId,
    channel,
    categoryScope: [ALL_SCOPE],
    language: "en",
    component: "title",
    field: "title.length",
    operator: "gte",
    value: 60,
    text: "Title at least 60 characters (only where the channel maximum is 100 or more)",
    declaredSeverity: "warn",
    evidence: "playbook",
    confirmedBy: "gate1-C02",
    source: "R011; decision gate1-C02",
    checkable: true,
    reason: `${C02} The 60 minimum warns only where the channel maximum is 100 or more; on this channel it wins over the fallback R011.`,
  });

const hsn = (ruleId: string, categoryScope: string[], pattern: string, text: string) =>
  newRule({
    ruleId,
    channel: "all",
    categoryScope,
    language: "any",
    component: "attributes",
    field: "hsn.code",
    operator: "matches_regex",
    value: pattern,
    text,
    declaredSeverity: "warn",
    evidence: "assumed",
    confirmedBy: "gate1-C27",
    source: "decision gate1-C27",
    checkable: true,
    reason: `${C27} The chapter part of the format check; replaces the playbook HSN lists. ${HSN_WARN_ONLY}`,
  });

/**
 * New rules in ruleset version 2. Ids continue after the dataset's last id (R555). Shein image 1 white needs no new rule:
 * the dataset's R229 already holds it as an assumed, unconfirmed rule (decision D2), and it stays at version 1.
 */
export const GATE1_NEW_RULES: RuleInsert[] = [
  titleMin("R556", "noon"),
  titleMin("R557", "namshi"),
  titleMin("R558", "trendyol"),
  titleMin("R559", "amazon"),
  hsn("R560", ["fashion.apparel"], "^6[12]", "HSN code for apparel starts with chapter 61 or 62"),
  hsn("R561", ["fashion.footwear"], "^64", "HSN code for footwear starts with chapter 64"),
];

const V2_CHANNEL_REASON = `${C10} Background ${GREY_240}.`;

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

export interface SeedChannelRulesResult {
  /** Ruleset versions this run added (empty on a re-run). */
  versionsAdded: number[];
  rulesAdded: number;
  conflictsAdded: number;
  channelsAdded: number;
}

async function assertScopesExist(tx: Tx, rules: RuleInsert[]): Promise<void> {
  const wanted = [...new Set(rules.flatMap((r) => r.categoryScope).filter((n) => n !== ALL_SCOPE))];
  const found = new Set((await tx.select({ id: catalogTaxonomyNodes.id }).from(catalogTaxonomyNodes).where(inArray(catalogTaxonomyNodes.id, wanted))).map((r) => r.id));
  const missing = wanted.filter((n) => !found.has(n));
  if (missing.length) throw new RulesError(`Rules scope taxonomy nodes that do not exist (seed the M2 taxonomy first): ${missing.join(", ")}.`);
}

async function seedVersion1(tx: Tx, data: RulesDataset): Promise<Omit<SeedChannelRulesResult, "versionsAdded">> {
  const rules = data.rules.map(ruleFromDataset);
  await assertScopesExist(tx, rules);
  await openRulesetVersion(tx, { version: 1, reason: "The channel rules dataset of 2026-11-02 as data (M5-F1-R1).", changedRuleIds: rules.map((r) => r.ruleId), by: SEED_BY });
  await tx.insert(catalogRules).values(rules);
  await tx.insert(catalogRuleConflicts).values(
    data.conflicts.map((c) => ({
      id: c.id,
      topic: c.topic,
      severity: c.severity as ConflictSeverity,
      ruleIds: c.rule_ids,
      options: c.options,
      recommendation: c.recommendation,
      reasoning: c.reasoning,
      status: "open" as const,
    })),
  );
  await tx.insert(catalogChannelRecords).values(
    CHANNEL_ORDER.map((id) => {
      const spec = CHANNELS[id];
      return {
        channelId: id,
        version: 1,
        rulesetVersion: 1,
        label: spec.label,
        group: spec.group,
        minCanvas: spec.minCanvas,
        targetCanvas: spec.targetCanvas,
        margins: spec.margins,
        anchor: spec.anchor,
        background: V1_GREY,
        firstImageBackground: spec.firstImageBackground ?? null,
        dpi: spec.dpi,
        fixedCanvas: spec.fixedCanvas,
        uniformScaleDefault: spec.uniformScaleDefault,
        sheetText: spec.sheetText,
        notes: spec.notes ?? null,
        status: "active" as const,
        reason: "Seeded from channels.ts with the same numbers (M5-F1-R3); background the earlier #E0E0E0.",
        createdBy: SEED_BY,
      };
    }),
  );
  await publishRulesetVersion(tx, 1, SEED_BY);
  return { rulesAdded: rules.length, conflictsAdded: data.conflicts.length, channelsAdded: CHANNEL_ORDER.length };
}

async function seedVersion2(tx: Tx): Promise<number> {
  const changed = [...GATE1_RULE_EDITS.map((e) => e.ruleId), ...GATE1_NEW_RULES.map((r) => r.ruleId)];
  await assertScopesExist(tx, GATE1_NEW_RULES);
  await openRulesetVersion(tx, { version: 2, reason: "Gate-1 decisions C02, C10 and C27 (M5-F1-R4).", changedRuleIds: changed, by: SEED_BY });

  const current = await tx.select().from(catalogRules).where(inArray(catalogRules.ruleId, GATE1_RULE_EDITS.map((e) => e.ruleId)));
  const latest = new Map<string, (typeof current)[number]>();
  for (const row of current) if ((latest.get(row.ruleId)?.version ?? 0) < row.version) latest.set(row.ruleId, row);
  const edited: RuleInsert[] = GATE1_RULE_EDITS.map((edit) => {
    const row = latest.get(edit.ruleId);
    if (!row) throw new RulesError(`Gate-1 edit names rule ${edit.ruleId}, which is not loaded.`);
    const { createdAt: _createdAt, ...rest } = row;
    return { ...rest, ...edit.patch, version: row.version + 1, rulesetVersion: 2, reason: edit.reason, createdBy: SEED_BY };
  });
  await tx.insert(catalogRules).values([...edited, ...GATE1_NEW_RULES]);

  await tx.insert(catalogRuleDecisions).values(
    GATE1_DECISIONS.map((d) => ({ id: d.id, conflictId: d.conflictId, option: d.option, reason: d.reason, decidedBy: GATE1_BY, decidedAt: GATE1_AT, rulesetVersion: 2 })),
  );
  for (const d of GATE1_DECISIONS) {
    await tx.update(catalogRuleConflicts).set({ status: "decided", decisionId: d.id }).where(eq(catalogRuleConflicts.id, d.conflictId));
  }

  const channels = await tx.select().from(catalogChannelRecords).where(eq(catalogChannelRecords.rulesetVersion, 1));
  await tx.insert(catalogChannelRecords).values(
    channels.map(({ createdAt: _createdAt, ...row }) => ({ ...row, version: row.version + 1, rulesetVersion: 2, background: GREY_240, reason: V2_CHANNEL_REASON, createdBy: SEED_BY })),
  );
  await publishRulesetVersion(tx, 2, SEED_BY);
  return edited.length + GATE1_NEW_RULES.length;
}

/** Check then insert: adds ruleset version 1 and version 2 when they are missing; a present version is left alone. */
export async function seedChannelRules(db: Db, data: RulesDataset = RULES_DATASET): Promise<SeedChannelRulesResult> {
  validateDataset(data);
  return rulesWriteTransaction(db, async (tx) => {
    const present = new Set((await tx.select({ version: catalogRulesets.version }).from(catalogRulesets)).map((r) => r.version));
    const result: SeedChannelRulesResult = { versionsAdded: [], rulesAdded: 0, conflictsAdded: 0, channelsAdded: 0 };
    if (!present.has(1)) {
      const v1 = await seedVersion1(tx, data);
      result.versionsAdded.push(1);
      result.rulesAdded += v1.rulesAdded;
      result.conflictsAdded += v1.conflictsAdded;
      result.channelsAdded += v1.channelsAdded;
    }
    if (!present.has(2)) {
      result.rulesAdded += await seedVersion2(tx);
      result.versionsAdded.push(2);
    }
    return result;
  });
}
