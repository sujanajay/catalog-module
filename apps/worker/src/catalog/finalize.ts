import { and, eq, sql } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, catalogUploads } from "@catalog/core/db/schema";
import { batchPrefix, exportPath, sanitizeSegment } from "@catalog/core/catalog/naming";
import { buildReport, readIngestReport, workbookCsvSheets, type ExportPaths } from "@catalog/core/catalog/pipeline/report";
import { releaseLocks } from "@catalog/core/catalog/pipeline/publish";
import { recheckSheet } from "@catalog/core/catalog/recheck/index";
import { compareXlsxCsv, fillProductListWorkbook, writeLinksCsv, writeLinksXlsx } from "@catalog/core/catalog/sheet";
import type { HandleResult } from "../server";
import { enqueueFinalize, type CatalogDeps } from "./deps";
export async function handleFinalizeTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if(typeof body.batchId!=="string") return {httpStatus:400,outcome:"batchId is required"};
  const batchId = body.batchId;
  try {
    // Hold one row lock so simultaneous finalizers never reuse an export version.
    const outcome = await deps.db.transaction(async tx=> {
      const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id,batchId)).for("update");
      if(!batch) return "not_found";
      await tx.update(catalogBatches).set({counts:sql`jsonb_set(${catalogBatches.counts},'{finalizePending}','false')`}).where(eq(catalogBatches.id,batchId));
      const chunks = await tx.select().from(catalogChunks).where(eq(catalogChunks.batchId,batchId));
      const pairs = await tx.select({pair:catalogBatchProducts,product:catalogProducts}).from(catalogBatchProducts).innerJoin(catalogProducts,eq(catalogProducts.id,catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId,batchId));
      const sources = await tx.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,batchId));
      if(chunks.some(c=>c.status!=="done" && c.status!=="failed") || pairs.some(({pair,product})=>sources.some(s=>s.productId===product.id) && product.lastBatchId!==batchId && pair.change!=="pending_attention" && pair.change!=="failed")) return "not_ready";
      const k = batch.counts.latestExport+1,prefix=batchPrefix(batch.brandSlug,batchId,batch.isTest);
      const paths:ExportPaths={xlsx:deps.storage.toGsUri(deps.storage.getBucketName(),exportPath(prefix,`links-v${k}.xlsx`)),csv:deps.storage.toGsUri(deps.storage.getBucketName(),exportPath(prefix,`links-v${k}.csv`)),report:deps.storage.toGsUri(deps.storage.getBucketName(),exportPath(prefix,`report-v${k}.json`)),filledProductList:null,exportsMatch:false};
      const db = tx as unknown as CatalogDeps["db"];
      const ingest=await readIngestReport(deps.storage,prefix);
      const initial=await buildReport(db,batchId,{recheck:{ok:0,total:0,failures:[]},exports:paths,ingest});
      const xlsx=await writeLinksXlsx(initial.sheet),csv=writeLinksCsv(initial.sheet),comparison=await compareXlsxCsv(xlsx,csv);
      if(!comparison.equal) { await tx.update(catalogBatches).set({error:`Links xlsx and csv differ: ${comparison.differences.join("; ")}`}).where(eq(catalogBatches.id,batchId)); return "exports_mismatch"; }
      paths.exportsMatch=true;
      await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.xlsx).path,xlsx,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.csv).path,Buffer.from(csv),"text/csv");
      const uploads=await tx.select().from(catalogUploads).where(and(eq(catalogUploads.batchId,batchId),eq(catalogUploads.kind,"product_list")));
      for(const upload of uploads.filter(u=>u.gcsUri && /\.xlsx$/i.test(u.name))) {
        const filled=await fillProductListWorkbook((await deps.storage.downloadBuffer(upload.gcsUri!)).buf,initial.sheet,Number(upload.detected?.matchColumn ?? upload.detected?.identifierColumn ?? 0));
        const stem=sanitizeSegment(upload.name.replace(/\.xlsx$/i,"")),filledPath=exportPath(prefix,`${stem}-filled-v${k}.xlsx`);
        const uri=await deps.storage.uploadBuffer(filledPath,filled,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        const csvUris:string[]=[];
        for(const sheet of await workbookCsvSheets(filled)) {
          csvUris.push(await deps.storage.uploadBuffer(exportPath(prefix,`${stem}-${sanitizeSegment(sheet.name)}-filled-v${k}.csv`),Buffer.from(sheet.csv),"text/csv"));
        }
        paths.filledProductList={xlsx:uri,csv:csvUris};
      }
      const recheck=await recheckSheet((await deps.storage.downloadBuffer(paths.xlsx)).buf,{fetch:deps.fetch});
      const built=await buildReport(db,batchId,{recheck,exports:paths,ingest});
      const counts={...built.batch.counts,latestExport:k,finalizePending:false};
      built.report.counts=counts;
      await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.report).path,Buffer.from(JSON.stringify(built.report)),"application/json");
      await tx.update(catalogBatches).set({counts,status:"done",finishedAt:deps.now(),sheetXlsxUri:paths.xlsx,sheetCsvUri:paths.csv,reportUri:paths.report,error:null}).where(eq(catalogBatches.id,batchId));
      await releaseLocks(db,batchId);
      return "done";
    });
    if(outcome==="not_ready") await enqueueFinalize(deps,batchId,30);
    return {httpStatus:outcome==="exports_mismatch" ? 500:200,outcome};
  } catch(error) { deps.log("finalize failed",{batchId,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
}
