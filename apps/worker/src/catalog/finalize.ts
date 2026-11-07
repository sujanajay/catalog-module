import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogImprovements, catalogOutputs, catalogProducts, catalogSourceImages, catalogUploads } from "@catalog/core/db/schema";
import { batchPrefix, exportPath, sanitizeSegment } from "@catalog/core/catalog/naming";
import { batchProductIds, buildReport, readIngestReport, splitRecheck, workbookCsvSheets, type ExportPaths } from "@catalog/core/catalog/pipeline/report";
import { releaseLocks } from "@catalog/core/catalog/pipeline/publish";
import { autoDecideOf } from "@catalog/core/catalog/auto-decide";
import { recordBatchOutcome } from "@catalog/core/catalog/reliability";
import { ENLARGING_TASK } from "@catalog/core/catalog/pipeline/enlargement";
import { recheckSheetPart, type RecheckProgress } from "@catalog/core/catalog/recheck/index";
import { compareXlsxCsv, fillProductListWorkbook, writeExceptionsCsv, writeLinksCsv, writeLinksXlsx, writeNotesCsv } from "@catalog/core/catalog/sheet";
import { digestCost, digestFrom, readImprovements, readTooLargePhotos, type BatchDigest } from "@catalog/core/catalog/digest";
import { inrPerUsdFromEnv } from "@catalog/core/catalog/cost";
import { batchCostFigure } from "@catalog/core/catalog/cost-report";
import { positiveIntEnv } from "@catalog/core/concurrency";
import type { HandleResult } from "../server";
import { CATALOG_TASK_LEASE_MS, enqueueFinalize, refreshBatchProgress, type CatalogDeps } from "./deps";
/** Spec 18 lifecycle 3.7: the finalize re-queue while every unfinished chunk waits on an enlargement (10 minutes). */
export const FINALIZE_PARKED_WAIT_S = 600;
/**
 * M1-S4 review P2-3: a done batch waiting only for a re-made product's publish re-queues after 30 s, doubling each time up
 * to FINALIZE_PARKED_WAIT_S (30, 60, 120, 240, 480, then 600 s), so a lost or stuck publish costs at most one finalize
 * run every 10 minutes; reaching the cap logs one WARNING.
 */
export function finalizeRemadeWait(waits:number):number { return Math.min(30*2**Math.max(0,waits),FINALIZE_PARKED_WAIT_S); }
/**
 * How long one finalize request re-checks links before it hands the rest to the next request. The dispatch deadline
 * is 900 s; the report builds, the uploads and the final write come on top. A 25k-product batch has about 225k links,
 * which takes several requests at 16 links at once, none near its deadline. CATALOG_FINALIZE_TIME_BUDGET_MS overrides.
 */
export function finalizeTimeBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.CATALOG_FINALIZE_TIME_BUDGET_MS, 420_000);
}
/** What a finalize request that ran out of time leaves for the next one, in its attempt's folder. */
interface FinalizeState { attempt:string; k:number; snapshotHash:string; paths:ExportPaths; progress:RecheckProgress }
const FINALIZE_STATE = "finalize-state.json";
type FinalizeCounts = typeof catalogBatches.$inferSelect.counts & {finalizeClaim?:string;finalizeClaimUntil?:number;finalizeEnqueuedAt?:number;finalizeResume?:string;finalizeRemadeWaits?:number};
export async function handleFinalizeTask(deps:CatalogDeps,body:Record<string,unknown>):Promise<HandleResult> {
  if(typeof body.batchId!=="string") return {httpStatus:400,outcome:"batchId is required"};
  const batchId = body.batchId;
  const claim=randomUUID(),started=+deps.now(),leaseUntil=started+CATALOG_TASK_LEASE_MS;
  const claimWhere=and(eq(catalogBatches.id,batchId),sql`${catalogBatches.counts}->>'finalizeClaim' = ${claim}`);
  // The finalize bookkeeping keys and the progress throttle's stamp are not part of the snapshot or the done counts.
  const cleanCounts=(counts:typeof catalogBatches.$inferSelect.counts)=>{
    const copy={...counts} as FinalizeCounts;
    delete copy.finalizeClaim;delete copy.finalizeClaimUntil;delete copy.finalizeEnqueuedAt;delete copy.finalizeResume;delete copy.finalizeRemadeWaits;delete copy.progressRefreshedAt;
    return copy;
  };
  try {
    const acquired=await deps.db.transaction(async tx=> {
      const [batch] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id,batchId)).for("update");
      if(!batch) return {outcome:"not_found"} as const;
      if(batch.status==="failed") return {outcome:"stopped"} as const;
      const state=batch.counts as FinalizeCounts;
      // Spec 18 H4: a done batch is finalized again only on a request, the stored finalizePending flag
      // (enqueueFinalize with reopen: an operator decision, Add SKU ids, a changed late delivery). A repeated task
      // is a no-op, so the counts written after done (the load driver's re-check) stay.
      if(batch.status==="done" && !state.finalizePending) return {outcome:"already_done"} as const;
      if(state.finalizeClaim && Number(state.finalizeClaimUntil)>+deps.now()) return {outcome:"busy"} as const;
      const done=batch.status==="done";
      const chunks = await tx.select({status:catalogChunks.status,taskName:catalogChunks.taskName}).from(catalogChunks).where(eq(catalogChunks.batchId,batchId));
      const pairs = await tx.select({pair:catalogBatchProducts,product:catalogProducts}).from(catalogBatchProducts).innerJoin(catalogProducts,eq(catalogProducts.id,catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId,batchId));
      // The products with a photo in this batch, read once (a per-pair search over every photo grew with products x photos).
      const withSources = new Set((await tx.selectDistinct({productId:catalogSourceImages.productId}).from(catalogSourceImages).where(eq(catalogSourceImages.batchId,batchId))).map(s=>s.productId));
      const chunksRunning=chunks.some(c=>c.status!=="done" && c.status!=="failed");
      // Spec 18 lifecycle 3.7: while every unfinished chunk is parked on an enlargement (hours, not seconds) the
      // request is re-queued every 10 minutes, not every 30 seconds.
      const wait=chunks.filter(c=>c.status!=="done" && c.status!=="failed").every(c=>c.status==="queued" && c.taskName===ENLARGING_TASK) ? FINALIZE_PARKED_WAIT_S:30;
      // A product this batch is re-making (Try again, an M1-S4 improvement: outputs pending or staged again) is not
      // published yet either, even though its lastBatchId already names this batch. An improvement's try stays open
      // (`previous` kept) until its publish has seen the re-made slots, so a slot a rule dropped still waits for the
      // publish that puts it back (M1-S4 review P2-1).
      const remade = new Set([
        ...(await tx.selectDistinct({productId:catalogOutputs.productId}).from(catalogOutputs).where(and(eq(catalogOutputs.batchId,batchId),inArray(catalogOutputs.status,["pending","staged"])))).map(o=>o.productId),
        ...(await tx.selectDistinct({productId:catalogImprovements.productId}).from(catalogImprovements).where(and(eq(catalogImprovements.batchId,batchId),sql`${catalogImprovements.previous} IS NOT NULL`))).map(o=>o.productId),
      ]);
      const unpublished=pairs.filter(({pair,product})=>withSources.has(product.id) && (product.lastBatchId!==batchId || remade.has(product.id)) && pair.change!=="pending_attention" && pair.change!=="failed");
      // A done batch: a product a later batch published (its lastBatchId is another batch and this batch holds no
      // lock on it) keeps its old links in the re-issued sheet, so it does not hold the finalize up.
      const moved=done ? unpublished.filter(({product})=>product.lockBatchId!==batchId):[];
      const pairsPending=unpublished.length>moved.length;
      if(moved.length) deps.log("finalize keeps earlier links of products a later batch published",{severity:"WARNING",batchId,products:moved.map(({product})=>({productId:product.id,identifier:product.identifier,lastBatchId:product.lastBatchId}))});
      if(chunksRunning || pairsPending) {
        if(done && (chunksRunning || unpublished.some(({product})=>remade.has(product.id) && product.lockBatchId===batchId))) {
          // A done batch with a running chunk (a replacement photo), or a re-made product whose publish has not landed:
          // the request stays pending and is re-queued (a publish that changes nothing asks for no finalize itself).
          // Only the publish wait backs off (finalizeRemadeWait); a running chunk keeps the lifecycle's wait.
          const waits=chunksRunning ? 0:Number(state.finalizeRemadeWaits ?? 0);
          const next=chunksRunning ? wait:finalizeRemadeWait(waits);
          if(!chunksRunning && next===FINALIZE_PARKED_WAIT_S && finalizeRemadeWait(waits-1)<FINALIZE_PARKED_WAIT_S) deps.log("finalize keeps waiting for a re-made product's publish",{severity:"WARNING",batchId,waits:waits+1,products:unpublished.filter(({product})=>remade.has(product.id)).map(({product})=>({productId:product.id,identifier:product.identifier}))});
          await tx.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:chunksRunning ? sql`${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil' - 'finalizeEnqueuedAt'`:sql`(${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil' - 'finalizeEnqueuedAt') || jsonb_build_object('finalizeRemadeWaits',${waits+1}::int)`}).where(eq(catalogBatches.id,batchId));
          return {outcome:"not_ready",requeue:true,reopen:true,wait:next} as const;
        }
        // Not ready. A batch still running hands the request on (re-queued below). A done batch blocked only by a
        // product still being published is not re-queued: that publish asks again when it lands.
        await tx.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`(${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil' - 'finalizeEnqueuedAt') || '{"finalizePending":false}'::jsonb`}).where(eq(catalogBatches.id,batchId));
        if(done) deps.log("finalize of a done batch waits for a product publish",{severity:"WARNING",batchId,products:unpublished.map(({product})=>({productId:product.id,identifier:product.identifier,lastBatchId:product.lastBatchId}))});
        return {outcome:"not_ready",requeue:!done,reopen:false,wait} as const;
      }
      // The pending flag (and its enqueue time) stays until the done write, so the publishes and sweeps that
      // run meanwhile see a finalize already on its way and queue no second one.
      await tx.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`(${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil') || jsonb_build_object('finalizePending',true,'finalizeClaim',${claim}::text,'finalizeClaimUntil',${leaseUntil}::numeric)`}).where(eq(catalogBatches.id,batchId));
      return {outcome:"claimed",batch} as const;
    });
    if(acquired.outcome!=="claimed") {
      if(acquired.outcome==="not_ready" && acquired.requeue) await enqueueFinalize(deps,batchId,acquired.wait,{reopen:acquired.reopen});
      return {httpStatus:acquired.outcome==="busy" ? 503:200,outcome:acquired.outcome};
    }
    const batch=acquired.batch;
    // The progress counts are rate limited while a large batch processes (refreshBatchProgress); the sheet reads them
    // exact. Unchanged counts are not written, so a resumed part keeps the snapshot it checks against.
    await refreshBatchProgress(deps.db,batchId,deps.now(),{force:true});
    const budgetMs=deps.finalizeTimeBudgetMs ?? finalizeTimeBudgetMs();
    const k = batch.counts.latestExport+1,prefix=batchPrefix(batch.brandSlug,batchId,batch.isTest);
    const bucketUri=(path:string)=>deps.storage.toGsUri(deps.storage.getBucketName(),path);
    // A request that ran out of time left its attempt's state; the next one goes on with it while the batch is unchanged.
    const resumeAttempt=(batch.counts as FinalizeCounts).finalizeResume;
    let state:FinalizeState|null=null;
    if(resumeAttempt) {
      const uri=bucketUri(exportPath(prefix,`${resumeAttempt}/${FINALIZE_STATE}`));
      if((await deps.storage.headObject(uri)).exists) state=JSON.parse((await deps.storage.downloadBuffer(uri)).buf.toString()) as FinalizeState;
    }
    // Unique paths keep an expired uploader from overwriting a newer attempt's checked files.
    const attempt=state?.attempt ?? claim;
    const attemptPath=(name:string)=>exportPath(prefix,`${attempt}/${name}`);
    const paths:ExportPaths=state?.paths ?? {xlsx:bucketUri(attemptPath(`links-v${k}.xlsx`)),csv:bucketUri(attemptPath(`links-v${k}.csv`)),report:bucketUri(attemptPath(`report-v${k}.json`)),filledProductList:null,exportsMatch:false,
      exceptionsCsv:bucketUri(attemptPath(`exceptions-v${k}.csv`)),notesCsv:bucketUri(attemptPath(`delivered-with-a-note-v${k}.csv`))};
    const ingest=await readIngestReport(deps.storage,prefix);
    const extra={recheck:{ok:0,total:0,failures:[]},exports:paths,ingest};
    const build=async(db:CatalogDeps["db"])=>{
      const {rows,...built}=await buildReport(db,batchId,extra);built.batch.counts=cleanCounts(built.batch.counts);built.report.counts=built.batch.counts;
      // M1-S5 (M1-F4-R1): the digest and its two sheets from the same snapshot as the links sheet, so their numbers agree.
      // R1 exit item 4: the digest cost is every cost ledger row of the batch (cut-out and enlarging calls, every compute
      // row, failed attempts) per product with links, not batch.cost (judge and chunk compute only). The page shows the
      // live figure (digestWithCost); the daily cost check adds idle time later.
      const cost=digestCost(await batchCostFigure(db,batchId),inrPerUsdFromEnv());
      // M1-S5 review P2-4: buildReport's rows are reused, so the outputs are read once per build; only improvements are new.
      const digest=digestFrom({batch:built.batch,sheet:built.sheet,files:[...(built.report.unsupportedFiles as unknown[]),...(built.report.linkFailures as unknown[])],
        cost,leftOutProducts:ingest?.leftOutProducts ?? [],sharedPhotos:ingest?.sharedPhotos ?? [],sameFilesMerged:(ingest?.sameFiles ?? []).reduce((k,s)=>k+s.dropped.length,0),
        pairs:rows.pairs.map(r=>({productId:r.pair.productId,identifier:r.product.identifier,change:r.pair.change,notes:r.pair.notes})),outputs:rows.outputs,improvements:await readImprovements(db,batchId),tooLarge:await readTooLargePhotos(db,batchId)});
      return {...built,digest};
    };
    const initial=await deps.db.transaction(tx=>build(tx as unknown as CatalogDeps["db"]),{isolationLevel:"repeatable read"});
    // M1-S5 review P2-3: the digest's exceptions and notes rows come from the outputs and improvements the report and the
    // digest numbers already cover, so only the numbers are compared; stringifying up to 225k rows twice (once under the
    // batch row lock) added memory and time and caught nothing more.
    // The digest cost is left out: ledger rows keep landing while the batch finalizes (this request's own compute row),
    // and the digest keeps the first build's figure.
    const snapshotOf=(built:typeof initial)=>JSON.stringify({...built,digest:{...built.digest.digest,cost:undefined},report:{...built.report,exports:undefined,recheck:undefined}});
    const snapshot=snapshotOf(initial),snapshotHash=createHash("sha256").update(snapshot).digest("hex");
    let resume:RecheckProgress|undefined;
    if(state) {
      // A saved part counts only for the same sheet (same version, same snapshot). Otherwise the marker is dropped and
      // the request answers 503: its retry writes a fresh sheet under a new claim.
      if(state.k!==k || state.snapshotHash!==snapshotHash) {
        await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`${catalogBatches.counts} - 'finalizeResume'`}).where(claimWhere);
        return {httpStatus:503,outcome:"snapshot_changed"};
      }
      resume=state.progress;
    } else {
      const xlsx=await writeLinksXlsx(initial.sheet,initial.digest),csv=writeLinksCsv(initial.sheet),comparison=await compareXlsxCsv(xlsx,csv);
      if(!comparison.equal) { await deps.db.update(catalogBatches).set({error:`Links xlsx and csv differ: ${comparison.differences.join("; ")}`}).where(claimWhere); return {httpStatus:500,outcome:"exports_mismatch"}; }
      paths.exportsMatch=true;
      await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.xlsx).path,xlsx,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.csv).path,Buffer.from(csv),"text/csv");
      if(paths.exceptionsCsv) await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.exceptionsCsv).path,Buffer.from(writeExceptionsCsv(initial.digest.exceptions)),"text/csv");
      if(paths.notesCsv) await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.notesCsv).path,Buffer.from(writeNotesCsv(initial.digest.notes)),"text/csv");
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
    }
    // The re-check runs to the request's budget, and for at least a quarter of it whatever the report and sheet took,
    // so every part moves the re-check on by many links (the request deadline is 900 s, the budget 420 s).
    const sheetBytes=(await deps.storage.downloadBuffer(paths.xlsx)).buf;
    const deadlineAt=Math.max(started+budgetMs,+deps.now()+budgetMs/4);
    const part=await recheckSheetPart(sheetBytes,{fetch:deps.fetch,deadlineAt,now:()=>+deps.now(),...(resume ? {resume}:{})});
    if(!part.done) {
      // Out of time: the part is saved, the claim given back with the resume marker, and the next request queued. The
      // enqueue time is renewed with it, so the publishes and sweeps of a long re-check see a finalize on its way and
      // queue no second chain next to this one.
      const saved:FinalizeState={attempt,k,snapshotHash,paths,progress:part.progress};
      await deps.storage.uploadBuffer(attemptPath(FINALIZE_STATE),Buffer.from(JSON.stringify(saved)),"application/json");
      const handed=await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`(${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil') || jsonb_build_object('finalizeResume',${attempt}::text,'finalizeEnqueuedAt',${+deps.now()}::numeric)`}).where(claimWhere).returning({id:catalogBatches.id});
      if(!handed.length) return {httpStatus:503,outcome:"snapshot_changed"};
      // One named task per part: a repeated delivery of this request queues the next part once. A failed enqueue
      // answers 503 (below), so this request's own retry goes on from the saved part.
      await deps.enqueue("/tasks/catalog/finalize",{batchId},{taskId:`finalize-${batchId}-${attempt}-${part.progress.next}`});
      deps.log("finalize re-check continues",{batchId,checked:part.progress.next,ok:part.result.ok,failures:part.result.failures.length,durationMs:+deps.now()-started});
      return {httpStatus:200,outcome:"rechecking"};
    }
    const recheck=part.result;
    // Both Details lines count this batch's delivered links; the held products' earlier links are re-checked apart.
    const split=splitRecheck(recheck,initial.carriedLinks);
    const counts={...initial.batch.counts,latestExport:k,finalizePending:false,recheckOk:split.ok,recheckTotal:split.total,recheckCarriedOk:split.carriedOk,recheckCarriedTotal:split.carriedTotal};
    const report={...initial.report,counts,recheck,exports:paths};
    await deps.storage.uploadBuffer(deps.storage.parseGsUri(paths.report).path,Buffer.from(JSON.stringify(report)),"application/json");
    const outcome=await deps.db.transaction(async tx=>{
      const [fresh]=await tx.select().from(catalogBatches).where(claimWhere).for("update");
      if(!fresh || Number((fresh.counts as FinalizeCounts).finalizeClaimUntil)<=+deps.now()) return "snapshot_changed";
      // Every product row of the batch, locked in id order through a subquery (no bind parameter per product).
      await tx.select({id:catalogProducts.id}).from(catalogProducts).where(inArray(catalogProducts.id,batchProductIds(tx as unknown as CatalogDeps["db"],batchId))).orderBy(catalogProducts.id).for("update");
      const current=await build(tx as unknown as CatalogDeps["db"]);
      // Network work may outlive a decision or publication. Commit only the snapshot we checked.
      if(snapshotOf(current)!==snapshot) return "snapshot_changed";
      // A first finalize writes done only while the batch is not done yet (the claim guards a re-opened done batch).
      const reopened=batch.status==="done";
      // M1-F4-R1: the digest is written with done. Its "links ready" time is the first done, kept by every later finalize.
      // The first links time and the links-ready time stay the first ones across a Try again; a batch finished before M1-S5
      // keeps its finish time as links-ready. The digest also holds its two csv files, so the page and the downloads read
      // only the digest (M1-S5 review P2-3).
      const doneAt=deps.now(),built=initial.digest.digest,before=fresh.digest?.firstLinksAt ?? null;
      const digest={...built,firstLinksAt:before && (!built.firstLinksAt || before<built.firstLinksAt) ? before:built.firstLinksAt,
        linksReadyAt:fresh.digest?.linksReadyAt ?? fresh.finishedAt?.toISOString() ?? doneAt.toISOString(),page:{exceptionsCsv:paths.exceptionsCsv ?? null,notesCsv:paths.notesCsv ?? null,filled:!!paths.filledProductList,
        notRefreshedChannels:(initial.report.notRefreshedChannels ?? []) as NonNullable<BatchDigest["page"]>["notRefreshedChannels"],...initial.digest.kept}};
      const written=await tx.update(catalogBatches).set({counts,cost:initial.batch.cost,digest,status:"done",finishedAt:doneAt,sheetXlsxUri:paths.xlsx,sheetCsvUri:paths.csv,reportUri:paths.report,error:null}).where(reopened ? claimWhere:and(claimWhere,ne(catalogBatches.status,"done"))).returning({id:catalogBatches.id});
      if(!written.length) return "snapshot_changed";
      // M1-F3-R7: an auto-decide batch releases every product it locked, so none blocks the next batch.
      await releaseLocks(tx as unknown as CatalogDeps["db"],batchId,{everyProduct:autoDecideOf(batch.options)!==null});
      return "done";
    });
    if(outcome==="done") {
      const c=counts,cost=initial.batch.cost;
      deps.log("batch finalized",{batchId,brandSlug:batch.brandSlug,durationMs:+deps.now()-started,batchMs:batch.startedAt ? +deps.now()-+batch.startedAt:null,
        counts:{products:c.products,outputs:c.outputs,verified:c.verified,needsAttention:c.needsAttention,attentionProducts:c.attentionProducts,failed:c.failed,skipped:c.skipped,recheckOk:c.recheckOk,recheckTotal:c.recheckTotal},
        cost:{qaUsd:cost.qaUsd,qaCalls:cost.qaCalls,computeUsd:cost.computeUsd,computeVcpuSeconds:cost.computeVcpuSeconds,mattingMs:cost.mattingMs,renderMs:cost.renderMs}});
      // M6-S6 (M6-F3-R1): the batch's outcome row. A failed write never fails the finalize; the sweep writes it again.
      try { const o=await recordBatchOutcome(deps.db,batchId,deps.now()); if(o) deps.log("batch outcome",{batchId,success:o.success,cause:o.cause,touches:o.touches,incidents:o.incidents,deployOverlap:o.deployOverlap}); }
      catch(error) { deps.log("batch outcome not written",{severity:"WARNING",batchId,error:error instanceof Error ? error.message:String(error)}); }
    }
    return {httpStatus:outcome==="snapshot_changed" ? 503:200,outcome};
  } catch(error) { deps.log("finalize failed",{severity:"WARNING",batchId,error:error instanceof Error ? error.message:String(error)}); return {httpStatus:503,outcome:"retry"}; }
  finally {
    // A hand-off already gave the claim back (claimWhere no longer matches); otherwise the claim is dropped here.
    await deps.db.update(catalogBatches).set({updatedAt:sql`${catalogBatches.updatedAt}`,counts:sql`${catalogBatches.counts} - 'finalizeClaim' - 'finalizeClaimUntil'`}).where(claimWhere);
  }
}
