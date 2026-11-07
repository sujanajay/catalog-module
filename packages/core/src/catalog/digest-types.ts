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
  /** Products in the batch, those grouping left out included. */
  products: number;
  /** Products with at least one link in the sheet on the batch's channels. */
  productsWithLinks: number;
  /** Products grouping left out whole, with their reasons, most common first. Older stored digests have none. */
  productsLeftOut?: number;
  productsLeftOutReasons?: DigestReason[];
  /** Files, rows and links outside those products that gave no photo, and whole inputs not read. Older digests have none. */
  filesLeftOut?: number;
  uploadsNotRead?: number;
  /** Photos delivered under more than one product name, for the operator to check. Older digests have none. */
  photosUnderSeveralProducts?: number;
  /** Files that were copies of a photo the product already has, so one was used. Older stored digests have none. */
  sameFilesMerged?: number;
  /** M1 D45: products with different photos at one shot number, each kept as its own shot. Older stored digests have none. */
  sameShotsKept?: number;
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
  /** Live images of the batch no judge verdict stands behind (not judged, or the judge gave no answer). Older stored digests have none. */
  deliveredUnjudged?: number;
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
  /** M1-F5-R3: products this batch found unchanged (same photos, same images); their links stay as they were. */
  unchanged: number;
  /** Products held for a person (only batches started before auto-decide have any). */
  needsYou: number;
  startedAt: string | null;
  firstLinksAt: string | null;
  /** The first time the batch was done; a later finalize (an improvement, Add SKU ids) keeps it. */
  linksReadyAt: string | null;
  /** A batch cancelled part way: when (the digest covers what was delivered). */
  cancelledAt: string | null;
  /**
   * Cost in total and per product with links (INR is null when no rate is set), as batchCostFigure gives it (R1 exit
   * item 4). The stored digest keeps finalize's `recorded` figure; the page and the digest API always put in the live
   * figure. Digests written before have no basis.
   */
  cost: DigestCost;
  /**
   * What the batch page and its downloads need besides the numbers, so a page with a digest reads this row only, never
   * the report or the outputs (M1-S5 review P2-3). Internal: storage paths, never sent to the browser.
   */
  page?: DigestPage;
}

export interface DigestCost { usd: number; inr: number | null; usdPerProduct: number | null; inrPerProduct: number | null; basis?: CostBasis }

/** See BatchCostFigure (cost-report.ts): `true` only once the daily cost check has a final figure for the batch. */
export type CostBasis = "recorded" | "provisional" | "true";

export interface DigestPage {
  /** The two digest sheets as csv (storage paths), null when not written. */
  exceptionsCsv: string | null;
  notesCsv: string | null;
  /** A filled copy of the uploaded product list exists. */
  filled: boolean;
  /** Channels this batch does not make whose links come from an earlier batch. */
  notRefreshedChannels: { channel: ChannelId; lastBatchId: string; lastBatchName: string }[];
  /** Photos kept with "Use as is", and Styli images left out as too small (the Ready line). */
  keptPhotos: number;
  styliSkipped: number;
}
