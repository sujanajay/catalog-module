// M1-S5 (M1-F4-R1, R6): the batch digest as the page and GET .../digest read it: one row of catalog_batches, never the
// outputs, so it loads quickly at any batch size.
import { eq } from "drizzle-orm";
import { catalogBatches } from "@catalog/core/db/schema";
import type { BatchDigest } from "@catalog/core/catalog/digest-types";
import { digestWithCost } from "@catalog/core/catalog/digest";
import { inrPerUsdFromEnv } from "@catalog/core/catalog/cost";
import { db, type Db } from "../db";
import { HttpError } from "../errors";

export async function batchDigest(id: string, conn: Db = db()): Promise<{ id: string; name: string; status: string; digest: BatchDigest | null }> {
  const [row] = await conn.select({ id: catalogBatches.id, name: catalogBatches.name, status: catalogBatches.status, digest: catalogBatches.digest }).from(catalogBatches).where(eq(catalogBatches.id, id));
  if (!row) throw new HttpError(404, "This batch was not found. Return to All batches.");
  // The page block holds storage paths: it stays on the server.
  if (!row.digest) return row;
  const { page: _page, ...digest } = row.digest;
  // R1 exit item 4: the live cost figure, the same as the batch page (batchCostFigure).
  return { ...row, digest: await digestWithCost(conn, id, digest, inrPerUsdFromEnv()) };
}
