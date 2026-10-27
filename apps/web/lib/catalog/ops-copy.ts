// Pure copy for the admin Ops page, the batch page's cost split and the Details tab additions. No React
// and no database here, so vitest covers it in the node environment. Engines and steps are named by what
// they do ("cut-out", "image making", "quality check"), never by a model id.
import { inrAmount, usdAmount } from "@catalog/core/catalog/cost";
import type { CostStage } from "@catalog/core/db/schema";
import type { BatchStatus } from "@catalog/core/catalog/types";
import type { StageCost } from "@catalog/core/catalog/cost-report";
import { plural } from "./copy";

export const OPS_TITLE = "Ops";
export const OPS_HREF = "/catalog/ops";
export const AGENCY_REFERENCE = "agency reference INR 60 per style";
export const OPS_REFRESH_MS = 30_000;
/** GCP project the Logs Explorer link opens (AGENTS.md). */
export const LOGS_PROJECT = "image-links-agent";

/** Batch statuses that mean work is in flight; the Ops page lists these as active. */
export const ACTIVE_STATUSES = ["ingesting", "matting", "rendering", "qa", "publishing"] as const satisfies readonly BatchStatus[];

const STATUS_WORDS: Record<BatchStatus, string> = {
  draft: "Draft",
  ingesting: "Collecting files",
  matting: "Cutting out",
  rendering: "Making images",
  qa: "Quality check",
  publishing: "Publishing",
  done: "Done",
  failed: "Could not start",
  cancelled: "Cancelled",
};
export function statusWord(status: BatchStatus): string {
  return STATUS_WORDS[status];
}

/** A chunk's stage (catalog_chunks.stage) in plain words. */
export const CHUNK_STAGE_WORDS = { matte: "cut-out", render: "image making", qa: "quality check" } as const;
const CHUNK_STATUS_WORDS = { queued: "waiting", running: "running", done: "done", failed: "gave up" } as const;
export type ChunkStage = keyof typeof CHUNK_STAGE_WORDS;
export type ChunkStatus = keyof typeof CHUNK_STATUS_WORDS;
export interface ChunkCount { stage: ChunkStage; status: ChunkStatus; chunks: number }

/**
 * "cut-out: 2 waiting, 1 running · image making: 3 done" in stage order; empty when there are no chunks.
 * A chunk moves through the stages, so each chunk is counted once, at the stage it is at now.
 */
export function chunkProgressText(counts: readonly ChunkCount[]): string {
  const stages = Object.keys(CHUNK_STAGE_WORDS) as ChunkStage[];
  const statuses = Object.keys(CHUNK_STATUS_WORDS) as ChunkStatus[];
  return stages.flatMap((stage) => {
    const parts = statuses.flatMap((status) => {
      const n = counts.filter((c) => c.stage === stage && c.status === status).reduce((sum, c) => sum + c.chunks, 0);
      return n ? [`${n} ${CHUNK_STATUS_WORDS[status]}`] : [];
    });
    return parts.length ? [`${CHUNK_STAGE_WORDS[stage]}: ${parts.join(", ")}`] : [];
  }).join(" · ");
}

export function chunkTotal(counts: readonly ChunkCount[]): number {
  return counts.reduce((sum, c) => sum + c.chunks, 0);
}

/** "USD 0.1234 (INR 10.37)", or USD only without a rupee rate. */
export function money(usd: number, inrPerUsd: number | null): string {
  return inrPerUsd === null ? `USD ${usdAmount(usd)}` : `USD ${usdAmount(usd)} (INR ${inrAmount(usd * inrPerUsd)})`;
}

/** The batch page's three steps; every ledger stage belongs to one, so the parts add up to the ledger total. */
const STEP_OF: Record<CostStage, "cut-out" | "images" | "quality checks"> = {
  matte: "cut-out",
  render: "images",
  upscale: "images",
  publish: "images",
  finalize: "images",
  qa: "quality checks",
  classify: "quality checks",
};
const STEPS = ["cut-out", "images", "quality checks"] as const;

/** The ledger cost of one batch per step; the parts add up to `usd`. */
export function fullCostParts(stages: readonly StageCost[]): { usd: number; parts: { step: (typeof STEPS)[number]; usd: number }[] } {
  const parts = STEPS.map((step) => ({ step, usd: stages.filter((s) => STEP_OF[s.stage] === step).reduce((sum, s) => sum + s.usd, 0) }));
  return { usd: parts.reduce((sum, p) => sum + p.usd, 0), parts };
}

/**
 * "Full cost including the cut-out service: INR 3.70 (cut-out INR 1.20, images INR 0.40, quality checks
 * INR 2.10)" from batchCostByStage; USD with four decimals when no rupee rate is set. It sits under the
 * cost line, which counts quality checks and worker time only. Null for a batch with no ledger rows
 * (batches from before the ledger), so the page shows nothing rather than zeros.
 */
export function fullCostText(stages: readonly StageCost[], inrPerUsd: number | null): string | null {
  if (!stages.length) return null;
  const amount = (usd: number) => (inrPerUsd === null ? `USD ${usdAmount(usd)}` : `INR ${inrAmount(usd * inrPerUsd)}`);
  const { usd, parts } = fullCostParts(stages);
  return `Full cost including the cut-out service: ${amount(usd)} (${parts.map((p) => `${p.step} ${amount(p.usd)}`).join(", ")})`;
}

/** A ledger stage in plain words, for the Ops page's per-stage table. */
export const COST_STAGE_WORDS: Record<CostStage, string> = {
  matte: "cut-out",
  render: "image making",
  upscale: "enlarging",
  qa: "quality check",
  classify: "product type check",
  publish: "publishing",
  finalize: "finishing",
};

/** Logs Explorer looks back this far, so a batch from earlier in the week still shows its lines. */
export const LOGS_DURATION = "P7D";
/** Logs Explorer filtered on the batch label the log helper sets (logging.googleapis.com/labels.batchId), last 7 days. */
export function logsUrl(batchId: string): string {
  return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(`labels.batchId="${batchId}"`)};duration=${LOGS_DURATION}?project=${LOGS_PROJECT}`;
}

/** Shown in place of a cost table whose read timed out or failed. */
export const REPORT_UNAVAILABLE = "Could not read the totals right now. Try again in a few minutes.";

/** "Chunk 4 (cut-out) gave up: <reason>." for a chunk that stopped after repeated errors. */
export function chunkGaveUpText(chunk: { index: number; stage: ChunkStage; error: string | null }): string {
  const reason = (chunk.error ?? "no reason was recorded").trim().replace(/[.]+$/, "");
  return `Chunk ${chunk.index + 1} (${CHUNK_STAGE_WORDS[chunk.stage]}) gave up after repeated errors: ${reason}.`;
}

/** The hints next to a product or image on the Ops page: only the counts that say something. */
export function hintText(h: { matteExtraCalls: number; judgeCalls: number; upscaleCalls: number }): string {
  const parts = [
    h.matteExtraCalls ? `${h.matteExtraCalls} extra cut-out ${plural(h.matteExtraCalls, "call", "calls")}` : "",
    h.judgeCalls ? `${h.judgeCalls} quality ${plural(h.judgeCalls, "check", "checks")}` : "",
    h.upscaleCalls ? `${h.upscaleCalls} ${plural(h.upscaleCalls, "enlargement", "enlargements")}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}
