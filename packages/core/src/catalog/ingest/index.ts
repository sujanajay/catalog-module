// Ingest run (spec 04, "Ingest run"): one task per upload collects its items, reads their bytes,
// computes sha256 and checks them, self-continuing in budgets; the task that finds every upload of
// the batch done runs the batch-wide step (grouping, product list, matching, products, version
// rows, overwrite preview, counts). buildPreview serves step 4 from what that step stored.
//
// Working files (private bucket, under the batch's derived/, so the 180-day lifecycle removes them):
// - `<prefix>/derived/_ingest/<uploadId>/manifest.json`: the upload's items and, per item, the
//   result of reading it (sha256, where its bytes are, dimensions, or the reject sentence). Later
//   calls of the same upload, a repeated delivery and a step 2 re-run read it, so bytes already in
//   our bucket are never fetched again.
// - `<prefix>/derived/_ingest/<uploadId>/<sha256>.<ext>`: the bytes of zip entries and fetched links
//   (uploaded files already sit under uploads/ and are read from there).
// - `<prefix>/derived/_ingest/preview-state.json`: the grouping the batch-wide step decided, for
//   buildPreview.
// Version rows point at `rawPath(prefix, path_key, n, ext)`, written by the batch-wide step.
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  catalogBatches,
  catalogBatchProducts,
  catalogOutputs,
  catalogProducts,
  catalogSourceImages,
  catalogUploads,
  type CatalogUpload,
} from "../../db/schema";
import { getBucketName, isRetryableStorageError, toGsUri } from "../../storage";
import type { enqueueTask } from "../../tasks";
import { log } from "../../log";
import { batchPrefix, normalizeKey, rawPath, sanitizeSegment } from "../naming";
import { findOrCreateProduct } from "../products";
import { resolveSkus, type ResolveResult } from "../sku-mapping";
import type { BatchCounts, BatchOptions, ChangeKind, ChannelId, LinkStatus, OutputFlag, UploadKind } from "../types";
import { driveFolderAdapter } from "./drive-folder";
import { googleSheetAdapter, sheetCopyUri } from "./google-sheet";
import {
  baseName, byText, distinct, fmt, groupItems, isDuplicateReject, isSameProductReject, originalOf, previewRows, sameProductMessage, shotFlags,
  warningSentences, type ItemDimensions,
} from "./group";
import { checkImage, classifyImageReject, corruptMessage, imageFlags } from "./image-check";
import { classifyLinkReject, isLinkReject, noLinkPhotosReason, type LinkReject } from "./link-reasons";
import { itemKey, loadJson, manifestPath, saveJson, workPrefix, type ItemResult, type UploadManifest } from "./manifest";
import { linksSheetAdapter, readLinksSheetUpload, normalizeHeader } from "./links-sheet";
import { completeUploads, mapLimit } from "./local-files";
import { buildOverwritePreview, matchProducts } from "./overwrite-preview";
import { linkStatuses, matchProductList, missingIdentifier, productListDetected, readProductList, sizeBases, type ProductListRow } from "./product-list";
import type { Adapter, CollectInput, Detected, GroupingResult, IngestDeps, OverwritePreview, Preview, SourceItem } from "./types";
import { fetchSourceUrl, urlListAdapter } from "./url-list";
import { collectRejectReason, openZipReader, tooLargeMessage, zipAdapter, ZIP_ENTRY_MAX_BYTES } from "./zip";

/** A product list collects no items; it is read in the batch-wide step. */
const productListAdapter: Adapter = { kind: "product_list", collect: async () => [] };

/** image uses completeUploads; the google kinds read what the web tier wrote into uploads/. */
export const ADAPTERS: Record<UploadKind, Adapter> = {
  zip: zipAdapter,
  image: { kind: "image", collect: completeUploads },
  sheet: linksSheetAdapter,
  product_list: productListAdapter,
  google_sheet: googleSheetAdapter,
  drive_folder: driveFolderAdapter,
  url_list: urlListAdapter,
};

export async function collect(input: CollectInput): Promise<SourceItem[]> {
  return ADAPTERS[input.upload.kind].collect(input);
}

export interface IngestProgress { done: number; total: number | null; phase: "listing" | "copying" | "grouping" | "done" }

/**
 * Builder constant: items read per task call. An item is one download (at most 40 MB), a hash, a
 * full decode and at most one upload, about 1 s; ITEM_CONCURRENCY at a time keeps 200 items to
 * well under a minute, far inside the 900 s request limit, and a 3,280-file folder to 17 calls.
 */
export const INGEST_BUDGET_ITEMS = 200;
const ITEM_CONCURRENCY = 8;
/** Raw copies at once in the batch-wide step. */
const COPY_CONCURRENCY = 16;
/** Grouping table rows buildPreview returns (06 shows "Showing <n> of <total>"). */
const PREVIEW_ROW_LIMIT = 100;
/** Bytes file-type needs to recognise every format. */
const SNIFF_BYTES = 4100;

const INGEST_ROUTE = "/tasks/catalog/ingest" as const;
const FILE_KINDS: UploadKind[] = ["zip", "image", "drive_folder"];

// --- Item results --------------------------------------------------------------------------

type OkResult = Extract<ItemResult, { ok: true }>;

const stagedPath = (prefix: string, uploadId: string, sha256: string, ext: string) => `${workPrefix(prefix)}/${uploadId}/${sha256}.${ext}`;
const statePath = (prefix: string) => `${workPrefix(prefix)}/preview-state.json`;

async function readStream(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

type ZipReaders = Map<string, Promise<{ entryStream(entryPath: string): Readable }>>;

const isNotFound = (err: unknown) => [(err as { code?: unknown })?.code, (err as { status?: unknown })?.status].some((c) => Number(c) === 404);

/**
 * Read one item: its bytes (our bucket, a zip entry streamed by range reads, or a link fetched with
 * fetchSourceUrl), sha256 and checkImage on the full bytes. Zip entries and fetched links are
 * stored content-addressed under derived/_ingest/, so a repeated call writes the same object.
 */
async function readItem(item: SourceItem, deps: IngestDeps, ctx: { prefix: string; uploadId: string; zips: ZipReaders }): Promise<ItemResult> {
  const reject = collectRejectReason(item);
  if (reject) return { ok: false, reason: reject };
  const name = baseName(item);
  let buf: Buffer;
  if (item.bytes.kind === "url") {
    const got = await fetchSourceUrl(item, deps, deps.lookup ? { lookup: deps.lookup } : {});
    if (!got.ok) return { ok: false, reason: got.reason };
    buf = got.buf;
  } else if (item.bytes.kind === "zip-entry") {
    const { zipGsUri, entryPath } = item.bytes;
    if (!ctx.zips.has(zipGsUri)) ctx.zips.set(zipGsUri, openZipReader(deps.storage, zipGsUri));
    let read: Buffer | null;
    try {
      read = await readStream((await ctx.zips.get(zipGsUri)!).entryStream(entryPath), ZIP_ENTRY_MAX_BYTES);
    } catch (err) {
      if (isRetryableStorageError(err)) throw err;
      return { ok: false, reason: corruptMessage(name) };
    }
    if (!read) return { ok: false, reason: tooLargeMessage(name) };
    buf = read;
  } else {
    try {
      buf = (await deps.storage.downloadBuffer(item.bytes.gsUri)).buf;
    } catch (err) {
      if (isNotFound(err)) return { ok: false, reason: `${name} did not finish uploading. Add it again.` };
      throw err;
    }
    if (buf.length > ZIP_ENTRY_MAX_BYTES) return { ok: false, reason: tooLargeMessage(name) };
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const check = await checkImage(buf.subarray(0, SNIFF_BYTES), buf, name);
  if (!check.ok) return { ok: false, reason: check.message };
  const uri = item.bytes.kind === "gcs" ? item.bytes.gsUri : await deps.storage.uploadBuffer(stagedPath(ctx.prefix, ctx.uploadId, sha256, check.ext), buf, check.mime);
  return {
    ok: true, sha256, uri, mime: check.mime, ext: check.ext, width: check.width || null, height: check.height || null,
    size: buf.length, flags: imageFlags(check),
  };
}

// --- Listing an upload --------------------------------------------------------------------

/**
 * The product list's step 2 match column, when the operator picked one: the stored matchColumn
 * differs from what detection finds on its own. Returned as readProductList's `columns`.
 */
async function pickedColumns(buf: Buffer, name: string, prior: Detected | null): Promise<{ identifier: number; ean?: number } | undefined> {
  if (typeof prior?.matchColumn !== "number") return undefined;
  const auto = await productListDetected(buf, name);
  if (prior.matchColumn === auto.matchColumn) return undefined;
  return { identifier: prior.matchColumn, ...(typeof prior.eanColumn === "number" ? { ean: prior.eanColumn } : {}) };
}

/** Where a sheet upload's bytes are and the name to read them by (Google Sheets: the web tier's csv copy). */
async function sheetSource(input: CollectInput): Promise<{ gsUri: string; name: string }> {
  const { upload } = input;
  if (upload.kind === "google_sheet") {
    const gsUri = await sheetCopyUri(input);
    return { gsUri, name: gsUri.split("/").pop() ?? "sheet.csv" };
  }
  if (!upload.gcsUri) throw new Error(`The sheet ${upload.name} has not been uploaded yet. Add it again.`);
  return { gsUri: upload.gcsUri, name: upload.name };
}

/**
 * Lists one upload. Links sheets go through readLinksSheetUpload, so row rejects, the
 * duplicate-identifier warning and the sheet's Detected are kept; a sheet without image columns
 * (or an upload marked as a product list) is a product list and gets productListDetected.
 */
async function listUpload(input: CollectInput): Promise<Omit<UploadManifest, "version" | "results">> {
  const { upload, deps, options } = input;
  const prior = (upload.detected as Detected | null) ?? null;
  const chosen = upload.detected?.columnsChosen === true ? { columnsChosen: true } : {};
  const asProductList = async (): Promise<Omit<UploadManifest, "version" | "results">> => {
    const src = upload.kind === "product_list" ? { gsUri: upload.gcsUri ?? "", name: upload.name } : await sheetSource(input);
    if (!src.gsUri) throw new Error(`The product list ${upload.name} has not been uploaded yet. Add it again.`);
    const { buf } = await deps.storage.downloadBuffer(src.gsUri);
    const detected = await productListDetected(buf, src.name, await pickedColumns(buf, src.name, prior));
    if (upload.kind === "google_sheet" && prior?.message) detected.message = prior.message;
    return { items: [], warnings: [], productList: true, detected: { ...detected, ...chosen } };
  };

  if (upload.kind === "product_list" || (chosen.columnsChosen && prior?.kind === "product_list")) return asProductList();
  if (upload.kind === "sheet" || upload.kind === "google_sheet") {
    const src = await sheetSource(input);
    const title = upload.kind === "google_sheet" && typeof prior?.title === "string" ? prior.title : undefined;
    const res = await readLinksSheetUpload(input, upload.kind === "google_sheet" ? { ...src, ...(title ? { title } : {}) } : undefined);
    if (res.detection.isProductList && res.detection.identifierColumn >= 0 && !options.sheetColumns) return asProductList();
    const detected = { ...res.detected, ...chosen };
    if (upload.kind === "google_sheet" && prior?.message) detected.message = prior.message;
    return { items: res.items, warnings: res.warnings, productList: false, detected };
  }
  const items = await ADAPTERS[upload.kind].collect(input);
  const detected: Detected = { kind: upload.kind, title: upload.name, fileCount: items.length, message: prior?.message ?? `${fmt(items.length)} files found.` };
  if (upload.kind === "url_list") detected.rows = items.length;
  return { items, warnings: [], productList: false, detected };
}

/** The Detected stored when the upload is done: formats, rejects and top-level folders filled in. */
function finalDetected(m: UploadManifest, kind: UploadKind): Detected {
  const formats = { jpg: 0, png: 0, heic: 0, other: 0 };
  const rejected = [...(m.detected.rejected ?? [])];
  const folders = new Set<string>();
  for (const item of m.items) {
    const r = m.results[itemKey(item)];
    if (!r) continue;
    if (!r.ok) {
      rejected.push({ name: item.originalName, reason: r.reason });
      continue;
    }
    if (r.ext === "jpg" || r.ext === "jpeg") formats.jpg++;
    else if (r.ext === "png") formats.png++;
    else if (r.ext === "heic" || r.ext === "heif") formats.heic++;
    else formats.other++;
    const segs = item.originalName.split(/[\\/]/).filter(Boolean);
    if (FILE_KINDS.includes(kind) && segs.length > 1) folders.add(segs[0]!);
  }
  const detected: Detected = { ...m.detected, formats, rejected };
  if (FILE_KINDS.includes(kind)) detected.topLevelFolders = [...folders].sort(byText);
  return detected;
}

// --- Storage helpers ------------------------------------------------------------------------

const doneCount = (m: UploadManifest | null) => (m ? m.items.filter((i) => m.results[itemKey(i)]).length : 0);

/** Adds to counts.collected and counts.collectTotal in one statement (uploads run in parallel). */
async function bumpCollected(db: Db, batchId: string, done: number, total: number): Promise<void> {
  if (!done && !total) return;
  await db
    .update(catalogBatches)
    .set({
      counts: sql`jsonb_set(jsonb_set(${catalogBatches.counts}, '{collected}', to_jsonb(GREATEST(0, COALESCE((${catalogBatches.counts}->>'collected')::int, 0) + (${done})::int))), '{collectTotal}', to_jsonb(GREATEST(0, COALESCE((${catalogBatches.counts}->>'collectTotal')::int, 0) + (${total})::int)))`,
    })
    .where(eq(catalogBatches.id, batchId));
}

async function patchCounts(db: Db, batchId: string, patch: Partial<BatchCounts>, set: Partial<typeof catalogBatches.$inferInsert> = {}): Promise<void> {
  await db
    .update(catalogBatches)
    .set({ ...set, counts: sql`${catalogBatches.counts} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(catalogBatches.id, batchId));
}

// --- The task --------------------------------------------------------------------------------

/**
 * Idempotent: an item whose bytes were already read (same key, same sha256 in the manifest) is
 * skipped. Processes at most INGEST_BUDGET_ITEMS items per call and re-enqueues itself with the same
 * body plus a cursor while work remains. `deps.budgetItems` (optional) overrides the budget.
 *
 * A delivery for an upload already `collected`, `failed` or `removed` is a no-op (it only finishes the batch
 * if that was left undone). A step 2 re-run is 06 setting the batch's uploads back to `uploaded`
 * and enqueueing them again: the items are listed again and only items never read before are read.
 */
export async function runIngest(
  db: Db,
  deps: IngestDeps & { enqueue: typeof enqueueTask; budgetItems?: number },
  body: { batchId: string; uploadId: string; cursor?: string },
): Promise<{ progress: IngestProgress; outcome: string }> {
  const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, body.uploadId));
  if (!upload || upload.batchId !== body.batchId) throw new Error(`Upload ${body.uploadId} is not part of batch ${body.batchId}.`);
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, body.batchId));
  if (!batch) throw new Error(`Batch ${body.batchId} does not exist.`);
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);

  if (upload.status === "collected" || upload.status === "failed" || upload.status === "removed") {
    // A removed upload (spec 14b F3) is never read; a delivery queued before the removal only finishes the batch.
    return (await finishIfLast(db, deps, batch.id)) ?? { progress: { done: 0, total: null, phase: "done" }, outcome: `noop: upload already ${upload.status}` };
  }
  if (!["draft", "ingesting", "failed"].includes(batch.status)) {
    return { progress: { done: 0, total: null, phase: "done" }, outcome: `noop: the batch is ${batch.status}` };
  }
  if (!body.cursor) {
    // A new run (first delivery or a step 2 re-run): the batch is collecting again.
    await patchCounts(db, batch.id, { previewReady: false, failReason: null }, { status: "ingesting" });
  }

  const input: CollectInput = { batchId: batch.id, brandSlug: batch.brandSlug, prefix, upload, options: batch.options, deps };
  const old = await loadJson<UploadManifest>(deps, manifestPath(prefix, upload.id));
  let manifest: UploadManifest;
  if (!body.cursor || !old) {
    let listing: Awaited<ReturnType<typeof listUpload>>;
    try {
      listing = await listUpload(input);
    } catch (err) {
      if (isRetryableStorageError(err)) throw err;
      const error = err instanceof Error ? err.message : String(err);
      await db.update(catalogUploads).set({ status: "failed", error }).where(eq(catalogUploads.id, upload.id));
      return (await finishIfLast(db, deps, batch.id)) ?? { progress: { done: 0, total: 0, phase: "done" }, outcome: `upload failed: ${error}` };
    }
    const results: Record<string, ItemResult> = {};
    for (const item of listing.items) {
      const prev = old?.results[itemKey(item)];
      if (prev) results[itemKey(item)] = prev;
    }
    manifest = { version: 1, ...listing, results };
  } else {
    manifest = old;
  }

  // Items still to read, from the cursor round to the start (a lost write is picked up again).
  const total = manifest.items.length;
  const start = Math.min(Math.max(0, Number(body.cursor ?? 0) || 0), total);
  const order = [...Array(total).keys()].map((k) => (start + k) % Math.max(total, 1));
  const unread = () => order.filter((i) => !manifest.results[itemKey(manifest.items[i]!)]);
  const todo = unread().slice(0, deps.budgetItems ?? INGEST_BUDGET_ITEMS);
  const zips: ZipReaders = new Map();
  await mapLimit(todo, ITEM_CONCURRENCY, async (i) => {
    const item = manifest.items[i]!;
    manifest.results[itemKey(item)] = await readItem(item, deps, { prefix, uploadId: upload.id, zips });
  });
  // Cloud Tasks delivers at least once, so another delivery of this upload may have saved while this
  // one was reading: keep what it read, and count only what this save adds to the stored manifest.
  const stored = await loadJson<UploadManifest>(deps, manifestPath(prefix, upload.id));
  for (const item of manifest.items) {
    const k = itemKey(item);
    if (!manifest.results[k] && stored?.results[k]) manifest.results[k] = stored.results[k];
  }
  await saveJson(deps, manifestPath(prefix, upload.id), manifest);
  await bumpCollected(db, batch.id, doneCount(manifest) - doneCount(stored), total - (stored?.items.length ?? 0));

  const done = doneCount(manifest);
  const left = unread();
  if (left.length) {
    const cursor = String(left[0]);
    await deps.enqueue(INGEST_ROUTE, { batchId: batch.id, uploadId: upload.id, cursor });
    return { progress: { done, total, phase: "copying" }, outcome: `collected ${done} of ${total}; continuing at ${cursor}` };
  }

  await db
    .update(catalogUploads)
    .set({ status: "collected", error: null, detected: finalDetected(manifest, upload.kind) as unknown as Record<string, unknown> })
    .where(eq(catalogUploads.id, upload.id));
  return (await finishIfLast(db, deps, batch.id)) ?? { progress: { done, total, phase: "done" }, outcome: "collected; waiting for the other uploads" };
}

/**
 * Runs the batch-wide step when every upload is collected or failed and the batch is still
 * `ingesting`. The claim is one conditional UPDATE (status ingesting -> draft), so of two uploads
 * finishing together only one runs it; on an error the claim is given back so a retry runs it.
 */
async function finishIfLast(db: Db, deps: IngestDeps, batchId: string): Promise<{ progress: IngestProgress; outcome: string } | null> {
  const claimed = await db
    .update(catalogBatches)
    .set({ status: "draft" })
    .where(
      and(
        eq(catalogBatches.id, batchId),
        eq(catalogBatches.status, "ingesting"),
        sql`NOT EXISTS (SELECT 1 FROM ${catalogUploads} WHERE ${catalogUploads.batchId} = ${batchId} AND ${catalogUploads.status} NOT IN ('collected', 'failed', 'removed'))`,
      ),
    )
    .returning({ id: catalogBatches.id });
  if (!claimed.length) return null;
  try {
    return await finishBatch(db, deps, batchId);
  } catch (err) {
    await db.update(catalogBatches).set({ status: "ingesting" }).where(eq(catalogBatches.id, batchId));
    throw err;
  }
}

// --- Grouping what was collected (shared by the runner and the CLI) -----------------------------

interface ListInput { rows: ProductListRow[]; picked: boolean }

interface Assembled {
  grouped: GroupingResult;
  resultOf: (item: SourceItem) => OkResult | undefined;
  sha256ByItem: Map<SourceItem, string>;
  dimensions: ItemDimensions;
  list: ProductListRow[] | null;
  byMatchColumn: boolean;
  statuses: Map<string, LinkStatus>;
  missing: string[];
  eans: Map<string, string>;
  listSkuIds: Map<string, string[]>;
}

/** Opptra SKU ids on product list rows: every column whose header holds "opptrasku". */
function rowSkuIds(rows: ProductListRow[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.entries(r.raw).filter(([h, v]) => v && normalizeHeader(h).includes("opptrasku")).map(([, v]) => v)))].sort();
}

/** The keys a list row can be found by: its identifier and its size-level base. */
function rowKeys(row: ProductListRow): string[] {
  return [normalizeKey(row.identifier.trim()), ...sizeBases(row.identifier).map(normalizeKey)];
}

/**
 * groupItems over every collected item (unreadable and fetch failures rejected under their
 * product), the sheets' warnings, then the product list: token-containment renames applied to the
 * grouping, link statuses, the missing identifiers, EANs and SKU ids per identifier.
 */
function assemble(manifests: UploadManifest[], lists: ListInput[], options: BatchOptions): Assembled {
  const results = new Map<string, ItemResult>();
  const items: SourceItem[] = [];
  for (const m of manifests) {
    if (m.productList) continue;
    for (const item of m.items) {
      items.push(item);
      const r = m.results[itemKey(item)];
      if (r) results.set(itemKey(item), r);
    }
  }
  const unreadable = new Map<SourceItem, string>();
  for (const item of items) {
    const r = results.get(itemKey(item));
    if (!r) unreadable.set(item, `${baseName(item)} could not be read. Add it again.`);
    else if (!r.ok) unreadable.set(item, r.reason);
  }
  const grouped = groupItems(items, options, unreadable);
  for (const m of manifests) grouped.warnings.push(...m.warnings);

  const list = lists.length ? lists.flatMap((l) => l.rows) : null;
  const byMatchColumn = lists.some((l) => l.picked);
  const eans = new Map<string, string>();
  const listSkuIds = new Map<string, string[]>();
  let statuses = new Map<string, LinkStatus>([...grouped.products.keys()].map((id) => [id, "ok" as LinkStatus]));
  if (list?.length) {
    const m = matchProductList(list, [...grouped.products.keys()], { byMatchColumn });
    if (m.renamed.size) {
      const renamed = new Map<string, SourceItem[]>();
      for (const [id, its] of grouped.products) {
        const final = m.renamed.get(id) ?? id;
        for (const it of its) it.identifier = final;
        const merged = [...(renamed.get(final) ?? []), ...its];
        merged.forEach((it, i) => (it.n = i + 1));
        renamed.set(final, merged);
      }
      grouped.products = new Map([...renamed].sort(([a], [b]) => byText(a, b)));
    }
    statuses = linkStatuses(list, grouped, { byMatchColumn });
    const eanByKey = new Map<string, string>();
    for (const row of list) if (row.ean) for (const k of rowKeys(row)) if (!eanByKey.has(k)) eanByKey.set(k, row.ean);
    for (const [id, rows] of m.byIdentifier) {
      const ean = rows.find((r) => r.ean)?.ean;
      if (ean) eans.set(id, ean);
      const skus = rowSkuIds(rows);
      if (skus.length) listSkuIds.set(id, skus);
    }
    const missingRows = new Map<string, ProductListRow[]>();
    for (const row of m.unmatchedRows) {
      const key = normalizeKey(missingIdentifier(row, m.sizeRowsMatched > 0, byMatchColumn));
      const rows = missingRows.get(key);
      if (rows) rows.push(row);
      else missingRows.set(key, [row]);
    }
    for (const [id, status] of statuses) {
      if (status !== "missing_images") continue;
      const ean = eanByKey.get(normalizeKey(id));
      if (ean) eans.set(id, ean);
      const skus = rowSkuIds(missingRows.get(normalizeKey(id)) ?? []);
      if (skus.length) listSkuIds.set(id, skus);
    }
  }
  const missing = [...statuses].filter(([, s]) => s === "missing_images").map(([id]) => id);

  const resultOf = (item: SourceItem) => {
    const r = results.get(itemKey(originalOf(item)));
    return r?.ok ? r : undefined;
  };
  const sha256ByItem = new Map<SourceItem, string>();
  const dimensions: ItemDimensions = new Map();
  const allGrouped = [...[...grouped.products.values()].flat(), ...grouped.rejected.map((r) => r.item)];
  for (const item of allGrouped) {
    const r = resultOf(item);
    if (!r) continue;
    sha256ByItem.set(item, r.sha256);
    dimensions.set(item, { width: r.width, height: r.height });
  }
  return { grouped, resultOf, sha256ByItem, dimensions, list, byMatchColumn, statuses, missing, eans, listSkuIds };
}

/** Rows of every product list upload (a list whose identifier column cannot be told is skipped; step 2 asks). */
async function readLists(uploads: CatalogUpload[], manifests: Map<string, UploadManifest>, deps: Pick<IngestDeps, "storage">, prefix: string, options: BatchOptions): Promise<ListInput[]> {
  const out: ListInput[] = [];
  for (const upload of uploads) {
    const m = manifests.get(upload.id);
    if (!m?.productList || m.detected.cannotRead) continue;
    const input = { batchId: upload.batchId, brandSlug: "", prefix, upload, options, deps: deps as IngestDeps };
    const src = upload.kind === "product_list" ? { gsUri: upload.gcsUri ?? "", name: upload.name } : await sheetSource(input);
    const { buf } = await deps.storage.downloadBuffer(src.gsUri);
    const columns = await pickedColumns(buf, src.name, m.detected);
    try {
      out.push({ rows: await readProductList(buf, src.name, columns), picked: !!columns });
    } catch (err) {
      if (isRetryableStorageError(err)) throw err;
    }
  }
  return out;
}

// --- The batch-wide step --------------------------------------------------------------------------

/** One item as buildPreview needs it back. */
interface StoredItem { item: SourceItem; sha256: string | null; width: number | null; height: number | null; rawUri: string | null }

interface PreviewState {
  version: 1;
  products: { identifier: string; productId: string; items: StoredItem[] }[];
  rejected: { item: StoredItem; reason: string }[];
  warnings: string[];
  missing: string[];
  list: ProductListRow[] | null;
  byMatchColumn: boolean;
  duplicates: OverwritePreview["duplicates"];
  skus: [string, string[]][];
  topLevelFolders: string[];
}

/**
 * "1 BMP file and 1 PDF": what the rejects were, for the zero-photos sentence. Uploads that could
 * not be opened at all (a missing zip, a sheet never uploaded) add the fact from their error
 * ("The zip Images.zip was not found in storage"), without its own action sentence.
 */
function whatWasFound(rejected: GroupingResult["rejected"], uploadErrors: string[] = []): string {
  // Unsupported image formats first, then files that are not images, corrupt files, the rest, then links.
  const counts = new Map<string, { rank: number; k: number; many?: string }>();
  const add = (what: string, rank: number, many?: string) => counts.set(what, { rank, k: (counts.get(what)?.k ?? 0) + 1, ...(many ? { many } : {}) });
  for (const r of rejected) {
    const kind = classifyImageReject(r.reason);
    if (kind === "unsupported") add(`${/is an? (\S+) file/.exec(r.reason)?.[1] ?? "unsupported"} file`, 0);
    else if (kind === "not_image") add(r.item.ext ? r.item.ext.toUpperCase() : "file that is not an image", 1);
    else if (kind === "corrupt") add("corrupt file", 2);
    // A link is not a file (spec 14b F5: "<n> other files" is not said of links).
    else if (kind === "link") add("link that could not be downloaded", 4, "links that could not be downloaded");
    else add("other file", 3);
  }
  const parts = [...counts]
    .sort(([a, x], [b, y]) => x.rank - y.rank || byText(a, b))
    .map(([what, { k, many }]) => `${fmt(k)} ${k === 1 ? what : many ?? `${what}s`}`);
  const facts = distinct(uploadErrors.map(firstFact).filter(Boolean));
  if (!parts.length && !facts.length) return "The upload was empty";
  const found = !parts.length ? [] : [parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`];
  return [...found, ...facts].join(". ");
}

/** The first sentence of an error, without its full stop ("The zip a.zip was not found in storage"). */
function firstFact(error: string): string {
  const m = /^(.+?)[.!?](?:\s|$)/s.exec(error.trim());
  return (m ? m[1]! : error.trim().replace(/[.!?]+$/, "")).trim();
}

/**
 * counts.failReason when the whole batch holds no photo: from the rejects and the uploads that failed.
 * When every reject is a link that could not be downloaded and no upload failed, the links sentence
 * (spec 14b F5 part 1, `linkSource` says where the links came from); else the file sentence.
 */
function noPhotosReason(rejected: GroupingResult["rejected"], uploadErrors: string[] = [], linkSource?: { links: number; source: string }): string {
  const links = rejected.map((r) => classifyLinkReject(r.reason));
  if (linkSource && links.length && !uploadErrors.length && links.every((l) => l !== null)) {
    return noLinkPhotosReason(links as LinkReject[], linkSource.links, linkSource.source);
  }
  return `No photos were found in what you uploaded. ${whatWasFound(rejected, uploadErrors)}. Upload photos and start again.`;
}

/** "pasted", "listed in <sheet>", or both: where the batch's links came from, for the no-photos sentence. */
function linkSourceWords(uploads: CatalogUpload[]): string {
  const pasted = uploads.some((u) => u.kind === "url_list");
  const sheets = distinct(uploads.filter((u) => u.kind === "sheet" || u.kind === "google_sheet").map((u) => (u.detected as Detected | null)?.title || u.name));
  const listed = sheets.length ? `listed in ${sheets.join(" and ")}` : "";
  return [pasted ? "pasted" : "", listed].filter(Boolean).join(" and ") || "pasted";
}

/**
 * Removes what an earlier run of this draft wrote: its version rows, its batch_products rows and
 * the products it created that nothing else refers to. No other product state is touched.
 */
async function removeDraftRows(db: Db, batchId: string): Promise<void> {
  const created = await db
    .select({ productId: catalogBatchProducts.productId })
    .from(catalogBatchProducts)
    .where(and(eq(catalogBatchProducts.batchId, batchId), eq(catalogBatchProducts.change, "new")));
  await db.delete(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId));
  await db.delete(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId));
  await deleteUnusedProducts(db, created.map((c) => c.productId));
}

/** Deletes those of `ids` that nothing refers to (no lock, batch, version or output row). */
async function deleteUnusedProducts(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.delete(catalogProducts).where(
    and(
      inArray(catalogProducts.id, ids),
      sql`${catalogProducts.lockBatchId} IS NULL`,
      sql`NOT EXISTS (SELECT 1 FROM ${catalogBatchProducts} WHERE ${catalogBatchProducts.productId} = ${catalogProducts.id})`,
      sql`NOT EXISTS (SELECT 1 FROM ${catalogSourceImages} WHERE ${catalogSourceImages.productId} = ${catalogProducts.id})`,
      sql`NOT EXISTS (SELECT 1 FROM ${catalogOutputs} WHERE ${catalogOutputs.productId} = ${catalogProducts.id})`,
    ),
  );
}

/** Puts an item's bytes at the raw object `target` (unless they are already there); returns its gs:// URI. */
async function placeRaw(storage: IngestDeps["storage"], bucket: string, target: string, r: OkResult): Promise<string> {
  const uri = toGsUri(bucket, target);
  if (r.uri === uri) return uri;
  return storage.uploadBuffer(target, (await storage.downloadBuffer(r.uri)).buf, r.mime);
}

/** findOrCreateProduct's operator sentences (an empty or clashing path); anything else is rethrown. */
const isProductRefusal = (err: unknown) => err instanceof Error && (/^".+" (cannot be used in an image link|would share image links with)/.test(err.message) || err.message.startsWith("The identifier is empty"));

function mergeSkus(skus: ResolveResult, extra: string[] | undefined): ResolveResult {
  if (!extra?.length) return skus;
  const ids = [...new Set([...skus.opptraSkuIds, ...extra])].sort();
  return { ...skus, opptraSkuIds: ids, method: skus.method === "unresolved" ? "manual" : skus.method };
}

async function finishBatch(db: Db, deps: IngestDeps, batchId: string): Promise<{ progress: IngestProgress; outcome: string }> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error(`Batch ${batchId} does not exist.`);
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  // A removed upload (spec 14b F3) is not an input: its photos, sheets and errors are left out.
  const uploads = await db.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, batchId), ne(catalogUploads.status, "removed")));
  await removeDraftRows(db, batch.id);

  const manifests = new Map<string, UploadManifest>();
  for (const u of uploads) {
    if (u.status !== "collected") continue;
    const m = await loadJson<UploadManifest>(deps, manifestPath(prefix, u.id));
    if (m) manifests.set(u.id, m);
  }
  const lists = await readLists(uploads, manifests, deps, prefix, batch.options);
  const a = assemble([...manifests.values()], lists, batch.options);
  const { grouped } = a;

  // Matching and the overwrite preview come first: duplicate spellings leave the grouping here.
  const ids = [...grouped.products.keys()];
  const matches = await matchProducts(db, batch, ids, a.eans);
  const overwrite = await buildOverwritePreview(db, batch, grouped, matches, a.sha256ByItem);
  const duplicates = [...overwrite.duplicates];

  // Products for what is left, then for the product list rows without photos. Each product's
  // catalog_batch_products row is written as soon as the product is found or created, so a retry
  // after a failure part-way through still knows (removeDraftRows) which products this batch created.
  const productOf = new Map<string, { id: string; pathKey: string; isNew: boolean; skuIds: string[]; resolved: boolean }>();
  const used = new Map<string, string>();
  const givenUp = new Set<string>();
  const refuse = (id: string, reason: string) => {
    for (const item of grouped.products.get(id) ?? []) grouped.rejected.push({ item, reason });
    grouped.products.delete(id);
  };
  for (const id of [...grouped.products.keys(), ...a.missing]) {
    const ean = a.eans.get(id) ?? null;
    const skus = mergeSkus(await resolveSkus(db, { brandSlug: batch.brandSlug, identifier: id, ean }), a.listSkuIds.get(id));
    let found: Awaited<ReturnType<typeof findOrCreateProduct>>;
    try {
      found = await findOrCreateProduct(db, { brandSlug: batch.brandSlug, isTest: batch.isTest, identifier: id, skus, productType: batch.productType, actor: batch.createdBy });
    } catch (err) {
      if (!isProductRefusal(err)) throw err;
      refuse(id, (err as Error).message);
      continue;
    }
    const hasPhotos = grouped.products.has(id);
    const other = used.get(found.product.id);
    // A product list row that names a product already in the batch under another spelling adds nothing.
    if (other !== undefined && !hasPhotos) continue;
    if (other !== undefined) {
      // Two identifiers that only became one product here (for example through the same option id):
      // both are left out, as buildOverwritePreview leaves out the ones it finds.
      const [x, y] = [other, id].sort(byText);
      duplicates.push({ a: x!, b: y! });
      const sentence = sameProductMessage([x!, y!]);
      refuse(id, sentence);
      const first = productOf.get(other);
      if (first) {
        refuse(other, sentence);
        productOf.delete(other);
        await db.delete(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, batch.id), eq(catalogBatchProducts.productId, first.id)));
        if (first.isNew) givenUp.add(first.id);
      }
      continue;
    }
    used.set(found.product.id, id);
    productOf.set(id, {
      id: found.product.id, pathKey: found.product.pathKey, isNew: found.isNew,
      skuIds: found.product.opptraSkuIds ?? [], resolved: skus.method !== "unresolved",
    });
    const linkStatus: LinkStatus = hasPhotos ? (a.statuses.get(id) ?? "ok") : "missing_images";
    const change: ChangeKind = found.isNew ? "new" : hasPhotos ? "updated" : "unchanged";
    await db.insert(catalogBatchProducts).values({ batchId: batch.id, productId: found.product.id, linkStatus, change }).onConflictDoNothing();
  }
  // A product this run created for a spelling it then left out is removed again.
  await deleteUnusedProducts(db, [...givenUp]);

  const withPhotos = [...grouped.products.keys()].filter((id) => productOf.has(id));
  const missing = a.missing.filter((id) => productOf.has(id) && !grouped.products.has(id));

  // Version rows: one per (product, n), not current, replacing the current row of that shot.
  const productIds = withPhotos.map((id) => productOf.get(id)!.id);
  const current = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += 1000) {
    const part = productIds.slice(i, i + 1000);
    const cur = await db
      .select({ id: catalogSourceImages.id, productId: catalogSourceImages.productId, n: catalogSourceImages.n })
      .from(catalogSourceImages)
      .where(and(inArray(catalogSourceImages.productId, part), eq(catalogSourceImages.isCurrent, true)));
    for (const c of cur) current.set(`${c.productId}:${c.n}`, c.id);
  }
  const bucket = getBucketName();
  const shots = withPhotos.flatMap((id) => grouped.products.get(id)!.map((item, i) => ({ id, item, n: item.n ?? i + 1 })));
  const rawUriOf = new Map<SourceItem, string>();
  const versions = (
    await mapLimit(shots, COPY_CONCURRENCY, async ({ id, item, n }) => {
      const r = a.resultOf(item);
      if (!r) return null;
      const product = productOf.get(id)!;
      const rawUri = await placeRaw(deps.storage, bucket, rawPath(prefix, product.pathKey, n, r.ext), r);
      rawUriOf.set(item, rawUri);
      const flags = [...new Set([...r.flags, ...shotFlags(item)])];
      return {
        productId: product.id, batchId: batch.id, n, sha256: r.sha256, isCurrent: false, replacesId: current.get(`${product.id}:${n}`) ?? null,
        originalName: item.originalName, uploadId: item.uploadId, rawUri, mime: r.mime, width: r.width, height: r.height, bytes: r.size,
        flags, status: "prepared" as const,
      };
    })
  ).filter((v): v is NonNullable<typeof v> => v !== null);
  for (let i = 0; i < versions.length; i += 500) {
    await db.insert(catalogSourceImages).values(versions.slice(i, i + 500)).onConflictDoNothing();
  }

  // The preview state buildPreview reads, and the counts.
  const stored = (item: SourceItem): StoredItem => {
    const r = a.resultOf(item);
    return { item, sha256: r?.sha256 ?? null, width: r?.width ?? null, height: r?.height ?? null, rawUri: rawUriOf.get(item) ?? null };
  };
  const topLevelFolders = [...new Set(uploads.flatMap((u) => ((u.detected as Detected | null)?.topLevelFolders ?? [])))].sort(byText);
  const skus = [...withPhotos, ...missing].map((id) => [id, productOf.get(id)!.skuIds] as [string, string[]]);
  const state: PreviewState = {
    version: 1,
    products: withPhotos.map((id) => ({ identifier: id, productId: productOf.get(id)!.id, items: grouped.products.get(id)!.map(stored) })),
    rejected: grouped.rejected.map((r) => ({ item: stored(r.item), reason: r.reason })),
    warnings: grouped.warnings, missing, list: a.list, byMatchColumn: a.byMatchColumn, duplicates, skus, topLevelFolders,
  };
  await saveJson(deps, statePath(prefix), state);

  const newCount = withPhotos.filter((id) => productOf.get(id)!.isNew).length;
  const existing = overwrite.existingProducts.filter((p) => productOf.has(p.identifier));
  const rejects = grouped.rejected.filter((r) => !isSameProductReject(r.reason));
  // Links that could not be downloaded are counted on their own, not as unsupported files (spec 14b F5).
  const linkRejects = rejects.filter((r) => isLinkReject(r.reason));
  const counts: Partial<BatchCounts> = {
    products: withPhotos.length, sources: versions.length,
    skuResolved: [...withPhotos, ...missing].filter((id) => productOf.get(id)!.resolved || productOf.get(id)!.skuIds.length > 0).length,
    missingImages: missing.length, notInSheet: withPhotos.filter((id) => a.statuses.get(id) === "not_in_sheet").length,
    unsupportedFiles: rejects.filter((r) => !isDuplicateReject(r.reason) && !isLinkReject(r.reason)).length,
    linkFailures: linkRejects.length,
    duplicateFiles: rejects.filter((r) => isDuplicateReject(r.reason)).length,
    newProducts: newCount, existingProducts: withPhotos.length - newCount,
    shotsToRemove: existing.reduce((s, p) => s + p.shotsToRemove.length, 0),
    previewReady: true, failReason: null,
  };
  // An input removed while this ran (spec 14b F3) was read above, so this result is out of date. The
  // removal already cleared previewReady; keep it cleared (no failure either) so the next Continue
  // runs this step again without it.
  const removedSince = uploads.length ? await db.select({ id: catalogUploads.id }).from(catalogUploads).where(and(inArray(catalogUploads.id, uploads.map((u) => u.id)), eq(catalogUploads.status, "removed"))) : [];
  if (removedSince.length) {
    await patchCounts(db, batch.id, { ...counts, previewReady: false }, { status: "draft" });
    return { progress: { done: 0, total: 0, phase: "done" }, outcome: "stale: an input was removed" };
  }
  const waitingForColumn = uploads.some((u) => (u.detected as Detected | null)?.cannotRead);
  if (!versions.length && !waitingForColumn) {
    const uploadErrors = uploads.filter((u) => u.status === "failed" && u.error).map((u) => u.error!);
    const linkUploads = uploads.filter((u) => manifests.get(u.id)?.items.some((i) => i.bytes.kind === "url"));
    const links = linkUploads.reduce((n, u) => n + manifests.get(u.id)!.items.filter((i) => i.bytes.kind === "url").length, 0);
    const failReason = noPhotosReason(grouped.rejected, uploadErrors, links ? { links, source: linkSourceWords(linkUploads) } : undefined);
    await patchCounts(db, batch.id, { ...counts, failReason }, { status: "failed" });
    // An operator upload with nothing usable: WARNING, so it sends no alert and stays out of Error Reporting.
    log("WARNING", "batch failed", { batchId: batch.id, brandSlug: batch.brandSlug, reason: failReason, cause: "no_photos" });
    return { progress: { done: 0, total: 0, phase: "done" }, outcome: "failed: no photos" };
  }
  await patchCounts(db, batch.id, counts, { status: "draft" });
  return {
    progress: { done: versions.length, total: versions.length, phase: "done" },
    outcome: `preview ready: ${withPhotos.length} products, ${versions.length} photos`,
  };
}

// --- Step 4 -----------------------------------------------------------------------------------

/**
 * Step 4 data, computed on request. The grouping is the one the batch-wide step stored; the parts
 * that change after ingest are recomputed now: live shots on the batch's channels as they are now,
 * busy products, rename hints. A product counts as new when this batch created it (its
 * catalog_batch_products.change is `new`), so the count stays right after ingest created the rows.
 * Duplicate spellings were rejected at ingest and come from the stored state.
 */
export async function buildPreview(db: Db, batchId: string, deps: Pick<IngestDeps, "storage">, opts: { limit?: number } = {}): Promise<Preview> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error("This batch does not exist.");
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  const state = await loadJson<PreviewState>(deps, statePath(prefix));
  if (!state) throw new Error("The preview is not ready yet. Wait until the files are collected.");

  const sha256ByItem = new Map<SourceItem, string>();
  const dimensions: ItemDimensions = new Map();
  const rawUriOf = new Map<SourceItem, string>();
  const restore = (s: StoredItem) => {
    if (s.sha256) sha256ByItem.set(s.item, s.sha256);
    dimensions.set(s.item, { width: s.width, height: s.height });
    if (s.rawUri) rawUriOf.set(s.item, s.rawUri);
    return s.item;
  };
  const grouped: GroupingResult = {
    products: new Map(state.products.map((p) => [p.identifier, p.items.map(restore)])),
    rejected: state.rejected.map((r) => ({ item: restore(r.item), reason: r.reason })),
    warnings: state.warnings,
  };

  const own = await db
    .select({ productId: catalogBatchProducts.productId, change: catalogBatchProducts.change, pathKey: catalogProducts.pathKey })
    .from(catalogBatchProducts)
    .innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId))
    .where(eq(catalogBatchProducts.batchId, batch.id));
  const ownById = new Map(own.map((o) => [o.productId, o]));
  const matches = state.products.map((p) => {
    const o = ownById.get(p.productId);
    return { identifier: p.identifier, productId: p.productId, pathKey: o?.pathKey ?? sanitizeSegment(p.identifier), isNew: o?.change === "new", matchedBy: null };
  });
  const overwrite = await buildOverwritePreview(db, batch, grouped, matches, sha256ByItem);
  overwrite.duplicates = state.duplicates;

  const [photos] = await db.select({ n: count() }).from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batch.id));
  const skus = new Map(state.skus);
  const thumb = (item: SourceItem) => rawUriOf.get(item) ?? null;
  const allRows = previewRows(grouped, skus, thumb, Number.MAX_SAFE_INTEGER, { missing: state.missing, dimensions });
  const channels: ChannelId[] = batch.channels;
  const photoCount = Number(photos?.n ?? 0);
  return {
    kpis: { products: grouped.products.size, photos: photoCount, channels: channels.length, outputs: photoCount * channels.length },
    warnings: warningSentences(grouped, state.list, channels, { brandName: batch.brandName, topLevelFolders: state.topLevelFolders, byMatchColumn: state.byMatchColumn }),
    rows: allRows.slice(0, Math.max(0, opts.limit ?? PREVIEW_ROW_LIMIT)),
    totalRows: allRows.length,
    overwrite,
  };
}

// --- Without a database (the catalog-local CLI) --------------------------------------------------

export interface OfflineShot { n: number; uri: string; sha256: string; width: number | null; height: number | null; flags: OutputFlag[] }
export interface OfflineResult {
  products: { identifier: string; skus: string[]; shots: OfflineShot[] }[];
  missing: string[];
  rejected: { name: string; reason: string }[];
  warnings: { headline: string; detail: string }[];
}

/**
 * The same adapters, reading and grouping as runIngest, with no database: every item is read in
 * one go, products are named by sanitizeSegment(identifier) and each shot is written to
 * rawPath(prefix, path_key, n, ext) through `deps.storage`. matchProducts and the overwrite preview
 * are skipped; SKU ids come only from a product list.
 */
export async function collectOffline(input: {
  brandName: string; prefix: string; uploads: CatalogUpload[]; options: BatchOptions; deps: IngestDeps; channels?: ChannelId[];
  onProgress?(done: number, total: number): void;
}): Promise<OfflineResult> {
  const { prefix, uploads, options, deps } = input;
  const manifests = new Map<string, UploadManifest>();
  const rejected: { name: string; reason: string }[] = [];
  for (const upload of uploads) {
    const ci: CollectInput = { batchId: upload.batchId, brandSlug: "", prefix, upload, options, deps };
    const listing = await listUpload(ci);
    const m: UploadManifest = { version: 1, ...listing, results: {} };
    const zips: ZipReaders = new Map();
    let done = 0;
    await mapLimit(m.items, ITEM_CONCURRENCY, async (item) => {
      m.results[itemKey(item)] = await readItem(item, deps, { prefix, uploadId: upload.id, zips });
      input.onProgress?.(++done, m.items.length);
    });
    rejected.push(...(listing.detected.rejected ?? []));
    manifests.set(upload.id, m);
  }
  const lists = await readLists(uploads, manifests, deps, prefix, options);
  const a = assemble([...manifests.values()], lists, options);
  const bucket = getBucketName();
  const products = await mapLimit([...a.grouped.products], COPY_CONCURRENCY, async ([identifier, items]) => {
    const pathKey = sanitizeSegment(identifier);
    const shots: OfflineShot[] = [];
    for (const [i, item] of items.entries()) {
      const r = a.resultOf(item);
      if (!r) continue;
      const n = item.n ?? i + 1;
      const uri = await placeRaw(deps.storage, bucket, rawPath(prefix, pathKey, n, r.ext), r);
      shots.push({ n, uri, sha256: r.sha256, width: r.width, height: r.height, flags: [...new Set([...r.flags, ...shotFlags(item)])] });
    }
    return { identifier, skus: a.listSkuIds.get(identifier) ?? [], shots };
  });
  for (const r of a.grouped.rejected) rejected.push({ name: r.item.originalName, reason: r.reason });
  const topLevelFolders = [
    ...new Set(
      [...manifests.entries()].flatMap(([id, m]) => {
        const kind = uploads.find((u) => u.id === id)!.kind;
        return finalDetected(m, kind).topLevelFolders ?? [];
      }),
    ),
  ].sort(byText);
  return {
    products,
    missing: a.missing,
    rejected,
    warnings: warningSentences(a.grouped, a.list, input.channels ?? [], { brandName: input.brandName, topLevelFolders, byMatchColumn: a.byMatchColumn }),
  };
}
