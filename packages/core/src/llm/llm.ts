// One place that talks to OpenRouter chat completions for the QA judge and the product-type
// classifier (07), plus a defensive JSON parser for model output. The model is always passed in by
// the caller (chosen by model_policy); there is no default model and no model env var here.
import { chatCompletion, type ChatCompletionResponse } from "./openrouter";
import type { OpenRouterDeps } from "./types";
import { readCost, refsToImageParts, sumUsage, type ImageRef } from "./util";

/**
 * Output cap for LLM calls. Generous on purpose: reasoning tokens count against max_tokens, and a
 * low cap intermittently returns an empty response (finish_reason "length").
 */
export const LLM_MAX_TOKENS = 4000;

export type LlmImage = ImageRef;

export type LlmContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmResult {
  text: string;
  usage: Record<string, unknown>;
  costUsd: number;
  model: string;
}

export interface LlmCallOptions {
  /** Required: chosen by model_policy (07). */
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/** The LLM answered, but with nothing usable (no choices or empty content). */
export class LlmResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseError";
  }
}

/** Model output could not be turned into the expected JSON object. */
export class LlmJsonError extends Error {
  /** First ~300 chars of the offending text. */
  readonly snippet: string;
  constructor(message: string, text: string) {
    const snippet = text.length > 300 ? `${text.slice(0, 300)}...` : text;
    super(`${message}: ${JSON.stringify(snippet)}`);
    this.name = "LlmJsonError";
    this.snippet = snippet;
  }
}

/** Image parts as data URLs, in the given order. */
export function imageParts(images: LlmImage[]): LlmContentPart[] {
  return refsToImageParts(images);
}

export const textPart = (text: string): LlmContentPart => ({ type: "text", text });

function responseText(res: ChatCompletionResponse): string {
  const content = res.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One chat completion. Returns text, usage and cost (usage.cost, 0 when absent). Throws when no model is given. */
export async function callLlm(messages: LlmMessage[], opts: LlmCallOptions, deps?: OpenRouterDeps): Promise<LlmResult> {
  const model = opts?.model?.trim();
  if (!model) throw new Error("callLlm: a model is required (it comes from model_policy)");
  const body: Record<string, unknown> = { model, messages, usage: { include: true } };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  const res = await chatCompletion<ChatCompletionResponse>(body, deps);
  const usage = (res.usage ?? {}) as Record<string, unknown>;
  const cost = readCost(usage) ?? 0;
  const text = responseText(res);
  if (!text.trim()) {
    const reason = res.choices?.[0]?.finish_reason ?? res.error?.message ?? "no content";
    throw new LlmResponseError(`LLM (${model}) returned an empty response (${reason})`);
  }
  return { text, usage, costUsd: cost, model };
}

export const JSON_NUDGE =
  "Your previous reply was not valid JSON. Return only valid JSON: a single JSON object matching the requested shape, " +
  "with no markdown fences, no comments and no text before or after it.";

export interface LlmJsonResult<T> {
  value: T;
  text: string;
  usage: Record<string, unknown>;
  costUsd: number;
  /** Number of completions made (1 or 2). */
  calls: number;
}

/**
 * Chat completion expected to return a JSON object. On a parse (or `validate`) failure, retries once
 * with the bad reply in context and a "return only valid JSON" nudge. Cost and usage cover every call.
 * `validate` returns the typed value or throws (any error counts as a failure worth one retry).
 */
export async function callLlmJson<T = Record<string, unknown>>(
  messages: LlmMessage[],
  validate: (obj: Record<string, unknown>) => T,
  opts: LlmCallOptions,
  deps?: OpenRouterDeps,
): Promise<LlmJsonResult<T>> {
  const results: LlmResult[] = [];
  const attempt = (r: LlmResult): T => validate(parseJsonLoose(r.text));
  const first = await callLlm(messages, opts, deps);
  results.push(first);
  let value: T;
  try {
    value = attempt(first);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const retry = await callLlm(
      [
        ...messages,
        { role: "assistant", content: first.text },
        { role: "user", content: `${JSON_NUDGE}\nProblem: ${reason.slice(0, 300)}` },
      ],
      opts,
      deps,
    );
    results.push(retry);
    value = attempt(retry);
  }
  return combine(results, value);
}

export function combine<T>(results: LlmResult[], value: T): LlmJsonResult<T> {
  const last = results[results.length - 1]!;
  const { usage, costUsd } = addCosts(results);
  return { value, text: last.text, usage, costUsd, calls: results.length };
}

/** Sum the cost and usage of several results. */
export function addCosts(
  parts: { usage: Record<string, unknown>; costUsd: number }[],
): { usage: Record<string, unknown>; costUsd: number } {
  if (parts.length === 1) return { usage: parts[0]!.usage, costUsd: parts[0]!.costUsd };
  return { usage: sumUsage(parts.map((p) => p.usage)), costUsd: parts.reduce((s, p) => s + p.costUsd, 0) };
}

// ---------------------------------------------------------------------------
// parseJsonLoose
// ---------------------------------------------------------------------------

/** Index just past the balanced object starting at `start` (text[start] === "{"), or -1. String-aware. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Remove commas that directly precede `}` or `]` (outside strings). */
function stripTrailingCommas(json: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      if (json[j] === "}" || json[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function firstObject(text: string): Record<string, unknown> | undefined {
  let from = 0;
  for (;;) {
    const start = text.indexOf("{", from);
    if (start < 0) return undefined;
    const end = balancedEnd(text, start);
    if (end > 0) {
      const candidate = text.slice(start, end);
      for (const c of [candidate, stripTrailingCommas(candidate)]) {
        try {
          const v: unknown = JSON.parse(c);
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          /* try next form */
        }
      }
    }
    from = start + 1;
  }
}

/**
 * Lenient JSON-object extraction from LLM output: strips ``` fences and surrounding prose, takes the
 * first balanced `{...}` that parses, tolerating trailing commas. Throws LlmJsonError otherwise.
 */
export function parseJsonLoose(text: string): Record<string, unknown> {
  const raw = text ?? "";
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const candidates: string[] = [];
  for (const m of src.matchAll(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g)) candidates.push(m[1] ?? "");
  candidates.push(src);
  for (const c of candidates) {
    const obj = firstObject(c);
    if (obj) return obj;
  }
  throw new LlmJsonError("Could not parse a JSON object from LLM output", src.trim());
}
