"use client";
// The error boundary for every page under /catalog (spec 14a F1): a crash shows a plain page with a way
// back instead of a blank screen. Next.js 15 passes `error` and `reset`; `reset` re-renders the segment.
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import CatalogError, { batchLinkFor } from "@/components/catalog/CatalogError";

export default function CatalogErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    // The digest ties this browser error to the server log line; the message itself is never shown.
    console.error("catalog page error", error.digest ?? error.message);
  }, [error]);
  return <CatalogError batchHref={batchLinkFor(pathname ?? "", searchParams?.get("batch") ?? null)} reset={reset} />;
}
