import type { WizardPreview } from "../../lib/catalog/preview";
import { duplicatePhotosPair, samePhotosPair } from "@catalog/core/catalog/ingest/same-photos";
import { ageText } from "@catalog/core/catalog/pipeline/status";
/**
 * The step 4 overwrite notes. The same-photos pairs (spec 14d F10) link the other batch's name to its
 * page and never block Start: the operator may be re-delivering on purpose.
 */
export function SamePhotosWarnings({preview,now=new Date()}:{preview:WizardPreview;now?:Date}) {
 const o=preview.overwrite;
 const dup=duplicatePhotosPair(o.duplicatePhotos);
 return <>{o.sameBatches.map((b)=>{const p=samePhotosPair(b,preview.counts.sources,ageText(b.createdAt,now));return <div className="warning" key={b.batchId}><p>{p.before}<a href={`/catalog/${b.batchId}`}>{p.name}</a>{p.after}</p><p>{p.detail}</p></div>;})}{dup?<div className="warning"><p>{dup.headline}</p><p>{dup.detail}</p></div>:null}</>;
}
export default function OverwritePreview({preview}:{preview:WizardPreview}) {
 const o=preview.overwrite;
 return <><SamePhotosWarnings preview={preview}/><section className="warning"><p>{o.newProducts} products are new.</p>{o.existingProducts.length?<p>{o.existingProducts.length} products already exist and will be overwritten: {o.existingProducts.map((p)=>p.identifier).join(", ")}.</p>:null}{o.existingProducts.filter((p)=>p.shotsToRemove.length).map((p)=><p key={p.identifier}>{p.identifier}: {p.liveShots.length} photos live, {p.uploadShots.length} in this upload; {p.shotsToRemove.map((n)=>`_${n}`).join(" and ")} will be removed.</p>)}{o.renameHints.map((p)=><p key={p.newIdentifier}>{p.newIdentifier} has the same photos as {p.existingIdentifier}. If this is a rename, add an alias on the product page instead of uploading.</p>)}{preview.busy.length?<p>{preview.busy[0]!.identifier}{preview.busy.length>1?` and ${preview.busy.length-1} others are`:" is"} still being processed in batch {preview.busy[0]!.batchName}. Wait for it to finish or remove them from this upload.</p>:null}{o.sameProductPairs.map((p)=><p key={p.a}>{p.a} and {p.b} are the same product. Keep one.</p>)}</section></>;
}
