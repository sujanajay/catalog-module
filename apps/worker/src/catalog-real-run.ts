// The real acceptance runner calls the shipped handlers. Storage, matting and public reads are real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages, catalogUploads, type CatalogBatch, type CatalogOutput } from "@catalog/core/db/schema";
import { runIngest } from "@catalog/core/catalog/ingest/index";
import { batchPrefix, productPrefix, assertTestPrefix } from "@catalog/core/catalog/naming";
import { lockProducts } from "@catalog/core/catalog/products";
import { planChunks } from "@catalog/core/catalog/pipeline/plan-chunks";
import { cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { CHANNEL_IDS, type ChannelId } from "@catalog/core/catalog/types";
import type { CanvasPlan } from "@catalog/core/catalog/render";
import { buildZip } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { workerCatalogDeps, type CatalogDeps } from "./catalog/deps";
import { handleChunkTask } from "./catalog/chunk";
import { handlePublishTask } from "./catalog/publish";
import { handleFinalizeTask } from "./catalog/finalize";
import { changeOnePixel, type RealFixture, type RealShot } from "./catalog-real-fixtures";

export interface VerifyRow { url: string; generation: number; bytes: number; channel: ChannelId; n: number; identifier: string; objectPath: string; plan: CanvasPlan }
export interface VerificationManifest { outputs: VerifyRow[]; xlsx: string }
export interface RunEvidence { slug: string; brand: string; source: string; batches: string[]; first: { products: number; sources: number; verified: number; skipped: number }; unchanged: { matte: number; render: number; copy: number }; changed: number; removed: number; report: string; cleanup: boolean }
const execute = promisify(execFile);

export async function runRealFixture(db: Db, fixture: RealFixture, out: string, cli: string): Promise<RunEvidence> {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out,"source-manifest.json"),JSON.stringify({brand:fixture.slug,source:fixture.source,files:fixture.shots.map(s=>({deliveryName:s.name,sourceName:s.originalName??s.name})),pastedLinks:fixture.urls},null,2));
  const batches: CatalogBatch[] = [], plans = new Map<string, CanvasPlan>();
  const calls = { matte: 0, render: 0, copy: 0 };
  const base = workerCatalogDeps(db);
  // Observe the real operations without replacing their implementations.
  const deps: CatalogDeps = { ...base, enqueue: async () => "local-real-run", log: (message, fields) => console.info(JSON.stringify({ message, ...fields })),
    matteFor: async (...args) => { calls.matte++; return base.matteFor(...args); },
    renderAllChannels: async (...args) => { calls.render++; const result = await base.renderAllChannels(...args); for (const channel of args[2]) plans.set(`${args[3]?.identifier}|${args[3]?.shotNumber}|${channel}`, result[channel].plan); return result; },
    storage: { ...storage, stageCopyToPublic: async (...args) => { calls.copy++; return storage.stageCopyToPublic(...args); } } };
  const evidence: RunEvidence = { slug: fixture.slug, brand: fixture.name, source: fixture.source, batches: [], first: { products: 0, sources: 0, verified: 0, skipped: 0 }, unchanged: { matte: 0, render: 0, copy: 0 }, changed: 0, removed: 0, report: path.join(out, "report.html"), cleanup: false };
  const snapshots: { label: string; rows: CatalogOutput[] }[] = [];
  let failure: unknown;
  try {
    const first = await batch(fixture.shots, fixture.urls, [...CHANNEL_IDS], "first");
    const original = await live(first);
    const pairs = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, first.id));
    assert(pairs.length > 0 && pairs.every(p => p.change === "new"), "Every initial sheet product must be new.");
    evidence.first = { products: pairs.length, sources: first.counts.sources, verified: original.length, skipped: first.counts.skipped };
    snapshots.push({ label: "First delivery", rows: original });
    await verify(first, original, "first");

    const before = { ...calls };
    const identical = await batch(fixture.shots, fixture.urls, [...CHANNEL_IDS], "identical");
    const same = await live(identical);
    assert.deepEqual(same.map(keyGeneration).sort(), original.map(keyGeneration).sort(), "Identical re-upload changed a generation.");
    const identicalPairs = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, identical.id));
    assert(identicalPairs.every(p => p.change === "unchanged"));
    evidence.unchanged = { matte: calls.matte - before.matte, render: calls.render - before.render, copy: calls.copy - before.copy };
    assert.deepEqual(evidence.unchanged, { matte: 0, render: 0, copy: 0 }, "Identical re-upload performed paid processing or a public copy.");
    const unchangedEvents = await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, identical.id));
    assert.equal(unchangedEvents.filter(e => e.kind === "unchanged").length, pairs.length);

    // Build a delivery from the original real bytes. The source collection itself is never edited.
    const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, first.id));
    const grouped = new Map<string, typeof sources>();
    for (const source of sources) grouped.set(source.productId, [...grouped.get(source.productId) ?? [], source]);
    const candidates = [...grouped.values()].filter(g => g.length >= 3).map(g => g.sort((a,b) => a.n-b.n));
    assert(candidates.length, "Overwrite proof needs at least one product with three real shots.");
    const changedSource = candidates[0]![0]!, removedSource = (candidates[1] ?? candidates[0])!.at(-1)!;
    const selected: ChannelId[] = CHANNEL_IDS.filter(c => c !== "amazon");
    const changedDelivery: RealShot[] = [];
    for (const source of sources) {
      if (source.id === removedSource.id) continue;
      const product = (await db.select().from(catalogProducts).where(eq(catalogProducts.id, source.productId)))[0]!;
      const bytes = (await storage.downloadBuffer(source.rawUri)).buf;
      changedDelivery.push({ name: `${product.identifier}_${source.n}.${source.id === changedSource.id ? "png" : "jpg"}`, bytes: source.id === changedSource.id ? await changeOnePixel(bytes) : bytes });
    }
    const changed = await batch(changedDelivery, [], selected, "changed");
    const after = await live(changed);
    for (const row of original) {
      const next = after.find(o => o.objectPath === row.objectPath);
      const removed = row.sourceImageId === removedSource.id && selected.includes(row.channel);
      if (removed) {
        assert(!next, `Removed output is still live: ${row.objectPath}`);
        await removedGet(row.publicUrl);
        evidence.removed++;
      } else {
        assert(next, `Unexpectedly removed ${row.objectPath}`);
        assert.equal(next.publicUrl, row.publicUrl);
        const altered = row.sourceImageId === changedSource.id && selected.includes(row.channel);
        if (altered) { assert.notEqual(next.generation, row.generation); evidence.changed++; }
        else assert.equal(next.generation, row.generation, `Untouched output generation changed: ${row.objectPath}`);
      }
    }
    const changedPairs = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, changed.id));
    assert.equal(changedPairs.find(p => p.productId === removedSource.productId)?.change, "shots_removed");
    if (changedSource.productId !== removedSource.productId) assert.equal(changedPairs.find(p => p.productId === changedSource.productId)?.change, "updated");
    for (const pair of changedPairs.filter(p => p.productId !== changedSource.productId && p.productId !== removedSource.productId)) assert.equal(pair.change, "unchanged");
    const events = await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, changed.id));
    assert(events.some(e => e.kind === "overwritten") && events.some(e => e.kind === "shots_removed"));
    const report = JSON.parse((await storage.downloadBuffer(changed.reportUri!)).buf.toString());
    assert.equal(report.removedLinks.length, evidence.removed);
    assert(report.notRefreshedChannels.some((c: { channel: string }) => c.channel === "amazon"));
    snapshots.push({ label: "Changed delivery (Amazon untouched)", rows: after });
    await verify(changed, after, "changed");
  } catch (error) { failure = error; }
  finally {
    // Retain self-contained thumbnails locally before deleting all test objects and rows.
    await saveHtml(evidence.report, fixture, snapshots, failure).catch(error => { failure ??= error; });
    try {
      if (batches.length) {
        const owned=await db.select({brandSlug:catalogProducts.brandSlug,pathKey:catalogProducts.pathKey}).from(catalogProducts).innerJoin(catalogBatchProducts,eq(catalogProducts.id,catalogBatchProducts.productId)).where(inArray(catalogBatchProducts.batchId,batches.map(b=>b.id)));
        const reportPath = `catalog-test/smoke/${path.basename(path.dirname(out))}/${fixture.slug}/report.html`;
        assertTestPrefix(reportPath);
        try { await storage.uploadBuffer(reportPath, await readFile(evidence.report), "text/html"); }
        catch (error) { failure ??= error; }
        finally {
          try { await cleanupTestBatches(db, storage, batches.map(b => b.id)); }
          finally { await storage.deleteTestObjects(storage.toGsUri(storage.getBucketName(), reportPath)); }
        }
        for (const batch of batches) assert.deepEqual(await storage.listObjects(storage.toGsUri(storage.getBucketName(), `${batchPrefix(batch.brandSlug,batch.id,true)}/`)), []);
        for(const product of owned)assert.deepEqual(await storage.listObjects(storage.toGsUri(storage.getPublicBucketName(),productPrefix(product.brandSlug,product.pathKey,true))),[]);
        const ids = batches.map(b => b.id);
        assert.equal((await db.select().from(catalogBatches).where(inArray(catalogBatches.id, ids))).length, 0);
      }
      evidence.cleanup = true;
    } catch (error) { failure ??= error; }
    await writeFile(path.join(out, "evidence.json"), JSON.stringify({ ...evidence, failure: failure ? String(failure) : null }, null, 2));
  }
  if (failure) throw failure;
  return evidence;

  async function batch(shots: RealShot[], urls: string[], channels: ChannelId[], label: string): Promise<CatalogBatch> {
    const [created] = await db.insert(catalogBatches).values({ brandSlug: fixture.slug, brandName: fixture.name, name: `catalog-test ${path.basename(out)} ${label}`, isTest: true, createdBy: "catalog-test@opptra.com", productType: fixture.type, channels }).returning();
    const b = created!; batches.push(b); evidence.batches.push(b.id);
    const prefix = batchPrefix(b.brandSlug,b.id,true);
    const uploads: {kind: "zip" | "url_list"; name: string; bytes: Buffer; mime: string}[] = [];
    if (shots.length) uploads.push({kind:"zip",name:"photos.zip",bytes:buildZip(shots.map(s => ({ path:s.name,data:s.bytes }))),mime:"application/zip"});
    if (urls.length) {
      if (label === "first") for (const line of urls) {
        const identifier = line.split("\t")[0]!;
        assert.equal((await db.select().from(catalogProducts).where(and(eq(catalogProducts.brandSlug,fixture.slug),eq(catalogProducts.identifier,identifier),eq(catalogProducts.isTest,true)))).length,0,"A previous test owns this source identifier. Clean that run first.");
      }
      uploads.push({kind:"url_list",name:"links.txt",bytes:Buffer.from(urls.join("\n")),mime:"text/plain"});
    }
    for (const upload of uploads) {
      const uri = await storage.uploadBuffer(`${prefix}/uploads/${randomUUID()}/${upload.name}`,upload.bytes,upload.mime);
      const [u] = await db.insert(catalogUploads).values({batchId:b.id,kind:upload.kind,name:upload.name,gcsUri:uri,status:"uploaded"}).returning();
      const queue: Record<string,unknown>[] = [{batchId:b.id,uploadId:u!.id}];
      while (queue.length) {
        const result = await runIngest(db,{storage,fetch:pinnedFetch,enqueue:async (_route,next) => {queue.push(next);return "real-inline";}},queue.shift() as {batchId:string;uploadId:string;cursor?:string});
        assert(!["failed","not_found"].includes(result.outcome),`Ingest failed: ${result.outcome}`);
      }
    }
    const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,b.id));
    assert.equal(sources.length,shots.length+urls.length,"Every supplied real source must be collected.");
    const productIds = [...new Set(sources.map(s => s.productId))];
    const locks = await lockProducts(db,b.id,productIds); assert(locks.ok,"A test product is locked by another batch.");
    await db.update(catalogBatches).set({status:"matting",startedAt:new Date(),counts:{...b.counts,products:productIds.length,sources:sources.length,outputs:sources.length*channels.length}}).where(eq(catalogBatches.id,b.id));
    const chunks = planChunks(productIds.map(productId => ({productId,sourceCount:sources.filter(s => s.productId===productId).length})),25);
    for (const [index,plan] of chunks.entries()) {
      const [chunk] = await db.insert(catalogChunks).values({batchId:b.id,index,stage:"matte",productIds:plan.productIds}).returning();
      for (let stage=0;stage<2;stage++) {const result=await handleChunkTask(deps,{chunkId:chunk!.id}); assert.equal(result.httpStatus,200,`Chunk failed: ${result.outcome}`);}
      for (const productId of plan.productIds) {const result=await handlePublishTask(deps,{batchId:b.id,productId}); assert.equal(result.outcome,"published",`Product was not published: ${result.outcome}`);}
    }
    const result = await handleFinalizeTask(deps,{batchId:b.id}); assert.equal(result.outcome,"done",`Finalize failed: ${result.outcome}`);
    const [done] = await db.select().from(catalogBatches).where(eq(catalogBatches.id,b.id));
    assert.equal(done!.counts.recheckOk,done!.counts.recheckTotal); assert.equal(done!.counts.failed,0); assert.equal(done!.counts.needsAttention,0);
    const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId,b.id));
    for (const output of outputs) {assert(["verified","skipped"].includes(output.status),`${output.objectPath}: ${output.status} ${output.reason}`);if(output.status!=="skipped"){assert.equal(output.isLive,true);assert.equal(output.compliance?.ok,true);}}
    await writeFile(path.join(out,`${label}.xlsx`),(await storage.downloadBuffer(done!.sheetXlsxUri!)).buf);
    await writeFile(path.join(out,`${label}-report.json`),(await storage.downloadBuffer(done!.reportUri!)).buf);
    return done!;
  }
  async function live(b: CatalogBatch) {
    const pairs = await db.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,b.id));
    return db.select().from(catalogOutputs).where(and(inArray(catalogOutputs.productId,pairs.map(p=>p.productId)),eq(catalogOutputs.isLive,true)));
  }
  async function verify(b: CatalogBatch, rows: CatalogOutput[], label: string) {
    const products = await db.select().from(catalogProducts).where(inArray(catalogProducts.id,[...new Set(rows.map(r=>r.productId))]));
    const manifest: VerificationManifest = { xlsx:path.resolve(out,`${label}.xlsx`),outputs:rows.map(r=> {
      const identifier=products.find(p=>p.id===r.productId)!.identifier,plan=plans.get(`${identifier}|${r.n}|${r.channel}`);
      assert(plan,`No real render plan captured for ${r.objectPath}`); assert(r.generation && r.bytes);
      return {url:r.publicUrl,generation:r.generation,bytes:r.bytes,channel:r.channel,n:r.n,identifier,objectPath:r.objectPath,plan};
    }) };
    const file=path.resolve(out,`${label}-verify.json`);await writeFile(file,JSON.stringify(manifest));
    const result=await execute(process.execPath,[cli,"--verify-manifest",file],{timeout:24*60*60_000,maxBuffer:1024*1024});
    await writeFile(path.join(out,`${label}-independent.json`),result.stdout);
    console.info(result.stdout.trim());
    assert.equal(b.counts.recheckOk,b.counts.recheckTotal);
  }
}

const keyGeneration = (o: CatalogOutput) => `${o.objectPath}|${o.generation}`;
async function removedGet(url: string): Promise<void> {
  // Public cache lifetime is 300 seconds. Allow that window, then require a plain GET 404.
  const deadline=Date.now()+310_000;
  for (;;) {
    const response=await fetch(url);await response.body?.cancel();
    if(response.status===404)return;
    assert.equal(response.status,200,`Unexpected removed-link response ${response.status}`);
    assert(Date.now()<deadline,`Removed link still serves bytes after the cache window: ${url}`);
    await new Promise(resolve=>setTimeout(resolve,10_000));
  }
}
const html = (v: string) => v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
async function saveHtml(file: string, fixture: RealFixture, snapshots: {label:string;rows:CatalogOutput[]}[], failure:unknown) {
  const rows: string[]=[];
  for(const snapshot of snapshots)for(const output of snapshot.rows){
    const response=await fetch(`${output.publicUrl}?generation=${output.generation}`);
    assert.equal(response.status,200);
    const thumb=(await sharp(Buffer.from(await response.arrayBuffer())).resize({width:100,height:100,fit:"inside"}).jpeg().toBuffer()).toString("base64");
    rows.push(`<tr><td>${html(snapshot.label)}</td><td>${html(output.objectPath)}</td><td>${output.generation}</td><td><img width="100" src="data:image/jpeg;base64,${thumb}" alt="${html(output.objectPath)}"></td></tr>`);
  }
  await writeFile(file,`<!doctype html><meta charset="utf-8"><title>Catalog smoke: ${html(fixture.name)}</title><h1>${html(fixture.name)}</h1><p>${failure?html(String(failure)):"All compliance, generation, overwrite and independent sheet checks passed."}</p><p>Source: ${html(fixture.source)}</p><table><thead><tr><th>Pass</th><th>Output</th><th>Generation</th><th>Thumbnail</th></tr></thead><tbody>${rows.join("")}</tbody></table>`);
}

