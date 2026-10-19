// Runs before deploy. This entry never calls OpenRouter and never writes outside catalog-test/.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "@catalog/core/db/client";
import { brandMaster, catalogBatches } from "@catalog/core/db/schema";
import { inArray } from "drizzle-orm";
import { cleanupTestBatches } from "@catalog/core/catalog/test-cleanup";
import * as storage from "@catalog/core/storage";
import { checkOutput } from "@catalog/core/catalog/compliance";
import { verifyPublic } from "@catalog/core/catalog/pipeline/verify";
import { recheckSheet } from "@catalog/core/catalog/recheck/index";
import { localFixture, sheetFixture } from "./catalog-real-fixtures";
import { runRealFixture, type VerificationManifest } from "./catalog-real-run";

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === "--cleanup-batches") {
    const ids=file?.split(",") ?? [];
    assert(ids.length && ids.every(id=>/^[a-f0-9-]{36}$/.test(id)),"Supply explicit test batch UUIDs.");
    try {
      const db=getDb(),batches=await db.select().from(catalogBatches).where(inArray(catalogBatches.id,ids));
      assert.equal(batches.length,ids.length);assert(batches.every(b=>b.isTest && b.name.startsWith("catalog-test")));
      console.info(JSON.stringify(await cleanupTestBatches(db,storage,ids)));
    } finally {await closeDb();}
    return;
  }
  if (mode === "--verify-manifest") {
    assert(file,"Supply the independently saved verification manifest.");
    const manifest = JSON.parse(await readFile(file,"utf8")) as VerificationManifest;
    for (const output of manifest.outputs) {
      const result = await verifyPublic(output.url,{size:output.bytes,generation:output.generation});
      assert(result.ok,`${output.objectPath}: ${!result.ok ? result.reason : ""}`);
      const response = await fetch(output.url);
      assert.equal(response.status,200);
      const compliance = await checkOutput({jpeg:Buffer.from(await response.arrayBuffer()),channel:output.channel,shotNumber:output.n,plan:output.plan,identifier:output.identifier,n:output.n,publicObjectPath:output.objectPath});
      assert(compliance.ok,`${output.objectPath}: ${compliance.failures.join("; ")}`);
    }
    const recheck = await recheckSheet(await readFile(manifest.xlsx),{fetch,concurrency:16});
    assert.equal(recheck.ok,recheck.total,JSON.stringify(recheck.failures));
    console.info(JSON.stringify({verified:manifest.outputs.length,compliance:100,recheck}));
    return;
  }
  assert(!mode,"Usage: catalog:smoke (or --verify-manifest <file> for a fresh independent reader)");
  const db=getDb(),run=`smoke-${randomUUID()}`,out=path.resolve(process.env.CATALOG_REAL_OUT ?? `var/catalog-test/${run}`);
  await mkdir(out,{recursive:true});
  try {
    const brands=await db.select().from(brandMaster);
    assert(brands.length,"The real brand master is empty. Sync the warehouse before smoke.");
    const evidence=[],excluded=[];
    for(const brand of brands) {
      const fixture=await localFixture(brand.slug,false,run) ?? (brand.slug==="campus" || brand.slug==="keds" ? await sheetFixture(brand.slug,false,run):null);
      if(!fixture){excluded.push({brand:brand.name,reason:"No real image set is available in REAL_DATA_DIR."});continue;}
      fixture.name=brand.name;
      evidence.push(await runRealFixture(db,fixture,path.join(out,brand.slug),fileURLToPath(import.meta.url)));
    }
    await writeFile(path.join(out,"summary.json"),JSON.stringify({run,evidence,excluded},null,2));
    assert(evidence.length,"No actual brand has an available real image set. Smoke did not run.");
    await writeFile(path.join(out,"report.html"),`<!doctype html><meta charset="utf-8"><title>Per-brand catalog smoke</title><h1>Per-brand catalog smoke</h1><ul>${evidence.map(e=>`<li><a href="${e.slug}/report.html">${e.brand}</a>: ${e.first.verified} verified, ${e.changed} changed, ${e.removed} removed; cleanup ${e.cleanup}; quality check: ${e.qa}</li>`).join("")}</ul><h2>Unavailable real sets</h2><pre>${JSON.stringify(excluded,null,2)}</pre>`);
    console.info(JSON.stringify({run,out,evidence,excluded}));
  } finally {await closeDb();}
}
main().catch(error=>{console.error(error instanceof Error ? error.message:String(error));process.exitCode=1;});
