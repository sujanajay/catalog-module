// M1-F5-R5 (M1-S6): drafts older than a day with inputs that never started, with why, on the Ops page. The target
// is none: a draft with its files collected and its brand known starts by itself (M1-F5-R1).
import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import type { OrphanDraft } from "@catalog/core/catalog/drafts";
import { ORPHAN_DRAFTS_HELP, ORPHAN_DRAFTS_NONE, ORPHAN_DRAFTS_TITLE } from "@/lib/catalog/ops-copy";
export default function OrphanDrafts({ rows }: { rows: OrphanDraft[] }) {
  return (
    <section>
      <h2>{ORPHAN_DRAFTS_TITLE} ({rows.length})</h2>
      <p className="help">{ORPHAN_DRAFTS_HELP}</p>
      {rows.length ? (
        <ul>{rows.map(d => (
          <li key={d.id}><Link href={`/catalog/${d.id}`}>{d.name}</Link> ({d.brandName}, {d.createdBy}), made <LocalTime at={d.createdAt} />: {d.reason}</li>
        ))}</ul>
      ) : <p>{ORPHAN_DRAFTS_NONE}</p>}
    </section>
  );
}
