// Large-batch fix (2026-11-01): the batch page refreshes every 5 s while a batch processes, and each refresh builds the
// live sheet (batchDetails -> batchSheet) and the not-refreshed channels. At 25,000 products (75,000 live outputs) the
// per-product searches over every output and member took minutes; the build is one pass in a fixed number of queries.
// SCALE_PRODUCTS sets another size.
import { afterAll, beforeAll, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import type { Logger } from "drizzle-orm/logger";
import { sql } from "drizzle-orm";
import { createDbFromPglite } from "@catalog/core/db/testing";
import { runMigrations } from "@catalog/core/db/migrate";
import { seedLargeBatch } from "@catalog/core/catalog/pipeline/large-batch-fixture";
import { notRefreshedChannels } from "@catalog/core/catalog/pipeline/report";
import type { Db } from "../lib/db";
import { batchSheet } from "../lib/catalog/exports";

const PRODUCTS = Number(process.env.SCALE_PRODUCTS ?? 25_000), PHOTOS = 3;
let db: Db, close: () => Promise<void>, queries = 0, batchId = "";
const counter: Logger = { logQuery: () => { queries++; } };
beforeAll(async () => {
  const made = createDbFromPglite(undefined, { logger: counter });
  db = made.db as unknown as Db; close = () => made.client.close();
  await runMigrations(made.db);
  ({ batchId } = await seedLargeBatch(made.db, { products: PRODUCTS, photosPerProduct: PHOTOS, channels: ["noon"], status: "rendering", earlierLive: 500, oldChannel: "amazon" }));
  await made.db.execute(sql`UPDATE catalog_batch_products SET change = 'pending_attention', notes = 'Held for a look' WHERE product_id IN (SELECT product_id FROM catalog_batch_products WHERE batch_id = ${batchId}::uuid LIMIT 3)`);
}, 600_000);
afterAll(async () => { await close(); });

it(`builds the live sheet of a ${PRODUCTS.toLocaleString("en")}-product batch in a fixed number of queries, well inside a page load`, async () => {
  const before = queries, t = performance.now();
  const sheet = await batchSheet(batchId, db);
  const ms = performance.now() - t, used = queries - before;
  console.log(`batchSheet: ${Math.round(ms)} ms, ${used} queries`);
  expect(sheet.rows).toHaveLength(PRODUCTS);
  expect(sheet.rows[0]!.identifier).toBe("SKU-000001");
  const ok = sheet.rows.find((r) => r.status === "ok")!;
  expect(ok).toMatchObject({ brand: "Scale", change: "new", notes: "" });
  expect(ok.links.noon).toHaveLength(PHOTOS);
  expect(sheet.rows.filter((r) => r.status === "needs_attention" && r.notes === "Held for a look")).toHaveLength(3);
  expect(used).toBeLessThanOrEqual(4);
  expect(ms).toBeLessThan(30_000);
  const t2 = performance.now();
  expect(await notRefreshedChannels(db as never, batchId)).toEqual([expect.objectContaining({ channel: "amazon", lastBatchName: "earlier delivery" })]);
  console.log(`notRefreshedChannels: ${Math.round(performance.now() - t2)} ms`);
}, 300_000);
