// M1-S5 (docs/program/requirements/M1-intake.md M1-F4, UX-design-system.md 5.3): one digest per finished batch instead
// of product cards. Built in the finalize step from buildReport's data and the batch's own outputs, from the same
// snapshot as the links sheet, so the digest's numbers equal the rows of its two new sheets: "Exceptions" (one row per
// product or photo with no link) and "Delivered with a note" (one row per image sent now with the best image we have).
// Until M2's gap report ships, the reasons come from the auto-decide causes and flags the pipeline already sets.
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatchProducts, catalogImprovements, catalogOutputs, catalogProducts } from "../db/schema";
import { autoDecideRecordOf, heldForPerson } from "./auto-decide";
import { CHANNEL_ORDER, CHANNELS } from "./channels";
import { batchCostFigure, type BatchCostFigure } from "./cost-report";
import type { BatchDigest, DigestCost, DigestReason } from "./digest-types";
import { LEFT_OUT_WORDS, type SharedPhotos } from "./ingest/group";
import type { LeftOutProduct } from "./ingest/types";
import { normalizeKey } from "./naming";
import { STYLI_SKIP_NOTE } from "./evals/completeness";
import { enlargementOutlooks, IMPROVE_MAX_TRIES } from "./improve";
import { APPEND_TAKEN_NOTE, HOLDOUT_KEPT_NOTE, NO_DELIVERABLE_PHOTO } from "./pipeline/publish";
import type { SheetRow, SheetSpec } from "./sheet";
import type { ChannelId, HoldCause } from "./types";
import { minOf } from "../arrays";

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
  unchecked: "not checked: our quality check could not run",
  unusable: "busy background in the photo, so the whole photo was used",
  photo_one: "a problem with the first image",
  every_photo: "every photo of the product had a problem",
  not_publishable: "did not meet our quality bar after the fixes we tried",
  code_fault: "made the plain way after a fault",
  wrong_item: "a different product may be in the photo",
  collage: "several photos in one",
  corrupt: "the photo file is damaged",
  visible_defect: "a visible problem on the image",
};
/** Why a photo was left out, by the auto-decide cause that dropped it. */
const LEFT_OUT_REASON: Record<HoldCause, string> = {
  wrong_item: "a different product in the photo",
  collage: "several photos in one",
  corrupt: "the photo file is damaged",
  not_enlarged: "the photo could not be enlarged",
  unchecked: "the image could not be checked",
  unusable: "the photo could not be used",
  photo_one: "the first image had a problem",
  every_photo: "every photo of the product had a problem",
  not_publishable: "the image did not meet the channel's rules",
  code_fault: "the image could not be made",
  visible_defect: "a visible problem on the image",
};
const LEFT_OUT_FIX: Partial<Record<HoldCause, string>> = {
  wrong_item: "Send a photo of this product in a new batch.",
  collage: "Send each view as its own photo in a new batch.",
  corrupt: "Send the photo file again in a new batch.",
  not_enlarged: "Send a larger photo in a new batch.",
};
// Spec 18 route `none`: a size refusal, the same on every try, and a larger photo makes it worse. A closer photo needs less enlarging.
const SENT_TOO_LARGE = "the photo is too large to enlarge fully, so it was enlarged the plain way";
const LEFT_OUT_TOO_LARGE = "the photo is too large to enlarge fully";
const FIX_TOO_LARGE = "Send a photo where the product fills more of the frame in a new batch.";
// Every try used, or the tries ended: the image stays as sent, so "yet" is no longer true.
const SENT_NO_MORE_TRIES = "not enlarged, and no more tries are planned";
const FIX_UNCHECKED = "Our quality check could not run, so this photo is not at fault. Send it again in a new batch.";
const notChecked = (o: { flags: readonly string[] }) => o.flags.includes("qa_unavailable") || o.flags.includes("qa_cap");
const BETTER_TOO_LARGE = "This image stays as it is. If it looks soft, send a photo where the product fills more of the frame in a new batch.";
const FIX_DEFAULT = "Send a better photo of this product in a new batch.";
const FIX_NOT_MADE = "Run this product again in a new batch.";
const FIX_PRODUCT = "Send usable photos of this product in a new batch.";
const FIX_FILE = "Send the file again in a new batch, as a photo or a working link.";
const NOT_MADE = "the image could not be made";
const HELD_REASON = "Held for you to decide before the photos are sent.";
const FIX_HELD = "Decide on the Needs you tab.";
/** M1 D40: one photo waiting for a person; the product's other photos are delivered. */
const PHOTO_HELD_GROUP = "one photo has no link until you decide";
export const AMAZON_NO_WHITE_FIRST = "Amazon needs a white first image and this listing has none until you decide.";
const FIX_PHOTO_HELD = "Open this batch and follow the link to the products that need you. Replace the photo, use it as it is, or remove it.";
const NOT_ADDED_TAKEN_GROUP = "another batch's photo already has this place";
const NOT_ADDED_LIMIT = "the channel takes no more images of this product";
const FIX_TAKEN = "Nothing to do. The earlier photo keeps its place, and the technical team looks at it.";
const FIX_LIMIT = "Nothing to do. The photos already live are kept.";
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
  batch: { id: string; channels: ChannelId[]; status: string; startedAt: Date | null; updatedAt: Date; counts?: { filesLeftOut?: number; uploadsNotRead?: number } };
  /** The links sheet of the same snapshot (buildReport): a slot with a link there is never an exception. */
  sheet: SheetSpec;
  /** Files that never became a photo of a product (buildReport's unsupportedFiles and linkFailures). */
  files: readonly unknown[];
  /** Products grouping left out whole (buildReport's leftOutProducts): they have no product row, so the digest adds them. */
  leftOutProducts?: readonly LeftOutProduct[];
  /** Files that were copies of a photo the product already has (buildReport's sameFiles, as a count). */
  sameFilesMerged?: number;
  /** The same bytes under several product names (photosUnderSeveralProducts): each is delivered, and said here. */
  sharedPhotos?: readonly SharedPhotos[];
  cost: DigestCost;
}

export interface DigestParts { digest: BatchDigest; exceptions: ExceptionRow[]; notes: NoteRow[]; kept: { keptPhotos: number; styliSkipped: number } }

/** The output columns the digest reads (buildReport's rows carry them). */
export type DigestOutput = { id: string; batchId: string; productId: string; sourceImageId: string; channel: ChannelId; n: number; status: string; isLive: boolean; flags: readonly string[]; reason: string | null; decision: string | null; compliance: unknown; qaModel: string | null; publicUrl: string; publishedAt: Date | null };
export type DigestPair = { productId: string; identifier: string; change: string; notes: string | null };
export type DigestImprovement = { sourceImageId: string; improvedAt: Date | null; tries: number; endReason: string | null };

/** The batch's improvements (M1-S4), in a fixed order. */
export async function readImprovements(db: Db, batchId: string): Promise<DigestImprovement[]> {
  return db.select({ sourceImageId: catalogImprovements.sourceImageId, improvedAt: catalogImprovements.improvedAt, tries: catalogImprovements.tries, endReason: catalogImprovements.endReason })
    .from(catalogImprovements).where(eq(catalogImprovements.batchId, batchId)).orderBy(asc(catalogImprovements.sourceImageId));
}

/** The batch's photos whose enlargement only the size rule refused (route `none`): no retry exists. */
export async function readTooLargePhotos(db: Db, batchId: string): Promise<Set<string>> {
  return new Set([...await enlargementOutlooks(db, batchId)].flatMap(([id, outlook]) => outlook === "too_large" ? [id] : []));
}

/**
 * The digest and its two sheets for one batch from rows already read (finalize passes buildReport's rows, so the
 * outputs are read once per build). `outputs` may hold other batches' outputs of the same products; only this batch's
 * count. `linksReadyAt` is left null: finalize sets it in its done write, keeping the first one.
 */
export function digestFrom(input: DigestInput & { pairs: readonly DigestPair[]; outputs: readonly DigestOutput[]; improvements: readonly DigestImprovement[]; tooLarge: ReadonlySet<string> }): DigestParts {
  const batchId = input.batch.id, channels = input.batch.channels, improvements = input.improvements, tooLarge = input.tooLarge;
  const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const pairs = [...input.pairs].sort((x, y) => collator.compare(x.identifier, y.identifier) || byText(x.productId, y.productId));
  const outputs = input.outputs.filter(o => o.batchId === batchId)
    .sort((x, y) => byText(x.productId, y.productId) || byText(x.channel, y.channel) || x.n - y.n || byText(x.id, y.id));

  const improvementOf = new Map(improvements.map(i => [i.sourceImageId, i]));
  const rowOf = new Map<string, SheetRow>();
  for (const row of input.sheet.rows) if (!rowOf.has(row.identifier)) rowOf.set(row.identifier, row);
  const linkAt = (identifier: string, channel: ChannelId, n: number) => !!rowOf.get(identifier)?.links[channel]?.[n - 1] && rowOf.get(identifier)?.status !== "missing_images";
  const hasLink = (identifier: string) => channels.some(c => (rowOf.get(identifier)?.links[c] ?? []).some(Boolean)) && rowOf.get(identifier)?.status !== "missing_images";
  const outputsOf = new Map<string, typeof outputs>();
  for (const o of outputs) { const list = outputsOf.get(o.productId); if (list) list.push(o); else outputsOf.set(o.productId, [o]); }
  const leftOutProducts = input.leftOutProducts ?? [];
  const leftOutKeys = new Set(leftOutProducts.map(l => normalizeKey(l.identifier)));

  const exceptions: ExceptionRow[] = [], notes: NoteRow[] = [], leftOut: { key: string; reason: string }[] = [];
  let needsYou = 0, unchanged = 0, controlsSkipped = 0, stayedAsSent = 0, completeEveryChannel = 0, productsWithLinks = 0;
  for (const pair of pairs) {
    // A product list row whose files were all left out has a row of its own: its one exception is the left-out one below.
    if (leftOutKeys.has(normalizeKey(pair.identifier))) continue;
    const mine = (outputsOf.get(pair.productId) ?? []).filter(o => channels.includes(o.channel));
    const withLinks = hasLink(pair.identifier);
    if (withLinks) productsWithLinks++;
    if (mine.some(o => o.reason?.includes(HOLDOUT_KEPT_NOTE))) controlsSkipped++;
    // A product held for a person (a batch started before auto-decide): counted under "Needs you" and listed in the
    // Exceptions sheet, so every product without a link is in a sheet (M1 D32).
    if (pair.change === "pending_attention") {
      needsYou++;
      exceptions.push({ identifier: pair.identifier, channel: null, image: null, reason: HELD_REASON, fix: FIX_HELD, group: `Waiting for you: ${HELD_REASON.charAt(0).toLowerCase()}${HELD_REASON.slice(1, -1)}` });
      continue;
    }
    if (pair.change === "unchanged") unchanged++;
    let productExceptions = 0, productNotes = 0;
    // M1 D40: a product whose every photo is held has no link (publish marks it failed) and still waits for a person: it counts under "Needs you" below.
    if (!mine.some(heldForPerson) && (pair.change === "failed" || (!withLinks && pair.change !== "unchanged"))) {
      const reason = pair.notes?.split("; ")[0] || NO_DELIVERABLE_PHOTO;
      exceptions.push({ identifier: pair.identifier, channel: null, image: null, reason, fix: FIX_PRODUCT, group: `No image on any channel: ${shortReason(reason)}` });
      for (const o of mine) if (o.flags.includes("auto_dropped")) leftOut.push({ key: o.sourceImageId, reason: leftOutReason(o, tooLarge) });
      continue;
    }
    let productHeld = false;
    for (const o of mine) {
      if (o.status === "verified" && o.isLive && o.flags.includes("provisional")) {
        const record = autoDecideRecordOf(o.compliance);
        const cause = record?.cause ?? "not_publishable";
        const improvement = improvementOf.get(o.sourceImageId);
        // The sweep goes by the flag: a failed enlargement a judged problem sent here under another rule is tried too.
        const notEnlarged = cause === "not_enlarged" || o.flags.includes("enlargement_failed"), refused = notEnlarged && tooLarge.has(o.sourceImageId);
        const improves = notEnlarged && !!improvement && !improvement.improvedAt && !improvement.endReason && improvement.tries < IMPROVE_MAX_TRIES;
        // M1-F3-R5 (M1 D11): every try used, or the re-made image did not pass: it stays as sent.
        if (improvement && !improvement.improvedAt && (improvement.tries >= IMPROVE_MAX_TRIES || improvement.endReason === "not_passed")) stayedAsSent++;
        notes.push({ identifier: pair.identifier, channel: o.channel, image: o.n, link: o.publicUrl, reason: notChecked(o) ? SENT_REASON.unchecked : cause === "not_enlarged" && refused ? SENT_TOO_LARGE : cause === "not_enlarged" && !improves && improvement && !improvement.improvedAt ? SENT_NO_MORE_TRIES : SENT_REASON[cause], rule: record?.rule ?? "", improves,
          better: improves ? "A larger version replaces it at the same link when the enlargement works. Nothing to do."
            : refused ? BETTER_TOO_LARGE
            : notEnlarged ? "We could not enlarge it. Send a larger photo in a new batch."
              : "Send a better photo in a new batch to replace it." });
        productNotes++;
        continue;
      }
      if (o.status !== "skipped" && o.status !== "failed" && o.status !== "needs_attention") continue;
      // M1 D40: the rare photo held for a person. The product counts once under "Needs you", each slot is an Exceptions row.
      if (heldForPerson(o)) {
        if (!productHeld) { productHeld = true; needsYou++; }
        // M1 D40: no photo could take image 1's place, so on Amazon the listing starts with a grey image and no white first image.
        const noWhiteFirst = o.channel === "amazon" && !o.isLive && o.n === Math.min(...mine.filter(m => m.channel === "amazon").map(m => m.n));
        exceptions.push({ identifier: pair.identifier, channel: o.channel, image: o.n, reason: `${o.reason ?? PHOTO_HELD_GROUP}${noWhiteFirst ? ` ${AMAZON_NO_WHITE_FIRST}` : ""}`, fix: FIX_PHOTO_HELD, group: `Waiting for you: ${PHOTO_HELD_GROUP}` });
        productExceptions++;
        continue;
      }
      // M1-S6 (M1 D30): a follow-up photo that was not added. Checked before the link check: its place may show another
      // batch's live photo, which is not this photo's link.
      if (o.status === "skipped" && o.flags.includes("not_added")) {
        const taken = o.reason === APPEND_TAKEN_NOTE;
        exceptions.push({ identifier: pair.identifier, channel: o.channel, image: o.n, reason: o.reason ?? NOT_ADDED_LIMIT, fix: taken ? FIX_TAKEN : FIX_LIMIT,
          group: `${CHANNELS[o.channel].label} image ${o.n} not added: ${taken ? NOT_ADDED_TAKEN_GROUP : NOT_ADDED_LIMIT}` });
        productExceptions++;
        continue;
      }
      // Left out on purpose, or replaced by a later image of the same slot: not an exception.
      if (o.decision === "remove" || o.decision === "replaced" || o.reason?.includes(HOLDOUT_KEPT_NOTE) || o.reason?.startsWith("Removed in batch")) continue;
      if (linkAt(pair.identifier, o.channel, o.n)) continue;
      const why = o.flags.includes("auto_dropped") ? leftOutReason(o, tooLarge) : o.reason?.includes(STYLI_SKIP_NOTE) ? TOO_SMALL : shortReason(o.reason);
      const cause = autoDecideRecordOf(o.compliance)?.cause;
      exceptions.push({ identifier: pair.identifier, channel: o.channel, image: o.n, reason: o.reason ?? why, fix: o.status === "failed" ? FIX_NOT_MADE : o.flags.includes("auto_dropped") && notChecked(o) ? FIX_UNCHECKED : why === TOO_SMALL ? "Send a larger photo in a new batch." : cause === "not_enlarged" && tooLarge.has(o.sourceImageId) ? FIX_TOO_LARGE : (cause && LEFT_OUT_FIX[cause]) ?? FIX_DEFAULT,
        group: `${CHANNELS[o.channel].label} image ${o.n} missing: ${why}` });
      if (o.flags.includes("auto_dropped")) leftOut.push({ key: o.sourceImageId, reason: why });
      productExceptions++;
    }
    if (withLinks && !productExceptions && !productNotes && channels.every(c => (rowOf.get(pair.identifier)?.links[c] ?? []).some(Boolean))) completeEveryChannel++;
  }
  // Every product grouping left out, one row each. When its name was the problem, that row speaks for its files; when its
  // files were, their own rows below say which one and why.
  const speaksForFiles = new Set<string>();
  for (const s of input.sharedPhotos ?? []) {
    const names = s.products > 3 ? `${s.identifiers.slice(0, 3).join(", ")} and ${(s.products - 3).toLocaleString("en-US")} more` : `${s.identifiers.slice(0, -1).join(", ")} and ${s.identifiers.at(-1)}`;
    exceptions.push({ identifier: s.identifiers[0]!, channel: null, image: null, reason: `${s.photos.toLocaleString("en-US")} ${s.photos === 1 ? "photo is" : "photos are"} the same in ${names}. Each product kept its links; nothing was merged.`, fix: "Check these are different products. If they are one product, send it under one name in a new batch.", group: "Check: the same photo under more than one product" });
  }
  for (const l of leftOutProducts) {
    const { text, fix } = LEFT_OUT_WORDS[l.why];
    exceptions.push({ identifier: l.identifier, channel: null, image: null, reason: l.reason, fix, group: `Product left out: ${text}` });
    if (l.why === "links" || l.why === "unreadable") continue;
    speaksForFiles.add(normalizeKey(l.identifier));
    for (const name of l.files) leftOut.push({ key: `left-out:${l.identifier}/${name}`, reason: text });
  }
  // Files that never became a photo of a product (unreadable files, links that could not be opened).
  for (const file of input.files) {
    const f = (file ?? {}) as { name?: unknown; originalName?: unknown; identifier?: unknown; url?: unknown; reason?: unknown };
    if (typeof f.identifier === "string" && speaksForFiles.has(normalizeKey(f.identifier))) continue;
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
  // minOf, not Math.min(...list): spreading a list that grows with the batch overflows the call stack (about 125k).
  const firstLink = minOf(outputs.flatMap(o => o.publishedAt ? [+o.publishedAt] : []));
  const linksPerChannel = CHANNEL_ORDER.filter(c => channels.includes(c)).map(channel => ({ channel, links: input.sheet.rows.reduce((n, r) => n + (r.status === "missing_images" ? 0 : (r.links[channel] ?? []).filter(Boolean).length), 0) }));
  const digest: BatchDigest = {
    version: 1,
    // A left-out product with a product list row is in `pairs` already.
    products: new Set([...pairs.map(p => normalizeKey(p.identifier)), ...leftOutKeys]).size,
    productsWithLinks,
    productsLeftOut: leftOutProducts.length,
    productsLeftOutReasons: groupReasons(leftOutProducts.map(l => LEFT_OUT_WORDS[l.why].text)),
    filesLeftOut: input.batch.counts?.filesLeftOut ?? 0,
    uploadsNotRead: input.batch.counts?.uploadsNotRead ?? 0,
    sameFilesMerged: input.sameFilesMerged ?? 0,
    photosUnderSeveralProducts: (input.sharedPhotos ?? []).reduce((sum, s) => sum + s.photos, 0),
    completeEveryChannel,
    linksPerChannel,
    provisionalLinks: notes.length,
    provisionalReasons: groupReasons(notes.map(n => n.reason)).slice(0, DIGEST_TOP_REASONS),
    improving: notes.filter(n => n.improves).length,
    stayedAsSent,
    // No model on the row, or one that gave no verdict: qa_unavailable keeps the model it asked, and a re-made image keeps the last one (qa_sampled_out on a re-made image).
    deliveredUnjudged: outputs.filter(o => o.status === "verified" && o.isLive && channels.includes(o.channel) && (o.qaModel === null || o.flags.includes("qa_unavailable") || o.flags.includes("qa_cap") || o.flags.includes("qa_sampled_out"))).length,
    photosLeftOut: photoReasons.size,
    leftOutReasons: groupReasons([...photoReasons.values()]),
    exceptions: exceptions.length,
    exceptionReasons: stored,
    exceptionsNotGrouped: grouped.slice(DIGEST_STORED_GROUPS).reduce((n, g) => n + g.count, 0),
    controlsSkipped,
    unchanged,
    needsYou,
    startedAt: input.batch.startedAt ? input.batch.startedAt.toISOString() : null,
    firstLinksAt: firstLink === null ? null : new Date(firstLink).toISOString(),
    linksReadyAt: null,
    cancelledAt: input.batch.status === "cancelled" ? input.batch.updatedAt.toISOString() : null,
    cost: input.cost,
  };
  // The Ready line's two counts, as batchDetails counts them, so the page reads them from the digest.
  const keptSources = new Set<string>();
  let styliSkipped = 0;
  for (const o of outputs) {
    if (o.decision === "use_as_is") keptSources.add(o.sourceImageId);
    if (o.channel === "styli" && o.status === "skipped" && o.reason?.includes(STYLI_SKIP_NOTE)) styliSkipped++;
  }
  return { digest, exceptions, notes, kept: { keptPhotos: keptSources.size, styliSkipped } };
}

/** A cost figure as the digest stores and shows it, with INR when a rate is set. */
export function digestCost(figure: BatchCostFigure, inrPerUsd: number | null): DigestCost {
  const { usd, usdPerProduct, basis } = figure;
  return { usd, inr: inrPerUsd === null ? null : usd * inrPerUsd, usdPerProduct, inrPerProduct: usdPerProduct === null || inrPerUsd === null ? null : usdPerProduct * inrPerUsd, basis };
}

/**
 * R1 exit item 4 (M6-F1-R9): the digest with the batch's live cost figure (batchCostFigure) in place of the one stored at
 * finalize, so the digest tab, the digest API and the batch page show one figure: the ledger so far, then the daily cost
 * check's (not final for two days, then final). Older digests get it too.
 */
export async function digestWithCost<T extends BatchDigest>(db: Db, batchId: string, digest: T, inrPerUsd: number | null): Promise<T> {
  return { ...digest, cost: digestCost(await batchCostFigure(db, batchId, digest.productsWithLinks), inrPerUsd) };
}

/** Reads what the digest needs and builds it (tests and callers without buildReport's rows). */
export async function buildDigest(db: Db, input: DigestInput): Promise<DigestParts> {
  const batchId = input.batch.id;
  const pairs = await db.select({ productId: catalogBatchProducts.productId, change: catalogBatchProducts.change, notes: catalogBatchProducts.notes, identifier: catalogProducts.identifier })
    .from(catalogBatchProducts).innerJoin(catalogProducts, eq(catalogProducts.id, catalogBatchProducts.productId)).where(eq(catalogBatchProducts.batchId, batchId))
    .orderBy(asc(catalogProducts.identifier), asc(catalogProducts.id));
  const outputs = await db.select({ id: catalogOutputs.id, batchId: catalogOutputs.batchId, productId: catalogOutputs.productId, sourceImageId: catalogOutputs.sourceImageId, channel: catalogOutputs.channel, n: catalogOutputs.n, status: catalogOutputs.status, isLive: catalogOutputs.isLive,
    flags: catalogOutputs.flags, reason: catalogOutputs.reason, decision: catalogOutputs.decision, compliance: catalogOutputs.compliance, qaModel: catalogOutputs.qaModel, publicUrl: catalogOutputs.publicUrl, publishedAt: catalogOutputs.publishedAt })
    .from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId)).orderBy(asc(catalogOutputs.createdAt), asc(catalogOutputs.id));
  return digestFrom({ ...input, pairs, outputs, improvements: await readImprovements(db, batchId), tooLarge: await readTooLargePhotos(db, batchId) });
}

function leftOutReason(o: { compliance: unknown; reason: string | null; sourceImageId: string; flags: readonly string[] }, tooLarge: ReadonlySet<string>): string {
  if (notChecked(o)) return LEFT_OUT_REASON.unchecked;
  const cause = autoDecideRecordOf(o.compliance)?.cause;
  if (cause === "not_enlarged" && tooLarge.has(o.sourceImageId)) return LEFT_OUT_TOO_LARGE;
  return cause ? LEFT_OUT_REASON[cause] : shortReason(o.reason);
}
