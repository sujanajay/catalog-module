// M1-S5 (docs/program/requirements/M1-intake.md M1-F4, UX-design-system.md 5.3): one digest per finished batch instead
// of product cards. Built in the finalize step from buildReport's data and the batch's own outputs, from the same
// snapshot as the links sheet, so the digest's numbers equal the rows of its two new sheets: "Exceptions" (one row per
// product or photo with no link) and "Delivered with a note" (one row per image sent now with the best image we have).
// Until M2's gap report ships, the reasons come from the auto-decide causes and flags the pipeline already sets.
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatchProducts, catalogImprovements, catalogOutputs, catalogProducts } from "../db/schema";
import { autoDecideRecordOf } from "./auto-decide";
import { CHANNEL_ORDER, CHANNELS } from "./channels";
import type { BatchDigest, DigestReason } from "./digest-types";
import { STYLI_SKIP_NOTE } from "./evals/completeness";
import { IMPROVE_MAX_TRIES } from "./improve";
import { HOLDOUT_KEPT_NOTE, NO_DELIVERABLE_PHOTO } from "./pipeline/publish";
import type { SheetRow, SheetSpec } from "./sheet";
import type { ChannelId, HoldCause } from "./types";

export type { BatchDigest, DigestReason } from "./digest-types";

/** M1-F4-R3: reason lines the page shows; the rest are in the sheets. An admin setting once the M12 store has it (M1 D2). */
export const DIGEST_REASON_LINES = 10;
/** Grouped exception reasons kept in the stored digest (the 200 KB budget, M1-F4 non-functional). */
export const DIGEST_STORED_GROUPS = 50;
/** M1-F4-R2: provisional reasons kept, most common first. */
export const DIGEST_TOP_REASONS = 5;

/** A row of the Exceptions sheet: a product or a photo that gave no link, and what would fix it. */
export interface ExceptionRow { identifier: string; channel: ChannelId | null; image: number | null; reason: string; fix: string; group: string }
/** A row of the "Delivered with a note" sheet: an image sent now that may not be the best we can make. */
export interface NoteRow { identifier: string; channel: ChannelId; image: number; link: string; reason: string; rule: string; improves: boolean; better: string }

/** Why an image was sent with a note, by the auto-decide cause that sent it. */
const SENT_REASON: Record<HoldCause, string> = {
  not_enlarged: "not enlarged yet",
  unchecked: "not checked yet; it is checked later",
  unusable: "busy background in the photo, so the whole photo was used",
  photo_one: "a problem with the first image",
  every_photo: "every photo of the product had a problem",
  not_publishable: "did not meet our quality bar after the fixes we tried",
  code_fault: "made the plain way after a fault",
  wrong_item: "a different product may be in the photo",
  collage: "several photos in one",
  corrupt: "the photo file is damaged",
};
/** Why a photo was left out, by the auto-decide cause that dropped it. */
const LEFT_OUT_REASON: Record<HoldCause, string> = {
  wrong_item: "a different product in the photo",
  collage: "several photos in one",
  corrupt: "the photo file is damaged",
  not_enlarged: "the photo is too small and could not be enlarged",
  unchecked: "the image could not be checked",
  unusable: "the photo could not be used",
  photo_one: "the first image had a problem",
  every_photo: "every photo of the product had a problem",
  not_publishable: "the image did not meet the channel's rules",
  code_fault: "the image could not be made",
};
const LEFT_OUT_FIX: Partial<Record<HoldCause, string>> = {
  wrong_item: "Send a photo of this product in a new batch.",
  collage: "Send each view as its own photo in a new batch.",
  corrupt: "Send the photo file again in a new batch.",
  not_enlarged: "Send a larger photo in a new batch.",
};
const FIX_DEFAULT = "Send a better photo of this product in a new batch.";
const FIX_NOT_MADE = "Run this product again in a new batch.";
const FIX_PRODUCT = "Send usable photos of this product in a new batch.";
const FIX_FILE = "Send the file again in a new batch, as a photo or a working link.";
const NOT_MADE = "the image could not be made";
const TOO_SMALL = "the photo is smaller than this channel needs";

/** The sentence's first clause, short enough for one reason line. */
function shortReason(reason: string | null): string {
  const first = (reason ?? "").split(/[.;]\s/)[0]!.trim().replace(/\.$/, "");
  const text = first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first;
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : NOT_MADE;
}

/** Groups by text and counts, most common first, then by text (the same input always gives the same order). */
export function groupReasons(texts: readonly string[]): DigestReason[] {
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

const channelOrder = (c: ChannelId | null) => (c ? CHANNEL_ORDER.indexOf(c) : -1);
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface DigestInput {
  batch: { id: string; channels: ChannelId[]; status: string; startedAt: Date | null; updatedAt: Date };
  /** The links sheet of the same snapshot (buildReport): a slot with a link there is never an exception. */
  sheet: SheetSpec;
  /** Files that never became a photo of a product (buildReport's unsupportedFiles and linkFailures). */
  files: readonly unknown[];
  cost: { usd: number; inr: number | null; usdPerProduct: number | null; inrPerProduct: number | null };
}

export interface DigestParts { digest: BatchDigest; exceptions: ExceptionRow[]; notes: NoteRow[] }

/**
 * The digest and its two sheets for one batch, read in a fixed order (finalize builds it twice and compares). `linksReadyAt`
 * is left null here: finalize sets it in its done write, keeping the first one.
 */
export async function buildDigest(db: Db, input: DigestInput): Promise<DigestParts> {
  const batchId = input.batch.id, channels = input.batch.channels;
  const pairs = await db.select({ productId: catalogBatchProducts.productId, change: catalogBatchProducts.change, notes: catalogBatchProducts.notes, identifier: catalogProducts.identifier })
    .from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, batchId))
    .orderBy(asc(catalogProducts.identifier), asc(catalogProducts.id));
  const outputs = await db.select({ productId: catalogOutputs.productId, sourceImageId: catalogOutputs.sourceImageId, channel: catalogOutputs.channel, n: catalogOutputs.n, status: catalogOutputs.status, isLive: catalogOutputs.isLive,
    flags: catalogOutputs.flags, reason: catalogOutputs.reason, decision: catalogOutputs.decision, compliance: catalogOutputs.compliance, publicUrl: catalogOutputs.publicUrl, publishedAt: catalogOutputs.publishedAt })
    .from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId)).orderBy(asc(catalogOutputs.productId), asc(catalogOutputs.channel), asc(catalogOutputs.n), asc(catalogOutputs.id));
  const improvements = await db.select({ sourceImageId: catalogImprovements.sourceImageId, improvedAt: catalogImprovements.improvedAt, tries: catalogImprovements.tries, endReason: catalogImprovements.endReason })
    .from(catalogImprovements).where(eq(catalogImprovements.batchId, batchId)).orderBy(asc(catalogImprovements.sourceImageId));
  const improvementOf = new Map(improvements.map(i => [i.sourceImageId, i]));
  const rowOf = new Map<string, SheetRow>();
  for (const row of input.sheet.rows) if (!rowOf.has(row.identifier)) rowOf.set(row.identifier, row);
  const linkAt = (identifier: string, channel: ChannelId, n: number) => !!rowOf.get(identifier)?.links[channel]?.[n - 1] && rowOf.get(identifier)?.status !== "missing_images";
  const hasLink = (identifier: string) => channels.some(c => (rowOf.get(identifier)?.links[c] ?? []).some(Boolean)) && rowOf.get(identifier)?.status !== "missing_images";
  const outputsOf = new Map<string, typeof outputs>();
  for (const o of outputs) { const list = outputsOf.get(o.productId); if (list) list.push(o); else outputsOf.set(o.productId, [o]); }

  const exceptions: ExceptionRow[] = [], notes: NoteRow[] = [], leftOut: { key: string; reason: string }[] = [];
  let needsYou = 0, controlsSkipped = 0, stayedAsSent = 0, completeEveryChannel = 0, productsWithLinks = 0;
  for (const pair of pairs) {
    const mine = (outputsOf.get(pair.productId) ?? []).filter(o => channels.includes(o.channel));
    const withLinks = hasLink(pair.identifier);
    if (withLinks) productsWithLinks++;
    if (mine.some(o => o.reason?.includes(HOLDOUT_KEPT_NOTE))) controlsSkipped++;
    // A product held for a person (a batch started before auto-decide) is counted under "Needs you", not as exceptions.
    if (pair.change === "pending_attention") { needsYou++; continue; }
    let productExceptions = 0, productNotes = 0;
    if (pair.change === "failed" || (!withLinks && pair.change !== "unchanged")) {
      const reason = pair.notes?.split("; ")[0] || NO_DELIVERABLE_PHOTO;
      exceptions.push({ identifier: pair.identifier, channel: null, image: null, reason, fix: FIX_PRODUCT, group: `No image on any channel: ${shortReason(reason)}` });
      for (const o of mine) if (o.flags.includes("auto_dropped")) leftOut.push({ key: o.sourceImageId, reason: leftOutReason(o) });
      continue;
    }
    for (const o of mine) {
      if (o.status === "verified" && o.isLive && o.flags.includes("provisional")) {
        const record = autoDecideRecordOf(o.compliance);
        const cause = record?.cause ?? "not_publishable";
        const improvement = improvementOf.get(o.sourceImageId);
        const improves = cause === "not_enlarged" && !!improvement && !improvement.improvedAt && !improvement.endReason && improvement.tries < IMPROVE_MAX_TRIES;
        // M1-F3-R5 (M1 D11): every try used, or the re-made image did not pass: it stays as sent.
        if (improvement && !improvement.improvedAt && (improvement.tries >= IMPROVE_MAX_TRIES || improvement.endReason === "not_passed")) stayedAsSent++;
        notes.push({ identifier: pair.identifier, channel: o.channel, image: o.n, link: o.publicUrl, reason: SENT_REASON[cause], rule: record?.rule ?? "", improves,
          better: improves ? "A larger version replaces it at the same link when the enlargement works. Nothing to do."
            : cause === "not_enlarged" ? "We could not enlarge it. Send a larger photo in a new batch."
              : "Send a better photo in a new batch to replace it." });
        productNotes++;
        continue;
      }
      if (o.status !== "skipped" && o.status !== "failed" && o.status !== "needs_attention") continue;
      // Left out on purpose, or replaced by a later image of the same slot: not an exception.
      if (o.decision === "remove" || o.decision === "replaced" || o.reason?.includes(HOLDOUT_KEPT_NOTE) || o.reason?.startsWith("Removed in batch")) continue;
      if (linkAt(pair.identifier, o.channel, o.n)) continue;
      const why = o.flags.includes("auto_dropped") ? leftOutReason(o) : o.reason?.includes(STYLI_SKIP_NOTE) ? TOO_SMALL : shortReason(o.reason);
      const cause = autoDecideRecordOf(o.compliance)?.cause;
      exceptions.push({ identifier: pair.identifier, channel: o.channel, image: o.n, reason: o.reason ?? why, fix: o.status === "failed" ? FIX_NOT_MADE : why === TOO_SMALL ? "Send a larger photo in a new batch." : (cause && LEFT_OUT_FIX[cause]) ?? FIX_DEFAULT,
        group: `${CHANNELS[o.channel].label} image ${o.n} missing: ${why}` });
      if (o.flags.includes("auto_dropped")) leftOut.push({ key: o.sourceImageId, reason: why });
      productExceptions++;
    }
    if (withLinks && !productExceptions && !productNotes && channels.every(c => (rowOf.get(pair.identifier)?.links[c] ?? []).some(Boolean))) completeEveryChannel++;
  }
  // Files that never became a photo of a product (unreadable files, links that could not be opened).
  for (const file of input.files) {
    const f = (file ?? {}) as { name?: unknown; originalName?: unknown; identifier?: unknown; url?: unknown; reason?: unknown };
    const name = String(f.name ?? f.originalName ?? f.url ?? f.identifier ?? "file");
    const reason = typeof f.reason === "string" && f.reason ? f.reason : "This file could not be read.";
    exceptions.push({ identifier: name, channel: null, image: null, reason, fix: FIX_FILE, group: `File not used: ${shortReason(reason)}` });
    leftOut.push({ key: `file:${name}`, reason: shortReason(reason) });
  }
  exceptions.sort((a, b) => collator.compare(a.identifier, b.identifier) || channelOrder(a.channel) - channelOrder(b.channel) || (a.image ?? 0) - (b.image ?? 0));
  notes.sort((a, b) => collator.compare(a.identifier, b.identifier) || channelOrder(a.channel) - channelOrder(b.channel) || a.image - b.image);

  // One photo left out on several channels counts once, under its first reason.
  const photoReasons = new Map<string, string>();
  for (const l of leftOut) if (!photoReasons.has(l.key)) photoReasons.set(l.key, l.reason);
  const grouped = groupReasons(exceptions.map(e => e.group));
  const stored = grouped.slice(0, DIGEST_STORED_GROUPS);
  const firstLinks = outputs.flatMap(o => o.publishedAt ? [+o.publishedAt] : []);
  const linksPerChannel = CHANNEL_ORDER.filter(c => channels.includes(c)).map(channel => ({ channel, links: input.sheet.rows.reduce((n, r) => n + (r.status === "missing_images" ? 0 : (r.links[channel] ?? []).filter(Boolean).length), 0) }));
  const digest: BatchDigest = {
    version: 1,
    products: pairs.length,
    productsWithLinks,
    completeEveryChannel,
    linksPerChannel,
    provisionalLinks: notes.length,
    provisionalReasons: groupReasons(notes.map(n => n.reason)).slice(0, DIGEST_TOP_REASONS),
    improving: notes.filter(n => n.improves).length,
    stayedAsSent,
    photosLeftOut: photoReasons.size,
    leftOutReasons: groupReasons([...photoReasons.values()]),
    exceptions: exceptions.length,
    exceptionReasons: stored,
    exceptionsNotGrouped: grouped.slice(DIGEST_STORED_GROUPS).reduce((n, g) => n + g.count, 0),
    controlsSkipped,
    needsYou,
    startedAt: input.batch.startedAt ? input.batch.startedAt.toISOString() : null,
    firstLinksAt: firstLinks.length ? new Date(Math.min(...firstLinks)).toISOString() : null,
    linksReadyAt: null,
    cancelledAt: input.batch.status === "cancelled" ? input.batch.updatedAt.toISOString() : null,
    cost: input.cost,
  };
  return { digest, exceptions, notes };
}

function leftOutReason(o: { compliance: unknown; reason: string | null }): string {
  const cause = autoDecideRecordOf(o.compliance)?.cause;
  return cause ? LEFT_OUT_REASON[cause] : shortReason(o.reason);
}
