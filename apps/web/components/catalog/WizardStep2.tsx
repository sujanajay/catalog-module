"use client";
import { useState } from "react";
import type { IdentifierMode, Precedence } from "@catalog/core/catalog/types";
import type { WizardDetected } from "../../lib/catalog/preview";
import { SHEET_READING_TEXT } from "../../lib/catalog/copy";
import { batchUrl, wizardApi } from "./wizard-client";
export type SheetChoice = {uploadId:string;identifierColumn:number;imageColumns:number[];kind:"sheet"|"product_list"};
type DetectedSheet = WizardDetected["sheets"][number];
/**
 * The operator's sheet choices after a new detection: a choice already made is kept (by uploadId), a newly
 * read sheet gets the detected columns, and a sheet still being read gets no choice yet, so the placeholder
 * columns of an unread sheet never stick once it has been read.
 */
export function mergeSheetChoices(old:SheetChoice[],detected:Pick<DetectedSheet,"uploadId"|"identifierColumn"|"imageColumns"|"kind"|"reading">[]):SheetChoice[] {
 return detected.filter((s)=>!s.reading).map((s)=>old.find((prior)=>prior.uploadId===s.uploadId) ?? {uploadId:s.uploadId,identifierColumn:s.identifierColumn,imageColumns:s.imageColumns,kind:s.kind});
}
const sheetSummary=(sheet:DetectedSheet)=>sheet.cannotRead||`Sheet ${sheet.name}: identifier column ${sheet.identifierHeader||"-"}, ${sheet.imageColumns.length} image columns, read as ${sheet.kind==="product_list"?"product list":"links sheet"}`;
export default function WizardStep2({detected,mode,precedence,sheets,setMode,setPrecedence,setSheets,email,id,onError,onAccessChecked,collecting=false}: {detected:WizardDetected;mode:IdentifierMode;precedence:Precedence;sheets:SheetChoice[];setMode(value:IdentifierMode):void;setPrecedence(value:Precedence):void;setSheets(value:SheetChoice[]):void;email:string;id:string;onError(value:string):void;onAccessChecked():Promise<void>;/** While files are collected the grouping cards are hidden; only sheets being read are shown. */collecting?:boolean}) {
 const [open,setOpen]=useState<string[]>([]);
 const update=(uploadId:string,patch:Partial<SheetChoice>)=>setSheets(sheets.map((s)=>s.uploadId===uploadId?{...s,...patch}:s));
 const reading=detected.sheets.filter((sheet)=>sheet.reading);
 if(collecting) return <div className="stack"><div><h2>Check what we found</h2></div>{reading.length?<section className="card"><h3>Sheet columns</h3>{reading.map((sheet)=><p key={sheet.uploadId}>{SHEET_READING_TEXT}</p>)}</section>:null}</div>;
 return <div className="stack"><div><h2>Check what we found</h2><p>We have looked at what you gave us. The usual answers are already selected; press Continue if they look right.</p></div>
 <section className="card"><h3>How should we tell products apart?</h3>{([["filename","By file name before the last _number","Recommended: ABC123_1.jpg, ABC123_2.jpg. This is what we detected."],["folder","By folder name","One folder per product."],["sheet_column","By the identifier column in your sheet",""]] as const).filter(([value])=>detected.identifierMode.options.includes(value)).map(([value,label,help])=><label className="opt" key={value}><input type="radio" name="identifier-mode" value={value} checked={mode===value} onChange={()=>setMode(value)}/><span>{label}<small>{help}</small></span></label>)}
 <div className="examples">{detected.identifierMode.examples.map((e)=><p key={e.identifier}><code>{e.identifier}</code> {e.label} {e.thumbs.map((url,i)=><img alt={`Example ${e.identifier} photo ${i+1}`} key={i} src={url}/>)}</p>)}</div><p className="note">{detected.identifierMode.examples.length} of {detected.totalProducts} products, so you can check the grouping.</p></section>
 {detected.precedence.shown?<section className="card"><h3>You gave us a folder and a sheet of links. Which wins when both have the same product?</h3><p className="note">Shown because you added both.</p>{([["uploads_then_links","Use the uploaded photos, fill gaps from the links"],["links_only","Use the links only"],["uploads_only","Use the uploaded photos only"]] as const).map(([value,label])=><label className="opt" key={value}><input type="radio" name="precedence" checked={precedence===value} onChange={()=>setPrecedence(value)}/><span>{label}{value==="uploads_then_links"?<small>Recommended.</small>:null}</span></label>)}</section>:null}
 <section className="card"><h3>Photo formats</h3><p>{detected.formats.sentence}</p>{detected.unreadable.length?<p>{detected.unreadable.length} files cannot be read ({detected.unreadable.map((f)=>f.name).join(", ")})</p>:<p className="help">No action needed.</p>}</section>
 {detected.sheets.length?<section className="card"><h3>Sheet columns</h3><p className="note">Shown because you added a sheet.</p>{detected.sheets.map((sheet)=>{
  if(sheet.reading) return <p key={sheet.uploadId}>{SHEET_READING_TEXT}</p>;
  const choice=sheets.find((s)=>s.uploadId===sheet.uploadId);
  // No choice yet (the next poll merges this sheet in): read-only text, never a missing choice dereferenced.
  if(!choice) return <p key={sheet.uploadId}>{sheetSummary(sheet)}</p>;
  const expanded=open.includes(sheet.uploadId)||sheet.cannotRead;
  return <div key={sheet.uploadId}><p>{sheetSummary(sheet)} <button type="button" className="btn ghost sm" onClick={()=>setOpen((old)=>old.includes(sheet.uploadId)?old.filter((id)=>id!==sheet.uploadId):[...old,sheet.uploadId])}>Change</button></p>{expanded?<div className="grid2"><label>Identifier column<select value={choice.identifierColumn} onChange={(e)=>update(sheet.uploadId,{identifierColumn:Number(e.target.value)})}><option value={-1}>Choose a column</option>{sheet.columns.map((header,index)=><option key={index} value={index}>{header||`Column ${index+1}`}</option>)}</select></label><label>Photo columns<select multiple value={choice.imageColumns.map(String)} onChange={(e)=>update(sheet.uploadId,{imageColumns:Array.from(e.target.selectedOptions).map((o)=>Number(o.value))})}>{sheet.columns.map((header,index)=><option key={index} value={index}>{header||`Column ${index+1}`}</option>)}</select></label><label>Read this sheet as<select value={choice.kind} onChange={(e)=>update(sheet.uploadId,{kind:e.target.value as SheetChoice["kind"]})}><option value="sheet">links sheet</option><option value="product_list">product list</option></select></label></div>:null}</div>;
 })}</section>:null}
 {detected.googleAccess.length?<section className="card"><h3>Google access</h3><p>For Google Sheets and Drive folders, share them with <code>{email}</code> as Viewer. Viewer is enough; we only read. We never change your files.</p>{detected.googleAccess.map((g)=><p key={g.url}><span className="pill">{g.status==="ok"?"Access confirmed":"No access yet"}</span> <span style={{overflowWrap:"anywhere"}}>{g.url}</span> {g.kind==="google_sheet"?"Google Sheet":"Drive folder"} {g.status!=="ok"?<button type="button" className="btn ghost sm" onClick={async()=>{try{const result=await wizardApi<{access:string}>(batchUrl(id,"/links"),"POST",{text:g.url});if(result.access==="ok")await wizardApi(batchUrl(id,"/ingest"),"POST");await onAccessChecked();}catch(err){onError(err instanceof Error?err.message:"Paste the link again.");}}}>Check again</button>:null}</p>)}</section>:null}
 </div>;
}
