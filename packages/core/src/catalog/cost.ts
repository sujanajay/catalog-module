import type { BatchCost, QaMode } from "./types";
export const QA_USD_PER_CHECK_ESTIMATE = 0.0013;
export const COMPUTE_SECONDS_PER_OUTPUT_ESTIMATE = 1.5;
/**
 * Default for the estimate's compute part when COMPUTE_USD_PER_VCPU_SECOND is unset (infra/deploy.sh
 * passes it to the worker only when the operator sets it). USD 0.000024 per vCPU-second is the
 * Cloud Run list price for CPU under request-based billing (Tier 1 regions); 09 replaces it with
 * the measured asia-south1 figure. Only the estimate uses this default: recorded compute spend
 * stays 0 until the env var is set (06 4.5).
 */
export const DEFAULT_COMPUTE_USD_PER_VCPU_SECOND = 0.000024;
/** Operator copy when no rupee rate is configured; never names the env var (spec 07 4.11). */
export const RUPEES_NOT_CONFIGURED = "Cost in rupees is not configured yet";
/** What one quality-check or classifier completion cost, as recorded in spend_days (07 4.5). */
export interface QaCallCost { costUsd:number; estimated:boolean; promptTokens:number; completionTokens:number }
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
/**
 * Reads the price of one successful OpenRouter chat completion from its JSON body. OpenRouter
 * always returns `usage` with token counts and, normally, `usage.cost` in USD (the amount it billed).
 * When the cost is missing or not a number, the call is priced at QA_USD_PER_CHECK_ESTIMATE and
 * marked `estimated` so the caller logs it: spend is never recorded as 0 for a billed completion.
 */
export function qaCallCost(body: unknown): QaCallCost {
 const usage = (body as {usage?: Record<string, unknown> | null} | null | undefined)?.usage ?? undefined;
 const reported = usage?.cost;
 const known = typeof reported === "number" && Number.isFinite(reported) && reported >= 0;
 return {costUsd:known ? reported : QA_USD_PER_CHECK_ESTIMATE,estimated:!known,promptTokens:count(usage?.prompt_tokens),completionTokens:count(usage?.completion_tokens)};
}
/**
 * Cost line amounts: USD with four decimals and INR with two, so a real but small spend (a judged
 * batch costs a fraction of a US cent per style) never reads as 0.00.
 */
export const usdAmount = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
export const inrAmount = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function positive(value: string | undefined): number | null {
 const number = value?.trim() ? Number(value) : NaN;
 return Number.isFinite(number) && number > 0 ? number : null;
}
interface CostBatch {
 cost: Pick<BatchCost,"qaUsd"|"computeUsd"|"identifiers">;
 products?: readonly {change:string;outputs:readonly {status:string}[]}[];
}
export function costLine(batch:CostBatch,env:NodeJS.ProcessEnv=process.env) {
 const usd = batch.cost.qaUsd+batch.cost.computeUsd;
 const identifiers = batch.products ? batch.products.filter(p => p.change !== "unchanged" && p.outputs.some(o => o.status !== "skipped")).length : batch.cost.identifiers;
 const usdPerIdentifier = identifiers > 0 ? usd/identifiers : null;
 const rate = positive(env.INR_PER_USD);
 const inrPerIdentifier = usdPerIdentifier !== null && rate !== null ? usdPerIdentifier*rate : null;
 const inr = rate !== null ? usd*rate : null;
 const text = usdPerIdentifier === null ? "Cost per style is not available yet" : inrPerIdentifier === null || inr === null ? `USD ${usdAmount(usdPerIdentifier)} per style so far · USD ${usdAmount(usd)} for this batch · ${RUPEES_NOT_CONFIGURED}` : `INR ${inrAmount(inrPerIdentifier)} per style so far · INR ${inrAmount(inr)} for this batch`;
 return {usd,inr,identifiers,usdPerIdentifier,inrPerIdentifier,text:`${text} · agency reference INR 60 per style`};
}
export interface EstimateCounts {
 outputs:number;sources:number;untypedProducts?:number;qaMode?:QaMode;qaSampleRate?:number;styliSkips?:number;unchangedPairs?:number;
}
export function estimateCost(counts:EstimateCounts,env:NodeJS.ProcessEnv=process.env) {
 const rate = positive(env.INR_PER_USD);
 if (rate === null) return null;
 const images = Math.max(0,counts.outputs-(counts.styliSkips ?? 0)-(counts.unchangedPairs ?? 0));
 const qaChecks = (counts.qaMode === "per_output" ? images : counts.sources)*(counts.qaSampleRate ?? 1)+(counts.untypedProducts ?? 0);
 const computeRate = positive(env.COMPUTE_USD_PER_VCPU_SECOND) ?? DEFAULT_COMPUTE_USD_PER_VCPU_SECOND;
 const usd = qaChecks*QA_USD_PER_CHECK_ESTIMATE+images*COMPUTE_SECONDS_PER_OUTPUT_ESTIMATE*2*computeRate;
 return {usd,inr:usd*rate,images,qaChecks};
}
