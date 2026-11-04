// evaluate(snapshot, subject): one RuleResult per applicable rule (M5-F4-R1). Pure: no database, network, clock or
// model. Steps: pick the rules that apply to the subject (status, component, channel, brand, language, market,
// category, audience), keep the most specific limit of each field (M5-F1-R8, decision D22), measure the field from the
// subject (graphemes for text, bytes only for byte fields, M5-F4-R7), run the operator (operators.ts), work out the
// effective severity (M5-F4-R2) and write a plain message with the numbers (M5-F4-R6). A check that throws becomes
// needs_judge, so one odd value never stops a batch.
import { fmt, OPERATORS, type Check } from "./operators";
import { byteCount, charCount, keywordTerms, sentenceCount } from "./text";
import { ALL_SCOPE, type ChannelRecord, type ConflictRecord, type Rule, type RuleOutcome, type RuleResult, type RuleSeverity, type RulesetSnapshot, type Subject } from "./types";

// ---------------------------------------------------------------------------
// Effective severity (M5-F4-R2)
// ---------------------------------------------------------------------------

export interface EffectiveSeverity {
  severity: RuleSeverity;
  /** True for a `checkable: false` rule: its outcome is needs_judge and M7 or a person decides (D5). */
  judge: boolean;
  /** Why the severity is lower than declared, added to a failing result's message. */
  note: string | null;
}

/** The open conflicts that name the rule. */
export function openConflictsOf(rule: Rule, conflicts: ConflictRecord[]): string[] {
  return conflicts.filter((c) => c.status === "open" && c.ruleIds.includes(rule.id)).map((c) => c.id);
}

export function effectiveSeverity(rule: Rule, conflicts: ConflictRecord[]): EffectiveSeverity {
  const judge = !rule.checkable;
  const open = openConflictsOf(rule, conflicts);
  if (open.length) {
    const which = open.length === 1 ? `conflict ${open[0]} is` : `conflicts ${open.join(", ")} are`;
    return { severity: "warn", judge, note: `Warn only while ${which} open.` };
  }
  if (judge) return { severity: "warn", judge, note: null };
  if (rule.declaredSeverity === "block") {
    if (rule.evidence === "documented" || rule.evidence === "reported" || rule.confirmedBy) return { severity: "block", judge, note: null };
    return { severity: "warn", judge, note: `Warn only until a channel confirms it (source: ${rule.evidence}).` };
  }
  return { severity: rule.declaredSeverity, judge, note: null };
}

/** What a block means to the caller (M5-F4-R3): this content version is not offered on this channel. */
export function blocks(result: RuleResult): boolean {
  return result.outcome === "fail" && result.effectiveSeverity === "block";
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

type Scope = { kind: "applies"; rank: number[] } | { kind: "unknown"; message: string } | { kind: "skip" };

const LANGUAGE_NAMES: Record<string, string> = { ar: "Arabic", en: "English" };

const GCC_MARKETS = new Set(["GCC", "AE", "SA", "KW", "QA", "BH", "OM"]);

function marketMatches(ruleMarket: string, subjectMarket: string): boolean {
  const r = ruleMarket.toUpperCase();
  const s = subjectMarket.toUpperCase();
  return r === s || (r === "GCC" && GCC_MARKETS.has(s));
}

/** A dotted M2 node id and all its parents: "fashion.apparel.upper" gives fashion, fashion.apparel and itself. */
function withParents(ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const parts = id.split(".");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return out;
}

/** The node under which the subject's category is unknown: "" for no category at all, else the parent of `unknown`. */
function unknownUnder(path: string[]): string | null {
  const leaf = path.at(-1);
  if (leaf === undefined) return "";
  const parts = leaf.split(".");
  return parts.at(-1) === "unknown" ? parts.slice(0, -1).join(".") : null;
}

interface SubjectScope {
  nodes: Set<string>;
  unknownUnder: string | null;
}

function scopeOf(rule: Rule, s: Subject, ss: SubjectScope): Scope {
  if (rule.status !== "active" || rule.component !== s.component) return { kind: "skip" };
  if (rule.channel !== "all" && rule.channel !== s.channel) return { kind: "skip" };
  if (rule.brandScope !== ALL_SCOPE && rule.brandScope !== s.brandId) return { kind: "skip" };
  if (rule.market && s.market && !marketMatches(rule.market, s.market)) return { kind: "skip" };
  if (rule.audience && s.audience && !rule.audience.includes(s.audience)) return { kind: "skip" };

  let depth = 0;
  if (!rule.categoryScope.includes(ALL_SCOPE)) {
    const hits = rule.categoryScope.filter((n) => ss.nodes.has(n));
    if (hits.length) depth = Math.max(...hits.map((n) => n.split(".").length));
    else {
      const under = ss.unknownUnder;
      const couldApply = under !== null && rule.categoryScope.some((n) => under === "" || n.startsWith(`${under}.`));
      if (!couldApply) return { kind: "skip" };
      return { kind: "unknown", message: `Category unknown: rule ${rule.id} applies to some categories only.` };
    }
  }
  if (rule.language !== "any" && rule.language !== s.language) {
    // English rules are the base set; until M5-S6 adds Arabic rules, Arabic content shows each English rule as not
    // checked instead of an empty list that reads as "all clear" (D30).
    if (rule.language !== "en") return { kind: "skip" };
    return { kind: "unknown", message: `Not checked: rule ${rule.id} has no ${LANGUAGE_NAMES[s.language] ?? s.language} version yet (M5-S6).` };
  }
  if (rule.market && !s.market) return { kind: "unknown", message: `Market unknown: rule ${rule.id} applies to some markets only.` };
  if (rule.audience && !s.audience) return { kind: "unknown", message: `Audience unknown: rule ${rule.id} applies to some audiences only.` };

  return {
    kind: "applies",
    rank: [rule.brandScope !== ALL_SCOPE ? 1 : 0, rule.channel !== "all" ? 1 : 0, rule.market ? 1 : 0, depth, rule.audience ? 1 : 0, rule.language !== "any" ? 1 : 0],
  };
}

/**
 * Operators that set a limit or the allowed values of a field: a more specific rule replaces a less specific one on the
 * same field (Noon's 150 replaces the fallback 60 to 200; Noon's "exactly 5 bullets" replaces "4 to 5"). Prohibitions
 * and presence rules add up instead: a channel's banned words never switch off the rule against phone numbers
 * (decision D22).
 */
const LIMIT_OPERATORS = new Set(["between", "between_max", "lte", "lt", "gte", "gt", "equals", "equals_rgb", "in_set", "allowed_values", "within", "matches_channel", "equals_ordered"]);

/** A limit rule whose value a machine can check; only these replace each other (D22, D29). */
function competes(rule: Rule): boolean {
  if (!LIMIT_OPERATORS.has(rule.operator)) return false;
  const spec = OPERATORS[rule.operator];
  return !!spec && !spec.unusable?.(rule.value);
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

// ---------------------------------------------------------------------------
// Measuring a field
// ---------------------------------------------------------------------------

const MISSING = Symbol("missing");
type Measured = { each: false; value: unknown } | { each: true; values: unknown[] } | typeof MISSING;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function lookup(facts: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(facts, key)) return facts[key];
  let at: unknown = facts;
  for (const part of key.split(".")) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return MISSING;
    at = at[part];
  }
  return at;
}

function derive(sub: string, text: string): unknown {
  switch (sub) {
    case "length":
      return charCount(text);
    case "bytes":
      return byteCount(text);
    case "sentences":
      return sentenceCount(text);
    case "text":
    case "case":
    case "starts_with":
    case "markup":
      return text;
    default:
      return MISSING;
  }
}

/** Fields that describe what the render does, not what a reviewer can check on the output (decision D21). */
const RENDER_DEFAULT_FIELDS = new Set(["image.background_hex"]);

function measure(rule: Rule, s: Subject): Measured {
  const facts = isRecord(s.value) ? s.value : null;
  const prefix = `${rule.component}.`;
  const sub = rule.field.startsWith(prefix) ? rule.field.slice(prefix.length) : null;
  if (facts) {
    const full = lookup(facts, rule.field);
    if (full !== MISSING) return { each: false, value: full };
    if (sub !== null) {
      const short = lookup(facts, sub);
      if (short !== MISSING) return { each: false, value: short };
    }
  }
  const raw = facts ? facts.text : s.value;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) && raw.every((t) => typeof t === "string") ? (raw as string[]) : null;
  if (text === null || sub === null) return MISSING;

  if (sub.startsWith("each.")) {
    if (!Array.isArray(text)) return MISSING;
    const values = text.map((t) => derive(sub.slice(5), t));
    return values.includes(MISSING) ? MISSING : { each: true, values };
  }
  if (sub === "count") return { each: false, value: Array.isArray(text) ? text.length : keywordTerms(text).length };
  if (Array.isArray(text)) {
    if (sub === "text" || sub === "markup") return { each: false, value: text };
    const joined = derive(sub, text.join(rule.component === "keywords" ? " " : "\n"));
    return joined === MISSING ? MISSING : { each: false, value: joined };
  }
  const v = derive(sub, text);
  return v === MISSING ? MISSING : { each: false, value: v };
}

// ---------------------------------------------------------------------------
// Messages (M5-F4-R6)
// ---------------------------------------------------------------------------

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s: string, n = 60) => ([...s].length > n ? `${[...s].slice(0, n).join("")}...` : s);
const labelOf = (field: string) => capital(field.replace(/[._]+/gu, " ").trim());

const UNITS: Record<string, string> = { length: "characters", bytes: "bytes", sentences: "sentences" };

function describe(rule: Rule, measured: unknown, index: number | null): string {
  const sub = rule.field.split(".").at(-1)!;
  const noun = index === null ? capital(rule.component.replace(/_/gu, " ")) : `${capital(rule.component.replace(/s$/u, ""))} ${index + 1}`;
  if (typeof measured === "number" && UNITS[sub]) return `${noun} has ${measured} ${UNITS[sub]}`;
  const shown = typeof measured === "string" ? `"${clip(measured)}"` : clip(fmt(measured));
  return `${index === null ? labelOf(rule.field) : noun} is ${shown}`;
}

function sentence(rule: Rule, check: Check, measured: unknown, index: number | null, who: string): string {
  if (check.outcome === "needs_judge" || check.outcome === "not_applicable") return `${labelOf(rule.field)}: rule ${rule.id} ${check.says}.`;
  const what = describe(rule, measured, index);
  if (check.says.startsWith("value is")) return `${what}; ${check.says}.`;
  return `${what}; ${who} ${check.says}.`;
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

function result(rule: Rule, sev: EffectiveSeverity, outcome: RuleOutcome, measured: unknown, message: string): RuleResult {
  const withNote = outcome === "fail" && sev.note ? `${message} ${sev.note}` : message;
  return { ruleId: rule.id, ruleVersion: rule.version, outcome, effectiveSeverity: sev.severity, measured, message: withNote };
}

function checkRule(rule: Rule, s: Subject, channel: ChannelRecord, sev: EffectiveSeverity, channels: Map<string, ChannelRecord>): RuleResult {
  const label = labelOf(rule.field);
  if (sev.judge) return result(rule, sev, "needs_judge", null, `${label}: rule ${rule.id} needs a judgement${rule.text ? ` (${rule.text})` : ""}.`);
  if (RENDER_DEFAULT_FIELDS.has(rule.field))
    return result(rule, sev, "not_applicable", null, `${label}: rule ${rule.id} is the render default, not a check (decision D21).`);
  const spec = OPERATORS[rule.operator];
  if (!spec) return result(rule, sev, "needs_judge", null, `${label}: rule ${rule.id} needs a judgement (no check for ${rule.operator}).`);
  const problem = spec.unusable?.(rule.value);
  if (problem) return result(rule, sev, "needs_judge", null, `${label}: rule ${rule.id} ${problem}, so it needs a judgement (decision D29).`);

  const who = rule.channel === "all" ? "Every channel" : (channels.get(rule.channel)?.label ?? rule.channel);
  const ctx = { channel, brandName: s.brandName ?? null };
  const m = measure(rule, s);
  if (m === MISSING && !spec.absenceFails) return result(rule, sev, "not_applicable", null, `Not measured: ${rule.field}.`);

  if (m !== MISSING && m.each) {
    const checks = m.values.map((v) => spec.check(v, rule.value, ctx));
    const failed = checks.findIndex((c) => c.outcome === "fail");
    if (failed >= 0) return result(rule, sev, "fail", m.values, sentence(rule, checks[failed]!, m.values[failed], failed, who));
    const judged = checks.findIndex((c) => c.outcome === "needs_judge");
    if (judged >= 0) return result(rule, sev, "needs_judge", m.values, sentence(rule, checks[judged]!, m.values[judged], judged, who));
    if (!checks.length) return result(rule, sev, "pass", m.values, `${label}: no items.`);
    const outcome = checks.every((c) => c.outcome === "not_applicable") ? "not_applicable" : "pass";
    return result(rule, sev, outcome, m.values, sentence(rule, checks[0]!, m.values[0], 0, who));
  }

  const measured = m === MISSING ? null : m.value;
  const check = spec.check(measured, rule.value, ctx);
  return result(rule, sev, check.outcome, measured, sentence(rule, check, measured, null, who));
}

/**
 * Every applicable rule's result for one subject, in snapshot order. A channel the snapshot does not hold gives no
 * results: it was added after the batch started and is never published in that batch (M5-F4 edge cases).
 */
export function evaluate(snapshot: RulesetSnapshot, subject: Subject): RuleResult[] {
  const channels = new Map(snapshot.channels.map((c) => [c.id, c]));
  const channel = channels.get(subject.channel);
  if (!channel) return [];

  const ss: SubjectScope = { nodes: withParents(subject.categoryPath), unknownUnder: unknownUnder(subject.categoryPath) };
  const scoped = snapshot.rules.map((rule) => ({ rule, scope: scopeOf(rule, subject, ss) })).filter((x) => x.scope.kind !== "skip");

  // The most specific rank of the limit rules of each field (D22).
  const best = new Map<string, number[]>();
  for (const { rule, scope } of scoped) {
    if (scope.kind !== "applies" || !competes(rule)) continue;
    const key = rule.field;
    const prev = best.get(key);
    if (!prev || compareRank(scope.rank, prev) > 0) best.set(key, scope.rank);
  }

  const out: RuleResult[] = [];
  for (const { rule, scope } of scoped) {
    const sev = effectiveSeverity(rule, snapshot.conflicts);
    if (scope.kind === "unknown") {
      out.push(result(rule, sev, "not_applicable", null, scope.message));
      continue;
    }
    if (scope.kind !== "applies") continue;
    const top = competes(rule) ? best.get(rule.field) : undefined;
    if (top && compareRank(scope.rank, top) < 0) continue;
    try {
      out.push(checkRule(rule, subject, channel, sev, channels));
    } catch {
      out.push(result(rule, sev, "needs_judge", null, `${labelOf(rule.field)}: rule ${rule.id} could not be checked automatically.`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Judge routing stub (D5)
// ---------------------------------------------------------------------------

export interface JudgeRequest {
  ruleId: string;
  ruleVersion: number;
  rulesetVersion: number;
  channel: string;
  component: Subject["component"];
  field: string;
  judgeMethod: string | null;
  contentVersionId: string | null;
  question: string;
}

/**
 * The judgement requests for a subject's needs_judge results. A stub by decision D5: it only builds the requests, which
 * are recorded and counted in the digest; no judge call runs until M7's judges cover the rule.
 */
export function routeToJudge(snapshot: RulesetSnapshot, subject: Subject, results: RuleResult[]): JudgeRequest[] {
  const rules = new Map(snapshot.rules.map((r) => [`${r.id}@${r.version}`, r]));
  return results
    .filter((r) => r.outcome === "needs_judge")
    .map((r) => {
      const rule = rules.get(`${r.ruleId}@${r.ruleVersion}`);
      return {
        ruleId: r.ruleId,
        ruleVersion: r.ruleVersion,
        rulesetVersion: snapshot.version,
        channel: subject.channel,
        component: subject.component,
        field: rule?.field ?? "",
        judgeMethod: rule?.judgeMethod ?? null,
        contentVersionId: subject.contentVersionId,
        question: r.message,
      };
    });
}
