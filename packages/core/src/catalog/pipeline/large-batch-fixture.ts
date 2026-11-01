// Test-only: seeds one processed batch of any size straight in SQL (generate_series), for the scale tests of the
// finalize, progress and batch page paths. Never imported by production code.
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { EMPTY_BATCH_COUNTS } from "../../db/schema";
import type { ChannelId } from "../types";

export interface LargeBatchShape {
  products: number;
  photosPerProduct: number;
  channels: ChannelId[];
  /** Products per chunk row. */
  chunkSize?: number;
  /** Batch status (default qa: every chunk done, outputs verified and live). */
  status?: string;
  brandSlug?: string;
  /** Products of the batch that also have a live output of an earlier batch on `oldChannel` (notRefreshedChannels). */
  earlierLive?: number;
  oldChannel?: ChannelId;
}

/** Seeds the batch and returns its id. Every output is verified and live, every chunk done at the qa stage. */
export async function seedLargeBatch(db: Db, shape: LargeBatchShape): Promise<{ batchId: string; earlierBatchId: string | null }> {
  const brand = shape.brandSlug ?? "scale", status = shape.status ?? "qa", chunkSize = shape.chunkSize ?? 10;
  const outputs = shape.products * shape.photosPerProduct * shape.channels.length;
  const counts = { ...EMPTY_BATCH_COUNTS, products: shape.products, sources: shape.products * shape.photosPerProduct, outputs };
  const run = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as { rows: Record<string, unknown>[] };
  const [batch] = (await run(sql`INSERT INTO catalog_batches (brand_slug, brand_name, name, status, is_test, channels, counts, created_by, started_at)
    VALUES (${brand}, 'Scale', 'scale batch', ${status}, true, ${JSON.stringify(shape.channels)}::jsonb, ${JSON.stringify(counts)}::jsonb, 'test@opptra.com', now()) RETURNING id`)).rows;
  const batchId = String(batch!.id);
  await run(sql`INSERT INTO catalog_products (brand_slug, is_test, product_key, path_key, identifier, last_batch_id, lock_batch_id)
    SELECT ${brand}, true, ${batchId}::text || '-' || i, 'p' || i || '-' || left(${batchId}::text, 8), 'SKU-' || lpad(i::text, 6, '0'), ${batchId}::uuid, ${batchId}::uuid FROM generate_series(1, ${shape.products}) AS i`);
  await run(sql`INSERT INTO catalog_batch_products (batch_id, product_id, change)
    SELECT ${batchId}::uuid, id, 'new' FROM catalog_products WHERE last_batch_id = ${batchId}::uuid`);
  await run(sql`INSERT INTO catalog_source_images (product_id, batch_id, n, sha256, is_current, original_name, raw_uri, mime, width, height, matte_uri, status)
    SELECT p.id, ${batchId}::uuid, n, md5(p.id::text || n), true, p.path_key || '_' || n || '.jpg', 'gs://assets/raw/' || p.path_key || '/' || n || '.jpg', 'image/jpeg', 1200, 1500,
      'gs://assets/matte/' || p.path_key || '/' || n || '.png', 'matted'
    FROM catalog_products p CROSS JOIN generate_series(1, ${shape.photosPerProduct}) AS n WHERE p.last_batch_id = ${batchId}::uuid`);
  for (const channel of shape.channels) {
    await run(sql`INSERT INTO catalog_outputs (batch_id, product_id, source_image_id, channel, n, canvas_w, canvas_h, scale, placed_x, placed_y, render_key, object_path, public_url, is_live, status, published_at, generation)
      SELECT ${batchId}::uuid, s.product_id, s.id, ${channel}, s.n, 800, 1000, 1, 0, 0, 'k-' || s.id, 'catalog-test/' || ${channel} || '/' || s.id || '.jpg',
        'https://storage.googleapis.com/public/catalog-test/' || ${channel} || '/' || s.id || '.jpg', true, 'verified', now(), 1
      FROM catalog_source_images s WHERE s.batch_id = ${batchId}::uuid`);
  }
  await run(sql`INSERT INTO catalog_chunks (batch_id, index, stage, product_ids, status, finished_at)
    SELECT ${batchId}::uuid, g - 1, 'qa', jsonb_agg(id::text), 'done', now() FROM (
      SELECT id, (row_number() OVER (ORDER BY id) - 1) / ${chunkSize} + 1 AS g FROM catalog_products WHERE last_batch_id = ${batchId}::uuid) AS numbered GROUP BY g`);
  let earlierBatchId: string | null = null;
  if (shape.earlierLive && shape.oldChannel) {
    const [old] = (await run(sql`INSERT INTO catalog_batches (brand_slug, brand_name, name, status, is_test, channels, created_by)
      VALUES (${brand}, 'Scale', 'earlier delivery', 'done', true, ${JSON.stringify([shape.oldChannel])}::jsonb, 'test@opptra.com') RETURNING id`)).rows;
    earlierBatchId = String(old!.id);
    await run(sql`INSERT INTO catalog_outputs (batch_id, product_id, source_image_id, channel, n, canvas_w, canvas_h, scale, placed_x, placed_y, render_key, object_path, public_url, is_live, status, published_at)
      SELECT ${earlierBatchId}::uuid, s.product_id, s.id, ${shape.oldChannel}, s.n, 800, 1000, 1, 0, 0, 'old-' || s.id, 'catalog-test/old/' || s.id || '.jpg',
        'https://storage.googleapis.com/public/catalog-test/old/' || s.id || '.jpg', true, 'verified', now() - interval '1 day'
      FROM catalog_source_images s WHERE s.batch_id = ${batchId}::uuid AND s.n = 1 LIMIT ${shape.earlierLive}`);
  }
  return { batchId, earlierBatchId };
}
