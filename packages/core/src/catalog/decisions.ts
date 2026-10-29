import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { brandMaster, catalogBatches, catalogBatchProducts, catalogChunks, catalogEnlargements, catalogOutputs, catalogProductAliases, catalogProducts, catalogSourceImages, catalogUploads, skuMap } from "../db/schema";
import type * as storage from "../storage";
import { toGsUri } from "../storage";
import { DEFAULT_MAX_BYTES } from "../safe-url";
import { batchPrefix, normalizeKey, rawPath, sanitizeSegment, uploadPath } from "./naming";
import { recordEvent } from "./products";
import { parseManualMapping } from "./sku-mapping";
import { checkImage, imageFlags } from "./ingest/image-check";
import { normalizeHeader } from "./ingest/links-sheet";
import type { ChannelId, Decision, OutputFlag } from "./types";
import { INFORMATION_FLAGS } from "./qa/triage";
import { ENLARGING_TASK, enqueueEnlargements, lockProductChunks, releaseEnlargements, unparkSettledChunks, type UnparkedChunk } from "./pipeline/enlargement";
import type { enqueueTask } from "../tasks";
import { isBulkBatch } from "./pipeline/dispatch";

type Output = typeof catalogOutputs.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export class CatalogDecisionError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CatalogDecisionError"; }
}
/** The code of the "Use as is" warning on a photo that could not be enlarged (spec 18 lifecycle 3.6). */
export const PLAIN_WARNING = "plain_warning";
/**
 * Spec 18 lifecycle 3.6 (owner, 2026-10-30: "Allow, with a clear warning"): "Use as is" on a scope with an output held
 * for its enlargement answers 409 with the channels whose images would be stretched, unless the request accepts it.
 */
export class CatalogPlainWarning extends CatalogDecisionError {
  constructor(readonly channels: ChannelId[]) { super(409, PLAIN_WARNING); this.name = "CatalogPlainWarning"; }
}
const undecided = (output: Output) => output.decision === null && (output.status === "needs_attention" || output.status === "failed");
const channelFlag = (flag: OutputFlag) => flag === "placement" || flag === "failed_compliance" || flag === "low_resolution";
// Information flags never decide the scope (4.6); they ride along with the real problem. One shared
// list with the attention model and the QA triage (qa/triage.ts), including low_resolution.
const informationFlags = INFORMATION_FLAGS;
/** A shared photo issue affects undecided siblings; solely channel-specific flags stay local. */
export function decisionScope(output: Output, candidates: readonly Output[]): Output[] {
  const problems = output.flags.filter(flag => !informationFlags.has(flag));
  const local = output.status !== "failed" && problems.length > 0 && problems.every(channelFlag);
  return candidates.filter(candidate => undecided(candidate) && candidate.batchId === output.batchId && candidate.sourceImageId === output.sourceImageId && (!local || candidate.id === output.id));
}
async function readOutput(db: Db | Tx, id: string): Promise<Output> {
  const [output] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, id));
  if (!output) throw new CatalogDecisionError(404, "This photo no longer exists. Reload the page.");
  return output;
}
async function lockProduct(tx: Tx, output: Output): Promise<typeof catalogProducts.$inferSelect> {
  const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, output.productId)).for("update");
  if (!product) throw new CatalogDecisionError(404, "This product no longer exists. Reload the page.");
  if (product.lockBatchId && product.lockBatchId !== output.batchId) throw new CatalogDecisionError(409, "This product is being changed by another batch. Try again when it finishes.");
  return product;
}
/**
 * Spec 18 lifecycle 3.6, Remove and Replace: once a photo has no undecided or pending output left in the batch, its
 * enlargements are released and the product's chunks unparked (a parked chunk never waits on a thrown-away photo).
 * Lock order: the product row (held by the caller), the product's chunks by id, the rows. Returns the chunks it
 * unparked (the caller enqueues the `direct` ones after the commit).
 */
async function releasePhotoEnlargements(tx: Tx, input: { batchId: string; productId: string; sourceImageId: string; errorKind: string }, now: Date): Promise<UnparkedChunk[]> {
  const db = tx as unknown as Db;
  const [open] = await tx.select({ id: catalogOutputs.id }).from(catalogOutputs).where(and(eq(catalogOutputs.batchId, input.batchId), eq(catalogOutputs.sourceImageId, input.sourceImageId), isNull(catalogOutputs.decision), inArray(catalogOutputs.status, ["pending", "needs_attention", "failed"]))).limit(1);
  if (open) return [];
  const chunks = await lockProductChunks(db, input.batchId, input.productId);
  const released = await releaseEnlargements(db, { batchId: input.batchId, sourceImageIds: [input.sourceImageId], errorKind: input.errorKind }, now);
  return released.length ? unparkSettledChunks(db, input.batchId, chunks, now) : [];
}
export interface DecisionResult { batchId: string; productId: string; outputIds: string[]; decisionId: string; /** Spec 18 lifecycle: chunks unparked by a Remove (enqueue the `direct` ones). */ unparked?: UnparkedChunk[] }
export async function applyDecision(db: Db, input: { outputId: string; decision: Extract<Decision, "use_as_is" | "remove">; actor: string; now?: Date; /** Spec 18 lifecycle 3.6: the operator accepted the plain warning. */ acceptPlain?: boolean }): Promise<DecisionResult> {
  if (input.decision !== "use_as_is" && input.decision !== "remove") throw new CatalogDecisionError(400, "Choose whether to keep or remove this photo.");
  return db.transaction(async tx => {
    const target = await readOutput(tx, input.outputId);
    await lockProduct(tx, target);
    const siblings = await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, target.batchId), eq(catalogOutputs.sourceImageId, target.sourceImageId))).orderBy(catalogOutputs.id).for("update");
    const current = siblings.find(o => o.id === target.id)!;
    if (!undecided(current)) throw new CatalogDecisionError(409, "Already decided.");
    const scope = decisionScope(current, siblings), now = input.now ?? new Date();
    if (input.decision === "use_as_is" && scope.some(o => o.status === "failed")) throw new CatalogDecisionError(400, "Nothing was made from this photo. Remove it or replace it.");
    // Spec 18 lifecycle 3.6: nothing stages a plain image of a photo that could not be enlarged without this click.
    const plain = input.decision === "use_as_is" ? scope.filter(o => o.flags.includes("enlargement_failed")) : [];
    if (plain.length && !input.acceptPlain) throw new CatalogPlainWarning([...new Set(plain.map(o => o.channel))]);
    await tx.update(catalogOutputs).set({ decision: input.decision, decidedBy: input.actor, decidedAt: now, status: input.decision === "remove" ? "skipped" : "staged", ...(input.decision === "remove" ? { reason: `Removed by ${input.actor}` } : {}), updatedAt: now }).where(inArray(catalogOutputs.id, scope.map(o => o.id)));
    await tx.update(catalogProducts).set({ lockBatchId: target.batchId, updatedAt: now }).where(eq(catalogProducts.id, target.productId));
    if (input.decision === "remove") await recordEvent(tx, { productId: target.productId, batchId: target.batchId, kind: "removed_photo", actor: input.actor, details: { n: target.n, channels: scope.map(o => o.channel) } });
    // The flag stays on each output as the record of why it is plain (the invariant excludes it, Ops counts it).
    if (plain.length) await recordEvent(tx, { productId: target.productId, batchId: target.batchId, kind: "plain_accepted", actor: input.actor, details: { n: target.n, channels: [...new Set(plain.map(o => o.channel))] } });
    const unparked = input.decision === "remove" ? await releasePhotoEnlargements(tx, { batchId: target.batchId, productId: target.productId, sourceImageId: target.sourceImageId, errorKind: "removed" }, now) : [];
    return { batchId: target.batchId, productId: target.productId, outputIds: scope.map(o => o.id), decisionId: `${current.id}-${+now}`, ...(unparked.length ? { unparked } : {}) };
  });
}

export interface ReplacementDeps {
  db: Db;
  storage: Pick<typeof storage, "getBucketName" | "signedPutUrl" | "headObject" | "downloadBuffer" | "uploadBuffer">;
  now?: () => Date;
}
export async function startReplacement(deps: ReplacementDeps, input: { outputId: string; name: string; size: number; mime: string }): Promise<{ uploadId: string; signedPutUrl: string }> {
  if (!/[A-Za-z0-9]/.test(sanitizeSegment(input.name)) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > DEFAULT_MAX_BYTES || !input.mime.startsWith("image/")) throw new CatalogDecisionError(400, "Choose one image under 40 MB.");
  const output = await readOutput(deps.db, input.outputId);
  if (!undecided(output)) throw new CatalogDecisionError(409, "Already decided.");
  const [batch] = await deps.db.select().from(catalogBatches).where(eq(catalogBatches.id, output.batchId));
  if (!batch) throw new CatalogDecisionError(404, "This batch no longer exists.");
  const uploadId = randomUUID(), prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  const path = uploadPath(prefix, `replacements-${uploadId}`, input.name);
  const signedPutUrl = await deps.storage.signedPutUrl(path, input.mime);
  await deps.db.insert(catalogUploads).values({ id: uploadId, batchId: batch.id, kind: "image", name: input.name, mime: input.mime, sizeBytes: input.size, gcsUri: toGsUri(deps.storage.getBucketName(), path), detected: { replacementOutputId: output.id, replacementSourceId: output.sourceImageId } });
  return { uploadId, signedPutUrl };
}
export interface ReplacementResult { batchId: string; productId: string; sourceImageId: string; chunkId: string; /** Spec 18 lifecycle: chunks unparked by the old photo's release (enqueue the `direct` ones). */ unparked?: UnparkedChunk[] }
export async function completeReplacement(deps: ReplacementDeps, input: { outputId: string; uploadId: string; actor: string }): Promise<ReplacementResult> {
  return deps.db.transaction(async tx => {
    const target = await readOutput(tx, input.outputId), product = await lockProduct(tx, target);
    const output = await readOutput(tx, input.outputId);
    if (!undecided(output)) throw new CatalogDecisionError(409, "Already decided.");
    const [upload] = await tx.select().from(catalogUploads).where(eq(catalogUploads.id, input.uploadId)).for("update");
    if (!upload || upload.batchId !== output.batchId || upload.detected?.replacementOutputId !== output.id || upload.detected?.replacementSourceId !== output.sourceImageId) throw new CatalogDecisionError(400, "This upload does not belong to this photo.");
    if (upload.status !== "pending") throw new CatalogDecisionError(409, "Already decided.");
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, output.batchId));
    const prefix = batchPrefix(batch!.brandSlug, batch!.id, batch!.isTest), bucket = deps.storage.getBucketName();
    const expected = toGsUri(bucket, uploadPath(prefix, `replacements-${upload.id}`, upload.name));
    if (upload.gcsUri !== expected) throw new CatalogDecisionError(400, "This upload is outside this batch.");
    const head = await deps.storage.headObject(expected);
    if (!head.exists || head.size !== upload.sizeBytes || head.contentType !== upload.mime) throw new CatalogDecisionError(400, "The replacement upload is incomplete. Upload the photo again.");
    const { buf } = await deps.storage.downloadBuffer(expected);
    if (buf.length !== upload.sizeBytes || buf.length > DEFAULT_MAX_BYTES) throw new CatalogDecisionError(400, "The replacement upload is incomplete. Upload the photo again.");
    const info = await checkImage(buf, buf, upload.name);
    if (!info.ok) throw new CatalogDecisionError(400, info.message);
    const sha256 = createHash("sha256").update(buf).digest("hex"), now = deps.now?.() ?? new Date();
    // A private version prefix preserves the original when a shot is replaced within its own batch.
    const path = rawPath(`${prefix}/replacements-${upload.id}`, product.pathKey, output.n, info.ext);
    const rawUri = await deps.storage.uploadBuffer(path, buf, info.mime);
    if (rawUri !== toGsUri(bucket, path)) throw new Error("The replacement raw copy is outside this batch.");
    const [old] = await tx.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, output.sourceImageId));
    const [current] = await tx.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.productId, product.id), eq(catalogSourceImages.n, output.n), eq(catalogSourceImages.isCurrent, true)));
    const [source] = await tx.insert(catalogSourceImages).values({ batchId: output.batchId, productId: product.id, n: output.n, replacesId: current?.id ?? old!.id, sha256, isCurrent: false, originalName: upload.name, uploadId: upload.id, rawUri, mime: info.mime, width: info.width || null, height: info.height || null, bytes: buf.length, flags: imageFlags(info), status: "prepared" }).returning();
    await tx.update(catalogOutputs).set({ decision: "replaced", decidedBy: input.actor, decidedAt: now, status: "skipped", reason: "Replaced by a new photo", updatedAt: now }).where(and(eq(catalogOutputs.batchId, output.batchId), eq(catalogOutputs.sourceImageId, output.sourceImageId)));
    await tx.update(catalogUploads).set({ status: "collected" }).where(eq(catalogUploads.id, upload.id));
    await tx.update(catalogProducts).set({ lockBatchId: output.batchId, updatedAt: now }).where(eq(catalogProducts.id, product.id));
    await recordEvent(tx, { productId: product.id, batchId: output.batchId, kind: "replacement_uploaded", actor: input.actor, details: { n: output.n, oldSha256: old!.sha256, newSha256: sha256 } });
    const [index] = await tx.select({ value: sql<number>`coalesce(max(${catalogChunks.index}), -1) + 1` }).from(catalogChunks).where(eq(catalogChunks.batchId, output.batchId));
    // Spec 18 lifecycle F11, F32: the replaced photo's enlargements are released and the product's chunks unparked.
    const unparked = await releasePhotoEnlargements(tx, { batchId: output.batchId, productId: product.id, sourceImageId: output.sourceImageId, errorKind: "replaced" }, now);
    const [chunk] = await tx.insert(catalogChunks).values({ batchId: output.batchId, index: Number(index!.value), stage: "matte", productIds: [product.id], sourceImageIds: [source!.id], status: "queued", attempt: 0, dispatchedAt: now }).returning();
    return { batchId: output.batchId, productId: product.id, sourceImageId: source!.id, chunkId: chunk!.id, ...(unparked.length ? { unparked } : {}) };
  });
}

export interface RetryEnlargementResult { batchId: string; productId: string; chunkId: string; outputIds: string[]; rows: number; retries: number }
/**
 * Spec 18 lifecycle 3.6 "Try again" (not an output decision): in one transaction, lock the product, take the photo's
 * undecided outputs held with `enlargement_failed`, require a failed wanted row that a call can make (a size refusal
 * has no route to try again), reset those rows (queued, counters 0, the photo's identity releases 0, `retries+1`),
 * reset the outputs to `pending` (judge scores cleared, the auto-action record kept, the flag and reason dropped), lock
 * the product to the batch, insert a one-photo render chunk parked on the rows, record `enlargement_retried`, then
 * send the rows' tasks. No cap on clicks: each is a human act, logged, and costs at most the rows' counted bounds.
 */
export async function retryEnlargement(db: Db, enqueue: typeof enqueueTask, input: { outputId: string; actor: string; now?: Date; log?: (message: string, fields?: Record<string, unknown>) => void }): Promise<RetryEnlargementResult> {
  const now = input.now ?? new Date(), log = input.log ?? (() => {});
  const result = await db.transaction(async tx => {
    const target = await readOutput(tx, input.outputId);
    await lockProduct(tx, target);
    const outputs = (await tx.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, target.batchId), eq(catalogOutputs.sourceImageId, target.sourceImageId))).orderBy(catalogOutputs.id).for("update"))
      .filter(o => o.decision === null && o.flags.includes("enlargement_failed"));
    if (!outputs.length) throw new CatalogDecisionError(409, "Nothing to try again.");
    // Lock order: the product row, its chunks by id, then the rows.
    await lockProductChunks(tx as unknown as Db, target.batchId, target.productId);
    const failed = await tx.select().from(catalogEnlargements).where(and(eq(catalogEnlargements.batchId, target.batchId), eq(catalogEnlargements.sourceImageId, target.sourceImageId), eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.status, "failed"), ne(catalogEnlargements.route, "none"))).orderBy(asc(catalogEnlargements.id)).for("update");
    if (!failed.length) throw new CatalogDecisionError(409, "Nothing to try again.");
    const rows = await tx.update(catalogEnlargements).set({ status: "queued", attempts: 0, timeouts: 0, probeTimeouts: 0, retries: sql`${catalogEnlargements.retries} + 1`, sends: sql`${catalogEnlargements.sends} + 1`, claimedAt: null, claimToken: null, tilesDone: 0, error: null, errorKind: null, updatedAt: now })
      .where(inArray(catalogEnlargements.id, failed.map(r => r.id))).returning();
    // F59: Try again resets the photo's identity-change count.
    await tx.update(catalogEnlargements).set({ identityReleases: 0 }).where(and(eq(catalogEnlargements.batchId, target.batchId), eq(catalogEnlargements.sourceImageId, target.sourceImageId)));
    for (const o of outputs) {
      await tx.update(catalogOutputs).set({ status: "pending", qaScores: null, compliance: { ok: true, failures: [], ...(o.compliance?.auto_actions ? { auto_actions: o.compliance.auto_actions } : {}) } as Output["compliance"], flags: o.flags.filter(f => f !== "enlargement_failed"), reason: null, error: null, stagingUri: null, bytes: null, updatedAt: now }).where(eq(catalogOutputs.id, o.id));
    }
    await tx.update(catalogProducts).set({ lockBatchId: target.batchId, updatedAt: now }).where(eq(catalogProducts.id, target.productId));
    const [index] = await tx.select({ value: sql<number>`coalesce(max(${catalogChunks.index}), -1) + 1` }).from(catalogChunks).where(eq(catalogChunks.batchId, target.batchId));
    const [chunk] = await tx.insert(catalogChunks).values({ batchId: target.batchId, index: Number(index!.value), stage: "render", productIds: [target.productId], sourceImageIds: [target.sourceImageId], status: "queued", attempt: 0, step: 0, stepKnown: true, taskName: ENLARGING_TASK, dispatchedAt: now, progressAt: now }).returning();
    const retries = Math.max(...rows.map(r => r.retries));
    await recordEvent(tx, { productId: target.productId, batchId: target.batchId, kind: "enlargement_retried", actor: input.actor, details: { n: target.n, retries, channels: [...new Set(outputs.map(o => o.channel))] } });
    return { batchId: target.batchId, productId: target.productId, chunkId: chunk!.id, outputIds: outputs.map(o => o.id), rows, retries };
  });
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, result.batchId));
  const bulk = !!batch && isBulkBatch(batch);
  await enqueueEnlargements(enqueue, result.rows, { log, chunkId: result.chunkId, ...(bulk ? { bulk: true } : {}) });
  return { batchId: result.batchId, productId: result.productId, chunkId: result.chunkId, outputIds: result.outputIds, rows: result.rows.length, retries: result.retries };
}

/** Accept the supported sheet headings, then reuse the normalised manual-map parser. */
function skuMapping(rows: string[][]): Map<string, string[]> {
  const header = (rows[0] ?? []).map(normalizeHeader);
  const keyColumn = header.findIndex(h => ["identifier", "option", "style", "optionidstylecolor", "sku"].includes(h));
  const skuColumn = header.findIndex(h => ["opptraskuid", "productcode", "unicommerce"].includes(h));
  if (keyColumn < 0 || skuColumn < 0) throw new CatalogDecisionError(400, "Use columns identifier and opptra_sku_id in the mapping sheet.");
  return parseManualMapping(rows.slice(1).flatMap(row => (row[skuColumn] ?? "").split(";").map(id => [row[keyColumn] ?? "", id.trim()])));
}
export async function applySkuMap(db: Db, input: { batchId: string; rows: string[][]; actor: string; now?: Date }): Promise<{ added: number; matched: number; unmatched: string[] }> {
  const mapping = skuMapping(input.rows);
  return db.transaction(async tx => {
    const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, input.batchId));
    if (!batch) throw new CatalogDecisionError(404, "This batch no longer exists.");
    const [brand] = await tx.select().from(brandMaster).where(eq(brandMaster.slug, batch.brandSlug));
    if (!brand) throw new CatalogDecisionError(400, "The brand details are missing. Sync the brand list before adding SKU ids.");
    const aliases = await tx.select({ alias: catalogProductAliases.aliasKey, productId: catalogProductAliases.productId }).from(catalogProductAliases).innerJoin(catalogBatchProducts, eq(catalogBatchProducts.productId, catalogProductAliases.productId)).where(and(eq(catalogBatchProducts.batchId, batch.id), eq(catalogProductAliases.brandSlug, batch.brandSlug), eq(catalogProductAliases.isTest, batch.isTest)));
    const byAlias = new Map(aliases.map(row => [row.alias, row.productId])), byProduct = new Map<string, string[]>(), unmatched: string[] = [];
    for (const [key, ids] of mapping) {
      const productId = byAlias.get(key);
      if (!productId) { unmatched.push(key); continue; }
      byProduct.set(productId, [...new Set([...(byProduct.get(productId) ?? []), ...ids])]);
    }
    let added = 0;
    for (const productId of [...byProduct.keys()].sort()) {
      const [product] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, productId)).for("update");
      const ids = byProduct.get(productId)!, newIds = ids.filter(id => !product!.opptraSkuIds.includes(id));
      for (const id of ids) {
        const aliasKey = normalizeKey(id);
        const [alias] = await tx.insert(catalogProductAliases).values({ brandSlug: batch.brandSlug, isTest: batch.isTest, productId, aliasKey, kind: "opptra_sku" }).onConflictDoNothing({ target: [catalogProductAliases.brandSlug, catalogProductAliases.isTest, catalogProductAliases.aliasKey] }).returning();
        if (!alias) {
          const [owner] = await tx.select().from(catalogProductAliases).where(and(eq(catalogProductAliases.brandSlug, batch.brandSlug), eq(catalogProductAliases.isTest, batch.isTest), eq(catalogProductAliases.aliasKey, aliasKey)));
          if (owner?.productId !== productId) throw new CatalogDecisionError(409, `SKU ${id} already belongs to another product.`);
        } else await recordEvent(tx, { productId, batchId: batch.id, kind: "alias_added", actor: input.actor, details: { aliasKey, kind: "opptra_sku" } });
        const [master] = await tx.select().from(skuMap).where(eq(skuMap.opptraSku, id));
        if (master && master.brandSlug !== batch.brandSlug) throw new CatalogDecisionError(409, `SKU ${id} already belongs to another brand.`);
        await tx.insert(skuMap).values({ opptraSku: id, brand: batch.brandName, brandSlug: batch.brandSlug, line: brand.line, optionKey: normalizeKey(product!.identifier), source: "manual" }).onConflictDoUpdate({ target: skuMap.opptraSku, set: { brand: batch.brandName, brandSlug: batch.brandSlug, line: brand.line, optionKey: normalizeKey(product!.identifier), source: "manual" } });
      }
      if (newIds.length) {
        await tx.update(catalogProducts).set({ opptraSkuIds: [...new Set([...product!.opptraSkuIds, ...newIds])].sort(), skuMethod: "manual", updatedAt: input.now ?? new Date() }).where(eq(catalogProducts.id, productId));
        await recordEvent(tx, { productId, batchId: batch.id, kind: "sku_ids_added", actor: input.actor, details: { ids: newIds } });
        added += newIds.length;
      }
    }
    return { added, matched: byProduct.size, unmatched };
  });
}

