// Hand-built rules, channel records and snapshots for the pure M5 tests (operators.test.ts, evaluate.test.ts).
// Test-only: nothing in the app imports this file.
import { CHANNELS } from "../channels";
import type { ChannelId } from "../types";
import type { ChannelRecord, ConflictRecord, Rule, RulesetSnapshot } from "./types";

export function recordFor(id: ChannelId): ChannelRecord {
  const spec = CHANNELS[id];
  return {
    id: spec.id,
    version: 1,
    rulesetVersion: 1,
    label: spec.label,
    group: spec.group,
    minCanvas: spec.minCanvas,
    targetCanvas: spec.targetCanvas,
    margins: spec.margins,
    anchor: spec.anchor,
    background: spec.background,
    firstImageBackground: spec.firstImageBackground ?? null,
    dpi: spec.dpi,
    fixedCanvas: spec.fixedCanvas,
    uniformScaleDefault: spec.uniformScaleDefault,
    sheetText: spec.sheetText,
    notes: spec.notes ?? null,
    markets: [],
    languages: [],
    status: "active",
    pushMethod: null,
    fileKind: null,
    owner: null,
    reason: "test",
    createdBy: "test",
  };
}

let next = 0;

/** A checkable, active, documented warn rule on every channel; override what the test is about. */
export function rule(over: Partial<Rule>): Rule {
  next += 1;
  return {
    id: `T${String(next).padStart(3, "0")}`,
    version: 1,
    rulesetVersion: 1,
    channel: "all",
    market: null,
    categoryScope: ["all"],
    datasetScope: "all",
    audience: null,
    brandScope: "all",
    language: "any",
    component: "title",
    field: "title.length",
    operator: "lte",
    value: 150,
    text: null,
    declaredSeverity: "warn",
    evidence: "documented",
    confirmedBy: null,
    source: "test",
    conflictsWith: [],
    checkable: true,
    judgeMethod: null,
    status: "active",
    reason: "test",
    createdBy: "test",
    ...over,
  };
}

export function conflict(id: string, ruleIds: string[], status: "open" | "decided" = "open"): ConflictRecord {
  return { id, topic: "test", severity: "high", ruleIds, options: [], recommendation: "", reasoning: "", status, decision: null };
}

export function snapshot(rules: Rule[], conflicts: ConflictRecord[] = [], channels: ChannelId[] = ["noon", "namshi", "amazon"]): RulesetSnapshot {
  return {
    id: "test",
    version: 9,
    hash: "test",
    publishedAt: "2026-11-04T00:00:00.000Z",
    rules,
    channels: channels.map(recordFor),
    categories: [],
    imagePolicies: [],
    conflicts,
  };
}
