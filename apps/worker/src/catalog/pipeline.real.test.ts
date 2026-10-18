import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, test } from "vitest";
import { createTestDb } from "@catalog/core/db/testing";
import { localFixture, sheetFixture } from "../catalog-real-fixtures";
import { runRealFixture } from "../catalog-real-run";

describe.skipIf(process.env.REAL_DATA !== "1")("spec 06 real pipeline, real matting and both GCS buckets",()=>{
  test.each(["anta","campus","keds"] as const)("%s: real delivery, all channels, identical and scoped overwrites",async(slug)=>{
    const {db,close}=await createTestDb(),run=`pipeline-${randomUUID()}`;
    const out=path.resolve(process.env.CATALOG_REAL_OUT ?? `var/catalog-test/${run}`);
    const cli=path.resolve("apps/worker/dist/catalog-smoke.js");
    try {
      const fixture=slug==="anta" ? await localFixture(slug,true,run):await sheetFixture(slug,false,run);
      assert(fixture,`${slug}: the source set named by spec 06 must contain genuine photos/links for this brand.`);
      await runRealFixture(db,fixture,path.join(out,fixture.slug),cli);
    } finally {await close();}
  },24*60*60_000);
});
