// catalog-load driver (spec 09 section 4.1; esbuild entry "catalog-load", `pnpm catalog:load`).
// Runs as the Cloud Run job catalog-load (infra/catalog-scale-jobs.sh) against the deployed stack:
// test batches only (brand test_brand, is_test, objects under catalog-test/ in both buckets), real
// pixels from the Anta and French Connection sets in REAL_DATA_DIR, the deployed worker doing every
// stage through Cloud Tasks. This process never calls OpenRouter (the deployed worker's QA stage
// does, under its caps).
//
//   node dist/catalog-load.js [--options 270] [--passes a,reupload,b] [--reupload-sample <k>]
//     [--timeout-min 240] [--keep]
//
// Env fallbacks for the job: LOAD_OPTIONS, LOAD_PASSES ("a+reupload+b"), LOAD_REUPLOAD_SAMPLE,
// LOAD_TIMEOUT_MIN, LOAD_KEEP=1. The full scale is --options 2700 (FULL_LOAD_OPTIONS).
// Passes: a = Run A (P1 channels), reupload = one altered photo and one dropped shot on a sample of
// Run A's products, b = Run B (the same options through all nine channels).
// Evidence: load-report.json and load-report.md in CATALOG_REAL_OUT/<run>/, written even when a pass
// fails (its error is recorded under passErrors). Every poll retries transient database errors and a
// poll that still fails is logged and retried at the next interval, so one failed query never ends
// a pass. Cleanup of every batch it made (both buckets under catalog-test/, then the rows) runs at
// the end unless --keep; it first waits (up to each batch's pass deadline) for a batch that is still
// running, and lists any batch it had to leave behind with the command that cleans it up later.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { closeDb, getDb, type Db } from "@catalog/core/db/client";
import { brandMaster, catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages, catalogUploads, DEFAULT_BATCH_OPTIONS, spendDays } from "@catalog/core/db/schema";
import { channel } from "@catalog/core/catalog/channels";
import { uploadObjectPath } from "@catalog/core/catalog/ingest/local-files";
import { classifyOutputs } from "@catalog/core/catalog/load/classify";
import { FULL_LOAD_OPTIONS, groupSourceFiles, replicateOptions, zipGroups, type LoadOption } from "@catalog/core/catalog/load/replicate";
import { alterOnePixelRow, planReupload, reuploadSampleSize, type ReuploadPlan } from "@catalog/core/catalog/load/reupload";
import { againstTarget, formatDuration, perMinute, percentile, stageWindows, type ChunkSample } from "@catalog/core/catalog/load/timing";
import { batchPrefix } from "@catalog/core/catalog/naming";
import { lockProducts } from "@catalog/core/catalog/products";
import { pollUntilEnd } from "@catalog/core/catalog/load/poll";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import { CHANNEL_IDS, type ChannelId } from "@catalog/core/catalog/types";
import * as storage from "@catalog/core/storage";
import { describeError } from "@catalog/core/retry";
import { enqueueTask } from "@catalog/core/tasks";
import { buildZip } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { recheckBatch } from "./catalog/recheck-batch";
import { dataRoot } from "./catalog-real-fixtures";

/** One tenth of Run A's 2,700 options: the default for the first go-live run. */
const DEFAULT_OPTIONS = 270;
const ZIP_IMAGES = 400;
const POLL_MS = 15_000;
const BRAND = "test_brand";
const SOURCE_DIRS = ["new_resources_4/Images", "new_resources_3/French Connection Final"];
const P1: ChannelId[] = CHANNEL_IDS.filter(c => channel(c).group === "P1");
const ALL: ChannelId[] = [...CHANNEL_IDS];
type Pass = "a" | "reupload" | "b";
interface ZipFile { name: string; file: string; alter: boolean }

const log = (message: string, extra: Record<string, unknown> = {}) => console.info(JSON.stringify({ at: new Date().toISOString(), message, ...extra }));
/** A batch with no stage running: never collected, collected and waiting for start, or ended. */
const IDLE = new Set(["draft", "done", "failed"]);
const pollError = (batchId: string, step: string) => (error: string) => log("poll failed; polling again", { batchId, step, error });

async function walk(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) found.push(...await walk(dir, next));
    else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) found.push(next);
  }
  return found;
}

/** Real products from the local sets; the first set wins when an identifier appears in both. */
async function realProducts() {
  const products = new Map<string, ReturnType<typeof groupSourceFiles<string>>[number]>();
  for (const sub of SOURCE_DIRS) {
    const dir = path.join(dataRoot(), sub);
    if (!existsSync(dir)) continue;
    const files = (await walk(dir)).map(rel => ({ name: path.basename(rel), item: path.join(dir, rel) }));
    for (const p of groupSourceFiles(files)) if (!products.has(p.identifier)) products.set(p.identifier, p);
  }
  if (!products.size) throw new Error(`No real photo set found under ${dataRoot()} (${SOURCE_DIRS.join(", ")}).`);
  return [...products.values()];
}

async function createBatch(db: Db, run: string, label: string, channels: ChannelId[]) {
  const [brand] = await db.select().from(brandMaster).where(eq(brandMaster.slug, BRAND));
  if (!brand) throw new Error(`The test brand ${BRAND} is missing. Run the migrate job first.`);
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: BRAND, brandName: brand.name, name: `catalog-test load ${run} ${label}`, isTest: true, createdBy: "catalog-test@opptra.com", productType: "auto", channels, options: DEFAULT_BATCH_OPTIONS }).returning();
  return batch!;
}

/** Zips are written to the same object path a signed PUT from the browser would use (04). */
async function uploadZips(db: Db, batch: typeof catalogBatches.$inferSelect, zips: ZipFile[][]) {
  const prefix = batchPrefix(batch.brandSlug, batch.id, batch.isTest), ids: string[] = [];
  for (const [i, files] of zips.entries()) {
    const entries = [];
    for (const f of files) {
      const bytes = await readFile(f.file);
      entries.push({ path: f.name, data: f.alter ? await alterOnePixelRow(bytes) : bytes });
    }
    const zip = buildZip(entries), uploadId = randomUUID(), name = `load-${i + 1}.zip`;
    const gcsUri = await storage.uploadBuffer(uploadObjectPath(prefix, uploadId, name), zip, "application/zip");
    await db.insert(catalogUploads).values({ id: uploadId, batchId: batch.id, kind: "zip", name, relativePath: name, sizeBytes: zip.length, mime: "application/zip", gcsUri, status: "uploaded", detected: { completedAt: new Date().toISOString() } });
    ids.push(uploadId);
    log("zip uploaded", { batchId: batch.id, zip: name, files: files.length, bytes: zip.length });
  }
  return ids;
}

/** Step 2 to 4: the deployed worker collects every zip; resolves when the preview is ready. */
async function collect(db: Db, batchId: string, uploadIds: string[], deadline: number) {
  const started = Date.now();
  await db.update(catalogBatches).set({ status: "ingesting", counts: sql`${catalogBatches.counts} || '{"previewReady":false}'::jsonb`, updatedAt: new Date() }).where(eq(catalogBatches.id, batchId));
  for (const uploadId of uploadIds) await enqueueTask("/tasks/catalog/ingest", { batchId, uploadId });
  const { ended, last: b } = await pollUntilEnd({
    read: async () => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)))[0]!,
    isEnd: b => b.status === "failed" || (b.status === "draft" && !!b.counts.previewReady),
    deadline, intervalMs: POLL_MS, onError: pollError(batchId, "collect"),
  });
  if (ended && b!.status === "failed") throw new Error(`Collecting failed: ${b!.counts.failReason ?? "no reason recorded"}`);
  if (!ended) throw new Error("Collecting did not finish before the time limit.");
  return Date.now() - started;
}

/** "Start processing", as the web's start route does it: lock, plan chunks, queue the matte stage. */
async function start(db: Db, batchId: string) {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const sources = await db.select({ id: catalogSourceImages.id, productId: catalogSourceImages.productId }).from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId));
  const productIds = (await db.select({ id: catalogBatchProducts.productId }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId))).map(p => p.id);
  const withPhotos = productIds.filter(id => sources.some(s => s.productId === id));
  const plans = planChunks(withPhotos.map(productId => ({ productId, sourceCount: sources.filter(s => s.productId === productId).length })), Number(process.env.CATALOG_CHUNK_IMAGES ?? 25));
  const chunks = await db.transaction(async tx => {
    const locked = await lockProducts(tx as unknown as Db, batchId, productIds);
    if (!locked.ok) throw new Error(`${locked.busy.length} products are locked by another batch.`);
    const rows = [];
    for (const [index, plan] of plans.entries()) {
      const [chunk] = await tx.insert(catalogChunks).values({ batchId, index, stage: "matte", status: "queued", productIds: plan.productIds, sourceImageIds: sources.filter(s => plan.productIds.includes(s.productId)).map(s => s.id) }).returning();
      rows.push(chunk!);
    }
    await tx.update(catalogBatches).set({ status: "matting", startedAt: new Date(), updatedAt: new Date(), counts: { ...batch!.counts, products: productIds.length, sources: sources.length, outputs: sources.length * batch!.channels.length } }).where(eq(catalogBatches.id, batchId));
    return rows;
  });
  for (const chunk of chunks) await enqueueTask("/tasks/catalog/chunk", { chunkId: chunk.id }, { taskId: `chunk-${chunk.id}-matte` });
  log("started", { batchId, chunks: chunks.length, sources: sources.length });
}

/** Polls until the batch ends; every poll samples the chunks for the stage windows. */
async function waitForEnd(db: Db, batchId: string, deadline: number, samples: ChunkSample[]) {
  const { ended } = await pollUntilEnd({
    read: async () => {
      const [b] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
      const chunks = await db.select({ id: catalogChunks.id, stage: catalogChunks.stage, status: catalogChunks.status, startedAt: catalogChunks.startedAt, finishedAt: catalogChunks.finishedAt }).from(catalogChunks).where(eq(catalogChunks.batchId, batchId));
      return { status: b!.status, chunks };
    },
    isEnd: ({ status }) => status === "done" || status === "failed",
    onValue: ({ status, chunks }) => {
      samples.push({ at: new Date(), chunks });
      const byStage = Object.fromEntries(["matte", "render", "qa"].map(s => [s, chunks.filter(c => c.stage === s && c.status !== "done").length]));
      log("progress", { batchId, status, chunks: chunks.length, open: byStage, done: chunks.filter(c => c.status === "done").length });
    },
    deadline, intervalMs: POLL_MS, onError: pollError(batchId, "process"),
  });
  return ended;
}

/** Before cleanup: waits for each batch that may still have a stage running, up to its deadline. */
async function waitForIdle(db: Db, batchId: string, deadline: number) {
  const { ended, last } = await pollUntilEnd({
    read: async () => (await db.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batchId)))[0]!.status,
    isEnd: status => IDLE.has(status),
    onValue: status => log("waiting for the batch before cleanup", { batchId, status }),
    deadline, intervalMs: POLL_MS, onError: pollError(batchId, "cleanup"),
  });
  return { ended, status: last as string | null };
}

async function metrics(db: Db, batchId: string, samples: ChunkSample[], collectMs: number, ended: boolean) {
  const [b] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId));
  const sources = await db.select({ matteMs: catalogSourceImages.matteMs }).from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId));
  const pairs = await db.select({ change: catalogBatchProducts.change }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batchId));
  const spend = await db.select({ engine: spendDays.engine, costUsd: sql<number>`sum(${spendDays.costUsd})`, calls: sql<number>`sum(${spendDays.calls})` }).from(spendDays).where(eq(spendDays.batchId, batchId)).groupBy(spendDays.engine);
  const published = outputs.filter(o => o.publishedAt).map(o => ({ at: o.publishedAt!.getTime(), productId: o.productId }));
  const publishStart = published.length ? Math.min(...published.map(p => p.at)) : null, publishEnd = published.length ? Math.max(...published.map(p => p.at)) : null;
  const publishMs = publishStart !== null && publishEnd !== null ? publishEnd - publishStart : 0;
  const end = b!.finishedAt ?? new Date();
  const total = b!.startedAt ? againstTarget(b!.startedAt, end) : null;
  const windows = stageWindows(samples);
  const matte = sources.map(s => s.matteMs).filter((v): v is number => v !== null);
  const classified = classifyOutputs(outputs);
  const changes = pairs.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.change]: (acc[p.change] ?? 0) + 1 }), {});
  const paidProducts = pairs.filter(p => p.change !== "unchanged").length;
  const spendUsd = spend.reduce((s, r) => s + Number(r.costUsd), 0);
  return {
    batchId, status: b!.status, ended, channels: b!.channels, counts: b!.counts, cost: b!.cost,
    wallMs: total?.ms ?? null, withinTarget: ended ? total?.withinTarget ?? false : false,
    stagesMs: { collect: collectMs, matte: windows.matte?.ms ?? null, render: windows.render?.ms ?? null, qa: windows.qa?.ms ?? null, publish: publishMs, finalize: b!.finishedAt && publishEnd !== null ? b!.finishedAt.getTime() - publishEnd : null },
    matteMs: { p50: percentile(matte, 50), p95: percentile(matte, 95) },
    renderMsPerOutputAvg: outputs.length ? Math.round(b!.cost.renderMs / outputs.length) : null,
    productsPublishedPerMinute: perMinute(new Set(published.map(p => p.productId)).size, publishMs),
    spend: spend.map(r => ({ engine: r.engine, usd: Number(r.costUsd), calls: Number(r.calls) })),
    usdPerPaidProduct: paidProducts ? spendUsd / paidProducts : null,
    outputsByStatus: classified.byStatus, errorsByReason: classified.errorsByReason, failed: classified.failed, silent: classified.silent, changes,
  };
}

/** The overwrite contract at scale: same URLs, new generation for the altered shot, the rest unchanged, the dropped shot gone. */
async function checkReupload(db: Db, runA: string, reupload: string, plan: ReuploadPlan<string>) {
  const problems: string[] = [];
  const pairs = await db.select({ product: catalogProducts, change: catalogBatchProducts.change }).from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, reupload));
  const byIdentifier = new Map(pairs.map(p => [p.product.identifier, p]));
  const productIds = pairs.map(p => p.product.id);
  // Run A's published rows. Not filtered on status: the re-upload sets the dropped shot's row to
  // `skipped`, and that row is the one whose link must now answer 404.
  const before = productIds.length ? await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, runA), inArray(catalogOutputs.productId, productIds), isNotNull(catalogOutputs.publishedAt))) : [];
  const live = productIds.length ? await db.select().from(catalogOutputs).where(and(inArray(catalogOutputs.productId, productIds), eq(catalogOutputs.isLive, true))) : [];
  const events = productIds.length ? await db.select().from(catalogProductEvents).where(and(eq(catalogProductEvents.batchId, reupload), inArray(catalogProductEvents.productId, productIds))) : [];
  const key = (productId: string, ch: string, n: number) => `${productId}#${ch}#${n}`;
  const beforeBy = new Map(before.map(o => [key(o.productId, o.channel, o.n), o])), liveBy = new Map(live.map(o => [key(o.productId, o.channel, o.n), o]));
  let gone = 0;
  for (const o of plan.options) {
    const pair = byIdentifier.get(o.identifier);
    if (!pair) { problems.push(`${o.identifier}: not part of the re-upload batch.`); continue; }
    if (!["updated", "shots_removed"].includes(pair.change)) problems.push(`${o.identifier}: change is ${pair.change}, expected updated or shots_removed.`);
    for (const kind of ["overwritten", "shots_removed"] as const) {
      const count = events.filter(e => e.productId === pair.product.id && e.kind === kind).length;
      if (count !== 1) problems.push(`${o.identifier}: ${count} ${kind} events, expected 1.`);
    }
    const altered = plan.altered.find(a => a.identifier === o.identifier)!.n, dropped = plan.dropped.find(d => d.identifier === o.identifier)!.n;
    for (const ch of P1) {
      for (const s of o.shots) {
        const was = beforeBy.get(key(pair.product.id, ch, s.n)), now = liveBy.get(key(pair.product.id, ch, s.n));
        if (!was || !now) { problems.push(`${o.identifier} ${ch} ${s.n}: missing ${was ? "live" : "Run A"} output.`); continue; }
        if (now.publicUrl !== was.publicUrl) problems.push(`${o.identifier} ${ch} ${s.n}: the link changed.`);
        if (s.n === altered && now.generation === was.generation) problems.push(`${o.identifier} ${ch} ${s.n}: the altered photo kept its old generation.`);
        if (s.n !== altered && now.generation !== was.generation) problems.push(`${o.identifier} ${ch} ${s.n}: an untouched photo got a new generation.`);
      }
      const removed = beforeBy.get(key(pair.product.id, ch, dropped));
      if (liveBy.has(key(pair.product.id, ch, dropped))) problems.push(`${o.identifier} ${ch} ${dropped}: the dropped shot is still live.`);
      if (!removed) { problems.push(`${o.identifier} ${ch} ${dropped}: no published Run A output for the dropped shot.`); continue; }
      const response = await fetch(removed.publicUrl, { headers: { "Cache-Control": "no-cache" } });
      await response.body?.cancel();
      if (response.status === 404) gone++; else problems.push(`${o.identifier} ${ch} ${dropped}: the dropped link answers ${response.status}, expected 404.`);
    }
  }
  return { sampled: plan.options.length, droppedLinksGone: gone, problems };
}

function markdown(report: Record<string, unknown>, passes: Record<string, Awaited<ReturnType<typeof metrics>> & { recheck?: string; reupload?: Awaited<ReturnType<typeof checkReupload>> }>) {
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? "-" : formatDuration(v));
  const lines = [`# Load run ${String(report.run)}`, "", `Options: ${String(report.options)}. Brand: ${BRAND} (test batches only). Target: 2 hours per batch.`, ""];
  lines.push("| Pass | Status | Wall time | Within 2 h | Collect | Matte | Render | QA | Publish | Finalize | matte_ms p50/p95 | Products published per minute | Re-check |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, p] of Object.entries(passes)) {
    lines.push(`| ${name} | ${p.status} | ${ms(p.wallMs)} | ${p.withinTarget ? "yes" : "no"} | ${ms(p.stagesMs.collect)} | ${ms(p.stagesMs.matte)} | ${ms(p.stagesMs.render)} | ${ms(p.stagesMs.qa)} | ${ms(p.stagesMs.publish)} | ${ms(p.stagesMs.finalize)} | ${p.matteMs.p50 ?? "-"} / ${p.matteMs.p95 ?? "-"} | ${p.productsPublishedPerMinute ?? "-"} | ${p.recheck ?? "-"} |`);
  }
  for (const [name, p] of Object.entries(passes)) {
    lines.push("", `## ${name}`, "", `Outputs by status: ${JSON.stringify(p.outputsByStatus)}. Changes: ${JSON.stringify(p.changes)}.`, `Spend: ${JSON.stringify(p.spend)}; USD per changed product: ${p.usdPerPaidProduct?.toFixed(4) ?? "-"}.`, `Errors by reason: ${JSON.stringify(p.errorsByReason)}.`, `Silent outputs (must be none): ${p.silent.length}.`);
    for (const f of p.failed) lines.push(`- failed ${f.channel} ${f.n} (${f.productId}): ${f.reason}`);
    if (p.reupload) lines.push(`Re-upload: ${p.reupload.sampled} products, ${p.reupload.droppedLinksGone} dropped links answer 404, ${p.reupload.problems.length} contract problems.`, ...p.reupload.problems.slice(0, 50).map(x => `- ${x}`));
  }
  const errors = Object.entries((report.passErrors ?? {}) as Record<string, string>);
  if (errors.length) lines.push("", "## Pass errors", "", ...errors.map(([name, error]) => `- ${name}: ${error}`));
  const left = (report.cleanup as { leftBehind?: { batchId: string; status: string | null }[] } | undefined)?.leftBehind ?? [];
  if (left.length) lines.push("", "## Left behind by cleanup", "", ...left.map(b => `- ${b.batchId} (${b.status ?? "unknown"}): clean up with node dist/catalog-smoke.js --cleanup-batches ${b.batchId}`));
  lines.push("", "Cloud Run instance counts and queue depth: read from Cloud Monitoring for the run window and paste here.");
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({ options: { options: { type: "string" }, passes: { type: "string" }, "reupload-sample": { type: "string" }, "timeout-min": { type: "string" }, keep: { type: "boolean" } } });
  const count = Number(values.options ?? process.env.LOAD_OPTIONS ?? DEFAULT_OPTIONS);
  if (!Number.isInteger(count) || count < 1 || count > FULL_LOAD_OPTIONS) throw new Error(`--options must be a whole number from 1 to ${FULL_LOAD_OPTIONS}.`);
  const passes = (values.passes ?? process.env.LOAD_PASSES ?? "a,reupload,b").split(/[,+]/).map(p => p.trim()).filter(Boolean) as Pass[];
  if (!passes.length || passes.some(p => !["a", "reupload", "b"].includes(p)) || (passes.includes("reupload") && !passes.includes("a"))) throw new Error("--passes lists a, reupload and b; reupload needs a.");
  const sample = Number(values["reupload-sample"] ?? process.env.LOAD_REUPLOAD_SAMPLE ?? reuploadSampleSize(count));
  const timeoutMs = Number(values["timeout-min"] ?? process.env.LOAD_TIMEOUT_MIN ?? 240) * 60_000;
  const keep = values.keep ?? process.env.LOAD_KEEP === "1";
  const run = `load-${randomUUID()}`, out = path.resolve(process.env.CATALOG_REAL_OUT ?? "var/catalog-test", run);
  await mkdir(out, { recursive: true });

  const options: LoadOption<string>[] = replicateOptions(await realProducts(), count);
  log("plan", { run, options: options.length, shots: options.reduce((s, o) => s + o.shots.length, 0), passes, reuploadSample: passes.includes("reupload") ? sample : 0 });
  const db = getDb(), batchIds: string[] = [], results: Parameters<typeof markdown>[1] = {};
  // Each batch's pass deadline: cleanup waits up to it for a batch that is still running.
  const deadlines = new Map<string, number>(), passErrors: Record<string, string> = {};
  let passed = true;
  const asZips = (opts: { shots: { name: string; item: string; alter?: boolean }[] }[]): ZipFile[][] =>
    zipGroups(opts, ZIP_IMAGES).map(group => group.flatMap(o => o.shots.map(s => ({ name: s.name, file: s.item, alter: !!s.alter }))));
  const runPass = async (label: string, channels: ChannelId[], zips: ZipFile[][]) => {
    const deadline = Date.now() + timeoutMs, batch = await createBatch(db, run, label, channels);
    batchIds.push(batch.id);
    deadlines.set(batch.id, deadline);
    const collectMs = await collect(db, batch.id, await uploadZips(db, batch, zips), deadline);
    await start(db, batch.id);
    const samples: ChunkSample[] = [];
    const ended = await waitForEnd(db, batch.id, deadline, samples);
    const m = await metrics(db, batch.id, samples, collectMs, ended);
    let recheck = "not run";
    if (ended && m.status === "done") {
      const r = await recheckBatch(db, batch.id);
      recheck = `${r.summary.ok} of ${r.summary.total} OK`;
      if (!r.summary.passed) passed = false;
    }
    if (!ended || m.status !== "done" || m.silent.length) passed = false;
    log("pass finished", { label, batchId: batch.id, status: m.status, wall: m.wallMs === null ? null : formatDuration(m.wallMs), recheck });
    return { ...m, recheck };
  };
  // A pass that throws is recorded and the run goes on. A later pass is skipped while an earlier
  // batch may still be running, since it would find the same products locked.
  const attempt = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (error) {
      passed = false;
      passErrors[name] = describeError(error);
      log("pass failed; recorded in the report", { pass: name, error: passErrors[name] });
      return null;
    }
  };
  const mayBeRunning = () => batchIds.some(id => !Object.values(results).some(r => r.batchId === id && r.ended));
  const skip = (name: string) => { passed = false; passErrors[name] = "Skipped: an earlier batch had not ended, so its products may still be locked."; log("pass skipped", { pass: name }); };
  const leftBehind: { batchId: string; status: string | null }[] = [];
  try {
    if (passes.includes("a")) { const r = await attempt("Run A", () => runPass("A", P1, asZips(options))); if (r) results["Run A"] = r; }
    const runA = results["Run A"];
    if (passes.includes("reupload") && runA?.status === "done") {
      if (mayBeRunning()) skip("Re-upload");
      else await attempt("Re-upload", async () => {
        const plan = planReupload(options, sample);
        const r = await runPass("reupload", P1, asZips(plan.options));
        const contract = r.status === "done" ? await checkReupload(db, runA.batchId, r.batchId, plan) : { sampled: plan.options.length, droppedLinksGone: 0, problems: ["The re-upload batch did not finish."] };
        if (contract.problems.length) passed = false;
        results["Re-upload"] = { ...r, reupload: contract };
      });
    } else if (passes.includes("reupload")) { passed = false; passErrors["Re-upload"] = "Skipped: Run A did not finish as done."; }
    if (passes.includes("b")) {
      if (mayBeRunning()) skip("Run B");
      else { const r = await attempt("Run B", () => runPass("B", ALL, asZips(options))); if (r) results["Run B"] = r; }
    }
  } finally {
    if (keep) log("cleanup skipped (--keep)", { batchIds });
    else if (batchIds.length) {
      const idle: string[] = [];
      for (const batchId of batchIds) {
        const w = await waitForIdle(db, batchId, deadlines.get(batchId) ?? Date.now()).catch(error => ({ ended: false, status: `unknown (${describeError(error)})` }));
        if (w.ended) idle.push(batchId); else leftBehind.push({ batchId, status: w.status });
      }
      if (idle.length) await attempt("cleanup", async () => log("cleanup", { batchIds: idle, ...await cleanupTestBatches(db, storage, idle) }));
      if (leftBehind.length) log("cleanup left batches behind: still running at their deadline; clean up after they end", { leftBehind, command: `node dist/catalog-smoke.js --cleanup-batches ${leftBehind.map(b => b.batchId).join(",")}` });
    }
    const report = { run, options: count, passes, passed, batchIds, passErrors, cleanup: keep ? "kept" : { leftBehind }, results };
    await writeFile(path.join(out, "load-report.json"), JSON.stringify(report, null, 2)).catch(error => console.error(`load-report.json not written: ${describeError(error)}`));
    await writeFile(path.join(out, "load-report.md"), markdown(report, results)).catch(error => console.error(`load-report.md not written: ${describeError(error)}`));
    log("report written", { out, passed });
    if (!passed) process.exitCode = 1;
    await closeDb();
  }
}

main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
