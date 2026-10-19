"use client";
// "Try again" for a collecting batch that stalled (deriveBatchState's `stalled`): re-runs the
// ingest hand-off through POST /ingest, which is idempotent, then reloads the page data.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, SessionEndedError } from "@/lib/fetch";
import { useToast } from "@/components/Toast";
export default function RetryCollectButton({ batchId, onDone }: { batchId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  async function retry() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/catalog/batches/${batchId}/ingest`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast("Collecting files again.");
      onDone?.();
      router.refresh();
    } catch (err) {
      if (!(err instanceof SessionEndedError)) toast(err instanceof Error && err.message ? err.message : "The upload could not be handed to processing. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return <button type="button" className="btn primary" disabled={busy} onClick={() => void retry()}>{busy ? "Please wait..." : "Try again"}</button>;
}
