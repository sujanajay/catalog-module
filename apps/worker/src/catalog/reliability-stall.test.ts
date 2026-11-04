// M6-S6 review P1-1 (Tier 2, PGlite): M6-F3 acceptance test 1 with the live lane behaviour. While the upscaler is
// stopped, every enlarge delivery still runs refreshLaneProgress (enlarge.ts step 3), which stamps progress_at on every
// parked chunk. That stamp is a retry, not progress: the stall incident must open anyway, and resolve once an
// enlargement settles.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { ENLARGING_TASK } from "@catalog/core/catalog/pipeline/enlargement";
import { recordBatchOutcome, syncIncidents } from "@catalog/core/catalog/reliability";
import { refreshBatchProgress } from "./deps";
import { refreshLaneProgress } from "./enlarge";

let db: Db;
let close: () => Promise<void>;
const T0 = new Date("2026-11-04T08:00:00Z");
const at = (minutes: number) => new Date(+T0 + minutes * 60_000);
type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

async function parkedBatch(options: { upscaler?: string; products?: number } = {}): Promise<{ batchId: string; chunkId: string; enlargementId: string }> {
  const batchId = randomUUID(), productId = randomUUID(), sourceId = randomUUID(), chunkId = randomUUID(), enlargementId = randomUUID();
  const counts = JSON.stringify({ products: options.products ?? 1 });
  await db.execute(sql`INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, created_by, counts, created_at, started_at, updated_at)
    VALUES (${batchId}, 'uspa', 'USPA', 'November drop', 'rendering', 'op@opptra.com', ${counts}::jsonb, ${T0.toISOString()}::timestamptz, ${T0.toISOString()}::timestamptz, ${at(5).toISOString()}::timestamptz)`);
  await db.execute(sql`INSERT INTO catalog_products (id, brand_slug, is_test, product_key, path_key, identifier) VALUES (${productId}, 'uspa', false, ${`P${productId.slice(0, 8)}`.toUpperCase()}, ${productId}, ${productId})`);
  await db.execute(sql`INSERT INTO catalog_source_images (id, batch_id, product_id, n, sha256, original_name, raw_uri, mime) VALUES (${sourceId}, ${batchId}, ${productId}, 1, 's', 'x.jpg', 'gs://a/x.jpg', 'image/jpeg')`);
  await db.execute(sql`INSERT INTO catalog_chunks (id, batch_id, "index", stage, product_ids, status, task_name, started_at, progress_at)
    VALUES (${chunkId}, ${batchId}, 0, 'render', '[]'::jsonb, 'queued', ${ENLARGING_TASK}, ${at(1).toISOString()}::timestamptz, ${at(5).toISOString()}::timestamptz)`);
  await db.execute(sql`INSERT INTO catalog_enlargements (id, batch_id, product_id, source_image_id, upscaler, factor, scale, out_w, out_h, route, pixel_hash, identity_hash, status, created_at, updated_at)
    VALUES (${enlargementId}, ${batchId}, ${productId}, ${sourceId}, ${options.upscaler ?? "u"}, 2, 2, 10, 10, 'direct', 'p', 'i', 'queued', ${at(5).toISOString()}::timestamptz, ${at(5).toISOString()}::timestamptz)`);
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

  it("opens one incident that stays open while a hung upscaler's counted failures refresh the batch's counts (review 2 P1-R)", async () => {
    const { batchId, chunkId, enlargementId } = await parkedBatch();
    const batch = { id: batchId, isTest: false, name: "November drop", counts: { products: 1 } } as Parameters<typeof refreshLaneProgress>[1];
    // The upscaler hangs from +5: every call times out, the re-probe too, and the failure is counted. A counted failure
    // settles with progress (enlarge.ts afterUnpark), so it refreshes the batch's counts (refreshBatchProgress).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let m = 6; m <= 60; m += 3) {
        vi.setSystemTime(at(m));
        await refreshLaneProgress({ db, now: () => at(m) }, batch);
        await db.execute(sql`UPDATE catalog_enlargements SET attempts = attempts + 1 WHERE id = ${enlargementId}`);
        await refreshBatchProgress(db, batchId, at(m), { force: true });
        await syncIncidents(db, at(m + 1));
        if (m >= 15) {
          const open = await rows(sql`SELECT resolved_at FROM catalog_incidents WHERE batch_id = ${batchId}`);
          expect(open, `at +${m + 1} min`).toEqual([{ resolved_at: null }]);
        }
      }
    } finally { vi.useRealTimers(); }
    const [updated] = await rows(sql`SELECT updated_at FROM catalog_batches WHERE id = ${batchId}`);
    expect(new Date(String(updated!.updated_at)).toISOString(), "the counts write keeps updated_at").toBe(at(5).toISOString());

    // Recovery at +62: the enlargement settles and the chunk finishes; the one incident resolves.
    await db.execute(sql`UPDATE catalog_enlargements SET status = 'done', updated_at = ${at(62).toISOString()}::timestamptz WHERE id = ${enlargementId}`);
    await db.execute(sql`UPDATE catalog_chunks SET status = 'done', finished_at = ${at(63).toISOString()}::timestamptz WHERE id = ${chunkId}`);
    await syncIncidents(db, at(64));
    const all = await rows(sql`SELECT cause_code, started_at, resolved_at FROM catalog_incidents WHERE batch_id = ${batchId}`);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ cause_code: "enlarge_wait" });
    expect(new Date(String(all[0]!.started_at)).toISOString()).toBe(at(5).toISOString());
    expect(new Date(String(all[0]!.resolved_at)).toISOString()).toBe(at(64).toISOString());
  });

  it("does not borrow progress from another upscaler service or the other lane (review 2 P2-A)", async () => {
    const gpuWaiting = await parkedBatch({ upscaler: "realesrgan_x4" });
    const cpuMoving = await parkedBatch({ upscaler: "realesrgan_x4+cpu" });
    const bulkWaiting = await parkedBatch({ upscaler: "realesrgan_x4+cpu", products: 500 });
    const gpuMoving = await parkedBatch({ upscaler: "realesrgan_x4" });
    // The GPU service is down: only CPU rows of an operator batch settle. Then a GPU row of another batch settles.
    for (let m = 6; m <= 24; m += 3) {
      await db.execute(sql`UPDATE catalog_enlargements SET status = 'done', updated_at = ${at(m).toISOString()}::timestamptz WHERE id = ${cpuMoving.enlargementId}`);
      await syncIncidents(db, at(m + 1));
    }
    const kinds = async (id: string) => (await rows(sql`SELECT cause_code FROM catalog_incidents WHERE batch_id = ${id} AND resolved_at IS NULL`)).map((r) => r.cause_code);
    expect(await kinds(gpuWaiting.batchId), "a GPU batch is stalled while only CPU rows move").toEqual(["enlarge_wait"]);
    expect(await kinds(bulkWaiting.batchId), "a bulk batch does not wait on the operator lane").toEqual(["enlarge_wait"]);
    expect(await kinds(gpuMoving.batchId)).toEqual(["enlarge_wait"]);
    // A GPU row of the operator lane settles: the other operator GPU batch is waiting its turn again; the bulk one is not.
    await db.execute(sql`UPDATE catalog_enlargements SET status = 'done', updated_at = ${at(26).toISOString()}::timestamptz WHERE id = ${gpuMoving.enlargementId}`);
    await syncIncidents(db, at(27));
    expect(await kinds(gpuWaiting.batchId)).toEqual([]);
    expect(await kinds(bulkWaiting.batchId)).toEqual(["enlarge_wait"]);
  });
});
