import sharp from "sharp";
import { callLlmJson, imageParts, textPart, LLM_MAX_TOKENS, LlmJsonError, LlmResponseError, type LlmMessage } from "../../llm/llm";
import { OpenRouterError } from "../../llm/openrouter";
import type { OpenRouterDeps } from "../../llm/types";
import { readCost, sumUsage } from "../../llm/util";
import { CHANNELS } from "../channels";
import type { ChannelId, OutputFlag, ProductType } from "../types";
import { CATALOG_QA_TEMPLATE, renderTemplate } from "./templates";
import { flagDetails } from "./reasons";

export const QA_DEFAULT_THRESHOLD = 75;
export const QA_DEFAULT_FLOOR = 60;
export const QA_DIMENSIONS = ["complete_product", "same_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok", "placement_ok"] as const;
export type QaDimension = typeof QA_DIMENSIONS[number];
export type QaScores = Record<QaDimension, number> & { overall: number };
export const DIMENSION_FLAGS: Record<QaDimension, OutputFlag> = {complete_product:"complete_product",same_product:"different_product",edge_quality:"halo",background_clean:"leftover_background",no_text_or_watermark:"text_or_watermark",orientation_ok:"orientation",placement_ok:"placement"};
export interface CatalogLlmDeps extends OpenRouterDeps { log?: (message: string) => void }

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function normalizeScores(raw: Record<string, unknown>): {scores: QaScores; reasons: string[]} {
  const reasons: string[] = [];
  const values = QA_DIMENSIONS.map(dimension => {
    const value = numeric(raw[dimension]);
    if (value === null) reasons.push(`The quality check did not provide a score for ${dimension.replaceAll("_", " ")}.`);
    return [dimension, value === null ? 0 : Math.max(0, Math.min(100, value))] as const;
  });
  return {scores: {...Object.fromEntries(values), overall: values.reduce((sum, [,value]) => sum + value, 0) / QA_DIMENSIONS.length} as QaScores, reasons};
}
export function verdictFor(scores: QaScores, threshold = QA_DEFAULT_THRESHOLD, floor = QA_DEFAULT_FLOOR): "pass" | "flag" {
  return scores.overall >= threshold && scores.complete_product >= floor && scores.same_product >= floor ? "pass" : "flag";
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
}
export async function judgeOutput(input: JudgeInput, deps: CatalogLlmDeps = {}) {
  const content = [textPart("Image 1: the original photo"), ...imageParts([await qaImage(input.original)]), textPart(`Image 2: the image we made for ${CHANNELS[input.channel].label}`), ...imageParts([await qaImage(input.output)])];
  if (input.n > 1 && input.shotOne) content.push(textPart(`Image 3: photo 1 of the same product (${input.identifier})`), ...imageParts([await qaImage(input.shotOne)]));
  content.push(textPart("Return only the JSON object."));
  const result = await callCatalogJson([{role:"system",content:renderTemplate(CATALOG_QA_TEMPLATE,{anchor:input.anchor,channel:CHANNELS[input.channel].label})},{role:"user",content}], obj => {
    if (!QA_DIMENSIONS.some(d => numeric(obj[d]) !== null)) throw new LlmJsonError("No numeric quality dimension", JSON.stringify(obj));
    return obj;
  }, input.model, deps);
  const {value, ...accounting} = result;
  if (!value) return {scores:normalizeScores({}).scores,verdict:"flag" as const,reasons:[flagDetails("qa_unavailable").why],isCollage:false,...accounting,model:input.model,flags:["qa_unavailable"] as OutputFlag[]};
  const {scores,reasons:missing} = normalizeScores(value);
  const flags = QA_DIMENSIONS.filter(d => scores[d] < input.threshold).sort((a,b) => scores[a]-scores[b]).map(d => DIMENSION_FLAGS[d]);
  const isCollage = value.is_collage === true;
  if (isCollage) flags.push("collage");
  const modelReasons = Array.isArray(value.reasons) ? value.reasons.filter((r): r is string => typeof r === "string" && !!r.trim()).map(r => r.trim()) : [];
  const reasons = [...modelReasons,...missing];
  if (!reasons.length) reasons.push(...flags.map(flag => flagDetails(flag).why));
  return {scores,verdict:isCollage ? "flag" as const : verdictFor(scores,input.threshold,input.floor),reasons,isCollage,...accounting,model:input.model,flags};
}
