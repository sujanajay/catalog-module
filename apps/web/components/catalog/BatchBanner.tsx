import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import type { BatchCounts, BatchStatus } from "@catalog/core/catalog/types";
import { ActionOnly } from "../ViewerPreview";
import { canContinueSettingUp, CONTINUE_SETTING_UP, continueSettingUpHref, DRAFT_READY_TEXT, readyText } from "../../lib/catalog/copy";
/**
 * The time left is worked out on the server from startedAt and the made count (the page passes its
 * render time as `now`), so it is the same on every reload and the page auto-refresh keeps it current.
 * A draft or collecting batch that has not started carries "Continue setting up" (spec 14a F4 part 1)
 * for operators when the page passes its id and `canAct`.
 */
export default function BatchBanner({status, counts, source, updatedAt, startedAt, now, keptPhotos = 0, styliSkipped = 0, batchId, canAct = false}: {status:BatchStatus;counts:BatchCounts;source?:string;updatedAt?:string;startedAt?:string|null;now?:string;keptPhotos?:number;styliSkipped?:number;batchId?:string;canAct?:boolean}) {
  const derived = deriveBatchState({status, counts, source, updatedAt, startedAt, now: now ? new Date(now) : undefined, styliSkipped});
  // A batch finished with "Use as is" decisions is Ready, but not every image passed every check.
  const state = derived.state === "ready" && keptPhotos > 0 ? {...derived, text: readyText(counts.outputs - counts.skipped, keptPhotos, styliSkipped)}
    // A draft whose grouping is ready says so and points at the button; other drafts keep the existing text until release C.
    : derived.state === "draft" && counts.previewReady ? {...derived, text: DRAFT_READY_TEXT} : derived;
  const tone = state.state === "ready" ? "ok" : state.state === "failed" ? "bad" : ["attention","recheck_failed"].includes(state.state) || state.stalled ? "warn" : "run";
  const settingUp = canAct && !!batchId && canContinueSettingUp({status, startedAt: startedAt ?? null});
  return <div className="banner" role="status"><span className={`pill ${tone}`}>{state.pill}</span>{state.state === "processing" && <progress aria-label="Images made" value={state.made} max={Math.max(1,state.total)} />}<span>{state.text}</span>{settingUp && <ActionOnly><a className="btn primary" href={continueSettingUpHref(batchId)}>{CONTINUE_SETTING_UP}</a></ActionOnly>}</div>;
}
