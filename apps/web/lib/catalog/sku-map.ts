import { applySkuMap } from "@catalog/core/catalog/decisions";
import { readSheetTable } from "@catalog/core/catalog/ingest/links-sheet";
import { enqueueTask } from "@catalog/core/tasks";
import { db } from "../db";
import { badRequest } from "../errors";
import { decisionAction } from "./decisions";

/** "Add Opptra SKU ids" (spec 07 4.9): fill gaps from a mapping sheet, then finalize a new links sheet. */
export async function addSkuMap(batchId: string, file: File, actor: string) {
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw badRequest("Choose an xlsx or csv mapping sheet.");
  const table = await readSheetTable(Buffer.from(await file.arrayBuffer()), file.name);
  return decisionAction(async () => {
    const result = await applySkuMap(db(), { batchId, rows: [table.header, ...table.rows], actor });
    await enqueueTask("/tasks/catalog/finalize", { batchId });
    return result;
  });
}
