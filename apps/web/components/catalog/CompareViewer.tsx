"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

export interface ViewerCell { channel: string; label: string; url: string | null; status: string; why: string }
export interface ViewerRow { title: string; originalUrl: string | null; cells: ViewerCell[] }

/** Which photo and channel the viewer shows after an arrow key (rows wrap around at both ends). */
export function step(rows: number, row: number, key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return (row + 1) % rows;
  if (key === "ArrowLeft" || key === "ArrowUp") return (row + rows - 1) % rows;
  return row;
}

/**
 * The large viewer (spec: Compare images): the original and one channel's output side by side at full
 * height, channel buttons, previous and next (also the arrow keys), the reason, and full-size links.
 * The grid it wraps stays server-rendered; a click on any of its images opens the viewer here.
 */
export default function CompareViewer({ rows, children }: { rows: ViewerRow[]; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState<{ row: number; channel: string } | null>(null);
  useEffect(() => { if (open && !ref.current?.open) ref.current?.showModal(); }, [open]);

  function pick(event: MouseEvent<HTMLDivElement>) {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button.cmp-open");
    if (!button) return;
    const row = Number(button.dataset.row);
    if (rows[row]) setOpen({ row, channel: button.dataset.channel || rows[row]!.cells[0]?.channel || "" });
  }
  function close() { ref.current?.close(); setOpen(null); }
  function keys(event: KeyboardEvent<HTMLDialogElement>) {
    if (!open || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    setOpen({ ...open, row: step(rows.length, open.row, event.key) });
  }

  const row = open ? rows[open.row] : undefined;
  const cell = row?.cells.find(c => c.channel === open?.channel) ?? row?.cells[0];
  return (
    <div onClick={pick}>
      {children}
      {open && row && (
        <dialog ref={ref} className="cmp-viewer" aria-labelledby="cmp-viewer-title" onKeyDown={keys} onClose={() => setOpen(null)}>
          <div className="hdr">
            <h2 id="cmp-viewer-title">{row.title}</h2>
            <div className="acts">
              <button type="button" className="btn ghost sm" onClick={() => setOpen({ ...open, row: step(rows.length, open.row, "ArrowLeft") })}>Previous</button>
              <button type="button" className="btn ghost sm" onClick={() => setOpen({ ...open, row: step(rows.length, open.row, "ArrowRight") })}>Next</button>
              <button type="button" className="btn ghost sm" onClick={close}>Close</button>
            </div>
          </div>
          {row.cells.length > 1 && (
            <div className="acts" role="group" aria-label="Marketplace">
              {row.cells.map(c => (
                <button key={c.channel} type="button" className={`pill${c.channel === cell?.channel ? " on" : ""}`} aria-pressed={c.channel === cell?.channel} onClick={() => setOpen({ ...open, channel: c.channel })}>{c.label}</button>
              ))}
            </div>
          )}
          <div className="cmp-pair">
            <figure>
              {row.originalUrl ? <img src={row.originalUrl} alt={`${row.title} original`} /> : <div className="ph">No original kept</div>}
              <figcaption>Original{row.originalUrl && <> · <a href={row.originalUrl} target="_blank" rel="noreferrer">Open full size</a></>}</figcaption>
            </figure>
            <figure>
              {cell?.url ? <img src={cell.url} alt={`${row.title} made for ${cell.label}`} /> : <div className="ph">{cell?.status || "No image"}</div>}
              <figcaption>Made for {cell?.label}{cell?.status ? ` · ${cell.status}` : ""}{cell?.url && <> · <a href={cell.url} target="_blank" rel="noreferrer">Open full size</a></>}</figcaption>
            </figure>
          </div>
          {cell?.why ? <p className="muted">{cell.why}</p> : null}
          <p className="help">Use the arrow keys for the previous and next photo.</p>
        </dialog>
      )}
    </div>
  );
}
