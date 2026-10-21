import sharp from "sharp";
import { eq } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { batchPrefix, stagingPath } from "@catalog/core/catalog/naming";
import { shotGeometry, type Matte, type Prepared, type RenderInput, type RenderOutput } from "@catalog/core/catalog/render";
import { autoActionsOf, LadderStopped, RENDER_FLAGS, runLadder, stepVariant, withAutoActions, type AutoAction, type LadderStep } from "@catalog/core/catalog/auto-resolve";
import { strictestChannel } from "@catalog/core/catalog/qa/policy";
import { heldInHand, isBusyBackground, passthroughMatte, passthroughProductLoss, PASSTHROUGH_PRODUCT_LOSS_MAX } from "@catalog/core/catalog/matte-guard";
import type { ChannelId, OutputFlag, ResolvedPolicy } from "@catalog/core/catalog/types";
import type { CatalogDeps } from "./deps";
import { renderKey, rerenderedKey } from "@catalog/core/catalog/pipeline/publish";

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
  /** Keeps a flush cut placed by `flushCutPhoto` (the judge-relaxed cut detector) in every step. */
  judgedCut?: boolean;
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
 * second matte model, (b2) only for `product_removed`: the whole frame kept (the pass-through matte
 * of matte-guard.ts, flag `matte_passthrough`), (c) a 5% smaller fit. Each step re-renders the failing channels, re-runs the
 * compliance checks (the renderer's guard) and, when the judge flagged the photo, re-judges once.
 * The first step that passes is applied to every channel of the photo, so all marketplaces show the
 * same treatment; a channel the winning step would break keeps its first image. Every step and its
 * result is appended to each output's `compliance.auto_actions`. Returns the output ids it fixed.
 */
export async function resolvePhoto(deps: CatalogDeps, input: ResolvePhotoInput): Promise<ResolveResult> {
  const {product,source,underClaim} = input;
  if (!input.failing.length) return {winner:null,actions:[],fixed:new Set()};
  // Ids for the matting service's log lines (x-catalog-batch / x-catalog-product) and the upscale log.
  const trace = {batchId:input.batch.id,productId:product.id};
  const p = input.prepared ?? await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b,trace));
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
    const matte = await deps.matteFor(p,deps.matting,secondModel,{},trace);
    second = matte.source === "model" ? matte : null;
    return second;
  };
  // The whole frame kept (matte-guard.ts), the last answer to a cut-out that removed the product.
  let passthrough: Matte | undefined;
  const passthroughFor = () => passthrough ??= passthroughMatte(p,[first,...(second ? [second]:[])]);
  const contextFor = input.contextFor ?? rowContext;
  const render = async (o: Output, step: LadderStep): Promise<RenderOutput> => {
    const variant = stepVariant(step), matte = variant.matte === "second" ? (await secondMatte())! : variant.matte === "passthrough" ? passthroughFor() : first;
    await underClaim(async()=>{});
    return (await deps.renderAllChannels(p,matte,[o.channel],{shotNumber:source.n,productType:product.productType ?? "other",identifier:product.identifier,publicObjectPath:o.objectPath,...contextFor(o),synthesiseShadow:variant.synthesiseShadow,...(variant.fitScale !== 1 ? {fitScale:variant.fitScale}:{}),...(input.judgedCut ? {judgedCut:true}:{}),trace}))[o.channel];
  };
  const renders = new Map<string, RenderOutput>();
  // Assigned inside the step callback; the casts keep TypeScript from narrowing them to null.
  let verdict = null as RejudgeVerdict | null, judgedChannel = null as ChannelId | null;
  const {winner,actions} = await runLadder(input.trigger,input.failing.map(o=>o.channel),async step=>{
    if (step === "shadow_off" && !input.failing.some(o=>o.flags.includes("shadow_synthesised"))) return {passed:false,skipped:true,detail:"no added shadow"};
    if (step === "second_matte" && !(await secondMatte())) return {passed:false,skipped:true,detail:"no second cut-out available"};
    // A pass-through replaces a plain backdrop only; on a busy background it would leave scenery around the product.
    if (step === "matte_passthrough" && isBusyBackground(p,passthroughFor(),[first,...(second ? [second]:[])])) return {passed:false,skipped:true,detail:"busy background"};
    // Nor where the backdrop is the product's own colour: the recolour would take the product with it.
    if (step === "matte_passthrough" && passthroughProductLoss(p,[first,...(second ? [second]:[])]) > PASSTHROUGH_PRODUCT_LOSS_MAX) return {passed:false,skipped:true,detail:"background matches the product"};
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
  const winning = stepVariant(winner).matte === "second" ? second : stepVariant(winner).matte === "passthrough" ? passthrough : undefined;
  if (winning && source.matteUri) {
    // The winning cut-out becomes the photo's matte, so any later render of this shot uses it too.
    const {path} = deps.storage.parseGsUri(source.matteUri), suffix = winning === passthrough ? ".matte-whole.png" : ".matte2.png", nextPath = path.replace(/\.matte[^/]*\.png$/,"")+suffix;
    const png = await sharp(winning.alpha,{raw:{width:p.width,height:p.height,channels:1}}).png().toBuffer();
    const matte = winning;
    sourceFlags = [...source.flags.filter(f=>f!=="fallback_matte" && f!=="matte_passthrough"),...(winning === passthrough ? ["matte_passthrough" as const]:[])];
    const uri = await underClaim(async()=>deps.storage.uploadBuffer(nextPath,png,"image/png"));
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
async function writeRender(deps: CatalogDeps, input: Pick<ResolvePhotoInput,"batch"|"product"|"source"|"policy"|"underClaim"|"trigger"|"statusFor">, o: Output, r: RenderOutput, all: readonly AutoAction[], extra: {sourceFlags: OutputFlag[]; qaScores: Output["qaScores"]}): Promise<boolean> {
  const {batch,product,source,underClaim} = input, jpeg = r.jpeg!;
  const path = stagingPath(batchPrefix(batch.brandSlug,batch.id,batch.isTest),product.pathKey,o.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path);
  await underClaim(async()=>deps.storage.uploadBuffer(path,jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL}));
  const head = await deps.storage.headObject(uri);
  // Judge flags other than the resolved defects stay (a photo problem is not ours to fix); render flags are the new render's.
  const judged = o.flags.filter(f=>!RENDER_FLAGS.has(f) && !input.trigger.includes(f));
  const flags = [...new Set<OutputFlag>([...extra.sourceFlags,...r.flags,...judged])], status = input.statusFor(flags);
  // Spec 11: `upscaled` is a render flag, so the re-render decides the key too (the upscaler may win or lose here).
  const key = rerenderedKey(o,r.upscale?.model,()=>renderKey({sourceSha256:source.sha256,channel:o.channel,n:source.n,policyKey:`default|${input.policy.matteModel}`}));
  await underClaim(async tx=>tx.update(catalogOutputs).set({renderKey:key,canvasW:r.plan.w,canvasH:r.plan.h,scale:r.plan.scale,placedX:r.plan.placedX,placedY:r.plan.placedY,bytes:r.bytes,quality:r.quality,flags,qaScores:extra.qaScores,
    compliance:withAutoActions({...r.compliance,auto_actions:autoActionsOf(o.compliance)},all),stagingUri:uri,crc32c:head.crc32c ?? null,status,
    reason:r.notes.join("; ") || (status === "needs_attention" ? o.reason:null),updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id)));
  return status !== "needs_attention";
}

export type FlushCutInput = Omit<ResolvePhotoInput,"failing"|"rejudge"|"trigger"|"judgedCut">;
/**
 * The judge saw the photo cut at its frame edge (`judgeSawSourceCut`) on a side the cut detector did
 * not place flush (a cut-out on the photo's own background colour, with no visible photo edge).
 * Re-render every channel of the photo with the judge-relaxed detector (`judgedCut`) so the cut sits
 * flush with the canvas edge. Applied only when the relaxed detector finds a cut side the first
 * render did not have and every channel still meets its rules; the record says either way.
 */
export async function flushCutPhoto(deps: CatalogDeps, input: FlushCutInput): Promise<AutoAction> {
  const trigger: OutputFlag[] = ["complete_product"], channels = input.outputs.map(o=>o.channel);
  const done = async (action: AutoAction) => { await recordActions(deps,input,input.outputs,[action]); return action; };
  if (!input.outputs.length) return {step:"flush_cut",trigger,result:"skipped",channels,rejudged:false,detail:"nothing to re-make"};
  const {source,product} = input, trace = {batchId:input.batch.id,productId:product.id};
  const p = input.prepared ?? await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b,trace));
  const matte = input.matte ?? await storedMatte(deps,source,p,input.policy.matteModel);
  if (!matte) return done({step:"flush_cut",trigger,result:"skipped",channels,rejudged:false,detail:"no cut-out stored"});
  // Only a side the first render did not already place flush is worth a re-render.
  const sides = (judgedCut: boolean) => { const cut = shotGeometry(matte.alpha,p.width,p.height,{rgb:p.rgb,judgedCut})?.cut; return cut ? (["top","bottom","left","right"] as const).filter(side=>cut[side]):[]; };
  const before = sides(false), after = sides(true);
  if (!after.some(side=>!before.includes(side))) return done({step:"flush_cut",trigger,result:before.length ? "skipped":"failed",channels,rejudged:false,detail:before.length ? "cut already placed flush":"no cut edge found"});
  const contextFor = input.contextFor ?? rowContext, renders = new Map<string, RenderOutput>();
  // A product held in a hand does not rest on a floor: no synthesised contact shadow (matte-guard.ts).
  const shadowAllowed = input.shadowAllowed && !heldInHand(p,matte.alpha).held;
  for (const o of input.outputs) {
    await input.underClaim(async()=>{});
    const r = (await deps.renderAllChannels(p,matte,[o.channel],{shotNumber:source.n,productType:product.productType ?? "other",identifier:product.identifier,publicObjectPath:o.objectPath,...contextFor(o),synthesiseShadow:shadowAllowed,judgedCut:true,trace}))[o.channel];
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
