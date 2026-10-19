"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { listAnd } from "../../lib/catalog/copy";
import { apiFetch, SessionEndedError } from "../../lib/fetch";
import { useToast } from "../Toast";

export const REPLACEMENT_TOAST = "Replacement queued. Usually done in a minute.";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "This did not finish. Try again.");
  return data;
}

/** The signed URL goes straight to storage, so it is a plain PUT with the signed content type. */
async function putFile(url: string, file: File, mime: string): Promise<void> {
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": mime }, body: file });
  if (!res.ok) throw new Error("Upload failed. Try again.");
}

interface Props { outputId: string; n: number; identifier: string; channels: string[]; onClose(): void; onQueued(): void }

/** "Replace photo <n> of <identifier>" (spec 07 4.8, spec 01 section 8). */
export default function ReplaceModal({ outputId, n, identifier, channels, onClose, onQueued }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => { ref.current?.showModal(); }, []);

  function drop(e: DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }

  async function upload() {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const mime = file.type || "application/octet-stream";
      const plan = await postJson<{ uploadId: string; signedPutUrl: string }>(`/api/catalog/outputs/${outputId}/replacement`, { name: file.name, size: file.size, mime });
      await putFile(plan.signedPutUrl, file, mime);
      await postJson(`/api/catalog/outputs/${outputId}/replacement/complete`, { uploadId: plan.uploadId });
      toast(REPLACEMENT_TOAST);
      onQueued();
      onClose();
    } catch (err) {
      if (!(err instanceof SessionEndedError)) setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={ref} aria-labelledby={`replace-${outputId}`} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
      <h2 id={`replace-${outputId}`}>Replace photo {n} of {identifier}</h2>
      <p>Drop the new photo. We will make it for {listAnd(channels)} again and update the sheet. Nothing else changes.</p>
      <div className="drop" onDragOver={e => e.preventDefault()} onDrop={drop}>
        <button type="button" className="drop-select" disabled={busy} onClick={() => input.current?.click()}>
          <b>Drop one photo</b><br /><span className="mono">{file ? file.name : `${identifier}_${n}.jpg`}</span>
        </button>
        <input ref={input} type="file" accept="image/*" hidden aria-label="Choose the new photo" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {error ? <p role="alert" className="err">{error}</p> : null}
      <div className="acts">
        <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !file} onClick={upload}>Upload</button>
      </div>
    </dialog>
  );
}
