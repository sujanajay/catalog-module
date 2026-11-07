// M1-S5 and UX4 (UX-design-system.md 5.3 and 6): the digest's words, the same on the batch page and in the digest email.
// Counts and reasons in plain words; products are never listed one by one (the sheets do that).
import { inrAmount, usdAmount } from "./cost";
import { DIGEST_REASON_LINES, type BatchDigest } from "./digest";
import { leftOutWords } from "./pipeline/status";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The one-sentence headline (5.3 item 1). It never says "failed" for a batch that produced links. */
export function digestHeadline(d: BatchDigest): string {
  // Never "all done" while anything is out: whatever was left out is said here too, in one sentence.
  const words = leftOutWords(d), out = words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}; the Exceptions sheet says why.` : "";
  const without = Math.max(0, d.products - d.productsWithLinks - d.needsYou - (d.productsLeftOut ?? 0));
  if (d.products === 0) return ["This batch had no products.", out].filter(Boolean).join(" ");
  if (d.productsWithLinks === d.products) return [d.products === 1 ? "The product has links." : `All ${n(d.products)} products have links.`, out].filter(Boolean).join(" ");
  const parts = [`${n(d.productsWithLinks)} of ${n(d.products)} products have links.`];
  if (without) parts.push(`${n(without)} ${plural(without, "does not", "do not")}; the Exceptions sheet says why.`);
  if (out) parts.push(out);
  if (d.needsYou) parts.push(`${n(d.needsYou)} ${plural(d.needsYou, "needs you", "need you")}.`);
  return parts.join(" ");
}

export interface DigestTile { label: string; value: string; meaning: string }
/** The four number tiles (5.3 item 2), each with its meaning under the number. */
export function digestTiles(d: BatchDigest): DigestTile[] {
  return [
    { label: "Products with links", value: `${n(d.productsWithLinks)} of ${n(d.products)}`, meaning: "Products with at least one image link in the sheet." },
    { label: "Complete for every channel", value: n(d.completeEveryChannel), meaning: "Every image made and sent, with nothing left out." },
    { label: "Improving by itself", value: n(d.improving), meaning: "Better images are on the way at the same links. Nothing to do." },
    { label: "Need you", value: n(d.needsYou), meaning: d.needsYou ? "Products a person has to decide on." : leftOutWords(d) ? "Nothing to decide here. What was left out is explained above." : "Nothing needs you." },
  ];
}

const reasonList = (reasons: BatchDigest["provisionalReasons"]) => reasons.map(r => `${r.text} (${n(r.count)})`).join(", ");

/** Everything left out of the batch, always shown (never cut by the reason line limit). Null when nothing was. */
export function digestLeftOutLine(d: BatchDigest): string | null {
  const k = d.productsLeftOut ?? 0, files = d.filesLeftOut ?? 0, uploads = d.uploadsNotRead ?? 0;
  if (!k && !files && !uploads) return null;
  return [
    ...(k ? [`${n(k)} ${plural(k, "product was", "products were")} left out of this batch: ${reasonList(d.productsLeftOutReasons ?? [])}. Any links ${plural(k, "it", "they")} already had stay as they were.`] : []),
    ...(uploads ? [`${n(uploads)} ${plural(uploads, "upload", "uploads")} could not be read, so what ${plural(uploads, "it holds is", "they hold is")} not in this batch.`] : []),
    ...(files ? [`${n(files)} ${plural(files, "file was", "files were")} not used.`] : []),
    "The Exceptions sheet names each one and what to do.",
  ].join(" ");
}

/**
 * The reason lines (5.3 item 4, M1-F4-R3): what was sent with a note and why, what was left out and why, then the
 * Exceptions groups, most common first, at most `max` lines. `more` counts the groups that did not fit; they are in the
 * Exceptions sheet.
 */
export function digestReasonLines(d: BatchDigest, max: number = DIGEST_REASON_LINES): { lines: string[]; more: number } {
  const lines: string[] = [];
  if (d.provisionalLinks) lines.push(`${n(d.provisionalLinks)} ${plural(d.provisionalLinks, "image was", "images were")} sent with the best image we have. Main reasons: ${reasonList(d.provisionalReasons)}.`);
  if (d.improving) lines.push(`${n(d.improving)} of these will improve by themselves at the same link.`);
  if (d.stayedAsSent) lines.push(`${n(d.stayedAsSent)} could not be made better and stay as sent.`);
  if (d.deliveredUnjudged) lines.push(`${n(d.deliveredUnjudged)} ${plural(d.deliveredUnjudged, "image was", "images were")} delivered without our automatic quality check.`);
  if (d.photosLeftOut) lines.push(`${n(d.photosLeftOut)} ${plural(d.photosLeftOut, "photo was", "photos were")} left out: ${reasonList(d.leftOutReasons)}. See the Exceptions sheet.`);
  if (d.controlsSkipped) lines.push(`${n(d.controlsSkipped)} ${plural(d.controlsSkipped, "product is", "products are")} in a running experiment. Their images on those channels were left unchanged on purpose.`);
  // M1-F5-R3: the digest says "unchanged: N". Older stored digests have no count.
  if (d.unchanged) lines.push(`Unchanged: ${n(d.unchanged)} ${plural(d.unchanged, "product was", "products were")} the same as before, so no new image was made and their links stay the same.`);
  if (d.photosUnderSeveralProducts) lines.push(`${n(d.photosUnderSeveralProducts)} ${plural(d.photosUnderSeveralProducts, "photo is", "photos are")} under more than one product name. Nothing was merged; the Exceptions sheet names them so you can check.`);
  if (d.sameFilesMerged) lines.push(`${n(d.sameFilesMerged)} ${plural(d.sameFilesMerged, "file was a copy", "files were copies")} of a photo already in the batch, so one of each was used.`);
  const groups = d.exceptionReasons.map(g => `${g.text} - ${n(g.count)}`);
  const room = Math.max(0, max - lines.length);
  const more = Math.max(0, groups.length - room) + (d.exceptionsNotGrouped ? 1 : 0);
  return { lines: [...lines, ...groups.slice(0, room)].slice(0, max), more };
}

/** "4 min", "1 h 6 min" or "under a minute". */
export function duration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** "Time to first links 4 min, to all links 46 min." or null before the batch started. */
export function digestTimeLine(d: BatchDigest): string | null {
  if (!d.startedAt) return null;
  const start = +new Date(d.startedAt), parts: string[] = [];
  if (d.firstLinksAt) parts.push(`to first links ${duration(+new Date(d.firstLinksAt) - start)}`);
  if (d.linksReadyAt) parts.push(`to all links ${duration(+new Date(d.linksReadyAt) - start)}`);
  return parts.length ? `Time ${parts.join(", ")}.` : null;
}

/**
 * "Cost: INR 9.20 per product (INR 18,400.00 for this batch)." with USD when no rupee rate is set. A recorded cost (R1
 * exit item 4) says the idle time comes later; the true cost says it holds it.
 */
export function digestCostLine(d: BatchDigest): string | null {
  const c = d.cost;
  // R1 exit item 4: only a final figure reads as the batch's cost; before that it says it is not final.
  const lead = c.basis === "recorded" ? "Cost so far (not final)" : c.basis === "provisional" ? "Cost (not final)" : "Cost";
  const after = c.basis === "recorded" ? " Idle machine time is added by the daily cost check."
    : c.basis === "provisional" ? " This includes idle machine time and the shared database, and can still change for two days."
    : c.basis === "true" ? " This includes idle machine time and the shared database." : "";
  if (c.inrPerProduct !== null && c.inr !== null) return `${lead}: INR ${inrAmount(c.inrPerProduct)} per product (INR ${inrAmount(c.inr)} for this batch).${after}`;
  if (c.usdPerProduct !== null) return `${lead}: USD ${usdAmount(c.usdPerProduct)} per product (USD ${usdAmount(c.usd)} for this batch).${after}`;
  return null;
}

/**
 * The digest email (UX 5.3 "the same content as one email", 6 "Batch links ready"): one email per batch to the person who
 * uploaded it. Built here; sending waits for the notification settings (M1 open question: email is P1).
 */
export function digestEmail(batch: { name: string; url: string }, d: BatchDigest): { subject: string; text: string } {
  const ready = d.productsWithLinks === d.products ? `links are ready for all ${n(d.products)} products` : `links are ready for ${n(d.productsWithLinks)} of ${n(d.products)} products`;
  const words = leftOutWords(d);
  const needs = d.needsYou ? `${n(d.needsYou)} ${plural(d.needsYou, "product needs", "products need")} you.` : words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : "Nothing needs you.";
  const reasons = digestReasonLines(d);
  const text = [
    digestHeadline(d), needs, ...[digestLeftOutLine(d)].filter((line): line is string => !!line), "",
    ...digestTiles(d).map(t => `${t.label}: ${t.value}`), "",
    ...reasons.lines, ...(reasons.more ? [`More reasons are in the Exceptions sheet.`] : []), "",
    ...[digestCostLine(d), digestTimeLine(d)].filter((line): line is string => !!line),
    `Open the batch: ${batch.url}`,
  ].join("\n");
  return { subject: `${batch.name}: ${ready}. ${needs}`, text };
}
