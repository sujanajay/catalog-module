"use client";
import type { BrandOption } from "@catalog/core/catalog/brands";
import type { ProductType } from "@catalog/core/catalog/types";
import { useCallback, useState } from "react";
import Uploader, { type LocalUpload } from "./Uploader";
import PasteBox from "./PasteBox";
import InputList from "./InputList";
/** `batchId`, `onInputCount` and `onRemoved` feed the input list (spec 14b F3): what the batch holds, with Remove. */
export default function WizardStep1({brands,brandSlug,name,productType,locked,email,setBrand,setName,setProductType,ensureBatch,onUploadsBusy,onLinksBusy,onAdded,batchId,onInputCount,onRemoved}: {brands:BrandOption[];brandSlug:string;name:string;productType:ProductType;locked:boolean;email:string;setBrand(value:string):void;setName(value:string):void;setProductType(value:ProductType):void;ensureBatch():Promise<string>;onUploadsBusy(value:boolean):void;onLinksBusy(value:boolean):void;onAdded():void;batchId?:string|null;onInputCount?(count:number):void;onRemoved?():void}) {
 const [local,setLocal] = useState<LocalUpload[]>([]);
 const [version,setVersion] = useState(0);
 // Every add (or a removal from the uploader) refreshes the input list from the server.
 const added = useCallback(()=>{setVersion((v)=>v+1);onAdded();},[onAdded]);
 return <div className="grid2"><section className="card"><label className="f" htmlFor="brand">Which brand?</label><select id="brand" value={brandSlug} disabled={locked} onChange={(e)=>setBrand(e.target.value)}><option value="">Choose a brand</option>{(["softline","hardline"] as const).map((line)=><optgroup key={line} label={line==="softline"?"Softline":"Hardline"}>{brands.filter((b)=>b.line===line).map((b)=><option key={b.slug} value={b.slug}>{b.name}</option>)}</optgroup>)}</select><p className="help">Brand not in the list? Email <a href="mailto:sujan@opptra.com">sujan@opptra.com</a>.</p>
 <label htmlFor="batch-name">Batch name (optional)</label><input type="text" id="batch-name" value={name} onChange={(e)=>setName(e.target.value)} placeholder="USPA kids sneakers, Oct lot"/>
 <label htmlFor="product-type">What kind of products?</label><select id="product-type" value={productType} disabled={locked} onChange={(e)=>setProductType(e.target.value as ProductType)}>{[["auto","Detect automatically (recommended)"],["footwear","Footwear"],["apparel_model","Apparel on a model"],["apparel_flat","Apparel laid flat"],["bag_accessory","Bags and accessories"],["other","Other"]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><p className="help">A folder can mix footwear, apparel and accessories; we detect each product separately.</p></section>
 <section className="card"><p className="f" style={{marginTop:0}}>What do you have?</p><Uploader ensureBatch={ensureBatch} onBusy={onUploadsBusy} onAdded={added} onRows={setLocal}/><PasteBox email={email} ensureBatch={ensureBatch} onBusy={onLinksBusy} onAdded={added}/>
 <InputList batchId={batchId ?? null} version={version} local={local} onCount={(count)=>onInputCount?.(count)} onRemoved={()=>onRemoved?.()}/></section></div>;
}
