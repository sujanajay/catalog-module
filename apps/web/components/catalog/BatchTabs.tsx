"use client";
import { useState, type KeyboardEvent, type ReactNode } from "react";

type TabsProps = {
  attentionCount: number;
  overview: ReactNode;
  attention: ReactNode;
  sheet: ReactNode;
  details: ReactNode;
};

export default function BatchTabs({ attentionCount, overview, attention, sheet, details }: TabsProps) {
  const [active, setActive] = useState("overview");
  const tabs = [
    { id: "overview", label: "Overview", body: overview },
    ...(attentionCount ? [{ id: "attention", label: `Needs attention (${attentionCount} products)`, body: attention }] : []),
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
    <>
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
    </>
  );
}
