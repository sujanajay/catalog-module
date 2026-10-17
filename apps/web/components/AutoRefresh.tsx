"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page every `ms` while `active`. */
export default function AutoRefresh({ active, ms = 5000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return active ? (
    <span className="muted small">
      <span className="spinner" /> auto-refreshing every {Math.round(ms / 1000)}s
    </span>
  ) : null;
}
