import sharp from "sharp";
import { eq } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { batchPrefix, stagingPath } from "@catalog/core/catalog/naming";
import { shotGeometry, type Matte, type Prepared, type RenderInput, type RenderMeasured, type RenderOutput } from "@catalog/core/catalog/render";
import { actionsOn, autoActionsOf, diagnoseOutput, failuresOf, LadderStopped, MAX_REJUDGES_PER_PHOTO, MAX_REPAIRS_PER_OUTPUT, measuredOf, ownDefects, RENDER_FLAGS, variantOf, withAutoActions, type AutoAction, type AutoActionKind, type Repair, type RenderVariant } from "@catalog/core/catalog/auto-resolve";
import { strictestChannel } from "@catalog/core/catalog/qa/policy";
import { heldInHand, isBusyBackground, passthroughMatte, passthroughProductLoss, PASSTHROUGH_PRODUCT_LOSS_MAX } from "@catalog/core/catalog/matte-guard";
import type { ChannelId, OutputFlag, ResolvedPolicy } from "@catalog/core/catalog/types";
import type { CatalogDeps } from "./deps";
import { primeStoredEnlargement } from "./enlarge";
import { renderKey, rerenderedKey } from "@catalog/core/catalog/pipeline/publish";
import { recordCostEvents } from "@catalog/core/cost-events";
import { matteCallUsd } from "@catalog/core/catalog/cost";

type Batch = typeof catalogBatches.$inferSelect;
type Product = typeof catalogProducts.$inferSelect;
type Source = typeof catalogSourceImages.$inferSelect;
export type Output = typeof catalogOutputs.$inferSelect;
type UnderClaim = <T>(write:(db:CatalogDeps["db"])=>Promise<T>)=>Promise<T>;

/** One judge look at a repaired output. `passed` is false while any of our own output defects remains. */
export interface RejudgeVerdict { passed: boolean; flags: OutputFlag[]; scores?: Record<string, unknown> | undefined }
export type Rejudge = (output: Output, jpeg: Buffer) => Promise<RejudgeVerdict>;

export interface ResolvePhotoInput {
  batch: Batch; product: Product; source: Source; policy: ResolvedPolicy; underClaim: UnderClaim;
  /** Every output of this photo in this batch that may be re-made (undecided, rendered or failed). */
  outputs: Output[];
  /** The outputs that showed the defect; only these are repaired (a matte change re-checks the others). */
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
export interface ResolveResult { actions: AutoAction[]; fixed: Set<string> }

/** Spec 18: a photo prepared again gets its stored x2 image primed, so a re-render never asks a service for it. */
async function preparePrimed(deps: CatalogDeps, source: Pick<typeof catalogSourceImages.$inferSelect,"id"|"rawUri"|"originalName"|"x2Uri">, trace: {batchId:string;productId:string}): Promise<Prepared> {
  const p = await deps.prepare((await deps.storage.downloadBuffer(source.rawUri)).buf,source.originalName,b=>deps.matting.convert(b,trace));
  await primeStoredEnlargement(deps,source,p);
  return p;
}
const ok = (r: RenderOutput | undefined | null): r is RenderOutput & { jpeg: Buffer } => !!r && r.status === "ok" && r.compliance.ok && !!r.jpeg;
const codes = (r: RenderOutput) => r.compliance.failures.map(f => f.split(":")[0]).join(",") || r.notes.join("; ") || r.status;
/** The context the first render used, read back from the row: one canvas per product, Styli's size kept. */
const rowContext = (o: Output): Partial<RenderInput> => ({...(o.canvasW > 0 && o.canvasH > 0 ? {canvas:{w:o.canvasW,h:o.canvasH}}:{}),...(o.channel === "styli" && o.scale > 0 ? {uniformScale:o.scale}:{})});
/** The render options of a variant, on top of the first render's shadow rule. */
function variantOptions(v: RenderVariant, shadowAllowed: boolean): Partial<RenderInput> {
  return {synthesiseShadow:v.synthesiseShadow === false ? false:shadowAllowed,...(v.keepSourceShadow === false ? {keepSourceShadow:false}:{}),...(v.fitScale !== 1 ? {fitScale:v.fitScale}:{}),...(v.anchorShift ? {anchorShift:v.anchorShift}:{}),...(v.jpegQualityMin ? {jpegQualityMin:v.jpegQualityMin}:{})};
}

/** The matte the first render used, from the stored PNG. */
export async function storedMatte(deps: CatalogDeps, source: Source, p: Prepared, model: string): Promise<Matte | null> {
  if (!source.matteUri) return null;
  const alpha = await sharp((await deps.storage.downloadBuffer(source.matteUri)).buf).toColourspace("b-w").raw().toBuffer();
  return {alpha,width:p.width,height:p.height,model:source.matteModel ?? model,ms:source.matteMs ?? 0,source:source.flags.includes("alpha_source") ? "alpha_source":"model",target:null,sentLongSide:null};
}

/** One output's place in the loop: its render options so far, its latest render and what that render measured. */
interface OutputState { o: Output; variant: RenderVariant; render: RenderOutput | null; failures: string[]; measured: RenderMeasured | null; tried: AutoActionKind[]; attempts: number; /** In the failing set (the defect was seen on it). */ target: boolean }

/**
 * The repair loop for one photo (07 4.6a). Each failing output is diagnosed from its failure codes, the
 * compliance measurement and the judge's flags (`diagnoseOutput`), and gets the repair that answers that
 * failure on that channel only: a computed move onto the Styli guide, a re-encode, the drawn shadow off,
 * a computed smaller fit, a plain re-render. A matte change (the second cut-out, the whole frame) is the
 * photo's and re-renders every channel, each with its own repairs so far, and re-checks each. When the
 * judge flagged the photo it looks again after each round, at most MAX_REJUDGES_PER_PHOTO times. An output
 * that passes is written; one that does not keeps its first image. Every step is appended to
 * `compliance.auto_actions` with the channel it changed. Returns the output ids it fixed.
 */
export async function resolvePhoto(deps: CatalogDeps, input: ResolvePhotoInput): Promise<ResolveResult> {
  const {product,source,underClaim,trigger} = input;
  if (!input.failing.length) return {actions:[],fixed:new Set()};
  // Ids for the matting service's log lines (x-catalog-batch / x-catalog-product) and the upscale log.
  const trace = {batchId:input.batch.id,productId:product.id};
  const p = input.prepared ?? await preparePrimed(deps,source,trace);
  const first = input.matte ?? await storedMatte(deps,source,p,input.policy.matteModel);
  if (!first) return {actions:[],fixed:new Set()};
  let second: Matte | null | undefined;
  const secondModel = input.policy.matteModelSecond;
  const secondPossible = !!secondModel && secondModel !== first.model && first.source !== "alpha_source";
  const secondMatte = async (): Promise<Matte | null> => {
    if (second !== undefined) return second;
    second = null;
    if (!secondPossible) return second;
    const health = await deps.matting.health();
    if (!health.models.some(m => m.id === secondModel)) return second;
    await underClaim(async()=>{});
    const matte = await deps.matteFor(p,deps.matting,secondModel!,{},trace);
    second = matte.source === "model" ? matte : null;
    // Cost ledger: the ladder's second cut-out call, on the photo. No claim write follows at once, so this
    // is a standalone savepoint write that never throws (recordCostEvents logs a failure).
    await recordCostEvents(deps.db,[{batchId:input.batch.id,brandSlug:input.batch.brandSlug,isTest:input.batch.isTest,productId:product.id,sourceImageId:source.id,stage:"matte",kind:"matte_call",engine:matte.target ?? "worker",ms:matte.ms,...matteCallUsd(matte.target,matte.ms),outcome:second ? "ok":"failed",at:deps.now()}],deps.log);
    return second;
  };
  // The whole frame kept (matte-guard.ts), the last answer to a cut-out that removed the product.
  let passthrough: Matte | undefined;
  const passthroughFor = () => passthrough ??= passthroughMatte(p,[first,...(second ? [second]:[])]);
  const contextFor = input.contextFor ?? rowContext;
  const render = async (o: Output, v: RenderVariant): Promise<RenderOutput> => {
    const matte = v.matte === "second" ? (await secondMatte())! : v.matte === "passthrough" ? passthroughFor() : first;
    await underClaim(async()=>{});
    return (await deps.renderAllChannels(p,matte,[o.channel],{shotNumber:source.n,productType:product.productType ?? "other",identifier:product.identifier,publicObjectPath:o.objectPath,...contextFor(o),...variantOptions(v,input.shadowAllowed),...(input.judgedCut ? {judgedCut:true}:{}),trace}))[o.channel];
  };
  const states = new Map<string, OutputState>();
  for (const o of input.outputs) states.set(o.id,{o,variant:variantOf(o.compliance),render:null,failures:failuresOf(o.compliance),measured:measuredOf(o.compliance),tried:actionsOn(o.compliance,o.channel).map(a=>a.step),attempts:0,target:input.failing.some(f=>f.id===o.id)});
  const targets = () => [...states.values()].filter(st=>st.target);
  const actions: AutoAction[] = [];
  const record = (step: AutoActionKind, result: AutoAction["result"], channels: ChannelId[], detail: string): AutoAction => { const a: AutoAction = {step,trigger:[...trigger],result,channels,rejudged:false,detail}; actions.push(a); return a; };
  const judgeTrigger = !!input.rejudge && trigger.some(f=>f !== "failed_compliance");
  // The flags the planner answers: the trigger, then whatever the judge still sees after a round.
  let currentTrigger: OutputFlag[] = [...trigger];
  let verdict = null as RejudgeVerdict | null, judgedChannel = null as ChannelId | null, rejudges = 0, changedSinceJudge = true, stopped = false;
  // Compliance failing: the latest render (or the row, before any) breaks a channel rule.
  const failing = (st: OutputState) => st.render ? !ok(st.render) : st.failures.length > 0 || st.o.flags.includes("failed_compliance");
  const judgePending = () => judgeTrigger && !(verdict?.passed);
  // The planner answers the judge's flags and, while the output breaks a channel rule, that rule's codes too.
  const diag = (st: OutputState): Repair[] => diagnoseOutput({channel:st.o.channel,trigger:[...new Set<OutputFlag>([...currentTrigger,...(failing(st) ? ["failed_compliance" as const]:[])])],failures:failing(st) ? (st.render ? st.render.compliance.failures:st.failures):[],measured:st.measured,current:st.variant,tried:st.tried,secondMatte:secondPossible});
  const adopt = (st: OutputState, v: RenderVariant, r: RenderOutput) => { st.variant = v; st.render = r; st.measured = r.compliance.measured ?? st.measured; };
  const renderStep = async (st: OutputState, repair: Repair): Promise<void> => {
    st.attempts++; st.tried.push(repair.step);
    const r = await render(st.o,repair.variant);
    adopt(st,repair.variant,r);
    record(repair.step,ok(r) ? "passed":"failed",[st.o.channel],ok(r) ? repair.why:`${repair.why}; ${codes(r)}`);
    changedSinceJudge = true;
  };
  // Render-level repairs, one channel at a time, until each target passes its rules or has nothing left to try.
  const renderRound = async (): Promise<void> => {
    for (const st of targets()) {
      while ((failing(st) || judgePending()) && st.attempts < MAX_REPAIRS_PER_OUTPUT) {
        const next = diag(st).find(r=>r.scope === "output");
        if (!next) break;
        await renderStep(st,next);
      }
    }
  };
  const rejudgeRound = async (): Promise<void> => {
    if (!judgeTrigger || !changedSinceJudge || rejudges >= MAX_REJUDGES_PER_PHOTO) return;
    const passing = targets().filter(st=>ok(st.render));
    if (!passing.length) return;
    const channel = strictestChannel(passing.map(st=>st.o.channel)), judged = passing.find(st=>st.o.channel === channel)!;
    const last = actions.at(-1);
    try { verdict = await input.rejudge!(judged.o,judged.render!.jpeg!); }
    catch (error) { if (!(error instanceof LadderStopped)) throw error; record("re_render","failed",[channel],error.message); stopped = true; return; }
    rejudges++; judgedChannel = channel; changedSinceJudge = false;
    // The round's last step carries the verdict: a step the judge rejects is a failed step, as the record reads it.
    if (last) { last.rejudged = true; if (!verdict.passed) last.result = "failed"; last.detail = `${last.detail ?? ""}; judge: ${verdict.passed ? "passed":verdict.flags.join(",") || "no verdict"}`.replace(/^; /,""); }
    if (!verdict.passed) currentTrigger = ownDefects(verdict.flags).length ? ownDefects(verdict.flags):currentTrigger;
  };
  // A matte change for the photo: every channel is re-made with it and re-checked, each with its own repairs so far.
  const matteRound = async (): Promise<boolean> => {
    const repair = targets().flatMap(st=>diag(st)).find(r=>r.scope === "photo");
    if (!repair) return false;
    const all = [...states.values()];
    for (const st of all) st.tried.push(repair.step);
    if (repair.step === "second_matte" && !(await secondMatte())) { record("second_matte","skipped",all.map(st=>st.o.channel),"no second cut-out available"); return true; }
    if (repair.step === "matte_passthrough") {
      const tried = [first,...(second ? [second]:[])];
      // A pass-through replaces a plain backdrop only; on a busy background it would leave scenery around the product,
      // and where the backdrop is the product's own colour the recolour would take the product with it.
      if (isBusyBackground(p,passthroughFor(),tried)) { record("matte_passthrough","skipped",all.map(st=>st.o.channel),"busy background"); return true; }
      if (passthroughProductLoss(p,tried) > PASSTHROUGH_PRODUCT_LOSS_MAX) { record("matte_passthrough","skipped",all.map(st=>st.o.channel),"background matches the product"); return true; }
    }
    const results: string[] = [];
    for (const st of all) {
      const v: RenderVariant = {...st.variant,matte:repair.variant.matte};
      const r = await render(st.o,v);
      adopt(st,v,r);
      results.push(`${st.o.channel}: ${ok(r) ? "ok":codes(r)}`);
    }
    record(repair.step,all.every(st=>ok(st.render)) ? "passed":"failed",all.map(st=>st.o.channel),`${repair.why}; ${results.join(", ")}`);
    changedSinceJudge = true;
    return true;
  };
  for (;;) {
    await renderRound();
    await rejudgeRound();
    if (stopped) break;
    const done = targets().every(st=>!failing(st) && st.render) && !judgePending();
    if (done) break;
    if (!(await matteRound())) break;
    if (stopped) break;
  }
  const written = [...states.values()].filter(st=>st.render && ok(st.render) && !judgePending());
  if (!written.length) { await recordActions(deps,input,input.outputs,actions); return {actions,fixed:new Set()}; }
  // A channel the matte change broke and no repair mended keeps its first image; the record says so.
  const kept = [...states.values()].filter(st=>st.render && st.variant.matte !== "first" && !written.includes(st));
  if (kept.length) record(kept[0]!.variant.matte === "second" ? "second_matte":"matte_passthrough","failed",kept.map(st=>st.o.channel),`kept the first image on ${kept.map(st=>st.o.channel).join(",")}`);
  let sourceFlags = source.flags;
  const winning = written.find(st=>st.variant.matte !== "first")?.variant.matte, matte = winning === "second" ? second : winning === "passthrough" ? passthrough : undefined;
  if (matte && source.matteUri) {
    // The winning cut-out becomes the photo's matte, so any later render of this shot uses it too.
    const {path} = deps.storage.parseGsUri(source.matteUri), suffix = matte === passthrough ? ".matte-whole.png" : ".matte2.png", nextPath = path.replace(/\.matte[^/]*\.png$/,"")+suffix;
    const png = await sharp(matte.alpha,{raw:{width:p.width,height:p.height,channels:1}}).png().toBuffer();
    sourceFlags = [...source.flags.filter(f=>f!=="fallback_matte" && f!=="matte_passthrough"),...(matte === passthrough ? ["matte_passthrough" as const]:[])];
    const uri = await underClaim(async()=>deps.storage.uploadBuffer(nextPath,png,"image/png"));
    await underClaim(async tx=>tx.update(catalogSourceImages).set({matteUri:uri,matteModel:matte.model,matteMs:matte.ms,flags:sourceFlags}).where(eq(catalogSourceImages.id,source.id)));
  }
  const fixed = new Set<string>();
  for (const st of written) {
    const o = st.o, done = verdict;
    const qaScores = o.qaScores && done ? {...o.qaScores,...(done.scores ? {edge_quality:done.scores.edge_quality ?? o.qaScores.edge_quality,background_clean:done.scores.background_clean ?? o.qaScores.background_clean,product_intact:done.scores.product_intact ?? o.qaScores.product_intact}:{}),rejudge:{step:[...actions].reverse().find(a=>a.rejudged)?.step ?? null,channel:judgedChannel,flags:done.flags}}:o.qaScores;
    if (await writeRender(deps,input,o,st.render!,actions,{sourceFlags,qaScores,variant:st.variant})) fixed.add(o.id);
  }
  await recordActions(deps,input,input.outputs.filter(o=>!written.some(st=>st.o.id === o.id)),actions);
  return {actions,fixed};
}

/** Appends the record to outputs that keep their image. */
async function recordActions(deps: CatalogDeps, input: Pick<ResolvePhotoInput,"underClaim">, outputs: readonly Output[], all: readonly AutoAction[]): Promise<void> {
  if (!outputs.length || !all.length) return;
  await input.underClaim(async tx=>{for (const o of outputs) await tx.update(catalogOutputs).set({compliance:withAutoActions(o.compliance,all),updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id));});
}
/** Stages a re-made image over the first one and updates its row. Returns true when nothing is left to hold. */
async function writeRender(deps: CatalogDeps, input: Pick<ResolvePhotoInput,"batch"|"product"|"source"|"policy"|"underClaim"|"trigger"|"statusFor">, o: Output, r: RenderOutput, all: readonly AutoAction[], extra: {sourceFlags: OutputFlag[]; qaScores: Output["qaScores"]; variant?: RenderVariant}): Promise<boolean> {
  const {batch,product,source,underClaim} = input, jpeg = r.jpeg!;
  const path = stagingPath(batchPrefix(batch.brandSlug,batch.id,batch.isTest),product.pathKey,o.channel,source.n), uri = deps.storage.toGsUri(deps.storage.getBucketName(),path);
  await underClaim(async()=>deps.storage.uploadBuffer(path,jpeg,"image/jpeg",{cacheControl:deps.storage.PUBLIC_CACHE_CONTROL}));
  const head = await deps.storage.headObject(uri);
  // Judge flags other than the resolved defects stay (a photo problem is not ours to fix); render flags are the new render's.
  const judged = o.flags.filter(f=>!RENDER_FLAGS.has(f) && !input.trigger.includes(f));
  const flags = [...new Set<OutputFlag>([...extra.sourceFlags,...r.flags,...judged])], status = input.statusFor(flags);
  // Spec 11: `upscaled` is a render flag, so the re-render decides the key too (the upscaler may win or lose here).
  const key = rerenderedKey(o,r.upscale?.model,()=>renderKey({sourceSha256:source.sha256,channel:o.channel,n:source.n,policyKey:`default|${input.policy.matteModel}`}));
  // The options this image was made with stay with it (relative to the stored matte), so a later repair starts from them.
  const variant = extra.variant ? {...extra.variant,matte:"first" as const}:undefined;
  await underClaim(async tx=>tx.update(catalogOutputs).set({renderKey:key,canvasW:r.plan.w,canvasH:r.plan.h,scale:r.plan.scale,placedX:r.plan.placedX,placedY:r.plan.placedY,bytes:r.bytes,quality:r.quality,flags,qaScores:extra.qaScores,
    compliance:withAutoActions({...r.compliance,...(variant ? {variant}:{}),auto_actions:autoActionsOf(o.compliance)},all),stagingUri:uri,crc32c:head.crc32c ?? null,status,
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
  const p = input.prepared ?? await preparePrimed(deps,source,trace);
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
    // The output's own repairs so far (a smaller fit, a shadow taken off) stay with it.
    const r = (await deps.renderAllChannels(p,matte,[o.channel],{shotNumber:source.n,productType:product.productType ?? "other",identifier:product.identifier,publicObjectPath:o.objectPath,...contextFor(o),...variantOptions(variantOf(o.compliance),shadowAllowed),judgedCut:true,trace}))[o.channel];
    if (!r.flags.includes("cut_in_source")) return done({step:"flush_cut",trigger,result:"failed",channels,rejudged:false,detail:"no cut edge found"});
    if (!ok(r)) return done({step:"flush_cut",trigger,result:"failed",channels,rejudged:false,detail:`${o.channel}: ${codes(r)}`});
    renders.set(o.id,r);
  }
  const action: AutoAction = {step:"flush_cut",trigger,result:"passed",channels,rejudged:false};
  // Nothing is resolved: `complete_product` stays as the photo's note; only the placement changes.
  for (const o of input.outputs) await writeRender(deps,{...input,trigger:[]},o,renders.get(o.id)!,[action],{sourceFlags:source.flags,qaScores:o.qaScores,variant:variantOf(o.compliance)});
  return action;
}

/** Wrap a re-judge so a spending-limit stop ends the loop instead of failing the chunk. */
export function stopOn(isStop: (error: unknown) => boolean, rejudge: Rejudge): Rejudge {
  return async (o,jpeg)=>{ try { return await rejudge(o,jpeg); } catch (error) { if (isStop(error)) throw new LadderStopped(error instanceof Error ? error.message:String(error)); throw error; } };
}
