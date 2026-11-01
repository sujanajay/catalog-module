// Large-batch audit item 7 (2026-11-01): a chunk delivery must not read every chunk row of its batch (select * with
// the jsonb id lists) to learn whether the batch moved on. At 25k products that is ~2,500 rows per delivery, for each
// of ~7,500 deliveries. The checks are one-row existence queries now.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "drizzle-orm/logger";
import type { Db } from "@catalog/core/db/client";
import { createDbFromPglite } from "@catalog/core/db/testing";
import { runMigrations } from "@catalog/core/db/migrate";
import { catalogBatches } from "@catalog/core/db/schema";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { fakeWorld, seedBatch } from "../../test/catalog-fakes";

let db: Db, close: () => Promise<void>;
const seen: string[] = [];
const logger: Logger = { logQuery: (query) => { seen.push(query); } };
beforeAll(async () => {
  const made = createDbFromPglite(undefined, { logger });
  db = made.db; close = () => made.client.close();
  await runMigrations(db);
}, 120_000);
afterAll(async () => { await close(); });

/** A query that reads the chunk rows' product id lists for a whole batch (no other condition, no limit). */
const wholeBatchChunkRead = (q: string) => /select .*"product_ids".* from "catalog_chunks" where "catalog_chunks"\."batch_id" = \$1$/i.test(q.trim());

it("the render-to-qa and last-chunk checks read at most one chunk row, not every chunk of the batch", async () => {
  const w = fakeWorld(db);
  const { batch, chunks } = await seedBatch(db, w, "chunk-queries", [[1], [1]]);
  // The other chunk is finished already, as most chunks of a large batch are when one more delivers.
  await db.execute(sql`UPDATE catalog_chunks SET stage = 'qa', status = 'done', finished_at = now() WHERE id = ${chunks[1]!.id}::uuid`);
  seen.length = 0;
  for (let step = 0; step < 3; step++) expect((await handleChunkTask(w.deps, await currentChunkTask(db, chunks[0]!.id))).httpStatus).toBe(200);
  expect((await db.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batch.id)))[0]!.status).toBe("publishing");
  expect(seen.filter(wholeBatchChunkRead)).toEqual([]);
}, 120_000);
