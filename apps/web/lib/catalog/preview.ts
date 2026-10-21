import { and, eq, inArray } from "drizzle-orm";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages, catalogUploads } from "@catalog/core/db/schema";
import { buildDetectedStep2 } from "@catalog/core/catalog/ingest/detect-step";
import { buildPreview } from "@catalog/core/catalog/ingest/index";
import type { Detected } from "@catalog/core/catalog/ingest/types";
import { styliMinSourceHeightPx, STYLI_SKIP_LOW_RESOLUTION } from "@catalog/core/catalog/channels";
import { renderKeys } from "@catalog/core/catalog/pipeline/publish";
import { resolvePolicy } from "@catalog/core/catalog/qa/policy";
import { upscaleConfigFromEnv, upscaleFactorFromEnv } from "@catalog/core/catalog/upscale";
import type { ChannelId } from "@catalog/core/catalog/types";
import * as storage from "@catalog/core/storage";
import { db } from "../db";
import { badRequest } from "../errors";
import { anotherBatchProcessing, assertDraft, draftForUpdate, parseOptions, queryBatch } from "./batches";
import { wizardEstimate } from "./cost";
import type { CostEstimate } from "./copy";
import { regroupBatch } from "./uploads";

export async function detectedBatch(id: string) {
  await queryBatch(id);
  const detected = await buildDetectedStep2(db(), id, { storage });
  const uploads = await db().select().from(catalogUploads).where(eq(catalogUploads.batchId, id));
  const batch = await queryBatch(id);
  return { ...detected, totalProducts: batch.counts.products, unreadable: uploads.flatMap((u) => (u.detected as unknown as Detected | null)?.rejected ?? []), sheets: detected.sheets.map((sheet) => ({ ...sheet, columns: (uploads.find((u) => u.id === sheet.uploadId)?.detected as unknown as Detected | null)?.columns ?? [] })) };
}
export async function patchDetected(id: string, value: unknown) {
  const batch = await assertDraft(id);
  const input = value as { identifierMode?: unknown; precedence?: unknown; sheets?: unknown };
  if (!input || typeof input !== "object") throw badRequest("Check the grouping controls and try again.");
  const options = parseOptions({ ...(input.identifierMode !== undefined ? { identifierMode: input.identifierMode } : {}), ...(input.precedence !== undefined ? { precedence: input.precedence } : {}) }, batch.options);
  const uploads = await db().select().from(catalogUploads).where(eq(catalogUploads.batchId, id));
  const sheets = input.sheets ?? [];
  if (!Array.isArray(sheets)) throw badRequest("Choose the sheet columns and try again.");
  const patches = sheets.map((sheet: { uploadId?: unknown; identifierColumn?: unknown; imageColumns?: unknown; kind?: unknown }) => {
    const upload = uploads.find((u) => u.id === sheet.uploadId);
    if (!upload || !["sheet", "product_list", "google_sheet"].includes(upload.kind)) throw badRequest("Choose a sheet from this batch and try again.");
    const prior = upload.detected as unknown as Detected | null;
    const headers = prior?.columns ?? [];
    if (!Number.isInteger(sheet.identifierColumn) || Number(sheet.identifierColumn) < 0 || Number(sheet.identifierColumn) >= headers.length || !Array.isArray(sheet.imageColumns) || !sheet.imageColumns.every((n) => Number.isInteger(n) && n >= 0 && n < headers.length) || !["sheet", "product_list"].includes(String(sheet.kind))) throw badRequest("Choose the identifier and photo columns in your sheet.");
    const identifier = Number(sheet.identifierColumn);
    const images = [...new Set(sheet.imageColumns as number[])];
    const detected = { ...prior, kind: sheet.kind as "sheet" | "product_list", columnsChosen: true, identifierColumn: identifier, matchColumn: identifier, identifierHeader: headers[identifier], urlColumns: images, styleColumn: null, colourColumn: null, cannotRead: null };
    return { upload, detected, identifier, images };
  });
  if (patches.length === 1) options.sheetColumns = { identifier: patches[0]!.identifier, images: patches[0]!.images };
  if (patches.length > 1) options.sheetColumns = null;
  await db().transaction(async (tx) => {
    await draftForUpdate(tx, id);
    for (const patch of patches) await tx.update(catalogUploads).set({ detected: patch.detected, kind: patch.upload.kind === "google_sheet" ? "google_sheet" : patch.detected.kind }).where(eq(catalogUploads.id, patch.upload.id));
    await tx.update(catalogBatches).set({ options, counts: { ...batch.counts, previewReady: false }, updatedAt: new Date() }).where(eq(catalogBatches.id, id));
  });
  await regroupBatch(id);
  return { collecting: true };
}
type PlannedSource = { productId: string; n: number; sha256: string; height: number | null };
/**
 * A live output and the photo it was made from (sha256). `workerMatteModel`: the cut-out model the worker will use
 * for this product in this batch (matteModelFor), or null when that cannot be known before the batch runs.
 */
type LiveOutput = { productId: string; n: number; channel: ChannelId; sha256: string; renderKey: string; workerMatteModel: string | null };
/**
 * Step 4's "images will be made" (spec 06): photos times channels, minus Styli skips, minus pairs whose live image
 * the worker keeps as it is: its render_key is one the worker accepts for this photo (chunk.ts, renderKeys: same
 * sha256, today's CHANNEL_RULES_VERSION, the cut-out model it will use, plain or upscaled). Anything in doubt is
 * counted, so the count may be higher than what is made but never lower.
 */
export function plannedImages(sources: readonly PlannedSource[], channels: readonly ChannelId[], live: readonly LiveOutput[], upscaleFactor: number = upscaleFactorFromEnv(), upscaleModel: string | null = upscaleConfigFromEnv().model): { outputs: number; sourcesToMake: number } {
  const current = (o: LiveOutput) => o.workerMatteModel !== null && renderKeys({ sourceSha256: o.sha256, channel: o.channel, n: o.n, policyKey: `default|${o.workerMatteModel}` }, upscaleModel).includes(o.renderKey);
  let outputs = 0, sourcesToMake = 0;
  const styliMin = styliMinSourceHeightPx(upscaleFactor);
  for (const source of sources) {
    let made = 0;
    for (const channel of channels) {
      if (channel === "styli" && STYLI_SKIP_LOW_RESOLUTION && source.height !== null && source.height < styliMin) continue;
      if (live.some((o) => o.productId === source.productId && o.n === source.n && o.channel === channel && o.sha256 === source.sha256 && current(o))) continue;
      made++;
    }
    outputs += made;
    if (made) sourcesToMake++;
  }
  return { outputs, sourcesToMake };
}
/**
 * The cut-out model chunk.ts will use for a product: the policy for its type (the product's own, else the batch's
 * when that is not "auto"), the second model for a transparent "other" product. Null (its live images are counted)
 * when the type is decided only by the classifier while the batch runs, or for an eval batch with a forced policy.
 * The worker may still fall back to another model when the service lacks this one; that is not known here.
 */
export async function matteModelFor(product: { productType: string | null }, batch: { brandSlug: string; productType: string; options: { evalSet?: unknown } }, transparent: boolean, resolve: (brandSlug: string, type: Parameters<typeof resolvePolicy>[2]) => ReturnType<typeof resolvePolicy> = (brandSlug, type) => resolvePolicy(db(), brandSlug, type)): Promise<string | null> {
  if (batch.options.evalSet) return null;
  const type = product.productType && product.productType !== "auto" ? product.productType : batch.productType !== "auto" ? batch.productType : null;
  if (!type) return null;
  const policy = await resolve(batch.brandSlug, type as Parameters<typeof resolvePolicy>[2]);
  return type === "other" && transparent && policy.matteModelSecond && policy.matteModelSecond !== policy.matteModel ? policy.matteModelSecond : policy.matteModel;
}
export async function previewBatch(id: string) {
  const batch = await queryBatch(id);
  const base = { otherBatchProcessing: await anotherBatchProcessing(id), ready: batch.counts.previewReady, previewAt: batch.updatedAt.toISOString(), counts: {...batch.counts, photos: batch.counts.sources, channels: batch.channels.length}, collected: batch.counts.collected, collectTotal: batch.counts.collectTotal, estimate: null as CostEstimate | null };
  if (!base.ready) return { ...base, groupedBy: "", warnings: [], groups: [], totalRows: 0, overwrite: { newProducts: 0, existingProducts: [], renameHints: [], sameProductPairs: [] }, busy: [] };
  const [preview, detected] = await Promise.all([buildPreview(db(), id, { storage }, { limit: 50 }), buildDetectedStep2(db(), id, { storage })]);
  const sources = await db().select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, id));
  const productIds = [...new Set(sources.map((s) => s.productId))];
  const products = productIds.length ? await db().select({ id: catalogProducts.id, productType: catalogProducts.productType }).from(catalogProducts).where(inArray(catalogProducts.id, productIds)) : [];
  const liveRows = productIds.length ? await db().select({ productId: catalogOutputs.productId, n: catalogOutputs.n, channel: catalogOutputs.channel, sha256: catalogSourceImages.sha256, renderKey: catalogOutputs.renderKey }).from(catalogOutputs).innerJoin(catalogSourceImages, eq(catalogSourceImages.id, catalogOutputs.sourceImageId)).where(and(inArray(catalogOutputs.productId, productIds), eq(catalogOutputs.isLive, true))) : [];
  const models = new Map(await Promise.all([...new Set(liveRows.map((o) => o.productId))].map(async (productId) => [productId, await matteModelFor(products.find((p) => p.id === productId) ?? { productType: null }, batch, sources.some((s) => s.productId === productId && s.flags.includes("transparent")))] as const)));
  const live = liveRows.map((o) => ({ ...o, workerMatteModel: models.get(o.productId) ?? null }));
  const { outputs, sourcesToMake } = plannedImages(sources, batch.channels, live);
  // One classifier call per product without a type when the batch type is "auto" (spec 07 4.3, 4.11).
  const untypedProducts = batch.productType !== "auto" ? 0 : products.filter((p) => !p.productType).length;
  const estimate = wizardEstimate({ outputs, sources: sourcesToMake, untypedProducts, qaMode: batch.options.policy?.qaMode ?? "per_source", qaSampleRate: batch.options.policy?.qaSampleRate ?? 1 });
  const existing = new Set(preview.overwrite.existingProducts.map((p) => p.identifier));
  const groups = await Promise.all(preview.rows.map(async ({ firstShotUri, ...row }) => ({ ...row, firstPhotoUrl: firstShotUri ? await storage.signedUrl(firstShotUri, 900) : null, status: row.status === "duplicate shot" ? "two files for one shot" : row.status === "ok" && existing.has(row.identifier) ? "existing" : row.notes.some((n) => /not in sheet/i.test(n)) ? "not in sheet" : row.status })));
  return { ...base, estimate, groupedBy: detected.groupedBy, counts: { ...batch.counts, ...preview.kpis, outputs }, warnings: preview.warnings, groups, totalRows: preview.totalRows, overwrite: { newProducts: preview.overwrite.newProducts, existingProducts: preview.overwrite.existingProducts, renameHints: preview.overwrite.renameHints, sameProductPairs: preview.overwrite.duplicates }, busy: preview.overwrite.busy };
}
export type WizardPreview = Awaited<ReturnType<typeof previewBatch>>;
export type WizardDetected = Awaited<ReturnType<typeof detectedBatch>>;
