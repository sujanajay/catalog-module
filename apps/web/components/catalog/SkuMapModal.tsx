"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, SessionEndedError } from "../../lib/fetch";
import { useToast } from "../Toast";
import AutoRefresh from "../AutoRefresh";

export const skuAddedToast = (n: number) => `${n} ids added. New links sheet ready.`;
export const missingLine = (n: number) => `${n} identifiers have no Opptra SKU id yet in this batch.`;
export const unmatchedLine = (rows: string[]) => `${rows.length} rows did not match any identifier in this batch: ${rows.join(", ")}`;

interface Props { batchId: string; missing: number; sheetUri: string | null }

/** "Add Opptra SKU ids" (spec 07 4.9, spec 01 "Links sheet tab: Add SKU ids"). Operator only. */
export default function SkuMapModal({ batchId, missing, sheetUri }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unmatched, setUnmatched] = useState<string[]>([]);
  // The links sheet the page showed when ids were applied; a different one means finalize has run.
  const [waitingFor, setWaitingFor] = useState<string | null | undefined>(undefined);
  const toast = useToast();
  const router = useRouter();
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  const ready = waitingFor !== undefined && sheetUri !== waitingFor;

  function show() { setFile(null); setError(""); setUnmatched([]); setOpen(true); }
  function drop(e: DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }

  async function apply() {
    if (!file) return;
    setBusy(true); setError(""); setUnmatched([]);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch(`/api/catalog/batches/${batchId}/sku-map`, { method: "POST", body: form });
      const data = await res.json() as { added?: number; unmatched?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "This did not finish. Try again.");
      toast(skuAddedToast(data.added ?? 0));
      setWaitingFor(sheetUri);
      router.refresh();
      if (data.unmatched?.length) setUnmatched(data.unmatched);
      else setOpen(false);
    } catch (err) {
      if (!(err instanceof SessionEndedError)) setError(err instanceof Error ? err.message : "This did not finish. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <button className="btn ghost" onClick={show}>Add SKU ids</button>
      {ready ? <p role="status">New links sheet ready</p> : <AutoRefresh active={waitingFor !== undefined} />}
      <dialog ref={ref} aria-labelledby="sku-map-title" onCancel={e => { e.preventDefault(); if (!busy) setOpen(false); }}>
        <h2 id="sku-map-title">Add Opptra SKU ids</h2>
        <p>Upload a sheet with two columns: identifier and opptra_sku_id. We fill the gaps and make a new links sheet. Nothing is re-processed.</p>
        <p className="help">{missingLine(missing)}</p>
        <div className="drop" onDragOver={e => e.preventDefault()} onDrop={drop}>
          <button type="button" className="drop-select" disabled={busy} onClick={() => input.current?.click()}>
            <b>Drop the mapping sheet (xlsx or csv)</b>{file ? <><br /><span className="mono">{file.name}</span></> : null}
          </button>
          <input ref={input} type="file" accept=".xlsx,.csv" hidden aria-label="Choose the mapping sheet" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </div>
        {unmatched.length ? <p>{unmatchedLine(unmatched)}</p> : null}
        {error ? <p role="alert" className="err">{error}</p> : null}
        <div className="acts">
          <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={busy || !file} onClick={apply}>Apply</button>
        </div>
      </dialog>
    </>
  );
}
