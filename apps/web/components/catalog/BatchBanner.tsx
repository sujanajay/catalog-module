"use client";
import { useEffect, useState } from "react";
import { deriveBatchState } from "@catalog/core/catalog/pipeline/status";
import type { BatchCounts, BatchStatus } from "@catalog/core/catalog/types";
export default function BatchBanner({status, counts, source}: {status:BatchStatus;counts:BatchCounts;source?:string}) {
  const [samples, setSamples] = useState<{at:Date;made:number}[]>([]);
  const made = counts.verified + counts.needsAttention + counts.failed + counts.skipped + counts.unchanged;
  const processing = ["matting", "rendering", "qa", "publishing"].includes(status);
  useEffect(() => {
    if (!processing) return;
    const now = new Date();
    setSamples(previous => [...previous.filter(s => now.getTime() - s.at.getTime() <= 300_000), {at:now,made}]);
  }, [made, processing]);
  const state = deriveBatchState({status, counts, source, samples});
  const tone = state.state === "ready" ? "ok" : state.state === "failed" ? "bad" : ["attention","recheck_failed"].includes(state.state) ? "warn" : "run";
  return <div className="banner" role="status"><span className={`pill ${tone}`}>{state.pill}</span>{state.state === "processing" && <progress aria-label="Images made" value={state.made} max={Math.max(1,state.total)} />}<span>{state.text}</span></div>;
}
