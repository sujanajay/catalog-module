// Bake-off metrics, gates and winner selection (spec 08 sections 4.5 and 4.6). Pure functions over
// rows loaded by load.ts; no database or network access here.
import { QA_DEFAULT_FLOOR, QA_DEFAULT_THRESHOLD, QA_DIMENSIONS, verdictFor, type QaScores } from "../qa/judge";
import type { EvalLabel } from "../types";

export const PRECISION_GATE = 0.97;
export const RECALL_GATE = 0.9;
/** Labels with these reasons count as human edge flags (the eval bar's edge and background reasons). */
export const EDGE_REASONS = ["halo", "leftover_background"] as const;
/** The plan's source volume used for the implied hours and USD per matte model. */
export const PLAN_SOURCES = 24_000;
/** USD per instance-hour for the implied cost: one CPU instance and one L4 (from the plan's review). */
export const USD_PER_HOUR = { cpu: 0.58, gpu: 1.2 } as const;

export interface EvalOutputRow {
  outputId: string; batchId: string; brand: string; category: string;
  matteModel: string; matteTarget: "cpu" | "gpu"; matteMs: number | null; complianceOk: boolean;
}
export interface EvalJudgementRow { outputId: string; judgeModel: string; scores: Record<string, unknown>; verdict: EvalLabel; costUsd: number; ms: number }
export interface EvalLabelRow { outputId: string; labeler: string; label: EvalLabel; reasons: string[]; createdAt: Date }
export type GateStatus = "met" | "not_met" | "no_labels";

export interface HumanLabel { label: EvalLabel; edgeFlag: boolean; disagreement: boolean }
/**
 * One human label per output: the latest label per labeler wins; when labelers disagree the output
 * counts as flagged (the conservative reading) and the disagreement is listed, never averaged.
 */
export function humanLabels(labels: readonly EvalLabelRow[]): Map<string, HumanLabel> {
  const latest = new Map<string, Map<string, EvalLabelRow>>();
  for (const row of labels) {
    const per = latest.get(row.outputId) ?? new Map<string, EvalLabelRow>();
    const prior = per.get(row.labeler);
    if (!prior || +row.createdAt >= +prior.createdAt) per.set(row.labeler, row);
    latest.set(row.outputId, per);
  }
  const out = new Map<string, HumanLabel>();
  for (const [outputId, per] of latest) {
    const rows = [...per.values()];
    const flagged = rows.filter(r => r.label === "flag");
    out.set(outputId, {
      label: flagged.length ? "flag" : "pass",
      edgeFlag: flagged.some(r => r.reasons.some(reason => (EDGE_REASONS as readonly string[]).includes(reason))),
      disagreement: flagged.length > 0 && flagged.length < rows.length,
    });
  }
  return out;
}

/** The judge's verdict at a swept threshold, recomputed from the stored scores (floor fixed at 60). */
export function verdictAt(j: EvalJudgementRow, threshold: number, floor = QA_DEFAULT_FLOOR): EvalLabel {
  if (j.scores.unavailable === true || j.scores.is_collage === true) return "flag";
  const scores = Object.fromEntries([...QA_DIMENSIONS, "overall"].map(k => [k, Number(j.scores[k] ?? 0)])) as QaScores;
  return verdictFor(scores, threshold, floor);
}

export interface GateMetrics {
  precision: number | null; recall: number | null;
  n_labelled: number; n_passed_by_judge: number; n_flagged_by_human: number;
  precisionGate: GateStatus; recallGate: GateStatus; met: boolean;
}
export function gateMetrics(pairs: readonly { judge: EvalLabel; human: EvalLabel }[]): GateMetrics {
  const passed = pairs.filter(p => p.judge === "pass");
  const flaggedByHuman = pairs.filter(p => p.human === "flag");
  const precision = passed.length ? passed.filter(p => p.human === "pass").length / passed.length : null;
  const recall = flaggedByHuman.length ? flaggedByHuman.filter(p => p.judge === "flag").length / flaggedByHuman.length : null;
  const gate = (value: number | null, min: number): GateStatus => value === null ? "no_labels" : value >= min ? "met" : "not_met";
  const precisionGate = gate(precision, PRECISION_GATE), recallGate = gate(recall, RECALL_GATE);
  return { precision, recall, n_labelled: pairs.length, n_passed_by_judge: passed.length, n_flagged_by_human: flaggedByHuman.length, precisionGate, recallGate, met: precisionGate === "met" && recallGate === "met" };
}

export interface JudgeScore {
  judgeModel: string; atDefault: GateMetrics;
  /** 75 when it qualifies, else the lowest qualifying threshold in 60..100, else null. */
  sweptThreshold: number | null;
  /** Highest recall reached at precision >= 97% over the sweep, with its threshold. */
  bestRecallAtPrecision: { threshold: number; recall: number } | null;
  costPerCheck: number; msPerCheck: number;
}
export function scoreJudge(judgeModel: string, judgements: readonly EvalJudgementRow[], labels: Map<string, HumanLabel>): JudgeScore {
  const rows = judgements.filter(j => j.judgeModel === judgeModel && labels.has(j.outputId));
  const at = (t: number) => gateMetrics(rows.map(j => ({ judge: verdictAt(j, t), human: labels.get(j.outputId)!.label })));
  const atDefault = at(QA_DEFAULT_THRESHOLD);
  let swept: number | null = atDefault.met ? QA_DEFAULT_THRESHOLD : null;
  let best: JudgeScore["bestRecallAtPrecision"] = null;
  for (let t = QA_DEFAULT_FLOOR; t <= 100; t++) {
    const m = at(t);
    if (swept === null && m.met) swept = t;
    if (m.precision !== null && m.precision >= PRECISION_GATE && m.recall !== null && (!best || m.recall > best.recall)) best = { threshold: t, recall: m.recall };
  }
  const all = judgements.filter(j => j.judgeModel === judgeModel);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return { judgeModel, atDefault, sweptThreshold: swept, bestRecallAtPrecision: best, costPerCheck: mean(all.map(j => j.costUsd)), msPerCheck: mean(all.map(j => j.ms)) };
}

export interface PolicyGates { precision: number | null; recall: number | null; n_labelled: number; met: boolean }
export interface JudgeChoice { qaModel: string; threshold: number; qaMode: "per_source" | "per_output"; gates: PolicyGates }
/** Section 4.6 QA model rule. Returns null when there are no judges at all. */
export function chooseJudge(scores: readonly JudgeScore[]): JudgeChoice | null {
  if (!scores.length) return null;
  const gates = (m: GateMetrics, met: boolean): PolicyGates => ({ precision: m.precision, recall: m.recall, n_labelled: m.n_labelled, met });
  const atDefault = scores.filter(s => s.atDefault.met).sort((a, b) => a.costPerCheck - b.costPerCheck);
  if (atDefault[0]) return { qaModel: atDefault[0].judgeModel, threshold: QA_DEFAULT_THRESHOLD, qaMode: "per_source", gates: gates(atDefault[0].atDefault, true) };
  const swept = scores.filter(s => s.sweptThreshold !== null).sort((a, b) => a.sweptThreshold! - b.sweptThreshold! || a.costPerCheck - b.costPerCheck);
  if (swept[0]) return { qaModel: swept[0].judgeModel, threshold: swept[0].sweptThreshold!, qaMode: "per_source", gates: gates(swept[0].atDefault, true) };
  const fallback = [...scores].sort((a, b) => (b.bestRecallAtPrecision?.recall ?? -1) - (a.bestRecallAtPrecision?.recall ?? -1) || a.costPerCheck - b.costPerCheck)[0]!;
  return { qaModel: fallback.judgeModel, threshold: fallback.bestRecallAtPrecision?.threshold ?? QA_DEFAULT_THRESHOLD, qaMode: "per_output", gates: gates(fallback.atDefault, false) };
}

export interface MatteScore {
  matteModel: string; matteTarget: "cpu" | "gpu"; n: number; n_labelled: number;
  complianceRate: number; edgeFlagRate: number | null; edgeDisagreements: number;
  meanEdgeQuality: number | null; meanBackgroundClean: number | null; msPerImage: number | null;
  planHours: number | null; planUsd: number | null;
}
/** Per matte model and target. `judgeModel` is the chosen judge whose edge scores are compared. */
export function scoreMattes(outputs: readonly EvalOutputRow[], judgements: readonly EvalJudgementRow[], labels: Map<string, HumanLabel>, judgeModel: string | null, threshold = QA_DEFAULT_THRESHOLD): MatteScore[] {
  const keys = [...new Set(outputs.map(o => `${o.matteModel}|${o.matteTarget}`))];
  return keys.map(key => {
    const [matteModel, matteTarget] = key.split("|") as [string, "cpu" | "gpu"];
    const rows = outputs.filter(o => o.matteModel === matteModel && o.matteTarget === matteTarget);
    const ids = new Set(rows.map(o => o.outputId));
    const labelled = rows.filter(o => labels.has(o.outputId));
    const judged = judgeModel ? judgements.filter(j => j.judgeModel === judgeModel && ids.has(j.outputId)) : [];
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const edgeOf = (j: EvalJudgementRow) => Number(j.scores.edge_quality ?? 0) < threshold || Number(j.scores.background_clean ?? 0) < threshold;
    const disagreements = judged.filter(j => labels.has(j.outputId) && edgeOf(j) !== labels.get(j.outputId)!.edgeFlag).length;
    const ms = mean(rows.flatMap(o => o.matteMs === null ? [] : [o.matteMs]));
    const planHours = ms === null ? null : PLAN_SOURCES * ms / 3_600_000;
    return {
      matteModel, matteTarget, n: rows.length, n_labelled: labelled.length,
      complianceRate: rows.length ? rows.filter(o => o.complianceOk).length / rows.length : 0,
      edgeFlagRate: labelled.length ? labelled.filter(o => labels.get(o.outputId)!.edgeFlag).length / labelled.length : null,
      edgeDisagreements: disagreements,
      meanEdgeQuality: mean(judged.map(j => Number(j.scores.edge_quality ?? 0))),
      meanBackgroundClean: mean(judged.map(j => Number(j.scores.background_clean ?? 0))),
      msPerImage: ms, planHours, planUsd: planHours === null ? null : planHours * USD_PER_HOUR[matteTarget],
    };
  });
}

export interface MatteCandidate { id: string; inputSize: number | "native"; gpuOnly: boolean; tier: "primary" | "secondary" }
/**
 * Section 4.6 matte rule: fewest human edge flags; ties by fewer judge edge disagreements, then by
 * lower ms per image. A 2048 px winner is served by the gpu; otherwise the target that measured faster.
 * Returns the full ranking; the first entry is the winner and the second is the manual fallback.
 */
export function rankMattes(scores: readonly MatteScore[], candidates: readonly MatteCandidate[]): { matteModel: string; matteTarget: "cpu" | "gpu"; edgeFlagRate: number }[] {
  const perModel = new Map<string, MatteScore[]>();
  for (const s of scores.filter(s => s.edgeFlagRate !== null)) perModel.set(s.matteModel, [...perModel.get(s.matteModel) ?? [], s]);
  return [...perModel.entries()].map(([model, rows]) => {
    const fastest = [...rows].sort((a, b) => (a.msPerImage ?? Infinity) - (b.msPerImage ?? Infinity))[0]!;
    const n = rows.reduce((a, r) => a + r.n_labelled, 0);
    const rate = rows.reduce((a, r) => a + (r.edgeFlagRate ?? 0) * r.n_labelled, 0) / Math.max(1, n);
    const candidate = candidates.find(c => c.id === model);
    const gpu = candidate?.inputSize === 2048 || !!candidate?.gpuOnly;
    return { model, rate, disagreements: rows.reduce((a, r) => a + r.edgeDisagreements, 0), ms: fastest.msPerImage ?? Infinity, target: gpu ? "gpu" as const : fastest.matteTarget };
  }).sort((a, b) => a.rate - b.rate || a.disagreements - b.disagreements || a.ms - b.ms)
    .map(r => ({ matteModel: r.model, matteTarget: r.target, edgeFlagRate: r.rate }));
}

/** Rows grouped per (brand, category), plus the pooled (*, category) and (*, *) scopes (section 4.6). */
export function scopes(outputs: readonly EvalOutputRow[]): { brand: string; category: string; outputs: EvalOutputRow[] }[] {
  const keys = new Map<string, EvalOutputRow[]>();
  const add = (brand: string, category: string, o: EvalOutputRow) => {
    const k = `${brand}|${category}`;
    keys.set(k, [...keys.get(k) ?? [], o]);
  };
  for (const o of outputs) { add(o.brand, o.category, o); add("*", o.category, o); add("*", "*", o); }
  return [...keys.entries()].map(([k, rows]) => { const [brand, category] = k.split("|") as [string, string]; return { brand, category, outputs: rows }; });
}
