"use client";
import { useState } from "react";
import Link from "next/link";
import { channel } from "@catalog/core/catalog/channels";
import type { EvalPage } from "../../lib/catalog/eval";
import type { ChannelId } from "@catalog/core/catalog/types";
import { apiFetch, SessionEndedError } from "../../lib/fetch";
import { ActionOnly } from "../ViewerPreview";
import { useToast } from "../Toast";

/** Reason chips in the spec 07 4.10 order, mapped to the output flags they label. */
export const EVAL_CHIPS = [
  ["complete_product", "Cut off"], ["different_product", "Different product"], ["halo", "Edge"],
  ["leftover_background", "Background"], ["text_or_watermark", "Text or watermark"], ["orientation", "Rotated"],
  ["placement", "Placement"],
] as const;
export const LABEL_SAVED_TOAST = "Label saved.";
export const EVAL_PAGE_SIZE = 50;

/** "Pass" and "Flag", the reason chips and a free-text note for one output (spec 07 4.10). */
export default function EvalLabelBar({ batchId, outputId }: { batchId: string; outputId: string }) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<"pass" | "flag" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  async function save(label: "pass" | "flag") {
    setBusy(true); setError("");
    try {
      const res = await apiFetch(`/api/catalog/batches/${batchId}/eval-labels`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outputId, label, reasons, note: note.trim() || undefined }) });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "This did not finish. Try again.");
      setSaved(label);
      toast(LABEL_SAVED_TOAST);
    } catch (err) {
      if (!(err instanceof SessionEndedError)) setError(err instanceof Error ? err.message : "This did not finish. Try again.");
    } finally { setBusy(false); }
  }

  const toggle = (flag: string) => setReasons(old => old.includes(flag) ? old.filter(r => r !== flag) : [...old, flag]);
  return (
    <div className="eval-bar">
      <div className="acts">
        <button className={`btn sm ${saved === "pass" ? "ok" : "ghost"}`} disabled={busy} onClick={() => save("pass")}>Pass</button>
        <button className={`btn sm ${saved === "flag" ? "primary" : "ghost"}`} disabled={busy} onClick={() => save("flag")}>Flag</button>
      </div>
      <div className="acts">
        {EVAL_CHIPS.map(([flag, text]) => (
          <button key={flag} type="button" className={`pill${reasons.includes(flag) ? " on" : ""}`} aria-pressed={reasons.includes(flag)} disabled={busy} onClick={() => toggle(flag)}>{text}</button>
        ))}
      </div>
      <input type="text" aria-label="Note" placeholder="Note" value={note} disabled={busy} onChange={e => setNote(e.target.value)} />
      {error ? <p role="alert" className="err">{error}</p> : null}
    </div>
  );
}

/** Eval mode of the attention tab: every output, paged, filtered by marketplace and verdict. */
export function EvalList({ batchId, data, channels, filters, canAct }: { batchId: string; data: EvalPage; channels: ChannelId[]; filters: { channel: string; verdict: string }; canAct: boolean }) {
  const pages = Math.max(1, Math.ceil(data.total / EVAL_PAGE_SIZE));
  const href = (page: number) => `?${new URLSearchParams({ ...(filters.channel ? { channel: filters.channel } : {}), ...(filters.verdict ? { verdict: filters.verdict } : {}), page: String(page) })}`;
  return (
    <>
      <p className="lead">Every image in this evaluation set is listed. Mark each one Pass or Flag; labels never change the images or the links sheet.</p>
      <form className="dl" method="get">
        <select name="channel" defaultValue={filters.channel} aria-label="Marketplace">
          <option value="">All marketplaces</option>
          {channels.map(c => <option key={c} value={c}>{channel(c).label}</option>)}
        </select>
        <select name="verdict" defaultValue={filters.verdict} aria-label="Quality check result">
          <option value="">Passed and flagged</option>
          <option value="pass">Passed</option>
          <option value="flag">Flagged</option>
        </select>
        <button className="btn ghost sm">Show</button>
      </form>
      <div className="att">
        {data.items.map(item => (
          <article className="pc" key={item.outputId}>
            <header><b className="mono">{item.identifier}</b><span className="muted">Photo {item.n}, {channel(item.channel).label}, quality check: {item.verdict === "pass" ? "passed" : "flagged"}</span></header>
            <div className="ir">
              <figure><img src={item.originalUrl} alt={`Photo ${item.n} original`} /><figcaption>Original</figcaption></figure>
              <figure>{item.outputUrl ? <img src={item.outputUrl} alt={`Photo ${item.n} made for ${channel(item.channel).label}`} /> : <div className="ph">Could not be made</div>}<figcaption>Made for {channel(item.channel).label}</figcaption></figure>
              <div className="why">
                {item.why ? <p>{item.why}</p> : null}
                {canAct && <ActionOnly><EvalLabelBar batchId={batchId} outputId={item.outputId} /></ActionOnly>}
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="dl">
        {data.page > 0 && <Link className="btn ghost sm" href={href(data.page - 1)}>Previous</Link>}
        <span className="muted">Page {data.page + 1} of {pages} · {data.total} images</span>
        {data.page + 1 < pages && <Link className="btn ghost sm" href={href(data.page + 1)}>Next</Link>}
      </div>
    </>
  );
}
