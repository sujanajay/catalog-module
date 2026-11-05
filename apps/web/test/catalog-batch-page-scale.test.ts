// M1-S5 review follow-up: the batch page readers of a batch without a digest (a processing batch refreshes every 5 s)
// at 25,000 products and 75,000 outputs. Each must stay within the 2 s page budget, so none may look up outputs per
// product in a loop (that is quadratic: the cost line took minutes this way). SCALE_PRODUCTS sets another size.
import { afterAll, beforeAll, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { eq, sql } from "drizzle-orm";
import { createDbFromPglite } from "@catalog/core/db/testing";
import { runMigrations } from "@catalog/core/db/migrate";
import { seedLargeBatch } from "@catalog/core/catalog/pipeline/large-batch-fixture";
import { catalogBatches } from "@catalog/core/db/schema";
import type { Db } from "../lib/db";
import { batchCostLine } from "../lib/catalog/cost";
import { listAttention } from "@catalog/core/catalog/attention";

const PRODUCTS = Number(process.env.SCALE_PRODUCTS ?? 25_000), PHOTOS = 3, HELD = Math.min(5_000, PRODUCTS);
let db: Db, close: () => Promise<void>, batchId = "";
beforeAll(async () => {
  const made = createDbFromPglite();
  db = made.db as unknown as Db; close = () => made.client.close();
  await runMigrations(made.db);
  ({ batchId } = await seedLargeBatch(made.db, { products: PRODUCTS, photosPerProduct: PHOTOS, channels: ["noon"], status: "rendering" }));
  // 10 products unchanged and 5 with every output skipped: neither counts as a style made.
  await made.db.execute(sql`UPDATE catalog_batch_products SET change = 'unchanged' WHERE product_id IN (SELECT product_id FROM catalog_batch_products WHERE batch_id = ${batchId}::uuid ORDER BY product_id LIMIT 10)`);
  await made.db.execute(sql`UPDATE catalog_outputs SET status = 'skipped' WHERE batch_id = ${batchId}::uuid AND product_id IN (SELECT product_id FROM catalog_batch_products WHERE batch_id = ${batchId}::uuid ORDER BY product_id DESC LIMIT 5)`);
  // A batch started before auto-decide with many products held for a person (every output of 5,000 products held).
  await made.db.execute(sql`UPDATE catalog_outputs SET status = 'needs_attention', flags = '["qa_unavailable"]'::jsonb WHERE batch_id = ${batchId}::uuid AND product_id IN (SELECT product_id FROM catalog_batch_products WHERE batch_id = ${batchId}::uuid ORDER BY product_id LIMIT ${HELD})`);
}, 600_000);
afterAll(async () => { await close(); });

it(`gives the cost line of a ${PRODUCTS.toLocaleString("en")}-product batch within 2 s`, async () => {
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  const t = performance.now();
  const line = await batchCostLine({ id: batchId, cost: { ...batch!.cost, qaUsd: 3, computeUsd: 2 } }, db, {} as NodeJS.ProcessEnv);
  const ms = performance.now() - t;
  console.log(`batchCostLine: ${Math.round(ms)} ms`);
  expect(line.identifiers).toBe(PRODUCTS - 15);
  expect(line.usdPerIdentifier).toBeCloseTo(5 / (PRODUCTS - 15));
  expect(ms).toBeLessThan(2000);
}, 600_000);

it(`lists ${HELD.toLocaleString("en")} held products of the batch for Needs attention within 2 s`, async () => {
  const t = performance.now();
  const held = await listAttention(db as never, batchId, async (uri) => uri);
  const ms = performance.now() - t;
  console.log(`listAttention: ${Math.round(ms)} ms`);
  expect(held).toHaveLength(HELD);
  expect(held[0]!.photos.length).toBeGreaterThan(0);
  expect(held[0]!.totalShots).toBe(PHOTOS);
  expect(ms).toBeLessThan(2000);
}, 600_000);
