import { costLine } from "../cost";
import { QA_DIMENSIONS } from "../qa/judge";
import { QA_CAP_BANNER } from "./status";
import { and, eq, inArray } from "drizzle-orm";
import ExcelJS from "exceljs";
import { buildCsv } from "../../csv";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages, catalogUploads, type CatalogBatch } from "../../db/schema";
import { CHANNEL_ORDER } from "../channels";
import type { SheetSpec } from "../sheet";
import { CHANNEL_IDS, type ChannelId, type LinkStatus, type ChangeKind, type SheetStatus } from "../types";
import { outputNote, type Output } from "./publish";
import type { RecheckResult } from "../recheck/index";
import { isDuplicateReject } from "../ingest/group";
import type * as storage from "../../storage";
export function batchSheetStatus(member: { linkStatus: LinkStatus; change: ChangeKind }): SheetStatus {
  if (member.linkStatus === "missing_images") return "missing_images";
  return member.change === "pending_attention" || member.change === "failed" ? "needs_attention" : member.linkStatus;
}
/** The sheet's notes cell: the product's stored notes, then every extra note not already in them (spec 06 5.6). */
export function mergeNotes(stored: string | null, extra: readonly string[]): string {
  const base = stored ?? "";
  return [...new Set([base, ...extra.filter(note => note && !base.includes(note))].filter(Boolean))].join("; ");
}
/** "Photos 1 and 3: ..." for the shots of this batch flagged cut_in_source (information; never holds the product). */
export function cutInSourceNote(outputs: readonly Pick<Output, "n" | "status" | "flags">[]): string {
  const shots = [...new Set(outputs.filter(o => o.flags.includes("cut_in_source") && o.status !== "failed" && o.status !== "skipped").map(o => o.n))].sort((a, b) => a - b);
  if (!shots.length) return "";
  const list = shots.length > 1 ? `${shots.slice(0, -1).join(", ")} and ${shots.at(-1)}` : String(shots[0]);
  return `${shots.length > 1 ? "Photos" : "Photo"} ${list}: already cut at the frame edge in the original photo; the cut edge sits flush with the edge of the image`;
}
export interface NotRefreshedChannel { channel: ChannelId; lastBatchId: string; lastBatchName: string }
export async function notRefreshedChannels(db:Db,batchId:string):Promise<NotRefreshedChannel[]> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id,batchId));
  if(!batch) return [];
  const ids = db.select({id:catalogBatchProducts.productId}).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId,batchId));
  const rows = await db.select({output:catalogOutputs,batch:catalogBatches}).from(catalogOutputs).innerJoin(catalogBatches,eq(catalogBatches.id,catalogOutputs.batchId)).where(and(inArray(catalogOutputs.productId,ids),eq(catalogOutputs.isLive,true)));
  return CHANNEL_IDS.filter(c=>!batch.channels.includes(c)).flatMap(c=> {
    const latest = rows.filter(r=>r.output.channel===c).sort((a,b)=>+(b.output.publishedAt ?? b.output.createdAt)-+(a.output.publishedAt ?? a.output.createdAt))[0];
    return latest ? [{channel:c,lastBatchId:latest.batch.id,lastBatchName:latest.batch.name}]:[];
  });
}
export interface ExportPaths { xlsx:string; csv:string; report:string; filledProductList:{xlsx:string;csv:string[]}|null; exportsMatch:boolean }
export interface IngestReport { unsupportedFiles:unknown[];duplicates:unknown[];sourceOrigins?:Record<string,{origin:string;sourceUrl?:string;relativePath?:string}> }
/** The reject ledger written by ingest includes files that have no product/source DB row. */
export async function readIngestReport(store:Pick<typeof storage,"headObject"|"downloadBuffer"|"getBucketName">,prefix:string):Promise<IngestReport|undefined> {
  const uri=`gs://${store.getBucketName()}/${prefix}/derived/_ingest/preview-state.json`;
  if(!(await store.headObject(uri)).exists) return undefined;
  type StoredOrigin={rawUri:string|null;item:{originalName:string;origin:string;bytes:{kind:string;url?:string}}};
  const state=JSON.parse((await store.downloadBuffer(uri)).buf.toString()) as {rejected?:{item:{item:{originalName:string;identifier:string}};reason:string}[];duplicates?:unknown[];products?:{items:StoredOrigin[]}[]};
  const rejected=(state.rejected ?? []).map(r=>({name:r.item.item.originalName,identifier:r.item.item.identifier,reason:r.reason}));
  const sourceOrigins:NonNullable<IngestReport["sourceOrigins"]>={};
  for(const source of (state.products ?? []).flatMap(p=>p.items)) if(source.rawUri) sourceOrigins[source.rawUri]={origin:source.item.origin,...(source.item.bytes.kind==="url" ? {sourceUrl:source.item.bytes.url}:{relativePath:source.item.originalName})};
  return {unsupportedFiles:rejected.filter(r=>!isDuplicateReject(r.reason)),duplicates:[...rejected.filter(r=>isDuplicateReject(r.reason)),...(state.duplicates ?? [])],sourceOrigins};
}
export async function workbookCsvSheets(bytes:Buffer):Promise<{name:string;csv:string}[]> {
  const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook.worksheets.map(sheet=> {
    const rows=Array.from({length:sheet.rowCount},(_,r)=>Array.from({length:sheet.columnCount},(_,c)=>sheet.getCell(r+1,c+1).text));
    return {name:sheet.name,csv:buildCsv(rows[0] ?? [],rows.slice(1))};
  });
}
const autoActionOf = (o: Output) => (o.qaScores as { autoAction?: unknown } | null)?.autoAction;
/** Share of the batch's products held for a person (0 to 1); the QA target is 0. */
export function attentionRate(productsHeld: number, products: number): number {
  return products ? productsHeld / products : 0;
}
/**
 * Why a judged output was flagged, for evals and the technical team (never shown to operators): the
 * scores, the per-dimension thresholds, each evidence sentence with the model that gave it, every
 * judgement made (judged channel, re-checks, second opinion), the automatic action and the final status.
 */
export function qaReportEntry(o: Output): Record<string, unknown> | null {
  const qa = o.qaScores as Record<string, unknown> | null;
  if (!qa) return null;
  const scores = Object.fromEntries(QA_DIMENSIONS.map(d => [d, qa[d] ?? null]));
  return { scores, overall: qa.overall ?? null, verdict: qa.verdict ?? null, thresholds: qa.thresholds ?? null, view: qa.view ?? null, evidence: qa.evidence ?? null, reasons: qa.reasons ?? [],
    model: o.qaModel, wrongItem: qa.wrongItem ?? null, judgements: qa.judgements ?? [], autoAction: qa.autoAction ?? null, holdCause: qa.holdCause ?? null, finalStatus: o.status, decision: o.decision };
}
export async function buildReport(db:Db,batchId:string,extra:{recheck:RecheckResult;exports:ExportPaths;ingest?:IngestReport}):Promise<{sheet:SheetSpec;report:Record<string,unknown>;batch:CatalogBatch}> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id,batchId));
  if(!batch) throw new Error("Batch not found.");
  const pairs = await db.select({product:catalogProducts,pair:catalogBatchProducts}).from(catalogBatchProducts).innerJoin(catalogProducts,eq(catalogProducts.id,catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId,batchId));
  const ids = pairs.map(p=>p.product.id);
  const outputs = ids.length ? await db.select().from(catalogOutputs).where(inArray(catalogOutputs.productId,ids)):[];
  const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId,batchId));
  const uploads = await db.select().from(catalogUploads).where(eq(catalogUploads.batchId,batchId));
  const events = await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId,batchId));
  const chunks = await db.select().from(catalogChunks).where(eq(catalogChunks.batchId,batchId));
  const rows:SheetSpec["rows"] = pairs.map(({product,pair})=> {
    const live = outputs.filter(o=>o.productId===product.id && o.isLive && batch.channels.includes(o.channel));
    const problems = outputs.filter(o=>o.productId===product.id && o.batchId===batchId && o.reason && (["skipped","failed","needs_attention"].includes(o.status) || o.decision === "use_as_is" || autoActionOf(o) === "note")).map(outputNote);
    const links:SheetSpec["rows"][number]["links"] = {};
    for (const output of live) { links[output.channel] ??= []; links[output.channel]![output.n-1]=output.publicUrl; }
    const times = live.flatMap(o=>o.publishedAt ? [+o.publishedAt]:[]);
    return {brand:batch.brandName,identifier:product.identifier,optionIdStyleColor:product.optionIdStyleColor ?? "",opptraSkuIds:product.opptraSkuIds,links,status:batchSheetStatus(pair),notes:mergeNotes(pair.notes,[...problems,cutInSourceNote(outputs.filter(o=>o.productId===product.id && o.batchId===batchId))]),change:pair.change,changedAt:times.length ? new Date(Math.max(...times)):null};
  });
  const selected = outputs.filter(o=>o.batchId===batchId), unchanged = pairs.reduce((n,{product})=>n+Math.max(0,sources.filter(s=>s.productId===product.id).length*batch.channels.length-selected.filter(o=>o.productId===product.id).length),0);
  const qaCap=selected.some(output=>output.flags.includes("qa_cap"));
  // qaCapped is a jsonb-only key (not in BatchCounts) read by deriveBatchState for the 07 4.5 banner.
  const counts = {...batch.counts,qaCapped:qaCap,verified:selected.filter(o=>o.status==="verified" && o.isLive).length+unchanged,needsAttention:selected.filter(o=>o.status==="needs_attention").length,attentionProducts:pairs.filter(p=>p.pair.change==="pending_attention").length,failed:selected.filter(o=>o.status==="failed").length,skipped:selected.filter(o=>o.status==="skipped").length,unchanged,recheckOk:extra.recheck.ok,recheckTotal:extra.recheck.total};
  const line=costLine({cost:batch.cost,products:pairs.map(({pair,product})=>({change:pair.change,outputs:selected.filter(output=>output.productId===product.id && output.decision!=="replaced")}))});
  const cost={...batch.cost,identifiers:line.identifiers,usdPerIdentifier:line.usdPerIdentifier,inrPerIdentifier:line.inrPerIdentifier};
  const judged = selected.filter(o=>o.qaScores), autoActions = Object.fromEntries(["none","note","drop","hold"].map(a=>[a,judged.filter(o=>(autoActionOf(o) ?? "none")===a).length]));
  const qa = {judgedOutputs:judged.length,autoActions,productsHeld:counts.attentionProducts,products:pairs.length,attentionRate:attentionRate(counts.attentionProducts,pairs.length)};
  const report = {batchId,brand:batch.brandName,channels:batch.channels,summary:{linksPlanned:counts.outputs-counts.skipped,linksVerified:counts.verified,linksSkipped:counts.skipped,productsHeld:counts.attentionProducts},counts,cost,qa,...(qaCap ? {banner:QA_CAP_BANNER}:{}),
    products:pairs.map(({product,pair})=>({identifier:product.identifier,pathKey:product.pathKey,linkStatus:pair.linkStatus,change:pair.change,changedAt:rows.find(r=>r.identifier===product.identifier)?.changedAt,optionIdStyleColor:product.optionIdStyleColor,opptraSkuIds:product.opptraSkuIds,sources:sources.filter(s=>s.productId===product.id).map(s=>({n:s.n,originalName:s.originalName,...(extra.ingest?.sourceOrigins?.[s.rawUri] ?? {origin:uploads.find(u=>u.id===s.uploadId)?.kind ?? "image",relativePath:s.originalName}),mime:s.mime,width:s.width,height:s.height,sha256:s.sha256,rawUri:s.rawUri,status:s.status,flags:s.flags})),outputs:outputs.filter(o=>o.productId===product.id && (o.batchId===batchId || o.isLive)).map(o=>({channel:o.channel,n:o.n,status:o.status,url:o.isLive ? o.publicUrl:null,generation:o.generation,flags:o.flags,reason:o.reason,qa:qaReportEntry(o)}))})),
    overwrites:events.filter(e=>["overwritten","shots_removed","reordered","channel_added"].includes(e.kind)).flatMap((e):Record<string,unknown>[]=> {
      const identifier=pairs.find(p=>p.product.id===e.productId)?.product.identifier;
      const changes=Array.isArray(e.details.changes) ? e.details.changes as Record<string,unknown>[]:[];
      return changes.length ? changes.map(c=>({identifier,kind:e.kind,channels:[c.channel],shots:[c.n],oldGeneration:c.oldGeneration,newGeneration:c.newGeneration,sha256:c.sha256})):[{identifier,kind:e.kind,channels:e.details.channels,shots:e.details.shots,oldGeneration:null,newGeneration:null,sha256:null}];
    }),notRefreshedChannels:await notRefreshedChannels(db,batchId),removedLinks:events.flatMap(e=>e.kind==="shots_removed" && Array.isArray(e.details.removedLinks) ? e.details.removedLinks.map((r:unknown)=>({identifier:pairs.find(p=>p.product.id===e.productId)?.product.identifier,...r as Record<string,unknown>})):[]),recheck:extra.recheck,exports:extra.exports,
    unsupportedFiles:extra.ingest?.unsupportedFiles ?? uploads.flatMap(u=>Array.isArray(u.detected?.rejected) ? u.detected.rejected:[]),duplicates:extra.ingest?.duplicates ?? pairs.filter(p=>p.pair.flags.includes("duplicate_shot")).map(p=>({identifier:p.product.identifier,reason:p.pair.notes})),unresolvedIdentifiers:pairs.filter(p=>!p.product.opptraSkuIds.length).map(p=>p.product.identifier),chunks:chunks.map(c=>({index:c.index,stage:c.stage,status:c.status,attempt:c.attempt,error:c.error}))};
  return {sheet:{channels:CHANNEL_ORDER.filter(c=>batch.channels.includes(c)),rows},report,batch:{...batch,counts,cost}};
}
