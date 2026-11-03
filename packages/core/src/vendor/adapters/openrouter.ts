/**
 * The OpenRouter route adapter (M7-F2-R1): the one place outside `llm/` that reaches the OpenRouter transport.
 * Every judge and classifier call goes through it; the lint rule in eslint.config.js keeps it that way.
 */
import { callLlmJson, LLM_MAX_TOKENS, LlmJsonError, LlmResponseError, type LlmMessage } from "../../llm/llm";
import { OpenRouterError } from "../../llm/openrouter";
import type { OpenRouterDeps } from "../../llm/types";
import { sumUsage } from "../../llm/util";
import { qaCallCost } from "../../catalog/cost";
import type { RouteAttempt, RouteFailure } from "../router";

export interface OpenRouterCallDeps extends OpenRouterDeps {
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
/** One route attempt's answer, with its usage summed over every HTTP attempt (the JSON retry and each back-off retry). */
export type OpenRouterAttempt<T> = RouteAttempt<T> & {usage: Record<string, unknown>};

/** The failure kind of an OpenRouter or JSON error; `empty_reply` (no content, often a moderation refusal) is a refusal. */
export function failureOf(error: LlmResponseError | LlmJsonError | OpenRouterError): RouteFailure {
  const status = error instanceof OpenRouterError ? error.status : null;
  const kind = error instanceof OpenRouterError ? (status === 401 || status === 403 ? "auth" : status === 0 ? (/API_KEY is not set/.test(error.message) ? "no_key" : "no_response") : status === 429 ? "rate_limit" : (status ?? 0) >= 500 ? "server" : "http") : error instanceof LlmJsonError ? "invalid_json" : "empty_reply";
  return {status, kind, ...(kind === "empty_reply" ? {refusal: true} : {})};
}

/** Keep request accounting even when the JSON helper exhausts its retry and throws. */
export async function callCatalogJson<T>(messages: LlmMessage[], validate: (obj: Record<string, unknown>) => T, model: string, deps: OpenRouterCallDeps): Promise<OpenRouterAttempt<T>> {
  const usages: Record<string, unknown>[] = [];
  let calls = 0, costUsd = 0;
  const request = deps.fetch ?? globalThis.fetch;
  const tracked: typeof fetch = async (url, init) => {
    calls++;
    const response = await request(url, init);
    if (response.ok) {
      let body: {usage?: Record<string, unknown>} | undefined;
      try { body = await response.clone().json() as typeof body; } catch { /* The existing HTTP/JSON helper owns malformed response errors; the call is still priced. */ }
      usages.push(body?.usage ?? {});
      // Same reading as the worker's spend recording (qa-stage), so the returned cost matches spend_days.
      const spent = qaCallCost(body);
      costUsd += spent.costUsd;
      if (spent.estimated) (deps.log ?? console.info)(`catalog_qa: usage.cost absent; recorded the estimated price USD ${spent.costUsd} for this completion (prompt tokens ${spent.promptTokens}, completion tokens ${spent.completionTokens}).`);
    }
    return response;
  };
  let value: T | null, failure: RouteFailure | null = null;
  try {
    value = (await callLlmJson(messages, validate, {temperature:0,maxTokens:LLM_MAX_TOKENS,model}, {...deps,fetch:tracked})).value;
  } catch (error) {
    if (!(error instanceof LlmResponseError || error instanceof LlmJsonError || error instanceof OpenRouterError)) throw error;
    // Warn before the caller maps this to qa_unavailable, so a bad key, an auth failure or a timeout
    // is visible in the logs. The OpenRouter message is already redacted; prompts are never logged.
    failure = failureOf(error);
    (deps.log ?? console.warn)("catalog_qa: quality check unavailable", {severity:"WARNING", model, status:failure.status, kind:failure.kind, calls, error:error.message.slice(0, 300)});
    value = null;
  }
  return {value, usage:sumUsage(usages), costUsd, calls, failure};
}
