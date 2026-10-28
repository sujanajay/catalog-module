import "@/components/catalog/pages.css";
import Link from "next/link";
import { channel } from "@catalog/core/catalog/channels";
import { inrPerUsdFromEnv, RUPEES_NOT_CONFIGURED, usdAmount } from "@catalog/core/catalog/cost";
import type { BrandCost } from "@catalog/core/catalog/cost-report";
import AutoRefresh from "@/components/AutoRefresh";
import { when } from "@/components/ui";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/user";
import { activeBatches, batchCostDetail, costOverview, gpuCandidateRevision, healthSummary, lifetimeBrandCost, recentBatches, recentFailures, COST_TTL_MS } from "@/lib/catalog/ops";
import { REPORT_UNAVAILABLE, AGENCY_REFERENCE, HEALTH_TITLE, healthLines, chunkGaveUpText, chunkProgressText, chunkTotal, COST_STAGE_WORDS, hintText, logsUrl, money, OPS_HREF, OPS_REFRESH_MS, statusWord } from "@/lib/catalog/ops-copy";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type OpsQuery = { batch?: string; lifetime?: string };

function opsLink(query: { batch?: string | null; lifetime?: boolean }): string {
  const params = new URLSearchParams();
  if (query.batch) params.set("batch", query.batch);
  if (query.lifetime) params.set("lifetime", "1");
  const text = params.toString();
  return text ? `${OPS_HREF}?${text}` : OPS_HREF;
}

function BrandTable({ rows, rate }: { rows: BrandCost[]; rate: number | null }) {
  if (!rows.length) return <p>No cost recorded in this period.</p>;
  return (
    <div className="tw"><table>
      <thead><tr>{["Brand", "Batches", "Products", "Photos", "Cost", "Per product", "Per photo"].map(c => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{rows.map(b => (
        <tr key={b.brandSlug}>
          <td>{b.brandSlug}</td><td>{b.batches}</td><td>{b.products}</td><td>{b.images}</td>
          <td>{money(b.usd, rate)}</td>
          <td>{b.usdPerProduct === null ? "" : money(b.usdPerProduct, rate)}</td>
          <td>{b.usdPerImage === null ? "" : money(b.usdPerImage, rate)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

// Admin only. Read only. Active batches and failures are read on every 30 s refresh; the cost sections are
// kept for a few minutes per web instance (a read that times out shows a plain sentence), and lifetime
// brand totals are read only on demand (no refresh).
export default async function OpsPage({ searchParams }: { searchParams: Promise<OpsQuery> }) {
  await requireRole("admin");
  const query = await searchParams;
  const lifetime = query.lifetime === "1";
  const selected = query.batch && UUID.test(query.batch) ? query.batch.toLowerCase() : null;
  const now = new Date();
  const conn = db();
  const rate = inrPerUsdFromEnv();
  // In sequence on purpose: the page holds at most one of the web instance's two pooled connections.
  const active = await activeBatches(conn, now);
  const health = healthLines(await healthSummary(conn), await gpuCandidateRevision(now));
  const failures = await recentFailures(conn, now);
  const overviewRead = await costOverview(conn, now);
  const overview = overviewRead.ok ? overviewRead.value : null;
  const lifetimeRead = lifetime ? await lifetimeBrandCost(conn, now) : null;
  const recent = await recentBatches(conn);
  const detailRead = selected ? await batchCostDetail(selected, conn, now) : null;
  const detail = detailRead?.ok ? detailRead.value : null;
  const costMinutes = Math.round(COST_TTL_MS / 60_000);

  return (
    <main>
      <div className="hdr">
        <div>
          <Link href="/catalog">← All batches</Link>
          <h1>Ops</h1>
          <p className="lead">Batches running now, failures in the last 24 hours, and what batches and brands cost. Read only.{rate === null ? ` ${RUPEES_NOT_CONFIGURED}.` : ""}</p>
        </div>
      </div>
      <AutoRefresh active={!lifetime} ms={OPS_REFRESH_MS} />

      <section>
        <h2>{HEALTH_TITLE}</h2>
        <ul>{health.map(line => <li key={line}>{line}</li>)}</ul>
      </section>

      <section>
        <h2>Running now</h2>
        {active.length ? (
          <div className="tw"><table>
            <thead><tr>{["Batch", "Brand", "Step", "Chunks", "Cost so far", "Started", ""].map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{active.map(b => (
              <tr key={b.id}>
                <td><Link href={`/catalog/${b.id}`}>{b.name}</Link>{b.isTest ? <> <span className="pill">Test</span></> : null}</td>
                <td>{b.brandName}</td>
                <td>{statusWord(b.status)}</td>
                <td>{chunkTotal(b.chunks) ? `${chunkTotal(b.chunks)} in total · ${chunkProgressText(b.chunks)}` : "No chunks yet"}</td>
                <td>{money(b.usd, rate)}</td>
                <td>{when(b.startedAt ?? b.createdAt)}</td>
                <td><Link href={opsLink({ batch: b.id })}>Cost detail</Link></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p>No batch is running now.</p>}
      </section>

      <section>
        <h2>Failures in the last 24 hours</h2>
        {!failures.batches.length && !failures.chunks.length ? <p>Nothing failed in the last 24 hours.</p> : null}
        {failures.batches.length ? (
          <ul>{failures.batches.map(f => (
            <li key={f.id}><Link href={`/catalog/${f.id}`}>{f.name}</Link> ({f.brandName}), {f.status === "failed" ? "stopped" : "reported a problem"} {when(f.at)}: {f.reason} <a href={logsUrl(f.id)} target="_blank" rel="noreferrer">Open logs</a></li>
          ))}</ul>
        ) : null}
        {failures.chunks.length ? (
          <ul>{failures.chunks.map(c => (
            <li key={`${c.batchId}-${c.index}`}><Link href={`/catalog/${c.batchId}`}>{c.batchName}</Link>, {when(c.at)}: {chunkGaveUpText(c)} <a href={logsUrl(c.batchId)} target="_blank" rel="noreferrer">Open logs</a></li>
          ))}</ul>
        ) : null}
      </section>

      <section>
        <h2>Cost per brand, last 30 days</h2>
        <p className="help">Test batches are left out. Compare the cost per product with the {AGENCY_REFERENCE}. Cost figures are read at most every {costMinutes} minutes{overview ? `, last at ${when(overview.readAt)}` : ""}.</p>
        {overview ? <BrandTable rows={overview.brands} rate={rate} /> : <p>{REPORT_UNAVAILABLE}</p>}
        {lifetimeRead ? (
          <>
            <h3>Cost per brand, all time</h3>
            {lifetimeRead.ok ? <BrandTable rows={lifetimeRead.value} rate={rate} /> : <p>{REPORT_UNAVAILABLE}</p>}
            <p><Link href={opsLink({ batch: selected })}>Back to the live view</Link> (this view does not refresh by itself)</p>
          </>
        ) : <p><Link href={opsLink({ batch: selected, lifetime: true })}>Show all-time totals</Link></p>}
      </section>

      <section>
        <h2>Cost of one batch</h2>
        <form method="get" action={OPS_HREF} className="alias-form">
          <label htmlFor="ops-batch">Batch</label>
          <select id="ops-batch" name="batch" defaultValue={selected ?? ""}>
            <option value="">Choose a batch</option>
            {recent.map(b => <option key={b.id} value={b.id}>{b.brandName}: {b.name}</option>)}
          </select>
          {lifetime ? <input type="hidden" name="lifetime" value="1" /> : null}
          <button type="submit" className="btn">Show</button>
        </form>
        {detailRead && !detailRead.ok ? <p>{REPORT_UNAVAILABLE}</p> : null}
        {detailRead?.ok && !detail ? <p>This batch was not found.</p> : null}
        {detail ? (
          <div className="card">
            <h3><Link href={`/catalog/${detail.batch.id}`}>{detail.batch.name}</Link> ({detail.batch.brandName})</h3>
            {!detail.stages.length ? <p>No cost is recorded for this batch yet.</p> : (
              <>
                <p>Total {money(detail.attribution.totalUsd, rate)}, read at {when(detail.readAt)}. <a href={logsUrl(detail.batch.id)} target="_blank" rel="noreferrer">Open logs</a></p>
                <div className="grid2">
                  <div>
                    <h4>By step</h4>
                    <div className="tw"><table>
                      <thead><tr>{["Step", "Cost", "Time", "Calls"].map(c => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>{detail.stages.map(s => (
                        <tr key={s.stage}><td>{COST_STAGE_WORDS[s.stage]}</td><td>{money(s.usd, rate)}</td><td>{Math.round(s.ms / 1000)} s</td><td>{s.calls}</td></tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                  <div>
                    <h4>By engine</h4>
                    <div className="tw"><table>
                      <thead><tr>{["Engine", "Cost", "Time", "Calls"].map(c => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>{detail.engines.map(e => (
                        <tr key={e.engine}><td>{e.engine}</td><td>{money(e.usd, rate)}</td><td>{Math.round(e.ms / 1000)} s</td><td>{e.calls}</td></tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                </div>
                <h4>By marketplace</h4>
                <div className="tw"><table>
                  <thead><tr>{["Marketplace", "Cost", "Images", "Per image"].map(c => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{detail.attribution.byChannel.map(c => (
                    <tr key={c.channel}><td>{channel(c.channel).label}</td><td>{money(c.usd, rate)}</td><td>{c.outputs}</td><td>{c.outputs ? money(c.usd / c.outputs, rate) : ""}</td></tr>
                  ))}</tbody>
                </table></div>
                {detail.attribution.unattributedUsd > 0 ? <p className="help">USD {usdAmount(detail.attribution.unattributedUsd)} could not be given to an image (every image it belonged to was skipped).</p> : null}
                <h4>Top 10 products</h4>
                <div className="tw"><table>
                  <thead><tr>{["Product", "Cost", "Images", "What added up"].map(c => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{detail.attribution.topProducts.map(p => (
                    <tr key={p.productId}><td>{p.identifier ?? "removed product"}</td><td>{money(p.usd, rate)}</td><td>{p.outputs}</td><td>{hintText(p.hints)}</td></tr>
                  ))}</tbody>
                </table></div>
                <h4>Top 10 photos</h4>
                <div className="tw"><table>
                  <thead><tr>{["Photo", "Cost", "Images", "What added up"].map(c => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{detail.attribution.topImages.map(i => (
                    <tr key={i.sourceImageId}><td>{i.identifier ?? "removed product"}{i.n !== null ? `, photo ${i.n}` : ""}</td><td>{money(i.usd, rate)}</td><td>{i.outputs}</td><td>{hintText(i.hints)}</td></tr>
                  ))}</tbody>
                </table></div>
              </>
            )}
          </div>
        ) : null}
      </section>

      <section>
        <h2>Cost per day, last 30 days</h2>
        <p className="help">Days are UTC. Test batches are left out.</p>
        {!overview ? <p>{REPORT_UNAVAILABLE}</p> : overview.days.length ? (
          <div className="tw"><table>
            <thead><tr>{["Day", "Cost", "Batches"].map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{[...overview.days].reverse().map(d => (
              <tr key={d.day}><td>{d.day}</td><td>{money(d.usd, rate)}</td><td>{d.batches}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <p>No cost recorded in the last 30 days.</p>}
      </section>
    </main>
  );
}
