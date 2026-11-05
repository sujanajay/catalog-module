// M1-F5-R2 (M1-S6): photos added to a batch that has already started go into a linked follow-up batch. The follow-up
// is a normal draft with the parent's brand, channels, product type and grouping choices, `parent_batch_id` naming the
// parent, and auto-start on, so once its files are collected it starts by itself (M1-F2-R6). Products the parent still
// holds make its auto-start wait for the lock and then start (M1-F2-R7, auto-start.ts), so nothing is refused.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, DEFAULT_BATCH_OPTIONS, type CatalogBatch } from "../db/schema";
import type { BatchOptions } from "./types";
import { log } from "../log";

/** M1 admin setting "follow-up batch auto-start on or off" (F5); a constant until the M12 settings store holds it (M1 D2). */
export const FOLLOW_UP_AUTO_START = true;

/** A refusal with the HTTP status the web answers with. */
export class FollowUpRefused extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FollowUpRefused";
  }
}

export const FOLLOW_UP_NOT_FOUND = "This batch does not exist. Open the batch list and choose another.";
/** A batch that has not started takes more photos itself (M1 D23: a change while collecting edits the draft). */
export const FOLLOW_UP_NOT_STARTED = "This batch has not started yet. Add the photos to it on its New batch page.";
export const FOLLOW_UP_CANCELLED = "This batch was cancelled. Make a new batch.";

/** The follow-up's name: the parent's, so a test batch's catalog-test prefix is kept. */
export function followUpName(parentName: string): string {
  return `${parentName} (more photos)`;
}

/** The grouping choices a follow-up keeps from its parent; the sheet columns belong to the parent's own sheets. */
export function followUpOptions(parent: BatchOptions): BatchOptions {
  return {
    ...DEFAULT_BATCH_OPTIONS,
    identifierMode: parent.identifierMode,
    precedence: parent.precedence,
    perRoot: parent.perRoot ?? true,
    ...(parent.newestSameProduct !== undefined ? { newestSameProduct: parent.newestSameProduct } : {}),
    autoStart: FOLLOW_UP_AUTO_START,
  };
}

/**
 * The follow-up batch of `parentId` for `actor`: the one they already have open (a draft or one collecting, never
 * started) or a new one. The parent's row lock serialises two adds at once, so one person gets one follow-up.
 * Refused (FollowUpRefused) for a batch that does not exist, has not started (its own page takes the photos) or was
 * cancelled before it started.
 */
export async function followUpBatch(db: Db, parentId: string, actor: string): Promise<{ id: string; created: boolean }> {
  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(catalogBatches).where(eq(catalogBatches.id, parentId)).for("update");
    if (!parent) throw new FollowUpRefused(404, FOLLOW_UP_NOT_FOUND);
    if (!parent.startedAt) throw new FollowUpRefused(409, parent.status === "cancelled" ? FOLLOW_UP_CANCELLED : FOLLOW_UP_NOT_STARTED);
    const [open] = await tx.select({ id: catalogBatches.id }).from(catalogBatches)
      .where(and(eq(catalogBatches.parentBatchId, parentId), isNull(catalogBatches.startedAt), inArray(catalogBatches.status, ["draft", "ingesting"]), sql`lower(${catalogBatches.createdBy}) = ${actor.toLowerCase()}`))
      .orderBy(desc(catalogBatches.createdAt)).limit(1);
    if (open) return { id: open.id, created: false };
    const [made] = await tx.insert(catalogBatches).values(followUpValues(parent, actor)).returning({ id: catalogBatches.id });
    log("INFO", "follow-up batch made", { batchId: made!.id, parentBatchId: parentId, brandSlug: parent.brandSlug });
    return { id: made!.id, created: true };
  });
}

function followUpValues(parent: CatalogBatch, actor: string): typeof catalogBatches.$inferInsert {
  return {
    brandSlug: parent.brandSlug, brandName: parent.brandName, name: followUpName(parent.name), productType: parent.productType,
    isTest: parent.isTest, channels: parent.channels, options: followUpOptions(parent.options), createdBy: actor, parentBatchId: parent.id,
  };
}

/** The batches a batch is linked to: the batch it adds to, and its own follow-ups (oldest first), for the batch page. */
export async function batchLinks(db: Db, batch: Pick<CatalogBatch, "id" | "parentBatchId">): Promise<{ parent: { id: string; name: string } | null; followUps: { id: string; name: string; status: string }[] }> {
  const [parent] = batch.parentBatchId ? await db.select({ id: catalogBatches.id, name: catalogBatches.name }).from(catalogBatches).where(eq(catalogBatches.id, batch.parentBatchId)) : [];
  const followUps = await db.select({ id: catalogBatches.id, name: catalogBatches.name, status: catalogBatches.status }).from(catalogBatches)
    .where(and(eq(catalogBatches.parentBatchId, batch.id), sql`${catalogBatches.status} <> 'cancelled'`)).orderBy(catalogBatches.createdAt);
  return { parent: parent ?? null, followUps };
}
