import type { BatchCost, QaMode } from "./types";
/**
 * Wizard step 4 estimate of one quality check or classifier call: measured USD 0.00014 per check on
 * 2026-10-20 with the default judge (batch b489e466: 52 calls, USD 0.0072398), doubled.
 */
export const QA_USD_PER_CHECK_ESTIMATE = 0.0003;
/**
 * What a billed completion is recorded at when OpenRouter returns no usable `usage.cost`. Kept at the
 * dearest candidate judge's list price (spec 07: up to about USD 0.0013 per check) so a missing cost
 * never under-records spend against the daily cap, whichever judge the policy picked.
 */
export const QA_USD_PER_CHECK_FALLBACK = 0.0013;
/**
 * vCPU-seconds the worker spends per planned output, for the estimate: measured on batch b489e466
 * on 2026-10-20 (2023 vCPU-seconds recorded in cost.computeVcpuSeconds for 468 planned outputs,
 * 2023 / 468 = 4.32), rounded to 4.3. vCPU-seconds are wall seconds times the worker's --cpu (2).
 */
export const COMPUTE_VCPU_SECONDS_PER_OUTPUT_ESTIMATE = 4.3;
/**
 * Effective USD per worker vCPU-second, CPU and memory together. Must match the default of
 * COMPUTE_USD_PER_VCPU_SECOND in infra/deploy.sh, which the worker records spend with; this code
 * default is used only by the estimate when the env var is missing.
 * Source: cloud.google.com/run/pricing, read 2026-10-20. asia-south1 (Mumbai) is a Tier 1 region
 * (Cloud Run release notes, 2024-11-15). The worker uses request-based billing (the default; no
 * --no-cpu-throttling), Tier 1 list prices: CPU USD 0.000024 per vCPU-second, memory USD 0.0000025
 * per GiB-second active time (instance-based would be 0.000018 and 0.000002; Tier 2 is 0.0000336
 * and 0.0000035).
 * Worker shape --cpu=2 --memory=2Gi, so each vCPU carries 1 GiB:
 *   per wall second  = 2 * 0.000024 + 2 * 0.0000025 = 0.000053
 *   per vCPU-second  = 0.000053 / 2 = 0.000024 + 1 * 0.0000025 = 0.0000265
 * Ignores the monthly free tier and the USD 0.40 per million requests fee (both negligible here).
 */
export const DEFAULT_COMPUTE_USD_PER_VCPU_SECOND = 0.0000265;
/**
 * USD per second of the CPU matting service (catalog-matting, asia-south1, --cpu=4 --memory=16Gi,
 * concurrency 1, request-based billing because deploy.sh sets no --no-cpu-throttling). Must match
 * PRICE_MATTE_CPU_USD_PER_SECOND in infra/deploy.sh; this default is used when the env var is missing.
 * Source: cloud.google.com/run/pricing, read 2026-10-22, region Mumbai (asia-south1), "Services
 * (Requests-based billing)": CPU active time USD 0.000024 per vCPU-second, memory active time
 * USD 0.0000025 per GiB-second. 4 * 0.000024 + 16 * 0.0000025 = 0.000096 + 0.00004 = 0.000136.
 */
export const DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND = 0.000136;
/**
 * USD per second of the GPU matting service (catalog-matting-gpu, asia-southeast1, one NVIDIA L4 with
 * --no-gpu-zonal-redundancy, --no-cpu-throttling so instance-based billing, --cpu=4 --memory=16Gi).
 * Must match PRICE_MATTE_GPU_USD_PER_SECOND in infra/deploy.sh.
 * Source: cloud.google.com/run/pricing, read 2026-10-22, region Singapore (asia-southeast1), "Services
 * (Instance-based billing)": GPU Type NVIDIA L4 non-zonal redundancy USD 0.00022404 per second,
 * CPU USD 0.0000216 per vCPU-second, memory USD 0.0000024 per GiB-second.
 * 0.00022404 + 4 * 0.0000216 + 16 * 0.0000024 = 0.00022404 + 0.0000864 + 0.0000384 = 0.00034884.
 * Both rates price the seconds the service reports for a call (its inference time), so matte and
 * upscale rows are a lower bound of what Google bills: instance start-up and the idle time before an
 * instance stops are not in the ledger, nor are upscale calls that failed (the render falls back
 * silently) or a GPU cut-out attempt that failed before the CPU service answered.
 */
export const DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND = 0.00034884;
/** The matting-service target of a cut-out or upscale call; null is the worker's own simple cut-out. */
export type MatteTarget = "cpu" | "gpu" | null;
/** PRICE_MATTE_CPU_USD_PER_SECOND and PRICE_MATTE_GPU_USD_PER_SECOND; missing or invalid values use the documented defaults. */
export function mattePricesFromEnv(env: NodeJS.ProcessEnv = process.env): { cpu: number; gpu: number } {
 return {cpu:positive(env.PRICE_MATTE_CPU_USD_PER_SECOND) ?? DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND,gpu:positive(env.PRICE_MATTE_GPU_USD_PER_SECOND) ?? DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND};
}
/**
 * What `ms` of a matting-service call cost on `target` (the ledger's matte_call and upscale_call rows).
 * A call the worker answered itself (floodfill, alpha_source) is free. `estimated` is true when the
 * rate came from the code default rather than the environment, so the Ops page can say so.
 */
export function matteCallUsd(target: MatteTarget, ms: number, env: NodeJS.ProcessEnv = process.env): { usd: number; estimated: boolean } {
 if (target === null || !Number.isFinite(ms) || ms <= 0) return {usd:0,estimated:false};
 const configured = positive(target === "gpu" ? env.PRICE_MATTE_GPU_USD_PER_SECOND : env.PRICE_MATTE_CPU_USD_PER_SECOND);
 const rate = configured ?? (target === "gpu" ? DEFAULT_PRICE_MATTE_GPU_USD_PER_SECOND : DEFAULT_PRICE_MATTE_CPU_USD_PER_SECOND);
 return {usd:ms/1000*rate,estimated:configured === null};
}
/** Operator copy when no rupee rate is configured; never names the env var (spec 07 4.11). */
export const RUPEES_NOT_CONFIGURED = "Cost in rupees is not configured yet";
/** What one quality-check or classifier completion cost, as recorded in spend_days (07 4.5). */
export interface QaCallCost { costUsd:number; estimated:boolean; promptTokens:number; completionTokens:number }
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
/**
 * Reads the price of one successful OpenRouter chat completion from its JSON body. OpenRouter
 * always returns `usage` with token counts and, normally, `usage.cost` in USD (the amount it billed).
 * When the cost is missing or not a number, the call is priced at QA_USD_PER_CHECK_FALLBACK and
 * marked `estimated` so the caller logs it: spend is never recorded as 0 for a billed completion.
 */
export function qaCallCost(body: unknown): QaCallCost {
 const usage = (body as {usage?: Record<string, unknown> | null} | null | undefined)?.usage ?? undefined;
 const reported = usage?.cost;
 const known = typeof reported === "number" && Number.isFinite(reported) && reported >= 0;
 return {costUsd:known ? reported : QA_USD_PER_CHECK_FALLBACK,estimated:!known,promptTokens:count(usage?.prompt_tokens),completionTokens:count(usage?.completion_tokens)};
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
/**
 * Wizard step 4 estimate (spec 07 4.11): usd = qaChecks * QA_USD_PER_CHECK_ESTIMATE + images *
 * COMPUTE_VCPU_SECONDS_PER_OUTPUT_ESTIMATE * COMPUTE_USD_PER_VCPU_SECOND (the same price the worker
 * records compute spend with, else DEFAULT_COMPUTE_USD_PER_VCPU_SECOND); null without INR_PER_USD.
 */
export function estimateCost(counts:EstimateCounts,env:NodeJS.ProcessEnv=process.env) {
 const rate = positive(env.INR_PER_USD);
 if (rate === null) return null;
 const images = Math.max(0,counts.outputs-(counts.styliSkips ?? 0)-(counts.unchangedPairs ?? 0));
 const qaChecks = (counts.qaMode === "per_output" ? images : counts.sources)*(counts.qaSampleRate ?? 1)+(counts.untypedProducts ?? 0);
 const computeRate = positive(env.COMPUTE_USD_PER_VCPU_SECOND) ?? DEFAULT_COMPUTE_USD_PER_VCPU_SECOND;
 const usd = qaChecks*QA_USD_PER_CHECK_ESTIMATE+images*COMPUTE_VCPU_SECONDS_PER_OUTPUT_ESTIMATE*computeRate;
 return {usd,inr:usd*rate,images,qaChecks};
}
