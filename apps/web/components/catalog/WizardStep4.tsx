import type { WizardPreview } from "../../lib/catalog/preview";
import { ANOTHER_BATCH_RUNNING, waitText } from "@catalog/core/catalog/pipeline/status";
import { canRetryLinks, estimateText, LEAVING_LINE } from "../../lib/catalog/copy";
import GroupingPreview from "./GroupingPreview";
import OverwritePreview from "./OverwritePreview";
import { RetryLinksButton } from "./LinkFailures";
/** `batchId` and `onLinksRetried` carry "Try the failed links again" under the warnings when some links may work on a second try (spec 14b F5). */
export default function WizardStep4({preview,batchId,onLinksRetried}:{preview:WizardPreview|null;batchId?:string|null;onLinksRetried?():void}) {
 // Before the first preview (or before the files are listed) there is no count yet: no "0 of 0".
 if(!preview?.ready) return <section><h2>Start</h2>{preview?.collectTotal?<><p role="status">Collecting files {preview.collected} of {preview.collectTotal}</p><progress value={preview.collected} max={preview.collectTotal}/></>:<><p role="status">Collecting files.</p><progress/></>}<p>{LEAVING_LINE}</p></section>;
 const c=preview.counts;
 return <div className="stack"><h2>Start</h2><div className="kpis">{[[c.products,"products found"],[c.sources,"photos"],[c.channels??0,"marketplaces"],[c.outputs,"images will be made"]].map(([n,label])=><div className="card" key={label}><strong>{n}</strong>{label}</div>)}</div>
 {preview.warnings.length?<div className="warning">{preview.warnings.map((w,i)=><p key={i}>{w.headline} {w.detail}</p>)}{batchId&&canRetryLinks(preview.linkFailures)?<p><RetryLinksButton batchId={batchId} onDone={onLinksRetried}/></p>:null}</div>:null}
 <p>{estimateText(preview.estimate)}</p><p>{waitText(c.outputs)}</p>{preview.otherBatchProcessing?<p>{ANOTHER_BATCH_RUNNING}</p>:null}<OverwritePreview preview={preview}/><GroupingPreview preview={preview}/><p className="help">Once you start, you cannot add more photos to this batch. Make a new batch for anything else.</p></div>;
}
