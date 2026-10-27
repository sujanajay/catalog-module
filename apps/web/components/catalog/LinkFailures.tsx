"use client";
// Links that could not be downloaded (spec 14b F5 part 1): the step 2 card with one line per reason,
// "Show all <total>" (the full table from GET /preview) and "Try the failed links again", which is
// offered only when some failures may work on a second try.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { reasonLine } from "@catalog/core/catalog/ingest/link-reasons";
import type { LinkFailuresBlock } from "@catalog/core/catalog/ingest/types";
import { apiFetch, SessionEndedError } from "@/lib/fetch";
import { useToast } from "@/components/Toast";
import { canRetryLinks, LINK_FAILURES_HEADING, linkFailuresSummary, RETRY_LINKS, RETRY_LINKS_STARTED, showAllText } from "../../lib/catalog/copy";

export type LinkFailureRow = { url: string; where: string; reason: string };

/** The card as markup: nothing when no link failed. `rows` (after Show all) is the full table. */
export function LinkFailuresView({ failures, rows, busy = false, onRetry, onShowAll }: { failures: LinkFailuresBlock; rows?: LinkFailureRow[] | null; busy?: boolean; onRetry?(): void; onShowAll?(): void }) {
  if (!failures.total) return null;
  return <section className="card" aria-label={LINK_FAILURES_HEADING}><h3>{LINK_FAILURES_HEADING}</h3>
    <p>{linkFailuresSummary(failures.total, failures.links, failures.products)}</p>
    {failures.byReason.map((g) => <p key={g.reason} style={{ overflowWrap: "anywhere" }}>{reasonLine({ reason: g.reason as Parameters<typeof reasonLine>[0]["reason"], count: g.count, first: g.first })}</p>)}
    <p>{canRetryLinks(failures) ? <><button type="button" className="btn primary sm" disabled={busy} onClick={onRetry}>{busy ? "Please wait..." : RETRY_LINKS}</button> </> : null}
      {rows ? null : <button type="button" className="btn ghost sm" onClick={onShowAll}>{showAllText(failures.total)}</button>}</p>
    {rows ? <div className="tw"><table><thead><tr><th>Where</th><th>Link</th><th>Reason</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td>{r.where}</td><td style={{ overflowWrap: "anywhere" }}>{r.url}</td><td>{r.reason}</td></tr>)}</tbody></table></div> : null}
  </section>;
}

/** POST /retry-links; resolves true when the links were handed back to collection. Shows the server's sentence otherwise. */
function useRetryLinks(batchId: string, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  async function retry() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/catalog/batches/${batchId}/retry-links`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast(RETRY_LINKS_STARTED);
      onDone?.();
      router.refresh();
    } catch (err) {
      if (!(err instanceof SessionEndedError)) toast(err instanceof Error && err.message ? err.message : "This did not finish. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, retry };
}

/** "Try the failed links again" on its own (the wizard's failed line, step 4 and the batch page). */
export function RetryLinksButton({ batchId, onDone }: { batchId: string; onDone?: () => void }) {
  const { busy, retry } = useRetryLinks(batchId, onDone);
  return <button type="button" className="btn primary" disabled={busy} onClick={() => void retry()}>{busy ? "Please wait..." : RETRY_LINKS}</button>;
}

/** The step 2 card. `onRetried` lets the wizard show the collection again. */
export default function LinkFailures({ batchId, failures, onRetried }: { batchId: string; failures: LinkFailuresBlock; onRetried?(): void }) {
  const [rows, setRows] = useState<LinkFailureRow[] | null>(null);
  const toast = useToast();
  const { busy, retry } = useRetryLinks(batchId, () => { setRows(null); onRetried?.(); });
  async function showAll() {
    try {
      const res = await apiFetch(`/api/catalog/batches/${batchId}/preview`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRows(data.linkFailureRows ?? []);
    } catch (err) {
      if (!(err instanceof SessionEndedError)) toast(err instanceof Error && err.message ? err.message : "This did not finish. Try again.");
    }
  }
  return <LinkFailuresView failures={failures} rows={rows} busy={busy} onRetry={() => void retry()} onShowAll={() => void showAll()}/>;
}
