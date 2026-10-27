"use client";
// "Your unfinished batches" on the batch list (spec 14c F4 part 2), and the Cancel and "Fix and continue"
// buttons it shares with the batch page. Cancel asks inline (not a modal); Fix and continue reopens the
// batch (POST /reopen, F8) and opens step 1, which shows the reason the batch could not start.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SessionEndedError } from "@/lib/fetch";
import { useToast } from "@/components/Toast";
import { ActionOnly } from "@/components/ViewerPreview";
import type { UnfinishedBatch } from "@/lib/catalog/batches";
import { CANCEL, cancelConfirmText, CONTINUE, continueSettingUpHref, createdAgoText, FIX_AND_CONTINUE, KEEP_IT, UNFINISHED_HEADING, YES_CANCEL } from "@/lib/catalog/copy";
import { batchUrl, wizardApi } from "./wizard-client";

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "This did not finish. Try again.");

/** The inline confirmation: "Cancel <name>? Nothing was processed and nothing was charged." with Yes, cancel and Keep it. */
export function CancelConfirmView({ name, busy = false, onYes, onKeep }: { name: string; busy?: boolean; onYes?(): void; onKeep?(): void }) {
  return <span className="cancel-confirm" role="group" aria-label={cancelConfirmText(name)}>
    <span>{cancelConfirmText(name)}</span>{" "}
    <button type="button" className="btn primary sm" disabled={busy} onClick={onYes}>{busy ? "Please wait..." : YES_CANCEL}</button>{" "}
    <button type="button" className="btn ghost sm" disabled={busy} onClick={onKeep}>{KEEP_IT}</button>
  </span>;
}

/** Cancel (or "Cancel this batch" on the batch page): asks first, then POST /cancel and reloads the page data. */
export function CancelBatchButton({ batchId, name, label = CANCEL }: { batchId: string; name: string; label?: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  async function cancel() {
    setBusy(true);
    try {
      await wizardApi(batchUrl(batchId, "/cancel"), "POST");
      setAsking(false);
      router.refresh();
    } catch (err) {
      if (!(err instanceof SessionEndedError)) toast(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (asking) return <CancelConfirmView name={name} busy={busy} onYes={() => void cancel()} onKeep={() => setAsking(false)} />;
  return <button type="button" className="btn ghost sm" onClick={() => setAsking(true)}>{label}</button>;
}

/** "Fix and continue": reopens a batch that failed before Start and opens the wizard at step 1 (a full page load, so a wizard already open starts again). */
export function FixAndContinueButton({ batchId, className = "btn primary sm" }: { batchId: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function fix() {
    setBusy(true);
    try {
      await wizardApi(batchUrl(batchId, "/reopen"), "POST");
      window.location.assign(continueSettingUpHref(batchId));
    } catch (err) {
      if (!(err instanceof SessionEndedError)) toast(errorText(err));
      setBusy(false);
    }
  }
  return <button type="button" className={className} disabled={busy} onClick={() => void fix()}>{busy ? "Please wait..." : FIX_AND_CONTINUE}</button>;
}

/**
 * The section, absent when there is nothing unfinished. `canAct` (operators and admins) adds Continue or
 * Fix and continue, and Cancel; a viewer sees the rows only. `showCreator` names who made each batch.
 */
export default function UnfinishedBatches({ rows, canAct, showCreator }: { rows: UnfinishedBatch[]; canAct: boolean; showCreator: boolean }) {
  if (!rows.length) return null;
  return <section className="unfinished" aria-labelledby="unfinished-heading"><h2 id="unfinished-heading">{UNFINISHED_HEADING}</h2>
    <ul>{rows.map((b) => <li key={b.id} className="card">
      <div className="unfinished-main">
        <a href={`/catalog/${b.id}`}><strong>{b.name}</strong></a> <span className="muted">{b.brandName}</span>
        <div>{b.words}</div>
        <div className="help">{createdAgoText(b.age)}{showCreator ? ` by ${b.createdBy}` : ""}</div>
      </div>
      {canAct ? <ActionOnly><div className="acts">
        {b.fixable ? <FixAndContinueButton batchId={b.id} /> : <a className="btn primary sm" href={continueSettingUpHref(b.id)}>{CONTINUE}</a>}
        <CancelBatchButton batchId={b.id} name={b.name} />
      </div></ActionOnly> : null}
    </li>)}</ul>
  </section>;
}
