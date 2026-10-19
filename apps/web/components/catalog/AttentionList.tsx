"use client";
import { useEffect, useState } from "react";
import type { AttentionProduct } from "../../lib/catalog/products";
import AutoRefresh from "../AutoRefresh";
import AttentionProductCard, { type PhotoState } from "./AttentionProductCard";
import { useAttentionRemaining } from "./BatchTabs";

const POLL_MS = 120_000;

/**
 * The Needs attention tab (spec 07 4.7, spec 01 section 7). Cards stay on screen after the server
 * stops listing them so a finished card can show as "Resolved"; a photo is decided when this page
 * decided it or the latest server list no longer has it.
 */
export default function AttentionList({ items, canAct, channels }: { items: AttentionProduct[]; canAct: boolean; channels: string[] }) {
  const [seen, setSeen] = useState(() => items);
  const [states, setStates] = useState<Record<string, PhotoState>>({});
  const [polling, setPolling] = useState(false);
  const report = useAttentionRemaining();

  useEffect(() => {
    // Merge each server list into what is shown: new products, and new problem photos after a replacement.
    setSeen(old => {
      const next = [...old];
      for (const item of items) {
        const at = next.findIndex(p => p.productId === item.productId);
        if (at < 0) { next.push(item); continue; }
        const known = new Set(next[at]!.photos.map(p => p.outputId));
        const extra = item.photos.filter(p => !known.has(p.outputId));
        if (extra.length) next[at] = { ...item, photos: [...next[at]!.photos, ...extra] };
      }
      return next.sort((a, b) => a.identifier.localeCompare(b.identifier));
    });
  }, [items]);

  useEffect(() => {
    if (!polling) return;
    const t = setTimeout(() => setPolling(false), POLL_MS);
    return () => clearTimeout(t);
  }, [polling]);

  const open = new Set(items.flatMap(p => p.photos.map(photo => photo.outputId)));
  const stateOf = (outputId: string): PhotoState => states[outputId] ?? (open.has(outputId) ? "open" : "done");
  const unresolved = seen.filter(p => p.photos.some(photo => stateOf(photo.outputId) === "open")).length;
  useEffect(() => report(unresolved), [report, unresolved]);

  function decided(outputIds: string[], state: PhotoState) {
    setStates(old => ({ ...old, ...Object.fromEntries(outputIds.map(id => [id, state])) }));
    setPolling(true);
  }

  return (
    <>
      <p className="lead">Everything else is done and in the sheet. Only the products below have a problem, and only the photos with a problem are shown. Your decision is applied to the links sheet straight away.</p>
      <AutoRefresh active={polling} />
      <div className="att">
        {seen.map(item => <AttentionProductCard key={item.productId} item={item} canAct={canAct} channels={channels} stateOf={stateOf} onDecided={decided} />)}
      </div>
    </>
  );
}
