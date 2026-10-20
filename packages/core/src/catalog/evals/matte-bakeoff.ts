// Matting model bake-off (spec 10 section 10): every deployed cut-out model is run on the golden
// sources of each category and scored with the same cut-out integrity checks the pipeline output is
// held to. The winner per (brand, category) and per category goes to spec 08's policy writer, so
// the next batch picks it up through model_policy; mixing models across types is intended.
import type { PlannedPolicyRow, PolicyCandidates } from "../eval/policy-writer";
import { CATALOG_QA_DEFAULT_MODEL } from "../qa/classify";
import { QA_DEFAULT_FLOOR, QA_DEFAULT_THRESHOLD } from "../qa/judge";
import type { MatteMetrics } from "./cutout";
import type { CheckResult } from "./types";

export interface MatteTrial { brand: string; category: string; identifier: string; n: number; model: string; target: "cpu" | "gpu"; ms: number; results: CheckResult[]; metrics: MatteMetrics; tags: string[] }

export interface ModelScore {
  model: string; target: "cpu" | "gpu"; sources: number;
  /** Share of sources with at least one failing cut-out check. */
  failRate: number;
  /** Mean of the raw metrics (null when never measured). */
  regionLoss: number | null; thinLoss: number | null; backgroundKept: number | null; seeThrough: number | null; edgeSoftness: number | null; holes: number;
  consensusLoss: number | null; consensusExtra: number | null;
  /** Composite: the weighted sum of the loss shares (COMPOSITE_WEIGHTS), unbounded, lower is better; 10 x a consensus loss of 10% alone is 1. */
  composite: number;
  msPerImage: number;
  /** Fail rate on the hard-case tags, for the report. */
  hardCaseFailRate: number | null;
}
export interface CategoryWinner { brand: string; category: string; ranking: ModelScore[]; winner: ModelScore | null; runnerUp: ModelScore | null; margin: number | null; sources: number }

/** Weights of the composite: lost pixels count most, soft edges least; the consensus terms separate models that all pass the bars. */
export const COMPOSITE_WEIGHTS = { regionLoss: 10, thinLoss: 3, backgroundKept: 10, seeThrough: 5, edgeSoftness: 0.02, consensusLoss: 10, consensusExtra: 10 } as const;
export const HARD_TAGS = new Set(["white_on_white", "dark_product", "thin_straps", "transparent", "reflective", "grey_background"]);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function scoreModels(trials: readonly MatteTrial[]): ModelScore[] {
  const byModel = new Map<string, MatteTrial[]>();
  for (const t of trials) byModel.set(`${t.model}|${t.target}`, [...byModel.get(`${t.model}|${t.target}`) ?? [], t]);
  return [...byModel.entries()].map(([key, rows]) => {
    const [model, target] = key.split("|") as [string, "cpu" | "gpu"];
    const pick = (f: (m: MatteMetrics) => number | null) => mean(rows.flatMap(r => { const v = f(r.metrics); return v === null ? [] : [v]; }));
    const regionLoss = pick(m => m.regionLoss), thinLoss = pick(m => m.thinLoss), backgroundKept = pick(m => m.backgroundKept), seeThrough = pick(m => m.seeThrough), edgeSoftness = pick(m => m.edgeSoftness);
    const consensusLoss = pick(m => m.consensusLoss ?? null), consensusExtra = pick(m => m.consensusExtra ?? null);
    const failed = (r: MatteTrial) => r.results.some(c => c.status === "fail");
    const hard = rows.filter(r => r.tags.some(t => HARD_TAGS.has(t)));
    const composite = COMPOSITE_WEIGHTS.regionLoss * (regionLoss ?? 0) + COMPOSITE_WEIGHTS.thinLoss * (thinLoss ?? 0) + COMPOSITE_WEIGHTS.backgroundKept * (backgroundKept ?? 0) + COMPOSITE_WEIGHTS.seeThrough * (seeThrough ?? 0) + COMPOSITE_WEIGHTS.edgeSoftness * (edgeSoftness ?? 0) + COMPOSITE_WEIGHTS.consensusLoss * (consensusLoss ?? 0) + COMPOSITE_WEIGHTS.consensusExtra * (consensusExtra ?? 0);
    return { model, target, sources: rows.length, failRate: rows.filter(failed).length / rows.length, regionLoss, thinLoss, backgroundKept, seeThrough, edgeSoftness, consensusLoss, consensusExtra, holes: rows.reduce((a, r) => a + (r.metrics.holes ?? 0), 0), composite: Math.round(composite * 1e5) / 1e5, msPerImage: mean(rows.map(r => r.ms)) ?? 0, hardCaseFailRate: hard.length ? hard.filter(failed).length / hard.length : null };
  });
}

/** Ranking: fewest failing sources, then the lower composite, then faster. The margin is the runner-up's composite minus the winner's. */
export function rankModels(scores: readonly ModelScore[]): ModelScore[] {
  return [...scores].sort((a, b) => a.failRate - b.failRate || a.composite - b.composite || a.msPerImage - b.msPerImage);
}

export function winnersByScope(trials: readonly MatteTrial[]): CategoryWinner[] {
  const scopes = new Map<string, MatteTrial[]>();
  const add = (brand: string, category: string, t: MatteTrial) => { const k = `${brand}|${category}`; scopes.set(k, [...scopes.get(k) ?? [], t]); };
  for (const t of trials) { add(t.brand, t.category, t); add("*", t.category, t); }
  return [...scopes.entries()].map(([k, rows]) => {
    const [brand, category] = k.split("|") as [string, string];
    const ranking = rankModels(scoreModels(rows));
    const winner = ranking[0] ?? null, runnerUp = ranking[1] ?? null;
    return { brand, category, ranking, winner, runnerUp, margin: winner && runnerUp ? Math.round((runnerUp.composite - winner.composite) * 1e5) / 1e5 : null, sources: new Set(rows.map(r => `${r.identifier}_${r.n}`)).size };
  }).sort((a, b) => a.brand.localeCompare(b.brand) || a.category.localeCompare(b.category));
}

/** Policy rows for spec 08's writer; the judge settings come from the existing row for the pair when there is one. */
export function policyRowsFor(winners: readonly CategoryWinner[], input: { batchIds: string[]; seen: PolicyCandidates; existing: { brandSlug: string; category: string; qaModel: string; threshold: number; floor: number; qaMode: "per_source" | "per_output"; qaSampleRate: number }[]; minSources?: number }): PlannedPolicyRow[] {
  const rows: PlannedPolicyRow[] = [];
  for (const w of winners) {
    if (!w.winner || w.sources < (input.minSources ?? 10)) continue;
    const prior = input.existing.find(e => e.brandSlug === w.brand && e.category === w.category);
    rows.push({
      brandSlug: w.brand, category: w.category as PlannedPolicyRow["category"], matteModel: w.winner.model, matteTarget: w.winner.target,
      qaModel: prior?.qaModel ?? CATALOG_QA_DEFAULT_MODEL, threshold: prior?.threshold ?? QA_DEFAULT_THRESHOLD, floor: prior?.floor ?? QA_DEFAULT_FLOOR,
      qaMode: prior?.qaMode ?? "per_source", qaSampleRate: prior?.qaSampleRate ?? 1, source: "bakeoff", evalBatchIds: input.batchIds,
      gates: { precision: null, recall: null, n_labelled: 0, met: false, candidates: input.seen, ...({ matteBakeoff: { sources: w.sources, winner: w.winner.model, runnerUp: w.runnerUp?.model ?? null, margin: w.margin, composite: w.winner.composite, failRate: w.winner.failRate } } as object) } as PlannedPolicyRow["gates"],
    });
  }
  return rows;
}
