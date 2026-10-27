"use client";
import { useEffect, useRef, useState } from "react";
import { batchUrl, wizardApi } from "./wizard-client";
import ShareBox from "./ShareBox";
import { createPasteChecker, EMPTY_PASTE_VIEW, pasteEntries, type PasteResult, type PasteView } from "./paste-check";

/** The pill shown while the readback runs (spec 14b F2). */
export const PASTE_WAITING = "Checking your links...";

function pillOf(r: PasteResult): string {
  if (r.access !== "ok") return "No access yet";
  if (r.kind === "url_list") return r.pill ?? `${r.count ?? 0} image links`;
  return "Access confirmed";
}

/** What the paste box says under the field: the waiting pill, or each answer with its pill, line and notes. */
export function PasteStatus({ view }: { view: PasteView }) {
  return <>
    {view.checking ? <p><span className="pill">{PASTE_WAITING}</span></p>
      : view.results.length ? view.results.map((r, i) => <div key={i}><p><span className={`pill ${r.access === "ok" ? "ok" : "warn"}`}>{pillOf(r)}</span> {r.summary}</p>{(r.notes ?? []).map((note) => <p key={note} className="note">{note}</p>)}</div>)
      : <p className="help">We check access as soon as you paste.</p>}
    {view.error ? <p role="alert">{view.error}</p> : null}
  </>;
}

/**
 * `removed` counts the pasted inputs removed through the input list: each change clears the box and its
 * readback and forgets what was saved, so pasting the same text again adds it again (spec 14b F3).
 */
export default function PasteBox({ email, ensureBatch, onBusy, onAdded, removed = 0 }: { email: string; ensureBatch(): Promise<string>; onBusy(busy: boolean): void; onAdded(): void; removed?: number }) {
  const [text, setText] = useState("");
  const [view, setView] = useState<PasteView>(EMPTY_PASTE_VIEW);
  // The latest callbacks, so the checker made once on the first render always calls the current ones.
  const props = useRef({ ensureBatch, onBusy, onAdded });
  props.current = { ensureBatch, onBusy, onAdded };
  const checker = useRef<ReturnType<typeof createPasteChecker> | null>(null);
  checker.current ??= createPasteChecker({
    async save(value) {
      const id = await props.current.ensureBatch();
      const got: PasteResult[] = [];
      for (const entry of pasteEntries(value)) got.push(await wizardApi<PasteResult>(batchUrl(id, "/links"), "POST", { text: entry }));
      return got;
    },
    onView: setView,
    onBusy: (busy) => props.current.onBusy(busy),
    onSaved: () => props.current.onAdded(),
  });
  const check = (value: string) => checker.current!.check(value);
  useEffect(() => {
    if (!removed) return;
    setText("");
    checker.current!.forget();
  }, [removed]);
  return <div><label htmlFor="source-links">Or paste a link</label><textarea id="source-links" rows={3} value={text} placeholder="A Google Sheet link, a Google Drive folder link, or image links one per line" onChange={(e) => setText(e.target.value)} onPaste={(e) => { const field = e.currentTarget; const value = text.slice(0, field.selectionStart) + e.clipboardData.getData("text") + text.slice(field.selectionEnd); setTimeout(() => check(value), 0); }} onBlur={() => check(text)} />
    {/https?:\/\/(docs\.google\.com\/spreadsheets|drive\.google\.com)/i.test(text) ? <ShareBox email={email}/> : null}
    <PasteStatus view={view} />
  </div>;
}
