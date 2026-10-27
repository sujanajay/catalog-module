import type { WizardPreview } from "../../lib/catalog/preview";
import { ANOTHER_BATCH_RUNNING, waitText } from "@catalog/core/catalog/pipeline/status";
import { estimateText, LEAVING_LINE } from "../../lib/catalog/copy";
import GroupingPreview from "./GroupingPreview";
import OverwritePreview from "./OverwritePreview";
export default function WizardStep4({preview}:{preview:WizardPreview|null}) {
 if(!preview?.ready) return <section><h2>Start</h2><p role="status">Collecting files {preview?.collected??0} of {preview?.collectTotal??0}</p><progress value={preview?.collected??0} max={Math.max(1,preview?.collectTotal??1)}/><p>{LEAVING_LINE}</p></section>;
 const c=preview.counts;
 return <div className="stack"><h2>Start</h2><div className="kpis">{[[c.products,"products found"],[c.sources,"photos"],[c.channels??0,"marketplaces"],[c.outputs,"images will be made"]].map(([n,label])=><div className="card" key={label}><strong>{n}</strong>{label}</div>)}</div>
 {preview.warnings.length?<div className="warning">{preview.warnings.map((w,i)=><p key={i}>{w.headline} {w.detail}</p>)}</div>:null}
 <p>{estimateText(preview.estimate)}</p><p>{waitText(c.outputs)}</p>{preview.otherBatchProcessing?<p>{ANOTHER_BATCH_RUNNING}</p>:null}<OverwritePreview preview={preview}/><GroupingPreview preview={preview}/><p className="help">Once you start, you cannot add more photos to this batch. Make a new batch for anything else.</p></div>;
}
