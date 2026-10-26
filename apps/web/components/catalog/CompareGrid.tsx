import { channel } from "@catalog/core/catalog/channels";
import type { ChannelId } from "@catalog/core/catalog/types";
import { GRADE_LABELS, type CompareCell, type CompareGrade } from "../../lib/catalog/compare-copy";
import CompareViewer, { type ViewerRow } from "./CompareViewer";

export const UNCHANGED_NOTE = "Unchanged, made in an earlier batch";
export const GRADE_CLASS: Record<CompareGrade, string> = { passed: "ok", repaired: "ok", attention: "warn", failed: "bad", unchanged: "", waiting: "run" };
export interface GridRow { key: string; identifier?: string; n: number; originalUrl: string | null; cells: CompareCell[] }

/** The badge under an output: its check result, "Skipped" for a photo left out on purpose, or the unchanged note. */
export function cellLabel(cell: Pick<CompareCell, "grade" | "skipped" | "unchanged">, missing = GRADE_LABELS.failed): string {
  if (cell.unchanged) return UNCHANGED_NOTE;
  if (cell.skipped) return "Skipped";
  return cell.grade === "failed" ? missing : GRADE_LABELS[cell.grade];
}

/**
 * Originals next to what was made for each channel, one line per photo (server-rendered). Any image opens the
 * large viewer. `missing` is the placeholder text where a channel has no image (product page: no live image).
 */
export default function CompareGrid({ rows, channels, missing = GRADE_LABELS.failed, badges = true }: { rows: GridRow[]; channels: ChannelId[]; missing?: string; badges?: boolean }) {
  const viewer: ViewerRow[] = rows.map(r => ({
    title: r.identifier ? `${r.identifier}, photo ${r.n}` : `Photo ${r.n}`, originalUrl: r.originalUrl,
    cells: r.cells.map(c => ({ channel: c.channel, label: channel(c.channel).label, url: c.url, status: badges ? cellLabel(c, missing) : "", why: c.why })),
  }));
  return (
    <CompareViewer rows={viewer}>
      <div className="cmp" role="table" aria-label="Originals and the images made for each marketplace" style={{ ["--cmp-cols" as string]: channels.length + 1 }}>
        <div className="cmp-row cmp-head" role="row">
          <span role="columnheader">Photo</span>
          <span role="columnheader">Original</span>
          {channels.map(c => <span key={c} role="columnheader">{channel(c).label}</span>)}
        </div>
        {rows.map((r, i) => (
          <div className="cmp-row" role="row" key={r.key}>
            <span role="rowheader" className="cmp-id">{r.identifier ? <b className="mono">{r.identifier}</b> : null}<span className="muted">Photo {r.n}</span></span>
            <figure role="cell">
              {r.originalUrl
                ? <button type="button" className="cmp-open" data-row={i} data-channel={r.cells[0]?.channel ?? ""} aria-label={`Open photo ${r.n}`}><img src={r.originalUrl} alt={`Photo ${r.n} original`} loading="lazy" /></button>
                : <div className="ph">No original kept</div>}
            </figure>
            {r.cells.map(c => (
              <figure role="cell" key={c.channel}>
                {c.url
                  ? <button type="button" className="cmp-open" data-row={i} data-channel={c.channel} aria-label={`Open photo ${r.n} for ${channel(c.channel).label}`}><img src={c.url} alt={`Photo ${r.n} made for ${channel(c.channel).label}`} loading="lazy" /></button>
                  : <div className="ph">{c.skipped ? "Skipped" : c.grade === "waiting" ? GRADE_LABELS.waiting : missing}</div>}
                {badges && c.url && <figcaption><span className={`pill ${GRADE_CLASS[c.unchanged ? "unchanged" : c.grade]}`}>{cellLabel(c, missing)}</span></figcaption>}
              </figure>
            ))}
          </div>
        ))}
      </div>
    </CompareViewer>
  );
}
