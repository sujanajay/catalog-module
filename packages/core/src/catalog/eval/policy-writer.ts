// `policy write` (spec 08 section 4.6): bake-off winners into model_policy. Every (brand, category)
// with labels gets source "bakeoff"; (*, category) is pooled per category and replaces the default
// row; (*, *) is pooled over everything. "manual" rows are never overwritten; "default" and
// "pending" rows for the same pair are replaced.
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { modelPolicy, POLICY_CATEGORIES } from "../../db/schema";
import { CATALOG_QA_DEFAULT_MODEL } from "../qa/classify";
import { QA_DEFAULT_FLOOR, QA_DEFAULT_THRESHOLD } from "../qa/judge";
import { DEFAULT_POLICIES } from "../qa/policy";
import type { ProductType } from "../types";
import { chooseJudge, humanLabels, rankMattes, scopes, scoreJudge, scoreMattes, type EvalJudgementRow, type EvalLabelRow, type EvalOutputRow, type JudgeScore, type MatteCandidate, type MatteScore, type PolicyGates } from "./score";

type Category = (typeof POLICY_CATEGORIES)[number];
export interface PolicyCandidates { matte: { id: string; target: "cpu" | "gpu" }[]; judges: string[] }
export interface PlannedPolicyRow {
  brandSlug: string; category: Category; matteModel: string; matteTarget: "cpu" | "gpu"; qaModel: string;
  /** The second matte model of the ladder (the bake-off's runner-up); absent or null keeps the category default on insert and the stored value on update. */
  matteModelSecond?: string | null;
  threshold: number; floor: number; qaMode: "per_source" | "per_output"; qaSampleRate: number; source: "bakeoff";
  evalBatchIds: string[]; gates: PolicyGates & { candidates: PolicyCandidates };
}
export interface ScopeResult {
  brand: string; category: string; judges: JudgeScore[]; mattes: MatteScore[];
  matteRanking: ReturnType<typeof rankMattes>; row: PlannedPolicyRow | null; disagreements: number;
}

/** Scores every scope and plans one row per scope that has human labels. */
export function planPolicy(input: { outputs: readonly EvalOutputRow[]; judgements: readonly EvalJudgementRow[]; labels: readonly EvalLabelRow[]; candidates: readonly MatteCandidate[]; seen: PolicyCandidates }): ScopeResult[] {
  const all = humanLabels(input.labels);
  return scopes(input.outputs).filter(s => (POLICY_CATEGORIES as readonly string[]).includes(s.category)).map(scope => {
    const ids = new Set(scope.outputs.map(o => o.outputId));
    const labels = new Map([...all].filter(([id]) => ids.has(id)));
    const judgements = input.judgements.filter(j => ids.has(j.outputId));
    const judges = [...new Set(judgements.map(j => j.judgeModel))].sort().map(model => scoreJudge(model, judgements, labels));
    const choice = chooseJudge(judges);
    const mattes = scoreMattes(scope.outputs, judgements, labels, choice?.qaModel ?? null, choice?.threshold);
    const matteRanking = rankMattes(mattes, input.candidates);
    const winner = matteRanking[0];
    const disagreements = [...labels.values()].filter(l => l.disagreement).length;
    const row: PlannedPolicyRow | null = labels.size && winner ? {
      brandSlug: scope.brand, category: scope.category as Category, matteModel: winner.matteModel, matteTarget: winner.matteTarget,
      qaModel: choice?.qaModel ?? CATALOG_QA_DEFAULT_MODEL, threshold: choice?.threshold ?? QA_DEFAULT_THRESHOLD, floor: QA_DEFAULT_FLOOR,
      qaMode: choice?.qaMode ?? "per_output", qaSampleRate: 1, source: "bakeoff",
      evalBatchIds: [...new Set(scope.outputs.map(o => o.batchId))].sort(),
      gates: { ...(choice?.gates ?? { precision: null, recall: null, n_labelled: labels.size, met: false }), candidates: input.seen },
    } : null;
    return { brand: scope.brand, category: scope.category, judges, mattes, matteRanking, row, disagreements };
  });
}

export type WriteOutcome = "inserted" | "replaced" | "kept_manual";
/** Upserts the planned rows. A manual row is never touched (setWhere), whatever the plan says. */
export async function writePolicyRows(db: Db, rows: readonly PlannedPolicyRow[], dryRun = false): Promise<{ row: PlannedPolicyRow; outcome: WriteOutcome; previousSource: string | null }[]> {
  const existing = await db.select().from(modelPolicy);
  const results: { row: PlannedPolicyRow; outcome: WriteOutcome; previousSource: string | null }[] = [];
  for (const row of rows) {
    const prior = existing.find(e => e.brandSlug === row.brandSlug && e.category === row.category);
    const outcome: WriteOutcome = !prior ? "inserted" : prior.source === "manual" ? "kept_manual" : "replaced";
    results.push({ row, outcome, previousSource: prior?.source ?? null });
    if (dryRun || outcome === "kept_manual") continue;
    const defaults = row.category === "*" ? null : DEFAULT_POLICIES[row.category as Exclude<ProductType, "auto">];
    const { matteModelSecond, ...planned } = row;
    const values = { ...planned, gates: row.gates as unknown as Record<string, unknown> };
    const second = matteModelSecond == null ? {} : { matteModelSecond };
    await db.insert(modelPolicy)
      .values({ ...values, ...(defaults ? { shadowMode: defaults.shadowMode ?? null, matteModelSecond: defaults.matteModelSecond ?? null, qaModelSecond: defaults.qaModelSecond ?? null } : {}), ...second })
      .onConflictDoUpdate({
        target: [modelPolicy.brandSlug, modelPolicy.category],
        set: {
          matteModel: values.matteModel, matteTarget: values.matteTarget, qaModel: values.qaModel, threshold: values.threshold, floor: values.floor,
          qaMode: values.qaMode, qaSampleRate: values.qaSampleRate, source: values.source, evalBatchIds: values.evalBatchIds, gates: values.gates, updatedAt: new Date(), ...second,
        },
        setWhere: sql`${modelPolicy.source} <> 'manual'`,
      });
  }
  return results;
}

/** Section 4.7 trigger: a matte id or target or a judge id that the policy row has not seen. */
export function candidatesChanged(row: { gates: Record<string, unknown> | null }, now: PolicyCandidates): boolean {
  const seen = (row.gates?.candidates ?? null) as PolicyCandidates | null;
  if (!seen) return false;
  const key = (m: { id: string; target: string }) => `${m.id}|${m.target}`;
  const before = new Set(seen.matte.map(key)), judges = new Set(seen.judges);
  return now.matte.some(m => !before.has(key(m))) || now.judges.some(j => !judges.has(j)) || seen.judges.length !== now.judges.length;
}
