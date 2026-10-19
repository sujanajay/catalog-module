// Eval run planning (spec 08 sections 4.3 and 4.4): the candidate matrix, the service choice by id
// and the forced policy of an eval batch. The pipeline execution itself lives in the worker CLI
// (apps/worker/src/catalog-eval.ts), which runs the same chunk and publish handlers as the worker.
import { QA_DEFAULT_FLOOR, QA_DEFAULT_THRESHOLD } from "../qa/judge";
import { CATALOG_QA_DEFAULT_MODEL } from "../qa/classify";
import type { ModelInfo } from "../matte";
import type { ResolvedPolicy } from "../types";
import type { MatteCandidate } from "./score";

/** The full matting matrix (section 4.4). Ids are engineering config, never shown to the operator. */
export const MATTE_CANDIDATES: readonly MatteCandidate[] = [
  { id: "birefnet-general", inputSize: 1024, gpuOnly: false, tier: "primary" },
  { id: "birefnet-general-lite", inputSize: 1024, gpuOnly: false, tier: "primary" },
  { id: "bria-rmbg", inputSize: 1024, gpuOnly: false, tier: "primary" },
  { id: "birefnet-hr-matting", inputSize: 2048, gpuOnly: true, tier: "primary" },
  { id: "birefnet-dynamic-matting", inputSize: "native", gpuOnly: false, tier: "primary" },
  { id: "ben2-base", inputSize: 1024, gpuOnly: false, tier: "primary" },
  { id: "inspyrenet-base", inputSize: 1024, gpuOnly: false, tier: "primary" },
  { id: "birefnet-hr", inputSize: 2048, gpuOnly: true, tier: "secondary" },
  { id: "birefnet-hrsod", inputSize: 1024, gpuOnly: false, tier: "secondary" },
  { id: "rmbg-1.4", inputSize: 1024, gpuOnly: false, tier: "secondary" },
];
/** Section 4.9 default for CATALOG_QA_CANDIDATES (the full judge bake-off). */
export const DEFAULT_QA_CANDIDATES = [
  "google/gemini-2.5-flash-lite", "google/gemini-2.5-flash", "google/gemini-3.5-flash-lite",
  "qwen/qwen3-vl-30b-a3b-instruct", "qwen/qwen3-vl-8b-instruct", "anthropic/claude-haiku-5.5",
] as const;
export function qaCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = env.CATALOG_QA_CANDIDATES?.split(",").map(s => s.trim()).filter(Boolean);
  return list?.length ? list : [...DEFAULT_QA_CANDIDATES];
}

/**
 * `--matte primary | all | <id>[,<id>...]`. EVAL_MATTE_CANDIDATES (comma ids) replaces the
 * primary list, so the full matrix is a config change, not a code change.
 */
export function matteModelsFor(arg: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.EVAL_MATTE_CANDIDATES?.split(",").map(s => s.trim()).filter(Boolean);
  if (arg === "primary") return configured?.length ? configured : MATTE_CANDIDATES.filter(c => c.tier === "primary").map(c => c.id);
  if (arg === "all") return MATTE_CANDIDATES.map(c => c.id);
  return arg.split(",").map(s => s.trim()).filter(Boolean);
}

export type ServiceChoice = { ok: true; target: "cpu" | "gpu"; inputSize: number | "native" } | { ok: false; reason: string };
/**
 * The worker's rule: send a model to the service that lists it, preferring gpu. A GPU-only candidate
 * without MATTING_GPU_URL is "not run: no GPU service"; an id no service lists is reported, never
 * dropped silently.
 */
export function chooseService(model: string, listed: readonly ModelInfo[], gpuConfigured: boolean): ServiceChoice {
  const candidate = MATTE_CANDIDATES.find(c => c.id === model);
  if (candidate?.gpuOnly && !gpuConfigured) return { ok: false, reason: "not run: no GPU service" };
  const entries = listed.filter(m => m.id === model);
  const gpu = entries.find(m => m.target === "gpu"), cpu = entries.find(m => m.target === "cpu");
  if (gpu) return { ok: true, target: "gpu", inputSize: gpu.inputSize };
  if (cpu) return { ok: true, target: "cpu", inputSize: cpu.inputSize };
  return { ok: false, reason: "not run: not loaded by the matting services" };
}

/** The forced policy of an eval batch: source manual, per_output QA, 07's default threshold and floor. */
export function forcedPolicy(matteModel: string, matteTarget: "cpu" | "gpu", qaModel: string = CATALOG_QA_DEFAULT_MODEL): ResolvedPolicy {
  return { matteModel, matteTarget, qaModel, threshold: QA_DEFAULT_THRESHOLD, floor: QA_DEFAULT_FLOOR, qaMode: "per_output", qaSampleRate: 1, source: "manual" };
}
