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
  /** Shot one's source, sent as image 3 when n > 1, as production does. A planted wrong item names another product's. */
  reference?: string; referenceSha256?: string;
}
export interface JudgeExamSet { version: string; prefix: string; images: JudgeExamImage[] }
/** What one judge said about one image. `model` is the model that gave the verdict, null when none did. */
export interface JudgeExamAnswer { id: string; model: string | null; secondModel: string | null; flags: readonly string[]; scores: unknown; costUsd: number }
export type DefectClass = "mark" | "leftover" | "wrong_item" | "floor_patch" | "cut";
export type JudgeExamClassBars = Partial<Record<DefectClass, number>>;
export interface JudgeExamBars { minCaught: number; maxFalseFlags: number; maxUnanswered: number; minPerClass: JudgeExamClassBars }
export interface JudgeExamScore {
  judge: string; caught: number; defects: number; falseFlags: number; good: number; unanswered: number; costUsd: number; pass: boolean;
  missed: string[]; falselyFlagged: string[]; noAnswer: string[]; models: Record<string, number>; failures: string[];
  /** Per class: caught and how many the set holds. */
  classes: Partial<Record<DefectClass, { caught: number; of: number }>>;
}

/** A catch must fit the defect: a flag about something else on the same image does not count. */
const DEFECTS: Record<string, { class: DefectClass; flags: readonly string[] }> = {
  "added mark stays": { class: "mark", flags: ["text_or_watermark"] },
  "whole scene and brand text": { class: "leftover", flags: ["leftover_background", "text_or_watermark"] },
  "court inside the rackets": { class: "leftover", flags: ["leftover_background"] },
  "court and hedge": { class: "leftover", flags: ["leftover_background"] },
  "faint floor patch": { class: "floor_patch", flags: ["leftover_background"] },
  "logo cut by the canvas": { class: "cut", flags: ["product_removed"] },
  "hem cut off": { class: "cut", flags: ["product_removed"] },
  "wrong item": { class: "wrong_item", flags: ["different_product"] },
};
export const defectClass = (defect: string | undefined): DefectClass | null => (defect && DEFECTS[defect]?.class) || null;

/**
 * The bars. Set from repeated live runs of the final prompt on this set: see M1 D43 for the numbers. The four faint floor patches are in
 * the set and no judge sees them (a code check must), so a catch of all defects is not the bar. A judge that passes everything fails
 * on `minCaught`; a judge that flags everything fails on `maxFalseFlags`, which is what keeps people away from a real batch. A judge
 * blind to a whole class of defect fails on `minPerClass`, whatever its total.
 */
export const JUDGE_EXAM_BARS: JudgeExamBars = { minCaught: 12, maxFalseFlags: 12, maxUnanswered: 3, minPerClass: { mark: 3, leftover: 3, wrong_item: 3 } };
/** A stop, far above the expected cost. Hitting it means the exam could not finish. */
export const JUDGE_EXAM_MAX_USD = 6;

/** A verdict counts only from the judge under exam: a fallback that answered instead proves nothing about it. */
export function scoreJudgeExam(judge: string, images: readonly JudgeExamImage[], answers: readonly JudgeExamAnswer[], bars: JudgeExamBars = JUDGE_EXAM_BARS): JudgeExamScore {
  const byId = new Map(answers.map(a => [a.id, a]));
  const answered = (a: JudgeExamAnswer | undefined): a is JudgeExamAnswer => !!a && a.model === judge && !a.flags.includes("qa_unavailable");
  const raised = (a: JudgeExamAnswer) => problemFlags(a.flags.filter(f => f !== "qa_unavailable") as OutputFlag[]) as readonly string[];
  const missed: string[] = [], falselyFlagged: string[] = [], noAnswer: string[] = [], classes: JudgeExamScore["classes"] = {};
  let caught = 0, defects = 0, good = 0;
  for (const image of images) {
    const answer = byId.get(image.id), kind = image.expect === "defect" ? DEFECTS[image.defect ?? ""] : undefined;
    if (image.expect === "defect") { defects++; if (kind) (classes[kind.class] ??= { caught: 0, of: 0 }).of++; } else good++;
    if (!answered(answer)) { noAnswer.push(image.id); if (image.expect === "defect") missed.push(image.id); continue; }
    if (image.expect === "defect") {
      if (raised(answer).some(f => kind?.flags.includes(f))) { caught++; if (kind) classes[kind.class]!.caught++; } else missed.push(image.id);
    } else if (raised(answer).length) falselyFlagged.push(image.id);
  }
  const models: Record<string, number> = {};
  for (const a of answers) { const key = a.model ?? "no answer"; models[key] = (models[key] ?? 0) + 1; }
  const failures = [
    ...(caught < bars.minCaught ? [`caught ${caught} of ${defects}, the bar is at least ${bars.minCaught}`] : []),
    ...(falselyFlagged.length > bars.maxFalseFlags ? [`falsely flagged ${falselyFlagged.length} of ${good}, the bar is at most ${bars.maxFalseFlags}`] : []),
    ...(noAnswer.length > bars.maxUnanswered ? [`no answer on ${noAnswer.length} images, the bar is at most ${bars.maxUnanswered}`] : []),
    ...Object.entries(bars.minPerClass).flatMap(([name, min]) => { const c = classes[name as DefectClass]; return (c?.caught ?? 0) < min! ? [`caught ${c?.caught ?? 0} of ${c?.of ?? 0} ${name} defects, the bar is at least ${min}`] : []; }),
  ];
  return { judge, caught, defects, falseFlags: falselyFlagged.length, good, unanswered: noAnswer.length, costUsd: answers.reduce((sum, a) => sum + a.costUsd, 0), pass: failures.length === 0, missed, falselyFlagged, noAnswer, models, failures, classes };
}

/** One line a person can read, naming the judge, for the job's log and verdict.txt. */
export function judgeExamLine(name: string, score: JudgeExamScore, second: string | null, bars: JudgeExamBars = JUDGE_EXAM_BARS): string {
  const classes = Object.entries(score.classes).map(([k, c]) => `${k} ${c.caught}/${c.of}${bars.minPerClass[k as DefectClass] ? ` (bar ${bars.minPerClass[k as DefectClass]})` : ""}`).join(", ");
  return `JUDGE EXAM ${score.pass ? "PASS" : "FAIL"} ${name} ${score.judge}${second ? ` (second opinion ${second})` : " (no second opinion)"}: caught ${score.caught} of ${score.defects} (bar ${bars.minCaught}), falsely flagged ${score.falseFlags} of ${score.good} (bar ${bars.maxFalseFlags}), no answer ${score.unanswered} (bar ${bars.maxUnanswered}), $${score.costUsd.toFixed(2)}. By class: ${classes}.`;
}

/** Reads the committed set and refuses a malformed one. */
export function parseJudgeExamSet(text: string): JudgeExamSet {
  const set = JSON.parse(text) as JudgeExamSet;
  if (!set.prefix?.startsWith("catalog-test/") || !Array.isArray(set.images) || !set.images.length) throw new Error("The judge exam set must list images under catalog-test/.");
  const ids = new Set(set.images.map(i => i.id));
  if (ids.size !== set.images.length) throw new Error("The judge exam set repeats an image id.");
  const unknown = set.images.find(i => i.expect === "defect" && !DEFECTS[i.defect ?? ""]);
  if (unknown) throw new Error(`The judge exam set has a defect with no class: ${unknown.id}.`);
  const noReference = set.images.find(i => i.n > 1 && !(i.reference && i.referenceSha256));
  if (noReference) throw new Error(`The judge exam set must pin shot one for ${noReference.id}, as production shows it.`);
  return set;
}
