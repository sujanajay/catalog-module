import { CHANNELS } from "@catalog/core/catalog/channels";
import AutoRefresh from "../../components/AutoRefresh";
import { when } from "../../components/ui";
import { listBatches } from "../../lib/catalog/batches";
import { atLeast, requireRole } from "../../lib/user";
import { ActionOnly } from "../../components/ViewerPreview";
import { shortReason } from "../../lib/catalog/copy";
export const dynamic = "force-dynamic";
/** On a phone, Channels collapses first, then Products and Created, so State stays on screen (spec 14a F9). */
const BATCH_COLUMNS: [string, string | undefined][] = [["Brand",undefined],["Batch",undefined],["Channels","col-channels"],["Products","col-products"],["State",undefined],["Created","col-created"]];

// Viewer: action links are rendered only for operators and admins, and hidden under "Preview as viewer".
export default async function CatalogPage() {
  const user = await requireRole("viewer");
  const batches = await listBatches();
  return (
    <main>
      <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center"}}><h1>Catalog images</h1>{atLeast(user.role,"operator")?<ActionOnly><a className="btn primary" href="/catalog/new">New batch</a></ActionOnly>:null}</div><p>Turn a brand&apos;s product photos into marketplace-ready images and get a sheet of links. One brand per batch.</p>
      <AutoRefresh active={batches.some((b)=>["collecting","processing"].includes(b.state.state))}/>
      <div className="tw"><table className="batch-list"><thead><tr>{BATCH_COLUMNS.map(([c,cls])=><th key={c} className={cls}>{c}</th>)}</tr></thead><tbody>{batches.map((b)=><tr key={b.id}><td>{b.brandName} <span className="pill">{b.brandLine==="softline"?"Softline":"Hardline"}</span> {b.isTest?<span className="pill">Test</span>:null}</td><td><a href={`/catalog/${b.id}`}>{b.name}</a>{b.status==="failed"&&b.counts.failReason?<div className="help" title={b.counts.failReason}>{shortReason(b.counts.failReason)}</div>:null}</td><td className="col-channels">{b.channels.map((c)=>CHANNELS[c].label).join(", ")}</td><td className="col-products">{b.counts.products}</td><td><span className={`pill ${b.state.state}`}>{b.state.listPill}</span></td><td className="col-created">{when(b.createdAt)}</td></tr>)}</tbody></table></div>
      {!batches.length?<p>No batches yet.</p>:null}<p className="help">A product&apos;s links stay the same for life. Uploading a product again replaces the pictures behind its links. Marketplaces keep their own copy, so re-submit changed products there.</p>
    </main>
  );
}
