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

// --- Stored link rejects (spec 14b F5 part 1) ------------------------------------------------

/** Final statuses that may work on a second try. Every other status is permanent (404, 403, 410, ...). */
export const TEMPORARY_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/** A link reject read back from its stored sentence: the link, where it was, the phrase and whether a retry may help. */
export interface LinkReject {
  url: string;
  /** "row <r>, column <c>" (a paste: c is the cell number on the line) or "row <r>, column <header>" (a sheet); null when unknown. */
  where: string | null;
  phrase: LinkReasonPhrase;
  temporary: boolean;
}

// fetchSourceUrl's sentence: "[Row <r>, column <c>: ]<url> did not return an image (got <status, type or error>)."
const FETCH_REJECT = /^(?:Row (\d+), column (.+?): (?=\S+:\/\/))?(.+?) did not return an image \(got (.*)\)\.$/s;
const MIME = /^[\w.+-]+\/[\w.+-]+/;

/** The phrase and class of fetchSourceUrl's `got` part. */
function classifyGot(got: string): { phrase: LinkReasonPhrase; temporary: boolean } {
  if (/^\d{3}$/.test(got)) {
    const status = Number(got);
    return { phrase: statusReason(status), temporary: TEMPORARY_STATUSES.has(status) };
  }
  // A content type: an answer that is not an image. A web page says so; anything else could not be used.
  if (MIME.test(got) || got === "") return { phrase: /html/i.test(got) ? LINK_REASON.webPage : LINK_REASON.unreachable, temporary: false };
  if (got.startsWith("Only https links")) return { phrase: LINK_REASON.http, temporary: false };
  if (/took longer than/.test(got)) return { phrase: LINK_REASON.timeout, temporary: true };
  // Refused before any request (the SSRF checks) or by the answer itself: a second try gives the same.
  if (/^(Links to internal addresses|Links with a user name|Not a valid link)|redirected (more than|without)|is larger than/.test(got)) {
    return { phrase: LINK_REASON.unreachable, temporary: false };
  }
  // A network failure ("Could not download ...", "Could not find the server for ...").
  return { phrase: LINK_REASON.unreachable, temporary: true };
}

/**
 * Reads a stored reject sentence as a link failure, or null when the sentence is not one (a file
 * reject, a grouping reject). Link rejects are the sentences of fetchSourceUrl and any sentence that
 * starts with "Only https links".
 */
export function classifyLinkReject(reason: string): LinkReject | null {
  const m = FETCH_REJECT.exec(reason);
  if (m) {
    const [, row, column, url, got] = m;
    return { url: url!, where: row ? `row ${row}, column ${column}` : null, ...classifyGot(got!) };
  }
  if (reason.startsWith("Only https links")) {
    return { url: /:\s*(\S+?)\.?$/.exec(reason)?.[1] ?? "", where: null, phrase: LINK_REASON.http, temporary: false };
  }
  return null;
}

export const isLinkReject = (reason: string) => classifyLinkReject(reason) !== null;

const fmtCount = (n: number) => n.toLocaleString("en-US");

/** One line per reason phrase, most frequent first: "<count> <phrase>, for example <url> (<where>)." */
export interface LinkReasonGroup { reason: LinkReasonPhrase; count: number; first: { url: string; where: string } }

/** Groups link rejects by phrase (most first, then the phrase), keeping the first failure of each as the example. */
export function groupLinkRejects(rejects: LinkReject[]): LinkReasonGroup[] {
  const groups = new Map<LinkReasonPhrase, LinkReasonGroup>();
  for (const r of rejects) {
    const g = groups.get(r.phrase);
    if (g) g.count++;
    else groups.set(r.phrase, { reason: r.phrase, count: 1, first: { url: r.url, where: r.where ?? "" } });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** "<count> <reason phrase>, for example <url> (<where>)." (the where part is left out when unknown). */
export function reasonLine(g: LinkReasonGroup): string {
  return `${fmtCount(g.count)} ${g.reason}, for example ${g.first.url}${g.first.where ? ` (${g.first.where})` : ""}.`;
}

/** The ending of the links no-photos sentence when every failure is permanent (from release C, spec 14c F8: the batch is fixed in place). */
export const NO_LINK_PHOTOS_PERMANENT = "Check that the links open in a browser, then press Fix and continue and paste the corrected links.";
/** The ending when some failures may work on a second try (the retry button is shown with it). */
export const NO_LINK_PHOTOS_TEMPORARY = "Some of these may work on a second try. Press Try the failed links again.";

/**
 * counts.failReason when no link could be downloaded (spec 14b F5 part 1): "No photos could be
 * downloaded from the <n> links you <source>. <count> <reason phrase>, for example <url> (<where>)."
 * (one per reason) and the ending. `source` is "pasted" or "listed in <sheet>".
 */
export function noLinkPhotosReason(rejects: LinkReject[], links: number, source: string): string {
  const lines = groupLinkRejects(rejects).map(reasonLine);
  const ending = rejects.some((r) => r.temporary) ? NO_LINK_PHOTOS_TEMPORARY : NO_LINK_PHOTOS_PERMANENT;
  return `No photos could be downloaded from the ${fmtCount(links)} ${links === 1 ? "link" : "links"} you ${source}. ${lines.join(" ")} ${ending}`;
}
