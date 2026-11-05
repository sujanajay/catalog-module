// M1-S5 (M1-F4): the shape of a batch digest, stored as catalog_batches.digest. Kept apart from digest.ts so the schema
// can name the type without importing the builder (which reads the database).
import type { ChannelId } from "./types";

/** One grouped reason: a plain sentence and how many images, photos or products it covers. */
export interface DigestReason {
  text: string;
  count: number;
}

export interface BatchDigest {
  /** Bumped when the shape changes; a page reading an older version still shows the fields it knows. */
  version: 1;
  /** Products in the batch. */
  products: number;
  /** Products with at least one link in the sheet on the batch's channels. */
  productsWithLinks: number;
  /** Products with links on every channel of the batch, nothing left out and nothing sent with a note. */
  completeEveryChannel: number;
  /** Links in the sheet per channel, in channel order. */
  linksPerChannel: { channel: ChannelId; links: number }[];
  /** Images sent now with the best image we have (the "Delivered with a note" sheet has one row each). */
  provisionalLinks: number;
  /** Their reasons, most common first (top 5, M1-F4-R2). */
  provisionalReasons: DigestReason[];
  /** Of those, the ones a later try may still make better at the same link (M1-S4). */
  improving: number;
  /** Of those, the ones every try left as they were (M1-F3-R5): they stay as sent. */
  stayedAsSent: number;
  /** Photos (and unreadable files) that gave no link, with their reasons, most common first. */
  photosLeftOut: number;
  leftOutReasons: DigestReason[];
  /** Rows of the Exceptions sheet: one per product or photo with no link (M1-F4-R4). */
  exceptions: number;
  /** The Exceptions rows grouped by channel, image and reason, most common first (at most DIGEST_STORED_GROUPS). */
  exceptionReasons: DigestReason[];
  /** Exception rows not in exceptionReasons (the groups past the stored limit). */
  exceptionsNotGrouped: number;
  /** Products whose images on some channel were left unchanged because a running experiment holds them. */
  controlsSkipped: number;
  /** Products held for a person (only batches started before auto-decide have any). */
  needsYou: number;
  startedAt: string | null;
  firstLinksAt: string | null;
  /** The first time the batch was done; a later finalize (an improvement, Add SKU ids) keeps it. */
  linksReadyAt: string | null;
  /** A batch cancelled part way: when (the digest covers what was delivered). */
  cancelledAt: string | null;
  /** Cost in total and per product, as the batch cost line counts it (INR is null when no rate is set). */
  cost: { usd: number; inr: number | null; usdPerProduct: number | null; inrPerProduct: number | null };
}
