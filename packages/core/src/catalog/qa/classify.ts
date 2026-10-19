import { imageParts, textPart, LlmJsonError } from "../../llm/llm";
import { PRODUCT_TYPES, type ProductType, type OutputFlag } from "../types";
import { callCatalogJson, qaImage, type CatalogLlmDeps } from "./judge";
import { PRODUCT_TYPE_TEMPLATE } from "./templates";
export const CATALOG_QA_DEFAULT_MODEL = "google/gemini-2.5-flash-lite";
export interface ClassifierDeps extends CatalogLlmDeps { model?: string; env?: NodeJS.ProcessEnv }
export async function classifyProductType(image: Buffer, deps: ClassifierDeps = {}) {
  const model = deps.model ?? (deps.env ?? process.env).CATALOG_QA_DEFAULT_MODEL ?? CATALOG_QA_DEFAULT_MODEL;
  const result = await callCatalogJson([{role:"system",content:PRODUCT_TYPE_TEMPLATE},{role:"user",content:[textPart("Classify the product in this photo."),...imageParts([await qaImage(image)])]}], obj => {
    if (typeof obj.type !== "string") throw new LlmJsonError("Product type missing", JSON.stringify(obj));
    return obj;
  }, model, deps);
  const {value,...accounting} = result;
  if (!value) return {type:"other" as const,confidence:0,...accounting,flags:["type_unknown"] as OutputFlag[]};
  const type = PRODUCT_TYPES.find(t => t !== "auto" && t === value.type) as Exclude<ProductType,"auto"> | undefined;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? Math.max(0,Math.min(1,value.confidence)) : 0;
  return {type:type ?? "other",confidence,...accounting,flags:[] as OutputFlag[]};
}
