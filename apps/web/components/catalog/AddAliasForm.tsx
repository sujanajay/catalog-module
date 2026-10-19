"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, SessionEndedError } from "@/lib/fetch";
import { useToast } from "@/components/Toast";
export default function AddAliasForm({id,identifier}:{id:string;identifier:string}) {
 const [alias,setAlias]=useState(""); const [busy,setBusy]=useState(false); const toast=useToast(); const router=useRouter();
 async function submit(e:FormEvent) { e.preventDefault(); setBusy(true); try { const res=await apiFetch(`/api/catalog/products/${id}/aliases`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({alias})}); const data=await res.json(); if(!res.ok) throw new Error(data.error); toast(`${alias.trim()} now points to ${identifier}.`); setAlias(""); router.refresh(); } catch(err) { if(!(err instanceof SessionEndedError)) toast(err instanceof Error ? err.message : "Could not add the alias. Try again."); } finally {setBusy(false);} }
 return <form className="alias-form" onSubmit={submit}><label htmlFor="alias">Add alias</label><input id="alias" type="text" value={alias} onChange={e=>setAlias(e.target.value)} disabled={busy}/><button className="btn ghost" disabled={busy || !alias.trim()}>Add alias</button></form>;
}
