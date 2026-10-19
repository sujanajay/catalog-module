import sharp from "sharp";
import { callLlmJson, imageParts, textPart, LLM_MAX_TOKENS, LlmJsonError, LlmResponseError, type LlmMessage } from "../../llm/llm";
import { OpenRouterError } from "../../llm/openrouter";
import type { OpenRouterDeps } from "../../llm/types";
import { readCost, sumUsage } from "../../llm/util";
import { CHANNELS } from "../channels";
import type { ChannelId, OutputFlag, ProductType } from "../types";
import { CATALOG_QA_TEMPLATE, PRODUCT_TYPE_WORDS, renderTemplate } from "./templates";
import { flagDetails } from "./reasons";

export const QA_DEFAULT_THRESHOLD = 75;
export const QA_DEFAULT_FLOOR = 60;
/**
 * Stored score keys (`catalog_outputs.qa_scores`). `same_product` is not scored by the judge: it is
 * 0 only when both judges said `wrong_item` (a confirmed different item), else 100. Placement is
 * never judged; code checks it exactly (05), so `placement_ok` is no longer a dimension.
 */
export const QA_DIMENSIONS = ["complete_product", "same_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok"] as const;
export type QaDimension = typeof QA_DIMENSIONS[number];
export type QaScores = Record<QaDimension, number> & { overall: number };
/** Dimensions that describe the source photo (image 1): they apply to every channel of that photo. */
export const PHOTO_DIMENSIONS = ["complete_product", "same_product", "no_text_or_watermark", "orientation_ok"] as const satisfies readonly QaDimension[];
/** Dimensions that describe our rendered output (image 2 against image 1): judged per channel. */
export const OUTPUT_DIMENSIONS = ["edge_quality", "background_clean"] as const satisfies readonly QaDimension[];
export const DIMENSION_FLAGS: Record<QaDimension, OutputFlag> = {complete_product:"complete_product",same_product:"different_product",edge_quality:"halo",background_clean:"leftover_background",no_text_or_watermark:"text_or_watermark",orientation_ok:"orientation"};
export interface CatalogLlmDeps extends OpenRouterDeps { log?: (message: string) => void }

/**
 * Per-dimension pass lines from the resolved policy (no mean). Output dimensions use the policy
 * `threshold`: they are our own work. Photo dimensions use the lower `floor`: they describe the
 * brand's photo, where a false positive costs a photo.
 */
export function dimensionThresholds(threshold = QA_DEFAULT_THRESHOLD, floor = QA_DEFAULT_FLOOR): Record<QaDimension, number> {
  return {complete_product:floor,same_product:floor,no_text_or_watermark:floor,orientation_ok:floor,edge_quality:threshold,background_clean:threshold};
}
function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** `overall` is the weakest dimension: informational only, the verdict never averages. */
export const withOverall = (scores: Record<QaDimension, number>): QaScores => ({...scores, overall: Math.min(...QA_DIMENSIONS.map(d => scores[d]))});
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
  return QA_DIMENSIONS.filter(d => scores[d] < lines[d]).sort((a, b) => scores[a] - scores[b]);
}
export function verdictFor(scores: QaScores, threshold = QA_DEFAULT_THRESHOLD, floor = QA_DEFAULT_FLOOR): "pass" | "flag" {
  return failingDimensions(scores, threshold, floor).length ? "flag" : "pass";
}

/** Keep request accounting even when the JSON helper exhausts its retry and throws. */
export async function callCatalogJson<T>(messages: LlmMessage[], validate: (obj: Record<string, unknown>) => T, model: string, deps: CatalogLlmDeps) {
  const usages: Record<string, unknown>[] = [];
  let calls = 0;
  const request = deps.fetch ?? globalThis.fetch;
  const tracked: typeof fetch = async (url, init) => {
    calls++;
    const response = await request(url, init);
    if (response.ok) {
      try {
        const body = await response.clone().json() as {usage?: Record<string, unknown>};
        const usage = body.usage ?? {};
        usages.push(usage);
        if (readCost(usage) === null) (deps.log ?? console.info)("catalog_qa: usage.cost absent; recorded cost 0 for this completion.");
      } catch { /* The existing HTTP/JSON helper owns malformed response errors. */ }
    }
    return response;
  };
  let value: T | null;
  try {
    value = (await callLlmJson(messages, validate, {temperature:0,maxTokens:LLM_MAX_TOKENS,model}, {...deps,fetch:tracked})).value;
  } catch (error) {
    if (!(error instanceof LlmResponseError || error instanceof LlmJsonError || error instanceof OpenRouterError)) throw error;
    value = null;
  }
  return {value, usage:sumUsage(usages), costUsd:usages.reduce((sum, usage) => sum + Math.max(0, readCost(usage) ?? 0), 0), calls};
}

/** Resize only the judge's transmitted copy, leaving source and staged bytes untouched. */
export async function qaImage(bytes: Buffer) {
  return {mime:"image/jpeg", data:await sharp(bytes).rotate().resize(1536,1536,{fit:"inside",withoutEnlargement:true}).flatten({background:"white"}).jpeg({quality:90}).toBuffer()};
}
export interface JudgeInput {
  output: Buffer; original: Buffer; shotOne?: Buffer; channel: ChannelId; anchor: "centre" | "bottom-centre";
  productType: ProductType; identifier: string; n: number; model: string; threshold: number; floor: number;
  /** The second judge (`policy.qaModelSecond`), asked only when the first says `wrong_item`. */
  secondModel?: string;
}
/** One judge model's reading of one output. */
export interface JudgeOpinion {
  model: string; view: string | null; wrongItem: boolean; isCollage: boolean;
  scores: QaScores; evidence: Partial<Record<QaDimension | "wrong_item" | "is_collage", string>>;
}
export interface JudgeResult {
  scores: QaScores; verdict: "pass" | "flag"; reasons: string[]; isCollage: boolean;
  usage: Record<string, unknown>; costUsd: number; calls: number; model: string; flags: OutputFlag[];
  /** v2 fields below are optional so the canned judge and older mocks stay valid. */
  view?: string | null;
  thresholds?: Record<QaDimension, number>;
  /** The evidence sentence behind each flag, keyed by flag. */
  evidence?: Partial<Record<OutputFlag, string>>;
  /** The second opinion on `wrong_item`; `different_product` is set only when `confirmed`. */
  wrongItem?: { first: boolean; second: boolean | null; secondModel: string | null; confirmed: boolean };
  opinions?: JudgeOpinion[];
}
const VIEWS = ["front", "side", "back", "sole", "top", "inside", "detail", "on-model", "flat"];
function readOpinion(value: Record<string, unknown>, model: string, hasReference: boolean): JudgeOpinion & {missing: string[]} {
  const {scores, reasons: missing} = normalizeScores({...value, same_product: undefined});
  const raw = value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence) ? value.evidence as Record<string, unknown> : {};
  const evidence = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim()).map(([k, v]) => [k, v.trim()]));
  const view = typeof value.view === "string" && VIEWS.includes(value.view.trim().toLowerCase()) ? value.view.trim().toLowerCase() : null;
  // Without image 3 there is nothing to compare with, so the photo is never a different item.
  return {model, view, wrongItem: hasReference && value.wrong_item === true, isCollage: value.is_collage === true, scores, evidence, missing};
}
async function askJudge(input: JudgeInput, model: string, deps: CatalogLlmDeps) {
  const content = [textPart("Image 1: the source photo"), ...imageParts([await qaImage(input.original)]), textPart(`Image 2: the output we rendered from image 1 for ${CHANNELS[input.channel].label}`), ...imageParts([await qaImage(input.output)])];
  if (input.n > 1 && input.shotOne) content.push(textPart(`Image 3: photo 1 of the same product id (${input.identifier}), for reference only`), ...imageParts([await qaImage(input.shotOne)]));
  content.push(textPart("Return only the JSON object."));
  const system = renderTemplate(CATALOG_QA_TEMPLATE, {channel: CHANNELS[input.channel].label, productType: PRODUCT_TYPE_WORDS[input.productType] ?? PRODUCT_TYPE_WORDS.other!});
  return callCatalogJson([{role:"system",content:system},{role:"user",content}], obj => {
    if (!QA_DIMENSIONS.some(d => numeric(obj[d]) !== null)) throw new LlmJsonError("No numeric quality dimension", JSON.stringify(obj));
    return obj;
  }, model, deps);
}
/** Older replies carry a `reasons` array instead of `evidence`; keep them in their order. */
function legacyReasons(value: Record<string, unknown>): string[] {
  return Array.isArray(value.reasons) ? value.reasons.filter((r): r is string => typeof r === "string" && !!r.trim()).map(r => r.trim()) : [];
}
export async function judgeOutput(input: JudgeInput, deps: CatalogLlmDeps = {}): Promise<JudgeResult> {
  const hasReference = input.n > 1 && !!input.shotOne;
  const thresholds = dimensionThresholds(input.threshold, input.floor);
  const first = await askJudge(input, input.model, deps);
  if (!first.value) {
    const {usage, costUsd, calls} = first;
    return {scores:normalizeScores({}).scores,verdict:"flag",reasons:[flagDetails("qa_unavailable").why],isCollage:false,usage,costUsd,calls,model:input.model,flags:["qa_unavailable"],thresholds,opinions:[]};
  }
  const opinion = readOpinion(first.value, input.model, hasReference);
  const opinions: JudgeOpinion[] = [opinion];
  const usages = [first.usage];
  let costUsd = first.costUsd, calls = first.calls, second: boolean | null = null;
  // A different item holds the product, so a second model must agree before it counts (07 4.2 v2).
  if (opinion.wrongItem && input.secondModel) {
    const reply = await askJudge(input, input.secondModel, deps);
    usages.push(reply.usage); costUsd += reply.costUsd; calls += reply.calls;
    if (reply.value) { const other = readOpinion(reply.value, input.secondModel, hasReference); opinions.push(other); second = other.wrongItem; }
  }
  const confirmed = opinion.wrongItem && second === true;
  const scores = withOverall({...opinion.scores, same_product: confirmed ? 0 : 100});
  const failing = failingDimensions(scores, input.threshold, input.floor);
  const flags: OutputFlag[] = failing.map(d => DIMENSION_FLAGS[d]);
  if (opinion.isCollage) flags.push("collage");
  const evidence: Partial<Record<OutputFlag, string>> = {};
  for (const d of failing) evidence[DIMENSION_FLAGS[d]] = (d === "same_product" ? opinion.evidence.wrong_item : opinion.evidence[d]) ?? flagDetails(DIMENSION_FLAGS[d]).why;
  if (opinion.isCollage) evidence.collage = opinion.evidence.is_collage ?? flagDetails("collage").why;
  const legacy = legacyReasons(first.value);
  const reasons = [...(legacy.length ? legacy : flags.map(flag => evidence[flag]!)), ...opinion.missing];
  return {scores,verdict:flags.length ? "flag" : "pass",reasons,isCollage:opinion.isCollage,usage:sumUsage(usages),costUsd,calls,model:input.model,flags,view:opinion.view,thresholds,evidence,
    wrongItem:{first:opinion.wrongItem,second,secondModel:opinion.wrongItem ? input.secondModel ?? null : null,confirmed},opinions};
}
