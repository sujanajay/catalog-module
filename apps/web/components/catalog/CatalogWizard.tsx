"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandOption } from "@catalog/core/catalog/brands";
import type { BatchCounts, BatchStatus, ChannelId, IdentifierMode, Precedence, ProductType } from "@catalog/core/catalog/types";
import { ANOTHER_BATCH_RUNNING, COLLECT_STALLED_TEXT, type BatchState } from "@catalog/core/catalog/pipeline/status";
import { BRAND_QUESTION, NEWEST_SAME_PRODUCT, canRetryLinks, collectingLine, continueSettingUpHref, countdownText, estimateText, foundText, goingToText, KEEP_GOING_LINE } from "../../lib/catalog/copy";
import type { WizardDetected, WizardPreview } from "../../lib/catalog/preview";
import { useToast } from "../Toast";
import WizardStep2, { mergeSheetChoices, type GroupingChoice, type SheetChoice } from "./WizardStep2";
import Uploader, { type LocalUpload } from "./Uploader";
import PasteBox from "./PasteBox";
import ShareBox from "./ShareBox";
import InputList, { type ServerInput } from "./InputList";
import ChannelPicker, { CHANNEL_CHOICES } from "./ChannelPicker";
import GroupingPreview from "./GroupingPreview";
import OverwritePreview from "./OverwritePreview";
import RetryCollectButton from "./RetryCollectButton";
import LinkFailures, { RetryLinksButton } from "./LinkFailures";
import { FixAndContinueButton } from "./UnfinishedBatches";
import { batchUrl, wizardApi } from "./wizard-client";
import { PASTE_INPUT_KINDS } from "@catalog/core/catalog/types";
import "./wizard.css";

/** An existing draft or collecting batch the page reopens (spec 14a F4 part 1, `/catalog/new?batch=<id>`). */
export interface WizardInitialBatch {
  id: string; brandSlug: string; name: string; productType: ProductType; channels: ChannelId[];
  options: { identifierMode: IdentifierMode; precedence: Precedence; perRoot?: boolean };
  uploads: { status: string }[]; counts: BatchCounts; status: BatchStatus; state: BatchState;
}
/**
 * The grouping answers a reopened batch shows. Saved options that differ from the creation defaults can only come from
 * the operator's own change, so they win and the first poll must not replace them with the detected defaults (`chosen`).
 * A per-root batch (M1-F1-R2) opens on "per_root"; one changed to a single mode opens on that mode.
 */
export function resumedGrouping(initialBatch: WizardInitialBatch | undefined, initialStep: number): { mode: GroupingChoice; precedence: Precedence; chosen: boolean } {
  if (!initialBatch) return { mode: "per_root", precedence: "uploads_then_links", chosen: false };
  const { identifierMode, precedence, perRoot } = initialBatch.options;
  const mode: GroupingChoice = perRoot ? "per_root" : identifierMode;
  return { mode, precedence, chosen: initialStep === 4 || (!perRoot && identifierMode !== "filename") || precedence !== "uploads_then_links" };
}
/** GET /api/catalog/batches/<id>, the parts this page reads. */
type PolledBatch = {
  batch: { status: BatchStatus; startedAt: string | null; options: { autoStart?: boolean; newestSameProduct?: boolean } };
  counts: { previewReady: boolean; failReason: string | null; collectTotal?: number | null; autoStartAt?: string | null; fixReason?: string | null };
  state?: BatchState;
};
type Defaults = { brandSlug: string | null; brandName: string | null; channels: ChannelId[]; channelSource: "listed" | "slice" | null };
const PASTE_KINDS: readonly string[] = PASTE_INPUT_KINDS;
const PRODUCT_TYPES: [ProductType, string][] = [["auto", "Detect automatically (recommended)"], ["footwear", "Footwear"], ["apparel_model", "Apparel on a model"], ["apparel_flat", "Apparel laid flat"], ["bag_accessory", "Bags and accessories"], ["other", "Other"]];
const channelLabel = (id: ChannelId) => CHANNEL_CHOICES.find((c) => c.id === id)?.label ?? id;

/** "What we found" once the files are grouped: the count and grouping sentence, warnings, cost and overwrites. */
export function FoundSummary({ preview, sentence, batchId, onLinksRetried }: { preview: WizardPreview; sentence: string | null; batchId: string; onLinksRetried?(): void }) {
  return <>
    <p>{foundText(preview.counts.sources, preview.counts.products)}{sentence ? ` ${sentence}` : ""}</p>
    {preview.warnings.length ? <div className="warning">{preview.warnings.map((w, i) => <p key={i}>{w.headline} {w.detail}</p>)}{canRetryLinks(preview.linkFailures) ? <p><RetryLinksButton batchId={batchId} onDone={onLinksRetried}/></p> : null}</div> : null}
    <p>{estimateText(preview.estimate)}</p>{preview.otherBatchProcessing ? <p>{ANOTHER_BATCH_RUNNING}</p> : null}
    <OverwritePreview preview={preview}/>
    <details><summary>See the grouping</summary><GroupingPreview preview={preview}/></details>
  </>;
}

/**
 * The New batch page (UX3, M1-F2): one page that fills in as data arrives. The inputs (with the sharing line always
 * visible, R1), "what we found" and "where it goes". The brand is read from the dropped names and asked only when it
 * cannot be (R3); the channels come from the brand (R4); product type is under More options (R5). Once the files are
 * collected the batch starts by itself after a 10 s countdown on the server (R6), and Wait leaves one Start button.
 */
export default function CatalogWizard({ brands, shareEmail, supabasePaste = false, initialBrand = "", initialBatch }: { brands: BrandOption[]; shareEmail: string; supabasePaste?: boolean; initialBrand?: string; initialBatch?: WizardInitialBatch }) {
  const router = useRouter();
  const toast = useToast();
  const [brandSlug, setBrandSlug] = useState(initialBatch?.brandSlug ?? initialBrand);
  const [askBrand, setAskBrand] = useState(false);
  /** Adds waiting for the brand answer (R3): they go on as soon as it is chosen, with no other click. */
  const brandWaiters = useRef<((slug: string) => void)[]>([]);
  const [name, setName] = useState(initialBatch?.name ?? "");
  const savedName = useRef<string | null>(initialBatch ? initialBatch.name.trim() : null);
  const [productType, setProductType] = useState<ProductType>(initialBatch?.productType ?? "auto");
  const [id, setId] = useState<string | null>(initialBatch?.id ?? null);
  const creating = useRef<Promise<string> | null>(null);
  const [channels, setChannels] = useState<ChannelId[]>(initialBatch?.channels ?? []);
  const [channelSource, setChannelSource] = useState<Defaults["channelSource"]>(null);
  const [changingChannels, setChangingChannels] = useState(false);
  const [changingBrand, setChangingBrand] = useState(false);
  /** Auto-start was on when the brand list opened (and was held for it). */
  const resumeAuto = useRef(false);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const [linksBusy, setLinksBusy] = useState(false);
  const [hasInputs, setHasInputs] = useState(() => !!initialBatch?.uploads.some((u) => u.status !== "removed"));
  /** Inputs were added or removed since the last hand-off to collecting: hand off once nothing is uploading. */
  const [handOff, setHandOff] = useState(false);
  const [local, setLocal] = useState<LocalUpload[]>([]);
  const [listVersion, setListVersion] = useState(0);
  const [pasteRemoved, setPasteRemoved] = useState(0);
  const [polled, setPolled] = useState<PolledBatch | null>(null);
  const [detected, setDetected] = useState<WizardDetected | null>(null);
  const [preview, setPreview] = useState<WizardPreview | null>(null);
  const [resumed] = useState(() => resumedGrouping(initialBatch, 1));
  const [mode, setMode] = useState<GroupingChoice>(resumed.mode);
  const [precedence, setPrecedence] = useState<Precedence>(resumed.precedence);
  const [sheets, setSheets] = useState<SheetChoice[]>([]);
  const [newest, setNewest] = useState<boolean | null>(null);
  const detectedInitialised = useRef(resumed.chosen);
  const pollRequest = useRef(0);
  /** Set once the batch has started and the page is moving to it: no more polls, and only one router.push. */
  const leaving = useRef(false);
  function openStarted(batchId: string) {
    if (leaving.current) return;
    leaving.current = true;
    toast("Batch started. We will show progress here.");
    router.push(`/catalog/${batchId}`);
  }
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  async function defaultsFor(paths: string[], slug?: string): Promise<Defaults> {
    return wizardApi<Defaults>("/api/catalog/brands/infer", "POST", slug ? { paths: [], brandSlug: slug } : { paths: paths.slice(0, 5000) });
  }
  function chooseBrand(slug: string) {
    if (id || !slug) return;
    setBrandSlug(slug);
    brandWaiters.current.splice(0).forEach((resolve) => resolve(slug));
  }
  /** The batch, made on the first add: brand read from the dropped names (or asked), channels from the brand. */
  async function ensureBatch(paths: string[] = []) {
    if (id) return id;
    if (!creating.current) {
      creating.current = (async () => {
        let defaults: Defaults | null = brandSlug ? await defaultsFor([], brandSlug) : paths.length ? await defaultsFor(paths) : null;
        if (!defaults?.brandSlug) {
          setAskBrand(true);
          const slug = await new Promise<string>((resolve) => brandWaiters.current.push(resolve));
          defaults = await defaultsFor([], slug);
        }
        setBrandSlug(defaults.brandSlug!); setChannels(defaults.channels); setChannelSource(defaults.channelSource);
        const sentName = name.trim();
        const batch = await wizardApi<{ id: string }>("/api/catalog/batches", "POST", { brandSlug: defaults.brandSlug, name, productType, channels: defaults.channels, autoStart: true });
        savedName.current = sentName; setId(batch.id); setAskBrand(false);
        // The batch id goes into the address bar at once, so a reload, Back or a closed tab loses nothing.
        router.replace(continueSettingUpHref(batch.id), { scroll: false });
        return batch.id;
      })().catch((err: unknown) => { creating.current = null; throw err; });
    }
    return creating.current;
  }
  const onAdded = useCallback(() => { setHasInputs(true); setHandOff(true); setListVersion((v) => v + 1); }, []);
  const onRemoved = useCallback((input: ServerInput) => { if (PASTE_KINDS.includes(input.kind)) setPasteRemoved((n) => n + 1); setHandOff(true); }, []);

  // Hand the inputs to collecting once nothing is uploading or being checked (there is no Continue, R2).
  useEffect(() => {
    if (!id || !handOff || uploadsBusy || linksBusy || !hasInputs) return;
    const timer = setTimeout(() => {
      setHandOff(false);
      void (async () => {
        try {
          if (name.trim() && name.trim() !== savedName.current) { await wizardApi(batchUrl(id), "PATCH", { name }); savedName.current = name.trim(); }
          await wizardApi(batchUrl(id, "/ingest"), "POST");
          pollRequest.current++; setPreview(null);
        } catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
      })();
    }, 800);
    return () => clearTimeout(timer);
  }, [id, handOff, uploadsBusy, linksBusy, hasInputs, name]);

  // Every change shows within 2.5 s (R8): the batch, and once collected what we found.
  useEffect(() => {
    if (!id) return;
    let active = true; let polling = false;
    const poll = async () => {
      // A push repeated every poll restarts the navigation, so a page that takes longer than a poll to render never opens.
      if (polling || leaving.current) return;
      polling = true;
      const request = ++pollRequest.current;
      try {
        const batch = await wizardApi<PolledBatch>(batchUrl(id));
        if (!active || request !== pollRequest.current) return;
        setPolled(batch);
        if (batch.batch.startedAt && batch.batch.status !== "cancelled") { openStarted(id); return; }
        const value = await wizardApi<WizardDetected>(batchUrl(id, "/detected"));
        if (!active || request !== pollRequest.current) return;
        setDetected(value);
        if (batch.counts.previewReady && !detectedInitialised.current) {
          detectedInitialised.current = true;
          setMode(value.grouping.perRoot ? "per_root" : value.identifierMode.detected);
          setPrecedence(value.precedence.default);
        }
        setSheets((old) => mergeSheetChoices(old, value.sheets));
        if (batch.counts.previewReady && batch.batch.status === "draft") {
          const found = await wizardApi<WizardPreview>(batchUrl(id, "/preview"));
          if (active && request === pollRequest.current) setPreview(found);
        }
      } catch (err) { if (active) setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => { active = false; pollRequest.current++; clearInterval(timer); };
    // toast and router are stable; the poll reads only setters and refs.
  }, [id]);

  const autoStartAt = polled?.batch.status === "draft" && polled.batch.options.autoStart ? polled.counts.autoStartAt ?? null : null;
  useEffect(() => {
    if (!autoStartAt) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [autoStartAt]);

  /** M1 D22: a different brand before Start: its default channels, and the files grouped again under it. */
  /**
   * Opening the brand list holds the countdown first (on the server, as Wait does), so the batch cannot start on the
   * old brand while the operator looks for the right one. Choosing a brand, the same one included, turns it back on.
   */
  async function openBrandPicker() {
    if (!id) return;
    const auto = polled ? polled.batch.options.autoStart === true : true;
    setWorking(true); setError("");
    try {
      if (auto) {
        await wizardApi(batchUrl(id, "/hold-start"), "POST");
        pollRequest.current++;
        setPolled((p) => p ? { ...p, batch: { ...p.batch, options: { ...p.batch.options, autoStart: false } }, counts: { ...p.counts, autoStartAt: null } } : p);
      }
      resumeAuto.current = auto;
      setChangingBrand(true);
    } catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
    finally { setWorking(false); }
  }
  async function changeBrand(slug: string) {
    if (!id || !slug) return;
    setWorking(true); setError("");
    try {
      // The same brand is sent too: it turns auto-start back on, and retries a hand-off that failed.
      const next = await wizardApi<Defaults & { collecting: boolean }>(batchUrl(id, "/brand"), "POST", { brandSlug: slug, ...(resumeAuto.current ? { autoStart: true } : {}) });
      setBrandSlug(next.brandSlug!); setChannels(next.channels); if (next.channelSource) setChannelSource(next.channelSource); setChangingBrand(false);
      pollRequest.current++; setPreview(null);
      setPolled((p) => p ? { ...p, counts: { ...p.counts, previewReady: !next.collecting && p.counts.previewReady, autoStartAt: null } } : p);
    } catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
    finally { setWorking(false); }
  }
  async function saveChannels(next: ChannelId[]) {
    setChannels(next);
    if (!id) return;
    try { await wizardApi(batchUrl(id), "PATCH", { channels: next }); } catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
  }
  async function wait() {
    if (!id) return;
    setWorking(true); setError("");
    try { await wizardApi(batchUrl(id, "/hold-start"), "POST"); pollRequest.current++; setPolled((p) => p ? { ...p, batch: { ...p.batch, options: { ...p.batch.options, autoStart: false } }, counts: { ...p.counts, autoStartAt: null } } : p); }
    catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
    finally { setWorking(false); }
  }
  async function start() {
    if (!id) return;
    setWorking(true); setError("");
    try {
      const fresh = await wizardApi<WizardPreview>(batchUrl(id, "/preview"));
      await wizardApi(batchUrl(id, "/start"), "POST", { previewAt: fresh.previewAt });
      openStarted(id);
    } catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
    finally { setWorking(false); }
  }
  async function applyGrouping() {
    if (!id) return;
    setWorking(true); setError("");
    try {
      await wizardApi(batchUrl(id, "/detected"), "PATCH", { ...(mode === "per_root" ? { perRoot: true } : { identifierMode: mode, perRoot: false }), precedence, sheets, newestSameProduct: newestOn });
      pollRequest.current++; setPreview(null);
    } catch (err) { setError(err instanceof Error ? err.message : "This did not finish. Try again."); }
    finally { setWorking(false); }
  }

  const status = polled?.batch.status ?? initialBatch?.status ?? "draft";
  const failReason = polled ? polled.counts.failReason : initialBatch?.counts.failReason ?? null;
  const fixReason = polled ? polled.counts.fixReason ?? null : initialBatch?.counts.fixReason ?? null;
  const state = polled?.state ?? initialBatch?.state ?? null;
  const ready = !!polled?.counts.previewReady && status === "draft" && !!preview?.ready;
  const previewReady = polled ? polled.counts.previewReady : !!initialBatch?.counts.previewReady;
  const collecting = !!id && hasInputs && !failReason && !previewReady;
  const needsColumn = sheets.some((s) => s.identifierColumn < 0);
  const newestOn = newest ?? polled?.batch.options.newestSameProduct !== false;
  const brandName = brands.find((b) => b.slug === brandSlug)?.name ?? "";
  const brandLocked = !!id || (!!creating.current && !askBrand);
  return <div className="catalog-wizard"><h1>New batch</h1>
    <section className="card stack">
      <ShareBox email={shareEmail}/>
      {(askBrand && !id) || changingBrand ? <div><label className="f" htmlFor="brand">{BRAND_QUESTION}</label><select id="brand" value={changingBrand ? "" : brandSlug} disabled={working} onChange={(e) => changingBrand ? void changeBrand(e.target.value) : chooseBrand(e.target.value)}><option value="">Choose a brand</option>{(["softline", "hardline"] as const).map((line) => <optgroup key={line} label={line === "softline" ? "Softline" : "Hardline"}>{brands.filter((b) => b.line === line).map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}</optgroup>)}</select><p className="help">Brand not in the list? Email <a href="mailto:sujan@opptra.com">sujan@opptra.com</a>.</p></div> : null}
      {brandName && (id || brandLocked) && !changingBrand ? <p>Brand: <b>{brandName}</b>{id && status === "draft" && !collecting ? <> <button type="button" className="btn ghost sm" disabled={working} onClick={() => void openBrandPicker()}>Change brand</button></> : null}</p> : null}
      <Uploader ensureBatch={ensureBatch} onBusy={setUploadsBusy} onAdded={onAdded} onRows={setLocal}/>
      <PasteBox ensureBatch={() => ensureBatch()} onBusy={setLinksBusy} onAdded={onAdded} removed={pasteRemoved} supabase={supabasePaste}/>
      {fixReason ? <p role="alert" className="fix-reason">{fixReason}</p> : null}
      <InputList batchId={id} version={listVersion} local={local} onCount={(n) => setHasInputs(n > 0)} onRemoved={onRemoved}/>
      <details><summary>More settings</summary>
        <label htmlFor="batch-name">Batch name (optional)</label><input type="text" id="batch-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (id && name.trim() && name.trim() !== savedName.current) void wizardApi(batchUrl(id), "PATCH", { name }).then(() => { savedName.current = name.trim(); }).catch((err: unknown) => setError(err instanceof Error ? err.message : "This did not finish. Try again.")); }} placeholder="USPA kids sneakers, Oct lot"/>
        <label htmlFor="product-type">What kind of products?</label><select id="product-type" value={productType} disabled={!!id || !!creating.current} onChange={(e) => setProductType(e.target.value as ProductType)}>{PRODUCT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p className="help">A folder can mix shoes, clothes and bags. We sort each product on its own.</p>
      </details>
    </section>

    {id && hasInputs ? <section className="card stack" aria-label="What we found"><h2>What we found</h2>
      {collecting ? <p role="status">{collectingLine(state, polled ? polled.counts.collectTotal : initialBatch?.counts.collectTotal)}</p> : null}
      {state?.stalled ? <p role="alert">{COLLECT_STALLED_TEXT} <RetryCollectButton batchId={id} onDone={() => { pollRequest.current++; }}/></p> : null}
      {ready && preview ? <FoundSummary preview={preview} sentence={detected?.grouping.sentence ?? null} batchId={id} onLinksRetried={() => { pollRequest.current++; setPreview(null); }}/> : null}
      {!ready && detected?.linkFailures?.total ? <LinkFailures batchId={id} failures={detected.linkFailures} onRetried={() => { pollRequest.current++; setPreview(null); }}/> : null}
      {detected && (ready || needsColumn) ? <details open={needsColumn}><summary>Change how products are grouped</summary><WizardStep2 detected={detected} collecting={false} mode={mode} precedence={precedence} sheets={sheets} setMode={setMode} setPrecedence={setPrecedence} setSheets={setSheets} email={shareEmail} id={id} onError={setError} onAccessChecked={async () => { pollRequest.current++; }} onLinksRetried={() => { pollRequest.current++; setPreview(null); }}/><label className="opt"><input type="checkbox" checked={newestOn} onChange={(e) => setNewest(e.target.checked)}/><span>{NEWEST_SAME_PRODUCT}</span></label><p><button type="button" className="btn ghost" disabled={working || needsColumn} onClick={() => void applyGrouping()}>Group again</button></p></details> : null}
    </section> : null}

    {id || channels.length ? <section className="card stack" aria-label="Where it goes"><h2>Where it goes</h2>
      <p>{channels.length ? goingToText(channels.map(channelLabel), channelSource === "listed") : "Choose at least one channel."} <button type="button" className="btn ghost sm" onClick={() => setChangingChannels((v) => !v)}>Change</button></p>
      {changingChannels ? <ChannelPicker channels={channels} onChange={(next) => void saveChannels(next)}/> : null}
    </section> : null}

    {error ? <p role="alert">{error}</p> : null}
    {failReason ? <p role="alert">{failReason} {id && state?.fixable ? <><FixAndContinueButton batchId={id}/> </> : null}{id && canRetryLinks(detected?.linkFailures) ? <><RetryLinksButton batchId={id} onDone={() => { pollRequest.current++; }}/> </> : null}<a href={`/catalog/${id}`}>Open batch details</a></p> : null}
    {ready && autoStartAt ? <p role="status" className="countdown">{countdownText((Date.parse(autoStartAt) - now) / 1000)} <button type="button" className="btn ghost" disabled={working} onClick={() => void wait()}>Wait</button></p> : null}
    {ready && !autoStartAt ? <p><button type="button" className="btn primary" disabled={working || !channels.length} onClick={() => void start()}>{working ? "Please wait..." : "Start"}</button></p> : null}
    {id ? <p className="help">{KEEP_GOING_LINE}</p> : null}
    <div className="actions"><a className="btn ghost" href="/catalog">All batches</a></div>
  </div>;
}
