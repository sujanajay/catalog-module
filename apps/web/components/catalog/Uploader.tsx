"use client";
import { useEffect, useRef, useState } from "react";
import { batchUrl, wizardApi, WizardApiError } from "./wizard-client";
type UploadRow = {key: string; file: File; relativePath: string; progress: number; status: "queued" | "uploading" | "done" | "failed"; plan?: Plan; plannedAt?: number; failure?: UploadFailure};
/** Why an upload failed: the server's sentence, and whether the batch has already started (409). */
export type UploadFailure = {message: string; batchStarted: boolean};
export const UPLOAD_FAILED = "Upload failed. Try again or remove it.";
/** A file this browser session is uploading, as the step 1 input list shows it (spec 14b F3). */
export type LocalUpload = {key: string; uploadId?: string; name: string; relativePath: string; size: number; progress: number; status: UploadRow["status"]; failure?: UploadFailure; retry(): void; remove(): void};
/** The signed PUT link's lifetime: `SIGNED_PUT_TTL_SEC` of `@catalog/core/storage` (spec 02), which a test checks. */
export const SIGNED_PUT_TTL_MS = 900_000;
/** A link this close to its end is planned again, so it cannot expire during the PUT. */
const REPLAN_MARGIN_MS = 60_000;
export function planExpired(plannedAt: number | undefined, now: number): boolean {
  return plannedAt === undefined || now - plannedAt > SIGNED_PUT_TTL_MS - REPLAN_MARGIN_MS;
}
export type SendDeps = {api<T>(url: string, method?: string, value?: unknown): Promise<T>; put(file: File, plan: Plan, progress: (value: number) => void): Promise<void>; now(): number};
/**
 * Plans (or plans again), PUTs and completes one file. Retry of a row whose signed link has expired
 * (older than the TTL, spec 14b F3) first removes the old pending row, so the batch does not wait for
 * bytes that will never come, then asks for a new link.
 */
export async function sendFile(row: Pick<UploadRow, "file" | "relativePath" | "plan" | "plannedAt">, id: string, deps: SendDeps, on: {plan(plan: Plan, at: number): void; progress(value: number): void}): Promise<Plan> {
  let plan = row.plan;
  if (plan && planExpired(row.plannedAt, deps.now())) {
    await deps.api(batchUrl(id, `/uploads/${plan.uploadId}`), "DELETE").catch(() => undefined);
    plan = undefined;
  }
  if (!plan) {
    plan = (await deps.api<Plan[]>(batchUrl(id, "/uploads"), "POST", {files: [{name: row.file.name, size: row.file.size, mime: row.file.type, relativePath: row.relativePath}]}))[0]!;
    on.plan(plan, deps.now());
  }
  await deps.put(row.file, plan, on.progress);
  await deps.api(batchUrl(id, `/uploads/${plan.uploadId}/complete`), "POST");
  return plan;
}
export function uploadFailureOf(err: unknown): UploadFailure {
  // The upload routes answer 409 only when the batch is no longer a draft (assertDraft, draftForUpdate).
  if (err instanceof WizardApiError) return {message: err.message, batchStarted: err.status === 409};
  return {message: err instanceof Error && err.message ? err.message : UPLOAD_FAILED, batchStarted: false};
}
/** The way forward when the batch has already started: a fresh wizard (full page load resets it). */
export function NewBatchLink() { return <a className="btn ghost sm" href="/catalog/new">Start a new batch</a>; }
/** The step's error line; when the batch has already started it offers a new batch. */
export function UploadErrorLine({error}: {error: UploadFailure | null}) {
  if (!error?.message) return null;
  return <p role="alert">{error.message}{error.batchStarted ? <> <NewBatchLink/></> : null}</p>;
}
/** A failed file's status: the server's sentence, Retry, Remove (spec 14b F3) and the new-batch link when it applies. */
export function FailedUploadStatus({failure,onRetry,onRemove}: {failure?: UploadFailure; onRetry(): void; onRemove?(): void}) {
  return <>{failure?.message ?? UPLOAD_FAILED} <button type="button" className="btn ghost sm" onClick={onRetry}>Retry</button>{onRemove ? <> <button type="button" className="btn ghost sm" onClick={onRemove}>Remove</button></> : null}{failure?.batchStarted ? <> <NewBatchLink/></> : null}</>;
}
export type Plan = { uploadId: string; putUrl: string; headers: Record<string,string> };
type Entry = {isFile: boolean; isDirectory: boolean; name: string; file(ok: (file: File) => void, fail: (error: unknown) => void): void; createReader(): {readEntries(ok: (entries: Entry[]) => void, fail: (error: unknown) => void): void}};
async function walk(entry: Entry, prefix = ""): Promise<{file: File; relativePath: string}[]> {
  if (entry.isFile) return [{file: await new Promise<File>((ok, fail) => entry.file(ok, fail)), relativePath: prefix + entry.name}];
  const reader = entry.createReader(); const entries: Entry[] = [];
  for (;;) { const page = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail)); if (!page.length) break; entries.push(...page); }
  return (await Promise.all(entries.map((child) => walk(child, prefix + entry.name + "/")))).flat();
}
function directPut(file: File, plan: Plan, progress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open("PUT", plan.putUrl);
    Object.entries(plan.headers).forEach(([key,value]) => xhr.setRequestHeader(key,value));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(UPLOAD_FAILED));
    xhr.onerror = () => reject(new Error(UPLOAD_FAILED)); xhr.send(file);
  });
}
/**
 * Uploads files straight to storage. Its rows are shown by the step 1 input list (`onRows`), merged with the
 * batch's server rows; a failed row has Retry and Remove. Busy (Continue disabled) while a row is queued,
 * uploading or failed: every one of those the operator can act on (wait, Retry or Remove).
 */
export default function Uploader({ensureBatch,onBusy,onAdded,onRows}: {ensureBatch(): Promise<string>; onBusy(busy: boolean): void; onAdded(): void; onRows(rows: LocalUpload[]): void}) {
  const [rows,setRows] = useState<UploadRow[]>([]);
  const [error,setErrorLine] = useState<UploadFailure | null>(null);
  const setError = (message: string) => setErrorLine(message ? {message,batchStarted:false} : null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => onBusy(rows.some((r) => r.status !== "done")), [rows,onBusy]);
  function patch(key: string, value: Partial<UploadRow>) { setRows((old) => old.map((row) => row.key === key ? {...row,...value} : row)); }
  async function upload(row: UploadRow, id: string) {
    patch(row.key,{status:"uploading",progress:0,failure:undefined});
    try {
      await sendFile(row, id, {api: wizardApi, put: directPut, now: Date.now}, {plan: (plan, plannedAt) => { row.plan = plan; row.plannedAt = plannedAt; patch(row.key,{plan,plannedAt}); }, progress: (progress) => patch(row.key,{progress})});
      patch(row.key,{status:"done",progress:100}); setErrorLine((line) => line === row.failure ? null : line); onAdded();
    } catch (err) { const failure = uploadFailureOf(err); patch(row.key,{status:"failed",failure}); setErrorLine(failure); }
  }
  async function retry(row: UploadRow) {
    try {await upload(row,await ensureBatch());} catch (err) {if (err instanceof WizardApiError) setErrorLine(uploadFailureOf(err)); else setError("Choose a brand and try again.");}
  }
  async function remove(row: UploadRow) {
    setRows((old) => old.filter((r) => r.key !== row.key)); setErrorLine((line) => line === row.failure ? null : line);
    // Without a plan the server never had a row; with one, the pending row is marked removed.
    if (row.plan) {
      try {await wizardApi(batchUrl(await ensureBatch(),`/uploads/${row.plan.uploadId}`),"DELETE");} catch (err) {setErrorLine(uploadFailureOf(err));}
    }
    onAdded();
  }
  useEffect(() => onRows(rows.map((row) => ({key:row.key,uploadId:row.plan?.uploadId,name:row.file.name,relativePath:row.relativePath,size:row.file.size,progress:row.progress,status:row.status,failure:row.failure,retry:() => void retry(row),remove:() => void remove(row)}))),
    // retry and remove read only the row and stable setters.
    [rows,onRows]);
  async function add(files: {file: File;relativePath: string}[]) {
    if (!files.length) return;
    setError("");
    try {
      const id = await ensureBatch();
      const added = files.map((f): UploadRow => ({...f,key:crypto.randomUUID(),progress:0,status:"queued"})); setRows((old) => [...old,...added]);
      let next = 0;
      await Promise.all(Array.from({length:Math.min(4,added.length)},async () => { while(next < added.length) await upload(added[next++]!,id); }));
    } catch (err) { setErrorLine(err instanceof Error ? uploadFailureOf(err) : {message:"Choose the files again.",batchStarted:false}); }
  }
  const fromFiles = (files: FileList | null) => files ? add(Array.from(files).map((file) => ({file,relativePath:file.webkitRelativePath || file.name}))) : undefined;
  return <><div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={async (e) => { e.preventDefault(); const items = Array.from(e.dataTransfer.items); const entries = items.map((i) => i.webkitGetAsEntry() as unknown as Entry | null).filter((i): i is Entry => !!i); try { if(entries.length) await add((await Promise.all(entries.map((entry) => walk(entry)))).flat()); else await fromFiles(e.dataTransfer.files); } catch {setError("This folder could not be read. Choose it again.");} }}>
    <button type="button" className="drop-select" onClick={() => fileInput.current?.click()}><strong>Drop images, folders, zips or a links sheet here</strong><span className="help" style={{display:"block"}}>Or click to choose. Photos should be named like ABC123_1.jpg, ABC123_2.jpg so we know which shots belong together.</span></button>
    <input ref={fileInput} hidden aria-label="Choose files" type="file" multiple onChange={(e) => {void fromFiles(e.target.files); e.target.value = "";}}/>
    <label>Choose a folder<input aria-label="Choose a folder" type="file" multiple {...{webkitdirectory:""}} onChange={(e) => {void fromFiles(e.target.files); e.target.value = "";}}/></label>
    </div>
    <UploadErrorLine error={error}/>
  </>;
}
