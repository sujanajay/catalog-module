import "@/components/catalog/pages.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { channel } from "@catalog/core/catalog/channels";
import { batchState } from "@/lib/catalog/batches";
import { requireRole } from "@/lib/user";
import { HttpError } from "@/lib/errors";
import { batchDetails } from "@/lib/catalog/exports";
import { batchAttention } from "@/lib/catalog/products";
import { evalOutputs } from "@/lib/catalog/eval";
import { batchCostLine } from "@/lib/catalog/cost";
import AutoRefresh from "@/components/AutoRefresh";
import { ActionOnly } from "@/components/ViewerPreview";
import { when } from "@/components/ui";
import BatchBanner from "@/components/catalog/BatchBanner";
import BatchKpis from "@/components/catalog/BatchKpis";
import BatchTabs from "@/components/catalog/BatchTabs";
import AttentionList from "@/components/catalog/AttentionList";
import SheetPreview from "@/components/catalog/SheetPreview";
import DetailsTab from "@/components/catalog/DetailsTab";
import NotRefreshedLine from "@/components/catalog/NotRefreshedLine";
import CostLine from "@/components/catalog/CostLine";
import { plural } from "@/lib/catalog/copy";
import SkuMapModal from "@/components/catalog/SkuMapModal";
import { EvalList } from "@/components/catalog/EvalLabelBar";

type EvalQuery = { page?: string; channel?: string; verdict?: string };

export default async function BatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<EvalQuery> }) {
  const user = await requireRole("viewer");
  const { id } = await params;
  let data;
  try {
    data = await batchDetails(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const { batch } = data;
  const canAct = user.role !== "viewer";
  // Eval batches (08) list every output for labelling instead of the problem photos (spec 07 4.10).
  const query = await searchParams;
  const evalFilters = { channel: query.channel ?? "", verdict: query.verdict ?? "" };
  const evalMode = batch.isTest && !!batch.options.evalSet;
  const [attention, evalPage, cost] = await Promise.all([
    evalMode ? Promise.resolve([]) : batchAttention(id),
    evalMode ? evalOutputs(id, { page: Number(query.page ?? 0) || 0, ...evalFilters }) : Promise.resolve(null),
    batchCostLine(batch),
  ]);
  const channelLabels = batch.channels.map(c => channel(c).label);
  const missingSkus = data.sheet.rows.filter(r => !r.opptraSkuIds.length).length;
  const source = data.uploads.some(u => u.kind === "drive_folder") ? "Drive folder"
    : data.uploads.some(u => u.kind === "google_sheet") ? "Google Sheet"
    : data.uploads.some(u => u.kind === "zip") ? "zip" : "links";
  const state = batchState(batch, source);
  const downloads = (batch.sheetXlsxUri || batch.sheetCsvUri || data.filled) ? (
    <div className="dl">
      {batch.sheetXlsxUri && <a className="btn primary" href={`/api/catalog/batches/${id}/export?format=xlsx`}>Download links sheet (Excel)</a>}
      {batch.sheetCsvUri && <a className="btn ghost" href={`/api/catalog/batches/${id}/export?format=csv`}>Download CSV</a>}
      {data.filled && <a className="btn ghost" href={`/api/catalog/batches/${id}/export?format=filled`}>Download filled product list</a>}
    </div>
  ) : null;
  const next: Record<string, string> = {
    processing: "You can close this page; nothing stops.",
    collecting: "We copy your files first so the batch does not depend on the Drive folder later. Processing starts automatically.",
    attention: `Open "Needs attention" for the ${batch.counts.attentionProducts} ${plural(batch.counts.attentionProducts, "product", "products")} with a problem.`,
    ready: "Download the sheet and paste the links into the marketplace templates.",
    failed: "Nothing was processed and nothing was charged.",
  };
  return (
    <main>
      <div className="hdr">
        <div>
          <Link href="/catalog">← All batches</Link>
          <h1>{batch.name}</h1>
          <p className="lead">
            <Link href={`/catalog/brands/${batch.brandSlug}`}>{batch.brandName}</Link> · {batch.channels.map(c => channel(c).label).join(", ")} · {batch.finishedAt ? `finished ${when(batch.finishedAt)}` : `started ${when(batch.startedAt ?? batch.createdAt)}`} by {batch.createdBy}
          </p>
        </div>
        {downloads}
        {canAct && batch.status === "failed" && (
          <ActionOnly><Link className="btn primary" href={`/catalog/new?brand=${encodeURIComponent(batch.brandSlug)}`}>Start again</Link></ActionOnly>
        )}
      </div>
      <BatchBanner key={id} status={batch.status} counts={batch.counts} source={source} />
      <NotRefreshedLine items={data.notRefreshedChannels} />
      <BatchKpis counts={batch.counts} />
      <AutoRefresh active={state.state === "collecting" || state.state === "processing"} />
      <BatchTabs
        attentionCount={attention.length}
        evalLabel={evalPage ? `Needs attention (${evalPage.total} ${plural(evalPage.total, "image", "images")})` : undefined}
        initialTab={evalMode && (query.page || query.channel || query.verdict) ? "attention" : undefined}
        overview={
          <div className="grid2">
            <div className="card">
              <h2>How this works</h2>
              <p>We check every image against the marketplace rules and our quality check. Images that pass go straight into the links sheet. Only products with a problem are listed under Needs attention.</p>
              <p>{next[state.state]}</p>
              {batch.counts.existingProducts > 0 && <p>Marketplaces keep their own copy. Re-submit the image columns for products marked updated, shots_removed or reordered in the sheet.</p>}
            </div>
            <div className="card">
              <h2>Cost so far</h2>
              <CostLine line={{ usdPerIdentifier: cost.usdPerIdentifier, inrPerIdentifier: cost.inrPerIdentifier, usd: cost.usd, inr: cost.inr }} />
            </div>
          </div>
        }
        attention={evalPage
          ? <EvalList batchId={id} data={evalPage} channels={batch.channels} filters={evalFilters} canAct={canAct} />
          : <AttentionList items={attention} canAct={canAct} channels={channelLabels} />}
        sheet={
          <>
            <SheetPreview sheet={data.sheet} />
            {downloads}
            {canAct && (
              <ActionOnly>
                <SkuMapModal batchId={id} missing={missingSkus} sheetUri={batch.sheetXlsxUri} />
              </ActionOnly>
            )}
            <p className="help">Opptra SKU ids are filled in automatically when they exist.</p>
          </>
        }
        details={
          <DetailsTab id={id} brand={batch.brandSlug} isTest={batch.isTest} counts={batch.counts}
            failures={data.failures} recheckFailures={data.recheckFailures}
            notRefreshedChannels={data.notRefreshedChannels} hasReport={!!batch.reportUri} />
        }
      />
    </main>
  );
}
