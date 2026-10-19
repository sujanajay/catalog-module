import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { CHANNELS } from "@catalog/core/catalog/channels";
import { checkCatalogCaps } from "@catalog/core/catalog/qa/caps";
import { sampledForQa, strictestChannel } from "@catalog/core/catalog/qa/policy";
import { autoActionNote, flagDetails } from "@catalog/core/catalog/qa/reasons";
import { DIMENSION_FLAGS, OUTPUT_DIMENSIONS, PHOTO_DIMENSIONS, QA_DIMENSIONS, dimensionThresholds, failingDimensions, withOverall, type JudgeResult, type QaDimension } from "@catalog/core/catalog/qa/judge";
import { HARD_HOLD_FLAGS, INFORMATION_FLAGS, OWN_DEFECT_FLAGS, noRepair, problemFlags, triageProduct } from "@catalog/core/catalog/qa/triage";
import { recordCost } from "@catalog/core/spend";
import type { ResolvedPolicy, OutputFlag } from "@catalog/core/catalog/types";
import type { CatalogDeps } from "./deps";

type Batch = typeof catalogBatches.$inferSelect;
type Source = typeof catalogSourceImages.$inferSelect;
export type UnderClaim = <T>(write:(db:CatalogDeps["db"])=>Promise<T>)=>Promise<T>;
export class CatalogQaCapError extends Error {}
/** Check the lease and cap before every HTTP attempt, including the JSON helper's retry. */
export function catalogLlmDeps(deps:CatalogDeps,batch:Batch,underClaim:UnderClaim) {
 let stopped:unknown;
 return {assertAvailable:()=>{if(stopped) throw stopped;},fetch:async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  try {
   await underClaim(async()=>{});
   const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});
   if(!cap.ok) throw new CatalogQaCapError(cap.reason);
  }catch(error){stopped=error;throw error;}
  let response:Response | undefined;
  try { response=await deps.fetch(url,init);return response; }
  finally {
   let costUsd=0;
   if(response?.ok) try {const body=await response.clone().json() as {usage?:{cost?:number}};costUsd=Math.max(0,Number(body.usage?.cost) || 0);}catch{/* Invalid replies still count as attempts. */}
   await deps.db.transaction(async tx=>{
    await recordCost(tx as unknown as CatalogDeps["db"],{brandSlug:batch.brandSlug,batchId:batch.id,engine:"catalog_qa",costUsd,day:deps.now()});
    await tx.update(catalogBatches).set({cost:sql`${catalogBatches.cost} || jsonb_build_object('qaUsd',coalesce((${catalogBatches.cost}->>'qaUsd')::numeric,0)+${costUsd}::numeric,'qaCalls',coalesce((${catalogBatches.cost}->>'qaCalls')::numeric,0)+1)`}).where(eq(catalogBatches.id,batch.id));
   });
  }
 },log:(message:string)=>deps.log(message)};
}
export const qaCapReason = `${flagDetails("qa_cap").why} ${flagDetails("qa_cap").whatToDo}`;
type Output = typeof catalogOutputs.$inferSelect;
interface Judged { row: Output; result: JudgeResult; role: "judge" | "recheck" }
const MODEL_TEXT = /birefnet|bria|gemini|haiku|qwen|openrouter|google\/|anthropic\//i;
const OWN_OUTPUT_FLAGS = new Set<OutputFlag>(OUTPUT_DIMENSIONS.map(d => DIMENSION_FLAGS[d]));
/** Outputs that never get a (new) judge call: no verdict can change them, or one is already recorded. */
const NOT_JUDGED = new Set<OutputFlag>(["failed_compliance", "qa_cap", "qa_unavailable"]);
/** A judge sentence reaches the report and the attention card only when it names no model. */
const clean = (sentence: string | undefined, fallback: string) => sentence && !MODEL_TEXT.test(sentence) ? sentence : fallback;

/**
 * 07 QA stage, judge v2. Per source: judge the strictest channel (or every channel in `per_output`)
 * with the second opinion on `wrong_item`; when an output dimension fails, re-check the photo's other
 * channels. Photo dimensions come from the judged channel(s) and apply to every channel; output
 * dimensions take the strictest score across the photo's channels, so one defect gives one consistent
 * result everywhere. Then `triageProduct` turns the problems into notes, drops and the few hard holds.
 */
export async function runQaStage(deps:CatalogDeps,batch:Batch,sources:Source[],policy:ResolvedPolicy,underClaim:UnderClaim):Promise<void> {
 if(!sources.length) return;
 const candidates=await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),inArray(catalogOutputs.sourceImageId,sources.map(s=>s.id)),inArray(catalogOutputs.status,["staged","needs_attention"]),isNull(catalogOutputs.qaScores),isNull(catalogOutputs.decision)));
 // A needs_attention output from render (small_source) is judged too, so a note never publishes an unseen image.
 const rows=candidates.filter(row=>row.status==="staged" || (!!row.stagingUri && !row.flags.some(flag=>NOT_JUDGED.has(flag))));
 const groups=sources.map(source=>rows.filter(row=>row.sourceImageId===source.id)).filter(group=>group.length);
 for(const group of groups) {
  await underClaim(async()=>{});
  const first=group[0]!,source=sources.find(s=>s.id===first.sourceImageId)!;
  const [product]=await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id,source.productId));
  if(!product) continue;
  if(!sampledForQa(product.identifier,policy.qaSampleRate)) {
   await underClaim(async tx=>{for(const row of group) await tx.update(catalogOutputs).set({flags:[...new Set([...row.flags,"qa_sampled_out" as const])],reason:row.reason ?? flagDetails("qa_sampled_out").why,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));});continue;
  }
  try {
   const cap=await checkCatalogCaps(deps.db,{batchId:batch.id,now:deps.now()});
   if(!cap.ok) throw new CatalogQaCapError(cap.reason);
   const [fresh]=await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id,batch.id));
   const state=fresh!.counts as Batch["counts"] & {qaUnavailableStreak?:number;qaUseSecond?:boolean};
   const model=state.qaUseSecond && policy.qaModelSecond ? policy.qaModelSecond : policy.qaModel;
   // The second opinion on a different item always comes from the other judge of the policy.
   const secondModel=model===policy.qaModelSecond ? policy.qaModel : policy.qaModelSecond;
   const originals=await deps.db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,source.productId),eq(catalogSourceImages.batchId,batch.id))).orderBy(catalogSourceImages.n);
   const superseded=new Set(originals.flatMap(s=>s.replacesId ? [s.replacesId]:[]));
   const shotOne=originals.find(s=>!superseded.has(s.id));
   const original=(await deps.storage.downloadBuffer(source.rawUri)).buf;
   const shotOneBytes=source.n>1 && shotOne ? (await deps.storage.downloadBuffer(shotOne.rawUri)).buf:undefined;
   const judge=async(row:Output,withSecond:boolean)=>{
    const output=(await deps.storage.downloadBuffer(row.stagingUri!)).buf;
    const llm=catalogLlmDeps(deps,batch,underClaim);
    const result=await deps.judgeOutput({output,original,...(shotOneBytes ? {shotOne:shotOneBytes}:{}),channel:row.channel,anchor:row.channel==="styli" ? "bottom-centre":"centre",productType:product.productType ?? "other",identifier:product.identifier,n:source.n,model,threshold:policy.threshold,floor:policy.floor,...(withSecond && secondModel ? {secondModel}:{})},llm);
    llm.assertAvailable();
    return result;
   };
   const strictest=strictestChannel(group.map(row=>row.channel));
   const primary=policy.qaMode==="per_output" ? group:[group.find(row=>row.channel===strictest)!];
   const judged=new Map<string,Judged>();
   for(const row of primary) judged.set(row.id,{row,result:await judge(row,true),role:"judge"});
   const usable=()=>[...judged.values()].filter(entry=>!entry.result.flags.includes("qa_unavailable"));
   // One channel shows our own defect: look at the same photo on the other channels before any is published.
   if(usable().some(entry=>failingDimensions(entry.result.scores,policy.threshold,policy.floor).some(d=>OWN_OUTPUT_FLAGS.has(DIMENSION_FLAGS[d])))) {
    for(const row of group.filter(row=>!judged.has(row.id))) judged.set(row.id,{row,result:await judge(row,false),role:"recheck"});
   }
   const ok=usable(),unavailable=!ok.length,main=judged.get(primary[0]!.id)!.result;
   await underClaim(async tx=>{
    const nextStreak=unavailable ? sql`coalesce((${catalogBatches.counts}->>'qaUnavailableStreak')::int,0)+1`:sql`0`;
    await tx.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || jsonb_build_object('qaUnavailableStreak',${nextStreak},'qaUseSecond',coalesce((${catalogBatches.counts}->>'qaUseSecond')::boolean,false) OR ${nextStreak}>=2)`}).where(eq(catalogBatches.id,batch.id));
    const thresholds=dimensionThresholds(policy.threshold,policy.floor);
    const judgements=[...judged.values()].map(({row,result,role})=>({channel:row.channel,role,model:result.model,view:result.view ?? null,scores:result.scores,flags:result.flags,wrongItem:result.wrongItem ?? null,
     secondOpinion:result.opinions?.[1] ? {model:result.opinions[1].model,wrongItem:result.opinions[1].wrongItem,view:result.opinions[1].view}:null}));
    if(unavailable) {
     for(const row of group) await tx.update(catalogOutputs).set({qaScores:{...main.scores,verdict:"flag",reasons:[flagDetails("qa_unavailable").why],thresholds,judgements,autoAction:null},qaModel:main.model,flags:[...new Set<OutputFlag>([...row.flags,"qa_unavailable"])],status:"needs_attention",reason:flagDetails("qa_unavailable").why,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));
     return;
    }
    const photoPool=ok.filter(entry=>entry.role==="judge");
    const lowest=(d:QaDimension)=>{const pool=(PHOTO_DIMENSIONS as readonly QaDimension[]).includes(d) ? photoPool:ok;return pool.reduce((low,entry)=>entry.result.scores[d]<low.result.scores[d] ? entry:low,pool[0]!);};
    const from=Object.fromEntries(QA_DIMENSIONS.map(d=>[d,lowest(d)])) as Record<QaDimension,Judged>;
    const scores=withOverall(Object.fromEntries(QA_DIMENSIONS.map(d=>[d,from[d].result.scores[d]])) as Record<QaDimension,number>);
    const failing=failingDimensions(scores,policy.threshold,policy.floor);
    const collage=photoPool.find(entry=>entry.result.isCollage);
    const sentence=(entry:Judged,flag:OutputFlag)=>clean(entry.result.evidence?.[flag] ?? (entry.result.evidence ? undefined:entry.result.reasons[entry.result.flags.indexOf(flag)]),flagDetails(flag).why);
    const evidence:Record<string,{sentence:string;model:string;secondModel?:string|null;channel:string}>={};
    for(const d of failing) {const flag=DIMENSION_FLAGS[d],entry=from[d];evidence[flag]={sentence:sentence(entry,flag),model:entry.result.model,...(flag==="different_product" ? {secondModel:entry.result.wrongItem?.secondModel ?? null}:{}),channel:entry.row.channel};}
    if(collage) evidence.collage={sentence:sentence(collage,"collage"),model:collage.result.model,channel:collage.row.channel};
    const found:OutputFlag[]=[...failing.map(d=>DIMENSION_FLAGS[d]),...(collage ? ["collage" as const]:[])];
    const information=[...new Set(ok.flatMap(entry=>entry.result.flags.filter(flag=>INFORMATION_FLAGS.has(flag))))];
    const missing=ok.flatMap(entry=>entry.result.reasons.filter(reason=>/did not provide a score/.test(reason)));
    const reasons=[...found.map(flag=>evidence[flag]!.sentence),...new Set(missing)];
    const wrongItem=photoPool.map(entry=>entry.result.wrongItem).find(w=>w?.first) ?? photoPool[0]?.result.wrongItem ?? null;
    for(const row of group) {
     const flags=[...new Set([...row.flags,...found,...information])];
     const own=judged.get(row.id);
     await tx.update(catalogOutputs).set({qaScores:{...scores,verdict:found.length ? "flag":"pass",reasons,view:own?.result.view ?? main.view ?? null,thresholds,evidence,wrongItem,judgements,autoAction:null},qaModel:main.model,flags,
      // Held until the triage below decides; a crash in between leaves the product held, never published unseen.
      status:problemFlags(flags).length ? "needs_attention":row.status,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));
    }
   });
  } catch(error) {
   if(!(error instanceof CatalogQaCapError)) throw error;
   await underClaim(async tx=>{for(const row of group) await tx.update(catalogOutputs).set({status:"needs_attention",flags:[...new Set<OutputFlag>([...row.flags,"qa_cap"])],reason:qaCapReason,updatedAt:deps.now()}).where(eq(catalogOutputs.id,row.id));});
  }
 }
 for(const productId of new Set(sources.map(source=>source.productId))) await applyTriage(deps,batch,productId,underClaim);
}

/** Lead flag for the sentence: a hard hold first, then the first other problem, then a note-only flag. */
function leadFlag(flags:readonly OutputFlag[]):OutputFlag|undefined {
 return flags.find(flag=>HARD_HOLD_FLAGS.has(flag)) ?? problemFlags(flags)[0] ?? flags.find(flag=>INFORMATION_FLAGS.has(flag) && (flag==="complete_product" || flag==="transparent"));
}
/**
 * Turns one product's QA problems into automatic actions (qa/triage.ts) and records them on each
 * judged output's `qa_scores` (`autoAction`, `holdCause`, `finalStatus`) for the report and evals.
 * Before deciding, the re-render loop (`deps.repairOwnDefects`) gets the outputs with our own defects.
 */
export async function applyTriage(deps:CatalogDeps,batch:Batch,productId:string,underClaim:UnderClaim):Promise<void> {
 const read=()=>deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batch.id),eq(catalogOutputs.productId,productId)));
 let outputs=await read();
 const repairable=outputs.filter(o=>o.decision===null && (o.status==="staged" || o.status==="needs_attention") && o.flags.some(flag=>OWN_DEFECT_FLAGS.has(flag)));
 if(repairable.length && deps.repairOwnDefects) {
  await underClaim(async()=>{});
  await (deps.repairOwnDefects ?? noRepair)(repairable.map(o=>({outputId:o.id,sourceImageId:o.sourceImageId,channel:o.channel,n:o.n,flags:o.flags})));
  outputs=await read();
 }
 const sources=await deps.db.select({id:catalogSourceImages.id,n:catalogSourceImages.n,replacesId:catalogSourceImages.replacesId}).from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId,batch.id),eq(catalogSourceImages.productId,productId)));
 const replaced=new Set(sources.flatMap(s=>s.replacesId ? [s.replacesId]:[]));
 const shots=new Set(sources.filter(s=>!replaced.has(s.id)).map(s=>s.n));
 const live=await deps.db.select({channel:catalogOutputs.channel,n:catalogOutputs.n}).from(catalogOutputs).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.isLive,true),inArray(catalogOutputs.channel,batch.channels)));
 const keptLive=live.filter(l=>shots.has(l.n) && !outputs.some(o=>o.channel===l.channel && o.n===l.n && o.decision!=="replaced"));
 const current=outputs.filter(o=>!replaced.has(o.sourceImageId));
 const decisions=triageProduct(current,keptLive);
 await underClaim(async tx=>{
  for(const o of current) {
   const decision=decisions.get(o.id),scores=o.qaScores;
   if(!decision || o.status==="failed") continue;
   const lead=leadFlag(o.flags),ctx={channel:CHANNELS[o.channel].label,n:o.n,k:batch.channels.length},why=lead ? flagDetails(lead,ctx).why:null;
   const ordered=[...new Set([...o.flags.filter(flag=>HARD_HOLD_FLAGS.has(flag)),...o.flags])];
   let patch:Partial<Output>;
   if(decision.action==="hold") {
    if(!decision.cause || decision.cause==="unchecked") continue;
    patch={status:"needs_attention",flags:ordered,reason:scores && why ? why:o.reason ?? why};
   } else if(decision.action==="drop") patch={status:"skipped",flags:ordered,reason:autoActionNote("drop",why ?? "")};
   else if(decision.action==="note") patch={status:"staged",flags:ordered,reason:autoActionNote("note",why ?? "")};
   else {
    // Nothing to decide: a judged note-only flag (the photo is cut at its own edge) still gets its sentence.
    if(!scores) continue;
    const note=lead && INFORMATION_FLAGS.has(lead) ? why:null;
    patch={reason:o.reason ?? note,qaScores:{...scores,autoAction:note ? "note":"none",finalStatus:o.status}};
    await tx.update(catalogOutputs).set({...patch,updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id));
    continue;
   }
   if(scores) patch.qaScores={...scores,autoAction:decision.action,...(decision.cause ? {holdCause:decision.cause}:{}),finalStatus:patch.status};
   await tx.update(catalogOutputs).set({...patch,updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id));
  }
 });
}
