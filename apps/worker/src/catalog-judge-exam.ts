// M1 D43: the judge exam, a subcommand of the Cloud Run job catalog-output-evals (infra/catalog-output-evals.sh exam). It calls the
// live judge, so it refuses to run without LIVE_SMOKE=1. It reads only the pinned images under catalog-test/, writes its report only
// under catalog-test/evals/<run>/judge-exam/, and in the database only one cost ledger row per judging, with no batch. A failed bar or an
// exam that could not run exits 1, which fails the deploy report (infra/deploy.sh) and the proof. The two print different lines, read by
// infra/catalog-output-evals.sh: "JUDGE EXAM FAIL:" is a judge result, "JUDGE EXAM COULD NOT RUN:" is not. Model ids appear in the report and the console only.
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@catalog/core/db/client";
import { JUDGE_EXAM_BARS, JUDGE_EXAM_MAX_USD, judgeExamLine, parseJudgeExamSet, scoreJudgeExam, type JudgeExamAnswer, type JudgeExamImage, type JudgeExamScore, type JudgeExamSet } from "@catalog/core/catalog/evals/judge-exam";
import { EVALS_PREFIX } from "@catalog/core/catalog/evals/progress";
import { assertTestPrefix } from "@catalog/core/catalog/naming";
import { DIMENSION_FLAGS, failingDimensions, type JudgeResult } from "@catalog/core/catalog/qa/judge";
import { DEFAULT_POLICIES } from "@catalog/core/catalog/qa/policy";
import { recordCostEvent } from "@catalog/core/cost-events";
import * as gcs from "@catalog/core/storage";
import { CircuitBreakers } from "@catalog/core/vendor/circuit";
import { createRouter, type Router } from "@catalog/core/vendor/router";
import type { RouteDef } from "@catalog/core/vendor/routes";
import { workerCatalogDeps, type CatalogDeps } from "./catalog/deps";
import { liveQaEnabled } from "./catalog/qa-mock";
// Bundled into the job: its image carries dist/ only, so a path into packages/ would not exist there.
import examSet from "../../../packages/core/test-fixtures/catalog/evals/judge-exam-set.json";

const CONCURRENCY = 6;

export interface JudgeExamPass { name: string; judge: string; second: string | null; score: JudgeExamScore; answers: JudgeExamAnswer[] }
export interface JudgeExamResult { run: string; version: string; pass: boolean; lines: string[]; passes: JudgeExamPass[]; reportUri: string; couldNotRun?: string }

/** The route table a judge is examined on: the serving table, with the judges above it switched off, on fresh circuits. */
export function routerWithout(routes: readonly RouteDef[], off: readonly string[]): Router {
  return createRouter(routes.map(r => (r.capability === "judge.render" && off.includes(r.model) ? { ...r, state: "off" as const } : r)), new CircuitBreakers());
}

/**
 * The two judges a verdict can come from in production, from the route table and the built-in policy: the first with its second opinion,
 * and the next route with the first switched off, as in a kill-switch drill.
 */
export function examPlan(routes: readonly RouteDef[], first: string): { name: string; judge: string; off: string[] }[] {
  const next = routes.filter(r => r.capability === "judge.render" && r.state === "serving" && r.model !== first).sort((a, b) => a.rank - b.rank)[0];
  return [{ name: "first judge", judge: first, off: [] }, ...(next ? [{ name: "fallback judge", judge: next.model, off: [first] }] : [])];
}

/**
 * Why the exam cannot give a judge result now: both judges must be serving. During a kill-switch drill or with a route switched off,
 * every image would read as no answer, or the fallback would go unexamined, and neither says anything about the judge.
 */
export function examBlocked(routes: readonly RouteDef[], judges: readonly (string | null | undefined)[]): string | null {
  const off = judges.filter((model): model is string => !!model && !routes.some(r => r.capability === "judge.render" && r.model === model && r.state === "serving"));
  return off.length ? `not serving: ${off.join(", ")}. A kill-switch drill or a switched-off route says nothing about the judge; end it and run the exam again.` : null;
}

/**
 * What the judge raised. With its second opinion the verdict is what production does. In the fallback pass no second opinion can exist,
 * so a reading that needs one comes back unchecked: the exam marks what the judge itself saw, since that is its eye under test.
 */
export function examFlags(verdict: Pick<JudgeResult, "flags" | "route" | "scores" | "leftover" | "wrongItem">, hasSecond: boolean, threshold: number, floor: number): readonly string[] {
  if (hasSecond || !verdict.route || !verdict.flags.includes("qa_unavailable")) return verdict.flags;
  const located = !!verdict.leftover?.located;
  const seen = failingDimensions(verdict.scores, threshold, floor).map(d => DIMENSION_FLAGS[d] as string).filter(f => f !== "leftover_background" && f !== "different_product");
  return [...seen, ...(located ? ["leftover_background"] : []), ...(verdict.wrongItem?.first ? ["different_product"] : [])];
}

async function pool<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (next < items.length) await work(items[next++]!); }));
}

export async function runJudgeExam(db: Db, deps: CatalogDeps, options: { run: string; routes?: readonly RouteDef[]; set?: JudgeExamSet }): Promise<JudgeExamResult> {
  const set = options.set ?? parseJudgeExamSet(JSON.stringify(examSet)), bucket = gcs.getBucketName(), prefix = `${EVALS_PREFIX}/${options.run}/judge-exam`;
  const routes = options.routes ?? (deps.routes ? (await deps.routes()).routes : []);
  const policy = DEFAULT_POLICIES.other, first = process.env.CATALOG_QA_DEFAULT_MODEL?.trim() || policy.qaModel;
  const images = new Map<string, Promise<Buffer>>();
  const read = (relative: string, sha: string) => {
    const known = images.get(relative);
    if (known) return known;
    const bytes = gcs.downloadBuffer(gcs.toGsUri(bucket, `${set.prefix}/${relative}`)).then(({ buf }) => {
      if (createHash("sha256").update(buf).digest("hex") !== sha) throw new Error(`The exam image ${relative} changed: its bytes no longer match the pinned sha256.`);
      return buf;
    });
    images.set(relative, bytes);
    return bytes;
  };
  const passes: JudgeExamPass[] = [];
  let spent = 0, stopped: string | undefined = examBlocked(routes, [first, policy.qaModelSecond]) ?? undefined;
  try {
    for (const { name, judge, off } of stopped ? [] : examPlan(routes, first)) {
      const router = routerWithout(routes, off), answers: JudgeExamAnswer[] = [], second = off.length ? null : policy.qaModelSecond ?? null;
      await pool(set.images, async (image: JudgeExamImage) => {
        if (spent >= JUDGE_EXAM_MAX_USD) throw new Error(`the exam reached $${JUDGE_EXAM_MAX_USD}`);
        const [output, original, shotOne] = await Promise.all([read(image.output, image.outputSha256), read(image.source, image.sourceSha256), image.n > 1 ? read(image.reference!, image.referenceSha256!) : undefined]);
        const verdict = await deps.judgeOutput({ output, original, ...(shotOne ? { shotOne } : {}), channel: image.channel, anchor: "centre", productType: image.productType, identifier: image.identifier, n: image.n, model: judge, threshold: policy.threshold, floor: policy.floor, ...(second ? { secondModel: second } : {}) }, { router });
        spent += verdict.costUsd;
        await recordCostEvent(db, { batchId: null, brandSlug: null, isTest: true, stage: "qa", kind: "llm_call", engine: verdict.model, usd: verdict.costUsd, channel: image.channel, outcome: "ok" }, deps.log);
        answers.push({ id: image.id, model: verdict.route ? verdict.model : null, secondModel: verdict.leftover?.secondModel ?? verdict.wrongItem?.secondModel ?? null, flags: examFlags(verdict, !!second, policy.threshold, policy.floor), scores: verdict.scores, costUsd: verdict.costUsd });
      });
      passes.push({ name, judge, second, score: scoreJudgeExam(judge, set.images, answers), answers });
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
  }
  const needed = examPlan(routes, first).length;
  const pass = !stopped && passes.length === needed && passes.every(p => p.score.pass);
  const lines = [
    ...passes.map(p => judgeExamLine(p.name, p.score, p.second)),
    ...passes.flatMap(p => [...p.score.failures.map(f => `FAIL ${p.judge}: ${f}`), `MISSED by ${p.judge}: ${p.score.missed.join(", ") || "none"}`, `FALSELY FLAGGED by ${p.judge}: ${p.score.falselyFlagged.join(", ") || "none"}`]),
    stopped ? `JUDGE EXAM COULD NOT RUN: ${stopped} Set ${set.version}, run ${options.run}. This is not a judge result.` : `JUDGE EXAM ${pass ? "PASS" : "FAIL"}: set ${set.version}, run ${options.run}.`,
  ];
  const write = async (name: string, body: string, mime: string) => { const object = `${prefix}/${name}`; assertTestPrefix(object); await gcs.uploadBuffer(object, Buffer.from(body), mime); return `gs://${bucket}/${object}`; };
  const reportUri = await write("report.json", JSON.stringify({ run: options.run, version: set.version, bars: JUDGE_EXAM_BARS, pass, couldNotRun: stopped ?? null, passes }, null, 1), "application/json");
  await write("verdict.txt", `${lines.join("\n")}\n`, "text/plain");
  for (const line of lines) console.info(line);
  console.info(`Judge exam report: ${reportUri}`);
  return { run: options.run, version: set.version, pass, lines, passes, reportUri, ...(stopped ? { couldNotRun: stopped } : {}) };
}

/** exam: the live judge on the pinned set. Exit 1 on a failed bar or an exam that could not run, which fails the deploy report. */
export async function judgeExamCommand(db: Db): Promise<void> {
  if (!liveQaEnabled()) { console.error("exam calls the live judge: run it through bash infra/catalog-output-evals.sh exam (LIVE_SMOKE=1)"); process.exitCode = 2; return; }
  const run = `exam-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  console.info(`Run id: ${run}`);
  const result = await runJudgeExam(db, workerCatalogDeps(db), { run });
  if (!result.pass) process.exitCode = 1;
}
