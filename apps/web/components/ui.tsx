// Small display primitives shared by the catalog pages.
import type { ReactNode } from "react";
import { STATUS_WORDS, statusTone, type StatusIcon, type StatusKey } from "@catalog/core/catalog/status-words";

const ICONS: Record<StatusIcon, ReactNode> = {
  progress: <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="17 18" />,
  tick: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  dot: <circle cx="8" cy="8" r="3.5" fill="currentColor" />,
  alert: <path d="M8 3.5v5.5M8 12v.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
  pause: <path d="M5.5 4v8M10.5 4v8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
};

/**
 * A status word from the vocabulary (UX section 4): icon, colour and word, with the word's meaning as its title.
 * The icon is decoration; the word carries the meaning, so colour is never the only signal.
 */
export function StatusWord({ status, blocking }: { status: StatusKey; blocking?: boolean }) {
  const spec = STATUS_WORDS[status];
  return (
    <span className={`status-word ${statusTone(status, { blocking })}`} title={spec.meaning}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">{ICONS[spec.icon]}</svg>
      <span>{spec.word}</span>
    </span>
  );
}

export function usd(n: number | string | null | undefined, digits = 2): string {
  const v = Number(n ?? 0);
  return `$${v.toFixed(v !== 0 && Math.abs(v) < 0.1 ? Math.max(digits, 3) : digits)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The zone names operators know (UX section 7: "GST" or "IST"); any other zone shows its offset, such as "GMT+3". */
const ZONE_NAMES: Record<string, string> = { "Asia/Kolkata": "IST", "Asia/Calcutta": "IST", "Asia/Dubai": "GST", "Asia/Muscat": "GST" };

/**
 * A date and time in the given time zone, as UX section 7 writes it: "4 Nov 2026, 15:30 IST" (day month year, 24-hour
 * time, zone name). Empty for a missing or unreadable date. Pages show it through LocalTime, which picks the person's zone.
 */
export function localTime(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date).map(p => [p.type, p.value]));
  const zone = ZONE_NAMES[timeZone] ?? (/^(UTC|Etc\/UTC|Etc\/GMT|GMT)$/.test(timeZone) ? "UTC" : parts.timeZoneName);
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} ${zone}`;
}
