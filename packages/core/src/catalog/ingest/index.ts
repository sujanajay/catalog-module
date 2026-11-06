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
// - `<prefix>/derived/_ingest/group-state-<lease>.json`: the grouping, matches and overwrite preview groupBatch
//   decided, for the deliveries that find or create the products in chunks; `group-products-<lease>-<n>.json`:
//   what those chunks decided before product n.
// - `<prefix>/derived/_ingest/place-state-<lease>.json`: the shot list groupBatch planned, for the placing
//   deliveries (spec 14d F7 part 2).
//   `<lease>` names the placing lease they were written under (leaseFileKey), so a frozen delivery of an earlier
//   run that saves late never overwrites a newer run's files.
// - `<prefix>/derived/_ingest/preview-state.json`: the grouping the batch-wide step decided, for
//   buildPreview.
// Version rows point at `rawPath(prefix, path_key, n, ext)`, written by the batch-wide step.
import { createHash, randomUUID } from "node:crypto";
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
import { recordSourcePhotoVersions } from "../../graph/write-path";
import { eachLimit } from "../../concurrency";
import { getBucketName, isRetryableStorageError, toGsUri } from "../../storage";
import type { enqueueTask } from "../../tasks";
import { log } from "../../log";
import { mergeCounts, placingClaim, placingLeaseFree, placingLeaseHeld, placingLeaseResumable, placingToken, progressCounts, RATE_SAMPLE_GAP_MS, type DoneKey } from "../counts";
import { batchPrefix, normalizeKey, rawPath, sanitizeSegment } from "../naming";
import { findOrCreateProduct } from "../products";
import { loadSkuResolver, type ResolveResult, type SkuResolver } from "../sku-mapping";
import type { BatchCounts, BatchOptions, ChangeKind, ChannelId, IntakePhase, LinkStatus, OutputFlag, PlacingClaim, UploadKind } from "../types";
import { driveFolderAdapter } from "./drive-folder";
import { googleSheetAdapter, sheetCopyUri } from "./google-sheet";
import { allocateShots, shotNumbers, shotRanks } from "./append";
import { hashedTaskId, INGEST_ROUTE } from "./hand-off";
import {
  baseName, byText, distinct, fmt, groupItems, isDuplicateReject, isProductRefusal, isSameProductReject, LEFT_OUT_WORDS, leftOutProducts, newestIdentifier, olderSameProductMessage, originalOf, previewRows, sameProductMessage, shotFlags,
  warningSentences, type ItemDimensions,
} from "./group";
import { checkImage, classifyImageReject, corruptMessage, imageFlags } from "./image-check";
import { classifyLinkReject, isLinkReject, noLinkPhotosReason, type LinkReject } from "./link-reasons";
import { itemKey, loadJson, manifestPath, saveJson, workPrefix, type ItemResult, type UploadManifest } from "./manifest";
import { LINK_UPLOAD_KINDS } from "./link-failures";
import { linksSheetAdapter, readLinksSheetUpload, normalizeHeader } from "./links-sheet";
import { completeUploads, mapLimit } from "./local-files";
import { buildOverwritePreview, matchProducts, uploadTimes } from "./overwrite-preview";
import { linkStatuses, matchProductList, missingIdentifier, productListDetected, readProductList, sizeBases, type ProductListRow } from "./product-list";
import type { Adapter, CollectInput, Detected, GroupingResult, IngestDeps, OverwritePreview, Preview, SameFile, SourceItem, UploadReject } from "./types";
import { badLinkRejects, fetchSourceUrl, parsePastedLinks, pastedText, urlListAdapter } from "./url-list";
import { armAutoStart } from "../auto-start";
import { columnLetter } from "./detect-step";
import type { InputRoot, StoredRoot } from "./roots";
import { collectRejectReason, openZipReader, tooLargeMessage, zipAdapter, ZIP_ENTRY_MAX_BYTES } from "./zip";
import { pushAll } from "../../arrays";

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


/** Builder constants (spec 14d F5 part 2): fetches of a link inside one delivery, and across runs before a transient failure is final. */
export const LINK_RETRY_ATTEMPTS = 3;
export const LINK_MAX_ATTEMPTS = 9;
/** Waits before the second and third fetch of a link. */
export const LINK_RETRY_BACKOFF_MS = [2_000, 8_000] as const;
/** Timeout of a retry; the first fetch keeps safeFetch's 60 s. */
export const LINK_RETRY_TIMEOUT_MS = 20_000;
/**
 * Builder constant (spec 14d F5 part 2): after this much work a delivery starts no new item, saves what
 * it read and continues in a new delivery, so a slow host cannot push it past the 900 s deadline. An
 * item started just before the budget runs out takes at most 60 + 2 + 20 + 8 + 20 s more.
 */
export const INGEST_TIME_BUDGET_MS = 600_000;
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

/**
 * Staged writes of one delivery, by object path. All sizes of a colour share the same photo links, so
 * many items carry the same bytes; GCS allows about one write per second to one object and answers 429
 * beyond it. Each staged object is therefore written at most once per delivery, and not at all when it
 * is already there (the name is the sha256 of the bytes, so an existing object holds the same bytes).
 */
type StagedWrites = Map<string, Promise<string>>;

function stageOnce(deps: IngestDeps, staged: StagedWrites, path: string, buf: Buffer, mime: string): Promise<string> {
  let write = staged.get(path);
  if (!write) {
    write = (async () => {
      const uri = toGsUri(getBucketName(), path);
      return (await deps.storage.headObject(uri)).exists ? uri : deps.storage.uploadBuffer(path, buf, mime);
    })();
    staged.set(path, write);
  }
  return write;
}

/** The first of each group of indexes whose items share an itemKey (one result serves them all). */
function firstPerKey(items: readonly SourceItem[], indexes: readonly number[]): number[] {
  const seen = new Set<string>();
  return indexes.filter((i) => {
    const k = itemKey(items[i]!);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetches a link with automatic retry (spec 14d F5 part 2): a transient failure (a timeout, a 429 or a
 * 5xx, classifyLinkReject) is tried again up to LINK_RETRY_ATTEMPTS times in this delivery, waiting
 * LINK_RETRY_BACKOFF_MS, with a LINK_RETRY_TIMEOUT_MS timeout. `prior` is the fetches earlier runs made.
 * A failure is final when it is permanent or the attempts reach LINK_MAX_ATTEMPTS.
 */
async function fetchLink(item: SourceItem, deps: IngestDeps, prior: number): Promise<{ ok: true; buf: Buffer; attempts: number } | { ok: false; result: ItemResult }> {
  for (let tries = 1; ; tries++) {
    const got = await fetchSourceUrl(item, deps, { ...(deps.lookup ? { lookup: deps.lookup } : {}), ...(tries > 1 ? { timeoutMs: LINK_RETRY_TIMEOUT_MS } : {}) });
    const attempts = prior + tries;
    if (got.ok) return { ok: true, buf: got.buf, attempts };
    const temporary = classifyLinkReject(got.reason)?.temporary === true;
    if (!temporary || attempts >= LINK_MAX_ATTEMPTS) return { ok: false, result: { ok: false, reason: got.reason, attempts, final: true } };
    if (tries >= LINK_RETRY_ATTEMPTS) return { ok: false, result: { ok: false, reason: got.reason, attempts, final: false } };
    await (deps.sleep ?? defaultSleep)(LINK_RETRY_BACKOFF_MS[tries - 1]!);
  }
}

const isNotFound = (err: unknown) => [(err as { code?: unknown })?.code, (err as { status?: unknown })?.status].some((c) => Number(c) === 404);

/**
 * Read one item: its bytes (our bucket, a zip entry streamed by range reads, or a link fetched with
 * fetchSourceUrl), sha256 and checkImage on the full bytes. Zip entries and fetched links are
 * stored content-addressed under derived/_ingest/ through stageOnce, so the same bytes are written once.
 */
async function readItem(item: SourceItem, deps: IngestDeps, ctx: { prefix: string; uploadId: string; zips: ZipReaders; staged: StagedWrites; priorAttempts?: Record<string, number> }): Promise<ItemResult> {
  const reject = collectRejectReason(item);
  if (reject) return { ok: false, reason: reject };
  const name = baseName(item);
  let buf: Buffer;
  let attempts: number | null = null;
  if (item.bytes.kind === "url") {
    const got = await fetchLink(item, deps, ctx.priorAttempts?.[itemKey(item)] ?? 0);
    if (!got.ok) return got.result;
    buf = got.buf;
    attempts = got.attempts;
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
  const uri = item.bytes.kind === "gcs" ? item.bytes.gsUri : await stageOnce(deps, ctx.staged, stagedPath(ctx.prefix, ctx.uploadId, sha256, check.ext), buf, check.mime);
  return {
    ok: true, sha256, uri, mime: check.mime, ext: check.ext, width: check.width || null, height: check.height || null,
    size: buf.length, flags: imageFlags(check), ...(attempts !== null ? { attempts } : {}),
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
  // A Supabase folder paste keeps its link and naming mode (M1-F1-R4) for the grouping sentence.
  if (prior?.supabaseFolder) detected.supabaseFolder = prior.supabaseFolder;
  const lostBefore = [...(prior?.supabaseFolder?.small ?? []), ...(upload.kind === "url_list" ? badLinkRejects(parsePastedLinks(await pastedText(input))) : [])];
  if (lostBefore.length) detected.rejected = lostBefore;
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

/**
 * Records collecting progress (spec 14c F6): `phase` and a `rate` sample of `collected`, merged into
 * counts. Applies only while the batch is `ingesting`, so it is also the delivery's cancel check:
 * false when the batch is no longer collecting.
 */
async function collectProgress(db: Db, batchId: string, phase: IntakePhase, at: Date, patch: Partial<BatchCounts> = {}, done: number | DoneKey = "collected"): Promise<boolean> {
  const rows = await db
    .update(catalogBatches)
    .set({ counts: progressCounts(patch, { phase, done, at }) })
    .where(and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "ingesting")))
    .returning({ id: catalogBatches.id });
  return rows.length > 0;
}


/**
 * The collecting phase of a batch (spec 14c F6), one for all its uploads so parallel deliveries write
 * the same phase and `rate` stays measurable: links to download (pasted, or in a sheet that is not a
 * product list) -> downloading; else a zip -> unpacking; else checking uploaded files.
 */
async function collectPhaseOf(db: Db, batchId: string): Promise<IntakePhase> {
  const uploads = await db
    .select({ kind: catalogUploads.kind, detected: catalogUploads.detected })
    .from(catalogUploads)
    .where(and(eq(catalogUploads.batchId, batchId), ne(catalogUploads.status, "removed")));
  if (uploads.some((u) => LINK_UPLOAD_KINDS.includes(u.kind) && (u.detected as Detected | null)?.kind !== "product_list")) return "downloading";
  if (uploads.some((u) => u.kind === "zip")) return "unpacking";
  return "checking";
}

/**
 * One ingest delivery's body. `place` (spec 14d F7 part 2) marks a placing continuation: it carries the
 * cursor into the shot list, and the rest of the body is that of the delivery that claimed the lease,
 * so deliveryToken gives the same token.
 */
export interface DeliveryBody { batchId: string; uploadId: string; cursor?: string; run?: string; place?: string; group?: string }

/** The body of a continuation of `body`: the claiming delivery's own keys (so the same token) plus `extra`. */
function handOnBody(body: DeliveryBody, extra: { place: string } | { group: string }): Record<string, string> {
  return { batchId: body.batchId, uploadId: body.uploadId, ...(body.cursor !== undefined ? { cursor: body.cursor } : {}), ...(body.run !== undefined ? { run: body.run } : {}), ...extra };
}

/**
 * The placing token of a delivery (spec 14c F6): its run (the hand-off's `run` when the body carries
 * one, and its cursor) and upload id, so a Cloud Tasks retry of the same task presents the same token.
 */
export function deliveryToken(body: { uploadId: string; cursor?: string; run?: string }): string {
  return placingToken(`${body.run ?? "-"}@${body.cursor ?? "0"}`, body.uploadId);
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
  deps: PlaceDeps & { budgetItems?: number },
  body: DeliveryBody,
): Promise<{ progress: IngestProgress; outcome: string }> {
  const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, body.uploadId));
  if (!upload || upload.batchId !== body.batchId) throw new Error(`Upload ${body.uploadId} is not part of batch ${body.batchId}.`);
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, body.batchId));
  if (!batch) throw new Error(`Batch ${body.batchId} does not exist.`);
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  const clock = () => deps.now?.() ?? new Date();
  const token = deliveryToken(body);
  const noop = (why: string) => ({ progress: { done: 0, total: null, phase: "done" as const }, outcome: `noop: ${why}` });

  // A cancelled batch is never collected or placed again (spec 14c F4 part 2). A placing continuation
  // that finds it cancelled between two chunks removes the rows grouping wrote, as the placing would.
  if (batch.status === "cancelled") {
    if (body.place !== undefined || body.group !== undefined) await removeDraftRows(db, batch.id);
    return noop("the batch is cancelled");
  }
  // A placing continuation (spec 14d F7 part 2) places the next chunk under its lease, whatever the upload's status.
  if (body.place !== undefined) {
    if (batch.status !== "ingesting") return noop(`the batch is ${batch.status}`);
    const cursor = Number(body.place);
    return (await resumeAttempt(db, deps, batch.id, token, body, { kind: "place", cursor }, (attempt) => placeBatch(db, deps, batch.id, token, attempt, cursor, body)))
      ?? noop("another delivery holds the placing lease");
  }
  // A grouping continuation finds or creates the next chunk of products under its lease.
  if (body.group !== undefined) {
    if (batch.status !== "ingesting") return noop(`the batch is ${batch.status}`);
    const cursor = Number(body.group);
    const startedAt = clock().getTime();
    return (await resumeAttempt(db, deps, batch.id, token, body, { kind: "products", cursor }, (attempt) => groupProducts(db, deps, batch.id, token, attempt, cursor, body, startedAt)))
      ?? noop("another delivery holds the placing lease");
  }
  if (upload.status === "collected" || upload.status === "failed" || upload.status === "removed") {
    // A removed upload (spec 14b F3) is never read; a delivery queued before the removal only finishes the batch.
    return (await finishIfLast(db, deps, batch.id, token, body)) ?? noop(`upload already ${upload.status}`);
  }
  if (!["draft", "ingesting", "failed"].includes(batch.status)) return noop(`the batch is ${batch.status}`);
  const phase = await collectPhaseOf(db, batch.id);
  if (!body.cursor) {
    // A new run (first delivery or a step 2 re-run): the batch is collecting again. A placing lease left
    // by an earlier run is cleared, since its grouping is out of date. Conditional, so a batch cancelled
    // since it was read above stays cancelled.
    const started = await db
      .update(catalogBatches)
      .set({
        status: "ingesting",
        // M1 D24: a lease that ran out is cleared (its grouping is out of date); a live one is left to its step, which
        // sees the input change at its close and groups again (inputsChanged) instead of two steps running at once.
        counts: sql`${progressCounts({ previewReady: false, failReason: null }, { phase: upload.kind === "sheet" || upload.kind === "google_sheet" ? "reading" : phase, done: "collected", at: clock() })} || (CASE WHEN ${placingLeaseFree(clock())} THEN '{"placingClaim": null}'::jsonb ELSE '{}'::jsonb END)`,
      })
      .where(and(eq(catalogBatches.id, batch.id), inArray(catalogBatches.status, ["draft", "ingesting", "failed"])))
      .returning({ id: catalogBatches.id });
    if (!started.length) return noop("the batch is no longer collecting");
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
      return (await finishIfLast(db, deps, batch.id, token, body)) ?? { progress: { done: 0, total: 0, phase: "done" }, outcome: `upload failed: ${error}` };
    }
    // A new run carries every result forward except a link's non-final failure (spec 14d F5 part 2):
    // that link is fetched again, its earlier attempts kept so they add up towards LINK_MAX_ATTEMPTS.
    // Continuations of this run read the saved manifest, so they never fetch it again.
    const results: Record<string, ItemResult> = {};
    const priorAttempts: Record<string, number> = {};
    for (const item of listing.items) {
      const k = itemKey(item);
      const prev = old?.results[k];
      if (prev && !prev.ok && prev.final === false) priorAttempts[k] = prev.attempts ?? 0;
      else if (prev) results[k] = prev;
      else if (old?.priorAttempts?.[k]) priorAttempts[k] = old.priorAttempts[k];
    }
    manifest = { version: 1, ...listing, results, ...(Object.keys(priorAttempts).length ? { priorAttempts } : {}) };
  } else {
    manifest = old;
  }

  // Items still to read, from the cursor round to the start (a lost write is picked up again).
  const total = manifest.items.length;
  const start = Math.min(Math.max(0, Number(body.cursor ?? 0) || 0), total);
  const order = [...Array(total).keys()].map((k) => (start + k) % Math.max(total, 1));
  const unread = () => order.filter((i) => !manifest.results[itemKey(manifest.items[i]!)]);
  // Items sharing a link share one result, so each is read once: reading them side by side would fetch the
  // same link and write the same staged object at once.
  const todo = firstPerKey(manifest.items, unread()).slice(0, deps.budgetItems ?? INGEST_BUDGET_ITEMS);
  const zips: ZipReaders = new Map();
  const staged: StagedWrites = new Map();
  const startedAt = clock().getTime();
  // An item that throws (a storage error past its retries) stops new items; what was read is still saved
  // below before the error is rethrown, so the Cloud Tasks retry goes on from there instead of starting over.
  let readError: { error: unknown } | null = null;
  try {
    await eachLimit(todo, ITEM_CONCURRENCY, async (i) => {
      // The time budget (spec 14d F5 part 2): past it, no new item starts; the continuation reads the rest.
      if (clock().getTime() - startedAt >= INGEST_TIME_BUDGET_MS) return;
      const item = manifest.items[i]!;
      manifest.results[itemKey(item)] = await readItem(item, deps, { prefix, uploadId: upload.id, zips, staged, ...(manifest.priorAttempts ? { priorAttempts: manifest.priorAttempts } : {}) });
    });
  } catch (error) {
    readError = { error };
  }
  // Cloud Tasks delivers at least once, so another delivery of this upload may have saved while this
  // one was reading: keep what it read, and count only what this save adds to the stored manifest.
  const stored = await loadJson<UploadManifest>(deps, manifestPath(prefix, upload.id));
  for (const item of manifest.items) {
    const k = itemKey(item);
    const theirs = stored?.results[k];
    // A non-final failure no newer than this run's attempt history is the earlier run's, which this
    // run fetches again (spec 14d F5 part 2): it is not carried back as if read.
    const earlierRun = theirs && !theirs.ok && theirs.final === false && manifest.priorAttempts?.[k] !== undefined && (theirs.attempts ?? 0) <= manifest.priorAttempts[k]!;
    if (!manifest.results[k] && theirs && !earlierRun) manifest.results[k] = theirs;
  }
  await saveJson(deps, manifestPath(prefix, upload.id), manifest);
  await bumpCollected(db, batch.id, doneCount(manifest) - doneCount(stored), total - (stored?.items.length ?? 0));
  if (readError) throw readError.error;
  // The phase and a rate sample, read after the bump; a batch cancelled meanwhile stops here, with
  // no continuation and no upload marked collected.
  if (!(await collectProgress(db, batch.id, phase, clock()))) {
    const [now] = await db.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batch.id));
    if (now?.status === "cancelled") return { progress: { done: doneCount(manifest), total, phase: "done" }, outcome: "stopped: the batch was cancelled" };
  }

  const done = doneCount(manifest);
  const left = unread();
  if (left.length) {
    const cursor = String(left[0]);
    await deps.enqueue(INGEST_ROUTE, { batchId: batch.id, uploadId: upload.id, cursor, ...(body.run ? { run: body.run } : {}) });
    return { progress: { done, total, phase: "copying" }, outcome: `collected ${done} of ${total}; continuing at ${cursor}` };
  }

  await db
    .update(catalogUploads)
    .set({ status: "collected", error: null, detected: finalDetected(manifest, upload.kind) as unknown as Record<string, unknown> })
    .where(eq(catalogUploads.id, upload.id));
  return (await finishIfLast(db, deps, batch.id, token, body)) ?? { progress: { done, total, phase: "done" }, outcome: "collected; waiting for the other uploads" };
}

const UPLOADS_LEFT = (batchId: string) =>
  sql`EXISTS (SELECT 1 FROM ${catalogUploads} WHERE ${catalogUploads.batchId} = ${batchId} AND ${catalogUploads.status} NOT IN ('collected', 'failed', 'removed'))`;

/**
 * Runs the batch-wide step (groupBatch, then placeBatch in chunks) when every upload is collected, failed or removed and the batch is still
 * `ingesting` (spec 14c F6). The claim is one conditional UPDATE that takes the placing lease
 * (`placingClaim` for `token`, `phase: "placing"`), so of two uploads finishing together only one
 * runs it; the batch stays `ingesting` until the closing write. Each run of the step carries its own
 * `attempt` in the claim. A thrown error keeps the lease but releases the attempt, so the retry of the
 * same task (same token) takes it back and runs the step again; a duplicate delivery of that task while
 * its first copy still runs does nothing, and so does a delivery with another token while the lease is
 * live (it takes the lease over once it ran out). A run killed without throwing (the request deadline)
 * holds its attempt until the lease runs out, which shows as stalled; Try again clears it.
 */
async function finishIfLast(db: Db, deps: PlaceDeps, batchId: string, token: string, body: DeliveryBody): Promise<{ progress: IngestProgress; outcome: string } | null> {
  const now = deps.now?.() ?? new Date();
  const attempt = randomUUID();
  const ingesting = and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "ingesting"));
  // M1 D24: the claim takes the batch row lock first (an input change holds it while it writes its upload rows and the
  // change marker), so the uploads check reads every change committed before it, and the step records the marker it
  // groups with (groupedChange); a change after this is caught at the closing write.
  const claimed = await db.transaction(async (tx) => {
    await tx.select({ id: catalogBatches.id }).from(catalogBatches).where(eq(catalogBatches.id, batchId)).for("update");
    return tx
      .update(catalogBatches)
      .set({ counts: sql`${progressCounts({ placingClaim: placingClaim(token, now, attempt), placed: 0, placeTotal: null, grouped: 0, groupTotal: null }, { phase: "grouping", done: 0, at: now })} || jsonb_build_object('groupedChange', ${catalogBatches.counts}->'inputsChangedAt')` })
      .where(and(ingesting, placingLeaseFree(now), sql`NOT ${UPLOADS_LEFT(batchId)}`))
      .returning({ id: catalogBatches.id });
  });
  // Grouping is not run again once placing went on to a later chunk (spec 14d F7 part 2): the retry
  // of this delivery after that only queues the continuation again.
  if (!claimed.length) return resumeAttempt(db, deps, batchId, token, body, { kind: "group" }, (a) => groupBatch(db, deps, batchId, token, a, body));
  return runAttempt(db, deps, batchId, token, attempt, () => groupBatch(db, deps, batchId, token, attempt, body));
}

const claimNextSql = sql`${catalogBatches.counts}->'placingClaim'->'next'`;
const claimGroupSql = sql`${catalogBatches.counts}->'placingClaim'->'group'`;
/** The counts with `claim`'s keys merged into the stored placing claim (its `next` kept). */
const mergeClaim = (claim: PlacingClaim) => sql`${catalogBatches.counts} || jsonb_build_object('placingClaim', (${catalogBatches.counts}->'placingClaim') || ${JSON.stringify(claim)}::jsonb)`;

/**
 * Runs one attempt of the batch-wide step under the lease `token` (spec 14c F6). A thrown error keeps
 * the lease but releases the attempt, so the retry of the same task takes it back.
 */
async function runAttempt(db: Db, deps: IngestDeps, batchId: string, token: string, attempt: string, step: () => Promise<StepResult>): Promise<StepResult> {
  try {
    return await step();
  } catch (err) {
    await db
      .update(catalogBatches)
      .set({ counts: mergeClaim(placingClaim(token, deps.now?.() ?? new Date(), null)) })
      .where(and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "ingesting"), placingLeaseHeld(token, attempt)));
    throw err;
  }
}

/**
 * Where the batch-wide step of one lease stands: grouping (the claiming delivery), a chunk of products
 * handed on at `cursor`, or a chunk of placing handed on at `cursor`. They run in that order.
 */
type Stage = { kind: "group" } | { kind: "products"; cursor: number } | { kind: "place"; cursor: number };

/**
 * Takes back the live, released lease `token` for one attempt (spec 14c F6) when the step stands at
 * `stage` (grouping, before any chunk was handed on; a products chunk; a placing chunk, spec 14d F7 part 2),
 * and runs `step` under it. When the step already went past `stage` under this token (a retried or
 * duplicate delivery whose hand-off happened), the continuation it handed to is queued again (named, so
 * Cloud Tasks drops a copy) and nothing else runs. Otherwise null.
 */
async function resumeAttempt(
  db: Db, deps: PlaceDeps, batchId: string, token: string, body: DeliveryBody, stage: Stage,
  step: (attempt: string) => Promise<StepResult>,
): Promise<StepResult | null> {
  const now = deps.now?.() ?? new Date();
  const attempt = randomUUID();
  const ingesting = and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "ingesting"));
  const at = stage.kind === "group" ? sql`${claimNextSql} IS NULL AND ${claimGroupSql} IS NULL`
    : stage.kind === "products" ? sql`${claimNextSql} IS NULL AND (${claimGroupSql})::int = ${stage.cursor}`
    : sql`(${claimNextSql})::int = ${stage.cursor}`;
  const resumed = await db
    .update(catalogBatches)
    .set({ counts: mergeClaim(placingClaim(token, now, attempt)) })
    .where(and(ingesting, placingLeaseResumable(token, now), at))
    .returning({ id: catalogBatches.id });
  if (resumed.length) return runAttempt(db, deps, batchId, token, attempt, () => step(attempt));
  const [b] = await db.select({ status: catalogBatches.status, counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const claim = b?.status === "ingesting" ? b.counts.placingClaim : null;
  if (claim?.token !== token) return null;
  if (typeof claim.next === "number" && (stage.kind !== "place" || claim.next > stage.cursor)) {
    await deps.enqueue(INGEST_ROUTE, handOnBody(body, { place: String(claim.next) }), { taskId: placeTaskId(batchId, token, claim.next) });
    return { progress: { done: claim.next, total: null, phase: "copying" }, outcome: `placing already at ${claim.next}; continuation queued again` };
  }
  if (typeof claim.next !== "number" && typeof claim.group === "number" && (stage.kind === "group" || (stage.kind === "products" && claim.group > stage.cursor))) {
    await deps.enqueue(INGEST_ROUTE, handOnBody(body, { group: String(claim.group) }), { taskId: groupTaskId(batchId, token, claim.group) });
    return { progress: { done: claim.group, total: null, phase: "grouping" }, outcome: `grouping already at ${claim.group}; continuation queued again` };
  }
  return null;
}

// --- Grouping what was collected (shared by the runner and the CLI) -----------------------------

interface ListInput { rows: ProductListRow[]; picked: boolean }

/** A reject row as leftOutProducts reads it. */
const ledgerRows = (rejected: GroupingResult["rejected"], uploadRejects: readonly UploadReject[]) => [
  ...rejected.map((r) => ({ identifier: r.item.identifier, name: r.item.originalName, reason: r.reason })),
  ...uploadRejects.map((r) => ({ identifier: r.identifier ?? "", name: r.name, reason: r.reason })),
];

/** The sentence for a product list that could not be used: its rows are not checked against the photos. */
export function listNotReadMessage(name: string): string {
  return `The product list ${name} could not be read, so nothing could be checked against it. Products in it with no photos are not named. Fix the list and send it in a new batch.`;
}

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
  uploadRejects: UploadReject[];
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
function assemble(manifests: UploadManifest[], lists: ListInput[], options: BatchOptions, listRejects: UploadReject[] = []): Assembled {
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
  // Every item was read and hashed before this step, so a same-number clash is judged by its bytes at no extra read.
  const sha256Of = (item: SourceItem) => {
    const r = results.get(itemKey(item));
    return r?.ok ? r.sha256 : null;
  };
  const grouped = groupItems(items, options, unreadable, sha256Of);
  for (const m of manifests) pushAll(grouped.warnings, m.warnings);
  // What the uploads lost before grouping (m.detected holds only those; finalDetected adds the read rejects to the stored copy).
  const uploadRejects: UploadReject[] = [...manifests.flatMap((m) => (m.productList ? [] : (m.detected.rejected ?? []).map((r) => ({ ...r })))), ...listRejects];
  for (const r of listRejects) grouped.warnings.push(r.reason);

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
      // A rejected file of a renamed product stays with it, so that product is not read as left out.
      for (const r of grouped.rejected) r.item.identifier = m.renamed.get(r.item.identifier) ?? r.item.identifier;
      for (const s of grouped.sameFiles ?? []) s.identifier = m.renamed.get(s.identifier) ?? s.identifier;
    }
    statuses = linkStatuses(list, grouped, { byMatchColumn });
    // A left-out product is matched like a kept one, so its list row (under any of the match rules) is that product and
    // not a second one: it takes the list's name, and only then is a row with no photos under it.
    const left = leftOutProducts(ledgerRows(grouped.rejected, uploadRejects), grouped.products.keys()).map((l) => l.identifier);
    if (left.length) {
      const named = matchProductList(list, [...grouped.products.keys(), ...left], { byMatchColumn });
      const finalOf = new Map(left.map((id) => [id, named.renamed.get(id) ?? id]));
      for (const r of grouped.rejected) r.item.identifier = finalOf.get(r.item.identifier) ?? r.item.identifier;
      for (const r of uploadRejects) if (r.identifier) r.identifier = finalOf.get(r.identifier) ?? r.identifier;
      const finals = [...finalOf.values()];
      statuses = linkStatuses(list, { ...grouped, products: new Map([...grouped.products, ...finals.map((id): [string, SourceItem[]] => [id, []])]) }, { byMatchColumn });
      for (const id of finals) {
        if (statuses.get(id) === "ok") statuses.set(id, "missing_images");
        else statuses.delete(id);
      }
    }
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
  return { grouped, resultOf, sha256ByItem, dimensions, list, byMatchColumn, statuses, missing, eans, listSkuIds, uploadRejects };
}

/** Rows of every product list upload (a list whose identifier column cannot be told is skipped; step 2 asks). */
async function readLists(uploads: CatalogUpload[], manifests: Map<string, UploadManifest>, deps: Pick<IngestDeps, "storage">, prefix: string, options: BatchOptions, notRead: UploadReject[] = []): Promise<ListInput[]> {
  const out: ListInput[] = [];
  const unread = (upload: CatalogUpload) => notRead.push({ name: upload.name, reason: listNotReadMessage(upload.name), upload: true });
  for (const upload of uploads) {
    const m = manifests.get(upload.id);
    if (!m?.productList) continue;
    // Step 2 asks for the column first; a batch that goes on without an answer has not used this list.
    if (m.detected.cannotRead) {
      unread(upload);
      continue;
    }
    const input = { batchId: upload.batchId, brandSlug: "", prefix, upload, options, deps: deps as IngestDeps };
    const src = upload.kind === "product_list" ? { gsUri: upload.gcsUri ?? "", name: upload.name } : await sheetSource(input);
    const { buf } = await deps.storage.downloadBuffer(src.gsUri);
    const columns = await pickedColumns(buf, src.name, m.detected);
    try {
      out.push({ rows: await readProductList(buf, src.name, columns), picked: !!columns });
    } catch (err) {
      if (isRetryableStorageError(err)) throw err;
      unread(upload);
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
  /** Shots that came as several files with the same bytes (absent on states saved before it). */
  sameFiles?: SameFile[];
  /** What the uploads lost before grouping (absent on states saved before it). */
  uploadRejects?: UploadReject[];
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

/**
 * Puts an item's bytes at the raw object `target` unless they are already there (spec 14c F7 part 1):
 * a target whose stored sha256 (custom metadata, written here) equals the item's is not copied
 * again, so a repeated placing costs one metadata read per photo. Returns the gs:// URI.
 */
async function placeRaw(storage: IngestDeps["storage"], bucket: string, target: string, r: Pick<OkResult, "uri" | "sha256" | "mime">): Promise<string> {
  const uri = toGsUri(bucket, target);
  if (r.uri === uri) return uri;
  const head = await storage.headObject(uri);
  if (head.exists && head.sha256 === r.sha256) return uri;
  return storage.uploadBuffer(target, (await storage.downloadBuffer(r.uri)).buf, r.mime, { sha256: r.sha256 });
}

function mergeSkus(skus: ResolveResult, extra: string[] | undefined): ResolveResult {
  if (!extra?.length) return skus;
  const ids = [...new Set([...skus.opptraSkuIds, ...extra])].sort();
  return { ...skus, opptraSkuIds: ids, method: skus.method === "unresolved" ? "manual" : skus.method };
}

/** Builder constant (spec 14d F7 part 2): photos one delivery places. At the measured 280 photos a minute, 800 take about 3 minutes, well inside the 900 s deadline. */
export const PLACE_BUDGET_ITEMS = 800;

/** One photo groupBatch decided, as placeBatch copies it and the last chunk writes its version row. */
interface PlannedShot {
  productId: string; n: number; sourceUri: string; sha256: string;
  target: string; rawUri: string; mime: string; width: number | null; height: number | null; size: number;
  flags: OutputFlag[]; originalName: string; uploadId: string;
}

/**
 * `derived/_ingest/place-state-<lease>.json` (spec 14d F7 part 2): what groupBatch decided, for the placing
 * deliveries that follow. `token` is the lease it was written under: a delivery with another token
 * never places from it.
 */
interface PlaceState {
  version: 1;
  token: string;
  shots: PlannedShot[];
  /** The preview state the last chunk writes for buildPreview (raw URIs are known before copying). */
  preview: PreviewState;
  counts: Partial<BatchCounts>;
  /** The inputs grouped, to tell at the end whether one was removed meanwhile (spec 14b F3). */
  uploadIds: string[];
  /** Set when the batch holds no photo: the closing write fails the batch with it. */
  failReason: string | null;
  waitingForColumn: boolean;
}

/**
 * The part of a working file's name that names the lease `token` it was written under (a hash: the token holds
 * the run and upload ids). Every run of the batch-wide step writes its own files, so a frozen delivery of an
 * earlier run that saves after a newer run claimed the lease never overwrites the newer run's (at-least-once
 * delivery, Try again).
 */
const leaseFileKey = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);
const placeStatePath = (prefix: string, token: string) => `${workPrefix(prefix)}/place-state-${leaseFileKey(token)}.json`;

/** A named continuation per (batch, lease, cursor), so a retried delivery never queues the next chunk twice (Cloud Tasks deduplicates task names). */
const placeTaskId = (batchId: string, token: string, cursor: number) => hashedTaskId("place", batchId, token, cursor);
/** The same for the grouping chunks (products from `cursor`). */
const groupTaskId = (batchId: string, token: string, cursor: number) => hashedTaskId("group", batchId, token, cursor);

type StepResult = { progress: IngestProgress; outcome: string };
type PlaceDeps = IngestDeps & { enqueue: typeof enqueueTask; placeBudgetItems?: number; productBudgetItems?: number };

/**
 * The batch's writes under the placing lease `token` (spec 14c F6): each applies only while the batch
 * is `ingesting` and the lease carries `token` (spec 14c F4 part 2). `placing` writes progress and
 * renews the lease; `close` is the closing write (lease and rate cleared). When one is refused the
 * step stops; if the batch was cancelled, the rows it wrote are removed again, so a cancelled batch
 * keeps no version rows.
 */
function leaseWrites(db: Db, deps: IngestDeps, batchId: string, token: string, attempt: string, mark: { next?: number; group?: number } = {}) {
  const clock = () => deps.now?.() ?? new Date();
  const held = and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "ingesting"), placingLeaseHeld(token, attempt));
  // Text reads (->>), so a missing key and a JSON null are both SQL NULL.
  const unchangedInputs = sql`(${catalogBatches.counts}->>'inputsChangedAt') IS NOT DISTINCT FROM (${catalogBatches.counts}->>'groupedChange')`;
  // The stage marks the claim carries, kept on every renewal so a retry of this delivery resumes it.
  const claim = (at: Date) => ({ ...placingClaim(token, at, attempt), ...(mark.next !== undefined ? { next: mark.next } : {}), ...(mark.group !== undefined ? { group: mark.group } : {}) });
  return {
    clock,
    /** Grouping progress: `grouped` (and `patch`) written, the lease renewed. False when refused. */
    grouping: async (patch: Partial<BatchCounts>, done: number): Promise<boolean> => {
      const at = clock();
      const rows = await db.update(catalogBatches)
        .set({ counts: progressCounts({ ...patch, grouped: done, placingClaim: claim(at) }, { phase: "grouping", done, at }) })
        .where(held).returning({ id: catalogBatches.id });
      return rows.length > 0;
    },
    /** Hands grouping on at product `end`: `grouped` and the claim's `group` written, this attempt released for the continuation. */
    continueGroup: async (end: number): Promise<boolean> => {
      const at = clock();
      const rows = await db.update(catalogBatches)
        .set({ counts: progressCounts({ grouped: end, placingClaim: { ...placingClaim(token, at, null), group: end } }, { phase: "grouping", done: end, at }) })
        .where(held).returning({ id: catalogBatches.id });
      return rows.length > 0;
    },
    placing: async (patch: Partial<BatchCounts>, done: number): Promise<boolean> => {
      const at = clock();
      const rows = await db.update(catalogBatches)
        .set({ counts: progressCounts({ ...patch, placingClaim: claim(at) }, { phase: "placing", done, at }) })
        .where(held).returning({ id: catalogBatches.id });
      return rows.length > 0;
    },
    /** Hands placing on at `end` (spec 14d F7 part 2): `placed` and `next` written, this attempt released for the continuation. */
    continueAt: async (end: number): Promise<boolean> => {
      const at = clock();
      const rows = await db.update(catalogBatches)
        .set({ counts: progressCounts({ placed: end, placingClaim: { ...placingClaim(token, at, null), next: end } }, { phase: "placing", done: end, at }) })
        .where(held).returning({ id: catalogBatches.id });
      return rows.length > 0;
    },
    close: async (patch: Partial<BatchCounts>, status: "draft" | "failed"): Promise<boolean> => {
      // M1 D24: not when an input changed since the claim (the marker is on this row, so a change that commits while
      // this write waits for the row lock is seen); the step then groups again (inputsChanged).
      const rows = await db.update(catalogBatches)
        .set({ status, counts: mergeCounts({ ...patch, placingClaim: null, rate: [] }) })
        .where(and(held, unchangedInputs)).returning({ id: catalogBatches.id });
      return rows.length > 0;
    },
    /**
     * M1 D24: an input changed since the claim: the lease is released and the preview stays not ready. The batch stays
     * collecting for a regroup, or goes back to draft when no input is left to group.
     */
    restart: async (status: "ingesting" | "draft"): Promise<boolean> => {
      const rows = await db.update(catalogBatches)
        .set({ status, counts: mergeCounts({ placingClaim: null, rate: [], previewReady: false, phase: null }) })
        .where(held).returning({ id: catalogBatches.id });
      return rows.length > 0;
    },
    stopped: async (): Promise<StepResult> => {
      const [now] = await db.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
      if (now?.status === "cancelled") {
        await removeDraftRows(db, batchId);
        return { progress: { done: 0, total: 0, phase: "done" }, outcome: "stopped: the batch was cancelled" };
      }
      return { progress: { done: 0, total: 0, phase: "done" }, outcome: "stopped: another delivery holds the placing lease" };
    },
  };
}

/**
 * Builder constant: products one grouping delivery finds or creates. A product is about 20 statements
 * (findOrCreateProduct's transaction, its aliases and the batch_products row) with no sku_map query, about
 * 50 ms on Cloud SQL, so 1,000 take about a minute, well inside the 900 s deadline.
 */
export const PRODUCT_BUDGET_ITEMS = 1000;
/**
 * Builder constant: after this long a grouping delivery starts no new product, saves what it decided and
 * hands on, so a slow database cannot push it past the request deadline. Well under the 10 minute stall
 * banner, so a live run never looks stopped.
 */
export const GROUP_TIME_BUDGET_MS = 180_000;

/** One grouped or rejected item with the result it was read with (null: not read). */
interface GroupItem { item: SourceItem; result: OkResult | null }

/**
 * `derived/_ingest/group-state-<lease>.json`: what the grouping delivery decided (the grouping after the overwrite
 * preview, the product list's facts, the inputs), for the chunks that find or create the products. `token`
 * is the lease it was written under: a delivery with another token never groups from it.
 */
interface GroupState {
  version: 1;
  token: string;
  products: { identifier: string; items: GroupItem[] }[];
  rejected: { item: GroupItem; reason: string }[];
  warnings: string[];
  /** The identifiers to find or create, in order: the grouped ones, then the product list rows without photos. */
  work: string[];
  eans: [string, string][];
  listSkuIds: [string, string[]][];
  statuses: [string, LinkStatus][];
  missing: string[];
  list: ProductListRow[] | null;
  byMatchColumn: boolean;
  duplicates: OverwritePreview["duplicates"];
  existing: { identifier: string; shotsToRemove: number }[];
  uploadIds: string[];
  topLevelFolders: string[];
  waitingForColumn: boolean;
  uploadErrors: string[];
  links: number;
  linkSource: string;
  /** M1-F1-R2: the roots of a per-root batch with their modes (absent otherwise, and on states saved before it). */
  roots?: StoredRoot[];
  /** Shots that came as several files with the same bytes (absent on states saved before it). */
  sameFiles?: SameFile[];
  /** What the uploads lost before grouping (absent on states saved before it). */
  uploadRejects?: UploadReject[];
}

/**
 * The stored roots (BatchCounts.roots) of a per-root grouping: a folder by its name, an upload by its
 * name, a sheet with the column its identifier came from (`column E (Option Id)`).
 */
export function storedRoots(roots: InputRoot[], uploads: CatalogUpload[], options: BatchOptions): StoredRoot[] {
  const sheetCount = uploads.filter((u) => u.kind === "sheet" || u.kind === "google_sheet").length;
  return roots.map((r) => {
    const upload = r.uploadId ? uploads.find((u) => u.id === r.uploadId) : undefined;
    const d = (upload?.detected as Detected | null | undefined) ?? null;
    const name = r.folder ?? d?.title ?? upload?.name ?? "";
    // A Supabase folder paste names its products by folder or file name, as it was listed (supabase-folder.ts).
    if (d?.supabaseFolder) return { kind: r.kind, name, mode: d.supabaseFolder.mode };
    if (r.mode !== "sheet_column") return { kind: r.kind, name, mode: r.mode };
    const column = options.sheetColumns && sheetCount === 1 ? options.sheetColumns.identifier : d?.identifierColumn ?? -1;
    const header = column >= 0 ? (d?.columns?.[column] ?? "").trim() : "";
    return { kind: r.kind, name, mode: r.mode, column: column >= 0 ? `column ${columnLetter(column)}${header ? ` (${header})` : ""}` : null };
  });
}

interface ProductEntry { id: string; pathKey: string; isNew: boolean; skuIds: string[]; resolved: boolean }

/** `derived/_ingest/group-products-<lease>-<n>.json`: what the chunks decided before product n (Maps as entries, in order). */
interface GroupProgress {
  version: 1;
  token: string;
  productOf: [string, ProductEntry][];
  used: [string, string][];
  givenUp: string[];
  /** Identifiers left out, with their sentence, in the order they were left out. */
  refused: [string, string][];
  /** Same-product pairs the chunks found (the overwrite preview's own are in GroupState). */
  duplicates: OverwritePreview["duplicates"];
}

const groupStatePath = (prefix: string, token: string) => `${workPrefix(prefix)}/group-state-${leaseFileKey(token)}.json`;
const groupProgressPath = (prefix: string, token: string, cursor: number) => `${workPrefix(prefix)}/group-products-${leaseFileKey(token)}-${cursor}.json`;

/**
 * The first part of the batch-wide step, run by the holder of the placing lease: removes what an earlier
 * run wrote, assembles, matches (one sku_map read for the whole batch) and builds the overwrite preview,
 * saves that to its `group-state-<lease>.json`, then finds or creates the products in budgeted chunks (groupProducts),
 * the first in this delivery.
 */
async function groupBatch(db: Db, deps: PlaceDeps, batchId: string, token: string, attempt: string, body: DeliveryBody): Promise<StepResult> {
  const lease = leaseWrites(db, deps, batchId, token, attempt);
  const startedAt = lease.clock().getTime();
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error(`Batch ${batchId} does not exist.`);
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  if (batch.status !== "ingesting") return lease.stopped();
  // A removed upload (spec 14b F3) is not an input: its photos, sheets and errors are left out.
  const uploads = await db.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, batchId), ne(catalogUploads.status, "removed")));
  await removeDraftRows(db, batch.id);

  const manifests = new Map<string, UploadManifest>();
  for (const u of uploads) {
    if (u.status !== "collected") continue;
    const m = await loadJson<UploadManifest>(deps, manifestPath(prefix, u.id));
    if (m) manifests.set(u.id, m);
  }
  const listRejects: UploadReject[] = [];
  const lists = await readLists(uploads, manifests, deps, prefix, batch.options, listRejects);
  const a = assemble([...manifests.values()], lists, batch.options, listRejects);
  const { grouped } = a;

  // Matching and the overwrite preview come first: duplicate spellings leave the grouping here. Every
  // product's SKUs come from one read of the brand's sku_map rows.
  const resolver = await loadSkuResolver(db, batch.brandSlug);
  const ids = [...grouped.products.keys()];
  const matches = await matchProducts(db, batch, ids, a.eans, resolver);
  const overwrite = await buildOverwritePreview(db, batch, grouped, matches, a.sha256ByItem, { otherBatches: false });

  const withResult = (item: SourceItem): GroupItem => ({ item, result: a.resultOf(item) ?? null });
  const linkUploads = uploads.filter((u) => manifests.get(u.id)?.items.some((i) => i.bytes.kind === "url"));
  const state: GroupState = {
    version: 1, token,
    products: [...grouped.products].map(([identifier, items]) => ({ identifier, items: items.map(withResult) })),
    rejected: grouped.rejected.map((r) => ({ item: withResult(r.item), reason: r.reason })),
    warnings: grouped.warnings,
    work: [...grouped.products.keys(), ...a.missing],
    eans: [...a.eans], listSkuIds: [...a.listSkuIds], statuses: [...a.statuses], missing: a.missing,
    list: a.list, byMatchColumn: a.byMatchColumn, duplicates: [...overwrite.duplicates],
    existing: overwrite.existingProducts.map((p) => ({ identifier: p.identifier, shotsToRemove: p.shotsToRemove.length })),
    uploadIds: uploads.map((u) => u.id),
    topLevelFolders: [...new Set(uploads.flatMap((u) => ((u.detected as Detected | null)?.topLevelFolders ?? [])))].sort(byText),
    waitingForColumn: uploads.some((u) => (u.detected as Detected | null)?.cannotRead),
    uploadErrors: uploads.filter((u) => u.status === "failed" && u.error).map((u) => u.error!),
    links: linkUploads.reduce((n, u) => n + manifests.get(u.id)!.items.filter((i) => i.bytes.kind === "url").length, 0),
    linkSource: linkSourceWords(linkUploads),
    ...(grouped.roots ? { roots: storedRoots(grouped.roots, uploads, batch.options) } : {}),
    ...(grouped.sameFiles ? { sameFiles: grouped.sameFiles } : {}),
    ...(a.uploadRejects.length ? { uploadRejects: a.uploadRejects } : {}),
  };
  await saveJson(deps, groupStatePath(prefix, token), state);
  if (!(await lease.grouping({ groupTotal: state.work.length }, 0))) return lease.stopped();
  return groupProducts(db, deps, batchId, token, attempt, 0, body, startedAt, { state, resolver });
}

/**
 * The products part of the batch-wide step: finds or creates the products of its `group-state-<lease>.json` from
 * `cursor`, at most PRODUCT_BUDGET_ITEMS (deps.productBudgetItems overrides it) and for at most
 * GROUP_TIME_BUDGET_MS from `startedAt`, writing `grouped` about every RATE_SAMPLE_GAP_MS (each write
 * renews the lease and stops the chunk when the batch was cancelled or the lease lost). While products
 * remain it saves what it decided to `group-products-<lease>-<end>.json` and hands on with a named task; the chunk
 * that finds the last one plans the shot list and starts placing. A retried chunk starts again from the
 * same saved state, and every product write is idempotent (findOrCreateProduct, onConflictDoNothing).
 * `inline` is the grouping delivery's own state, so its first chunk reads nothing back.
 */
async function groupProducts(
  db: Db, deps: PlaceDeps, batchId: string, token: string, attempt: string, cursor: number, body: DeliveryBody, startedAt: number,
  inline?: { state: GroupState; resolver: SkuResolver },
): Promise<StepResult> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error(`Batch ${batchId} does not exist.`);
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  // The grouping delivery's claim has no `group`; a continuation's carries its own cursor.
  const lease = leaseWrites(db, deps, batchId, token, attempt, inline ? {} : { group: cursor });
  if (batch.status !== "ingesting") return lease.stopped();
  const state = inline?.state ?? (await loadJson<GroupState>(deps, groupStatePath(prefix, token)));
  // A later run regrouped the batch under another lease: its own deliveries go on from its state.
  if (!state || state.token !== token) return lease.stopped();
  const saved = cursor > 0 ? await loadJson<GroupProgress>(deps, groupProgressPath(prefix, token, cursor)) : null;
  if (cursor > 0 && (!saved || saved.token !== token)) throw new Error(`The grouping of batch ${batchId} has no saved state at product ${cursor}.`);
  const resolver = inline?.resolver ?? (await loadSkuResolver(db, batch.brandSlug));

  // The grouping as the grouping delivery left it, with the identifiers earlier chunks left out applied.
  const resultOf = new Map<SourceItem, OkResult | null>();
  const restore = (g: GroupItem) => {
    resultOf.set(g.item, g.result);
    return g.item;
  };
  const grouped: GroupingResult = {
    products: new Map(state.products.map((p) => [p.identifier, p.items.map(restore)])),
    rejected: state.rejected.map((r) => ({ item: restore(r.item), reason: r.reason })),
    warnings: state.warnings,
  };
  const productOf = new Map<string, ProductEntry>(saved?.productOf ?? []);
  const used = new Map<string, string>(saved?.used ?? []);
  const givenUp = new Set<string>(saved?.givenUp ?? []);
  const refused: [string, string][] = [...(saved?.refused ?? [])];
  const found2: OverwritePreview["duplicates"] = [...(saved?.duplicates ?? [])];
  const leaveOut = (id: string, reason: string) => {
    for (const item of grouped.products.get(id) ?? []) grouped.rejected.push({ item, reason });
    grouped.products.delete(id);
  };
  for (const [id, reason] of refused) leaveOut(id, reason);
  const refuse = (id: string, reason: string) => {
    leaveOut(id, reason);
    refused.push([id, reason]);
  };
  const eans = new Map(state.eans);
  const listSkuIds = new Map(state.listSkuIds);
  const uploadAt = batch.options.newestSameProduct !== false ? await uploadTimes(db, batch.id) : null;
  const statuses = new Map(state.statuses);
  // A retried chunk finds the products its first try created as existing: the batch's own `new` rows say
  // which were. The grouping delivery's first chunk starts right after removeDraftRows, so it has none.
  const createdHere = inline
    ? new Set<string>()
    : new Set((await db.select({ productId: catalogBatchProducts.productId }).from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, batch.id), eq(catalogBatchProducts.change, "new")))).map((r) => r.productId));

  // Products for what is left, then for the product list rows without photos. Each product's
  // catalog_batch_products row is written as soon as the product is found or created, so a retry
  // after a failure part-way through still knows (removeDraftRows) which products this batch created.
  const total = state.work.length;
  const budget = Math.max(1, deps.productBudgetItems ?? PRODUCT_BUDGET_ITEMS);
  const overTime = () => lease.clock().getTime() - startedAt >= GROUP_TIME_BUDGET_MS;
  let lastWrite = lease.clock().getTime();
  const start = Math.min(Math.max(0, Math.floor(cursor) || 0), total);
  let end = start;
  while (end < total && end - start < budget && !(end > start && overTime())) {
    const id = state.work[end]!;
    end++;
    const skus = mergeSkus(resolver.resolve({ identifier: id, ean: eans.get(id) ?? null }), listSkuIds.get(id));
    let found: Awaited<ReturnType<typeof findOrCreateProduct>>;
    try {
      found = await findOrCreateProduct(db, { brandSlug: batch.brandSlug, isTest: batch.isTest, identifier: id, skus, productType: batch.productType, actor: batch.createdBy });
    } catch (err) {
      if (!(err instanceof Error) || !isProductRefusal(err.message)) throw err;
      refuse(id, err.message);
      continue;
    }
    const isNew = found.isNew || createdHere.has(found.product.id);
    const hasPhotos = grouped.products.has(id);
    const other = used.get(found.product.id);
    // A product list row that names a product already in the batch under another spelling adds nothing.
    if (other !== undefined && !hasPhotos) continue;
    if (other !== undefined && uploadAt) {
      // M1-F2-R7: from different uploads, the newest upload's spelling keeps the product (one product row either way).
      const newest = newestIdentifier([other, id], (k) => grouped.products.get(k) ?? [], uploadAt);
      const first = productOf.get(other);
      if (newest === other) { refuse(id, olderSameProductMessage(id, other)); continue; }
      if (newest === id && first) {
        refuse(other, olderSameProductMessage(other, id));
        productOf.delete(other);
        used.set(found.product.id, id);
        productOf.set(id, first);
        continue;
      }
    }
    if (other !== undefined) {
      // Two identifiers that only became one product here (for example through the same option id):
      // both are left out, as buildOverwritePreview leaves out the ones it finds.
      const [x, y] = [other, id].sort(byText);
      found2.push({ a: x!, b: y! });
      const sentence = sameProductMessage([x!, y!]);
      refuse(id, sentence);
      const first = productOf.get(other);
      if (first) {
        refuse(other, sentence);
        productOf.delete(other);
        // A product this run created keeps its `new` row until the last chunk removes it with the product, so a
        // retry of a chunk that crashed after this point still knows the run created it (removeDraftRows, createdHere).
        if (first.isNew) givenUp.add(first.id);
        else await db.delete(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, batch.id), eq(catalogBatchProducts.productId, first.id)));
      }
      continue;
    }
    used.set(found.product.id, id);
    productOf.set(id, {
      id: found.product.id, pathKey: found.product.pathKey, isNew,
      skuIds: found.product.opptraSkuIds ?? [], resolved: skus.method !== "unresolved",
    });
    const linkStatus: LinkStatus = hasPhotos ? (statuses.get(id) ?? "ok") : "missing_images";
    const change: ChangeKind = isNew ? "new" : hasPhotos ? "updated" : "unchanged";
    await db.insert(catalogBatchProducts).values({ batchId: batch.id, productId: found.product.id, linkStatus, change }).onConflictDoNothing();
    // Progress and the lease about every RATE_SAMPLE_GAP_MS; a refused write (cancelled, or the lease lost) stops here.
    if (lease.clock().getTime() - lastWrite >= RATE_SAMPLE_GAP_MS) {
      lastWrite = lease.clock().getTime();
      if (!(await lease.grouping({}, end))) return lease.stopped();
    }
  }

  if (end < total) {
    const progress: GroupProgress = { version: 1, token, productOf: [...productOf], used: [...used], givenUp: [...givenUp], refused, duplicates: found2 };
    await saveJson(deps, groupProgressPath(prefix, token, end), progress);
    if (!(await lease.continueGroup(end))) return lease.stopped();
    await deps.enqueue(INGEST_ROUTE, handOnBody(body, { group: String(end) }), { taskId: groupTaskId(batchId, token, end) });
    return { progress: { done: end, total, phase: "grouping" }, outcome: `grouped ${end} of ${total} products; continuing at ${end}` };
  }

  // A product this run created for a spelling it then left out is removed again, with its batch row.
  for (let i = 0; i < givenUp.size; i += 1000) {
    const part = [...givenUp].slice(i, i + 1000);
    await db.delete(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, batch.id), inArray(catalogBatchProducts.productId, part)));
  }
  await deleteUnusedProducts(db, [...givenUp]);

  const withPhotos = [...grouped.products.keys()].filter((id) => productOf.has(id));
  const missing = state.missing.filter((id) => productOf.has(id) && !grouped.products.has(id));

  // The shot list: one per (product, n). Raw URIs are known before copying (placeRaw writes `target`).
  const bucket = getBucketName();
  const rawUriOf = new Map<SourceItem, string>();
  const shots: PlannedShot[] = [];
  // M1 D30: a follow-up batch only adds photos: its shot numbers are given out by allocateShots (after every shot the
  // product has or another batch holds, under the product row lock), for new products too (two follow-ups can make one).
  const allocated = batch.options.append
    ? await allocateShots(db, batch.id, withPhotos.map((id) => ({ productId: productOf.get(id)!.id, count: shotRanks(grouped.products.get(id)!) })))
    : null;
  for (const id of withPhotos) {
    const product = productOf.get(id)!;
    const items = grouped.products.get(id)!;
    const numberOf = shotNumbers(items, allocated ? allocated.get(product.id)! : null);
    for (const item of items) {
      const r = resultOf.get(item);
      if (!r) continue;
      const n = numberOf.get(item)!;
      const target = rawPath(prefix, product.pathKey, n, r.ext);
      const rawUri = toGsUri(bucket, target);
      rawUriOf.set(item, rawUri);
      shots.push({
        productId: product.id, n, sourceUri: r.uri, sha256: r.sha256, target, rawUri, mime: r.mime,
        width: r.width, height: r.height, size: r.size, flags: [...new Set([...r.flags, ...shotFlags(item)])],
        originalName: item.originalName, uploadId: item.uploadId,
      });
    }
  }

  // The preview state buildPreview reads, and the counts, written by the last placing delivery.
  const stored = (item: SourceItem): StoredItem => {
    const r = resultOf.get(item);
    return { item, sha256: r?.sha256 ?? null, width: r?.width ?? null, height: r?.height ?? null, rawUri: rawUriOf.get(item) ?? null };
  };
  const skus = [...withPhotos, ...missing].map((id) => [id, productOf.get(id)!.skuIds] as [string, string[]]);
  const preview: PreviewState = {
    version: 1,
    products: withPhotos.map((id) => ({ identifier: id, productId: productOf.get(id)!.id, items: grouped.products.get(id)!.map(stored) })),
    rejected: grouped.rejected.map((r) => ({ item: stored(r.item), reason: r.reason })),
    warnings: grouped.warnings, missing, list: state.list, byMatchColumn: state.byMatchColumn,
    duplicates: [...state.duplicates, ...found2], skus, topLevelFolders: state.topLevelFolders,
    ...(state.sameFiles ? { sameFiles: state.sameFiles } : {}),
    ...(state.uploadRejects ? { uploadRejects: state.uploadRejects } : {}),
  };
  const newCount = withPhotos.filter((id) => productOf.get(id)!.isNew).length;
  const existing = state.existing.filter((p) => productOf.has(p.identifier));
  const rejects = grouped.rejected.filter((r) => !isSameProductReject(r.reason));
  // Links that could not be downloaded are counted on their own, not as unsupported files (spec 14b F5).
  const linkRejects = rejects.filter((r) => isLinkReject(r.reason));
  const leftOut = leftOutProducts(ledgerRows(grouped.rejected, state.uploadRejects ?? []), grouped.products.keys());
  const counts: Partial<BatchCounts> = {
    products: withPhotos.length, sources: shots.length,
    skuResolved: [...withPhotos, ...missing].filter((id) => productOf.get(id)!.resolved || productOf.get(id)!.skuIds.length > 0).length,
    missingImages: missing.length, notInSheet: withPhotos.filter((id) => statuses.get(id) === "not_in_sheet").length,
    unsupportedFiles: rejects.filter((r) => !isDuplicateReject(r.reason) && !isLinkReject(r.reason)).length,
    linkFailures: linkRejects.length,
    duplicateFiles: rejects.filter((r) => isDuplicateReject(r.reason)).length,
    // Every product left out, whatever the reason: read by the batch page and the outcome, so "All N products" stays true.
    productsLeftOut: leftOut.length,
    newProducts: newCount, existingProducts: withPhotos.length - newCount,
    shotsToRemove: existing.reduce((s, p) => s + p.shotsToRemove, 0),
    previewReady: true, failReason: null,
    ...(state.roots ? { roots: state.roots } : {}),
  };
  let failReason: string | null = null;
  if (!shots.length && !state.waitingForColumn) {
    // Photos that clash or are badly named were found: that is what the batch says, not "no photos".
    const named = leftOut.filter((l) => l.why !== "links" && l.why !== "unreadable");
    failReason = named.length
      ? `${leftOut.length === 1 ? "The product" : `None of the ${fmt(leftOut.length)} products`} could ${leftOut.length === 1 ? "not " : ""}be used: ${distinct(leftOut.map((l) => LEFT_OUT_WORDS[l.why].text)).join("; ")}. Fix the files and start again.`
      : noPhotosReason(grouped.rejected, state.uploadErrors, state.links ? { links: state.links, source: state.linkSource } : undefined);
  }
  const place: PlaceState = { version: 1, token, shots, preview, counts, uploadIds: state.uploadIds, failReason, waitingForColumn: state.waitingForColumn };
  await saveJson(deps, placeStatePath(prefix, token), place);
  // Out of time: placing starts in its own delivery, so this one ends well inside its deadline.
  if (overTime()) {
    if (!(await lease.grouping({ placeTotal: shots.length, placed: 0 }, end))) return lease.stopped();
    if (!(await lease.continueAt(0))) return lease.stopped();
    await deps.enqueue(INGEST_ROUTE, handOnBody(body, { place: "0" }), { taskId: placeTaskId(batchId, token, 0) });
    return { progress: { done: 0, total: shots.length, phase: "copying" }, outcome: `grouped ${total} products; placing continues at 0` };
  }
  if (!(await lease.placing({ placeTotal: shots.length, placed: 0 }, 0))) return lease.stopped();
  return placeBatch(db, deps, batchId, token, attempt, 0, body, place, inline ? undefined : cursor);
}

/**
 * The second half of the batch-wide step (spec 14d F7 part 2): copies the next PLACE_BUDGET_ITEMS
 * photos of its `place-state-<lease>.json` from `cursor` with the sha256 skip of placeRaw, writing `placed` (at
 * most every RATE_SAMPLE_GAP_MS during the chunk and once after it, each renewing the lease), then
 * re-enqueues itself with the next cursor under the same lease token. The delivery that places the
 * last chunk inserts the version rows, writes `preview-state.json` and makes the closing write.
 * `deps.placeBudgetItems` (optional) overrides the chunk size.
 */
async function placeBatch(db: Db, deps: PlaceDeps, batchId: string, token: string, attempt: string, cursor: number, body: DeliveryBody, planned?: PlaceState, groupMark?: number): Promise<StepResult> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error(`Batch ${batchId} does not exist.`);
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest);
  // The first chunk runs in the delivery that found the last product, whose claim has no `next` yet (and
  // keeps that delivery's `group`, so its retry resumes it).
  const lease = leaseWrites(db, deps, batchId, token, attempt, planned ? (groupMark !== undefined ? { group: groupMark } : {}) : { next: cursor });
  if (batch.status !== "ingesting") return lease.stopped();
  const state = planned ?? (await loadJson<PlaceState>(deps, placeStatePath(prefix, token)));
  // A later run regrouped the batch under another lease: its own deliveries place from its state.
  if (!state || state.token !== token) return lease.stopped();

  const total = state.shots.length;
  const start = Math.min(Math.max(0, Math.floor(cursor) || 0), total);
  const end = Math.min(total, start + Math.max(1, deps.placeBudgetItems ?? PLACE_BUDGET_ITEMS));
  const bucket = getBucketName();
  let placed = start, lastWrite = lease.clock().getTime(), writing = false, refused = false;
  await mapLimit(state.shots.slice(start, end), COPY_CONCURRENCY, async (shot) => {
    if (refused) return;
    await placeRaw(deps.storage, bucket, shot.target, { uri: shot.sourceUri, sha256: shot.sha256, mime: shot.mime });
    placed++;
    // `placed` and a rate sample at most every RATE_SAMPLE_GAP_MS (this also renews the lease and keeps
    // updated_at moving, so a long placing never looks stalled); a refused write stops the placing.
    if (!writing && lease.clock().getTime() - lastWrite >= RATE_SAMPLE_GAP_MS) {
      writing = true;
      lastWrite = lease.clock().getTime();
      try {
        if (!(await lease.placing({ placed }, placed))) refused = true;
      } finally {
        writing = false;
      }
    }
  });
  // Still ours and still collecting after the chunk (the hand-off, or the progress write before any version row is written).
  if (refused) return lease.stopped();
  if (end < total) {
    if (!(await lease.continueAt(end))) return lease.stopped();
    await deps.enqueue(INGEST_ROUTE, handOnBody(body, { place: String(end) }), { taskId: placeTaskId(batchId, token, end) });
    return { progress: { done: end, total, phase: "copying" }, outcome: `placed ${end} of ${total}; continuing at ${end}` };
  }

  if (!(await lease.placing({ placed: end }, end))) return lease.stopped();

  // The last chunk. Version rows: one per (product, n), not current, replacing the current row of that shot.
  const productIds = [...new Set(state.shots.map((s) => s.productId))];
  const current = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += 1000) {
    const part = productIds.slice(i, i + 1000);
    const cur = await db
      .select({ id: catalogSourceImages.id, productId: catalogSourceImages.productId, n: catalogSourceImages.n })
      .from(catalogSourceImages)
      .where(and(inArray(catalogSourceImages.productId, part), eq(catalogSourceImages.isCurrent, true)));
    for (const c of cur) current.set(`${c.productId}:${c.n}`, c.id);
  }
  const versions = state.shots.map((s) => ({
    productId: s.productId, batchId: batch.id, n: s.n, sha256: s.sha256, isCurrent: false, replacesId: current.get(`${s.productId}:${s.n}`) ?? null,
    originalName: s.originalName, uploadId: s.uploadId, rawUri: s.rawUri, mime: s.mime, width: s.width, height: s.height, bytes: s.size,
    flags: s.flags, status: "prepared" as const,
  }));
  for (let i = 0; i < versions.length; i += 500) {
    await db.insert(catalogSourceImages).values(versions.slice(i, i + 500)).onConflictDoNothing();
  }
  // M0-F2-R1: every accepted photo is an asset and a brand version of the product's option (null until M0-S2 links it).
  const optionOf = new Map<string, string | null>();
  for (let i = 0; i < productIds.length; i += 1000) {
    for (const p of await db.select({ id: catalogProducts.id, optionId: catalogProducts.optionId }).from(catalogProducts).where(inArray(catalogProducts.id, productIds.slice(i, i + 1000)))) optionOf.set(p.id, p.optionId);
  }
  await recordSourcePhotoVersions(db, versions.map((v) => ({ ...v, optionId: optionOf.get(v.productId) ?? null, isTest: batch.isTest })));
  await saveJson(deps, statePath(prefix), state.preview);

  // An input removed or changed while this ran (spec 14b F3, M1 D24) makes this result out of date: the step groups
  // again with the inputs as they are now (inputsChanged), never two steps at once and never with a removed input.
  const removedSince = state.uploadIds.length ? await db.select({ id: catalogUploads.id }).from(catalogUploads).where(and(inArray(catalogUploads.id, state.uploadIds), eq(catalogUploads.status, "removed"))) : [];
  if (removedSince.length) return inputsChanged(db, deps, batchId, lease, body);
  if (state.failReason) {
    if (!(await lease.close({ ...state.counts, failReason: state.failReason, phase: null, placed: total }, "failed"))) return (await changedSinceClaim(db, batchId, token)) ? inputsChanged(db, deps, batchId, lease, body) : lease.stopped();
    // An operator upload with nothing usable: WARNING, so it sends no alert and stays out of Error Reporting.
    log("WARNING", "batch failed", { batchId: batch.id, brandSlug: batch.brandSlug, reason: state.failReason, cause: "no_photos" });
    return { progress: { done: 0, total: 0, phase: "done" }, outcome: "failed: no photos" };
  }
  if (!(await lease.close({ ...state.counts, phase: state.waitingForColumn ? "needs_input" : "ready", placed: total }, "draft"))) return (await changedSinceClaim(db, batchId, token)) ? inputsChanged(db, deps, batchId, lease, body) : lease.stopped();
  // M1-F2-R6: a batch made with autoStart starts by itself after its countdown (a sheet still waiting for its column
  // does not). The batch is collected either way, so a failure to arm only leaves its Start button.
  if (!state.waitingForColumn) {
    await armAutoStart(db, deps.enqueue, batchId).catch((err: unknown) => log("WARNING", "auto-start not armed", { batchId, error: err instanceof Error ? err.message : String(err) }));
  }
  return {
    progress: { done: versions.length, total: versions.length, phase: "done" },
    outcome: `preview ready: ${state.preview.products.length} products, ${versions.length} photos`,
  };
}

/** M1 D24: the lease `token` is still this batch's and an input changed since its claim (the closing write was refused for it). */
async function changedSinceClaim(db: Db, batchId: string, token: string): Promise<boolean> {
  const [b] = await db.select({ status: catalogBatches.status, counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  return b?.status === "ingesting" && b.counts.placingClaim?.token === token && (b.counts.inputsChangedAt ?? null) !== (b.counts.groupedChange ?? null);
}

/**
 * M1 D24 (review P1-1): an input was removed, added or corrected while the batch-wide step ran. Its result is out of
 * date, so it is not closed: the lease is released and one delivery of a read upload is queued under the batch's
 * current run, whose claim groups again from scratch (groupBatch first removes the rows this step wrote). While an
 * upload is still being read, that claim is refused (uploads left) and the upload's own last delivery claims instead.
 */
async function inputsChanged(db: Db, deps: PlaceDeps, batchId: string, lease: { restart(status: "ingesting" | "draft"): Promise<boolean>; stopped(): Promise<StepResult> }, body: DeliveryBody): Promise<StepResult> {
  // A read upload's delivery claims again; an upload still being read claims at its own last delivery; with no input
  // left at all there is nothing to group, and the batch goes back to draft (its page asks for photos).
  const [read] = await db.select({ id: catalogUploads.id }).from(catalogUploads)
    .where(and(eq(catalogUploads.batchId, batchId), inArray(catalogUploads.status, ["collected", "failed"]))).orderBy(catalogUploads.id).limit(1);
  const [anyLive] = read ? [read] : await db.select({ id: catalogUploads.id }).from(catalogUploads)
    .where(and(eq(catalogUploads.batchId, batchId), ne(catalogUploads.status, "removed"))).limit(1);
  if (!(await lease.restart(anyLive ? "ingesting" : "draft"))) return lease.stopped();
  const [b] = await db.select({ counts: catalogBatches.counts }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const run = b?.counts.ingestRun ?? body.run;
  if (read) await deps.enqueue(INGEST_ROUTE, { batchId, uploadId: read.id, ...(run ? { run } : {}) }, { taskId: hashedTaskId("regroup", batchId, randomUUID()) });
  log("INFO", "inputs changed while grouping: grouping again", { batchId, regroup: !!read, inputsLeft: !!anyLive });
  return { progress: { done: 0, total: 0, phase: "done" }, outcome: "stale: an input changed; grouping again" };
}

/** counts.failReason when an ingest task used its last attempt (the batch then shows "Fix and continue"). */
export const INGEST_STOPPED_TEXT = "Collecting stopped part way after several tries. Press Fix and continue, then Continue to try again.";

/**
 * Marks a collecting batch failed with INGEST_STOPPED_TEXT, for an ingest task that failed on its last
 * attempt: Cloud Tasks drops it, so nothing else would move the batch on. The lease and phase are cleared;
 * rows an unfinished grouping wrote are removed by the next run's groupBatch. Only an `ingesting` batch
 * changes (a cancelled one stays cancelled), and only for a task of the current run: the delivery holds the
 * placing lease (its token), or no lease is held yet and its run is the newest hand-off's (`ingestRun`; a batch
 * handed off before that key existed has none, and any task counts). A task of an earlier run that still retries
 * after Try again started another changes nothing. True when it changed.
 */
export async function failStoppedIngest(db: Db, batchId: string, delivery: Pick<DeliveryBody, "uploadId" | "cursor" | "run">): Promise<boolean> {
  const claim = sql`${catalogBatches.counts}->'placingClaim'`;
  const newest = sql`${catalogBatches.counts}->>'ingestRun'`;
  const ofRun = delivery.run !== undefined ? sql`(${newest} IS NULL OR ${newest} = ${delivery.run}::text)` : sql`${newest} IS NULL`;
  const current = sql`((${claim}->>'token') = ${deliveryToken(delivery)}::text OR (COALESCE(jsonb_typeof(${claim}), 'null') = 'null' AND ${ofRun}))`;
  const rows = await db
    .update(catalogBatches)
    .set({ status: "failed", counts: mergeCounts({ failReason: INGEST_STOPPED_TEXT, placingClaim: null, phase: null, rate: [], previewReady: false }) })
    .where(and(eq(catalogBatches.id, batchId), eq(catalogBatches.status, "ingesting"), current))
    .returning({ id: catalogBatches.id });
  return rows.length > 0;
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
    const staged: StagedWrites = new Map();
    const distinct = firstPerKey(m.items, [...m.items.keys()]).map((i) => m.items[i]!);
    let done = 0;
    await mapLimit(distinct, ITEM_CONCURRENCY, async (item) => {
      m.results[itemKey(item)] = await readItem(item, deps, { prefix, uploadId: upload.id, zips, staged });
      input.onProgress?.(++done, distinct.length);
    });
    pushAll(rejected, listing.detected.rejected ?? []);
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
