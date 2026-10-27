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
import { batchCompare } from "@/lib/catalog/compare";
import { LINKABLE_TABS } from "@/lib/catalog/compare-copy";
import { batchCostLine } from "@/lib/catalog/cost";
import { inrPerUsdFromEnv } from "@catalog/core/catalog/cost";
import { batchChunkSummary, batchStageCost } from "@/lib/catalog/ops";
import { fullCostText } from "@/lib/catalog/ops-copy";
import AutoRefresh from "@/components/AutoRefresh";
import { ActionOnly } from "@/components/ViewerPreview";
import { when } from "@/components/ui";
import BatchBanner from "@/components/catalog/BatchBanner";
import BatchKpis from "@/components/catalog/BatchKpis";
import BatchTabs from "@/components/catalog/BatchTabs";
import CompareTab, { compareHref } from "@/components/catalog/CompareTab";
import AttentionList from "@/components/catalog/AttentionList";
import SheetPreview from "@/components/catalog/SheetPreview";
import DetailsTab from "@/components/catalog/DetailsTab";
import NotRefreshedLine from "@/components/catalog/NotRefreshedLine";
import CostLine from "@/components/catalog/CostLine";
import RetryCollectButton from "@/components/catalog/RetryCollectButton";
import { batchSource, canContinueSettingUp, collectingText, continueSettingUpHref, createdText, hasNotStarted, HOW_THIS_WORKS_DRAFT, notStartedText, plural } from "@/lib/catalog/copy";
import SkuMapModal from "@/components/catalog/SkuMapModal";
import { EvalList } from "@/components/catalog/EvalLabelBar";

type EvalQuery = { page?: string; channel?: string; verdict?: string };
/** ?tab= opens a tab; q, cchannel, cstatus and cpage are the Compare tab's filters and page. */
type PageQuery = EvalQuery & { tab?: string; q?: string; cchannel?: string; cstatus?: string; cpage?: string };

export default async function BatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<PageQuery> }) {
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
  const tab = (LINKABLE_TABS as readonly string[]).includes(query.tab ?? "") ? query.tab! : undefined;
  const compareFilters = { channel: query.cchannel ?? "", status: query.cstatus ?? "", q: query.q ?? "" };
  // A batch that never reached Start has made nothing: its Compare and Links sheet tabs say so in one line (spec 14a F9).
  const notStarted = hasNotStarted(batch);
  const settingUp = canContinueSettingUp(batch);
  // The comparison signs a page of images, so it loads only when its tab is asked for (?tab=compare).
  const [attention, evalPage, cost, stageCost, chunks, comparePage] = await Promise.all([
    evalMode ? Promise.resolve([]) : batchAttention(id),
    evalMode ? evalOutputs(id, { page: Number(query.page ?? 0) || 0, ...evalFilters }) : Promise.resolve(null),
    batchCostLine(batch),
    batchStageCost(id),
    batchChunkSummary(id),
    tab === "compare" && !notStarted ? batchCompare(id, { page: Number(query.cpage ?? 0) || 0, ...compareFilters }) : Promise.resolve(null),
  ]);
  const fullCost = fullCostText(stageCost, inrPerUsdFromEnv());
  const channelLabels = batch.channels.map(c => channel(c).label);
  const missingSkus = data.sheet.rows.filter(r => !r.opptraSkuIds.length).length;
  const source = batchSource(data.uploads.map(u => u.kind));
  // One clock for the whole render, so the banner's time left and the page state agree.
  const now = new Date();
  const state = batchState(batch, source, now);
  const downloads = (batch.sheetXlsxUri || batch.sheetCsvUri || data.filled) ? (
    <div className="dl">
      {batch.sheetXlsxUri && <a className="btn primary" href={`/api/catalog/batches/${id}/export?format=xlsx`}>Download links sheet (Excel)</a>}
      {batch.sheetCsvUri && <a className="btn ghost" href={`/api/catalog/batches/${id}/export?format=csv`}>Download CSV</a>}
      {data.filled && <a className="btn ghost" href={`/api/catalog/batches/${id}/export?format=filled`}>Download filled product list</a>}
    </div>
  ) : null;
  const next: Record<string, string> = {
    processing: "You can close this page and come back; nothing stops.",
    collecting: collectingText(source),
    attention: `Open "Needs attention" for the ${batch.counts.attentionProducts} ${plural(batch.counts.attentionProducts, "product", "products")} with a problem.`,
    ready: "Download the sheet and paste the links into the marketplace templates.",
    failed: "Nothing was processed and nothing was charged.",
  };
  const notStartedLine = <p>{notStartedText(batch.counts.sources, batch.counts.products)}</p>;
  return (
    <main>
      <div className="hdr">
        <div>
          <Link href="/catalog">← All batches</Link>
          <h1>{batch.name}</h1>
          <p className="lead">
            <Link href={`/catalog/brands/${batch.brandSlug}`}>{batch.brandName}</Link>{channelLabels.length > 0 && ` · ${channelLabels.join(", ")}`} · {batch.finishedAt ? `finished ${when(batch.finishedAt)} by ${batch.createdBy}` : batch.startedAt ? `started ${when(batch.startedAt)} by ${batch.createdBy}` : createdText(when(batch.createdAt), batch.createdBy)}
          </p>
        </div>
        {downloads}
        {canAct && batch.status === "failed" && (
          <ActionOnly><Link className="btn primary" href={`/catalog/new?brand=${encodeURIComponent(batch.brandSlug)}`}>Start again</Link></ActionOnly>
        )}
        {canAct && state.stalled && <ActionOnly><RetryCollectButton batchId={id} /></ActionOnly>}
      </div>
      <BatchBanner key={id} status={batch.status} counts={batch.counts} source={source} updatedAt={new Date(batch.updatedAt).toISOString()} startedAt={batch.startedAt ? new Date(batch.startedAt).toISOString() : null} now={now.toISOString()} keptPhotos={data.keptPhotos} styliSkipped={data.styliSkipped} continueHref={canAct && settingUp ? continueSettingUpHref(id) : undefined} />
      <NotRefreshedLine items={data.notRefreshedChannels} />
      <BatchKpis counts={batch.counts} />
      <AutoRefresh active={state.state === "collecting" || state.state === "processing"} />
      <BatchTabs
        attentionCount={attention.length}
        evalLabel={evalPage ? `Needs attention (${evalPage.total} ${plural(evalPage.total, "image", "images")})` : undefined}
        initialTab={tab ?? (evalMode && (query.page || query.channel || query.verdict) ? "attention" : undefined)}
        compare={notStarted ? notStartedLine : comparePage ? <CompareTab data={comparePage} channels={batch.channels} filters={compareFilters} /> : <p className="muted">Loading the comparison.</p>}
        compareHref={comparePage || notStarted ? undefined : compareHref(compareFilters)}
        overview={
          <div className="grid2">
            <div className="card">
              <h2>How this works</h2>
              <p>We check every image against the marketplace rules and our quality check. Images that pass go straight into the links sheet. Only products with a problem are listed under Needs attention.</p>
              {settingUp && <p>{HOW_THIS_WORKS_DRAFT}</p>}
              {next[state.state] && <p>{next[state.state]}</p>}
              {batch.counts.existingProducts > 0 && <p>Marketplaces keep their own copy. Re-submit the image columns for products marked updated, shots_removed or reordered in the sheet.</p>}
            </div>
            <div className="card">
              <h2>Cost so far</h2>
              <CostLine line={{ usdPerIdentifier: cost.usdPerIdentifier, inrPerIdentifier: cost.inrPerIdentifier, usd: cost.usd, inr: cost.inr }} />
              {fullCost && <p className="cost-split">{fullCost}</p>}
            </div>
          </div>
        }
        attention={evalPage
          ? <EvalList batchId={id} data={evalPage} channels={batch.channels} filters={evalFilters} canAct={canAct} />
          : <AttentionList items={attention} canAct={canAct} channels={channelLabels} />}
        sheet={notStarted ? notStartedLine : (
          <>
            <SheetPreview sheet={data.sheet} />
            {downloads}
            {canAct && batch.counts.products > 0 && (
              <ActionOnly>
                <SkuMapModal batchId={id} missing={missingSkus} sheetUri={batch.sheetXlsxUri} />
              </ActionOnly>
            )}
            <p className="help">Opptra SKU ids are filled in automatically when they exist.</p>
          </>
        )}
        details={
          <DetailsTab id={id} brand={batch.brandSlug} isTest={batch.isTest} counts={batch.counts}
            failures={data.failures} recheckFailures={data.recheckFailures}
            notRefreshedChannels={data.notRefreshedChannels} hasReport={!!batch.reportUri}
            chunks={chunks.counts} lastFailedChunk={chunks.lastFailed} batchError={batch.error} />
        }
      />
    </main>
  );
}
