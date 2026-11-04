"use client";
import { useEffect, useState } from "react";
import { localTime } from "@/components/ui";

/**
 * A date and time in the person's own time zone (UX section 7), such as "4 Nov 2026, 15:30 IST". The server does not
 * know the zone, so the first render (server and hydration) shows UTC, labelled "UTC"; the browser then switches to
 * its own zone. Renders nothing for a missing date.
 */
export default function LocalTime({ at }: { at: Date | string | null | undefined }) {
  const [zone, setZone] = useState("UTC");
  useEffect(() => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (own) setZone(own);
  }, []);
  const text = localTime(at, zone);
  if (!text) return null;
  return <time dateTime={new Date(at!).toISOString()}>{text}</time>;
}
