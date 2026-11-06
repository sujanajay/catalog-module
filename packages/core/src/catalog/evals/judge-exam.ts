// M1 D43: the judge exam. A fixed set of output images whose answer a person already knows: defects the judge must name and clean
// images it must leave alone, pinned by sha256 in test-fixtures/catalog/evals/judge-exam-set.json, the images under catalog-test/.
// Each judge that can give a verdict in production sits it: the first judge with its second opinion, and the fallback judge with
// the first switched off, as in a kill-switch drill. This file only scores; apps/worker/src/catalog-judge-exam.ts asks the live judge.
import { problemFlags } from "../qa/triage";
import type { ChannelId, OutputFlag, ProductType } from "../types";

export interface JudgeExamImage {
  id: string; expect: "defect" | "good"; defect?: string;
  identifier: string; n: number; channel: ChannelId; productType: ProductType;
  /** Relative to the set's `prefix`. */
  source: string; sourceSha256: string; output: string; outputSha256: string;
}
export interface JudgeExamSet { version: string; prefix: string; images: JudgeExamImage[] }
/** What one judge said about one image. `model` is the model that gave the verdict, null when none did. */
export interface JudgeExamAnswer { id: string; model: string | null; secondModel: string | null; flags: readonly string[]; scores: unknown; costUsd: number }
export interface JudgeExamBars { minCaught: number; maxFalseFlags: number; maxUnanswered: number }
export interface JudgeExamScore {
  judge: string; caught: number; defects: number; falseFlags: number; good: number; unanswered: number; costUsd: number; pass: boolean;
  missed: string[]; falselyFlagged: string[]; noAnswer: string[]; models: Record<string, number>; failures: string[];
}

/**
 * The bars. Set from repeated live runs of the final prompt on this set: see M1 D43 for the numbers. The four faint floor patches are in
 * the set and no judge sees them (a code check must), so a catch of all defects is not the bar. A judge that passes everything fails
 * on `minCaught`; a judge that flags everything fails on `maxFalseFlags`, which is what keeps people away from a real batch.
 */
export const JUDGE_EXAM_BARS: JudgeExamBars = { minCaught: 8, maxFalseFlags: 12, maxUnanswered: 3 };
/** A stop, far above the expected cost. Hitting it fails the exam. */
export const JUDGE_EXAM_MAX_USD = 6;

/** A verdict counts only from the judge under exam: a fallback that answered instead proves nothing about it. */
export function scoreJudgeExam(judge: string, images: readonly JudgeExamImage[], answers: readonly JudgeExamAnswer[], bars: JudgeExamBars = JUDGE_EXAM_BARS): JudgeExamScore {
  const byId = new Map(answers.map(a => [a.id, a]));
  const answered = (a: JudgeExamAnswer | undefined): a is JudgeExamAnswer => !!a && a.model === judge && !a.flags.includes("qa_unavailable");
  const raised = (a: JudgeExamAnswer) => problemFlags(a.flags.filter(f => f !== "qa_unavailable") as OutputFlag[]).length > 0;
  const missed: string[] = [], falselyFlagged: string[] = [], noAnswer: string[] = [];
  let caught = 0, defects = 0, good = 0;
  for (const image of images) {
    const answer = byId.get(image.id);
    if (image.expect === "defect") defects++; else good++;
    if (!answered(answer)) { noAnswer.push(image.id); if (image.expect === "defect") missed.push(image.id); continue; }
    if (image.expect === "defect") { if (raised(answer)) caught++; else missed.push(image.id); }
    else if (raised(answer)) falselyFlagged.push(image.id);
  }
  const models: Record<string, number> = {};
  for (const a of answers) { const key = a.model ?? "no answer"; models[key] = (models[key] ?? 0) + 1; }
  const failures = [
    ...(caught < bars.minCaught ? [`caught ${caught} of ${defects}, the bar is at least ${bars.minCaught}`] : []),
    ...(falselyFlagged.length > bars.maxFalseFlags ? [`falsely flagged ${falselyFlagged.length} of ${good}, the bar is at most ${bars.maxFalseFlags}`] : []),
    ...(noAnswer.length > bars.maxUnanswered ? [`no answer on ${noAnswer.length} images, the bar is at most ${bars.maxUnanswered}`] : []),
  ];
  return { judge, caught, defects, falseFlags: falselyFlagged.length, good, unanswered: noAnswer.length, costUsd: answers.reduce((sum, a) => sum + a.costUsd, 0), pass: failures.length === 0, missed, falselyFlagged, noAnswer, models, failures };
}

/** One line a person can read, naming the judge, for the job's log and verdict.txt. */
export function judgeExamLine(name: string, score: JudgeExamScore, second: string | null, bars: JudgeExamBars = JUDGE_EXAM_BARS): string {
  return `JUDGE EXAM ${score.pass ? "PASS" : "FAIL"} ${name} ${score.judge}${second ? ` (second opinion ${second})` : " (no second opinion)"}: caught ${score.caught} of ${score.defects} (bar ${bars.minCaught}), falsely flagged ${score.falseFlags} of ${score.good} (bar ${bars.maxFalseFlags}), no answer ${score.unanswered} (bar ${bars.maxUnanswered}), $${score.costUsd.toFixed(2)}.`;
}

/** Reads the committed set and refuses a malformed one. */
export function parseJudgeExamSet(text: string): JudgeExamSet {
  const set = JSON.parse(text) as JudgeExamSet;
  if (!set.prefix?.startsWith("catalog-test/") || !Array.isArray(set.images) || !set.images.length) throw new Error("The judge exam set must list images under catalog-test/.");
  const ids = new Set(set.images.map(i => i.id));
  if (ids.size !== set.images.length) throw new Error("The judge exam set repeats an image id.");
  return set;
}
