import { CATALOG_QA_DEFAULT_MODEL } from "@catalog/core/catalog/qa/classify";
import { DEFAULT_POLICIES } from "@catalog/core/catalog/qa/policy";

// Spec 07: no model or provider name in any page, API response or export. The chosen models stay
// in the database, the stored report, the eval job and PROGRESS.md; anything served to the
// operator from those records goes through withoutModelNames first, so a new field cannot leak.

/** Model families and providers (spec 07 section 8), plus every candidate id the default policy names. */
const FAMILIES = /birefnet|rmbg|bria|inspyre|ben_custom|esrgan|swinir|gemini|claude|qwen|llama|mistral|openrouter|gpt-|openai\/|anthropic\/|google\//;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CANDIDATE_IDS = [...new Set([CATALOG_QA_DEFAULT_MODEL, ...Object.values(DEFAULT_POLICIES).flatMap(p => [p.matteModel, p.matteModelSecond, p.qaModel, p.qaModelSecond])])]
  .filter((id): id is string => !!id).map(escape);
const NAME = [FAMILIES.source, ...CANDIDATE_IDS].join("|");
/** True when the text names a model or a model provider. */
export const MODEL_NAME = new RegExp(NAME, "i");
/** A whole model id token, such as a provider/model path with an optional ":variant" suffix. */
const MODEL_TOKEN = new RegExp(String.raw`[\w./-]*(?:${NAME})[\w./-]*(?::\w[\w.-]*)?`, "gi");

/** Fields that hold a model id, shown as the role the model played instead. */
const ROLE_LABELS: Record<string, string> = {
  model: "quality check",
  qaModel: "quality check",
  judgeModel: "quality check",
  secondModel: "second opinion",
  qaModelSecond: "second opinion",
  matteModel: "cut-out",
  matteModelSecond: "second cut-out",
};
/** Operator data (names, identifiers, links) is kept as uploaded even if it happens to contain a family name. */
const OPERATOR_DATA = new Set(["batchId", "brand", "brandName", "identifier", "pathKey", "optionIdStyleColor", "opptraSkuIds", "unresolvedIdentifiers",
  "originalName", "relativePath", "sourceUrl", "rawUri", "url", "sha256", "exports"]);

/**
 * A copy of an export payload with no model or provider name in it. Known model fields become the
 * role label ("quality check", "cut-out"); any other string that names a model has each id replaced
 * by "model A", "model B" and so on, consistently within one payload. Scores, thresholds, evidence,
 * actions and costs are kept.
 */
export function withoutModelNames<T>(payload: T): T {
  const aliases = new Map<string, string>();
  const alias = (id: string) => {
    const key = id.toLowerCase();
    if (!aliases.has(key)) aliases.set(key, `model ${aliasLetter(aliases.size)}`);
    return aliases.get(key)!;
  };
  const text = (s: string) => MODEL_NAME.test(s) ? s.replace(MODEL_TOKEN, alias) : s;
  const walk = (value: unknown, key: string | null): unknown => {
    if (key !== null && OPERATOR_DATA.has(key)) return value;
    if (typeof value === "string") return key !== null && key in ROLE_LABELS && value ? ROLE_LABELS[key] : text(value);
    if (Array.isArray(value)) return value.map(v => walk(v, null));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), walk(v, k)]));
    }
    return value;
  };
  return walk(payload, null) as T;
}

function aliasLetter(n: number): string {
  return n < 26 ? String.fromCharCode(65 + n) : `${aliasLetter(Math.floor(n / 26) - 1)}${String.fromCharCode(65 + (n % 26))}`;
}
