"use client";
import { createContext, useContext, useState, type KeyboardEvent, type ReactNode } from "react";

// The attention list reports how many products still need a decision so the tab label counts down
// as cards resolve (spec 07 4.7), without waiting for the next server render.
const AttentionRemaining = createContext<(remaining: number) => void>(() => {});
export function useAttentionRemaining(): (remaining: number) => void {
  return useContext(AttentionRemaining);
}

export function attentionLabel(n: number): string {
  return `Needs attention (${n} ${n === 1 ? "product" : "products"})`;
}

/**
 * The attention tab shows while something needs a decision, and also while the operator is on it, so
 * the last card can turn into "Resolved · <identifier> · Sheet updated." instead of the tab vanishing
 * and the view jumping to Overview (spec 07 4.7). Once they leave it at 0 it goes, as spec 01 says.
 */
export function showAttentionTab(input: { evalMode: boolean; remaining: number; active: string }): boolean {
  return input.evalMode || input.remaining > 0 || input.active === "attention";
}

type TabsProps = {
  attentionCount: number;
  /** Eval mode: the tab is always shown with this label (spec 07 4.10). */
  evalLabel?: string;
  initialTab?: string;
  overview: ReactNode;
  attention: ReactNode;
  /** "Compare images": every photo next to what was made for each channel. Absent on older callers. */
  compare?: ReactNode;
  /**
   * Set while the comparison is not loaded on this render (it signs a page of images, so it loads only
   * when asked for): choosing the tab opens this link, which renders the page with the comparison.
   */
  compareHref?: string;
  sheet: ReactNode;
  details: ReactNode;
};

export default function BatchTabs({ attentionCount, evalLabel, initialTab, overview, attention, compare, compareHref, sheet, details }: TabsProps) {
  const [active, setActive] = useState(initialTab ?? "overview");
  const [remaining, setRemaining] = useState<number | null>(null);
  // Once the batch had something to decide, the attention panel stays mounted (hidden when its tab is
  // gone) so its resolved cards and its refresh after a decision survive a server re-render.
  const [hadAttention, setHadAttention] = useState(attentionCount > 0);
  if (attentionCount > 0 && !hadAttention) setHadAttention(true);
  const count = remaining ?? attentionCount;
  const attentionTab = showAttentionTab({ evalMode: !!evalLabel, remaining: count, active });
  const panels = [
    { id: "overview", label: "Overview", body: overview },
    ...(evalLabel || attentionCount || hadAttention || attentionTab ? [{ id: "attention", label: evalLabel ?? attentionLabel(count), body: attention }] : []),
    ...(compare !== undefined ? [{ id: "compare", label: "Compare images", body: compare }] : []),
    { id: "sheet", label: "Links sheet", body: sheet },
    { id: "details", label: "Details", body: details },
  ];
  const tabs = panels.filter(t => t.id !== "attention" || attentionTab);
  const selected = tabs.some(t => t.id === active) ? active : "overview";

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next]!;
    choose(tab.id);
    document.getElementById(`tab-${tab.id}`)?.focus();
  }

  function choose(id: string) {
    setActive(id);
    if (id === "compare" && compareHref) window.location.assign(compareHref);
  }

  return (
    <AttentionRemaining value={setRemaining}>
      <div className="tabs" role="tablist" aria-label="Batch sections">
        {tabs.map((tab, index) => (
          <button key={tab.id} id={`tab-${tab.id}`} role="tab" aria-selected={selected === tab.id}
            aria-controls={`panel-${tab.id}`} tabIndex={selected === tab.id ? 0 : -1}
            className={selected === tab.id ? "on" : ""} onClick={() => choose(tab.id)}
            onKeyDown={event => navigate(event, index)}>{tab.label}</button>
        ))}
      </div>
      {panels.map(tab => (
        <section key={tab.id} id={`panel-${tab.id}`} role="tabpanel" tabIndex={0}
          aria-labelledby={`tab-${tab.id}`} hidden={selected !== tab.id}>{tab.body}</section>
      ))}
    </AttentionRemaining>
  );
}
