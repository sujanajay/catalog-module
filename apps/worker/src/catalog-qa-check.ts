// 07 tier 3: the live QA check, run as the Cloud Run job `catalog-qa-check` from the worker image.
// OpenRouter is called only when LIVE_SMOKE=1 (key from the Secret Manager env mount); otherwise the
// judge is mocked. Batches are catalog-test only; evidence goes to CATALOG_REAL_OUT, which the job
// mounts at catalog-test/qa-check/<run>/; the test batches, objects and rows are cleaned up at the end.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, type Db } from "@catalog/core/db/client";
import { brandMaster, catalogBatches, catalogChunks, catalogOutputs, catalogSourceImages, catalogUploads, DEFAULT_BATCH_OPTIONS } from "@catalog/core/db/schema";
import { runIngest } from "@catalog/core/catalog/ingest/index";
import { batchPrefix } from "@catalog/core/catalog/naming";
import { lockProducts } from "@catalog/core/catalog/products";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { QA_DIMENSIONS } from "@catalog/core/catalog/qa/judge";
import { CATALOG_QA_DEFAULT_MODEL } from "@catalog/core/catalog/qa/classify";
import { cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import type { ChannelId } from "@catalog/core/catalog/types";
import { pinnedFetch } from "@catalog/core/safe-url";
import { dailyCapFromEnv, sumSpendForDay, utcDay } from "@catalog/core/spend";
import * as storage from "@catalog/core/storage";
import { buildZip } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { workerCatalogDeps, type CatalogDeps } from "./catalog/deps";
import { chunkFinished, currentChunkTask, handleChunkTask, IN_PROCESS_DELIVERIES } from "./catalog/chunk";
import { runUntilSettled } from "@catalog/core/catalog/retry-chunk";
import { handlePublishTask } from "./catalog/publish";
import { cannedQa, liveQaEnabled } from "./catalog/qa-mock";
import { localFixture, type RealFixture } from "./catalog-real-fixtures";

const CHANNELS: ChannelId[] = ["noon", "styli"];
// Per check: three images at 1536 px plus the template (about 6,000 prompt tokens) and a short JSON
// reply; doubled for the built-in retry. Used only to size the budget before each batch.
const PROMPT_TOKENS_PER_CHECK = 6000, COMPLETION_TOKENS_PER_CHECK = 500, RETRY_FACTOR = 2;

/** USD per check for one model from the OpenRouter model listing (prices are USD per token). */
async function usdPerCheck(model: string): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  assert(response.ok, `The OpenRouter model listing answered ${response.status}.`);
  const body = await response.json() as { data?: { id: string; pricing?: Record<string, string> }[] } | { id: string; pricing?: Record<string, string> }[];
  const rows = Array.isArray(body) ? body : body.data ?? [];
  const pricing = rows.find(row => row.id === model)?.pricing;
  assert(pricing, `The OpenRouter listing has no price for the configured judge.`);
  const price = (key: string) => Number(pricing[key] ?? 0) || 0;
  return (PROMPT_TOKENS_PER_CHECK * price("prompt") + COMPLETION_TOKENS_PER_CHECK * price("completion") + 3 * price("image") + price("request")) * RETRY_FACTOR;
}

async function runBatch(db: Db, deps: CatalogDeps, fixture: RealFixture, run: string, qaCapUsd: number | null) {
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: fixture.slug, brandName: fixture.name, name: `catalog-test ${run} ${fixture.slug}`, isTest: true, createdBy: "catalog-test@opptra.com", productType: fixture.type, channels: CHANNELS, options: { ...DEFAULT_BATCH_OPTIONS, qaCapUsd } }).returning();
  const b = batch!, prefix = batchPrefix(b.brandSlug, b.id, true);
  const uri = await storage.uploadBuffer(`${prefix}/uploads/${randomUUID()}/photos.zip`, buildZip(fixture.shots.map(s => ({ path: s.name, data: s.bytes }))), "application/zip");
  const [upload] = await db.insert(catalogUploads).values({ batchId: b.id, kind: "zip", name: "photos.zip", gcsUri: uri, status: "uploaded" }).returning();
  const queue: Record<string, unknown>[] = [{ batchId: b.id, uploadId: upload!.id }];
  while (queue.length) {
    const result = await runIngest(db, { storage, fetch: pinnedFetch, enqueue: async (_route, next) => { queue.push(next); return "qa-check-inline"; } }, queue.shift() as { batchId: string; uploadId: string; cursor?: string });
    assert(!["failed", "not_found"].includes(result.outcome), `Ingest failed: ${result.outcome}`);
  }
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, b.id));
  const productIds = [...new Set(sources.map(s => s.productId))];
  assert((await lockProducts(db, b.id, productIds)).ok, "A test product is locked by another batch.");
  await db.update(catalogBatches).set({ status: "matting", startedAt: new Date(), counts: { ...b.counts, products: productIds.length, sources: sources.length, outputs: sources.length * CHANNELS.length } }).where(eq(catalogBatches.id, b.id));
  for (const [index, plan] of planChunks(productIds.map(productId => ({ productId, sourceCount: sources.filter(s => s.productId === productId).length })), 25).entries()) {
    const [chunk] = await db.insert(catalogChunks).values({ batchId: b.id, index, stage: "matte", productIds: plan.productIds }).returning();
    for (let delivery = 0; delivery < IN_PROCESS_DELIVERIES && !(await chunkFinished(deps.db, chunk!.id)); delivery++) assert.equal((await runUntilSettled(async () => handleChunkTask(deps, await currentChunkTask(deps.db, chunk!.id)), { label: `chunk ${chunk!.id}` })).httpStatus, 200, "A chunk stage failed.");
    for (const productId of plan.productIds) await handlePublishTask(deps, { batchId: b.id, productId });
  }
  return b.id;
}

const html = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function main() {
  const live = liveQaEnabled(), run = `qa-check-${randomUUID()}`;
  const out = path.resolve(process.env.CATALOG_REAL_OUT ?? `var/catalog-test/qa-check/${run}`);
  const fcLimit = Number(process.env.QA_CHECK_FC_LIMIT ?? 200);
  // Photos taken from the Anta set; unset means all of them. A small value (with QA_CHECK_FC_LIMIT)
  // makes a cheap live probe after a deploy.
  const antaLimit = process.env.QA_CHECK_ANTA_LIMIT?.trim() ? Number(process.env.QA_CHECK_ANTA_LIMIT) : Infinity;
  assert(Number.isInteger(fcLimit) && fcLimit >= 0, "QA_CHECK_FC_LIMIT must be a whole number of photos.");
  assert(antaLimit === Infinity || (Number.isInteger(antaLimit) && antaLimit >= 0), "QA_CHECK_ANTA_LIMIT must be a whole number of photos.");
  await mkdir(out, { recursive: true });
  const db = getDb(), batchIds: string[] = [];
  const base = workerCatalogDeps(db);
  const deps: CatalogDeps = { ...base, ...(live ? {} : cannedQa), enqueue: async () => "qa-check-inline" };
  const summary: Record<string, unknown>[] = [], flagged: string[] = [];
  try {
    const brands = await db.select().from(brandMaster);
    const fixtures: RealFixture[] = [];
    for (const brand of brands) {
      const fixture = await localFixture(brand.slug, true, run);
      if (!fixture) continue;
      fixture.name = brand.name;
      fixture.shots = fixture.shots.slice(0, fixture.slug === "anta" ? antaLimit : fcLimit);
      fixtures.push(fixture);
    }
    assert(fixtures.length, "No real Anta or French Connection set is available in REAL_DATA_DIR.");
    const model = process.env.CATALOG_QA_DEFAULT_MODEL ?? CATALOG_QA_DEFAULT_MODEL;
    const perCheck = live ? await usdPerCheck(model) : 0;
    for (const fixture of fixtures) {
      // Enforced before each batch: the budget must fit under today's cap, and becomes the batch's QA cap.
      const budget = fixture.shots.length * perCheck;
      const spent = await sumSpendForDay(db, utcDay()), cap = dailyCapFromEnv();
      if (live && spent + budget > cap) { summary.push({ brand: fixture.name, skipped: `Budget USD ${budget.toFixed(4)} does not fit under the daily cap (USD ${spent.toFixed(4)} of ${cap} used).` }); continue; }
      const batchId = await runBatch(db, deps, fixture, run, live ? budget : null);
      batchIds.push(batchId);
      const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
      const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId));
      const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batchId));
      const threshold = batch!.options.policy?.threshold ?? 75;
      const dimensions = Object.fromEntries(QA_DIMENSIONS.map(d => [d, { pass: 0, flag: 0 }]));
      const verdicts: Record<string, number> = {};
      for (const output of outputs) {
        const scores = output.qaScores as Record<string, unknown> | null;
        const verdict = scores ? String(scores.verdict ?? "pass") : output.flags.find(f => f.startsWith("qa_")) ?? output.status;
        verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
        if (scores) for (const d of QA_DIMENSIONS) dimensions[d]![Number(scores[d]) >= threshold ? "pass" : "flag"]++;
        if (output.status !== "needs_attention" || !output.stagingUri) continue;
        const source = sources.find(s => s.id === output.sourceImageId);
        if (!source) continue;
        const thumb = async (uri: string) => (await storage.downloadBuffer(uri)).buf.toString("base64");
        flagged.push(`<tr><td>${html(fixture.name)} ${html(output.channel)} img ${output.n}<br>${html(output.flags.join(", "))}<br>${html(output.reason ?? "")}</td><td><img width="300" src="data:image/jpeg;base64,${await thumb(source.rawUri)}"></td><td><img width="300" src="data:image/jpeg;base64,${await thumb(output.stagingUri)}"></td></tr>`);
      }
      summary.push({ brand: fixture.name, images: fixture.shots.length, outputs: outputs.length, verdicts, dimensions, qaUsd: batch!.cost.qaUsd, qaCalls: batch!.cost.qaCalls, budgetUsd: budget });
    }
    const result = { run, mode: live ? "live judge" : "mocked judge (LIVE_SMOKE is not 1)", summary };
    await writeFile(path.join(out, "summary.json"), JSON.stringify(result, null, 2));
    await writeFile(path.join(out, "contact-sheet.html"), `<!doctype html><meta charset="utf-8"><title>QA check flagged outputs</title><h1>Flagged outputs (${flagged.length})</h1><p>${html(result.mode)}</p><table><thead><tr><th>Output</th><th>Original</th><th>Made</th></tr></thead><tbody>${flagged.join("")}</tbody></table>`);
    console.info(JSON.stringify(result));
  } finally {
    if (batchIds.length) console.info(JSON.stringify({ cleanup: await cleanupTestBatches(db, storage, batchIds) }));
    await closeDb();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
