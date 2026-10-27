import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import type { BatchCounts, BatchStatus } from "@catalog/core/catalog/types";
import { ActionOnly } from "../ViewerPreview";
import { CANCEL_THIS_BATCH, collectingBannerText, CONTINUE_SETTING_UP, DRAFT_READY_TEXT, readyText, type BatchSource } from "../../lib/catalog/copy";
import { RetryLinksButton } from "./LinkFailures";
import { CancelBatchButton, FixAndContinueButton } from "./UnfinishedBatches";
/**
 * The time left is worked out on the server from startedAt and the made count (the page passes its
 * render time as `now`), so it is the same on every reload and the page auto-refresh keeps it current.
 * While collecting, the text is the phase, count and measured time with the source ("Downloading photos
 * 612 of 1,400 from your links, about 7 min left", spec 14c F6).
 * The buttons are for operators: `continueHref` adds "Continue setting up" (a batch that can still be set
 * up, spec 14a F4 part 1); `fixId` adds "Fix and continue" (failed before Start, spec 14c F8);
 * `retryLinksId` adds "Try the failed links again" (some failed links may work on a second try, spec 14b
 * F5 part 1); `cancel` adds "Cancel this batch" (not started, spec 14c F4 part 2).
 */
export default function BatchBanner({status, counts, source, updatedAt, startedAt, now, keptPhotos = 0, styliSkipped = 0, continueHref, fixId, retryLinksId, cancel}: {status:BatchStatus;counts:BatchCounts;source?:BatchSource;updatedAt?:string;startedAt?:string|null;now?:string;keptPhotos?:number;styliSkipped?:number;continueHref?:string;fixId?:string;retryLinksId?:string;cancel?:{id:string;name:string}}) {
  const at = now ? new Date(now) : new Date();
  const derived = deriveBatchState({status, counts, source, updatedAt, startedAt, now: at, styliSkipped});
  // A batch finished with "Use as is" decisions is Ready, but not every image passed every check.
  const state = derived.state === "ready" && keptPhotos > 0 ? {...derived, text: readyText(counts.outputs - counts.skipped, keptPhotos, styliSkipped)}
    // A draft whose grouping is ready says so and points at the button.
    : derived.state === "draft" && counts.previewReady ? {...derived, text: DRAFT_READY_TEXT}
    : derived.state === "collecting" && !derived.stalled ? {...derived, text: collectingBannerText(counts, source ?? "upload", at)} : derived;
  const tone = state.state === "ready" ? "ok" : state.state === "failed" ? "bad" : state.state === "cancelled" ? "" : ["attention","recheck_failed"].includes(state.state) || state.stalled ? "warn" : "run";
  return <div className="banner" role="status"><span className={`pill ${tone}`}>{state.pill}</span>{state.state === "processing" && <progress aria-label="Images made" value={state.made} max={Math.max(1,state.total)} />}<span>{state.text}</span>
    {continueHref && <ActionOnly><a className="btn primary" href={continueHref}>{CONTINUE_SETTING_UP}</a></ActionOnly>}
    {fixId && <ActionOnly><FixAndContinueButton batchId={fixId} className="btn primary" /></ActionOnly>}
    {retryLinksId && <ActionOnly><RetryLinksButton batchId={retryLinksId} /></ActionOnly>}
    {cancel && <ActionOnly><CancelBatchButton batchId={cancel.id} name={cancel.name} label={CANCEL_THIS_BATCH} /></ActionOnly>}</div>;
}
