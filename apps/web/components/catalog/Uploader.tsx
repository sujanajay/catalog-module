"use client";
import { useEffect, useRef, useState } from "react";
import { batchUrl, wizardApi } from "./wizard-client";
type UploadRow = {key: string; file: File; relativePath: string; progress: number; status: "queued" | "uploading" | "done" | "failed"; plan?: Plan};
type Plan = { uploadId: string; putUrl: string; headers: Record<string,string> };
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
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed. Try again."));
    xhr.onerror = () => reject(new Error("Upload failed. Try again.")); xhr.send(file);
  });
}
export default function Uploader({ensureBatch,onBusy,onAdded}: {ensureBatch(): Promise<string>; onBusy(busy: boolean): void; onAdded(): void}) {
  const [rows,setRows] = useState<UploadRow[]>([]);
  const [error,setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => onBusy(rows.some((r) => r.status !== "done")), [rows,onBusy]);
  function patch(key: string, value: Partial<UploadRow>) { setRows((old) => old.map((row) => row.key === key ? {...row,...value} : row)); }
  async function upload(row: UploadRow, id: string) {
    patch(row.key,{status:"uploading",progress:0});
    try {
      const plan = row.plan ?? (await wizardApi<Plan[]>(batchUrl(id,"/uploads"),"POST",{files:[{name:row.file.name,size:row.file.size,mime:row.file.type,relativePath:row.relativePath}]}))[0]!;
      patch(row.key,{plan}); await directPut(row.file,plan,(progress) => patch(row.key,{progress}));
      await wizardApi(batchUrl(id,`/uploads/${plan.uploadId}/complete`),"POST"); patch(row.key,{status:"done",progress:100}); onAdded();
    } catch { patch(row.key,{status:"failed"}); }
  }
  async function add(files: {file: File;relativePath: string}[]) {
    if (!files.length) return;
    setError("");
    try {
      const id = await ensureBatch();
      const added = files.map((f): UploadRow => ({...f,key:crypto.randomUUID(),progress:0,status:"queued"})); setRows((old) => [...old,...added]);
      let next = 0;
      await Promise.all(Array.from({length:Math.min(4,added.length)},async () => { while(next < added.length) await upload(added[next++]!,id); }));
    } catch (err) { setError(err instanceof Error ? err.message : "Choose the files again."); }
  }
  const fromFiles = (files: FileList | null) => files ? add(Array.from(files).map((file) => ({file,relativePath:file.webkitRelativePath || file.name}))) : undefined;
  return <><div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={async (e) => { e.preventDefault(); const items = Array.from(e.dataTransfer.items); const entries = items.map((i) => i.webkitGetAsEntry() as unknown as Entry | null).filter((i): i is Entry => !!i); try { if(entries.length) await add((await Promise.all(entries.map((entry) => walk(entry)))).flat()); else await fromFiles(e.dataTransfer.files); } catch {setError("This folder could not be read. Choose it again.");} }}>
    <button type="button" className="drop-select" onClick={() => fileInput.current?.click()}><strong>Drop images, folders, zips or a links sheet here</strong><span className="help" style={{display:"block"}}>Or click to choose. Photos should be named like ABC123_1.jpg, ABC123_2.jpg so we know which shots belong together.</span></button>
    <input ref={fileInput} hidden aria-label="Choose files" type="file" multiple onChange={(e) => {void fromFiles(e.target.files); e.target.value = "";}}/>
    <label>Choose a folder<input aria-label="Choose a folder" type="file" multiple {...{webkitdirectory:""}} onChange={(e) => {void fromFiles(e.target.files); e.target.value = "";}}/></label>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    <ul className="upload-list">{rows.map((row) => <li key={row.key}>{row.relativePath} { /\.zip$/i.test(row.file.name) ? <span className="pill">zip</span> : /\.(xlsx|csv)$/i.test(row.file.name) ? <span className="pill">links sheet</span> : /\.bmp$/i.test(row.file.name) ? <span className="pill">cannot read</span> : null } <small>{(row.file.size / 1024 / 1024).toFixed(1)} MB</small><progress aria-label={`Upload ${row.relativePath}`} value={row.progress} max={100}/>{row.status === "done" ? "Uploaded" : row.status === "failed" ? <>Upload failed. Try again. <button type="button" className="btn ghost sm" onClick={async () => {try {await upload(row,await ensureBatch());} catch {setError("Choose a brand and try again.");}}}>Retry</button></> : "Uploading"}</li>)}</ul>
  </>;
}
