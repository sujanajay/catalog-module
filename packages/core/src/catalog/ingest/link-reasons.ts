// The reason phrases for links that could not be downloaded (spec 14 copy register, "Reason
// phrases"; spec 14b F5). They read after a count ("3 answered 'not found' (404)") and after the
// paste readback's "<ok> of <tried> opened;". The paste readback (F2) picks one from a peek's
// answer; F5 classifies stored reasons into the same phrases.

export const LINK_REASON = {
  notFound: "answered 'not found' (404)",
  refused: "were refused (403)",
  timeout: "did not answer in time",
  webPage: "returned a web page instead of an image",
  http: "use http instead of https",
  unreachable: "could not be reached",
} as const;

export type LinkReasonPhrase = (typeof LINK_REASON)[keyof typeof LINK_REASON];

/** The phrase for a final HTTP status that is not a success (404, 403, 408 and 504 by name; others unreachable). */
export function statusReason(status: number): LinkReasonPhrase {
  if (status === 404) return LINK_REASON.notFound;
  if (status === 403) return LINK_REASON.refused;
  if (status === 408 || status === 504) return LINK_REASON.timeout;
  return LINK_REASON.unreachable;
}

/** The phrase for an error thrown before any answer (an unsafe link, a timeout, a network failure). */
export function errorReason(err: unknown): LinkReasonPhrase {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("Only https links")) return LINK_REASON.http;
  if (/took longer than/.test(message) || (err as { name?: string } | null)?.name === "TimeoutError") return LINK_REASON.timeout;
  return LINK_REASON.unreachable;
}
