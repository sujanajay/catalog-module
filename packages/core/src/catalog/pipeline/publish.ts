import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages } from "../../db/schema";
import * as storage from "../../storage";
import { CHANNEL_RULES_VERSION } from "../channels";
import { assertWithinProduct, productPrefix, publicObjectPath } from "../naming";
import { lockProducts } from "../products";
import type { ChannelId, EventKind } from "../types";
import { verifyPublic } from "./verify";
export { lockProducts };
export type Output = typeof catalogOutputs.$inferSelect;
export type Source = typeof catalogSourceImages.$inferSelect;
export interface PublishDeps { db: Db; storage: Pick<typeof storage, "headObject" | "stageCopyToPublic" | "deletePublicObject" | "setCustomTime" | "getPublicBucketName">; fetch: typeof fetch; now: () => Date; sleep?: (ms:number) => Promise<void> }
export function renderKey(input: { sourceSha256: string; channel: ChannelId; n: number; policyKey: string; rulesVersion?: string }): string {
  return createHash("sha256").update(`${input.sourceSha256}|${input.channel}|${input.rulesVersion ?? CHANNEL_RULES_VERSION}|${input.policyKey}|${input.n}`).digest("hex");
}
export interface PublishPlan { copies: { output: Output; objectPath: string; ifGenerationMatch: number }[]; deletes: { output: Output; objectPath: string; ifGenerationMatch: number }[]; kept: Output[] }
export function planPublish(input: { brandSlug: string; pathKey: string; isTest: boolean; channels: ChannelId[]; sources: Pick<Source,"n">[]; outputs: Output[]; live: Output[] }): PublishPlan {
  const scope = productPrefix(input.brandSlug, input.pathKey, input.isTest), selected = input.live.filter(o => input.channels.includes(o.channel));
  const copies = input.outputs.filter(o => o.status === "staged" || o.status === "verified" || o.decision === "use_as_is").filter(o => o.decision !== "remove").map(output => {
    const objectPath = publicObjectPath(input.brandSlug, input.pathKey, output.channel, output.n, input.isTest);
    if (!input.channels.includes(output.channel)) throw new Error("Publication channel is outside this batch.");
    assertWithinProduct(objectPath, scope);
    return { output, objectPath, ifGenerationMatch: selected.find(o => o.channel === output.channel && o.n === output.n)?.generation ?? 0 };
  });
  const deletes = selected.filter(o => !input.sources.some(s => s.n === o.n) || input.outputs.some(x => x.channel === o.channel && x.n === o.n && x.decision === "remove")).map(output => {
    assertWithinProduct(output.objectPath, scope);
    return { output, objectPath: output.objectPath, ifGenerationMatch: output.generation ?? 0 };
  });
  const kept = selected.filter(o => input.sources.some(s => s.n === o.n) && !input.outputs.some(x => x.channel === o.channel && x.n === o.n));
  return { copies, deletes, kept };
}
/** Finalization releases completed products; attention products retain their batch lock. */
export async function releaseLocks(db: Db, batchId: string): Promise<number> {
  const completed = db.select({ id: catalogBatchProducts.productId }).from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, batchId), ne(catalogBatchProducts.change, "pending_attention")));
  return (await db.update(catalogProducts).set({ lockBatchId: null }).where(and(eq(catalogProducts.lockBatchId,batchId), inArray(catalogProducts.id,completed))).returning({ id: catalogProducts.id })).length;
}
export async function publishProduct(deps: PublishDeps, batchId: string, productId: string): Promise<{ outcome: string }> {
  return deps.db.transaction(async tx => {
    const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id,productId)).for("update");
    if (!product || product.lockBatchId !== batchId) return { outcome: "not_locked" };
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id,batchId));
    if (!batch) return { outcome: "not_found" };
    const where = and(eq(catalogBatchProducts.batchId,batchId),eq(catalogBatchProducts.productId,productId));
    const outputs = await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batchId),eq(catalogOutputs.productId,productId)));
    const sources = await tx.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId,batchId),eq(catalogSourceImages.productId,productId)));
    const all = await tx.select().from(catalogOutputs).where(eq(catalogOutputs.productId,productId));
    const live = all.filter(o => o.isLive);
    const [pair] = await tx.select().from(catalogBatchProducts).where(where);
    const missingPairs = sources.some(source=>batch.channels.some(channel=> {
      if(outputs.some(output=>output.sourceImageId===source.id && output.channel===channel)) return false;
      const key = batch.options.policy ? renderKey({sourceSha256:source.sha256,channel,n:source.n,policyKey:`default|${batch.options.policy.matteModel}`}):null;
      return !key || !live.some(output=>output.channel===channel && output.n===source.n && output.renderKey===key);
    }));
    if (product.lastBatchId === batchId && outputs.every(o=>o.status === "verified" || o.status === "skipped")) {
      let alreadyPublished = true;
      for (const output of outputs.filter(o=>o.status === "verified")) {
        const head = await deps.storage.headObject(storage.toGsUri(deps.storage.getPublicBucketName(),output.objectPath));
        if (!head.exists || head.crc32c !== output.crc32c || Number(head.generation) !== output.generation) { alreadyPublished = false; break; }
      }
      if (alreadyPublished) return {outcome:"published"};
    }
    if (missingPairs || pair?.flags.includes("duplicate_shot") || outputs.some(o => !["staged","skipped","verified"].includes(o.status) && o.decision !== "use_as_is" && o.decision !== "remove")) {
      await tx.update(catalogBatchProducts).set({ change:"pending_attention", notes: [pair?.notes,missingPairs ? "Some photos could not be processed. Start this product again.":"",...outputs.filter(o => o.reason).map(o => `${o.channel} img ${o.n}: ${o.reason}`)].filter(Boolean).join("; ") }).where(where);
      return { outcome:"held" };
    }
    const plan = planPublish({ ...product, channels:batch.channels, sources,outputs,live });
    const now = deps.now(), actor = batch.createdBy;
    let failure: string | null = null;
    const landed = new Map<string, { channel: ChannelId; n: number; generation: string }>();
    const changes: { channel: ChannelId; n:number; oldGeneration:number|null; newGeneration:number; sha256:string }[] = [];
    for (const copy of plan.copies) {
      const o = copy.output;
      try {
        if (!o.stagingUri || o.bytes === null || !o.crc32c) throw new Error("The staged image is missing. Start this product again.");
        const head = await deps.storage.headObject(storage.toGsUri(deps.storage.getPublicBucketName(),copy.objectPath));
        const previous = live.find(output => output.channel === o.channel && output.n === o.n);
        const canReuse = previous?.renderKey === o.renderKey || Number(head.generation) !== copy.ifGenerationMatch;
        let written = canReuse && head.exists && head.crc32c === o.crc32c && head.size === o.bytes && head.generation ? { generation:head.generation,crc32c:head.crc32c } : await deps.storage.stageCopyToPublic(o.stagingUri,copy.objectPath,{ifGenerationMatch:copy.ifGenerationMatch});
        if (Number(written.generation) !== copy.ifGenerationMatch) landed.set(o.id, {channel:o.channel,n:o.n,generation:String(written.generation)});
        let verified = await verifyPublic(o.publicUrl,{size:o.bytes,generation:written.generation,fetch:deps.fetch,sleep:deps.sleep});
        if (!verified.ok) {
          written = await deps.storage.stageCopyToPublic(o.stagingUri,copy.objectPath,{ifGenerationMatch:written.generation});
          landed.set(o.id, {channel:o.channel,n:o.n,generation:String(written.generation)});
          verified = await verifyPublic(o.publicUrl,{size:o.bytes,generation:written.generation,fetch:deps.fetch,sleep:deps.sleep});
        }
        if (!verified.ok) throw new Error("Uploaded file could not be read back from the public link");
        await tx.update(catalogOutputs).set({isLive:false,supersededAt:now,supersededByOutputId:o.id,updatedAt:now}).where(and(eq(catalogOutputs.productId,productId),eq(catalogOutputs.channel,o.channel),eq(catalogOutputs.n,o.n),ne(catalogOutputs.id,o.id),eq(catalogOutputs.isLive,true)));
        await tx.update(catalogOutputs).set({isLive:true,status:"verified",generation:Number(written.generation),crc32c:written.crc32c,publishedAt:o.publishedAt ?? now,publishedBy:o.decidedBy ?? actor,updatedAt:now}).where(eq(catalogOutputs.id,o.id));
        changes.push({channel:o.channel,n:o.n,oldGeneration:copy.ifGenerationMatch || null,newGeneration:Number(written.generation),sha256:sources.find(s => s.id === o.sourceImageId)?.sha256 ?? ""});
      } catch(error) {
        failure = error instanceof Error ? error.message : String(error);
        await tx.update(catalogOutputs).set({status:"failed",reason:failure,error:failure,updatedAt:now}).where(eq(catalogOutputs.id,o.id));
        break;
      }
    }
    const removed: Output[] = [];
    if (!failure) for (const target of plan.deletes) {
      await deps.storage.deletePublicObject(target.objectPath,productPrefix(product.brandSlug,product.pathKey,product.isTest),{ifGenerationMatch:target.ifGenerationMatch});
      await tx.update(catalogOutputs).set({isLive:false,status:"skipped",supersededAt:now,reason:`Removed in batch ${batch.name}`,updatedAt:now}).where(eq(catalogOutputs.id,target.output.id));
      removed.push(target.output);
    }
    const previousSources = await tx.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId,productId),eq(catalogSourceImages.isCurrent,true)));
    const reordered = sources.length === previousSources.length && sources.map(s=>s.sha256).sort().join("|") === previousSources.map(s=>s.sha256).sort().join("|") && sources.some(s=> previousSources.find(p=>p.n===s.n)?.sha256 !== s.sha256);
    const wasNew = !all.some(o=>o.batchId !== batchId && (o.publishedAt || o.isLive));
    const change = failure ? "failed" : removed.length ? "shots_removed" : wasNew ? "new" : reordered ? "reordered" : changes.length ? "updated" : "unchanged";
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
        if (old) { await deps.storage.setCustomTime(old.rawUri,now); await tx.update(catalogSourceImages).set({isCurrent:false,supersededAt:now}).where(eq(catalogSourceImages.id,old.id)); }
        await tx.update(catalogSourceImages).set({isCurrent:true}).where(eq(catalogSourceImages.id,source.id));
      }
      for (const old of previousSources.filter(s=>!sources.some(n=>n.n===s.n))) { await deps.storage.setCustomTime(old.rawUri,now); await tx.update(catalogSourceImages).set({isCurrent:false,supersededAt:now}).where(eq(catalogSourceImages.id,old.id)); }
    }
    const unverified = [...landed.values()].filter(copy => !changes.some(change => change.channel === copy.channel && change.n === copy.n));
    const liveNotes = [changes.length ? `Verified live images: ${changes.map(c=>`${c.channel} ${c.n}`).join(", ")}.` : "", unverified.length ? `Public images replaced but unverified: ${unverified.map(c=>`${c.channel} img ${c.n} generation ${c.generation}`).join(", ")}.` : "", !changes.length && !landed.size ? "Live images: previous images retained." : ""].filter(Boolean).join(" ");
    const notes = [failure ? `Some images could not be published: ${failure}. ${liveNotes}` : "", removed.length ? `photos ${removed.map(o=>o.n).join(" and ")} removed in batch ${batch.name}` : "",...outputs.filter(o=>o.status === "skipped" && o.reason).map(o=>`${o.channel} img ${o.n}: ${o.reason}`)].filter(Boolean).join("; ");
    await tx.update(catalogBatchProducts).set({change,notes}).where(where);
    await tx.update(catalogProducts).set({lastBatchId:batchId}).where(eq(catalogProducts.id,productId));
    return { outcome: failure ? "failed" : "published" };
  });
}
