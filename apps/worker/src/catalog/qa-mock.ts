import { QA_DIMENSIONS, type QaScores } from "@catalog/core/catalog/qa/judge";
import type { CatalogDeps } from "./deps";
/**
 * 07 tier 5: canned pass verdicts for runs without LIVE_SMOKE=1. No OpenRouter request is made;
 * every judged output carries the information flag `qa_sampled_out` so reports show the mock ran.
 */
export const cannedQa: Pick<CatalogDeps,"judgeOutput"|"classifyProductType"> = {
  judgeOutput: async input => ({scores:{...Object.fromEntries(QA_DIMENSIONS.map(d=>[d,100])),overall:100} as QaScores,verdict:"pass",reasons:[],isCollage:false,usage:{},costUsd:0,calls:0,model:input.model,flags:["qa_sampled_out"]}),
  classifyProductType: async () => ({type:"other",confidence:0,usage:{},costUsd:0,calls:0,flags:[]}),
};
export const liveQaEnabled = (env: NodeJS.ProcessEnv = process.env) => env.LIVE_SMOKE === "1";
