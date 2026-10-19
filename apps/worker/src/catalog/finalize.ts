import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, catalogUploads } from "@catalog/core/db/schema";
import { batchPrefix, exportPath, sanitizeSegment } from "@catalog/core/catalog/naming";
import { buildReport, readIngestReport, workbookCsvSheets, type ExportPaths } from "@catalog/core/catalog/pipeline/report";
import { releaseLocks } from "@catalog/core/catalog/pipeline/publish";
import { recheckSheet } from "@catalog/core/catalog/recheck/index";
import { compareXlsxCsv, fillProductListWorkbook, writeLinksCsv, writeLinksXlsx } from "@catalog/core/catalog/sheet";
import type { HandleResult } from "../server";
import { CATALOG_TASK_LEASE_MS, enqueueFinalize, type CatalogDeps } from "./deps";
export async function handleFinalizeTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if(typeof body.batchId!=="string") return {httpStatus:400,outcome:"batchId is required"};
  const batchId = body.batchId;
  const claim=randomUUID(),leaseUntil=+deps.now()+CATALOG_TASK_LEASE_MS;
  const claimWhere=and(eq(catalogBatches.id,batchId),sql`${catalogBatches.counts}->>'finalizeClaim' = ${claim}`);
  const cleanCounts=(counts:typeof catalogBatches.$inferSelect.counts)=>{
    const copy={...counts} as typeof counts & {finalizeClaim?:string;finalizeClaimUntil?:number;finalizeEnqueuedAt?:number};
    delete copy.finalizeClaim;delete copy.finalizeClaimUntil;delete copy.finalizeEnqueuedAt;
    return copy;
  };
  try {
    const acquired=await deps.db.transaction(async tx=> {
      const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id,batchId)).for("update");
      if(!batch) return {outcome:"not_found"} as const;
      if(batch.status==="failed") return {outcome:"stopped"} as const;
      const state=batch.counts as typeof batch.counts & {finalizeClaim?:string;finalizeClaimUntil?:number};
      if(state.finalizeClaim && Number(state.finalizeClaimUntil)>+deps.now()) return {outcome:"busy"} as const;
      await tx.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`(${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil' - 'finalizeEnqueuedAt') || '{"finalizePending":false}'::jsonb`}).where(eq(catalogBatches.id,batchId));
      const chunks = await tx.select().from(catalogChunks).where(eq(catalogChunks.batchId,batchId));
      const pairs = await tx.select({pair:catalogBatchProducts,product:catalogProducts}).from(catalogBatchProducts).innerJoin(catalogProducts,eq(catalogProducts.id,catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId,batchId));
      const sources = await tx.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,batchId));
      if(chunks.some(c=>c.status!=="done" && c.status!=="failed") || pairs.some(({pair,product})=>sources.some(s=>s.productId===product.id) && product.lastBatchId!==batchId && pair.change!=="pending_attention" && pair.change!=="failed")) return {outcome:"not_ready"} as const;
      await tx.update(catalogBatches).set({counts:sql`${catalogBatches.counts} || jsonb_build_object('finalizeClaim',${claim}::text,'finalizeClaimUntil',${leaseUntil}::numeric)`}).where(eq(catalogBatches.id,batchId));
      return {outcome:"claimed",batch} as const;
    });
    if(acquired.outcome!=="claimed") {
      if(acquired.outcome==="not_ready") await enqueueFinalize(deps,batchId,30);
      return {httpStatus:acquired.outcome==="busy" ? 503:200,outcome:acquired.outcome};
    }
    const batch=acquired.batch;
    // Unique paths keep an expired uploader from overwriting a newer attempt's checked files.
    const attemptPath=(name:string)=>exportPath(batchPrefix(batch.brandSlug,batchId,batch.isTest),`${claim}/${name}`);
    const k = batch.counts.latestExport+1,prefix=batchPrefix(batch.brandSlug,batchId,batch.isTest);
    const paths:ExportPaths={xlsx:deps.storage.toGsUri(deps.storage.getBucketName(),attemptPath(`links-v${k}.xlsx`)),csv:deps.storage.toGsUri(deps.storage.getBucketName(),attemptPath(`links-v${k}.csv`)),report:deps.storage.toGsUri(deps.storage.getBucketName(),attemptPath(`report-v${k}.json`)),filledProductList:null,exportsMatch:false};
    const ingest=await readIngestReport(deps.storage,prefix);
    const extra={recheck:{ok:0,total:0,failures:[]},exports:paths,ingest};
    const initial=await deps.db.transaction(tx=>buildReport(tx as unknown as CatalogDeps["db"],batchId,extra),{isolationLevel:"repeatable read"});
    initial.batch.counts=cleanCounts(initial.batch.counts);initial.report.counts=initial.batch.counts;
    const snapshotOf=(built:typeof initial)=>JSON.stringify({...built,report:{...built.report,exports:undefined,recheck:undefined}});
    const snapshot=snapshotOf(initial);
    const xlsx=await writeLinksXlsx(initial.sheet),csv=writeLinksCsv(initial.sheet),comparison=await compareXlsxCsv(xlsx,csv);
    if(!comparison.equal) { await deps.db.update(catalogBatches).set({error:`Links xlsx and csv differ: ${comparison.differences.join("; ")}`}).where(claimWhere); return {httpStatus:500,outcome:"exports_mismatch"}; }
    paths.exportsMatch=true;
    await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.xlsx).path,xlsx,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.csv).path,Buffer.from(csv),"text/csv");
    const uploads=await deps.db.select().from(catalogUploads).where(and(eq(catalogUploads.batchId,batchId),eq(catalogUploads.kind,"product_list")));
    for(const upload of uploads.filter(u=>u.gcsUri && /\.xlsx$/i.test(u.name))) {
      const filled=await fillProductListWorkbook((await deps.storage.downloadBuffer(upload.gcsUri!)).buf,initial.sheet,Number(upload.detected?.matchColumn ?? upload.detected?.identifierColumn ?? 0));
      const stem=sanitizeSegment(upload.name.replace(/\.xlsx$/i,"")),filledPath=attemptPath(`${stem}-filled-v${k}.xlsx`);
      const uri=await deps.storage.uploadBuffer(filledPath,filled,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const csvUris:string[]=[];
      for(const sheet of await workbookCsvSheets(filled)) {
        csvUris.push(await deps.storage.uploadBuffer(attemptPath(`${stem}-${sanitizeSegment(sheet.name)}-filled-v${k}.csv`),Buffer.from(sheet.csv),"text/csv"));
      }
      paths.filledProductList={xlsx:uri,csv:csvUris};
    }
    const recheck=await recheckSheet((await deps.storage.downloadBuffer(paths.xlsx)).buf,{fetch:deps.fetch});
    const counts={...initial.batch.counts,latestExport:k,finalizePending:false,recheckOk:recheck.ok,recheckTotal:recheck.total};
    const report={...initial.report,counts,recheck,exports:paths};
    await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.report).path,Buffer.from(JSON.stringify(report)),"application/json");
    const outcome=await deps.db.transaction(async tx=>{
      const [fresh]=await tx.select().from(catalogBatches).where(claimWhere).for("update");
      if(!fresh || Number((fresh.counts as typeof fresh.counts & {finalizeClaimUntil?:number}).finalizeClaimUntil)<=+deps.now()) return "snapshot_changed";
      const pairs=await tx.select().from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,batchId));
      if(pairs.length) await tx.select({id:catalogProducts.id}).from(catalogProducts).where(inArray(catalogProducts.id,pairs.map(p=>p.productId))).orderBy(catalogProducts.id).for("update");
      const current=await buildReport(tx as unknown as CatalogDeps["db"],batchId,extra);
      current.batch.counts=cleanCounts(current.batch.counts);current.report.counts=current.batch.counts;
      // Network work may outlive a decision or publication. Commit only the snapshot we checked.
      if(snapshotOf(current)!==snapshot) return "snapshot_changed";
      await tx.update(catalogBatches).set({counts,cost:initial.batch.cost,status:"done",finishedAt:deps.now(),sheetXlsxUri:paths.xlsx,sheetCsvUri:paths.csv,reportUri:paths.report,error:null}).where(claimWhere);
      await releaseLocks(tx as unknown as CatalogDeps["db"],batchId);
      return "done";
    });
    return {httpStatus:outcome==="snapshot_changed" ? 503:200,outcome};
  } catch(error) { deps.log("finalize failed",{batchId,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
  finally {
    await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil'`}).where(claimWhere);
  }
}
