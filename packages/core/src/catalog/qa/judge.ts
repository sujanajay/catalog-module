import sharp from "sharp";
import { imageParts, textPart, LlmJsonError } from "../../llm/llm";
import type { BackoffBudget, RetryPolicy } from "../../llm/openrouter";
import { sumUsage } from "../../llm/util";
import { callCatalogJson, type OpenRouterCallDeps } from "../../vendor/adapters/openrouter";
import { callRoutes, fallbackLogFields, planRoutes, type RouteFailure, type Router } from "../../vendor/router";
import { CHANNELS } from "../channels";
import type { ChannelId, OutputFlag, ProductType } from "../types";
import { CATALOG_QA_TEMPLATE, PRODUCT_TYPE_WORDS, renderTemplate } from "./templates";
import { bySeverity, flagDetails } from "./reasons";

export const QA_DEFAULT_THRESHOLD = 75;
export const QA_DEFAULT_FLOOR = 60;
/**
 * Stored score keys (`catalog_outputs.qa_scores`). `same_product` is not scored by the judge: it is
 * 0 only when both judges said `wrong_item` (a confirmed different item), else 100. Placement is
 * never judged; code checks it exactly (05), so `placement_ok` is no longer a dimension.
 * `product_intact` (flag `product_removed`): image 2 still shows all of the product image 1 shows.
 */
export const QA_DIMENSIONS = ["complete_product", "same_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok", "product_intact"] as const;
export type QaDimension = typeof QA_DIMENSIONS[number];
export type QaScores = Record<QaDimension, number> & { overall: number };
/** Dimensions that describe the source photo (image 1): they apply to every channel of that photo. */
export const PHOTO_DIMENSIONS = ["complete_product", "same_product", "no_text_or_watermark", "orientation_ok"] as const satisfies readonly QaDimension[];
/** Dimensions that describe our rendered output (image 2 against image 1): judged per channel. */
export const OUTPUT_DIMENSIONS = ["product_intact", "edge_quality", "background_clean"] as const satisfies readonly QaDimension[];
export const DIMENSION_FLAGS: Record<QaDimension, OutputFlag> = {complete_product:"complete_product",same_product:"different_product",edge_quality:"halo",background_clean:"leftover_background",no_text_or_watermark:"text_or_watermark",orientation_ok:"orientation",product_intact:"product_removed"};
/** The scores the judge itself returns (every one is required in its reply). */
export const JUDGE_SCORED = QA_DIMENSIONS.filter(d => d !== "same_product");
/**
 * Dimensions added after rows were already judged. A stored score without them (an older judgement,
 * a canned or mocked judge) reads them as 100: nothing was checked, so nothing failed.
 */
export const LATER_DIMENSIONS: readonly QaDimension[] = ["product_intact"];
/** A stored or returned score, with the reading above for a dimension added later. */
export function scoreOf(scores: Partial<Record<string, unknown>>, d: QaDimension): number {
  const value = scores[d];
  if (value === undefined || value === null) return LATER_DIMENSIONS.includes(d) ? 100 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
export { callCatalogJson };
export interface CatalogLlmDeps extends OpenRouterCallDeps {
  /**
   * The live route table and circuit breakers (M7-F2, vendor/route-table.ts `routerFor`). The judge asks the policy's
   * models first, then every other serving route of `judge.render`; a switched-off route is never asked. Absent: the
   * policy's two models only.
   */
  router?: Router;
  /**
   * Back-off allowance shared by every judge call that gets these deps (the worker passes one per QA
   * delivery), on top of each judging's own `JUDGE_BACKOFF_BUDGET_MS`.
   */
  backoff?: BackoffBudget;
  /** Injectable waits for the judge back-off (tests). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * A 429 ("temporarily rate-limited upstream") or a 5xx from the judge comes in bursts: wait about
 * 5, 15 and 45 s (+/- 20%), or the Retry-After header, before giving up (07 4.2). One judging (the
 * first judge, the fallback and the second opinion together) waits at most `JUDGE_BACKOFF_BUDGET_MS`.
 */
export const JUDGE_BACKOFF_DELAYS_MS = [5_000, 15_000, 45_000] as const;
export const JUDGE_BACKOFF_JITTER = 0.2;
export const JUDGE_BACKOFF_BUDGET_MS = 120_000;
export type JudgeFailure = RouteFailure;

/**
 * Per-dimension pass lines from the resolved policy (no mean). Output dimensions use the policy
 * `threshold`: they are our own work. Photo dimensions use the lower `floor`: they describe the
 * brand's photo, where a false positive costs a photo.
 */
export function dimensionThresholds(threshold = QA_DEFAULT_THRESHOLD, floor = QA_DEFAULT_FLOOR): Record<QaDimension, number> {
  return {complete_product:floor,same_product:floor,no_text_or_watermark:floor,orientation_ok:floor,edge_quality:threshold,background_clean:threshold,product_intact:threshold};
}
function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** `overall` is the weakest dimension: informational only, the verdict never averages. */
export const withOverall = (scores: Record<QaDimension, number>): QaScores => ({...scores, overall: Math.min(...QA_DIMENSIONS.map(d => scoreOf(scores, d)))});
export function normalizeScores(raw: Record<string, unknown>): {scores: QaScores; reasons: string[]} {
  const reasons: string[] = [];
  const values = Object.fromEntries(QA_DIMENSIONS.map(dimension => {
    if (dimension === "same_product") {
      const legacy = numeric(raw.same_product);
      return [dimension, legacy !== null ? clamp(legacy) : raw.wrong_item === true ? 0 : 100];
    }
    const value = numeric(raw[dimension]);
    if (value === null) reasons.push(`The quality check did not provide a score for ${dimension.replaceAll("_", " ")}.`);
    return [dimension, value === null ? 0 : clamp(value)];
  })) as Record<QaDimension, number>;
  return {scores: withOverall(values), reasons};
}
/** Dimensions under their own pass line, lowest score first. */
export function failingDimensions(scores: QaScores, threshold = QA_DEFAULT_THRESHOLD, floor = QA_DEFAULT_FLOOR): QaDimension[] {
  const lines = dimensionThresholds(threshold, floor);
  return QA_DIMENSIONS.filter(d => scoreOf(scores, d) < lines[d]).sort((a, b) => scoreOf(scores, a) - scoreOf(scores, b));
}
export function verdictFor(scores: QaScores, threshold = QA_DEFAULT_THRESHOLD, floor = QA_DEFAULT_FLOOR): "pass" | "flag" {
  return failingDimensions(scores, threshold, floor).length ? "flag" : "pass";
}

/** Resize only the judge's transmitted copy, leaving source and staged bytes untouched. */
export async function qaImage(bytes: Buffer) {
  return {mime:"image/jpeg", data:await sharp(bytes).rotate().resize(1536,1536,{fit:"inside",withoutEnlargement:true}).flatten({background:"white"}).jpeg({quality:90}).toBuffer()};
}
export interface JudgeInput {
  output: Buffer; original: Buffer; shotOne?: Buffer; channel: ChannelId; anchor: "centre" | "bottom-centre";
  productType: ProductType; identifier: string; n: number; model: string; threshold: number; floor: number;
  /**
   * The second judge (`policy.qaModelSecond`), asked only when the first says `wrong_item` or finds
   * leftover background it can place. Without it neither ever counts.
   */
  secondModel?: string;
  /**
   * False on a re-check of another channel or a re-judge in the repair ladder: the photo checks come
   * from the first judging, so `wrong_item` never asks the second judge there. Default true.
   */
  wrongItemCheck?: boolean;
}
/** One judge model's reading of one output. */
export interface JudgeOpinion {
  model: string; view: string | null; wrongItem: boolean; isCollage: boolean;
  scores: QaScores; evidence: Partial<Record<QaDimension | "wrong_item" | "is_collage", string>>;
}
/** Two-model agreement on one check (`wrong_item`, or leftover background). */
export interface SecondOpinion { first: boolean; second: boolean | null; secondModel: string | null; confirmed: boolean }
export interface JudgeResult {
  scores: QaScores; verdict: "pass" | "flag"; reasons: string[]; isCollage: boolean;
  usage: Record<string, unknown>; costUsd: number; calls: number; model: string; flags: OutputFlag[];
  /** v2 fields below are optional so the canned judge and older mocks stay valid. */
  view?: string | null;
  thresholds?: Record<QaDimension, number>;
  /** The evidence sentence behind each flag, keyed by flag. */
  evidence?: Partial<Record<OutputFlag, string>>;
  /** The second opinion on `wrong_item`; `different_product` is set only when `confirmed`. */
  wrongItem?: SecondOpinion;
  /**
   * The second opinion on leftover background; `leftover_background` is set only when `confirmed`:
   * the first judge said where the leftover is and the second judge also scored it under the line.
   */
  leftover?: SecondOpinion & { located: boolean };
  opinions?: JudgeOpinion[];
  /** The route id that gave the verdict (M7-F2-R6), null when no route answered. Internal: never operator text. */
  route?: string | null;
}
export const VIEWS = ["front", "side", "back", "sole", "top", "inside", "detail", "on-model", "flat", "chart"] as const;
/** The view of a size chart, measurement guide or other text-only image: left out with a note, never held. */
export const CHART_VIEW = "chart";
/**
 * A leftover-background sentence must say where the leftover is ("a grey block left of the shoe");
 * a sentence without a place, or no sentence, is not evidence of a leftover.
 */
const PLACE = /\b(left|right|top|bottom|corner|corners|edge|edges|above|below|behind|under|underneath|beneath|beside|next to|near|around|between|centre|center|middle|side|sides|upper|lower|outline|border)\b/i;
export const namesPlace = (sentence: string | undefined) => !!sentence && PLACE.test(sentence);
/**
 * What each prompt image is on the operator's sheet: image 1 is the product's photo `n`, image 2 our
 * output rendered from it, image 3 (when sent) the product's photo 1.
 */
export function sheetNames(n: number, hasReference: boolean): Record<number, string> {
  const names: Record<number, string> = {1:`photo ${n}`, 2:"the output"};
  if (hasReference) names[3] = "photo 1";
  return names;
}
/**
 * The judge numbers images as the prompt orders them (the photo first, the reference last); the
 * operator reads the sheet. Rewrite each "image N" through `names`; a number outside it, or a
 * sentence without one, is left as is.
 */
export function sheetNumbered(sentence: string, names: Record<number, string>): string {
  return sentence.replace(/\b(?:(the)\s+)?(image)\s+(\d+)\b/gi, (match, the: string | undefined, word: string, digits: string) => {
    const name = names[Number(digits)];
    if (!name) return match;
    const lead = the ?? word;
    const upper = lead[0] === lead[0]!.toUpperCase();
    const text = the && !name.startsWith("the ") ? `the ${name}` : name;
    return upper ? text[0]!.toUpperCase() + text.slice(1) : text;
  });
}
function readOpinion(value: Record<string, unknown>, model: string, hasReference: boolean, names: Record<number, string>): JudgeOpinion & {missing: string[]} {
  const {scores, reasons: missing} = normalizeScores({...value, same_product: undefined});
  const raw = value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence) ? value.evidence as Record<string, unknown> : {};
  const evidence = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim()).map(([k, v]) => [k, sheetNumbered(v.trim(), names)]));
  const view = typeof value.view === "string" && (VIEWS as readonly string[]).includes(value.view.trim().toLowerCase()) ? value.view.trim().toLowerCase() : null;
  // Without image 3 there is nothing to compare with, so the photo is never a different item; a chart
  // belongs to the listing, so it is never a different item either.
  return {model, view, wrongItem: hasReference && view !== CHART_VIEW && value.wrong_item === true, isCollage: value.is_collage === true, scores, evidence, missing};
}
/** The judge's back-off for one model: waits come off this judging's budget and the shared one. */
function judgeRetry(model: string, budgets: BackoffBudget[], deps: CatalogLlmDeps, delaysMs: readonly number[] = JUDGE_BACKOFF_DELAYS_MS): RetryPolicy {
  return backoffRetry("catalog_qa: judge back-off", model, budgets, deps, delaysMs);
}
/**
 * The 429/5xx back-off of one catalog model call (judge or classifier): about 5, 15 and 45 s (+/- 20%)
 * or Retry-After, every wait taken off `budgets`, each wait logged as `line`.
 */
export function backoffRetry(line: string, model: string, budgets: BackoffBudget[], deps: CatalogLlmDeps, delaysMs: readonly number[] = JUDGE_BACKOFF_DELAYS_MS): RetryPolicy {
  return {delaysMs, jitter:JUDGE_BACKOFF_JITTER, budgets, ...(deps.sleep ? {sleep:deps.sleep} : {}), ...(deps.random ? {random:deps.random} : {}),
    onRetry: ({attempt, status, waitMs, retryAfterMs}) => (deps.log ?? console.warn)(line, {severity:"WARNING", model, attempt, status, kind:status === 429 ? "rate_limit" : "server", waitMs, retryAfterMs, budgetLeftMs:Math.min(...budgets.map(b => b.remainingMs))})};
}
async function askJudge(input: JudgeInput, model: string, deps: CatalogLlmDeps) {
  const content = [textPart("Image 1: the source photo"), ...imageParts([await qaImage(input.original)]), textPart(`Image 2: the output we rendered from image 1 for ${CHANNELS[input.channel].label}`), ...imageParts([await qaImage(input.output)])];
  if (input.n > 1 && input.shotOne) content.push(textPart(`Image 3: photo 1 of the same product id (${input.identifier}), for reference only`), ...imageParts([await qaImage(input.shotOne)]));
  content.push(textPart("Return only the JSON object."));
  const system = renderTemplate(CATALOG_QA_TEMPLATE, {channel: CHANNELS[input.channel].label, productType: PRODUCT_TYPE_WORDS[input.productType] ?? PRODUCT_TYPE_WORDS.other!});
  return callCatalogJson([{role:"system",content:system},{role:"user",content}], obj => {
    // Every check must be scored: a missing score is asked for again (the JSON helper retries once
    // with this message), never read as a failed check, so a partial reply cannot raise flags.
    const missing = JUDGE_SCORED.filter(d => numeric(obj[d]) === null);
    if (missing.length === JUDGE_SCORED.length) throw new LlmJsonError("No numeric quality dimension", JSON.stringify(obj));
    if (missing.length) throw new LlmJsonError(`Missing scores: ${missing.join(", ")}. Return every score as a number from 0 to 100.`, JSON.stringify(obj));
    return obj;
  }, model, deps);
}
/** Older replies carry a `reasons` array instead of `evidence`; keep them in their order. */
function legacyReasons(value: Record<string, unknown>, names: Record<number, string>): string[] {
  return Array.isArray(value.reasons) ? value.reasons.filter((r): r is string => typeof r === "string" && !!r.trim()).map(r => sheetNumbered(r.trim(), names)) : [];
}
const allPass = (): Record<QaDimension, number> => Object.fromEntries(QA_DIMENSIONS.map(d => [d, 100])) as Record<QaDimension, number>;
export async function judgeOutput(input: JudgeInput, deps: CatalogLlmDeps = {}): Promise<JudgeResult> {
  const hasReference = input.n > 1 && !!input.shotOne;
  const names = sheetNames(input.n, hasReference);
  const thresholds = dimensionThresholds(input.threshold, input.floor);
  const budgets = [{remainingMs:JUDGE_BACKOFF_BUDGET_MS}, ...(deps.backoff ? [deps.backoff] : [])];
  const withRetry = (model: string, delaysMs?: readonly number[]): CatalogLlmDeps => ({...deps, retry:judgeRetry(model, budgets, deps, delaysMs)});
  // M7-F2: the policy's two judges first, then every other serving `judge.render` route; a switched-off route is not
  // asked. The first route asked gets the full back-off, the later ones are asked once. A rate limit, server error,
  // timeout, invalid reply or refusal moves to the next route before the photo is held as unchecked.
  const plan = planRoutes(deps.router, "judge.render", [input.model, input.secondModel]);
  const answer = await callRoutes(plan, (route, index) => askJudge(input, route.model, withRetry(route.model, index === 0 ? undefined : [])), deps.router ? {router:deps.router} : {});
  const first = {value:answer.output, usage:sumUsage(answer.usages), costUsd:answer.costUsd, calls:answer.calls};
  const judgeRoute = answer.route;
  if (answer.tried.length > 1 || !plan.length) {
    (deps.log ?? console.warn)(!plan.length ? "catalog_qa: no judge route available" : answer.ok ? "catalog_qa: first judge unavailable; the second judge gave the verdict" : "catalog_qa: both judges unavailable", fallbackLogFields(plan, answer, input.model));
  }
  if (!first.value || !judgeRoute) {
    const {usage, costUsd, calls} = first;
    return {scores:normalizeScores({}).scores,verdict:"flag",reasons:[flagDetails("qa_unavailable").why],isCollage:false,usage,costUsd,calls,model:plan[0]?.model ?? input.model,flags:["qa_unavailable"],thresholds,opinions:[],route:null};
  }
  const judgeModel = judgeRoute.model;
  // The second opinion comes from the healthy routes of the plan other than the judge's: a route that failed in this
  // judging is not asked again, so a dead route 1 never stands in for the second model (M7-F2-R4).
  const failedIds = new Set(answer.tried.filter(t => t.failure).map(t => t.route.id));
  const secondPlan = plan.filter(route => route.model !== judgeModel && !failedIds.has(route.id));
  /** True when the plan had a second judge at all (configured), healthy or not. */
  const secondConfigured = plan.some(route => route.model !== judgeModel);
  const opinion = readOpinion(first.value, judgeModel, hasReference, names);
  const opinions: JudgeOpinion[] = [opinion];
  // A size chart or text-only image is left out with a note: no product check applies to it.
  if (opinion.view === CHART_VIEW) {
    const why = flagDetails("chart_image").why;
    return {scores:withOverall(allPass()),verdict:"flag",reasons:[why],isCollage:false,usage:first.usage,costUsd:first.costUsd,calls:first.calls,model:judgeModel,route:judgeRoute.id,flags:["chart_image"],view:opinion.view,thresholds,evidence:{chart_image:why},
      wrongItem:{first:false,second:null,secondModel:null,confirmed:false},leftover:{first:false,second:null,secondModel:null,confirmed:false,located:false},opinions};
  }
  const wrongFirst = opinion.wrongItem && input.wrongItemCheck !== false;
  const leftoverFirst = opinion.scores.background_clean < thresholds.background_clean;
  const located = leftoverFirst && namesPlace(opinion.evidence.background_clean);
  const usages = [first.usage];
  let costUsd = first.costUsd, calls = first.calls, other: JudgeOpinion | null = null, otherModel: string | undefined;
  // A different item holds the product and a leftover background re-makes or drops the photo, so a
  // second model must agree before either counts (07 4.2 v2). One second call answers both; it goes through the
  // routes like the verdict (first one with its back-off, the next ones once).
  const needSecond = wrongFirst || located;
  if (needSecond && secondPlan.length) {
    const reply = await callRoutes(secondPlan, (route, index) => askJudge(input, route.model, withRetry(route.model, index === 0 ? undefined : [])), deps.router ? {router:deps.router} : {});
    usages.push(...reply.usages); costUsd += reply.costUsd; calls += reply.calls;
    if (reply.output && reply.route) { otherModel = reply.route.model; other = readOpinion(reply.output, otherModel, hasReference, names); opinions.push(other); }
    else otherModel = secondPlan[0]!.model;
  }
  // A second judge was configured but none could answer: the check is unavailable, which is never a pass (M7-F2-R4).
  // Without any second judge (a one-model plan, as in the eval job) neither check counts, as before.
  if (needSecond && secondConfigured && !other) {
    (deps.log ?? console.warn)("catalog_qa: no second judge could answer; the photo is held as unchecked", {severity:"WARNING", model:judgeModel, route:judgeRoute.id, wrongItem:wrongFirst, leftover:located, calls});
    return {scores:opinion.scores,verdict:"flag",reasons:[flagDetails("qa_unavailable").why],isCollage:opinion.isCollage,usage:sumUsage(usages),costUsd,calls,model:judgeModel,route:judgeRoute.id,flags:["qa_unavailable"],view:opinion.view,thresholds,
      wrongItem:{first:wrongFirst,second:null,secondModel:otherModel ?? null,confirmed:false},leftover:{first:leftoverFirst,second:null,secondModel:otherModel ?? null,confirmed:false,located},opinions};
  }
  const secondWrong = wrongFirst && other ? other.wrongItem : null;
  const confirmed = wrongFirst && secondWrong === true;
  const secondLeftover = located && other ? other.scores.background_clean < thresholds.background_clean : null;
  const leftoverConfirmed = located && secondLeftover === true;
  // An unconfirmed leftover is read at the higher of the two scores, at least its line, so every
  // reader of the stored scores (re-checks, triage, evals) sees the same pass.
  const background = leftoverConfirmed ? Math.min(opinion.scores.background_clean, other!.scores.background_clean)
    : leftoverFirst ? Math.max(opinion.scores.background_clean, other?.scores.background_clean ?? 0, thresholds.background_clean) : opinion.scores.background_clean;
  const scores = withOverall({...opinion.scores, same_product: confirmed ? 0 : 100, background_clean: background});
  const failing = failingDimensions(scores, input.threshold, input.floor);
  // Only checks that actually failed raise a flag, the worst first, so a card cites the main problem.
  const flags: OutputFlag[] = bySeverity([...failing.map(d => DIMENSION_FLAGS[d]), ...(opinion.isCollage ? ["collage" as const] : [])]);
  const evidence: Partial<Record<OutputFlag, string>> = {};
  for (const d of failing) evidence[DIMENSION_FLAGS[d]] = (d === "same_product" ? opinion.evidence.wrong_item : opinion.evidence[d]) ?? flagDetails(DIMENSION_FLAGS[d]).why;
  if (opinion.isCollage) evidence.collage = opinion.evidence.is_collage ?? flagDetails("collage").why;
  const legacy = legacyReasons(first.value, names);
  const reasons = [...(legacy.length ? legacy : flags.map(flag => evidence[flag]!)), ...opinion.missing];
  const secondModel = otherModel ?? secondPlan[0]?.model ?? null;
  return {scores,verdict:flags.length ? "flag" : "pass",reasons,isCollage:opinion.isCollage,usage:sumUsage(usages),costUsd,calls,model:judgeModel,route:judgeRoute.id,flags,view:opinion.view,thresholds,evidence,
    wrongItem:{first:wrongFirst,second:secondWrong,secondModel:wrongFirst ? secondModel : null,confirmed},
    leftover:{first:leftoverFirst,second:secondLeftover,secondModel:located ? secondModel : null,confirmed:leftoverConfirmed,located},opinions};
}
