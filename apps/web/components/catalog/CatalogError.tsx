import { ERROR_ALL_BATCHES, ERROR_BATCH_SAFE, ERROR_HEADING, ERROR_OPEN_BATCH, ERROR_TRY_AGAIN } from "../../lib/catalog/copy";
import { isUuid } from "../../lib/catalog/uuid";

/**
 * The batch a crashed /catalog page was about, and where "Open this batch" leads (spec 14a F1). The
 * batch is known from `?batch=<id>` (the wizard) or from a `/catalog/<id>` path (the batch page). The
 * wizard's link reopens the wizard at its step; the batch page's link reloads the batch page.
 */
export function batchLinkFor(pathname: string, batchParam: string | null): string | null {
  const fromQuery = batchParam && isUuid(batchParam) ? batchParam : null;
  if (fromQuery) return pathname.replace(/\/$/, "") === "/catalog/new" ? `/catalog/new?batch=${fromQuery}` : `/catalog/${fromQuery}`;
  const fromPath = /^\/catalog\/([^/?#]+)\/?$/.exec(pathname)?.[1];
  return fromPath && isUuid(fromPath) ?`/catalog/${fromPath}` : null;
}

/** The error page body: plain links (a full load) so a broken client state is left behind. */
export default function CatalogError({ batchHref, reset }: { batchHref: string | null; reset: () => void }) {
  return (
    <main>
      <h1>{ERROR_HEADING}</h1>
      {batchHref && <p>{ERROR_BATCH_SAFE}</p>}
      <div className="acts">
        {batchHref && <a className="btn primary" href={batchHref}>{ERROR_OPEN_BATCH}</a>}
        <a className={batchHref ? "btn ghost" : "btn primary"} href="/catalog">{ERROR_ALL_BATCHES}</a>
        <button type="button" className="btn ghost" onClick={() => reset()}>{ERROR_TRY_AGAIN}</button>
      </div>
    </main>
  );
}
