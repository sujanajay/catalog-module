"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandOption } from "@catalog/core/catalog/brands";
import type { ChannelId, IdentifierMode, Precedence, ProductType } from "@catalog/core/catalog/types";
import { COLLECT_STALLED_TEXT } from "@catalog/core/catalog/pipeline/status";
import type { WizardDetected, WizardPreview } from "../../lib/catalog/preview";
import { useToast } from "../Toast";
import WizardStep1 from "./WizardStep1";
import WizardStep2, { type SheetChoice } from "./WizardStep2";
import WizardStep3 from "./WizardStep3";
import WizardStep4 from "./WizardStep4";
import RetryCollectButton from "./RetryCollectButton";
import { batchUrl, wizardApi } from "./wizard-client";
import "./wizard.css";

const STEPS = ["Brand and files", "Check what we found", "Where will these images go?", "Start"];
export default function CatalogWizard({ brands, shareEmail, initialBrand = "" }: { brands: BrandOption[]; shareEmail: string; initialBrand?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [brandSlug, setBrand] = useState(initialBrand);
  const [name, setName] = useState("");
  const [productType, setProductType] = useState<ProductType>("auto");
  const [id, setId] = useState<string | null>(null);
  const creating = useRef<Promise<string> | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const detectedRequest = useRef(0);
  const [channels, setChannels] = useState<ChannelId[]>([]);
  const [mode, setMode] = useState<IdentifierMode>("filename");
  const [precedence, setPrecedence] = useState<Precedence>("uploads_then_links");
  const [sheets, setSheets] = useState<SheetChoice[]>([]);
  const [detected, setDetected] = useState<WizardDetected | null>(null);
  const [preview, setPreview] = useState<WizardPreview | null>(null);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const [linksBusy, setLinksBusy] = useState(false);
  const [hasInputs, setHasInputs] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [collecting, setCollecting] = useState(true);
  const [failReason, setFailReason] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  /** The name the batch already has, so a second Continue after a failed hand-off skips the PATCH. */
  const savedName = useRef<string | null>(null);
  const detectedInitialised = useRef(false);
  async function ensureBatch() {
    if (id) return id;
    if (!brandSlug) throw new Error("Choose a brand before adding files or links.");
    if (!creating.current) {
      setIsCreating(true);
      const sentName = name.trim();
      creating.current = wizardApi<{id:string}>("/api/catalog/batches", "POST", { brandSlug, name, productType }).then((batch) => { savedName.current = sentName; setId(batch.id); return batch.id; }).catch((err) => { creating.current = null; throw err; }).finally(() => setIsCreating(false));
    }
    return creating.current;
  }
  const onAdded = useCallback(() => {setHasInputs(true); setPreview(null);}, []);
  async function loadDetected(batchId: string, initialise = false) {
    const request = ++detectedRequest.current;
    const batch = await wizardApi<{counts:{previewReady:boolean;failReason:string|null}}>(batchUrl(batchId));
    const value = await wizardApi<WizardDetected>(batchUrl(batchId, "/detected"));
    if (request !== detectedRequest.current) return value;
    setFailReason(batch.counts.failReason);
    setCollecting(!batch.counts.previewReady);
    setDetected(value);
    if (initialise && batch.counts.previewReady) {
      detectedInitialised.current = true;
      setMode(value.identifierMode.detected);
      setPrecedence(value.precedence.default);
      setSheets(value.sheets.map((s) => ({uploadId:s.uploadId,identifierColumn:s.identifierColumn,imageColumns:s.imageColumns,kind:s.kind})));
    }
    return value;
  }
  useEffect(() => {
    if (!id || ![2,3,4].includes(step)) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if(step === 4) {
          const value = await wizardApi<WizardPreview>(batchUrl(id,"/preview"));
          if(active) setPreview(value);
        } else {
          const request = ++detectedRequest.current;
          const batch = await wizardApi<{counts:{previewReady:boolean;failReason:string|null};state?:{stalled?:boolean}}>(batchUrl(id));
          const value = await wizardApi<WizardDetected>(batchUrl(id,"/detected"));
          if(active && request === detectedRequest.current) {
            setCollecting(!batch.counts.previewReady);
            setStalled(!!batch.state?.stalled);
            setFailReason(batch.counts.failReason);
            setDetected(value);
            if (batch.counts.previewReady && !detectedInitialised.current) {
              detectedInitialised.current = true;
              setMode(value.identifierMode.detected);
              setPrecedence(value.precedence.default);
            }
            setSheets((old) => value.sheets.map((s) => old.find((prior) => prior.uploadId===s.uploadId) ?? {uploadId:s.uploadId,identifierColumn:s.identifierColumn,imageColumns:s.imageColumns,kind:s.kind}));
          }
        }
      } catch(err) {if(active) setError(err instanceof Error ? err.message : "This did not finish. Try again.");}
      finally {polling=false;}
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {active=false;detectedRequest.current++;clearInterval(timer);};
  },[id,step]);
  async function continueStep() {
    setWorking(true);setError("");
    try {
      const batchId = await ensureBatch();
      if(step === 1) {
        if(name.trim() && name.trim() !== savedName.current) {await wizardApi(batchUrl(batchId),"PATCH",{name});savedName.current = name.trim();}
        await wizardApi(batchUrl(batchId,"/ingest"),"POST");
        await loadDetected(batchId,true);
        setStep(2);
      } else if(step === 2) {
        await wizardApi(batchUrl(batchId,"/detected"),"PATCH",{identifierMode:mode,precedence,sheets});
        setCollecting(true);setPreview(null);setStep(3);
      } else if(step === 3) {
        await wizardApi(batchUrl(batchId),"PATCH",{channels});
        setPreview(null);setStep(4);
      } else if(preview?.ready) {
        await wizardApi(batchUrl(batchId,"/start"),"POST",{previewAt:preview.previewAt});
        toast("Batch started. We will show progress here.");
        router.push(`/catalog/${batchId}`);
      }
    } catch(err) {setError(err instanceof Error ? err.message : "This did not finish. Try again.");}
    finally {setWorking(false);}
  }
  const disabled = working || !!failReason || (step===1 && (!brandSlug || !hasInputs || uploadsBusy || linksBusy)) || (step===2 && (collecting || !detected || sheets.some((s)=>s.identifierColumn<0))) || (step===3 && (!channels.length || collecting)) || (step===4 && (!preview?.ready || !channels.length || !!preview.busy.length || !!preview.overwrite.sameProductPairs.length));
  return <div className="catalog-wizard"><h1>New batch</h1><ol className="steps" aria-label="Batch steps">{STEPS.map((title,i)=><li key={title} className={step===i+1?"on":step>i+1?"done":""} aria-current={step===i+1?"step":undefined}>{title}</li>)}</ol>
    <div hidden={step!==1}><WizardStep1 brands={brands} brandSlug={brandSlug} name={name} productType={productType} locked={!!id || isCreating} email={shareEmail} setBrand={(value)=>{if(!id && !creating.current)setBrand(value);}} setName={setName} setProductType={(value)=>{if(!id && !creating.current)setProductType(value);}} ensureBatch={ensureBatch} onUploadsBusy={setUploadsBusy} onLinksBusy={setLinksBusy} onAdded={onAdded}/></div>
    {step===2 && detected && id ? <><WizardStep2 detected={detected} mode={mode} precedence={precedence} sheets={sheets} setMode={setMode} setPrecedence={setPrecedence} setSheets={setSheets} email={shareEmail} id={id} onError={setError} onAccessChecked={async()=>{await loadDetected(id);}}/>{collecting?<p role="status">Collecting files. The grouping will appear here when the files are ready.</p>:null}</>:null}
    {(step===2 || step===3) && stalled && id ? <p role="alert">{COLLECT_STALLED_TEXT} <RetryCollectButton batchId={id} onDone={()=>setStalled(false)}/></p>:null}
    {step===3?<><WizardStep3 channels={channels} onChange={setChannels}/>{collecting?<p role="status">Collecting files. Continue when the grouping is ready.</p>:null}</>:null}
    {step===4?<WizardStep4 preview={preview}/>:null}
    {error?<p role="alert">{error}</p>:null}
    {failReason?<p role="alert">{failReason} <a href={`/catalog/${id}`}>Open batch details</a></p>:null}
    <div className="actions">{step>1?<button type="button" className="btn ghost" disabled={working} onClick={()=>{setError("");setStep(step-1);}}>Back</button>:<a className="btn ghost" href="/catalog">All batches</a>}<button type="button" className="btn primary" disabled={disabled} onClick={()=>void continueStep()}>{working?"Please wait...":step===4?"Start processing":"Continue"}</button></div>
  </div>;
}
