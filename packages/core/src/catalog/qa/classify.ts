import { imageParts, textPart, LlmJsonError, type LlmMessage } from "../../llm/llm";
import { sumUsage } from "../../llm/util";
import { PRODUCT_TYPES, type ProductType, type OutputFlag } from "../types";
import { backoffRetry, callCatalogJson, qaImage, type CatalogLlmDeps } from "./judge";
import { callRoutes, fallbackLogFields, planRoutes } from "../../vendor/router";
import { PRODUCT_TYPE_TEMPLATE } from "./templates";
export const CATALOG_QA_DEFAULT_MODEL = "google/gemini-2.5-flash-lite";
export interface ClassifierDeps extends CatalogLlmDeps {
  model?: string; env?: NodeJS.ProcessEnv;
  /**
   * The second model (the batch policy's `qaModelSecond`), asked once when the first fails (rate limit or 5xx through
   * its back-off, timeout, invalid reply, refusal), before the other `vision.read` routes and `type_unknown`.
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
  /** The `vision.read` route that gave the type (M7-F2-R6); absent when none did. Internal: never operator text. */
  route?: string;
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
  // M7-F2: the model and the policy's second first, then every other serving `vision.read` route (the classifier is the
  // first reading of a photo); a switched-off route is not asked. The first route asked gets the back-off, the later
  // ones are asked once, before the general rules are used.
  const plan = planRoutes(deps.router, "vision.read", [model, deps.secondModel]);
  const answer = await callRoutes(plan, (route, index) => ask(route.model, index === 0 ? undefined : []), deps.router ? {router:deps.router} : {});
  const result = {value:answer.output, usage:sumUsage(answer.usages), costUsd:answer.costUsd, calls:answer.calls};
  if (answer.tried.length > 1 || !plan.length) {
    (deps.log ?? console.warn)(!plan.length ? "catalog_qa: no classifier route available; the general rules are used" : answer.ok ? "catalog_qa: classifier unavailable; the second model gave the product type" : "catalog_qa: both classifier models unavailable; the general rules are used", fallbackLogFields(plan, answer, model));
  }
  const {value, usage, costUsd, calls} = result;
  if (!value) return {type:"other",confidence:0,usage,costUsd,calls,flags:["type_unknown"],chart:false};
  const type = PRODUCT_TYPES.find(t => t !== "auto" && t === value.type) as Exclude<ProductType,"auto"> | undefined;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? Math.max(0,Math.min(1,value.confidence)) : 0;
  return {type:type ?? "other",confidence,usage,costUsd,calls,flags:value.transparent === true ? ["transparent"] : [],chart:value.chart === true,model:answer.route!.model,route:answer.route!.id};
}
