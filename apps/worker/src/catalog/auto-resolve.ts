import sharp from "sharp";
import { eq } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { batchPrefix, stagingPath } from "@catalog/core/catalog/naming";
import type { Matte, Prepared, RenderInput, RenderOutput } from "@catalog/core/catalog/render";
import { autoActionsOf, JUDGED_CUT_MIN_RUN_FRACTION, LadderStopped, RENDER_FLAGS, runLadder, stepVariant, withAutoActions, type AutoAction, type LadderStep } from "@catalog/core/catalog/auto-resolve";
import { strictestChannel } from "@catalog/core/catalog/qa/policy";
import type { ChannelId, OutputFlag, ResolvedPolicy } from "@catalog/core/catalog/types";
import type { CatalogDeps } from "./deps";

type Batch = typeof catalogBatches.$inferSelect;
type Product = typeof catalogProducts.$inferSelect;
type Source = typeof catalogSourceImages.$inferSelect;
export type Output = typeof catalogOutputs.$inferSelect;
type UnderClaim = <T>(write:(db:CatalogDeps["db"])=>Promise<T>)=>Promise<T>;

/** One judge look at a step's output. `passed` is false while any of our own output defects remains. */
export interface RejudgeVerdict { passed: boolean; flags: OutputFlag[]; scores?: Record<string, unknown> | undefined }
export type Rejudge = (output: Output, jpeg: Buffer) => Promise<RejudgeVerdict>;

export interface ResolvePhotoInput {
  batch: Batch; product: Product; source: Source; policy: ResolvedPolicy; underClaim: UnderClaim;
  /** Every output of this photo in this batch that may be re-made (undecided, rendered or failed). */
  outputs: Output[];
  /** The outputs that showed the defect; the steps are checked on these. */
  failing: Output[];
  trigger: OutputFlag[];
  /** The product-type shadow rule (05 rule 3) the first render used. */
  shadowAllowed: boolean;
  /** The output's status after a successful re-render, from its new flags. */
  statusFor: (flags: OutputFlag[]) => Output["status"];
  /** Present when the judge flagged the photo: one look per step, at the strictest failing channel. */
  rejudge?: Rejudge;
  /** The render context the first render used (canvas, Styli's uniform scale); default: read back from the row. */
  contextFor?: (output: Output) => Partial<RenderInput>;
  prepared?: Prepared; matte?: Matte;
  /** Keeps a flush cut placed by `flushCutPhoto` (the relaxed cut run fraction) in every step. */
  cutMinRunFraction?: number;
}
export interface ResolveResult { winner: LadderStep | null; actions: AutoAction[]; fixed: Set<string> }

const ok = (r: RenderOutput | undefined): r is RenderOutput & { jpeg: Buffer } => !!r && r.status === "ok" && r.compliance.ok && !!r.jpeg;
const codes = (r: RenderOutput) => r.compliance.failures.map(f => f.split(":")[0]).join(",") || r.notes.join("; ") || r.status;
/** The context the first render used, read back from the row: one canvas per product, Styli's size kept. */
const rowContext = (o: Output): Partial<RenderInput> => ({...(o.canvasW > 0 && o.canvasH > 0 ? {canvas:{w:o.canvasW,h:o.canvasH}}:{}),...(o.channel === "styli" && o.scale > 0 ? {uniformScale:o.scale}:{})});

/** The matte the first render used, from the stored PNG. */
export async function storedMatte(deps: CatalogDeps, source: Source, p: Prepared, model: string): Promise<Matte | null> {
  if (!source.matteUri) return null;
  const alpha = await sharp((await deps.storage.downloadBuffer(source.matteUri)).buf).toColourspace("b-w").raw().toBuffer();
  return {alpha,width:p.width,height:p.height,model:source.matteModel ?? model,ms:source.matteMs ?? 0,source:source.flags.includes("alpha_source") ? "alpha_source":"model",target:null,sentLongSide:null};
}

/**
 * The retry ladder for one photo (07 auto-resolve): (a) synthesised shadow off, (b) the policy's
 * second matte model, (c) a 5% smaller fit. Each step re-renders the failing channels, re-runs the
 * compliance checks (the renderer's guard) and, when the judge flagged the photo, re-judges once.
 * The first step that passes is applied to every channel of the photo, so all marketplaces show the
 * same treatment; a channel the winning step would break keeps its first image. Every step and its
 * result is appended to each output's `compliance.auto_actions`. Returns the output ids it fixed.
 */
export async function resolvePhoto(deps: CatalogDeps, input: ResolvePhotoInput): Promise<ResolveResult> {
  const {product,source,underClaim} = input;
  if (!input.failing.length) return {winner:null,actions:[],fixed:new Set()};
  const p = input.prepared ?? await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b));
  const first = input.matte ?? await storedMatte(deps,source,p,input.policy.matteModel);
  if (!first) return {winner:null,actions:[],fixed:new Set()};
  let second: Matte | null | undefined;
  const secondModel = input.policy.matteModelSecond;
  const secondMatte = async (): Promise<Matte | null> => {
    if (second !== undefined) return second;
    second = null;
    if (!secondModel || secondModel === first.model || first.source === "alpha_source") return second;
    const health = await deps.matting.health();
    if (!health.models.some(m => m.id === secondModel)) return second;
    await underClaim(async()=>{});
    const matte = await deps.matteFor(p,deps.matting,secondModel);
    second = matte.source === "model" ? matte : null;
    return second;
  };
  const contextFor = input.contextFor ?? rowContext;
  const render = async (o: Output, step: LadderStep): Promise<RenderOutput> => {
    const variant = stepVariant(step), matte = variant.matte === "second" ? (await secondMatte())! : first;
    await underClaim(async()=>{});
    return (await deps.renderAllChannels(p,matte,[o.channel],{shotNumber:source.n,productType:product.productType ?? "other",identifier:product.identifier,publicObjectPath:o.objectPath,...contextFor(o),synthesiseShadow:variant.synthesiseShadow,...(variant.fitScale !== 1 ? {fitScale:variant.fitScale}:{}),...(input.cutMinRunFraction ? {cutMinRunFraction:input.cutMinRunFraction}:{})}))[o.channel];
  };
  const renders = new Map<string, RenderOutput>();
  // Assigned inside the step callback; the casts keep TypeScript from narrowing them to null.
  let verdict = null as RejudgeVerdict | null, judgedChannel = null as ChannelId | null;
  const {winner,actions} = await runLadder(input.trigger,input.failing.map(o=>o.channel),async step=>{
    if (step === "shadow_off" && !input.failing.some(o=>o.flags.includes("shadow_synthesised"))) return {passed:false,skipped:true,detail:"no added shadow"};
    if (step === "second_matte" && !(await secondMatte())) return {passed:false,skipped:true,detail:"no second cut-out available"};
    renders.clear();
    for (const o of input.failing) renders.set(o.id,await render(o,step));
    const broken = input.failing.find(o=>!ok(renders.get(o.id)));
    if (broken) return {passed:false,detail:`${broken.channel}: ${codes(renders.get(broken.id)!)}`};
    if (!input.rejudge) return {passed:true};
    const channel = strictestChannel(input.failing.map(o=>o.channel)), judged = input.failing.find(o=>o.channel===channel)!;
    verdict = await input.rejudge(judged,renders.get(judged.id)!.jpeg!);
    judgedChannel = channel;
    return {passed:verdict.passed,rejudged:true,...(verdict.passed ? {}:{detail:`judge: ${verdict.flags.join(",") || "no verdict"}`})};
  });
  if (!winner) { await recordActions(deps,input,input.outputs,actions); return {winner,actions,fixed:new Set()}; }
  const kept: ChannelId[] = [];
  for (const o of input.outputs) if (!renders.has(o.id)) { const r = await render(o,winner); if (ok(r)) renders.set(o.id,r); else kept.push(o.channel); }
  const applied = input.outputs.filter(o=>renders.has(o.id));
  const all: AutoAction[] = [...actions,{step:"apply",trigger:[...input.trigger],result:"passed",channels:applied.map(o=>o.channel),rejudged:false,detail:kept.length ? `${winner}; kept the first image on ${kept.join(",")}`:winner}];
  let sourceFlags = source.flags;
  if (stepVariant(winner).matte === "second" && second && source.matteUri) {
    // The winning cut-out becomes the photo's matte, so any later render of this shot uses it too.
    const {path} = deps.storage.parseGsUri(source.matteUri), secondPath = path.replace(/\.matte\.png$/,"")+".matte2.png";
    const png = await sharp(second.alpha,{raw:{width:p.width,height:p.height,channels:1}}).png().toBuffer();
    const matte = second;
    sourceFlags = source.flags.filter(f=>f!=="fallback_matte");
    const uri = await underClaim(async()=>deps.storage.uploadBuffer(secondPath,png,"image/png"));
    await underClaim(async tx=>tx.update(catalogSourceImages).set({matteUri:uri,matteModel:matte.model,matteMs:matte.ms,flags:sourceFlags}).where(eq(catalogSourceImages.id,source.id)));
  }
  const fixed = new Set<string>();
  for (const o of applied) {
    const done = verdict;
    const qaScores = o.qaScores && done ? {...o.qaScores,...(done.scores ? {edge_quality:done.scores.edge_quality ?? o.qaScores.edge_quality,background_clean:done.scores.background_clean ?? o.qaScores.background_clean,product_intact:done.scores.product_intact ?? o.qaScores.product_intact}:{}),rejudge:{step:winner,channel:judgedChannel,flags:done.flags}}:o.qaScores;
    if (await writeRender(deps,input,o,renders.get(o.id)!,all,{sourceFlags,qaScores})) fixed.add(o.id);
  }
  await recordActions(deps,input,input.outputs.filter(o=>!renders.has(o.id)),all);
  return {winner,actions:all,fixed};
}

/** Appends the record to outputs that keep their image. */
async function recordActions(deps: CatalogDeps, input: Pick<ResolvePhotoInput,"underClaim">, outputs: readonly Output[], all: readonly AutoAction[]): Promise<void> {
  if (!outputs.length) return;
  await input.underClaim(async tx=>{for (const o of outputs) await tx.update(catalogOutputs).set({compliance:withAutoActions(o.compliance,all),updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id));});
}
/** Stages a re-made image over the first one and updates its row. Returns true when nothing is left to hold. */
async function writeRender(deps: CatalogDeps, input: Pick<ResolvePhotoInput,"batch"|"product"|"source"|"underClaim"|"trigger"|"statusFor">, o: Output, r: RenderOutput, all: readonly AutoAction[], extra: {sourceFlags: OutputFlag[]; qaScores: Output["qaScores"]}): Promise<boolean> {
  const {batch,product,source,underClaim} = input, jpeg = r.jpeg!;
  const path = stagingPath(batchPrefix(batch.brandSlug,batch.id,batch.isTest),product.pathKey,o.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path);
  await underClaim(async()=>deps.storage.uploadBuffer(path,jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL}));
  const head = await deps.storage.headObject(uri);
  // Judge flags other than the resolved defects stay (a photo problem is not ours to fix); render flags are the new render's.
  const judged = o.flags.filter(f=>!RENDER_FLAGS.has(f) && !input.trigger.includes(f));
  const flags = [...new Set<OutputFlag>([...extra.sourceFlags,...r.flags,...judged])], status = input.statusFor(flags);
  await underClaim(async tx=>tx.update(catalogOutputs).set({canvasW:r.plan.w,canvasH:r.plan.h,scale:r.plan.scale,placedX:r.plan.placedX,placedY:r.plan.placedY,bytes:r.bytes,quality:r.quality,flags,qaScores:extra.qaScores,
    compliance:withAutoActions({...r.compliance,auto_actions:autoActionsOf(o.compliance)},all),stagingUri:uri,crc32c:head.crc32c ?? null,status,
    reason:r.notes.join("; ") || (status === "needs_attention" ? o.reason:null),updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id)));
  return status !== "needs_attention";
}

export type FlushCutInput = Omit<ResolvePhotoInput,"failing"|"rejudge"|"trigger"|"cutMinRunFraction">;
/**
 * The judge saw the photo cut at its frame edge (`complete_product`) but the geometric detector found
 * no cut (its 25% run rule misses a knee-level cut). Re-render every channel of the photo with the
 * relaxed run fraction so the cut sits flush with the canvas edge. Applied only when the relaxed
 * detector finds the cut and every channel still meets its rules; the record says either way.
 */
export async function flushCutPhoto(deps: CatalogDeps, input: FlushCutInput): Promise<AutoAction> {
  const trigger: OutputFlag[] = ["complete_product"], channels = input.outputs.map(o=>o.channel);
  const done = async (action: AutoAction) => { await recordActions(deps,input,input.outputs,[action]); return action; };
  if (!input.outputs.length || input.outputs.some(o=>o.flags.includes("cut_in_source"))) return {step:"flush_cut",trigger,result:"skipped",channels,rejudged:false,detail:"cut already placed flush"};
  const {source,product} = input;
  const p = input.prepared ?? await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b));
  const matte = input.matte ?? await storedMatte(deps,source,p,input.policy.matteModel);
  if (!matte) return done({step:"flush_cut",trigger,result:"skipped",channels,rejudged:false,detail:"no cut-out stored"});
  const contextFor = input.contextFor ?? rowContext, renders = new Map<string, RenderOutput>();
  for (const o of input.outputs) {
    await input.underClaim(async()=>{});
    const r = (await deps.renderAllChannels(p,matte,[o.channel],{shotNumber:source.n,productType:product.productType ?? "other",identifier:product.identifier,publicObjectPath:o.objectPath,...contextFor(o),synthesiseShadow:input.shadowAllowed,cutMinRunFraction:JUDGED_CUT_MIN_RUN_FRACTION}))[o.channel];
    if (!r.flags.includes("cut_in_source")) return done({step:"flush_cut",trigger,result:"failed",channels,rejudged:false,detail:"no cut edge found"});
    if (!ok(r)) return done({step:"flush_cut",trigger,result:"failed",channels,rejudged:false,detail:`${o.channel}: ${codes(r)}`});
    renders.set(o.id,r);
  }
  const action: AutoAction = {step:"flush_cut",trigger,result:"passed",channels,rejudged:false};
  // Nothing is resolved: `complete_product` stays as the photo's note; only the placement changes.
  for (const o of input.outputs) await writeRender(deps,{...input,trigger:[]},o,renders.get(o.id)!,[action],{sourceFlags:source.flags,qaScores:o.qaScores});
  return action;
}

/** Wrap a re-judge so a spending-limit stop ends the ladder instead of failing the chunk. */
export function stopOn(isStop: (error: unknown) => boolean, rejudge: Rejudge): Rejudge {
  return async (o,jpeg)=>{ try { return await rejudge(o,jpeg); } catch (error) { if (isStop(error)) throw new LadderStopped(error instanceof Error ? error.message:String(error)); throw error; } };
}
