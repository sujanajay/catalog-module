import type { WizardPreview } from "../../lib/catalog/preview";
import { ANOTHER_BATCH_RUNNING, waitText } from "@catalog/core/catalog/pipeline/status";
import { canRetryLinks, count, estimateText, intakeProgress, LEAVING_LINE } from "../../lib/catalog/copy";
import GroupingPreview from "./GroupingPreview";
import OverwritePreview from "./OverwritePreview";
import { RetryLinksButton } from "./LinkFailures";
/** `batchId` and `onLinksRetried` carry "Try the failed links again" under the warnings when some links may work on a second try (spec 14b F5). */
/**
 * Step 4 before the grouping is ready: the phase words, the count and the measured time, with a bar that
 * follows `placed` while placing (spec 14c F6). A row the worker has not given a phase yet keeps the
 * plain "Collecting files <n> of <total>". Before a count exists there is none to show: no "0 of 0".
 */
export function step4CollectingLine(preview: WizardPreview | null, now: Date): { text: string; done: number; total: number } | null {
 if(!preview) return null;
 if(!preview.counts.phase) return preview.collectTotal ? { text: `Collecting files ${count(preview.collected)} of ${count(preview.collectTotal)}`, done: preview.collected, total: preview.collectTotal } : null;
 const { counted, done, total, time } = intakeProgress(preview.counts, now);
 return total ? { text: time ? `${counted}, ${time}` : counted, done, total } : null;
}
export default function WizardStep4({preview,batchId,onLinksRetried}:{preview:WizardPreview|null;batchId?:string|null;onLinksRetried?():void}) {
 if(!preview?.ready) {
  const line = step4CollectingLine(preview, new Date());
  return <section><h2>Start</h2>{line?<><p role="status">{line.text}</p><progress value={line.done} max={line.total}/></>:<><p role="status">Collecting files.</p><progress/></>}<p>{LEAVING_LINE}</p></section>;
 }
 const c=preview.counts;
 return <div className="stack"><h2>Start</h2><div className="kpis">{[[c.products,"products found"],[c.sources,"photos"],[c.channels??0,"marketplaces"],[c.outputs,"images will be made"]].map(([n,label])=><div className="card" key={label}><strong>{n}</strong>{label}</div>)}</div>
 {preview.warnings.length?<div className="warning">{preview.warnings.map((w,i)=><p key={i}>{w.headline} {w.detail}</p>)}{batchId&&canRetryLinks(preview.linkFailures)?<p><RetryLinksButton batchId={batchId} onDone={onLinksRetried}/></p>:null}</div>:null}
 <p>{estimateText(preview.estimate)}</p><p>{waitText(c.outputs)}</p>{preview.otherBatchProcessing?<p>{ANOTHER_BATCH_RUNNING}</p>:null}<OverwritePreview preview={preview}/><GroupingPreview preview={preview}/><p className="help">Once you start, you cannot add more photos to this batch. Make a new batch for anything else.</p></div>;
}
