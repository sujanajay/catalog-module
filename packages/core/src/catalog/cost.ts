import type { BatchCost, QaMode } from "./types";
export const QA_USD_PER_CHECK_ESTIMATE = 0.0013;
export const COMPUTE_SECONDS_PER_OUTPUT_ESTIMATE = 1.5;
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
 const text = usdPerIdentifier === null ? "Cost per style is not available yet" : inrPerIdentifier === null ? `USD ${usdPerIdentifier.toFixed(2)} per style so far (set INR_PER_USD to show rupees)` : `INR ${inrPerIdentifier.toFixed(2)} per style so far`;
 return {usd,identifiers,usdPerIdentifier,inrPerIdentifier,text:`${text} · agency reference INR 60 per style`};
}
export interface EstimateCounts {
 outputs:number;sources:number;untypedProducts?:number;qaMode?:QaMode;qaSampleRate?:number;styliSkips?:number;unchangedPairs?:number;
}
export function estimateCost(counts:EstimateCounts,env:NodeJS.ProcessEnv=process.env) {
 const rate = positive(env.INR_PER_USD);
 if (rate === null) return null;
 const images = Math.max(0,counts.outputs-(counts.styliSkips ?? 0)-(counts.unchangedPairs ?? 0));
 const qaChecks = (counts.qaMode === "per_output" ? images : counts.sources)*(counts.qaSampleRate ?? 1)+(counts.untypedProducts ?? 0);
 const computeRate = positive(env.COMPUTE_USD_PER_VCPU_SECOND) ?? 0;
 const usd = qaChecks*QA_USD_PER_CHECK_ESTIMATE+images*COMPUTE_SECONDS_PER_OUTPUT_ESTIMATE*2*computeRate;
 return {usd,inr:usd*rate,images,qaChecks};
}
