import { applySkuMap } from "@catalog/core/catalog/decisions";
import { enqueueFinalize } from "@catalog/core/catalog/finalize-request";
import { readSheetTable } from "@catalog/core/catalog/ingest/links-sheet";
import { enqueueTask } from "@catalog/core/tasks";
import { db } from "../db";
import { badRequest } from "../errors";
import { decisionAction } from "./decisions";

/** A two-column mapping sheet is small; anything larger is refused before it is parsed. */
export const SKU_MAP_MAX_BYTES = 10 * 1024 * 1024;
export const SKU_MAP_TOO_LARGE = "Choose a mapping sheet under 10 MB.";

/** "Add Opptra SKU ids" (spec 07 4.9): fill gaps from a mapping sheet, then finalize a new links sheet. */
export async function addSkuMap(batchId: string, file: File, actor: string) {
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw badRequest("Choose an xlsx or csv mapping sheet.");
  if (file.size > SKU_MAP_MAX_BYTES) throw badRequest(SKU_MAP_TOO_LARGE);
  const table = await readSheetTable(Buffer.from(await file.arrayBuffer()), file.name);
  return decisionAction(async () => {
    const result = await applySkuMap(db(), { batchId, rows: [table.header, ...table.rows], actor });
    // Spec 18 H4: a done batch is finalized again only on request; new SKU ids ask for a fresh links sheet
    // through the one stored request (counts.finalizePending), with its dedupe and failed-batch guard.
    await enqueueFinalize({ db: db(), enqueue: enqueueTask }, batchId, undefined, { reopen: true });
    return result;
  });
}
