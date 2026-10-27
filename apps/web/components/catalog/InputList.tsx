"use client";
import { useEffect, useRef, useState } from "react";
import { batchUrl, wizardApi } from "./wizard-client";
import { FailedUploadStatus, NewBatchLink, UPLOAD_FAILED, uploadFailureOf, type LocalUpload, type UploadFailure } from "./Uploader";

/** A batch input as `GET /api/catalog/batches/[id]` returns it (one catalog_uploads row). */
export type ServerInput = { id: string; kind: string; name: string; relativePath: string | null; sizeBytes: number | null; status: string; error: string | null };

// Copy (spec 14b F3, parent copy register "Input list").
export const REMOVE = "Remove";
export const UPLOADED = "Uploaded";
export const CHECKED = "Checked";
export const REMOVED = "Removed";
export const DID_NOT_FINISH = "Upload did not finish. Add the file again or remove it.";
export const uploadingWord = (progress: number) => `Uploading ${progress}%`;

/** Pasted links and Google links are removed through `/links`; files through `/uploads` (as `LINK_KINDS` on the server). */
const LINK_KINDS = ["url_list", "google_sheet", "drive_folder"];
const KIND_WORDS: Record<string, string> = { image: "Photo", zip: "Zip", sheet: "Links sheet", product_list: "Product list", google_sheet: "Google Sheet", drive_folder: "Drive folder", url_list: "Pasted links" };
const kindOfName = (name: string) => /\.zip$/i.test(name) ? "zip" : /\.(csv|xls[xm])$/i.test(name) ? "sheet" : "image";

/** One line of the input list. `state` is the state word; `failure` (a failed upload in this session) replaces it with Retry and Remove. */
export interface InputRow { key: string; kind: string; name: string; size: number | null; state: string; failure?: UploadFailure; retry?(): void; remove?(): void }

/**
 * The step 1 list: every server row of the batch, in the order added, merged with this session's uploads.
 * A server row still `pending` that this session is not uploading was cut off (a closed tab, spec 14b F3).
 * A removed row is shown as "Removed" only when it was removed here (`removedHere`); older ones are hidden.
 */
export function inputRows(server: ServerInput[], local: LocalUpload[], removedHere: ReadonlySet<string>, removeServer: (input: ServerInput) => void): InputRow[] {
  const byUpload = new Map(local.filter((l) => l.uploadId).map((l) => [l.uploadId!, l]));
  const fromLocal = (l: LocalUpload, kind: string): InputRow => {
    const base = { key: l.key, kind, name: l.relativePath, size: l.size };
    if (l.status === "failed") return { ...base, state: l.failure?.message ?? UPLOAD_FAILED, failure: l.failure ?? { message: UPLOAD_FAILED, batchStarted: false }, retry: l.retry, remove: l.remove };
    return { ...base, state: l.status === "done" ? UPLOADED : uploadingWord(l.progress) };
  };
  const rows: InputRow[] = [];
  for (const s of server) {
    if (s.status === "removed" && !removedHere.has(s.id)) continue;
    const mine = byUpload.get(s.id);
    if (mine && s.status === "pending") { rows.push(fromLocal(mine, s.kind)); continue; }
    const base = { key: s.id, kind: s.kind, name: s.relativePath ?? s.name, size: s.sizeBytes };
    const remove = () => removeServer(s);
    if (s.status === "removed") rows.push({ ...base, state: REMOVED });
    else if (s.status === "pending") rows.push({ ...base, state: DID_NOT_FINISH, remove });
    else if (s.status === "uploaded") rows.push({ ...base, state: UPLOADED, remove });
    else if (s.status === "collected") rows.push({ ...base, state: CHECKED, remove });
    // A link that failed its access check keeps its own sentence (the paste box's); a file says it failed.
    else rows.push({ ...base, state: LINK_KINDS.includes(s.kind) && s.error ? s.error : UPLOAD_FAILED, remove });
  }
  // Files of this session the server does not list yet (not planned yet, or listed after the last refresh).
  const listed = new Set(server.map((s) => s.id));
  for (const l of local) if (!l.uploadId || !listed.has(l.uploadId)) rows.push(fromLocal(l, kindOfName(l.name)));
  return rows;
}

const sizeText = (bytes: number | null) => bytes === null ? null : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function InputListView({ rows }: { rows: InputRow[] }) {
  if (!rows.length) return null;
  return <ul className="upload-list" aria-label="What this batch holds">{rows.map((row) => <li key={row.key}>
    <span className="pill">{KIND_WORDS[row.kind] ?? row.kind}</span> {row.name} {sizeText(row.size) ? <small>{sizeText(row.size)}</small> : null}{" "}
    {row.failure ? <FailedUploadStatus failure={row.failure} onRetry={row.retry ?? (() => undefined)} onRemove={row.remove}/> : <>{row.state}{row.remove ? <> <button type="button" className="btn ghost sm" onClick={row.remove}>{REMOVE}</button></> : null}</>}
  </li>)}</ul>;
}

/**
 * Lists what the batch holds from the server (`GET batch`), refreshed when `version` changes, with Remove
 * (no confirmation: a removed input can be added again). Reports how many inputs remain (`onCount`).
 */
export default function InputList({ batchId, version, local, onCount, onRemoved }: { batchId: string | null; version: number; local: LocalUpload[]; onCount(count: number): void; onRemoved(input: ServerInput): void }) {
  const [server, setServer] = useState<ServerInput[]>([]);
  const [removedHere, setRemovedHere] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<UploadFailure | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    if (!batchId) return;
    const turn = ++request.current;
    // Many files finishing together refresh once.
    const timer = setTimeout(() => {
      wizardApi<{ uploads: ServerInput[] }>(batchUrl(batchId)).then((batch) => {
        if (turn !== request.current) return;
        setServer(batch.uploads);
        onCount(batch.uploads.filter((u) => u.status !== "removed").length);
      }).catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
    // onCount is a state setter wrapper from the wizard.
  }, [batchId, version, refresh]);
  async function removeServer(input: ServerInput) {
    if (!batchId) return;
    setError(null);
    try {
      await wizardApi(batchUrl(batchId, `/${LINK_KINDS.includes(input.kind) ? "links" : "uploads"}/${input.id}`), "DELETE");
      setRemovedHere((old) => new Set([...old, input.id]));
      onRemoved(input);
    } catch (err) { setError(uploadFailureOf(err)); }
    setRefresh((n) => n + 1);
  }
  return <>
    <InputListView rows={inputRows(server, local, removedHere, (input) => void removeServer(input))}/>
    {error ? <p role="alert">{error.message}{error.batchStarted ? <> <NewBatchLink/></> : null}</p> : null}
  </>;
}
