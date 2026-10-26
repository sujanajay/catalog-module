import Link from "next/link";
import { channel } from "@catalog/core/catalog/channels";
import type { ChannelId } from "@catalog/core/catalog/types";
import { COMPARE_GRADES, COMPARE_PAGE_SIZE, GRADE_LABELS } from "../../lib/catalog/compare-copy";
import type { ComparePage } from "../../lib/catalog/compare";
import CompareGrid from "./CompareGrid";

export interface CompareFilterValues { channel: string; status: string; q: string }

/** The Compare tab's own query keys, apart from the eval list's page, channel and verdict. */
export function compareHref(filters: CompareFilterValues, page = 0): string {
  return `?${new URLSearchParams({ tab: "compare", ...(filters.q ? { q: filters.q } : {}), ...(filters.channel ? { cchannel: filters.channel } : {}), ...(filters.status ? { cstatus: filters.status } : {}), ...(page ? { cpage: String(page) } : {}) })}`;
}

/** "Compare images": every input photo of the batch next to what was made for each channel (filters, paging). */
export default function CompareTab({ data, channels, filters }: { data: ComparePage; channels: ChannelId[]; filters: CompareFilterValues }) {
  const pages = Math.max(1, Math.ceil(data.total / COMPARE_PAGE_SIZE));
  return (
    <>
      <p className="lead">Every photo in this batch next to what was made for each marketplace. Click any image to see it large.</p>
      <form className="dl cmp-filters" method="get">
        <input type="hidden" name="tab" value="compare" />
        <input type="search" name="q" defaultValue={filters.q} placeholder="Product" aria-label="Product" />
        <select name="cchannel" defaultValue={filters.channel} aria-label="Marketplace">
          <option value="">All marketplaces</option>
          {channels.map(c => <option key={c} value={c}>{channel(c).label}</option>)}
        </select>
        <select name="cstatus" defaultValue={filters.status} aria-label="Result">
          <option value="">All results</option>
          {COMPARE_GRADES.map(g => <option key={g} value={g}>{GRADE_LABELS[g]}</option>)}
        </select>
        <button className="btn ghost sm">Show</button>
      </form>
      {data.rows.length
        ? <CompareGrid rows={data.rows.map(r => ({ key: r.sourceImageId, identifier: r.identifier, n: r.n, originalUrl: r.originalUrl, cells: r.cells }))} channels={data.channels} />
        : <p>{filters.q || filters.channel || filters.status ? "No photos match these filters." : "No photos in this batch yet."}</p>}
      <div className="dl">
        {data.page > 0 && <Link className="btn ghost sm" href={compareHref(filters, Math.min(data.page - 1, pages - 1))}>Previous</Link>}
        <span className="muted">Page {data.page + 1} of {pages} · {data.total} {data.total === 1 ? "photo" : "photos"}</span>
        {data.page + 1 < pages && <Link className="btn ghost sm" href={compareHref(filters, data.page + 1)}>Next</Link>}
      </div>
    </>
  );
}
