import { and, eq, inArray, sql } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { CHANNELS } from "@catalog/core/catalog/channels";
import { checkCatalogCaps } from "@catalog/core/catalog/qa/caps";
import { sampledForQa, strictestChannel } from "@catalog/core/catalog/qa/policy";
import { flagDetails } from "@catalog/core/catalog/qa/reasons";
import { QA_DIMENSIONS, DIMENSION_FLAGS, verdictFor } from "@catalog/core/catalog/qa/judge";
import { recordCost } from "@catalog/core/spend";
import { qaCallCost } from "@catalog/core/catalog/cost";
import type { ResolvedPolicy, OutputFlag } from "@catalog/core/catalog/types";
import type { CatalogDeps } from "./deps";

type Batch = typeof catalogBatches.$inferSelect;
type Source = typeof catalogSourceImages.$inferSelect;
export type UnderClaim = <T>(write:(db:CatalogDeps["db"])=>Promise<T>)=>Promise<T>;
export class CatalogQaCapError extends Error {}
/** The model id of a chat completion request; it is the first field of the JSON body. */
function requestModel(init?:RequestInit):string | null {
 return typeof init?.body==="string" ? /"model"\s*:\s*"([^"]{1,200})"/.exec(init.body.slice(0,500))?.[1] ?? null : null;
}
/** Why an attempt failed, for the warn line: auth, rate limit, server, timeout or network, plus OpenRouter's short message. */
async function failureDetail(response:Response | undefined,failure:unknown):Promise<Record<string,unknown>> {
 if(!response) {
  const name=(failure as {name?:string} | null)?.name;
  return {kind:name==="TimeoutError" || name==="AbortError" ? "timeout":"network",error:String((failure as Error | null)?.message ?? failure).slice(0,200)};
 }
 const kind=response.status===401 || response.status===403 ? "auth":response.status===402 ? "credit":response.status===429 ? "rate_limit":response.status>=500 ? "server":"request";
 let error="";
 try {const text=await response.clone().text();error=String((JSON.parse(text) as {error?:{message?:unknown}}).error?.message ?? text);}catch{/* No readable body. */}
 return {kind,error:error.replace(/Bearer\s+\S+/g,"Bearer [REDACTED]").slice(0,200)};
}
/** Check the lease and cap before every HTTP attempt, including the JSON helper's retry. */
export function catalogLlmDeps(deps:CatalogDeps,batch:Batch,underClaim:UnderClaim) {
 let stopped:unknown;
 return {assertAvailable:()=>{if(stopped) throw stopped;},fetch:async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  try {
   await underClaim(async()=>{});
   const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});
   if(!cap.ok) throw new CatalogQaCapError(cap.reason);
  }catch(error){stopped=error;throw error;}
  let response:Response | undefined,failure:unknown;
  const started=Date.now();
  try { response=await deps.fetch(url,init);return response; }
  catch(error){failure=error;throw error;}
  finally {
   // A failed or unanswered request is not billed; a successful one is priced from OpenRouter's
   // usage.cost, or at the per-check estimate when that is missing (the judge logs that case).
   let spent={costUsd:0,estimated:false,promptTokens:0,completionTokens:0};
   if(response?.ok) {let body:unknown;try {body=await response.clone().json();}catch{/* Invalid replies still count as billed attempts. */}spent=qaCallCost(body);}
   const {costUsd,promptTokens,completionTokens}=spent;
   // One line per OpenRouter attempt: never the key, never the prompt or its images.
   const fields={batchId:batch.id,model:requestModel(init),status:response?.status ?? 0,ms:Date.now()-started,costUsd,estimated:spent.estimated,promptTokens,completionTokens};
   if(response?.ok) deps.log("catalog_qa call",fields);
   else deps.log("catalog_qa call failed",{...fields,severity:"WARNING",...(await failureDetail(response,failure))});
   await deps.db.transaction(async tx=>{
    await recordCost(tx as unknown as CatalogDeps["db"],{brandSlug:batch.brandSlug,batchId:batch.id,engine:"catalog_qa",costUsd,day:deps.now()});
    await tx.update(catalogBatches).set({cost:sql`${catalogBatches.cost} || jsonb_build_object('qaUsd',coalesce((${catalogBatches.cost}->>'qaUsd')::numeric,0)+${costUsd}::numeric,'qaCalls',coalesce((${catalogBatches.cost}->>'qaCalls')::numeric,0)+1,'qaPromptTokens',coalesce((${catalogBatches.cost}->>'qaPromptTokens')::numeric,0)+${promptTokens}::numeric,'qaCompletionTokens',coalesce((${catalogBatches.cost}->>'qaCompletionTokens')::numeric,0)+${completionTokens}::numeric)`}).where(eq(catalogBatches.id,batch.id));
   });
  }
 },log:(message:string,fields?:Record<string,unknown>)=>deps.log(message,{batchId:batch.id,...fields})};
}
export const qaCapReason = `${flagDetails("qa_cap").why} ${flagDetails("qa_cap").whatToDo}`;
export async function runQaStage(deps:CatalogDeps,batch:Batch,sources:Source[],policy:ResolvedPolicy,underClaim:UnderClaim):Promise<void> {
 if(!sources.length) return;
 const rows=await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),inArray(catalogOutputs.sourceImageId,sources.map(s=>s.id)),eq(catalogOutputs.status,"staged"),sql`${catalogOutputs.qaScores} IS NULL`,sql`${catalogOutputs.decision} IS NULL`));
 const groups=policy.qaMode==="per_output" ? rows.map(row=>[row]) : sources.map(source=>rows.filter(row=>row.sourceImageId===source.id)).filter(group=>group.length);
 for(const group of groups) {
  await underClaim(async()=>{});
  const first=group[0]!,source=sources.find(s=>s.id===first.sourceImageId)!;
  const [product]=await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id,source.productId));
  if(!product) continue;
  if(!sampledForQa(product.identifier,policy.qaSampleRate)) {
   await underClaim(async tx=>{for(const row of group) await tx.update(catalogOutputs).set({flags:[...new Set([...row.flags,"qa_sampled_out" as const])],reason:row.reason ?? flagDetails("qa_sampled_out").why,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));});continue;
  }
  const judged=group.find(row=>row.channel===strictestChannel(group.map(row=>row.channel)))!;
  try {
   const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});
   if(!cap.ok) throw new CatalogQaCapError(cap.reason);
   const [fresh]=await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,batch.id));
   const state=fresh!.counts as Batch["counts"] & {qaUnavailableStreak?:number;qaUseSecond?:boolean};
   const model=state.qaUseSecond && policy.qaModelSecond ? policy.qaModelSecond : policy.qaModel;
   const originals=await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,source.productId),eq(catalogSourceImages.batchId,batch.id))).orderBy(catalogSourceImages.n);
   const superseded=new Set(originals.flatMap(s=>s.replacesId ? [s.replacesId]:[]));
   const shotOne=originals.find(s=>!superseded.has(s.id));
   const original=(await deps.storage.downloadBuffer(source.rawUri)).buf;
   const output=(await deps.storage.downloadBuffer(judged.stagingUri!)).buf;
   const llm=catalogLlmDeps(deps,batch,underClaim);
   const result=await deps.judgeOutput({output,original,...(source.n>1 && shotOne ? {shotOne:(await deps.storage.downloadBuffer(shotOne.rawUri)).buf}:{}),channel:judged.channel,anchor:judged.channel==="styli" ? "bottom-centre":"centre",productType:product.productType ?? "other",identifier:product.identifier,n:source.n,model,threshold:policy.threshold,floor:policy.floor},llm);
   llm.assertAvailable();
   const unavailable=result.flags.includes("qa_unavailable");
   await underClaim(async tx=>{
    const nextStreak=unavailable ? sql`coalesce((${catalogBatches.counts}->>'qaUnavailableStreak')::int,0)+1`:sql`0`;
    await tx.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || jsonb_build_object('qaUnavailableStreak',${nextStreak},'qaUseSecond',coalesce((${catalogBatches.counts}->>'qaUseSecond')::boolean,false) OR ${nextStreak}>=2)`}).where(eq(catalogBatches.id,batch.id));
    for(const row of group) {
     const flags=result.flags.filter(flag=>flag!=="placement" || row.id===judged.id);
     const otherScores=row.id===judged.id || policy.qaMode==="per_output" ? result.scores : {...result.scores,placement_ok:100,overall:(QA_DIMENSIONS.reduce((sum,key)=>sum+(key==="placement_ok" ? 100:result.scores[key]),0))/7};
     const flagged=unavailable || result.isCollage || verdictFor(otherScores,policy.threshold,policy.floor)==="flag";
     const lowest=QA_DIMENSIONS.filter(key=>key!=="placement_ok" || row.id===judged.id).sort((a,b)=>result.scores[a]-result.scores[b]).map(key=>DIMENSION_FLAGS[key]).find(flag=>flags.includes(flag));
     const issue=unavailable ? "qa_unavailable":lowest ?? (result.isCollage ? "collage":undefined);
     const stable=issue ? flagDetails(issue,{channel:CHANNELS[row.channel].label,n:row.n,k:batch.channels.length}).why:null;
     await tx.update(catalogOutputs).set({qaScores:{...result.scores,verdict:flagged ? "flag":"pass",reasons:result.reasons.map(reason=>/birefnet|bria|gemini|haiku|qwen|openrouter|google\/|anthropic\//i.test(reason) ? stable ?? "Please compare the made image with the original photo.":reason)},qaModel:result.model,flags:[...new Set([...row.flags,...(flagged ? flags:flags.filter(flag=>flag==="qa_sampled_out"))])],status:flagged ? "needs_attention":"staged",reason:flagged ? stable ?? row.reason:row.reason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));
    }
   });
  } catch(error) {
   if(!(error instanceof CatalogQaCapError)) throw error;
   await underClaim(async tx=>{for(const row of group) await tx.update(catalogOutputs).set({status:"needs_attention",flags:[...new Set<OutputFlag>([...row.flags,"qa_cap"])],reason:qaCapReason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));});
  }
 }
}
