import { imageParts, textPart, LlmJsonError, type LlmMessage } from "../../llm/llm";
import { sumUsage } from "../../llm/util";
import { PRODUCT_TYPES, type ProductType, type OutputFlag } from "../types";
import { backoffRetry, callCatalogJson, qaImage, TRANSIENT, type CatalogLlmDeps } from "./judge";
import { PRODUCT_TYPE_TEMPLATE } from "./templates";
export const CATALOG_QA_DEFAULT_MODEL = "google/gemini-2.5-flash-lite";
export interface ClassifierDeps extends CatalogLlmDeps {
  model?: string; env?: NodeJS.ProcessEnv;
  /**
   * The second model (the batch policy's `qaModelSecond`), asked once when the first stays
   * rate-limited (or 5xx) through its back-off, before the product falls back to `type_unknown`.
   */
  secondModel?: string;
}
/**
 * One classification waits at most this long for 429/5xx back-off (about 5, 15 and 45 s, +/- 20%, or
 * Retry-After), on top of the shared per-delivery allowance in `deps.backoff` (07 4.3).
 */
export const CLASSIFIER_BACKOFF_BUDGET_MS = 120_000;
export interface ProductTypeResult {
  type: Exclude<ProductType, "auto">; confidence: number; usage: Record<string, unknown>; costUsd: number; calls: number;
  /** Product-level flags (`transparent`, `type_unknown`): the caller copies them to every photo of the product. */
  flags: OutputFlag[];
  /**
   * True when the classified photo is a size chart, measurement guide or other text-only image. It
   * describes that one photo, never the product, so it is not a flag: the caller should classify
   * the next photo for the product type and render this one without a cut-out (07 views amendment).
   * Optional so canned classifiers stay valid; absent means false.
   */
  chart?: boolean;
  /** The model that gave the type (the second model when the fallback was used); absent when none did. */
  model?: string;
}
type ClassifierReply = Record<string, unknown>;
export async function classifyProductType(image: Buffer, deps: ClassifierDeps = {}): Promise<ProductTypeResult> {
  const model = deps.model ?? (deps.env ?? process.env).CATALOG_QA_DEFAULT_MODEL ?? CATALOG_QA_DEFAULT_MODEL;
  const messages: LlmMessage[] = [{role:"system",content:PRODUCT_TYPE_TEMPLATE},{role:"user",content:[textPart("Classify the product in this photo."),...imageParts([await qaImage(image)])]}];
  const validate = (obj: ClassifierReply) => {
    if (typeof obj.type !== "string") throw new LlmJsonError("Product type missing", JSON.stringify(obj));
    return obj;
  };
  // A 429 or 5xx backs off like the judge (07 4.2): this classification's budget and the delivery's shared one.
  const budgets = [{remainingMs:CLASSIFIER_BACKOFF_BUDGET_MS}, ...(deps.backoff ? [deps.backoff] : [])];
  const ask = (id: string, delaysMs?: readonly number[]) => callCatalogJson(messages, validate, id, {...deps, retry:backoffRetry("catalog_qa: classifier back-off", id, budgets, deps, delaysMs)});
  let result = await ask(model), used = model;
  // Still rate-limited (or 5xx) after the back-off: the second model is asked once before the general rules are used.
  if (!result.value && result.failure && TRANSIENT.has(result.failure.kind) && deps.secondModel && deps.secondModel !== model) {
    const spent = result;
    const fallback = await ask(deps.secondModel, []);
    result = {...fallback, usage:sumUsage([spent.usage, fallback.usage]), costUsd:spent.costUsd + fallback.costUsd, calls:spent.calls + fallback.calls};
    (deps.log ?? console.warn)(fallback.value ? "catalog_qa: classifier unavailable; the second model gave the product type" : "catalog_qa: both classifier models unavailable; the general rules are used",
      {severity:"WARNING", model, fallbackModel:deps.secondModel, kind:spent.failure!.kind, status:spent.failure!.status, fallbackKind:fallback.failure?.kind ?? null, fallbackStatus:fallback.failure?.status ?? null, calls:result.calls});
    if (fallback.value) used = deps.secondModel;
  }
  const {value, usage, costUsd, calls} = result;
  if (!value) return {type:"other",confidence:0,usage,costUsd,calls,flags:["type_unknown"],chart:false};
  const type = PRODUCT_TYPES.find(t => t !== "auto" && t === value.type) as Exclude<ProductType,"auto"> | undefined;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? Math.max(0,Math.min(1,value.confidence)) : 0;
  return {type:type ?? "other",confidence,usage,costUsd,calls,flags:value.transparent === true ? ["transparent"] : [],chart:value.chart === true,model:used};
}
