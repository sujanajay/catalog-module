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

type TabsProps = {
  attentionCount: number;
  /** Eval mode: the tab is always shown with this label (spec 07 4.10). */
  evalLabel?: string;
  initialTab?: string;
  overview: ReactNode;
  attention: ReactNode;
  sheet: ReactNode;
  details: ReactNode;
};

export default function BatchTabs({ attentionCount, evalLabel, initialTab, overview, attention, sheet, details }: TabsProps) {
  const [active, setActive] = useState(initialTab ?? "overview");
  const [remaining, setRemaining] = useState<number | null>(null);
  const tabs = [
    { id: "overview", label: "Overview", body: overview },
    ...(evalLabel || attentionCount ? [{ id: "attention", label: evalLabel ?? attentionLabel(remaining ?? attentionCount), body: attention }] : []),
    { id: "sheet", label: "Links sheet", body: sheet },
    { id: "details", label: "Details", body: details },
  ];
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
    setActive(tab.id);
    document.getElementById(`tab-${tab.id}`)?.focus();
  }

  return (
    <AttentionRemaining value={setRemaining}>
      <div className="tabs" role="tablist" aria-label="Batch sections">
        {tabs.map((tab, index) => (
          <button key={tab.id} id={`tab-${tab.id}`} role="tab" aria-selected={selected === tab.id}
            aria-controls={`panel-${tab.id}`} tabIndex={selected === tab.id ? 0 : -1}
            className={selected === tab.id ? "on" : ""} onClick={() => setActive(tab.id)}
            onKeyDown={event => navigate(event, index)}>{tab.label}</button>
        ))}
      </div>
      {tabs.map(tab => (
        <section key={tab.id} id={`panel-${tab.id}`} role="tabpanel" tabIndex={0}
          aria-labelledby={`tab-${tab.id}`} hidden={selected !== tab.id}>{tab.body}</section>
      ))}
    </AttentionRemaining>
  );
}
