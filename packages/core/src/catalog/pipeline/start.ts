// Start a draft batch: lock its products, write its chunk rows and queue the first window. Shared by the web's Start
// button (apps/web/lib/catalog/start.ts) and the worker's auto-start after the countdown (M1-F2-R6, auto-start.ts).
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, catalogUploads, type CatalogBatch } from "../../db/schema";
import { lockProducts } from "../products";
import { planChunks } from "./plan-chunks";
import { buildPreview } from "../ingest/index";
import type { IngestDeps } from "../ingest/types";
import type { enqueueTask } from "../../tasks";
import { chunkImages, dispatchChunks, recoverBatchChunks } from "./dispatch";
import { startedBatchOptions } from "./enlargement";
import { failedBeforeStart } from "./status";
import { mergeCounts } from "../counts";
import { log } from "../../log";
import type { BatchStatus } from "../types";
import { armAutoStart, AUTO_START_BUSY_WARN_MS, busyRetryDelaySec, type AutoStartBody } from "../auto-start";

/** A refusal with the HTTP status the web answers with; the worker's auto-start reads `kind`. */
export class StartRefused extends Error {
  constructor(public status: number, message: string, public kind: "stale" | "busy" | "not_draft" | "no_photos" | "held" | "invalid" = "invalid") {
    super(message);
    this.name = "StartRefused";
  }
}

export const STALE_PREVIEW = "Files changed since you last looked. Check what we found again, then press Start.";
export const STARTED_TEXT = "This batch has already started. Open its progress page.";
/** The auto-start task's refusal when Wait came first (M1-F2-R6); the page then shows its Start button. */
export const AUTO_START_HELD = "Auto-start was turned off with Wait. Press Start when you are ready.";
// The refusals of a change that needs a draft, by status (spec 14c F8; parent copy register "assertDraft").
export const BATCH_STARTED = "This batch has already started. Make a new batch to add more photos.";
export const BATCH_COULD_NOT_START = "This batch could not start. Press Fix and continue to change its photos or links.";
export const BATCH_STILL_COLLECTING = "This batch is still collecting. Wait for it to finish, or press Try again if nothing has moved for 10 minutes.";
export const BATCH_CANCELLED = "This batch was cancelled. Make a new batch.";
/** The sentence for a batch that is not a draft: what happened to it and what to do now. */
export function notDraftText(batch: { status: BatchStatus; startedAt: Date | string | null }): string {
  if (failedBeforeStart(batch)) return BATCH_COULD_NOT_START;
  if (batch.status === "ingesting") return BATCH_STILL_COLLECTING;
  if (batch.status === "cancelled") return BATCH_CANCELLED;
  return BATCH_STARTED;
}
/** Products locked by another running batch: the first one, its batch and how many more. */
export function busyText(busy: { identifier: string; batchName: string }[]): string {
  const first = busy[0]!;
  return `${first.identifier}${busy.length > 1 ? ` and ${busy.length - 1} others are` : " is"} still being processed in batch ${first.batchName}. Wait for it to finish or remove them from this upload.`;
}

/** Chunk rows per insert at Start (7 bind parameters per row, Postgres allows 65,535). */
const START_INSERT_ROWS = 1000;

export interface StartDeps {
  storage: IngestDeps["storage"];
  enqueue: typeof enqueueTask;
}

/**
 * Start the draft `id` as it was at `previewAt` (ISO): refuses (StartRefused) a batch that is not a draft, has no
 * channels, changed after `previewAt`, has no photos (and marks it failed) or whose products another running batch
 * holds. A batch already running gets the sweep's recovery instead (spec 15 E4).
 * `autoStart`: the auto-start task's countdown. The batch then starts only while auto-start is still on and that
 * countdown is still the batch's, checked first and again under the batch row lock (Wait takes the same lock).
 */
export async function startDraftBatch(db: Db, deps: StartDeps, id: string, previewAt: string, autoStart?: { at: string }): Promise<{ id: string; status: string }> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!batch) throw new StartRefused(404, "This batch does not exist. Open the batch list and choose another.", "not_draft");
  const held = (b: CatalogBatch) => !!autoStart && b.status === "draft" && (b.options.autoStart !== true || b.counts.autoStartAt !== autoStart.at);
  if (held(batch)) throw new StartRefused(409, AUTO_START_HELD, "held");
  if (batch.status === "failed" && batch.counts.failReason?.startsWith("No photos were found")) throw new StartRefused(400, batch.counts.failReason, "no_photos");
  if (["matting", "rendering", "publishing"].includes(batch.status)) {
    // Spec 15 E4: a second press runs the sweep's rules for this batch (recover dead chunks, top up the window)
    // instead of queueing every queued chunk again.
    await recoverBatchChunks(db, deps.enqueue, id);
    return { id, status: batch.status };
  }
  // A collecting, cancelled or failed-before-Start batch gets its own sentence (spec 14c F8).
  if (batch.status !== "draft") throw new StartRefused(409, batch.startedAt ? STARTED_TEXT : notDraftText(batch), "not_draft");
  if (!batch.channels.length) throw new StartRefused(400, "Choose at least one marketplace before starting.");
  if (!batch.counts.previewReady || batch.updatedAt.getTime() > Date.parse(previewAt)) throw new StartRefused(409, STALE_PREVIEW, "stale");
  const uploads = await db.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, id), ne(catalogUploads.status, "removed")));
  if (uploads.some((u) => u.status === "pending" || u.status === "uploaded" || (typeof u.detected?.completedAt === "string" && Date.parse(u.detected.completedAt) > Date.parse(previewAt)))) throw new StartRefused(409, STALE_PREVIEW, "stale");
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, id));
  if (!sources.length) {
    const detail = uploads.map((u) => u.error).filter(Boolean).join(" ");
    const sentence = `No photos were found in what you uploaded.${detail ? ` ${detail}` : " Upload photos and start again."}`;
    await db.update(catalogBatches).set({ status: "failed", counts: mergeCounts({ failReason: sentence }), updatedAt: new Date() }).where(and(eq(catalogBatches.id, id), eq(catalogBatches.status, "draft")));
    // An operator upload with nothing usable: WARNING, so it sends no alert and stays out of Error Reporting.
    log("WARNING", "batch failed", { batchId: id, brandSlug: batch.brandSlug, reason: sentence, cause: "no_photos" });
    throw new StartRefused(400, sentence, "no_photos");
  }
  const preview = await buildPreview(db, id, { storage: deps.storage });
  const products = await db.select({ id: catalogProducts.id, identifier: catalogProducts.identifier }).from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, id));
  // Source ids by product, built once (a 7,000-product batch has about 28,000 photos).
  const sourceIds = new Map<string, string[]>();
  for (const s of sources) { const ids = sourceIds.get(s.productId); if (ids) ids.push(s.id); else sourceIds.set(s.productId, [s.id]); }
  const plans = planChunks(products.filter((p) => sourceIds.has(p.id)).map((p) => ({ productId: p.id, identifier: p.identifier, sourceCount: sourceIds.get(p.id)!.length })), chunkImages());
  const chunks = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, id)).for("update");
    if (!current) throw new StartRefused(404, "This batch does not exist. Open the batch list and choose another.", "not_draft");
    // A Start that lost to another Start (or to the auto-start) says the batch started, not that files changed.
    if (current.status !== "draft") throw new StartRefused(409, current.startedAt ? STARTED_TEXT : notDraftText(current), "not_draft");
    if (held(current)) throw new StartRefused(409, AUTO_START_HELD, "held");
    if (!current.counts.previewReady || current.updatedAt.getTime() !== batch.updatedAt.getTime()) throw new StartRefused(409, STALE_PREVIEW, "stale");
    const locked = await lockProducts(tx as unknown as Db, id, products.map((p) => p.id));
    if (!locked.ok) throw new StartRefused(409, busyText(locked.busy), "busy");
    // Spec 16: chunk rows in a few big inserts, so a 7,000-product Start stays well inside the web request limit.
    // Slices of 1,000 rows keep each insert under Postgres's 65,535 bind parameters (7 per row).
    const values = plans.map((plan, index) => ({ batchId: id, index, stage: "matte" as const, status: "queued" as const, attempt: 0, productIds: plan.productIds, sourceImageIds: plan.productIds.flatMap((p) => sourceIds.get(p) ?? []) }));
    const rows = [];
    for (let at = 0; at < values.length; at += START_INSERT_ROWS) rows.push(...await tx.insert(catalogChunks).values(values.slice(at, at + START_INSERT_ROWS)).returning());
    // Spec 18: a batch started with the upscaler on is made with the enlargement stage (the invariant's scope).
    await tx.update(catalogBatches).set({ status: "matting", startedAt: new Date(), updatedAt: new Date(), options: startedBatchOptions(current.options), counts: { ...startedCounts(current), products: products.length, sources: sources.length, outputs: sources.length * batch.channels.length, newProducts: preview.overwrite.newProducts, existingProducts: preview.overwrite.existingProducts.length, shotsToRemove: preview.overwrite.existingProducts.reduce((n, p) => n + p.shotsToRemove.length, 0) } }).where(eq(catalogBatches.id, id));
    return rows;
  });
  // Spec 15 E5: only the batch's window of chunks is queued now; each finished chunk queues the next.
  await dispatchChunks(db, deps.enqueue, id);
  log("INFO", "batch started", { batchId: id, brandSlug: batch.brandSlug, products: products.length, sources: sources.length, outputs: sources.length * batch.channels.length, chunks: chunks.length, channels: batch.channels });
  return { id, status: "matting" };
}

/** The counts a started batch keeps: the countdown of the draft (M1-F2-R6) is cleared. */
function startedCounts(batch: CatalogBatch): CatalogBatch["counts"] {
  return { ...batch.counts, autoStartAt: null };
}

/**
 * M1-F2-R6 and R7: the auto-start task. Starts the draft when it is still the one armed at `body.at` (auto-start on,
 * collection done, same countdown); otherwise does nothing. The start blockers are rules (R7): products another
 * running batch holds make it try again (busyRetryDelaySec: 60 s doubling to 15 min) until the lock frees; a changed
 * draft waits for its own new countdown; anything else leaves the draft with its Start button and the reason logged.
 */
export async function runAutoStart(db: Db, deps: StartDeps & { now?: () => Date }, body: AutoStartBody, start: (db: Db, deps: StartDeps, id: string, previewAt: string, autoStart?: { at: string }) => Promise<unknown> = startDraftBatch): Promise<string> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, body.batchId));
  if (!batch) return "noop: the batch does not exist";
  if (batch.status !== "draft") return `noop: the batch is ${batch.status}`;
  if (!batch.options.autoStart) return "noop: auto-start is off (Wait)";
  if (!batch.counts.previewReady) return "noop: collection is not done";
  if (batch.counts.autoStartAt !== body.at) return "noop: a newer countdown runs";
  const now = deps.now?.() ?? new Date();
  try {
    await start(db, deps, batch.id, now.toISOString(), { at: body.at });
    log("INFO", "auto-start started the batch", { batchId: batch.id, brandSlug: batch.brandSlug });
    return "started";
  } catch (err) {
    if (!(err instanceof StartRefused)) throw err;
    if (err.kind === "held") return `noop: ${err.message}`;
    if (err.kind === "busy") {
      const retries = body.busyRetries ?? 0;
      const busySince = body.busySince ?? now.toISOString();
      if (now.getTime() - Date.parse(busySince) >= AUTO_START_BUSY_WARN_MS) log("WARNING", "auto-start still waiting for locked products", { batchId: batch.id, brandSlug: batch.brandSlug, busySince, retries, reason: err.message });
      await armAutoStart(db, deps.enqueue, batch.id, busyRetryDelaySec(retries), now, { busyRetries: retries + 1, busySince });
      return `waiting: ${err.message}`;
    }
    // A changed draft, no marketplace chosen, or nothing usable: this countdown ends and the Start button shows. A
    // collection still running arms a new countdown when it ends (only this countdown's own `at` is cleared).
    await db.update(catalogBatches).set({ counts: mergeCounts({ autoStartAt: null }) })
      .where(and(eq(catalogBatches.id, batch.id), eq(catalogBatches.status, "draft"), sql`${catalogBatches.counts}->>'autoStartAt' = ${body.at}`));
    log("WARNING", "auto-start did not start the batch", { batchId: batch.id, brandSlug: batch.brandSlug, reason: err.message });
    return `not started: ${err.message}`;
  }
}
