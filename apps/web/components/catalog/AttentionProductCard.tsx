"use client";
import { useState } from "react";
import { channel } from "@catalog/core/catalog/channels";
import type { AttentionPhoto, AttentionProduct } from "../../lib/catalog/products";
import { listAnd, plural } from "../../lib/catalog/copy";
import { apiFetch, SessionEndedError } from "../../lib/fetch";
import { ActionOnly } from "../ViewerPreview";
import { useToast } from "../Toast";
import ReplaceModal from "./ReplaceModal";

/** open: needs a decision; done: decided (here or elsewhere); replacing: a replacement is queued. */
export type PhotoState = "open" | "done" | "replacing";

export const KEPT_TOAST = "Kept in the sheet";
export const REMOVED_TOAST = "Removed. The sheet cell is empty with a note.";

function liveSentence(photo: AttentionPhoto): string {
  return `This removes the live image for this photo on ${listAnd(photo.liveChannels.map(c => channel(c).label))}.`;
}

interface RowProps { item: AttentionProduct; photo: AttentionPhoto; state: PhotoState; canAct: boolean; channels: string[]; onDecided(ids: string[], state: PhotoState): void }

function PhotoRow({ item, photo, state, canAct, channels, onDecided }: RowProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const label = channel(photo.channel).label;
  const decided = state !== "open";

  async function decide(decision: "use_as_is" | "remove") {
    setBusy(true); setError("");
    try {
      const res = await apiFetch(`/api/catalog/outputs/${photo.outputId}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      const data = await res.json() as { outputIds?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "This did not finish. Try again.");
      onDecided(data.outputIds?.length ? data.outputIds : [photo.outputId], "done");
      toast(decision === "use_as_is" ? KEPT_TOAST : REMOVED_TOAST);
    } catch (err) {
      if (!(err instanceof SessionEndedError)) setError(err instanceof Error ? err.message : "This did not finish. Try again.");
    } finally { setBusy(false); setConfirming(false); }
  }

  return (
    <div className={decided ? "ir decided" : "ir"}>
      <figure>
        <img src={photo.originalUrl} alt={`Photo ${photo.n} original`} />
        <figcaption>Photo {photo.n} of {item.totalShots}, original</figcaption>
      </figure>
      <figure>
        {photo.outputUrl ? <img src={photo.outputUrl} alt={`Photo ${photo.n} made for ${label}`} /> : <div className="ph">Could not be made</div>}
        <figcaption>Photo {photo.n} of {item.totalShots}, made for {label}</figcaption>
      </figure>
      <div className="why">
        <b>{photo.why}</b>
        <p>{photo.whatToDo}{photo.liveObjectExists ? ` ${liveSentence(photo)}` : ""}</p>
        {state === "replacing" && <p role="status">Replacement in progress</p>}
        {canAct && (
          <ActionOnly>
            {error ? <p role="alert" className="err">{error}</p> : null}
            {confirming ? (
              <div className="acts">
                <button className="btn sm primary" disabled={busy} onClick={() => decide("remove")}>Remove anyway</button>
                <button className="btn sm ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            ) : (
              <div className="acts">
                <button className="btn sm ok" disabled={busy || decided} onClick={() => decide("use_as_is")}>Use as is</button>
                <button className="btn sm ghost" disabled={busy || decided} onClick={() => (photo.liveObjectExists ? setConfirming(true) : decide("remove"))}>Remove this photo</button>
                <button className="btn sm ghost" disabled={busy || decided} onClick={() => setReplacing(true)}>Replace photo {photo.n}</button>
              </div>
            )}
            {replacing && (
              <ReplaceModal outputId={photo.outputId} n={photo.n} identifier={item.identifier} channels={channels}
                onClose={() => setReplacing(false)}
                onQueued={() => onDecided(photo.outputIds.length ? photo.outputIds : [photo.outputId], "replacing")} />
            )}
          </ActionOnly>
        )}
      </div>
    </div>
  );
}

interface CardProps { item: AttentionProduct; canAct: boolean; channels: string[]; stateOf?(outputId: string): PhotoState; onDecided?(ids: string[], state: PhotoState): void }

/** One product with a problem; collapses to the resolved card once no photo needs a decision. */
export default function AttentionProductCard({ item, canAct, channels, stateOf = () => "open", onDecided = () => {} }: CardProps) {
  if (!item.photos.some(p => stateOf(p.outputId) === "open")) {
    return <article className="pc resolved"><span className="pill ok">Resolved</span> <b className="mono">{item.identifier}</b> <span>Sheet updated.</span></article>;
  }
  return (
    <article className="pc">
      <header>
        <b className="mono">{item.identifier}</b>
        <span className="muted">{new Set(item.photos.map(p => p.n)).size} of {item.totalShots} {plural(item.totalShots, "photo needs", "photos need")} a decision</span>
      </header>
      <p className="prob">{item.problemLine}</p>
      {item.photos.map(p => <PhotoRow key={p.outputId} item={item} photo={p} state={stateOf(p.outputId)} canAct={canAct} channels={channels} onDecided={onDecided} />)}
    </article>
  );
}
