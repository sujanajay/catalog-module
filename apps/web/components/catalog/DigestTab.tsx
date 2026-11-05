import type { BatchDigest } from "@catalog/core/catalog/digest-types";
import { channel } from "@catalog/core/catalog/channels";
import { digestCostLine, digestHeadline, digestReasonLines, digestTiles, digestTimeLine } from "@catalog/core/catalog/digest-copy";
import LocalTime from "../LocalTime";

/**
 * M1-S5 and UX4 (UX 5.3): the digest of a finished batch. A headline, four number tiles, at most ten reason lines, the
 * downloads, cost and time. No product is listed one by one; the Exceptions and "Delivered with a note" sheets do that.
 */
export default function DigestTab({ id, digest: d, sheets, onNeedsYou }: { id: string; digest: BatchDigest; sheets: { xlsx: boolean; exceptions: boolean; notes: boolean }; onNeedsYou?: string }) {
  const reasons = digestReasonLines(d);
  const cost = digestCostLine(d), time = digestTimeLine(d);
  const perChannel = d.linksPerChannel.filter(c => c.links > 0).map(c => `${channel(c.channel).label} ${c.links.toLocaleString("en-US")}`).join(", ");
  return (
    <div className="digest">
      {d.cancelledAt && <p className="lead">Cancelled at <LocalTime at={d.cancelledAt} />. This covers what was sent before that.</p>}
      <p className="headline">{digestHeadline(d)}</p>
      <div className="kpis">
        {digestTiles(d).map(t => (
          <div key={t.label} className={`kpi ${t.label === "Need you" && d.needsYou ? "w" : ""}`}>
            <b>{t.value}</b><span>{t.label}</span><small>{t.meaning}</small>
          </div>
        ))}
      </div>
      {d.needsYou > 0 && onNeedsYou && <p><a href={onNeedsYou}>See the products that need you</a></p>}
      {reasons.lines.length > 0 && (
        <section aria-labelledby="digest-reasons">
          <h2 id="digest-reasons">What we did by ourselves</h2>
          <ul className="reasons">{reasons.lines.map(line => <li key={line}>{line}</li>)}</ul>
          {reasons.more > 0 && <p className="help">More reasons are in the Exceptions sheet.</p>}
        </section>
      )}
      {perChannel && <p>Links per channel: {perChannel}.</p>}
      <div className="dl">
        {sheets.xlsx && <a className="btn primary" href={`/api/catalog/batches/${id}/export?format=xlsx`}>Download sheet</a>}
        {sheets.exceptions && <a className="btn ghost" href={`/api/catalog/batches/${id}/export?format=exceptions`}>Exceptions (CSV)</a>}
        {sheets.notes && <a className="btn ghost" href={`/api/catalog/batches/${id}/export?format=notes`}>Delivered with a note (CSV)</a>}
      </div>
      {sheets.xlsx && <p className="help">The sheet has three tabs: Links, Exceptions, and Delivered with a note.</p>}
      {cost && <p>{cost}</p>}
      {time && <p>{time}</p>}
    </div>
  );
}
