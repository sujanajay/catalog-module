// Links that could not be downloaded (spec 14b F5 part 1), read from the upload manifests: the step 2
// card, the "Show all" table and POST /retry-links, which drops those results so only they are read again.
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogUploads, type CatalogUpload } from "../../db/schema";
import { batchPrefix } from "../naming";
import type { UploadKind } from "../types";
import { classifyLinkReject, isLinkReject } from "./link-reasons";
import { itemKey, loadJson, manifestPath, saveJson, type UploadManifest } from "./manifest";
import type { IngestDeps } from "./types";

/** Kinds whose items are links. */
export const LINK_UPLOAD_KINDS: UploadKind[] = ["url_list", "sheet", "google_sheet"];

/** One link that could not be downloaded, for the "Show all" table and the counts. `reason` is the reason phrase. */
export interface LinkFailureRow { url: string; where: string; reason: string; temporary: boolean; identifier: string; uploadId: string; /** Fetches made (spec 14d F5 part 2); 1 for results written before release D. */ attempts: number }

async function linkUploads(db: Db, batchId: string): Promise<{ prefix: string; uploads: CatalogUpload[] }> {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new Error("This batch does not exist.");
  const uploads = await db.select().from(catalogUploads).where(and(eq(catalogUploads.batchId, batchId), ne(catalogUploads.status, "removed")));
  return { prefix: batchPrefix(batch.brandSlug, batch.id, batch.isTest), uploads: uploads.filter((u) => LINK_UPLOAD_KINDS.includes(u.kind)) };
}

/**
 * Every link of the batch's non-removed uploads that was read and could not be downloaded, and how
 * many links the batch holds. Links not read yet are counted but are not failures.
 */
export async function linkFailuresOf(db: Db, batchId: string, deps: Pick<IngestDeps, "storage">): Promise<{ links: number; rows: LinkFailureRow[] }> {
  const { prefix, uploads } = await linkUploads(db, batchId);
  let links = 0;
  const rows: LinkFailureRow[] = [];
  for (const u of uploads) {
    const m = await loadJson<UploadManifest>(deps, manifestPath(prefix, u.id));
    if (!m || m.productList) continue;
    for (const item of m.items) {
      if (item.bytes.kind !== "url") continue;
      links++;
      const r = m.results[itemKey(item)];
      const link = r && !r.ok ? classifyLinkReject(r.reason) : null;
      if (link) rows.push({ url: link.url, where: link.where ?? "", reason: link.phrase, temporary: link.temporary, identifier: item.identifier, uploadId: u.id, attempts: (r && !r.ok && r.attempts) || 1 });
    }
  }
  return { links, rows };
}

/**
 * Drops the link reject results from the manifests of the batch's non-removed uploads, so the next
 * run of those uploads reads those links again and only those (the manifest keeps every other
 * result). `counts.collected` goes down by the same number, as that run adds them back. Returns the
 * uploads whose manifest changed and how many results were dropped.
 */
export async function dropLinkRejects(db: Db, batchId: string, deps: Pick<IngestDeps, "storage">): Promise<{ uploadIds: string[]; dropped: number }> {
  const { prefix, uploads } = await linkUploads(db, batchId);
  const uploadIds: string[] = [];
  let dropped = 0;
  for (const u of uploads) {
    const m = await loadJson<UploadManifest>(deps, manifestPath(prefix, u.id));
    if (!m) continue;
    const keys = Object.entries(m.results).filter(([, r]) => !r.ok && isLinkReject(r.reason)).map(([k]) => k);
    if (!keys.length) continue;
    // The operator's explicit retry drops each result with its attempt history (spec 14d F5 part 2).
    for (const k of keys) {
      delete m.results[k];
      if (m.priorAttempts) delete m.priorAttempts[k];
    }
    await saveJson(deps, manifestPath(prefix, u.id), m);
    uploadIds.push(u.id);
    dropped += keys.length;
  }
  if (dropped) {
    await db
      .update(catalogBatches)
      .set({ counts: sql`jsonb_set(${catalogBatches.counts}, '{collected}', to_jsonb(GREATEST(0, COALESCE((${catalogBatches.counts}->>'collected')::int, 0) - (${dropped})::int)))` })
      .where(eq(catalogBatches.id, batchId));
  }
  return { uploadIds, dropped };
}
