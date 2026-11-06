import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogChangeEvents, catalogChannelListings, catalogChunks, catalogContentVersions, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages } from "../../db/schema";
import { recordChange, type GraphDb } from "../../graph";
import { imageAsset, publishChangeSetId, publishChangeType, publishReason, recordOutputVersion, REMOVED_CHANGE_TYPE, type PublishedSlot } from "../../graph/write-path";
import { IMPROVE_ACTOR } from "../improve";
import * as storage from "../../storage";
import { channel, CHANNEL_RULES_VERSION } from "../channels";
import { assertWithinProduct, productPrefix, publicObjectPath } from "../naming";
import { lockProducts } from "../products";
import type { ChannelId, EventKind } from "../types";
import { verifyPublic } from "./verify";
import { CHANNEL_IMAGE_LIMITS } from "../ingest/append";
import type { ChannelRules } from "../channel-rules";
import { frozenChannels } from "../holdout";
import { autoDecideNote, autoDecideOf, heldForPerson } from "../auto-decide";
import { restoreUnpassedImprovements } from "../improve";
import { otherTargetUpscalerId, upscaleConfigFromEnv, upscalerId, upscalerKey } from "../upscale";
export { lockProducts };
export type Output = typeof catalogOutputs.$inferSelect;
export type Source = typeof catalogSourceImages.$inferSelect;
export interface PublishDeps { db: Db; storage: Pick<typeof storage, "headObject" | "downloadBuffer" | "stageCopyToPublic" | "deletePublicObject" | "setCustomTime" | "getPublicBucketName">; fetch: typeof fetch; now: () => Date; sleep?: (ms:number) => Promise<void>;
  /** M3-S1: the render-key versions of the channel rows the worker rendered with (channel-rules.ts); M5-S3: of the batch's pinned ruleset version (null: the latest). */ channelRules: (version?: number | null) => Promise<Pick<ChannelRules, "keyVersion">>;
  /** M0-S3: a version or change-log write that failed is logged here (ERROR) and never fails the delivery (decision D26). */ log?: (message: string, fields?: Record<string, unknown>) => void
  /** M1 D30: the image limit per channel for a follow-up batch; absent, CHANNEL_IMAGE_LIMITS (empty: no limit). */ imageLimits?: Partial<Record<ChannelId, number>> }
/** M3-F3-R3: the note on an output a running experiment's listing kept out of this publish. */
export const HOLDOUT_KEPT_NOTE = "This listing is part of a running test, so its live image was kept as it is.";
/**
 * `upscaler` (spec 11): the upscaler model id, only when it made the output. The plain key does not depend on the
 * upscaler, so the path without it keeps its keys (spec 11 A's CHANNEL_RULES_VERSION 8 changes every key once, on
 * purpose: sharpening changes output bytes); an upscaled output's key is upscaledRenderKey of the plain one.
 */
export function renderKey(input: { sourceSha256: string; channel: ChannelId; n: number; policyKey: string; rulesVersion?: string; upscaler?: string | null }): string {
  const plain = createHash("sha256").update(`${input.sourceSha256}|${input.channel}|${input.rulesVersion ?? CHANNEL_RULES_VERSION}|${input.policyKey}|${input.n}`).digest("hex");
  return input.upscaler ? upscaledRenderKey(plain, input.upscaler) : plain;
}
/** The render_key of an output the upscaler made: the plain key with the upscaler id and UPSCALER_VERSION ("u:<id>:<version>"). */
export function upscaledRenderKey(plainKey: string, model: string): string {
  return createHash("sha256").update(`${plainKey}|${upscalerKey(model)}`).digest("hex");
}
/**
 * The render_key of an output row after a (re-)render: a row that becomes upscaled takes the upscaled key of its
 * plain key; a row that was upscaled and is now plain (a fallback, or a smaller fit under the threshold) goes back to
 * the plain key (`plain`, recomputed, since the upscaled key cannot be undone); otherwise the row keeps its key.
 */
export function rerenderedKey(row: { renderKey: string; flags: readonly string[] }, upscaleModel: string | null | undefined, plain: () => string): string {
  const was = row.flags.includes("upscaled");
  if (upscaleModel && !was) return upscaledRenderKey(row.renderKey, upscaleModel);
  // Spec 16 3.1.3: a row upscaled before (perhaps on the GPU) and re-made on the CPU service takes the CPU key, so
  // CPU bytes never keep a GPU key. Spec 18 quality: likewise a row upscaled before and re-made, perhaps by the other
  // model (x2 or x4), takes the key of the model that made it now. The plain key is recomputed because an upscaled key
  // cannot be undone.
  if (upscaleModel && was) return upscaledRenderKey(plain(), upscaleModel);
  if (!upscaleModel && was) return plain();
  return row.renderKey;
}
/**
 * The keys a live output may carry and still match this render: the plain key and, when UPSCALE_MODEL is
 * set, the key of an output the upscaler made. Whether a render needs the upscaler is known only after its
 * plan, so an output made on the plain path (no enlargement beyond the threshold, or a fallback) and one
 * the upscaler made both count as unchanged. `upscaleModels` are upscalerIds (spec 18 quality: the x2 and the x4
 * model, either may make an output); an output a model made on the other matting service (GPU or CPU, spec 16) also
 * counts as unchanged, so moving the upscaler re-makes nothing.
 */
export function renderKeys(input: Omit<Parameters<typeof renderKey>[0], "upscaler">, upscaleModels: string | readonly string[] | null = configuredUpscalerIds()): string[] {
  const plain = renderKey(input);
  const models = upscaleModels === null ? [] : typeof upscaleModels === "string" ? [upscaleModels] : upscaleModels;
  return [plain, ...models.flatMap((model) => [upscaledRenderKey(plain, model), upscaledRenderKey(plain, otherTargetUpscalerId(model))])];
}
/** One output's sheet note, "<Channel label> img <n>: <reason>" (spec 06 5.6). The publish step and the report write the same words, so the report's de-duplication finds them. */
export function outputNote(o: Pick<Output, "channel" | "n" | "reason" | "decision" | "decidedBy">): string {
  return `${channel(o.channel).label} img ${o.n}: ${o.decision === "use_as_is" ? `kept as is by ${o.decidedBy}: ` : ""}${o.reason}`;
}
export interface PublishPlan { copies: { output: Output; objectPath: string; ifGenerationMatch: number }[]; deletes: { output: Output; objectPath: string; ifGenerationMatch: number }[]; kept: Output[]; skipped: { output: Output; reason: string }[] }
/** M1 D30: the note on a follow-up photo that is not added because its channel's image limit is reached. */
export function overLimitNote(channelId: ChannelId, limit: number): string {
  return `Not added: ${channel(channelId).label} takes at most ${limit} images of a product. The photos already live are kept.`;
}
/** M1 D30: the note on a follow-up photo whose place already holds another batch's live photo (it only adds, never replaces). */
export const APPEND_TAKEN_NOTE = "Not added: another batch's live photo already has this place, and more photos never replace one. The technical team will look at it.";
/** M1 D30: the refusal when a follow-up would delete or overwrite a public object another batch made. */
export const NOT_OWN_OBJECT = "A follow-up batch only removes or replaces photos it made itself.";
/**
 * M1 D30 (re-review P1-A), checked next to assertWithinProduct: a follow-up batch may delete or overwrite only a live
 * output it made itself, named by its batch id and shot number, never whatever sits at that place.
 */
export function assertOwnedByBatch(output: Pick<Output, "batchId" | "n">, batchId: string | undefined, n: number): void {
  if (!batchId || output.batchId !== batchId || output.n !== n) throw new Error(NOT_OWN_OBJECT);
}
/**
 * `append` (M1 D30, a follow-up batch `batchId`): photos are only added. A live photo of another batch is never
 * deleted or overwritten: a copy onto its place, or above its channel's image limit (`limits`), is not added and is
 * returned in `skipped` (flagged `not_added` by publishProduct). A "remove" decision deletes only the batch's own live
 * output of that shot.
 */
export function planPublish(input: { brandSlug: string; pathKey: string; isTest: boolean; channels: ChannelId[]; sources: Pick<Source,"n">[]; outputs: Output[]; live: Output[]; append?: boolean; batchId?: string; limits?: Partial<Record<ChannelId, number>> }): PublishPlan {
  const scope = productPrefix(input.brandSlug, input.pathKey, input.isTest), selected = input.live.filter(o => input.channels.includes(o.channel));
  const skipped: PublishPlan["skipped"] = [];
  const addable = (output: Output): boolean => {
    if (!input.append) return true;
    const limit = input.limits?.[output.channel];
    if (limit !== undefined && output.n > limit) { skipped.push({ output, reason: overLimitNote(output.channel, limit) }); return false; }
    if (selected.some(o => o.channel === output.channel && o.n === output.n && o.batchId !== input.batchId)) { skipped.push({ output, reason: APPEND_TAKEN_NOTE }); return false; }
    return true;
  };
  const copies = input.outputs.filter(o => o.status === "staged" || (o.status === "verified" && !o.isLive) || (o.decision === "use_as_is" && !o.isLive)).filter(o => o.decision !== "remove" && o.decision !== "replaced").filter(addable).map(output => {
    const objectPath = publicObjectPath(input.brandSlug, input.pathKey, output.channel, output.n, input.isTest);
    if (!input.channels.includes(output.channel)) throw new Error("Publication channel is outside this batch.");
    assertWithinProduct(objectPath, scope);
    const target = selected.find(o => o.channel === output.channel && o.n === output.n);
    if (input.append && target) assertOwnedByBatch(target, input.batchId, output.n);
    return { output, objectPath, ifGenerationMatch: target?.generation ?? 0 };
  });
  // M1 D40: a live row a re-cut left held for a person or left out (only recutPhotos resets a live row without keeping it): the bad image it replaces comes down.
  // Image 1 held stays until the person decides: a listing with no first image is worse than the image it had.
  const first = input.sources.length ? Math.min(...input.sources.map(s => s.n)) : null;
  const removes = (o: Output) => input.outputs.some(x => x.channel === o.channel && x.n === o.n && (x.decision === "remove" || (x.id === o.id && ((heldForPerson(x) && x.n !== first) || x.flags.includes("auto_dropped")))));
  const deletes = selected.filter(o => input.append ? o.batchId === input.batchId && removes(o) : !input.sources.some(s => s.n === o.n) || removes(o)).map(output => {
    assertWithinProduct(output.objectPath, scope);
    if (input.append) assertOwnedByBatch(output, input.batchId, output.n);
    return { output, objectPath: output.objectPath, ifGenerationMatch: output.generation ?? 0 };
  });
  const kept = selected.filter(o => (input.append || input.sources.some(s => s.n === o.n)) && !input.outputs.some(x => x.channel === o.channel && x.n === o.n));
  return { copies, deletes, kept, skipped };
}
/**
 * Finalization releases completed products; attention products retain their batch lock. M1-F3-R7: an auto-decide batch
 * (`everyProduct`) releases every product it locked, so no product of it ever blocks the next batch.
 */
export async function releaseLocks(db: Db, batchId: string, options: { everyProduct?: boolean } = {}): Promise<number> {
  const completed = db.select({ id: catalogBatchProducts.productId }).from(catalogBatchProducts).where(options.everyProduct ? eq(catalogBatchProducts.batchId, batchId) : and(eq(catalogBatchProducts.batchId, batchId), ne(catalogBatchProducts.change, "pending_attention")));
  return (await db.update(catalogProducts).set({ lockBatchId: null }).where(and(eq(catalogProducts.lockBatchId,batchId), inArray(catalogProducts.id,completed))).returning({ id: catalogProducts.id })).length;
}
/** M1-F3-R2: the note of an auto-decide product with no deliverable photo at all (an exception, never a held product). */
export const NO_DELIVERABLE_PHOTO = "No photo of this product could be delivered in this batch. Links from earlier batches stay as they were.";
/** `batch` (brand and test flag, for the worker's cost ledger row) is present whenever the batch was read. */
/**
 * `changed`: this call published a real content change (new, updated, reordered or removed shots). An unchanged
 * or failed publish is not a change (spec 18 H4: only a change re-opens a done batch).
 */
export async function publishProduct(deps: PublishDeps, batchId: string, productId: string): Promise<{ outcome: string; batch?: { brandSlug: string; isTest: boolean }; changed?: boolean }> {
  // M5-S3: the ruleset version the batch pinned at Start, read before the transaction (the rules read is its own query).
  const [pin] = await deps.db.select({ rulesetVersion: catalogBatches.rulesetVersion }).from(catalogBatches).where(eq(catalogBatches.id,batchId));
  const rules = await deps.channelRules(pin?.rulesetVersion ?? null);
  // M0-S3 (D26): outputs staged by a worker from before the write path get their version first, outside the publish
  // transaction (a download and a hash each), so the delivery below never waits on it or fails for it.
  await recordStagedVersions(deps, batchId, productId);
  const log = deps.log ?? (() => {});
  return deps.db.transaction(async tx => {
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id,productId)).for("update");
    if (!product || product.lockBatchId !== batchId) return { outcome: "not_locked" };
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id,batchId));
    if (!batch) return { outcome: "not_found" };
    const found = { brandSlug: batch.brandSlug, isTest: batch.isTest };
    // M1-S4 (review P2-1): an improvement's re-made slot that did not pass goes back to its delivered provisional state
    // before anything below reads the outputs, so it is neither dropped, failed nor copied over the delivered link.
    if (autoDecideOf(batch.options)) await restoreUnpassedImprovements(tx, batchId, productId, deps.now());
    const where = and(eq(catalogBatchProducts.batchId,batchId),eq(catalogBatchProducts.productId,productId));
    // M3-F3-R3, M3 3.4 need 2: read again at publish time. A listing held by an experiment takes nothing from this batch
    // (no copy, no delete); its live image stays. An output planned before the hold began is left out with a note; one
    // already verified (a republish after the hold began) keeps its state. This sits after anything that resets the
    // batch's outputs (M1-S4's restore) and before anything that reads them.
    const held = new Set((await frozenChannels(tx as unknown as Db, product.optionId, batch.channels)).map(f => f.channel));
    const channels = batch.channels.filter(c => !held.has(c));
    const heldOutputs = (await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batchId),eq(catalogOutputs.productId,productId)))).filter(o => held.has(o.channel) && o.status !== "skipped" && o.status !== "verified");
    for (const o of heldOutputs) await tx.update(catalogOutputs).set({status:"skipped",reason:HOLDOUT_KEPT_NOTE,updatedAt:deps.now()}).where(eq(catalogOutputs.id,o.id));
    if (held.size && !channels.length) {
      // Every channel of the batch is held: the product keeps all its live images. It is unchanged, never held for a
      // person nor failed (an auto-decide batch would otherwise count "nothing delivered" as an exception).
      const [pair] = await tx.select().from(catalogBatchProducts).where(where);
      const notes = pair?.notes?.includes(HOLDOUT_KEPT_NOTE) ? pair.notes : [pair?.notes, HOLDOUT_KEPT_NOTE].filter(Boolean).join("; ");
      await tx.update(catalogBatchProducts).set({ change:"unchanged", notes }).where(where);
      await tx.update(catalogProducts).set(publisherOf(batchId, batch.options.append === true)).where(eq(catalogProducts.id,productId));
      return { outcome:"published", batch:found, changed:false };
    }
    const outputs = await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batchId),eq(catalogOutputs.productId,productId)));
    const allSources = await tx.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId,batchId),eq(catalogSourceImages.productId,productId)));
    const replacedIds=new Set(allSources.flatMap(source=>source.replacesId ? [source.replacesId]:[]));
    const sources=allSources.filter(source=>!replacedIds.has(source.id));
    const all = await tx.select().from(catalogOutputs).where(eq(catalogOutputs.productId,productId));
    const live = all.filter(o => o.isLive);
    const [pair] = await tx.select().from(catalogBatchProducts).where(where);
    const missingPairs = sources.some(source=>channels.some(channel=> {
      if(outputs.some(output=>output.sourceImageId===source.id && output.channel===channel)) return false;
      // The registry key (M3 D13), and the plain CHANNEL_RULES_VERSION key a worker before M3-S1 planned with: a batch
      // open across that deploy kept unchanged products' live images under the plain key and made no output for them.
      const key = batch.options.policy ? {sourceSha256:source.sha256,channel,n:source.n,policyKey:`default|${source.matteModel ?? batch.options.policy.matteModel}`} : null;
      const keys = key ? [...renderKeys({...key,rulesVersion:rules.keyVersion(channel)}),...renderKeys(key)] : null;
      return !keys || !live.some(output=>output.channel===channel && output.n===source.n && keys.includes(output.renderKey));
    }));
    // A live row a decision just removed (a re-cut's image 1, M1 D42) still has its delete to do.
    if (product.lastBatchId === batchId && outputs.every(o=>(o.status === "verified" || o.status === "skipped") && !(o.status === "skipped" && o.isLive))) {
      let alreadyPublished = true;
      for (const output of outputs.filter(o=>o.status === "verified")) {
        const head = await deps.storage.headObject(storage.toGsUri(deps.storage.getPublicBucketName(),output.objectPath));
        if (!head.exists || head.crc32c !== output.crc32c || Number(head.generation) !== output.generation) { alreadyPublished = false; break; }
      }
      if (alreadyPublished) return {outcome:"published",batch:found};
    }
    // 07 section 1 and 5: a staged output counts as decided only after the QA judge passed it (scores,
    // or the information flag qa_sampled_out) or the operator chose "Use as is". A decision-triggered
    // publish that lands while the qa stage is still running must not copy unjudged images.
    // M1-F3: an output an auto-decide rule delivered (`provisional`) is decided, judged or not (the judge was down or capped).
    const unjudged = (o: Output) => o.status === "staged" && o.decision === null && o.qaScores === null && !o.flags.includes("qa_sampled_out") && !o.flags.includes("provisional");
    const undecided = (o: Output) => !["staged","skipped","verified"].includes(o.status) && o.decision !== "use_as_is" && o.decision !== "remove" && o.decision !== "replaced";
    // M1-F3-R7: an auto-decide batch never makes a product `pending_attention`. While any chunk holding the product is
    // open, its publish waits: the chunk's own finish publishes it once the judge and the rules are through (a decision
    // that lands mid-chunk would otherwise race triage). Once no chunk is open, an output left undecided or unjudged is
    // dropped with its reason (never published unseen). A pipeline failure (`failed`) is not a rule decision: it stays
    // failed and counted. A product that cannot be processed at all (two files with the same shot) is an exception.
    const auto = autoDecideOf(batch.options) !== null;
    if (auto) {
      const [open] = await tx.select({ id: catalogChunks.id }).from(catalogChunks).where(and(eq(catalogChunks.batchId,batchId),sql`${catalogChunks.productIds} @> jsonb_build_array(${productId}::text)`,notInArray(catalogChunks.status,["done","failed"]))).limit(1);
      if (open) return { outcome:"waiting", batch:found };
      if (pair?.flags.includes("duplicate_shot")) {
        await tx.update(catalogBatchProducts).set({ change:"failed", notes: pair.notes ?? null }).where(where);
        return { outcome:"failed", batch:found };
      }
      const now = deps.now();
      // M1 D40: a photo a rule held for a person stays held, with no link; the product goes on without it.
      for (const o of outputs.filter(o => o.status !== "failed" && !heldForPerson(o) && (undecided(o) || unjudged(o)))) {
        const dropped = { status:"skipped" as const, flags:[...new Set([...o.flags,"auto_dropped" as const])], reason:autoDecideNote("drop", o.reason), updatedAt:now };
        await tx.update(catalogOutputs).set(dropped).where(eq(catalogOutputs.id,o.id));
        Object.assign(o, dropped);
      }
    }
    if (!auto && (missingPairs || pair?.flags.includes("duplicate_shot") || outputs.some(o => unjudged(o) || undecided(o)))) {
      await tx.update(catalogBatchProducts).set({ change:"pending_attention", notes: [pair?.notes,missingPairs ? "Some photos could not be processed. Start this product again.":"",...outputs.filter(o => o.reason).map(outputNote)].filter(Boolean).join("; ") }).where(where);
      return { outcome:"held", batch:found };
    }
    const append = batch.options.append === true;
    const plan = planPublish({ ...product, channels, sources, outputs:outputs.filter(o => !held.has(o.channel)), live, append, batchId, limits: deps.imageLimits ?? CHANNEL_IMAGE_LIMITS });
    const now = deps.now(), actor = batch.createdBy;
    // M1 D30: a follow-up photo that would replace another batch's live photo or go over its channel's limit is not
    // added: it is flagged `not_added` on the output and the product (a flagged item with its note), never dropped silently.
    for (const { output, reason } of plan.skipped) {
      const flags = [...new Set([...output.flags, "not_added" as const])];
      await tx.update(catalogOutputs).set({status:"skipped",reason,flags,updatedAt:now}).where(eq(catalogOutputs.id,output.id));
      Object.assign(output, { status: "skipped", reason, flags });
    }
    if (plan.skipped.length && pair && !pair.flags.includes("not_added")) {
      pair.flags = [...pair.flags, "not_added"];
      await tx.update(catalogBatchProducts).set({ flags: pair.flags }).where(where);
    }
    if (plan.skipped.length) log("follow-up photos not added", { severity: "WARNING", batchId, productId, outputs: plan.skipped.length, reasons: [...new Set(plan.skipped.map(s => s.reason))] });
    let failure: string | null = null;
    const landed = new Map<string, { channel: ChannelId; n: number; generation: string }>();
    const changes: { channel: ChannelId; n:number; oldGeneration:number|null; newGeneration:number; sha256:string }[] = [];
    const delivered: Output[] = [];
    for (const copy of plan.copies) {
      const o = copy.output;
      try {
        if (!o.stagingUri || o.bytes === null || !o.crc32c) throw new Error("The staged image is missing. Start this product again.");
        const head = await deps.storage.headObject(storage.toGsUri(deps.storage.getPublicBucketName(),copy.objectPath));
        const previous = live.find(output => output.channel === o.channel && output.n === o.n);
        const canReuse = previous?.renderKey === o.renderKey || Number(head.generation) !== copy.ifGenerationMatch;
        let written = canReuse && head.exists && head.crc32c === o.crc32c && head.size === o.bytes && head.generation ? { generation:head.generation,crc32c:head.crc32c } : await deps.storage.stageCopyToPublic(o.stagingUri,copy.objectPath,{ifGenerationMatch:copy.ifGenerationMatch});
        if (Number(written.generation) !== copy.ifGenerationMatch) landed.set(o.id, {channel:o.channel,n:o.n,generation:String(written.generation)});
        let verified = await verifyPublic(o.publicUrl,{size:o.bytes,generation:written.generation,fetch:deps.fetch,sleep:deps.sleep,pinnedFallback:true});
        if (!verified.ok) {
          written = await deps.storage.stageCopyToPublic(o.stagingUri,copy.objectPath,{ifGenerationMatch:written.generation});
          landed.set(o.id, {channel:o.channel,n:o.n,generation:String(written.generation)});
          verified = await verifyPublic(o.publicUrl,{size:o.bytes,generation:written.generation,fetch:deps.fetch,sleep:deps.sleep,pinnedFallback:true});
        }
        if (!verified.ok) throw new Error("Uploaded file could not be read back from the public link");
        // M0-F2-R8: the version came with the staged image (or from recordStagedVersions); a missing one never stops
        // the delivery: it is logged here and reported by the output_without_version invariant.
        if (!o.contentVersionId) log("content version missing at publish",{severity:"ERROR",batchId,productId,outputId:o.id});
        delivered.push(o);
        await tx.update(catalogOutputs).set({isLive:false,supersededAt:now,supersededByOutputId:o.id,updatedAt:now}).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.channel,o.channel),eq(catalogOutputs.n,o.n),ne(catalogOutputs.id,o.id),eq(catalogOutputs.isLive,true)));
        await tx.update(catalogOutputs).set({isLive:true,status:"verified",generation:Number(written.generation),crc32c:written.crc32c,publishedAt:o.publishedAt ?? now,publishedBy:o.decidedBy ?? actor,updatedAt:now}).where(eq(catalogOutputs.id,o.id));
        changes.push({channel:o.channel,n:o.n,oldGeneration:copy.ifGenerationMatch || null,newGeneration:Number(written.generation),sha256:sources.find(s => s.id === o.sourceImageId)?.sha256 ?? ""});
      } catch(error) {
        failure = error instanceof Error ? error.message : String(error);
        await tx.update(catalogOutputs).set({status:"failed",reason:failure,error:failure,updatedAt:now}).where(eq(catalogOutputs.id,o.id));
        break;
      }
    }
    // Spec 17 3.1.2 (gap B): a copy failed and the loop stopped, so the product ends `failed`; its outputs
    // still `staged` in this batch end with the same reason, so a failed product has no staged leftovers.
    if (failure) await tx.update(catalogOutputs).set({status:"failed",reason:failure,error:failure,updatedAt:now}).where(and(eq(catalogOutputs.batchId,batchId),eq(catalogOutputs.productId,productId),eq(catalogOutputs.status,"staged")));
    const removed: Output[] = [];
    if (!failure) for (const target of plan.deletes) {
      if (append) assertOwnedByBatch(target.output, batchId, target.output.n);
      await deps.storage.deletePublicObject(target.objectPath,productPrefix(product.brandSlug,product.pathKey,product.isTest),{ifGenerationMatch:target.ifGenerationMatch});
      const stillHeld = outputs.find(o => o.id === target.output.id && heldForPerson(o));
      await tx.update(catalogOutputs).set(stillHeld ? {isLive:false,supersededAt:now,updatedAt:now} : {isLive:false,status:"skipped",supersededAt:now,reason:`Removed in batch ${batch.name}`,updatedAt:now}).where(eq(catalogOutputs.id,target.output.id));
      removed.push(target.output);
    }
    // M0-F3-R1, R2: the change log, in this transaction (one event per changed slot of each listing), inside a savepoint:
    // the public links already changed, so a failed log write is rolled back alone, logged at ERROR and never fails or
    // rolls back the delivery (decision D26).
    try { await tx.transaction(sp => recordPublishEvents(sp,{batch,product,channels,live,delivered:delivered.filter(o => o.contentVersionId),removed,now,actor,rulesKeyVersion:c => rules.keyVersion(c),log})); }
    catch (error) { log("change log not written",{severity:"ERROR",batchId,productId,error:error instanceof Error ? error.message : String(error)}); }
    const previousSources = await tx.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.isCurrent,true)));
    const reordered = !append && sources.length === previousSources.length && sources.map(s=>s.sha256).sort().join("|") === previousSources.map(s=>s.sha256).sort().join("|") && sources.some(s=> previousSources.find(p=>p.n===s.n)?.sha256 !== s.sha256);
    const wasNew = !all.some(o=>o.batchId !== batchId && (o.publishedAt || o.isLive));
    // M1-F3-R2: in an auto-decide batch a product with nothing delivered on any channel is an exception, not a new product.
    const nothingDelivered = auto && !failure && !changes.length && !plan.kept.length && !outputs.some(o => o.status === "verified");
    const change = failure || nothingDelivered ? "failed" : removed.length ? "shots_removed" : wasNew ? "new" : reordered ? "reordered" : changes.length ? "updated" : "unchanged";
    const events: EventKind[] = [];
    if (wasNew && changes.length) events.push("created");
    if (changes.some(c=>c.oldGeneration)) events.push("overwritten");
    if (removed.length) events.push("shots_removed");
    if (reordered) events.push("reordered");
    if (change === "unchanged") events.push("unchanged");
    if (!wasNew && changes.some(c=>!all.some(o=>o.batchId!==batchId && o.channel===c.channel && o.publishedAt))) events.push("channel_added");
    for (const kind of events) {
      const [existing] = await tx.select({id:catalogProductEvents.id}).from(catalogProductEvents).where(and(eq(catalogProductEvents.productId,productId),eq(catalogProductEvents.batchId,batchId),eq(catalogProductEvents.kind,kind)));
      if (!existing) await tx.insert(catalogProductEvents).values({productId,batchId,kind,actor,details:{channels:batch.channels,shots:kind==="shots_removed" ? removed.map(o=>o.n):changes.map(o=>o.n),changes,removedLinks:removed.map(o=>({channel:o.channel,n:o.n,url:o.publicUrl}))}});
    }
    if (!failure) {
      for (const source of sources) {
        const old = previousSources.find(s=>s.n===source.n);
        if (old?.sha256 === source.sha256) continue;
        // M1 D30: a follow-up never retires a current photo, and a photo it did not add (skipped) does not become current.
        if (append && (old || plan.skipped.some(k => k.output.sourceImageId === source.id))) continue;
        if (old) { await deps.storage.setCustomTime(old.rawUri,now); await tx.update(catalogSourceImages).set({isCurrent:false,supersededAt:now}).where(eq(catalogSourceImages.id,old.id)); }
        await tx.update(catalogSourceImages).set({isCurrent:true}).where(eq(catalogSourceImages.id,source.id));
      }
      // M1 D30: a follow-up adds photos, so the photos it has no shot for stay current.
      if (!append) for (const old of previousSources.filter(s=>!sources.some(n=>n.n===s.n))) { await deps.storage.setCustomTime(old.rawUri,now); await tx.update(catalogSourceImages).set({isCurrent:false,supersededAt:now}).where(eq(catalogSourceImages.id,old.id)); }
    }
    const unverified = [...landed.values()].filter(copy => !changes.some(change => change.channel === copy.channel && change.n === copy.n));
    const liveNotes = [changes.length ? `Verified live images: ${changes.map(c=>`${c.channel} ${c.n}`).join(", ")}.` : "", unverified.length ? `Public images replaced but unverified: ${unverified.map(c=>`${c.channel} img ${c.n} generation ${c.generation}`).join(", ")}.` : "", !changes.length && !landed.size ? "No replacements were verified." : ""].filter(Boolean).join(" ");
    const notes = [nothingDelivered ? NO_DELIVERABLE_PHOTO : "", auto && missingPairs ? "Some photos could not be processed. Start this product again." : "", failure ? `Some images could not be published: ${failure}. ${liveNotes}` : "", removed.length ? `photos ${removed.map(o=>o.n).join(" and ")} removed in batch ${batch.name}` : "",...outputs.filter(o=>o.decision === "use_as_is" && o.reason).map(outputNote),...outputs.filter(o=>o.status === "skipped" && o.reason).map(outputNote),...outputs.filter(o=>heldForPerson(o) && o.reason).map(outputNote),...outputs.filter(o=>o.flags.includes("provisional") && o.status !== "skipped" && o.reason).map(outputNote)].filter(Boolean).join("; ");
    await tx.update(catalogBatchProducts).set({change,notes}).where(where);
    await tx.update(catalogProducts).set(publisherOf(batchId, append)).where(eq(catalogProducts.id,productId));
    return { outcome: failure || nothingDelivered ? "failed" : "published", batch: found, changed: !failure && !nothingDelivered && change !== "unchanged" };
  });
}
/**
 * M1 D30 (re-review 3 P2-1): what a publish writes on the product. Every batch becomes last_batch_id; a full batch also
 * becomes last_full_batch_id. A follow-up only adds photos, so it keeps last_full_batch_id, filling it (when a product
 * published before migration 0024 has none) with the previous publisher if that one was a full batch. Postgres reads the
 * old row in SET, so the subquery sees the previous last_batch_id.
 */
export function publisherOf(batchId: string, append: boolean) {
  if (!append) return { lastBatchId: batchId, lastFullBatchId: batchId };
  return { lastBatchId: batchId, lastFullBatchId: sql<string | null>`coalesce(${catalogProducts.lastFullBatchId}, (SELECT b.id FROM ${catalogBatches} b WHERE b.id = ${catalogProducts.lastBatchId} AND coalesce((b.options->>'append')::boolean, false) = false))` };
}
/** The upscalerId the worker's env selects (UPSCALE_MODEL on the service UPSCALE_URL names), or null when off. */
export function configuredUpscalerId(env: NodeJS.ProcessEnv = process.env): string | null {
  const config = upscaleConfigFromEnv(env);
  return config.model ? upscalerId(config.model, config.target) : null;
}
/** Spec 18 quality: every upscalerId the worker's env selects (the x2 model and, when set, the x4 model); empty when off. */
export function configuredUpscalerIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = upscaleConfigFromEnv(env);
  return config.model ? [config.model, ...(config.x4Model ? [config.x4Model] : [])].map((model) => upscalerId(model, config.target)) : [];
}


/**
 * M0-F2-R8 for outputs staged by a worker from before M0-S3 (D22, D26): their staged bytes are read and hashed outside
 * any transaction, then each version is written in its own short transaction, only while the row still holds those
 * staged bytes (same staging_uri and crc32c, no version yet). A failure is logged and left to the invariant; the
 * publish goes on without it.
 */
async function recordStagedVersions(deps: PublishDeps, batchId: string, productId: string): Promise<void> {
  const log = deps.log ?? (() => {});
  const rows = await deps.db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, batchId), eq(catalogOutputs.productId, productId), isNull(catalogOutputs.contentVersionId), isNotNull(catalogOutputs.stagingUri), inArray(catalogOutputs.status, ["staged", "needs_attention"])));
  if (!rows.length) return;
  const [product] = await deps.db.select().from(catalogProducts).where(eq(catalogProducts.id, productId));
  const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!product || !batch) return;
  for (const output of rows) {
    try {
      const [source] = await deps.db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, output.sourceImageId));
      if (!source) continue;
      const asset = await imageAsset((await deps.storage.downloadBuffer(output.stagingUri!)).buf, output.stagingUri!, "image/jpeg");
      await deps.db.transaction(async tx => {
        const contentVersionId = await recordOutputVersion(tx, { output, source, product, batch, asset });
        await tx.update(catalogOutputs).set({ contentVersionId }).where(and(eq(catalogOutputs.id, output.id), isNull(catalogOutputs.contentVersionId), eq(catalogOutputs.stagingUri, output.stagingUri!), output.crc32c ? eq(catalogOutputs.crc32c, output.crc32c) : isNull(catalogOutputs.crc32c)));
      });
    } catch (error) {
      log("content version not recorded", { severity: "ERROR", batchId, productId, outputId: output.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * M0-F3-R1, R2, R9: one `links_delivered` event per delivered slot and one `removed` event per emptied slot, on every
 * listing of the option on that channel (both markets when the channel keeps one image set), each with its reason and
 * M10 change type. The slot's previous version is the last event on that listing slot (else the other live output's
 * version), so an output row re-made in place (an M1-S4 improvement, Try again) is logged as the change it is. The key
 * names the output, the slot's last event (its seq) and the listing (D27): a retry of the same publish finds the last
 * event already at this version and writes nothing, a retry after a rollback rebuilds the same key, and a re-made row
 * gets a new event even when its versions repeat (A, B, A, B). Exported for the write-path tests. A product with no option
 * yet (M0-S2 has not linked it), or with no listing on a channel, still gets one event per changed slot of that channel:
 * on the product and channel instead of a listing (D23), keyed `publish:<output id>:<last seq>:product`.
 */
export async function recordPublishEvents(db: GraphDb, input: { batch: typeof catalogBatches.$inferSelect; product: typeof catalogProducts.$inferSelect; channels: ChannelId[]; live: Output[]; delivered: Output[]; removed: Output[]; now: Date; actor: string; rulesKeyVersion: (c: ChannelId) => string; log?: PublishDeps["log"] }): Promise<void> {
  const { batch, product, live, delivered, removed, now, actor } = input;
  const log = input.log ?? (() => {});
  // A key that already names an equal event writes nothing; with keys on the slot's last event that only happens if
  // the log was read wrong, so it is reported, never dropped in silence (review 2 P2-2).
  const write = async (e: Parameters<typeof recordChange>[1], outputId: string) => {
    if (!(await recordChange(db, e)).created) log("change event already recorded", { severity: "ERROR", batchId: batch.id, productId: product.id, outputId, listingId: e.listingId, slot: e.slot, idempotencyKey: e.idempotencyKey });
  };
  if (!delivered.length && !removed.length) return;
  const touched = [...new Set([...delivered, ...removed].map(o => o.channel))].filter(c => input.channels.includes(c));
  if (!touched.length) return;
  const listings = product.optionId ? await db.select({ id: catalogChannelListings.id, channel: catalogChannelListings.channel }).from(catalogChannelListings)
    .where(and(eq(catalogChannelListings.optionId, product.optionId), inArray(catalogChannelListings.channel, touched))) : [];
  // D23: a channel where the product has no listing yet (no option, or none on that channel) logs on the product and
  // channel instead, so every delivered link has its event.
  const bare = touched.filter(c => !listings.some(l => l.channel === c));
  const targets: { id: string | null; channel: ChannelId }[] = [...listings, ...bare.map(c => ({ id: null, channel: c }))];
  const targetKey = (listingId: string | null, c: ChannelId | null) => listingId ?? `product|${c}`;
  const slots = [...new Set([...delivered, ...removed].map(o => `image:${o.n}` as const))];
  // The last event on each target slot (indexes on listing_id, slot, at and on the listing-less product_id, channel, slot).
  const lastCols = { listingId: catalogChangeEvents.listingId, channel: catalogChangeEvents.channel, slot: catalogChangeEvents.slot, kind: catalogChangeEvents.kind, toVersionId: catalogChangeEvents.toVersionId, seq: catalogChangeEvents.seq };
  const lastRows = [
    ...(listings.length ? await db.select(lastCols).from(catalogChangeEvents).where(and(inArray(catalogChangeEvents.listingId, listings.map(l => l.id)), inArray(catalogChangeEvents.slot, slots))).orderBy(desc(catalogChangeEvents.seq)) : []),
    // Every touched channel, listed or not: a listing made after a listing-less publish continues from that history.
    ...await db.select(lastCols).from(catalogChangeEvents).where(and(isNull(catalogChangeEvents.listingId), eq(catalogChangeEvents.productId, product.id), inArray(catalogChangeEvents.channel, touched), inArray(catalogChangeEvents.slot, slots))).orderBy(desc(catalogChangeEvents.seq)),
  ];
  const last = new Map<string, (typeof lastRows)[number]>();
  for (const r of lastRows) if (!last.has(`${targetKey(r.listingId, r.channel)}|${r.slot}`)) last.set(`${targetKey(r.listingId, r.channel)}|${r.slot}`, r);
  // A listing slot with no event of its own continues from the product's last listing-less event on that channel slot
  // (D23): the delivery logged before the listing existed is not logged again, and a later change starts from it.
  const lastOf = (target: { id: string | null; channel: ChannelId }, n: number) =>
    last.get(`${targetKey(target.id, target.channel)}|image:${n}`) ?? (target.id ? last.get(`${targetKey(null, target.channel)}|image:${n}`) : undefined);
  // The photos behind the images live before this publish, and the version source of each delivered image.
  const photoIds = [...new Set([...live, ...delivered].map(o => o.sourceImageId))];
  const photoSha = new Map((await db.select({ id: catalogSourceImages.id, sha256: catalogSourceImages.sha256 }).from(catalogSourceImages).where(inArray(catalogSourceImages.id, photoIds))).map(p => [p.id, p.sha256]));
  const versionIds = delivered.map(o => o.contentVersionId!);
  const versionSource = new Map(versionIds.length ? (await db.select({ id: catalogContentVersions.id, source: catalogContentVersions.source }).from(catalogContentVersions).where(inArray(catalogContentVersions.id, versionIds))).map(v => [v.id, v.source]) : []);
  // Who re-made a delivered row in place: the latest "enlargement_retried" product event of the batch for that shot.
  const retried = delivered.some(o => o.publishedAt) ? await db.select({ id: catalogProductEvents.id, actor: catalogProductEvents.actor, details: catalogProductEvents.details }).from(catalogProductEvents)
    .where(and(eq(catalogProductEvents.productId, product.id), eq(catalogProductEvents.batchId, batch.id), eq(catalogProductEvents.kind, "enlargement_retried"))).orderBy(desc(catalogProductEvents.at)) : [];
  const changeSetId = publishChangeSetId(batch.id, product.id);
  const common = { at: now, evidence: "tool_publish" as const, actor, changeSetId, batchId: batch.id, productId: product.id };
  for (const o of delivered) {
    const other = live.find(l => l.channel === o.channel && l.n === o.n && l.id !== o.id) ?? null;
    // Delivered before and now made again in place (the same row, so the same photo).
    const remade = !other && !!o.publishedAt;
    const remadeBy = remade ? retried.find(e => Number(e.details.n) === o.n) ?? null : null;
    const sourceSha256 = photoSha.get(o.sourceImageId) ?? "";
    const slot: PublishedSlot = {
      versionSource: versionSource.get(o.contentVersionId!) ?? "cleanup", n: o.n, sourceSha256,
      previousSourceSha256: remade ? sourceSha256 : other ? photoSha.get(other.sourceImageId) ?? null : null,
      movedFromOtherSlot: live.some(l => l.channel === o.channel && l.n !== o.n && photoSha.get(l.sourceImageId) === sourceSha256),
      flags: o.flags, decision: o.decision,
      remade: remade ? { by: remadeBy?.actor === IMPROVE_ACTOR ? "improvement" : "operator", ref: remadeBy ? `catalog_product_events:${remadeBy.id}` : null } : null,
    };
    const reason = publishReason(slot, input.rulesKeyVersion(o.channel));
    for (const target of targets.filter(t => t.channel === o.channel)) {
      const before = lastOf(target, o.n);
      if (before?.toVersionId === o.contentVersionId) continue;
      const fromVersionId = before ? before.toVersionId : other?.contentVersionId ?? null;
      await write({ ...common, idempotencyKey: `publish:${o.id}:${before ? before.seq : "none"}:${target.id ?? "product"}`, listingId: target.id, channel: target.channel, slot: `image:${o.n}`, fromVersionId,
        toVersionId: o.contentVersionId!, kind: "links_delivered", evidenceRef: `catalog_outputs:${o.id}`, ...reason, changeTypeId: publishChangeType(slot) }, o.id);
    }
  }
  for (const o of removed) {
    for (const target of targets.filter(t => t.channel === o.channel)) {
      const before = lastOf(target, o.n);
      if (before?.kind === "removed") continue;
      await write({ ...common, idempotencyKey: `removed:${o.id}:${before ? before.seq : "none"}:${target.id ?? "product"}`, listingId: target.id, channel: target.channel, slot: `image:${o.n}`, fromVersionId: before ? before.toVersionId : o.contentVersionId ?? null,
        toVersionId: null, kind: "removed", evidenceRef: `catalog_outputs:${o.id}`, reasonKind: "new_content", reasonRef: null, changeTypeId: REMOVED_CHANGE_TYPE }, o.id);
    }
  }
}
