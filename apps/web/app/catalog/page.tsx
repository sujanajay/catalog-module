import { CHANNELS } from "@catalog/core/catalog/channels";
import AutoRefresh from "../../components/AutoRefresh";
import { when } from "../../components/ui";
import { listBatches } from "../../lib/catalog/batches";
import { atLeast, requireRole } from "../../lib/user";
export const dynamic = "force-dynamic";

// Viewer: action links are rendered only for operators and admins.
export default async function CatalogPage() {
  const user = await requireRole("viewer");
  const batches = await listBatches();
  return (
    <main>
      <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center"}}><h1>Catalog images</h1>{atLeast(user.role,"operator")?<a className="btn primary" href="/catalog/new">New batch</a>:null}</div><p>Turn a brand&apos;s product photos into marketplace-ready images and get a sheet of links. One brand per batch.</p>
      <AutoRefresh active={batches.some((b)=>["collecting","processing"].includes(b.state.state))}/>
      <div className="tw"><table><thead><tr>{["Brand","Batch","Channels","Products","State","Created"].map((c)=><th key={c}>{c}</th>)}</tr></thead><tbody>{batches.map((b)=><tr key={b.id}><td>{b.brandName} <span className="pill">{b.brandLine==="softline"?"Softline":"Hardline"}</span> {b.isTest?<span className="pill">Test</span>:null}</td><td><a href={`/catalog/${b.id}`}>{b.name}</a></td><td>{b.channels.map((c)=>CHANNELS[c].label).join(", ")}</td><td>{b.counts.products}</td><td><span className={`pill ${b.state.state}`}>{b.state.listPill}</span></td><td>{when(b.createdAt)}</td></tr>)}</tbody></table></div>
      {!batches.length?<p>No batches yet.</p>:null}<p className="help">A product&apos;s links stay the same for life. Uploading a product again replaces the pictures behind its links. Marketplaces keep their own copy, so re-submit changed products there.</p>
    </main>
  );
}
