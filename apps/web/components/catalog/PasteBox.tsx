"use client";
import { useEffect, useRef, useState } from "react";
import { batchUrl, wizardApi } from "./wizard-client";
import { createPasteChecker, EMPTY_PASTE_VIEW, pasteEntries, readFoldersToEnd, type PasteResult, type PasteView } from "./paste-check";

/** The pill shown while the readback runs (spec 14b F2). */
export const PASTE_WAITING = "Checking your links...";

/** The paste field hint; Supabase folders are named only while that paste kind is on. */
export function pastePlaceholder(supabase: boolean): string {
  return "A Google Sheet link, a Google Drive folder link, " + (supabase ? "a Supabase folder link, " : "") + "or image links one per line";
}

function pillOf(r: PasteResult): string {
  if (r.access === "reading") return r.pill ?? "Reading folder";
  if (r.access !== "ok") return "No access yet";
  if (r.kind === "url_list") return r.pill ?? `${r.count ?? 0} image links`;
  if (r.pill) return r.pill;
  return "Access confirmed";
}

/**
 * What the paste box says under the field: the waiting pill (with the answers so far while a large Supabase
 * folder is still being read), or each answer with its pill, line and notes.
 */
export function PasteStatus({ view }: { view: PasteView }) {
  const answers = (results: PasteResult[]) => results.map((r, i) => <div key={i}><p><span className={`pill ${r.access === "ok" ? "ok" : r.access === "reading" ? "" : "warn"}`}>{pillOf(r)}</span> {r.summary}</p>{(r.notes ?? []).map((note) => <p key={note} className="note">{note}</p>)}</div>);
  return <>
    {view.checking ? <><p><span className="pill">{PASTE_WAITING}</span></p>{answers(view.progress ?? [])}</>
      : view.results.length ? answers(view.results)
      : <p className="help">We check access as soon as you paste.</p>}
    {view.error ? <p role="alert">{view.error}</p> : null}
  </>;
}

/**
 * `removed` counts the pasted inputs removed through the input list: each change clears the box and its
 * readback and forgets what was saved, so pasting the same text again adds it again (spec 14b F3).
 */
export default function PasteBox({ ensureBatch, onBusy, onAdded, removed = 0, supabase = false }: { ensureBatch(): Promise<string>; onBusy(busy: boolean): void; onAdded(): void; removed?: number; supabase?: boolean }) {
  const [text, setText] = useState("");
  const [view, setView] = useState<PasteView>(EMPTY_PASTE_VIEW);
  // The latest callbacks, so the checker made once on the first render always calls the current ones.
  const props = useRef({ ensureBatch, onBusy, onAdded, supabase });
  props.current = { ensureBatch, onBusy, onAdded, supabase };
  const checker = useRef<ReturnType<typeof createPasteChecker> | null>(null);
  checker.current ??= createPasteChecker({
    async save(value, progress) {
      const id = await props.current.ensureBatch();
      const send = (text: string) => wizardApi<PasteResult>(batchUrl(id, "/links"), "POST", { text });
      const got: PasteResult[] = [];
      for (const entry of pasteEntries(value, props.current.supabase)) {
        // A large Supabase folder answers "reading" and is sent again until it is read (R1 exit finding 1).
        got.push(...await readFoldersToEnd(await send(entry), send, (answers) => progress([...got, ...answers])));
      }
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
  return <div><label htmlFor="source-links">Or paste a link</label><textarea id="source-links" rows={3} value={text} placeholder={pastePlaceholder(supabase)} onChange={(e) => setText(e.target.value)} onPaste={(e) => { const field = e.currentTarget; const value = text.slice(0, field.selectionStart) + e.clipboardData.getData("text") + text.slice(field.selectionEnd); setTimeout(() => check(value), 0); }} onBlur={() => check(text)} />
    <PasteStatus view={view} />
  </div>;
}
