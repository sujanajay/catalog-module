"use client";
import { useRef, useState } from "react";
import { batchUrl, wizardApi } from "./wizard-client";
import ShareBox from "./ShareBox";
type AccessResult = {kind: string; access: string; summary: string; count?: number};
export default function PasteBox({ email, ensureBatch, onBusy, onAdded }: { email: string; ensureBatch(): Promise<string>; onBusy(busy: boolean): void; onAdded(): void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<AccessResult[]>([]);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const savedText = useRef("");
  const queuedText = useRef("");
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  function check(value: string) {
    if (!value.trim() || (pending.current ? value === queuedText.current : value === savedText.current)) return;
    const turn = ++sequence.current;
    queuedText.current = value;
    pending.current++;
    onBusy(true); setError("");
    const save = async () => {
      try {
        const id = await ensureBatch();
        const lines = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const isGoogle = (s: string) => /https?:\/\/(docs\.google\.com\/spreadsheets|drive\.google\.com\/.*folders)/i.test(s);
        const google = lines.filter(isGoogle);
        const images = lines.filter((s) => !isGoogle(s)).join("\n");
        const entries = [...google, ...(images ? [images] : [])];
        const got = [];
        for (const entry of entries) got.push(await wizardApi<AccessResult>(batchUrl(id, "/links"), "POST", {text: entry}));
        savedText.current = value;
        onAdded();
        if (turn === sequence.current) setResults(got);
      } catch (err) { if (turn === sequence.current) setError(err instanceof Error ? err.message : "Paste the link again."); }
      finally { if (--pending.current === 0) onBusy(false); }
    };
    queue.current = queue.current.then(save);
  }
  return <div><label htmlFor="source-links">Or paste a link</label><textarea id="source-links" rows={3} value={text} placeholder="A Google Sheet link, a Google Drive folder link, or image links one per line" onChange={(e) => setText(e.target.value)} onPaste={(e) => { const field = e.currentTarget; const value = text.slice(0, field.selectionStart) + e.clipboardData.getData("text") + text.slice(field.selectionEnd); setTimeout(() => void check(value), 0); }} onBlur={() => {if(text !== savedText.current) void check(text);}} />
    {/https?:\/\/(docs\.google\.com\/spreadsheets|drive\.google\.com)/i.test(text) ? <ShareBox email={email}/> : null}
    {results.length ? results.map((r, i) => <p key={i}><span className={`pill ${r.access === "ok" ? "ok" : "warn"}`}>{r.access === "ok" ? r.kind === "url_list" ? `${r.count ?? 0} image links` : "Access confirmed" : "No access yet"}</span> {r.summary}</p>) : <p className="help">We check access as soon as you paste.</p>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
