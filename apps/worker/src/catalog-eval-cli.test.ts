import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { toGsUri } from "@catalog/core/storage";
import { assertBrandInMaster, cleanupEvalSet } from "./catalog-eval-cli";

/** Tier 2 (PGlite): the real migration via createTestDb; storage is a fake. */
let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

async function insertEvalBatch(set: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO catalog_batches (id, brand_slug, brand_name, name, status, is_test, product_type, channels, options, counts, cost, created_by)
    VALUES (${id}, 'uspa', 'USPA', ${`catalog-test eval ${set}`}, 'draft', true, 'auto', '[]'::jsonb, ${JSON.stringify({ evalSet: set, ...extra })}::jsonb, '{}'::jsonb, '{}'::jsonb, 'catalog-eval@opptra.com')`);
  return id;
}
const fakeStorage = () => ({ getBucketName: () => "image-links-agent-assets", toGsUri, deleteTestObjects: vi.fn(async () => 3) });

it("assemble's brand check fails early with a plain message for a brand not in the brand master", async () => {
  await expect(assertBrandInMaster(db, "anta")).rejects.toThrow(/Brand anta is not in the brand master.*Nothing was written/);
  await db.execute(sql`INSERT INTO brand_master (name, slug, line, source) VALUES ('Anta', 'anta', 'softline', 'manual')`);
  await expect(assertBrandInMaster(db, "anta")).resolves.toBeUndefined();
});

it("cleanup --set removes only catalog-test/eval/<set>/ (with the trailing slash) when the set has no eval batch", async () => {
  await insertEvalBatch("anta-2");
  await insertEvalBatch("anta", { cleanedUp: true });
  const storage = fakeStorage();
  expect(await cleanupEvalSet(db, storage, "anta")).toEqual({ set: "anta", folder: "gs://image-links-agent-assets/catalog-test/eval/anta/", objects: 3 });
  expect(storage.deleteTestObjects).toHaveBeenCalledExactlyOnceWith("gs://image-links-agent-assets/catalog-test/eval/anta/");
});

it("cleanup --set refuses while the set still has eval batches, and rejects a bad set name", async () => {
  const id = await insertEvalBatch("anta");
  const storage = fakeStorage();
  await expect(cleanupEvalSet(db, storage, "anta")).rejects.toThrow(new RegExp(`still has eval batches \\(${id}\\)`));
  await expect(cleanupEvalSet(db, storage, "../catalog")).rejects.toThrow(/Invalid eval set name/);
  expect(storage.deleteTestObjects).not.toHaveBeenCalled();
});
