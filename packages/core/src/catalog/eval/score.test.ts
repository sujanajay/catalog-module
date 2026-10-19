import { describe, expect, it } from "vitest";
import { chooseJudge, gateMetrics, humanLabels, rankMattes, scoreJudge, scoreMattes, type EvalJudgementRow, type EvalLabelRow, type EvalOutputRow } from "./score";
import { MATTE_CANDIDATES, chooseService } from "./run";

const t0 = new Date("2026-10-19T00:00:00Z");
const label = (outputId: string, l: "pass" | "flag", reasons: string[] = [], labeler = "a@opptra.com", at = t0): EvalLabelRow => ({ outputId, labeler, label: l, reasons, createdAt: at });
/** A judgement with every dimension at `score` (overall equals score). */
const judged = (outputId: string, judgeModel: string, score: number, costUsd = 0.001, extra: Record<string, unknown> = {}): EvalJudgementRow => ({
  outputId, judgeModel, verdict: score >= 75 ? "pass" : "flag", costUsd, ms: 100,
  scores: { complete_product: score, same_product: score, edge_quality: score, background_clean: score, no_text_or_watermark: score, orientation_ok: score, placement_ok: score, overall: score, ...extra },
});
const output = (outputId: string, matteModel: string, matteTarget: "cpu" | "gpu" = "cpu", matteMs = 1000): EvalOutputRow => ({ outputId, batchId: "b1", brand: "anta", category: "footwear", matteModel, matteTarget, matteMs, complianceOk: true });

describe("score: gates", () => {
  it("computes precision and recall and reports no_labels for empty denominators", () => {
    const m = gateMetrics([{ judge: "pass", human: "pass" }, { judge: "pass", human: "flag" }, { judge: "flag", human: "flag" }]);
    expect(m).toMatchObject({ precision: 0.5, recall: 0.5, n_labelled: 3, n_passed_by_judge: 2, n_flagged_by_human: 2, precisionGate: "not_met", met: false });
    expect(gateMetrics([{ judge: "pass", human: "pass" }])).toMatchObject({ precision: 1, recall: null, precisionGate: "met", recallGate: "no_labels", met: false });
  });
  it("latest label per labeler wins and disagreements count as flagged and are listed", () => {
    const labels = humanLabels([label("o1", "flag", ["halo"]), label("o1", "pass", [], "a@opptra.com", new Date(+t0 + 1)), label("o2", "pass"), label("o2", "flag", ["leftover_background"], "b@opptra.com")]);
    expect(labels.get("o1")).toEqual({ label: "pass", edgeFlag: false, disagreement: false });
    expect(labels.get("o2")).toEqual({ label: "flag", edgeFlag: true, disagreement: true });
  });
  it("threshold sweep keeps 75 when it qualifies and finds the lowest qualifying threshold otherwise", () => {
    const labels = humanLabels([label("p", "pass"), label("f", "flag")]);
    expect(scoreJudge("j", [judged("p", "j", 90), judged("f", "j", 50)], labels).sweptThreshold).toBe(75);
    // The flagged output scores 80: only thresholds above 80 flag it.
    expect(scoreJudge("j", [judged("p", "j", 90), judged("f", "j", 80)], labels).sweptThreshold).toBe(81);
  });
  it("chooses the cheapest judge meeting both gates at 75", () => {
    const labels = humanLabels([label("p", "pass"), label("f", "flag")]);
    const rows = [judged("p", "cheap", 90, 0.0004), judged("f", "cheap", 50, 0.0004), judged("p", "dear", 90, 0.0013), judged("f", "dear", 50, 0.0013)];
    expect(chooseJudge(["cheap", "dear"].map(m => scoreJudge(m, rows, labels)))).toMatchObject({ qaModel: "cheap", threshold: 75, qaMode: "per_source", gates: { met: true } });
  });
  it("when no judge meets the gates it picks the best recall at precision 97%, per_output and met false", () => {
    const labels = humanLabels([label("p", "pass"), label("f", "flag")]);
    // Both judges pass the flagged output at every threshold up to 100 and flag the good one at 100.
    const rows = [judged("p", "a", 99), judged("f", "a", 100), judged("p", "b", 99), judged("f", "b", 100)];
    const choice = chooseJudge(["a", "b"].map(m => scoreJudge(m, rows, labels)));
    expect(choice).toMatchObject({ qaMode: "per_output", gates: { met: false } });
  });
});

describe("score: matte winner", () => {
  const labels = humanLabels([label("a1", "pass"), label("a2", "flag", ["halo"]), label("b1", "pass"), label("b2", "pass"), label("c1", "pass"), label("c2", "pass")]);
  it("fewest human edge flags wins, ties go to fewer judge edge disagreements, then lower ms", () => {
    const outputs = [output("a1", "m-a"), output("a2", "m-a"), output("b1", "m-b", "cpu", 2000), output("b2", "m-b", "cpu", 2000), output("c1", "m-c", "cpu", 500), output("c2", "m-c", "cpu", 500)];
    const judgements = [judged("b1", "j", 90), judged("b2", "j", 90), judged("c1", "j", 90), judged("c2", "j", 50)];
    const ranking = rankMattes(scoreMattes(outputs, judgements, labels, "j"), MATTE_CANDIDATES);
    expect(ranking.map(r => r.matteModel)).toEqual(["m-b", "m-c", "m-a"]);
    const noJudge = rankMattes(scoreMattes(outputs, [], labels, null), MATTE_CANDIDATES);
    expect(noJudge.map(r => r.matteModel)).toEqual(["m-c", "m-b", "m-a"]);
  });
  it("a 2048 px winner is served by the gpu; a 1024 px winner by the target that measured faster", () => {
    const hr = rankMattes(scoreMattes([output("b1", "birefnet-hr-matting", "cpu"), output("b2", "birefnet-hr-matting", "cpu")], [], labels, null), MATTE_CANDIDATES);
    expect(hr[0]).toMatchObject({ matteTarget: "gpu" });
    const general = rankMattes(scoreMattes([output("b1", "birefnet-general", "cpu", 9000), output("b2", "birefnet-general", "gpu", 400)], [], labels, null), MATTE_CANDIDATES);
    expect(general[0]).toMatchObject({ matteModel: "birefnet-general", matteTarget: "gpu" });
  });
  it("a GPU-only candidate without MATTING_GPU_URL is not run: no GPU service", () => {
    expect(chooseService("birefnet-hr-matting", [], false)).toEqual({ ok: false, reason: "not run: no GPU service" });
    expect(chooseService("birefnet-general", [{ id: "birefnet-general", inputSize: 1024, target: "cpu" }, { id: "birefnet-general", inputSize: 1024, target: "gpu" }], true)).toMatchObject({ ok: true, target: "gpu" });
    expect(chooseService("ben2-base", [], false)).toMatchObject({ ok: false });
  });
});
