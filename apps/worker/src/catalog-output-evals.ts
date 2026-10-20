// Spec 10: the output-quality eval suite, run as the Cloud Run job `catalog-output-evals` from the
// worker image (infra/catalog-output-evals.sh) or locally for the pure-image modes. `run` pushes the
// golden set through the shipped pipeline handlers (real storage, matting and public reads, test
// batches only), measures every output against the spec 10 bars, scores every deployed cut-out model
// on the golden categories, and writes report.json and report.html under catalog-test/evals/<run>/.
// Each (brand, category) set is recorded under catalog-test/evals/<run>/sets/ as soon as it finishes,
// so `run --resume <run>` continues after a failure instead of starting over.
// The judge is mocked unless LIVE_SMOKE=1 (set by the infra script for one execution). Model ids
// appear in the JSON report and the console only, never in operator copy.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { and, eq, inArray, like } from "drizzle-orm";
import { closeDb, getDb, type Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages, catalogUploads, DEFAULT_BATCH_OPTIONS, modelPolicy, type CatalogBatch, type CatalogOutput } from "@catalog/core/db/schema";
import { runIngest } from "@catalog/core/catalog/ingest/index";
import { batchPrefix, productPrefix, assertTestPrefix } from "@catalog/core/catalog/naming";
import { lockProducts } from "@catalog/core/catalog/products";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { PUBLIC_CACHE_WINDOW_MS } from "@catalog/core/catalog/pipeline/verify";
import { readSheetLinks } from "@catalog/core/catalog/recheck/links";
import { cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import { CHANNELS } from "@catalog/core/catalog/channels";
import { bbox, planCanvas, planProduct, prepare, shotGeometry, type Prepared } from "@catalog/core/catalog/render";
import { matteFor } from "@catalog/core/catalog/matte";
import { QA_DEFAULT_THRESHOLD } from "@catalog/core/catalog/qa/judge";
import { writePolicyRows } from "@catalog/core/catalog/eval/policy-writer";
import { qaCandidates } from "@catalog/core/catalog/eval/run";
import { CHANNEL_IDS, type ChannelId, type OutputFlag, type ProductType } from "@catalog/core/catalog/types";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { assertLocked, checkAttention, checkCompleteness, checkIdentical, checkOverwrite, checkUniformScale, flagRows, outputKey, overwriteFailed, overwriteNotRun, planOverwrite, runImageChecks, type CheckResult, type Expectation, type OutputSubject } from "@catalog/core/catalog/evals/index";
import { checkMatte, consensusMetrics } from "@catalog/core/catalog/evals/cutout";
import { sheetNotes } from "@catalog/core/catalog/evals/sheet-notes";
import { buildGolden, GOLDEN_MANIFEST_PATH, goldenCounts, goldenSourcePath, parseGolden, readGoldenBytes, serializeGolden, sha256, type GoldenBuild, type GoldenEntry, type GoldenManifest } from "@catalog/core/catalog/evals/golden";
import { policyRowsFor, winnersByScope } from "@catalog/core/catalog/evals/matte-bakeoff";
import { EVALS_PREFIX, parseSetRecord, parseSetsFlag, RUN_ID_PATTERN, selectSets, serializeSetRecord, setId, setRecordPath, setsPrefix, withEvalRetry, type SetRecord } from "@catalog/core/catalog/evals/progress";
import { buildReport, reportHtml, type ReportThumb } from "@catalog/core/catalog/evals/report";
import { buildZip } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { workerCatalogDeps, type CatalogDeps } from "./catalog/deps";
import { handleChunkTask } from "./catalog/chunk";
import { handlePublishTask } from "./catalog/publish";
import { handleFinalizeTask } from "./catalog/finalize";
import { cannedQa, liveQaEnabled } from "./catalog/qa-mock";
import { changeOnePixel } from "./catalog-real-fixtures";

const USAGE = `Usage: catalog:output-evals <command>
  build-golden [--build <golden-build.json>] [--out <golden-manifest.json>] [--root name=path ...]
  upload [--manifest <golden-manifest.json>] [--root name=path ...]      (copies the pinned photos under catalog-test/evals/golden/)
  run [--resume <run>] [--sets <brand.category,...>] [--limit <products>] [--brand <slug>] [--bakeoff-sample <n>] [--skip-bakeoff] [--skip-overwrite] [--write-policy]
      (--resume continues a run from its recorded sets; --sets runs only the named sets, for example anta.footwear)
  check-folder --dir <root> --product-type <type> [--only <ids>] [--out <dir>]   (raw/, mattes/, outputs/<product>/<channel>/ layout; no GCP)`;
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/core/test-fixtures/catalog/evals");
/** Every direct storage call of the eval path retries transient network errors (five attempts). */
const gcs = withEvalRetry(storage);

function parseArgs(argv: string[]) {
  const words: string[] = [], flags: Record<string, string | string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { words.push(a); continue; }
    const key = a.slice(2), next = argv[i + 1];
    const value: string | true = next === undefined || next.startsWith("--") ? true : (i++, next);
    const prior = flags[key];
    flags[key] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [String(prior)]), String(value)];
  }
  return { words, flags };
}
const str = (v: string | string[] | true | undefined) => (typeof v === "string" ? v : undefined);
const print = (value: unknown) => console.info(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const runId = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
function rootsFrom(flags: Record<string, string | string[] | true>, base: Record<string, string>): Record<string, string> {
  const list = flags.root === undefined ? [] : Array.isArray(flags.root) ? flags.root : [String(flags.root)];
  const out = { ...base };
  for (const item of list) { const [name, ...rest] = item.split("="); assert(name && rest.length, `--root needs name=path, got ${item}`); out[name] = rest.join("="); }
  return out;
}

async function buildGoldenCommand(flags: Record<string, string | string[] | true>) {
  const buildFile = str(flags.build) ?? path.join(FIXTURES, "golden-build.json"), outFile = str(flags.out) ?? path.join(FIXTURES, "golden-manifest.json");
  const build = JSON.parse(await readFile(buildFile, "utf8")) as GoldenBuild;
  build.roots = rootsFrom(flags, build.roots);
  const derivedDir = build.roots.derived;
  assert(derivedDir, "The build needs a `derived` root for the derived hard cases.");
  await mkdir(derivedDir, { recursive: true });
  const manifest = await buildGolden(build, async (name, bytes) => { await writeFile(path.join(derivedDir, name), bytes); return name; });
  await writeFile(outFile, serializeGolden(manifest));
  print({ manifest: outFile, ...goldenCounts(manifest) });
}

async function readLocalManifest(flags: Record<string, string | string[] | true>): Promise<GoldenManifest> {
  const file = str(flags.manifest) ?? path.join(FIXTURES, "golden-manifest.json");
  const manifest = parseGolden(await readFile(file, "utf8"));
  manifest.roots = rootsFrom(flags, manifest.roots);
  return manifest;
}

async function uploadCommand(flags: Record<string, string | string[] | true>) {
  const manifest = await readLocalManifest(flags);
  let uploaded = 0, kept = 0;
  for (const entry of manifest.entries) {
    const objectPath = goldenSourcePath(entry);
    assertTestPrefix(objectPath);
    const bytes = await readGoldenBytes(manifest, entry);
    const head = await gcs.headObject(storage.toGsUri(storage.getBucketName(), objectPath));
    if (head.exists && head.size === bytes.length) { kept++; continue; }
    await gcs.uploadBuffer(objectPath, bytes, entry.mime);
    uploaded++;
  }
  await gcs.uploadBuffer(GOLDEN_MANIFEST_PATH, Buffer.from(serializeGolden(manifest)), "application/json");
  print({ uploaded, kept, manifest: `gs://${storage.getBucketName()}/${GOLDEN_MANIFEST_PATH}`, ...goldenCounts(manifest) });
}

interface Group { brand: string; brandName: string; category: Exclude<ProductType, "auto">; entries: GoldenEntry[] }
interface BatchRun { batch: CatalogBatch; group: Group; products: Map<string, { id: string; pathKey: string; productType: string | null; change: string | null }>; sources: (typeof catalogSourceImages.$inferSelect)[]; outputs: CatalogOutput[]; xlsx: Buffer; report: Record<string, unknown> }

const BRAND_NAMES: Record<string, string> = { anta: "Anta", french_connection: "French Connection", penti: "Penti", vero_moda: "Vero Moda", test_brand: "Test Brand" };
const batchName = (run: string, group: Group, label: string) => `catalog-test output-evals ${run} ${group.category} ${label}`;

/** Runs one test batch through ingest, matte, render, qa, publish and finalize with the shipped handlers. */
async function runBatch(db: Db, deps: CatalogDeps, run: string, group: Group, files: { path: string; data: Buffer }[], channels: ChannelId[], label: string): Promise<CatalogBatch> {
  const [created] = await db.insert(catalogBatches).values({ brandSlug: group.brand, brandName: group.brandName, name: batchName(run, group, label), isTest: true, createdBy: "catalog-output-evals@opptra.com", productType: group.category, channels, options: { ...DEFAULT_BATCH_OPTIONS, qaCapUsd: null } }).returning();
  const b = created!, prefix = batchPrefix(b.brandSlug, b.id, true);
  const uri = await gcs.uploadBuffer(`${prefix}/uploads/${randomUUID()}/photos.zip`, buildZip(files), "application/zip");
  const [upload] = await db.insert(catalogUploads).values({ batchId: b.id, kind: "zip", name: "photos.zip", gcsUri: uri, status: "uploaded" }).returning();
  const queue: Record<string, unknown>[] = [{ batchId: b.id, uploadId: upload!.id }];
  while (queue.length) {
    const result = await runIngest(db, { storage, fetch: pinnedFetch, enqueue: async (_route, next) => { queue.push(next); return "evals-inline"; } }, queue.shift() as { batchId: string; uploadId: string; cursor?: string });
    assert(!["failed", "not_found"].includes(result.outcome), `Ingest failed: ${result.outcome}`);
  }
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, b.id));
  assert.equal(sources.length, files.length, "Every golden photo must be collected.");
  const productIds = [...new Set(sources.map(s => s.productId))];
  assertLocked(await lockProducts(db, b.id, productIds));
  await db.update(catalogBatches).set({ status: "matting", startedAt: new Date(), counts: { ...b.counts, products: productIds.length, sources: sources.length, outputs: sources.length * channels.length } }).where(eq(catalogBatches.id, b.id));
  for (const [index, plan] of planChunks(productIds.map(productId => ({ productId, sourceCount: sources.filter(s => s.productId === productId).length })), 25).entries()) {
    const [chunk] = await db.insert(catalogChunks).values({ batchId: b.id, index, stage: "matte", productIds: plan.productIds }).returning();
    for (let stage = 0; stage < 3; stage++) assert.equal((await handleChunkTask(deps, { chunkId: chunk!.id })).httpStatus, 200, "A chunk stage failed.");
    for (const productId of plan.productIds) await handlePublishTask(deps, { batchId: b.id, productId });
  }
  const finalize = await handleFinalizeTask(deps, { batchId: b.id });
  assert.equal(finalize.outcome, "done", `Finalize did not finish: ${finalize.outcome}`);
  return (await db.select().from(catalogBatches).where(eq(catalogBatches.id, b.id)))[0]!;
}

async function collect(db: Db, batch: CatalogBatch, group: Group): Promise<BatchRun> {
  const pairs = await db.select({ pair: catalogBatchProducts, product: catalogProducts }).from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, batch.id));
  const products = new Map(pairs.map(({ pair, product }) => [product.id, { id: product.id, pathKey: product.pathKey, productType: product.productType, change: pair.change }]));
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batch.id));
  const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batch.id));
  const xlsx = (await gcs.downloadBuffer(batch.sheetXlsxUri!)).buf, report = JSON.parse((await gcs.downloadBuffer(batch.reportUri!)).buf.toString()) as Record<string, unknown>;
  return { batch, group, products, sources, outputs, xlsx, report };
}

/** Bounded concurrency over a list. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!, i); } }));
  return out;
}

/** Contact-sheet size, so a set record stays small and the HTML report needs no original bytes. */
const shrink = (bytes: Buffer): Promise<Buffer | null> => sharp(bytes).resize(240, 320, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer().catch(() => null);

/**
 * Removes every test batch this run made for the set (both overwrite passes included) and checks
 * that no public object of its products is left. Also called before a set runs, so a crashed earlier
 * attempt of the same run never leaves locked products or stray objects behind.
 */
async function cleanupSetBatches(db: Db, run: string, group: Group): Promise<void> {
  const rows = await db.select().from(catalogBatches).where(and(eq(catalogBatches.brandSlug, group.brand), eq(catalogBatches.isTest, true), like(catalogBatches.name, `${batchName(run, group, "")}%`)));
  const batchIds = rows.filter(b => !b.options.cleanedUp).map(b => b.id);
  if (!batchIds.length) return;
  const owned = await db.select({ brandSlug: catalogProducts.brandSlug, pathKey: catalogProducts.pathKey }).from(catalogProducts).innerJoin(catalogBatchProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(inArray(catalogBatchProducts.batchId, batchIds));
  const cleanup = await cleanupTestBatches(db, storage, batchIds);
  for (const product of owned) assert.deepEqual(await gcs.listObjects(storage.toGsUri(storage.getPublicBucketName(), productPrefix(product.brandSlug, product.pathKey, true))), [], `Cleanup left public objects for ${product.pathKey}.`);
  console.info(JSON.stringify({ set: setId(group.brand, group.category), batches: batchIds.length, cleanup }));
}

interface RunContext {
  db: Db; deps: CatalogDeps; run: string; channels: ChannelId[];
  expectOf: Map<string, Expectation>; plantedOf: Map<string, { n: number; from: string }>;
  work: { matte: number; render: number; copy: number };
  /** Deployed cut-out models for the bake-off; empty with --skip-bakeoff. */
  models: { id: string; target: "cpu" | "gpu" }[]; bakeoffSample: number;
  skipOverwrite: boolean; overwriteDone: boolean;
}

/**
 * One (brand, category) set end to end: its test batch, the completeness and image checks, the
 * overwrite contract when it is the first eligible set, the bake-off trials, then cleanup. A failure
 * anywhere makes a "failed" record (with the error, no results) instead of ending the run, except in
 * the overwrite passes: the record then keeps the first-pass checks and only the overwrite checks
 * are recorded as failed.
 */
async function runSet(ctx: RunContext, group: Group): Promise<SetRecord> {
  const { db, deps, run, channels } = ctx, set = setId(group.brand, group.category), startedAt = new Date();
  const record: SetRecord = { set, brand: group.brand, category: group.category, status: "done", error: null, startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), photos: group.entries.length, products: new Set(group.entries.map(e => e.identifier)).size, results: [], thumbs: [], deterministicPass: [], attentionRows: [], attentionProducts: [], trials: [], overwriteRan: false, batches: [] };
  const strip = (identifier: string) => identifier.startsWith(`${run}-`) ? identifier.slice(run.length + 1) : identifier;
  const deterministicPass = new Set<string>(), prepared = new Map<string, { p: Prepared; alpha: Buffer; entry: GoldenEntry }>();
  try {
    await cleanupSetBatches(db, run, group);
    const files = await mapLimit(group.entries, 4, async e => ({ path: `${run}-${e.identifier}_${e.n}.${e.source.path.split(".").pop()!.toLowerCase()}`, data: (await gcs.downloadBuffer(storage.toGsUri(storage.getBucketName(), goldenSourcePath(e)))).buf }));
    console.info(`evals: ${set}: ${files.length} photos, ${record.products} products`);
    const batch = await runBatch(db, deps, run, group, files, channels, "first");
    record.batches.push(batch.id);
    const collected = await collect(db, batch, group);
    const { products, sources, outputs, xlsx } = collected;
    const identifierOf = (productId: string) => strip(products.get(productId)?.pathKey ?? "");

    // Completeness over rows, public objects, staged files and the sheet.
    const publicHeads = new Map<string, Awaited<ReturnType<typeof storage.headObject>>>(), stagingHeads = new Map<string, Awaited<ReturnType<typeof storage.headObject>>>();
    await mapLimit(outputs, 8, async o => {
      if (o.status !== "skipped") publicHeads.set(o.publicUrl, await gcs.headObject(storage.toGsUri(storage.getPublicBucketName(), o.objectPath)));
      if (o.stagingUri) stagingHeads.set(o.stagingUri, await gcs.headObject(o.stagingUri));
    });
    const links = await readSheetLinks(xlsx), notes = await sheetNotes(xlsx);
    record.results.push(...checkCompleteness({
      channels, sources: sources.map(s => ({ identifier: identifierOf(s.productId), n: s.n, width: s.width, height: s.height })),
      outputs: outputs.map(o => ({ identifier: identifierOf(o.productId), n: o.n, channel: o.channel, status: o.status, isLive: o.isLive, reason: o.reason, generation: o.generation, bytes: o.bytes, crc32c: o.crc32c, publicUrl: o.publicUrl, stagingUri: o.stagingUri })),
      publicHeads, stagingHeads, sheet: links.links.map(l => ({ identifier: strip(l.identifier), channel: l.channel, n: l.n, url: l.url })),
      sheetNotes: new Map([...notes].map(([id, note]) => [strip(id), note])), counts: { outputs: batch.counts.outputs, verified: batch.counts.verified, skipped: batch.counts.skipped, recheckOk: batch.counts.recheckOk, recheckTotal: batch.counts.recheckTotal },
    }));

    // Image checks on every made output.
    const byProduct = new Map<string, { n: number; scale: number; detailShot: boolean }[]>();
    await mapLimit(sources, 3, async source => {
      const identifier = identifierOf(source.productId), entry = group.entries.find(e => e.identifier === identifier && e.n === source.n);
      if (!entry || !source.matteUri) return;
      const raw = (await gcs.downloadBuffer(source.rawUri)).buf;
      const p = await prepare(raw, source.originalName, b => deps.matting.convert(b));
      const alpha = await sharp((await gcs.downloadBuffer(source.matteUri)).buf).toColourspace("b-w").raw().toBuffer();
      prepared.set(`${identifier}_${source.n}`, { p, alpha, entry });
      const box = bbox(alpha, p.width, p.height);
      for (const o of outputs.filter(o => o.sourceImageId === source.id && o.stagingUri)) {
        const jpeg = (await gcs.downloadBuffer(o.stagingUri!)).buf;
        const subject: OutputSubject = { identifier, n: source.n, channel: o.channel, productType: (products.get(source.productId)?.productType ?? group.category) as ProductType, source: { w: p.width, h: p.height, rgb: p.rgb }, sourceBackground: p.background, alpha, jpeg, placement: { w: o.canvasW, h: o.canvasH, scale: Number(o.scale), placedX: o.placedX, placedY: o.placedY }, flags: o.flags, status: o.status, expect: entry.expect };
        const checks = await runImageChecks(subject);
        record.results.push(...checks);
        if (checks.every(c => c.ok)) deterministicPass.add(outputKey(identifier, o.channel, source.n));
        if (checks.some(c => !c.ok)) record.thumbs.push({ identifier, n: source.n, channel: o.channel, original: await shrink(raw), output: await shrink(jpeg) });
        if (o.channel === "styli" && box) byProduct.set(identifier, [...byProduct.get(identifier) ?? [], { n: source.n, scale: Number(o.scale), detailShot: box.w / p.width > 0.85 || box.h / p.height > 0.85 }]);
      }
    });
    for (const [identifier, shots] of byProduct) record.results.push(checkUniformScale(identifier, shots));
    record.deterministicPass = [...deterministicPass];

    // Rows for the attention checks and the flag table.
    for (const o of outputs) record.attentionRows.push({ identifier: identifierOf(o.productId), n: o.n, channel: o.channel, status: o.status, flags: o.flags, reason: o.reason, qaScores: o.qaScores, qaModel: o.qaModel, decision: o.decision, compliance: o.compliance as { ok: boolean; failures: string[] } | null });
    for (const [, product] of products) { const identifier = strip(product.pathKey); record.attentionProducts.push({ identifier, change: product.change, productType: product.productType, expect: ctx.expectOf.get(identifier) ?? { attention: false, flags: [], detector: "code" }, planted: ctx.plantedOf.get(identifier) ?? null }); }

    // Overwrite contract on the first set with a product of three or more shots. Its passes re-upload
    // the released products only (a held product keeps its batch lock); a failure inside them keeps
    // the checks above and marks the overwrite checks failed.
    if (!ctx.skipOverwrite && !ctx.overwriteDone && [...sources.reduce((m, s) => m.set(s.productId, (m.get(s.productId) ?? 0) + 1), new Map<string, number>()).values()].some(n => n >= 3)) {
      try {
        const overwrite = await overwritePasses(db, deps, run, collected, ctx.work, record.batches);
        record.results.push(...overwrite.results);
        if (overwrite.ran) { record.overwriteRan = true; ctx.overwriteDone = true; }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`evals: ${set} overwrite passes failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        record.results.push(...overwriteFailed(message));
        record.status = "failed";
        record.error = record.error ? `${record.error}; overwrite: ${message}` : `overwrite: ${message}`;
      }
    }

    // Matting bake-off: every deployed model on a sample of this set's sources.
    const keys = [...new Set(group.entries.filter(e => !e.planted).map(e => `${e.identifier}_${e.n}`))].filter(k => prepared.has(k)).slice(0, ctx.bakeoffSample);
    // Every model mattes each sampled source; the metrics compare each matte with the source colours
    // and with the majority of the other models, so models that all pass the bars still separate.
    if (ctx.models.length) await mapLimit(keys, 3, async k => {
      const { p, entry } = prepared.get(k)!, mattes: { model: string; target: "cpu" | "gpu"; ms: number; alpha: Buffer }[] = [];
      await mapLimit(ctx.models, ctx.models.length, async m => {
        try { const matte = await matteFor(p, deps.matting, m.id); mattes.push({ model: m.id, target: matte.target ?? m.target, ms: matte.ms, alpha: matte.alpha }); }
        catch (error) { console.info(JSON.stringify({ message: "bakeoff matte failed", model: m.id, source: k, error: error instanceof Error ? error.message : String(error) })); }
      });
      for (const matte of mattes) {
        const { results: r, metrics } = checkMatte({ identifier: entry.identifier, n: entry.n, source: { w: p.width, h: p.height, rgb: p.rgb }, sourceBackground: p.background, alpha: matte.alpha });
        const consensus = consensusMetrics(matte.alpha, mattes.filter(o => o !== matte).map(o => o.alpha));
        record.trials.push({ brand: group.brand, category: group.category, identifier: entry.identifier, n: entry.n, model: matte.model, target: matte.target, ms: matte.ms, results: r, metrics: { ...metrics, ...consensus }, tags: entry.tags });
      }
    });
  } catch (error) {
    failSet(record, error);
  } finally {
    try { await cleanupSetBatches(db, run, group); } catch (error) { failSet(record, error, "cleanup"); }
  }
  record.finishedAt = new Date().toISOString();
  return record;
}

/** Marks the record failed and drops its partial results; the report lists the set with its error. */
function failSet(record: SetRecord, error: unknown, stage?: string): void {
  const message = `${stage ? `${stage}: ` : ""}${error instanceof Error ? error.message : String(error)}`;
  console.error(`evals: ${record.set} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  record.status = "failed";
  record.error = record.error ? `${record.error}; ${message}` : message;
  record.results = []; record.thumbs = []; record.deterministicPass = []; record.attentionRows = []; record.attentionProducts = []; record.trials = []; record.overwriteRan = false;
}

async function runCommand(db: Db, flags: Record<string, string | string[] | true>) {
  const resume = flags.resume === undefined ? undefined : str(flags.resume);
  assert(flags.resume === undefined || (resume && RUN_ID_PATTERN.test(resume)), "--resume needs the run id printed at the start of the earlier run, for example evals-20261020013422-a1b2c3.");
  const run = resume ?? `evals-${runId()}`, live = liveQaEnabled();
  console.info(`Run id: ${run}${resume ? " (resumed)" : ""}. If this run stops early, continue it with: run --resume ${run}`);
  const out = path.resolve(process.env.CATALOG_REAL_OUT ?? `var/catalog-test/${run}`);
  await mkdir(out, { recursive: true });
  const manifest = parseGolden((await gcs.downloadBuffer(storage.toGsUri(storage.getBucketName(), GOLDEN_MANIFEST_PATH))).buf.toString("utf8"));
  const limit = flags.limit ? Number(flags.limit) : Infinity, brandFilter = str(flags.brand);
  const base = workerCatalogDeps(db), work = { matte: 0, render: 0, copy: 0 };
  const deps: CatalogDeps = { ...base, ...(live ? {} : cannedQa), enqueue: async () => "evals-inline", log: (message, fields) => console.info(JSON.stringify({ message, ...fields })),
    matteFor: async (...args) => { work.matte++; return base.matteFor(...args); }, renderAllChannels: async (...args) => { work.render++; return base.renderAllChannels(...args); },
    storage: { ...storage, stageCopyToPublic: async (...args) => { work.copy++; return storage.stageCopyToPublic(...args); } } };
  const expectOf = new Map<string, Expectation>(), plantedOf = new Map<string, { n: number; from: string }>();
  for (const e of manifest.entries) { expectOf.set(e.identifier, e.expect); if (e.planted) plantedOf.set(e.identifier, { n: e.n, from: e.planted.from }); }
  // Sets: one test batch per (brand, category); the product type is forced so the shadow rule follows the golden category.
  const groups = new Map<string, Group>();
  for (const e of manifest.entries) {
    if (brandFilter && e.brand !== brandFilter) continue;
    const key = setId(e.brand, e.category);
    groups.set(key, groups.get(key) ?? { brand: e.brand, brandName: BRAND_NAMES[e.brand] ?? e.brand, category: e.category, entries: [] });
    groups.get(key)!.entries.push(e);
  }
  if (Number.isFinite(limit)) for (const g of groups.values()) { const ids = [...new Set(g.entries.map(e => e.identifier))].slice(0, limit); g.entries = g.entries.filter(e => ids.includes(e.identifier)); }
  const all = [...groups.keys()];

  // Progress already recorded under this run id (a resume), then the sets left to run.
  const stored = new Map<string, SetRecord>();
  if (resume) {
    for (const uri of await gcs.listObjects(storage.toGsUri(storage.getBucketName(), setsPrefix(run)))) {
      if (!uri.endsWith(".json")) continue;
      const record = parseSetRecord((await gcs.downloadBuffer(uri)).buf.toString("utf8"));
      stored.set(record.set, record);
    }
  }
  const only = flags.sets === undefined ? undefined : parseSetsFlag(str(flags.sets) ?? "", all);
  const { run: todo, skipped } = selectSets(all, stored, only);
  console.info(`evals: ${todo.length} set(s) to run${todo.length ? ` (${todo.join(", ")})` : ""}${skipped.length ? `; ${skipped.length} already done in ${run} (${skipped.join(", ")})` : ""}`);
  const models = flags["skip-bakeoff"] ? [] : [...new Map((await deps.matting.health()).models.map(m => [m.id, m])).values()].map(m => ({ id: m.id, target: m.target }));
  const ctx: RunContext = { db, deps, run, channels: [...CHANNEL_IDS], expectOf, plantedOf, work, models, bakeoffSample: Number(str(flags["bakeoff-sample"]) ?? 40), skipOverwrite: flags["skip-overwrite"] === true, overwriteDone: [...stored.values()].some(r => r.status === "done" && r.overwriteRan) };
  for (const id of todo) {
    const record = await runSet(ctx, groups.get(id)!);
    stored.set(id, record);
    const objectPath = setRecordPath(run, id);
    assertTestPrefix(objectPath);
    await gcs.uploadBuffer(objectPath, Buffer.from(serializeSetRecord(record)), "application/json");
    console.info(`evals: ${id}: ${record.status}${record.error ? ` (${record.error})` : ""}; ${record.results.length} checks recorded at gs://${storage.getBucketName()}/${objectPath}`);
  }

  // The report, from every record of the run (stored and new), in manifest order.
  const order = (set: string) => (all.includes(set) ? all.indexOf(set) : Infinity);
  const records = [...stored.values()].sort((a, b) => order(a.set) - order(b.set) || a.set.localeCompare(b.set));
  const results = records.flatMap(r => r.results), thumbs = records.flatMap(r => r.thumbs), trials = records.flatMap(r => r.trials), batchIds = records.flatMap(r => r.batches);
  const attentionRows = records.flatMap(r => r.attentionRows), attentionProducts = records.flatMap(r => r.attentionProducts), deterministicPass = new Set(records.flatMap(r => r.deterministicPass));
  const failedSets = records.filter(r => r.status === "failed");
  const winners = winnersByScope(trials);
  const existing = await db.select().from(modelPolicy);
  const policyRows = policyRowsFor(winners, { batchIds, seen: { matte: trials.length ? [...new Map(trials.map(t => [`${t.model}|${t.target}`, { id: t.model, target: t.target }])).values()] : [], judges: qaCandidates() }, existing });
  const written = policyRows.length ? await writePolicyRows(db, policyRows, flags["write-policy"] !== true) : [];

  const attention = checkAttention({ products: attentionProducts, outputs: attentionRows, deterministicPass, liveJudge: live, threshold: QA_DEFAULT_THRESHOLD });
  results.push(...attention.results);
  const counts = goldenCounts(manifest);
  const startedAt = new Date(Math.min(Date.now(), ...records.map(r => Date.parse(r.startedAt))));
  const report = buildReport({ run, startedAt, finishedAt: new Date(), mode: live ? "live judge" : "mocked judge (LIVE_SMOKE is not 1)", golden: { products: counts.products, photos: counts.photos, brands: counts.brands, categories: counts.categories, tags: counts.tags }, results, attention, flags: flagRows(attentionRows, QA_DEFAULT_THRESHOLD), batches: batchIds, includeAll: true });
  const sets = records.map(r => ({ set: r.set, status: r.status, error: r.error, photos: r.photos, products: r.products, checks: r.results.length, overwriteRan: r.overwriteRan, startedAt: r.startedAt, finishedAt: r.finishedAt }));
  const full = { ...report, sets, matteBakeoff: { trials: trials.length, winners, policyRows: written.map(w => ({ brand: w.row.brandSlug, category: w.row.category, matteModel: w.row.matteModel, outcome: flags["write-policy"] === true ? w.outcome : `dry run (${w.outcome})` })) } };
  const html = await reportHtml(report, thumbs) + setsHtml(sets) + bakeoffHtml(winners, flags["write-policy"] === true);
  await writeFile(path.join(out, "report.json"), JSON.stringify(full, null, 1));
  await writeFile(path.join(out, "report.html"), html);
  for (const [name, body, mime] of [["report.json", JSON.stringify(full), "application/json"], ["report.html", html, "text/html"]] as const) { const objectPath = `${EVALS_PREFIX}/${run}/${name}`; assertTestPrefix(objectPath); await gcs.uploadBuffer(objectPath, Buffer.from(body), mime); }
  console.info(report.summary.line);
  console.info(`Report: gs://${storage.getBucketName()}/${EVALS_PREFIX}/${run}/report.html (also ${out})`);
  for (const w of winners) console.info(`matte bake-off ${w.brand}/${w.category}: ${w.winner ? `${w.winner.model} (composite ${w.winner.composite.toFixed(4)}, fail rate ${(w.winner.failRate * 100).toFixed(0)}%)` : "no trials"}${w.runnerUp ? `, runner-up ${w.runnerUp.model}, margin ${w.margin}` : ""} over ${w.sources} sources`);
  if (failedSets.length) console.error(`evals: ${failedSets.length} set(s) failed (${failedSets.map(r => r.set).join(", ")}); re-run them with: run --resume ${run}`);
  if (!report.summary.passedAll || failedSets.length) process.exitCode = 1;
}

function setsHtml(sets: { set: string; status: string; error: string | null; photos: number; products: number; checks: number; overwriteRan: boolean; startedAt: string; finishedAt: string }[]): string {
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const rows = sets.map(s => `<tr><td>${esc(s.set)}</td><td class="${s.status === "done" ? "ok" : "bad"}">${esc(s.status)}</td><td>${s.photos}</td><td>${s.products}</td><td>${s.checks}</td><td>${s.overwriteRan ? "yes" : ""}</td><td>${esc(s.startedAt)}</td><td>${esc(s.finishedAt)}</td><td>${esc(s.error ?? "")}</td></tr>`);
  return `<h2>Sets (${sets.length})</h2><p>One test batch per brand and category. A set that failed before its checks carries none; one whose overwrite passes failed keeps its first-pass checks. Re-run a failed set with <code>run --resume &lt;run&gt;</code>.</p><table><thead><tr><th>Set</th><th>Status</th><th>Photos</th><th>Products</th><th>Checks</th><th>Overwrite</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead><tbody>${rows.join("") || "<tr><td colspan=9>No sets.</td></tr>"}</tbody></table>`;
}

function bakeoffHtml(winners: ReturnType<typeof winnersByScope>, written: boolean): string {
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(2)}%`);
  const rows = winners.flatMap(w => w.ranking.map((m, i) => `<tr><td>${esc(w.brand)}</td><td>${esc(w.category)}</td><td>${i + 1}</td><td>${esc(m.model)} (${m.target})</td><td>${m.sources}</td><td>${pct(m.failRate)}</td><td>${pct(m.hardCaseFailRate)}</td><td>${pct(m.regionLoss)}</td><td>${pct(m.thinLoss)}</td><td>${pct(m.backgroundKept)}</td><td>${pct(m.seeThrough)}</td><td>${m.holes}</td><td>${m.edgeSoftness === null ? "n/a" : m.edgeSoftness.toFixed(2)}</td><td>${pct(m.consensusLoss)}</td><td>${pct(m.consensusExtra)}</td><td>${m.composite.toFixed(4)}</td><td>${Math.round(m.msPerImage)}</td><td>${i === 0 && w.margin !== null ? w.margin : ""}</td></tr>`));
  return `<h2>Cut-out model bake-off</h2><p>Every deployed cut-out model on the golden sources of each category, scored with the cut-out integrity checks. Rank 1 is the winner; the margin is the runner-up's composite minus the winner's. Policy rows ${written ? "were written" : "were planned (dry run; pass --write-policy to write them)"}.</p><table><thead><tr><th>Brand</th><th>Category</th><th>Rank</th><th>Model</th><th>Sources</th><th>Fail rate</th><th>Hard-case fail rate</th><th>Region loss</th><th>Thin loss</th><th>Background kept</th><th>See-through</th><th>Holes</th><th>Edge softness px</th><th>Consensus loss</th><th>Consensus extra</th><th>Composite</th><th>ms</th><th>Margin</th></tr></thead><tbody>${rows.join("") || "<tr><td colspan=18>No trials.</td></tr>"}</tbody></table>`;
}

/**
 * Identical re-upload, then one photo altered and one shot dropped with Amazon unselected. Only the
 * products the first pass released take part: a product held for attention keeps its batch lock
 * (finalize releases completed products only), so re-ingesting it would fail the lock of the new
 * batch. With no released candidate the checks are recorded as not run with the reason.
 */
async function overwritePasses(db: Db, deps: CatalogDeps, run: string, first: BatchRun, work: { matte: number; render: number; copy: number }, batchIds: string[]): Promise<{ ran: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [], strip = (identifier: string) => identifier.startsWith(`${run}-`) ? identifier.slice(run.length + 1) : identifier;
  const identifierOf = (productId: string) => strip(first.products.get(productId)?.pathKey ?? "");
  const planned = planOverwrite([...first.products.values()].map(p => ({ id: p.id, change: p.change })), first.sources.map(s => ({ id: s.id, productId: s.productId, n: s.n })));
  if (!planned.ok) {
    console.info(JSON.stringify({ message: "overwrite passes skipped", set: setId(first.group.brand, first.group.category), reason: planned.reason, held: planned.held.map(identifierOf) }));
    return { ran: false, results: overwriteNotRun(planned.reason) };
  }
  const { productIds, held, altered: changed, removed } = planned.plan;
  if (held.length) console.info(JSON.stringify({ message: "overwrite passes leave out the products held for attention", set: setId(first.group.brand, first.group.category), held: held.map(identifierOf) }));
  const liveRows = async (productIds: string[]) => (await db.select().from(catalogOutputs).where(and(inArray(catalogOutputs.productId, productIds), eq(catalogOutputs.isLive, true)))).map(o => ({ identifier: identifierOf(o.productId), n: o.n, channel: o.channel, publicUrl: o.publicUrl, objectPath: o.objectPath, generation: o.generation }));
  const before = await liveRows(productIds);
  const originals = await Promise.all(first.sources.filter(s => productIds.includes(s.productId)).map(async s => ({ source: s, bytes: (await gcs.downloadBuffer(s.rawUri)).buf })));
  const files = (edit?: { alteredId: string; removedId: string; selected: ChannelId[] }) => originals.filter(({ source }) => source.id !== edit?.removedId).map(({ source, bytes }) => ({ path: `${first.products.get(source.productId)!.pathKey}_${source.n}.${source.id === edit?.alteredId ? "png" : source.originalName.split(".").pop()}`, data: bytes, altered: source.id === edit?.alteredId }));
  const changes = async (batchId: string) => new Map((await db.select({ pair: catalogBatchProducts, product: catalogProducts }).from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, batchId))).map(({ pair, product }) => [strip(product.pathKey), pair.change]));
  const events = async (batchId: string) => (await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, batchId))).map(e => ({ identifier: identifierOf(e.productId), kind: e.kind }));

  const beforeWork = { ...work };
  const identical = await runBatch(db, deps, run, first.group, files().map(f => ({ path: f.path, data: f.data })), [...CHANNEL_IDS], "identical");
  batchIds.push(identical.id);
  results.push(...checkIdentical({ before, after: await liveRows(productIds), changes: await changes(identical.id), work: { matte: work.matte - beforeWork.matte, render: work.render - beforeWork.render, copy: work.copy - beforeWork.copy }, events: await events(identical.id) }));

  const selected: ChannelId[] = CHANNEL_IDS.filter(c => c !== "amazon");
  const delivery = await Promise.all(files({ alteredId: changed.id, removedId: removed.id, selected }).map(async f => ({ path: f.path, data: f.altered ? await changeOnePixel(f.data) : f.data })));
  const second = await runBatch(db, deps, run, first.group, delivery, selected, "changed");
  batchIds.push(second.id);
  const after = await liveRows(productIds), report = JSON.parse((await gcs.downloadBuffer(second.reportUri!)).buf.toString()) as { removedLinks: unknown[]; notRefreshedChannels: { channel: ChannelId }[] };
  const removedGone = new Map<string, boolean>();
  for (const row of before.filter(r => r.identifier === identifierOf(removed.productId) && r.n === removed.n && selected.includes(r.channel))) removedGone.set(row.publicUrl, await gone(row.publicUrl));
  results.push(...checkOverwrite({ before, after, selected, altered: { identifier: identifierOf(changed.productId), n: changed.n }, removed: { identifier: identifierOf(removed.productId), n: removed.n }, changes: await changes(second.id), events: await events(second.id), removedGone, report: { removedLinks: report.removedLinks.length, notRefreshedChannels: report.notRefreshedChannels.map(c => c.channel) }, recheck: { ok: second.counts.recheckOk, total: second.counts.recheckTotal } }));
  return { ran: true, results };
}

/** A removed link may serve its old bytes from the public cache for up to the cache window. */
async function gone(url: string): Promise<boolean> {
  const deadline = Date.now() + PUBLIC_CACHE_WINDOW_MS;
  for (;;) {
    const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    await response.body?.cancel();
    if (response.status === 404) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}

/** Pure checks over a folder of raw photos, mattes and outputs (the render-investigation layout); no GCP. */
async function checkFolderCommand(flags: Record<string, string | string[] | true>) {
  const dir = str(flags.dir), productType = (str(flags["product-type"]) ?? "other") as ProductType;
  assert(dir && existsSync(dir), "--dir must point at a folder with raw/, mattes/ and outputs/.");
  const out = str(flags.out) ?? path.join(dir, "evals"), results: CheckResult[] = [], thumbs: ReportThumb[] = [], started = new Date();
  await mkdir(out, { recursive: true });
  const only = str(flags.only)?.split(",").map(v => v.trim()).filter(Boolean);
  const products = (await readdir(path.join(dir, "outputs"), { withFileTypes: true })).filter(d => d.isDirectory() && (!only || only.includes(d.name))).map(d => d.name);
  let photos = 0;
  for (const product of products) {
    const shots = new Map<number, { p: Prepared; alpha: Buffer; raw: Buffer }>();
    for (const file of await readdir(path.join(dir, "raw", product))) {
      const m = /_(\d+)\.[a-z0-9]+$/i.exec(file); if (!m) continue;
      const n = Number(m[1]), raw = await readFile(path.join(dir, "raw", product, file)), mattePath = path.join(dir, "mattes", product, `${product}_${n}.matte.png`);
      if (!existsSync(mattePath)) continue;
      const p = await prepare(raw, file, async b => b), alpha = await sharp(await readFile(mattePath)).toColourspace("b-w").raw().toBuffer();
      shots.set(n, { p, alpha, raw }); photos++;
    }
    const geometries = [...shots.values()].flatMap(({ p, alpha }) => { const g = shotGeometry(alpha, p.width, p.height, { rgb: p.rgb }); return g ? [g] : []; });
    const uniformScale = geometries.length ? planProduct(CHANNELS.styli, geometries).uniformScale : undefined;
    for (const channel of await readdir(path.join(dir, "outputs", product))) {
      if (!(CHANNEL_IDS as readonly string[]).includes(channel)) continue;
      for (const file of await readdir(path.join(dir, "outputs", product, channel))) {
        const m = /_(\d+)\.jpg$/i.exec(file); if (!m) continue;
        const n = Number(m[1]), shot = shots.get(n); if (!shot) continue;
        const geometry = shotGeometry(shot.alpha, shot.p.width, shot.p.height, { rgb: shot.p.rgb }); if (!geometry) continue;
        const productCanvas = geometries.length ? planProduct(CHANNELS[channel as ChannelId], geometries).canvas : undefined;
        const plan = planCanvas(CHANNELS[channel as ChannelId], geometry.box, geometry.source, { cut: geometry.cut, canvas: productCanvas, ...(channel === "styli" ? { uniformScale } : {}) });
        const jpeg = await readFile(path.join(dir, "outputs", product, channel, file));
        const meta = await sharp(jpeg).metadata();
        if (meta.width !== plan.w || meta.height !== plan.h) { results.push({ id: "geometry.canvas", group: "geometry", subject: { identifier: product, n, channel: channel as ChannelId }, ok: false, status: "fail", measured: `${meta.width}x${meta.height}`, threshold: `${plan.w}x${plan.h}`, unit: "px", detail: "The output canvas differs from the plan the channel table gives for this source." }); continue; }
        const subject: OutputSubject = { identifier: product, n, channel: channel as ChannelId, productType, source: { w: shot.p.width, h: shot.p.height, rgb: shot.p.rgb }, sourceBackground: shot.p.background, alpha: shot.alpha, jpeg, placement: { w: plan.w, h: plan.h, scale: plan.scale, placedX: plan.placedX, placedY: plan.placedY }, flags: [] as OutputFlag[], status: "staged", expect: { attention: false, flags: [], detector: "code" } };
        const checks = await runImageChecks(subject);
        results.push(...checks);
        if (checks.some(c => !c.ok)) thumbs.push({ identifier: product, n, channel, original: shot.raw, output: jpeg });
      }
    }
  }
  const report = buildReport({ run: `folder-${path.basename(dir)}`, startedAt: started, finishedAt: new Date(), mode: "folder (pure image checks, no pipeline)", golden: { products: products.length, photos, brands: {}, categories: { [productType]: products.length }, tags: {} }, results, attention: { attentionProducts: 0, attentionRate: 0, expectedAttention: 0, falseHoldRate: null, useAsIsRate: null, plantedCaught: 0, plantedTotal: 0 }, flags: [], batches: [], includeAll: true });
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 1));
  await writeFile(path.join(out, "report.html"), await reportHtml(report, thumbs));
  console.info(report.summary.line);
  console.info(`Report: ${path.join(out, "report.html")}`);
  if (!report.summary.passedAll) process.exitCode = 1;
}

async function main() {
  const { words, flags } = parseArgs(process.argv.slice(2));
  const command = words.join(" ");
  if (!command || command === "help") { print(USAGE); return; }
  if (command === "build-golden") return buildGoldenCommand(flags);
  if (command === "upload") return uploadCommand(flags);
  if (command === "check-folder") return checkFolderCommand(flags);
  if (command !== "run") { print(USAGE); process.exitCode = 2; return; }
  const db = getDb();
  try { await runCommand(db, flags); } finally { await closeDb(); }
}
main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
export { sha256 };
