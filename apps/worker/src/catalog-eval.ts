// 08: the bake-off CLI `pnpm catalog:eval <command>`, run as the Cloud Run job `catalog-eval` from the
// worker image (infra/catalog-eval.sh). Every artifact stays under catalog-test/eval/<set>/ in the
// private bucket; eval batches are is_test batches, so their outputs land under catalog-test/ only.
// Live judge calls happen only in `judges`, and only with LIVE_SMOKE=1 (the key comes from the Secret
// Manager env mount); `run` always uses the mocked judge. Model ids are printed here (engineering
// output) and never reach an operator page.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb, type Db } from "@catalog/core/db/client";
import { brandMaster, catalogBatches, catalogChunks, catalogEvalJudgements, catalogEvalLabels, catalogOutputs, catalogProducts, catalogSourceImages, catalogUploads, DEFAULT_BATCH_OPTIONS, modelPolicy } from "@catalog/core/db/schema";
import { runIngest } from "@catalog/core/catalog/ingest/index";
import { batchPrefix } from "@catalog/core/catalog/naming";
import { lockProducts } from "@catalog/core/catalog/products";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { judgeOutput } from "@catalog/core/catalog/qa/judge";
import { cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import { CHANNEL_IDS, PRODUCT_TYPES, type ChannelId, type ProductType } from "@catalog/core/catalog/types";
import { assembleFromFolder, readManifest } from "@catalog/core/catalog/eval/assemble";
import { contactPath, labelsPath, reportPath, type EvalCategory } from "@catalog/core/catalog/eval/manifest";
import { fetchPriceListing, runJudges } from "@catalog/core/catalog/eval/judges";
import { liveDrift, loadEvalRows } from "@catalog/core/catalog/eval/load";
import { candidatesChanged, planPolicy, writePolicyRows, type PolicyCandidates } from "@catalog/core/catalog/eval/policy-writer";
import { reportHtml, reportJson, WAITING_BRANDS } from "@catalog/core/catalog/eval/report";
import { chooseService, forcedPolicy, MATTE_CANDIDATES, matteModelsFor, qaCandidates } from "@catalog/core/catalog/eval/run";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { buildZip } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { workerCatalogDeps, type CatalogDeps } from "./catalog/deps";
import { handleChunkTask } from "./catalog/chunk";
import { handlePublishTask } from "./catalog/publish";
import { handleFinalizeTask } from "./catalog/finalize";
import { cannedQa, liveQaEnabled } from "./catalog/qa-mock";
import { dataRoot } from "./catalog-real-fixtures";

const USAGE = `Usage: catalog:eval <command>
  assemble --set <s> --brand <slug> [--folder <path>] [--category <type>] [--sample <n> --seed <k>]
  run --set <s> --matte <model|primary|all> --channels <list> [--qa-model <model>] [--qa-mode per_output]
  judges --batch <id> --models <a,b,...>          (LIVE_SMOKE=1 and EVAL_BUDGET_USD required)
  experiment --name sr_pass|trimap|box_prompt --batch <id>
  contact-sheet --batch <id>
  labels export --set <s>
  score --set <s> --batches <ids> [--live]
  policy write --set <s> --batches <ids> [--dry-run]
  report --set <s> --batches <ids>
  cleanup --batches <ids>`;

/** Real photo folders (relative to REAL_DATA_DIR) for the brands with real sets, and their category. */
const REAL_FOLDERS: Record<string, { folder: string; category: EvalCategory }> = {
  anta: { folder: "new_resources_4/Images", category: "footwear" },
  french_connection: { folder: "new_resources_3/French Connection Final", category: "apparel_model" },
};

function parseArgs(argv: string[]) {
  const words: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { words.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { words, flags };
}
const list = (v: string | true | undefined) => typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean) : [];
function need(flags: Record<string, string | true>, name: string): string {
  const v = flags[name];
  assert(typeof v === "string" && v, `--${name} is required.\n${USAGE}`);
  return v;
}
const runId = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const print = (value: unknown) => console.info(typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** The job mounts the real-data tarballs read only; unpack them once into REAL_DATA_DIR. */
async function ensureRealData(): Promise<string> {
  const root = dataRoot(), input = process.env.EVAL_INPUT_DIR;
  if (existsSync(root) && readdirSync(root).length) return root;
  assert(input && existsSync(input), "No real data: set REAL_DATA_DIR or EVAL_INPUT_DIR.");
  await mkdir(root, { recursive: true });
  for (const tar of readdirSync(input).filter(f => f.endsWith(".tar"))) await promisify(execFile)("tar", ["-xf", path.join(input, tar), "-C", root]);
  return root;
}

async function evalBatches(db: Db, ids: string[]) {
  assert(ids.length && ids.every(id => /^[0-9a-f-]{36}$/.test(id)), "Supply eval batch UUIDs with --batches.");
  const rows = await db.select().from(catalogBatches).where(inArray(catalogBatches.id, ids));
  assert(rows.length === ids.length && rows.every(b => b.isTest && b.options.evalSet), "Every batch must be an eval test batch.");
  return rows;
}

async function assemble(flags: Record<string, string | true>) {
  const set = need(flags, "set"), brand = need(flags, "brand");
  if (flags.sheets || flags.master) print("not run: Supabase sheet and master image_url sources are deferred in this build; only local real photo folders are collected.");
  const known = REAL_FOLDERS[brand];
  const folderArg = typeof flags.folder === "string" ? flags.folder : known?.folder;
  assert(folderArg, `No real photo folder is known for ${brand}; pass --folder.`);
  const folder = path.isAbsolute(folderArg) ? folderArg : path.join(await ensureRealData(), folderArg);
  const rawCategory = typeof flags.category === "string" ? flags.category : known?.category;
  assert(!rawCategory || (PRODUCT_TYPES as readonly string[]).includes(rawCategory) && rawCategory !== "auto", "Unknown --category.");
  const category = rawCategory as EvalCategory | undefined;
  const sample = flags.sample ? { n: Number(flags.sample), seed: Number(flags.seed ?? 0) } : undefined;
  assert(!sample || Number.isInteger(sample.n) && sample.n > 0 && Number.isInteger(sample.seed), "--sample and --seed must be integers.");
  print(await assembleFromFolder(storage, { set, brand, folder, ...(category ? { category } : {}), ...(sample ? { sample } : {}) }));
}

async function runEval(db: Db, flags: Record<string, string | true>) {
  const set = need(flags, "set"), channels = list(need(flags, "channels")) as ChannelId[];
  assert(channels.length && channels.every(c => (CHANNEL_IDS as readonly string[]).includes(c)), "Unknown channel in --channels.");
  assert(!flags["qa-mode"] || flags["qa-mode"] === "per_output", "Eval runs use --qa-mode per_output.");
  const manifest = await readManifest(storage, set);
  assert(manifest.entries.length, `The eval set ${set} has no sources yet; run assemble first.`);
  const base = workerCatalogDeps(db);
  const deps: CatalogDeps = { ...base, ...cannedQa, enqueue: async () => "eval-inline" };
  const health = await deps.matting.health();
  const results: Record<string, unknown>[] = [];
  for (const model of matteModelsFor(need(flags, "matte"))) {
    const choice = chooseService(model, health.models, !!process.env.MATTING_GPU_URL);
    if (!choice.ok) { results.push({ model, status: choice.reason }); print(`${model}: ${choice.reason}`); continue; }
    for (const brand of [...new Set(manifest.entries.map(e => e.brand))]) {
      const entries = manifest.entries.filter(e => e.brand === brand);
      const [master] = await db.select().from(brandMaster).where(eq(brandMaster.slug, brand));
      assert(master, `Brand ${brand} is not in the brand master.`);
      const categories = [...new Set(entries.map(e => e.category_override ?? "auto"))];
      const productType: ProductType = categories.length === 1 ? categories[0]! : "auto";
      const tag = `eval-${randomUUID().slice(0, 8)}`;
      const policy = forcedPolicy(model, choice.target, typeof flags["qa-model"] === "string" ? flags["qa-model"] : undefined);
      const [batch] = await db.insert(catalogBatches).values({ brandSlug: brand, brandName: master.name, name: `catalog-test eval ${set} ${tag}`, isTest: true, createdBy: "catalog-eval@opptra.com", productType, channels, options: { ...DEFAULT_BATCH_OPTIONS, evalSet: set, qaCapUsd: null, policy } }).returning();
      const b = batch!, prefix = batchPrefix(b.brandSlug, b.id, true);
      // Run-unique identifiers keep every run's products apart, so each batch can be cleaned on its own.
      const files = await Promise.all(entries.map(async e => ({ path: `${tag}-${e.identifier}_${e.n}.${e.uri.split(".").pop()}`, data: (await storage.downloadBuffer(e.uri)).buf })));
      const uri = await storage.uploadBuffer(`${prefix}/uploads/${randomUUID()}/photos.zip`, buildZip(files), "application/zip");
      const [upload] = await db.insert(catalogUploads).values({ batchId: b.id, kind: "zip", name: "photos.zip", gcsUri: uri, status: "uploaded" }).returning();
      const queue: Record<string, unknown>[] = [{ batchId: b.id, uploadId: upload!.id }];
      while (queue.length) {
        const result = await runIngest(db, { storage, fetch: pinnedFetch, enqueue: async (_route, next) => { queue.push(next); return "eval-inline"; } }, queue.shift() as { batchId: string; uploadId: string; cursor?: string });
        assert(!["failed", "not_found"].includes(result.outcome), `Ingest failed: ${result.outcome}`);
      }
      const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, b.id));
      const productIds = [...new Set(sources.map(s => s.productId))];
      assert((await lockProducts(db, b.id, productIds)).ok, "An eval product is locked by another batch.");
      const started = Date.now();
      await db.update(catalogBatches).set({ status: "matting", startedAt: new Date(), counts: { ...b.counts, products: productIds.length, sources: sources.length, outputs: sources.length * channels.length } }).where(eq(catalogBatches.id, b.id));
      for (const [index, plan] of planChunks(productIds.map(productId => ({ productId, sourceCount: sources.filter(s => s.productId === productId).length })), 25).entries()) {
        const [chunk] = await db.insert(catalogChunks).values({ batchId: b.id, index, stage: "matte", productIds: plan.productIds }).returning();
        for (let stage = 0; stage < 3; stage++) assert.equal((await handleChunkTask(deps, { chunkId: chunk!.id })).httpStatus, 200, "A chunk stage failed.");
        for (const productId of plan.productIds) await handlePublishTask(deps, { batchId: b.id, productId });
      }
      const finalize = await handleFinalizeTask(deps, { batchId: b.id });
      const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, b.id));
      const matted = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, b.id));
      const ms = matted.flatMap(s => s.matteMs ? [s.matteMs] : []);
      const compliance = outputs.filter(o => o.status !== "skipped");
      const summary = { model, target: choice.target, brand, set, batchId: b.id, finalize: finalize.outcome, wallSeconds: Math.round((Date.now() - started) / 1000), outputs: outputs.length, compliancePct: compliance.length ? 100 * compliance.filter(o => o.compliance?.ok === true).length / compliance.length : 0, meanMatteMs: ms.length ? Math.round(ms.reduce((a, x) => a + x, 0) / ms.length) : null, labelAt: `/catalog/${b.id}` };
      results.push(summary);
      print(summary);
    }
  }
  print({ runs: results });
}

async function judges(db: Db, flags: Record<string, string | true>) {
  const batchId = need(flags, "batch"), models = list(need(flags, "models"));
  if (!liveQaEnabled()) { print("not run: judges makes live calls only with LIVE_SMOKE=1 (run it as the catalog-eval job)."); process.exitCode = 1; return; }
  const budget = Number(process.env.EVAL_BUDGET_USD);
  assert(Number.isFinite(budget) && budget > 0, "EVAL_BUDGET_USD is required for judges.");
  const result = await runJudges({ db, downloadBuffer: storage.downloadBuffer, fetchPublic: async url => Buffer.from(await (await fetch(url)).arrayBuffer()), judge: judgeOutput, llm: { log: m => console.info(m) } }, { batchId, models, budgetUsd: budget, listing: await fetchPriceListing() });
  print(result);
  if (result.stopped) process.exitCode = 1;
}

async function contactSheet(db: Db, flags: Record<string, string | true>) {
  const [batch] = await evalBatches(db, [need(flags, "batch")]);
  const b = batch!;
  const rows = await db.select({ output: catalogOutputs, source: catalogSourceImages, identifier: catalogProducts.identifier }).from(catalogOutputs)
    .innerJoin(catalogSourceImages, eq(catalogSourceImages.id, catalogOutputs.sourceImageId)).innerJoin(catalogProducts, eq(catalogProducts.id, catalogOutputs.productId))
    .where(eq(catalogOutputs.batchId, b.id)).orderBy(catalogProducts.identifier, catalogOutputs.n, catalogOutputs.channel);
  const verdicts = await db.select().from(catalogEvalJudgements).where(eq(catalogEvalJudgements.batchId, b.id));
  const labels = await db.select().from(catalogEvalLabels).where(eq(catalogEvalLabels.batchId, b.id));
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const body: string[] = [];
  for (const { output, source, identifier } of rows) {
    const made = output.stagingUri ? await storage.signedUrl(output.stagingUri) : output.publicUrl;
    const judged = verdicts.filter(v => v.outputId === output.id).map(v => `${v.judgeModel}: ${v.verdict} (${Math.round(Number(v.scores.overall ?? 0))})`).join("<br>");
    const human = labels.filter(l => l.outputId === output.id).map(l => `${l.labeler}: ${l.label} ${l.reasons.join(" ")}`).join("<br>");
    body.push(`<tr><td>${esc(identifier)} img ${output.n} ${esc(output.channel)}<br>${esc(output.status)}</td><td><img width="220" src="${esc(await storage.signedUrl(source.rawUri))}"></td><td><img width="220" src="${esc(made)}"></td><td>${judged.split("<br>").map(esc).join("<br>")}</td><td>${human.split("<br>").map(esc).join("<br>")}</td></tr>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Contact sheet ${esc(b.id)}</title><h1>${esc(b.options.evalSet)} ${esc(b.options.policy?.matteModel)}</h1><table border="1"><thead><tr><th>Output</th><th>Original</th><th>Made</th><th>Judges</th><th>Human</th></tr></thead><tbody>${body.join("")}</tbody></table>`;
  const uri = await storage.uploadBuffer(contactPath(b.options.evalSet!, b.id), Buffer.from(html), "text/html");
  print({ contactSheet: uri, signedUrl: await storage.signedUrl(uri) });
}

async function labelsExport(db: Db, flags: Record<string, string | true>) {
  const set = need(flags, "set"), id = runId();
  const batches = await db.select({ id: catalogBatches.id }).from(catalogBatches).where(and(eq(catalogBatches.isTest, true), sql`${catalogBatches.options}->>'evalSet' = ${set}`));
  const rows = batches.length ? await db.select().from(catalogEvalLabels).where(inArray(catalogEvalLabels.batchId, batches.map(b => b.id))) : [];
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [["batch_id", "output_id", "identifier", "channel", "labeler", "label", "reasons", "note", "judge_verdict", "created_at"].join(","),
    ...rows.map(r => [r.batchId, r.outputId, r.identifier, r.channel, r.labeler, r.label, r.reasons.join(" "), r.note, r.judgeVerdict, r.createdAt.toISOString()].map(cell).join(","))].join("\n");
  print({ labels: rows.length, file: await storage.uploadBuffer(labelsPath(set, id), Buffer.from(`${csv}\n`), "text/csv") });
}

async function seenCandidates(deps: CatalogDeps): Promise<PolicyCandidates> {
  const health = await deps.matting.health();
  return { matte: health.models.map(m => ({ id: m.id, target: m.target })), judges: qaCandidates() };
}

async function scored(db: Db, flags: Record<string, string | true>) {
  const batchIds = list(need(flags, "batches"));
  await evalBatches(db, batchIds);
  const rows = await loadEvalRows(db, batchIds);
  const deps = workerCatalogDeps(db);
  const seen = await seenCandidates(deps);
  return { rows, seen, scopes: planPolicy({ ...rows, candidates: MATTE_CANDIDATES, seen }), deps };
}

async function score(db: Db, flags: Record<string, string | true>) {
  need(flags, "set");
  const { scopes, seen } = await scored(db, flags);
  for (const s of scopes) print({ brand: s.brand, category: s.category, judges: s.judges.map(j => ({ judge: j.judgeModel, ...j.atDefault, sweptThreshold: j.sweptThreshold, costPerCheck: j.costPerCheck, msPerCheck: j.msPerCheck })), mattes: s.mattes, ranking: s.matteRanking, row: s.row, labelerDisagreements: s.disagreements });
  const policies = await db.select().from(modelPolicy);
  print({ reEvaluate: policies.filter(p => p.source === "pending").map(p => ({ brand: p.brandSlug, category: p.category, todo: "assemble sources for this brand, label, run, policy write" })) });
  for (const p of policies) if (p.source === "bakeoff" && candidatesChanged(p, seen)) print(`candidates changed since the policy row was written: ${p.brandSlug}/${p.category} (updated ${p.updatedAt.toISOString()})`);
  if (flags.live) print({ liveDrift: await liveDrift(db) });
}

async function policyWrite(db: Db, flags: Record<string, string | true>) {
  need(flags, "set");
  const { scopes } = await scored(db, flags);
  const rows = scopes.flatMap(s => s.row ? [s.row] : []);
  const result = await writePolicyRows(db, rows, flags["dry-run"] === true);
  print({ dryRun: flags["dry-run"] === true, rows: result.map(r => ({ ...r.row, outcome: r.outcome, previousSource: r.previousSource })) });
}

async function report(db: Db, flags: Record<string, string | true>) {
  const set = need(flags, "set"), id = runId();
  const { rows, scopes, deps } = await scored(db, flags);
  const health = await deps.matting.health();
  const measured = new Set(rows.outputs.map(o => o.matteModel));
  const notRun = matteModelsFor("primary").filter(m => !measured.has(m)).map(model => {
    const choice = chooseService(model, health.models, !!process.env.MATTING_GPU_URL);
    return { model, reason: choice.ok ? "not run: no eval batch in this report" : choice.reason };
  });
  const judgedUsd = rows.judgements.reduce((a, j) => a + j.costUsd, 0);
  const batchUsd = rows.batches.reduce((a, b) => a + b.cost.qaUsd + b.cost.computeUsd, 0);
  const products = new Set((await db.select({ productId: catalogOutputs.productId }).from(catalogOutputs).where(and(inArray(catalogOutputs.batchId, rows.batches.map(b => b.id)), sql`${catalogOutputs.status} <> 'skipped'`))).map(r => r.productId)).size;
  const written = (await db.select().from(modelPolicy)).filter(p => p.source === "bakeoff" && p.evalBatchIds.some(b => rows.batches.some(x => x.id === b)));
  const inr = Number(process.env.INR_PER_USD);
  const input = { set, runId: id, batchIds: rows.batches.map(b => b.id), scopes, notRun, cost: { usd: judgedUsd + batchUsd, products, inrPerUsd: Number.isFinite(inr) && inr > 0 ? inr : null }, policyRows: written.map(p => ({ brandSlug: p.brandSlug, category: p.category, outcome: "written" })), commands: [`catalog:eval ${process.argv.slice(2).join(" ")}`] };
  const html = await storage.uploadBuffer(reportPath(set, id, "html"), Buffer.from(reportHtml(input)), "text/html");
  const json = await storage.uploadBuffer(reportPath(set, id, "json"), Buffer.from(JSON.stringify(reportJson(input), null, 2)), "application/json");
  print({ html, json, signedUrl: await storage.signedUrl(html), brandsWaitingForImages: WAITING_BRANDS });
}

async function main() {
  const { words, flags } = parseArgs(process.argv.slice(2));
  const command = words.join(" ");
  if (!command || command === "help") { print(USAGE); return; }
  if (command === "assemble") return assemble(flags);
  if (command === "experiment") { print(`not run: the ${String(flags.name ?? "")} experiment is deferred in this build${flags.name === "sr_pass" && !process.env.MATTING_GPU_URL ? " (and it needs MATTING_GPU_URL)" : ""}.`); return; }
  const db = getDb();
  try {
    if (command === "run") await runEval(db, flags);
    else if (command === "judges") await judges(db, flags);
    else if (command === "contact-sheet") await contactSheet(db, flags);
    else if (command === "labels export") await labelsExport(db, flags);
    else if (command === "score") await score(db, flags);
    else if (command === "policy write") await policyWrite(db, flags);
    else if (command === "report") await report(db, flags);
    else if (command === "cleanup") { const ids = list(need(flags, "batches")); await evalBatches(db, ids); print({ cleanup: await cleanupTestBatches(db, storage, ids) }); }
    else { print(USAGE); process.exitCode = 2; }
  } finally { await closeDb(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
