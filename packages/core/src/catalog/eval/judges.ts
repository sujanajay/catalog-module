// Judge bake-off (spec 08 section 4.3 `judges`): every judge on every output of an eval batch, one
// catalog_eval_judgements row per (output, judge). Resumable: existing rows are skipped. The budget
// is estimated from each model's own price in the OpenRouter model listing, never one constant.
// Live calls are made only by the catalog-eval Cloud Run job with LIVE_SMOKE=1; tests inject fakes.
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogEvalJudgements, catalogOutputs, catalogProducts, catalogSourceImages } from "../../db/schema";
import { dailyCapFromEnv, recordCost, sumSpendForDay, utcDay } from "../../spend";
import { QA_DEFAULT_FLOOR, QA_DEFAULT_THRESHOLD, type CatalogLlmDeps, type judgeOutput } from "../qa/judge";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** Per check: three images at 1536 px plus the template and a short JSON reply, doubled for the retry. */
export const PROMPT_TOKENS_PER_CHECK = 6000, COMPLETION_TOKENS_PER_CHECK = 500, RETRY_FACTOR = 2;

export type PriceListing = Record<string, Record<string, string | number>>;
/** Parses the OpenRouter model listing body into model id -> pricing (USD per token). */
export function parsePriceListing(body: unknown): PriceListing {
  const rows = Array.isArray(body) ? body : (body as { data?: unknown[] })?.data ?? [];
  const out: PriceListing = {};
  for (const row of rows as { id?: string; pricing?: Record<string, string | number> }[]) if (row.id && row.pricing) out[row.id] = row.pricing;
  return out;
}
export async function fetchPriceListing(request: typeof fetch = fetch): Promise<PriceListing> {
  const response = await request(OPENROUTER_MODELS_URL);
  if (!response.ok) throw new Error(`The model price listing answered ${response.status}.`);
  return parsePriceListing(await response.json());
}
/** USD per check for one model from its own listing price. Throws when the listing has no price. */
export function usdPerCheck(model: string, listing: PriceListing): number {
  const pricing = listing[model];
  if (!pricing) throw new Error(`The price listing has no entry for judge ${model}.`);
  const price = (key: string) => Number(pricing[key] ?? 0) || 0;
  return (PROMPT_TOKENS_PER_CHECK * price("prompt") + COMPLETION_TOKENS_PER_CHECK * price("completion") + 3 * price("image") + price("request")) * RETRY_FACTOR;
}
/** Total and per-model estimate for `calls[model]` checks still to make. */
export function estimateJudgeCost(calls: Record<string, number>, listing: PriceListing) {
  const perModel = Object.fromEntries(Object.entries(calls).map(([model, n]) => [model, n * usdPerCheck(model, listing)]));
  return { totalUsd: Object.values(perModel).reduce((a, b) => a + b, 0), perModel };
}

export interface JudgesDeps {
  db: Db;
  downloadBuffer: (gsUri: string) => Promise<{ buf: Buffer }>;
  fetchPublic: (url: string) => Promise<Buffer>;
  judge: typeof judgeOutput;
  llm?: CatalogLlmDeps;
  now?: () => Date;
  log?: (message: string) => void;
}
export interface JudgesResult { estimateUsd: number; calls: number; skipped: number; spentUsd: number; stopped: string | null }

/** Outputs still to judge per model (the resumability check). */
export async function pendingJudgements(db: Db, batchId: string, models: readonly string[]) {
  const outputs = await db.select({ id: catalogOutputs.id }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batchId), ne(catalogOutputs.status, "skipped")));
  const existing = outputs.length ? await db.select({ outputId: catalogEvalJudgements.outputId, judgeModel: catalogEvalJudgements.judgeModel }).from(catalogEvalJudgements).where(inArray(catalogEvalJudgements.outputId, outputs.map(o => o.id))) : [];
  const done = new Set(existing.map(e => `${e.outputId}|${e.judgeModel}`));
  return Object.fromEntries(models.map(model => [model, outputs.filter(o => !done.has(`${o.id}|${model}`)).map(o => o.id)])) as Record<string, string[]>;
}

export async function runJudges(deps: JudgesDeps, input: { batchId: string; models: readonly string[]; budgetUsd: number; listing: PriceListing; env?: NodeJS.ProcessEnv }): Promise<JudgesResult> {
  const { db } = deps, now = deps.now ?? (() => new Date());
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, input.batchId));
  if (!batch || !batch.isTest || !batch.options.evalSet) throw new Error("Judges run only on eval test batches.");
  const pending = await pendingJudgements(db, batch.id, input.models);
  const estimate = estimateJudgeCost(Object.fromEntries(Object.entries(pending).map(([m, ids]) => [m, ids.length])), input.listing);
  const total = Object.values(pending).reduce((a, ids) => a + ids.length, 0);
  const skipped = (await db.select({ id: catalogOutputs.id }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batch.id), ne(catalogOutputs.status, "skipped")))).length * input.models.length - total;
  if (estimate.totalUsd > input.budgetUsd) return { estimateUsd: estimate.totalUsd, calls: 0, skipped, spentUsd: 0, stopped: `Estimated USD ${estimate.totalUsd.toFixed(4)} is above EVAL_BUDGET_USD ${input.budgetUsd}.` };
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batch.id));
  const products = await db.select().from(catalogProducts).where(inArray(catalogProducts.id, [...new Set(sources.map(s => s.productId))]));
  const cache = new Map<string, Buffer>();
  const bytes = async (uri: string) => { if (!cache.has(uri)) cache.set(uri, (await deps.downloadBuffer(uri)).buf); return cache.get(uri)!; };
  let calls = 0, spent = 0;
  for (const model of input.models) {
    const ids = pending[model] ?? [];
    if (!ids.length) continue;
    const outputs = await db.select().from(catalogOutputs).where(inArray(catalogOutputs.id, ids));
    for (const output of outputs) {
      const day = await sumSpendForDay(db, utcDay(now()));
      if (day + usdPerCheck(model, input.listing) > dailyCapFromEnv(input.env)) return { estimateUsd: estimate.totalUsd, calls, skipped, spentUsd: spent, stopped: "The daily spend cap is reached; run judges again tomorrow to resume." };
      if (spent + usdPerCheck(model, input.listing) > input.budgetUsd) return { estimateUsd: estimate.totalUsd, calls, skipped, spentUsd: spent, stopped: "EVAL_BUDGET_USD is used up; run judges again with a larger budget to resume." };
      const source = sources.find(s => s.id === output.sourceImageId)!;
      const product = products.find(p => p.id === output.productId)!;
      const shotOne = sources.filter(s => s.productId === product.id).sort((a, b) => a.n - b.n)[0];
      const made = output.stagingUri ? await bytes(output.stagingUri) : await deps.fetchPublic(output.publicUrl);
      const started = Date.now();
      const result = await deps.judge({
        output: made, original: await bytes(source.rawUri), ...(source.n > 1 && shotOne ? { shotOne: await bytes(shotOne.rawUri) } : {}),
        channel: output.channel, anchor: output.channel === "styli" ? "bottom-centre" : "centre", productType: product.productType ?? "other",
        identifier: product.identifier, n: output.n, model, threshold: QA_DEFAULT_THRESHOLD, floor: QA_DEFAULT_FLOOR,
      }, deps.llm);
      const ms = Date.now() - started;
      calls++; spent += result.costUsd;
      await recordCost(db, { brandSlug: batch.brandSlug, batchId: batch.id, engine: "catalog_qa", costUsd: result.costUsd, calls: result.calls, day: now() });
      await db.insert(catalogEvalJudgements).values({
        batchId: batch.id, outputId: output.id, judgeModel: model,
        scores: { ...result.scores, is_collage: result.isCollage, unavailable: result.flags.includes("qa_unavailable") },
        verdict: result.verdict, reasons: result.reasons, costUsd: result.costUsd, ms,
      }).onConflictDoNothing({ target: [catalogEvalJudgements.outputId, catalogEvalJudgements.judgeModel] });
    }
  }
  return { estimateUsd: estimate.totalUsd, calls, skipped, spentUsd: spent, stopped: null };
}
