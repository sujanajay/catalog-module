"use client";
// M1-F5-R2 (M1-S6): "Add more photos" on a batch that has started. POST /extend answers its linked follow-up batch
// (same brand, channels and grouping); the New batch page opens on it, and once its files are collected it starts by
// itself. Photos of products this batch is still making wait for it to finish, then go.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, SessionEndedError } from "@/lib/fetch";
import { useToast } from "@/components/Toast";
import { ADD_MORE_PHOTOS, continueSettingUpHref } from "@/lib/catalog/copy";
export default function AddMorePhotosButton({ batchId }: { batchId: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  async function add() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/catalog/batches/${batchId}/extend`, { method: "POST" });
      const data = await res.json() as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error);
      router.push(continueSettingUpHref(data.id));
    } catch (err) {
      if (!(err instanceof SessionEndedError)) toast(err instanceof Error && err.message ? err.message : "This did not finish. Try again.");
      setBusy(false);
    }
  }
  return <button type="button" className="btn ghost" disabled={busy} onClick={() => void add()}>{busy ? "Please wait..." : ADD_MORE_PHOTOS}</button>;
}
