// M6-S6 review P1-1 (Tier 2, PGlite): M6-F3 acceptance test 1 with the live lane behaviour. While the upscaler is
// stopped, every enlarge delivery still runs refreshLaneProgress (enlarge.ts step 3), which stamps progress_at on every
// parked chunk. That stamp is a retry, not progress: the stall incident must open anyway, and resolve once an
// enlargement settles.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { ENLARGING_TASK } from "@catalog/core/catalog/pipeline/enlargement";
import { recordBatchOutcome, syncIncidents } from "@catalog/core/catalog/reliability";
import { refreshLaneProgress } from "./enlarge";

let db: Db;
let close: () => Promise<void>;
const T0 = new Date("2026-11-04T08:00:00Z");
const at = (minutes: number) => new Date(+T0 + minutes * 60_000);
type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

async function parkedBatch(): Promise<{ batchId: string; chunkId: string; enlargementId: string }> {
  const batchId = randomUUID(), productId = randomUUID(), sourceId = randomUUID(), chunkId = randomUUID(), enlargementId = randomUUID();
  await db.execute(sql`INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, created_by, counts, created_at, started_at, updated_at)
    VALUES (${batchId}, 'uspa', 'USPA', 'November drop', 'rendering', 'op@opptra.com', '{"products":1}'::jsonb, ${T0.toISOString()}::timestamptz, ${T0.toISOString()}::timestamptz, ${at(5).toISOString()}::timestamptz)`);
  await db.execute(sql`INSERT INTO catalog_products (id, brand_slug, is_test, product_key, path_key, identifier) VALUES (${productId}, 'uspa', false, ${`P${productId.slice(0, 8)}`.toUpperCase()}, ${productId}, ${productId})`);
  await db.execute(sql`INSERT INTO catalog_source_images (id, batch_id, product_id, n, sha256, original_name, raw_uri, mime) VALUES (${sourceId}, ${batchId}, ${productId}, 1, 's', 'x.jpg', 'gs://a/x.jpg', 'image/jpeg')`);
  await db.execute(sql`INSERT INTO catalog_chunks (id, batch_id, "index", stage, product_ids, status, task_name, started_at, progress_at)
    VALUES (${chunkId}, ${batchId}, 0, 'render', '[]'::jsonb, 'queued', ${ENLARGING_TASK}, ${at(1).toISOString()}::timestamptz, ${at(5).toISOString()}::timestamptz)`);
  await db.execute(sql`INSERT INTO catalog_enlargements (id, batch_id, product_id, source_image_id, upscaler, factor, scale, out_w, out_h, route, pixel_hash, identity_hash, status, updated_at)
    VALUES (${enlargementId}, ${batchId}, ${productId}, ${sourceId}, 'u', 2, 2, 10, 10, 'direct', 'p', 'i', 'queued', ${at(5).toISOString()}::timestamptz)`);
  return { batchId, chunkId, enlargementId };
}

describe("stall incident while the upscaler is down (M6-F3 acceptance test 1, review P1-1)", () => {
  it("opens although failing enlarge deliveries keep stamping the parked chunk, and resolves when an enlargement settles", async () => {
    const { batchId, chunkId, enlargementId } = await parkedBatch();
    const batch = { id: batchId, isTest: false, name: "November drop", counts: { products: 1 } } as Parameters<typeof refreshLaneProgress>[1];
    // The upscaler is stopped from +5 to +25: Cloud Tasks re-delivers the enlarge task every few minutes, and each
    // delivery runs refreshLaneProgress before its call fails.
    for (let m = 6; m <= 24; m += 3) {
      await refreshLaneProgress({ db, now: () => at(m) }, batch);
      await syncIncidents(db, at(m + 1));
    }
    const [stall] = await rows(sql`SELECT kind, cause_code, started_at, resolved_at FROM catalog_incidents WHERE batch_id = ${batchId}`);
    expect(stall).toMatchObject({ kind: "stall", cause_code: "enlarge_wait", resolved_at: null });
    expect(new Date(String(stall!.started_at)).toISOString()).toBe(at(5).toISOString());

    // Back at +25: the enlargement settles, the chunk finishes, the batch is done.
    await db.execute(sql`UPDATE catalog_enlargements SET status = 'done', updated_at = ${at(27).toISOString()}::timestamptz WHERE id = ${enlargementId}`);
    await db.execute(sql`UPDATE catalog_chunks SET status = 'done', finished_at = ${at(29).toISOString()}::timestamptz WHERE id = ${chunkId}`);
    await syncIncidents(db, at(30));
    const [resolved] = await rows(sql`SELECT resolved_at FROM catalog_incidents WHERE batch_id = ${batchId}`);
    expect(new Date(String(resolved!.resolved_at)).toISOString()).toBe(at(30).toISOString());
    await db.execute(sql`UPDATE catalog_batches SET status = 'done', finished_at = ${at(32).toISOString()}::timestamptz, updated_at = ${at(32).toISOString()}::timestamptz WHERE id = ${batchId}`);
    expect(await recordBatchOutcome(db, batchId, at(33))).toMatchObject({ success: false, cause: "incident", incidents: 1 });
  });

  it("does not open for a batch queued behind another batch's enlargements while the lane moves", async () => {
    const waiting = await parkedBatch();
    const moving = await parkedBatch();
    // The other batch's enlargements settle every few minutes; this one waits its turn on the same lane.
    for (let m = 6; m <= 24; m += 3) {
      await db.execute(sql`UPDATE catalog_enlargements SET status = 'done', updated_at = ${at(m).toISOString()}::timestamptz WHERE id = ${moving.enlargementId}`);
      await syncIncidents(db, at(m + 1));
    }
    expect(await rows(sql`SELECT kind FROM catalog_incidents WHERE batch_id = ${waiting.batchId}`)).toEqual([]);
  });
});
