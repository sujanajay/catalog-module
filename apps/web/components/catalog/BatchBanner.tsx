import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import type { BatchCounts, BatchStatus } from "@catalog/core/catalog/types";
import { ActionOnly } from "../ViewerPreview";
import { CONTINUE_SETTING_UP, DRAFT_READY_TEXT, readyText } from "../../lib/catalog/copy";
/**
 * The time left is worked out on the server from startedAt and the made count (the page passes its
 * render time as `now`), so it is the same on every reload and the page auto-refresh keeps it current.
 * With `continueHref` (an operator on a batch that can still be set up, spec 14a F4 part 1) the banner
 * carries "Continue setting up".
 */
export default function BatchBanner({status, counts, source, updatedAt, startedAt, now, keptPhotos = 0, styliSkipped = 0, continueHref}: {status:BatchStatus;counts:BatchCounts;source?:string;updatedAt?:string;startedAt?:string|null;now?:string;keptPhotos?:number;styliSkipped?:number;continueHref?:string}) {
  const derived = deriveBatchState({status, counts, source, updatedAt, startedAt, now: now ? new Date(now) : undefined, styliSkipped});
  // A batch finished with "Use as is" decisions is Ready, but not every image passed every check.
  const state = derived.state === "ready" && keptPhotos > 0 ? {...derived, text: readyText(counts.outputs - counts.skipped, keptPhotos, styliSkipped)}
    // A draft whose grouping is ready says so and points at the button; other drafts keep the existing text until release C.
    : derived.state === "draft" && counts.previewReady ? {...derived, text: DRAFT_READY_TEXT} : derived;
  const tone = state.state === "ready" ? "ok" : state.state === "failed" ? "bad" : ["attention","recheck_failed"].includes(state.state) || state.stalled ? "warn" : "run";
  return <div className="banner" role="status"><span className={`pill ${tone}`}>{state.pill}</span>{state.state === "processing" && <progress aria-label="Images made" value={state.made} max={Math.max(1,state.total)} />}<span>{state.text}</span>{continueHref && <ActionOnly><a className="btn primary" href={continueHref}>{CONTINUE_SETTING_UP}</a></ActionOnly>}</div>;
}
