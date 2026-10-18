"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, SessionEndedError } from "@/lib/fetch";
import { useToast } from "@/components/Toast";
export default function RemoveProductDialog({id,identifier,brand,channels}:{id:string;identifier:string;brand:string;channels:string}) {
 const [open,setOpen]=useState(false);const [confirm,setConfirm]=useState("");const [busy,setBusy]=useState(false);const ref=useRef<HTMLDialogElement>(null);const toast=useToast();const router=useRouter();
 useEffect(()=>{if(open) ref.current?.showModal();else ref.current?.close();},[open]);
 async function remove(){setBusy(true);try{const res=await apiFetch(`/api/catalog/products/${id}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm})});if(!res.ok)throw new Error((await res.json()).error);toast(`${identifier} removed.`);router.push(`/catalog/brands/${brand}`);router.refresh();}catch(err){if(!(err instanceof SessionEndedError))toast(err instanceof Error?err.message:"Could not remove the product. Try again.");}finally{setBusy(false);}}
 return <><button className="btn ghost" onClick={()=>{setConfirm("");setOpen(true);}}>Remove product</button><dialog ref={ref} aria-labelledby="remove-title" onCancel={e=>{if(busy)e.preventDefault();else setOpen(false);}}><h2 id="remove-title">Remove {identifier}?</h2><p>This deletes its live images on {channels || "every live marketplace"}. Marketplaces keep their copy. Type the identifier to confirm.</p><input type="text" aria-label="Type the identifier to confirm" value={confirm} disabled={busy} onChange={e=>setConfirm(e.target.value)}/><div className="acts"><button className="btn ghost" disabled={busy} onClick={()=>setOpen(false)}>Cancel</button><button className="btn primary" disabled={busy || confirm!==identifier} onClick={remove}>Remove product</button></div></dialog></>;
}
