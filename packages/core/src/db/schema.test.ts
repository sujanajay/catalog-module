// Tier 2: every generated migration (0000_init.sql, then 0001_users.sql) on a fresh PGlite database.
// The users table's columns, role check and migration order are tested in people.test.ts.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import {
  catalogBatches,
  catalogOutputs,
  catalogProductAliases,
  catalogProducts,
  catalogSourceImages,
} from "./schema";
import { createTestDb } from "./testing";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

const TABLES = [
  "brand_master", "sku_map", "model_policy", "catalog_batches", "catalog_uploads", "catalog_products",
  "catalog_batch_products", "catalog_product_aliases", "catalog_product_events", "catalog_source_images",
  "catalog_outputs", "catalog_chunks", "catalog_eval_labels", "catalog_eval_judgements", "spend_days",
  "users", // 0001_users.sql (spec 03)
  "catalog_cost_events", // 0002_cost_events.sql (observability plan, part A)
];

const INDEXES = [
  "sku_map_brand_slug_idx", "sku_map_option_key_idx", "sku_map_ean_idx", "model_policy_brand_category_uq",
  "catalog_batches_brand_slug_idx", "catalog_uploads_batch_id_idx", "catalog_products_brand_test_key_uq",
  "catalog_products_brand_test_path_uq",
  "catalog_product_aliases_brand_test_key_uq", "catalog_product_events_product_id_idx",
  "catalog_source_images_product_id_idx", "catalog_source_images_product_n_sha_batch_uq",
  "catalog_outputs_batch_id_idx", "catalog_outputs_product_id_idx", "catalog_outputs_live_uq",
  "catalog_chunks_batch_id_idx", "catalog_eval_labels_batch_id_idx", "catalog_eval_judgements_batch_id_idx",
  "catalog_eval_judgements_output_model_uq", "brand_master_slug_unique",
  "catalog_cost_events_batch_id_idx", "catalog_cost_events_brand_slug_at_idx", "catalog_cost_events_output_id_idx",
  "catalog_cost_events_at_idx",
];

describe("generated migrations", () => {
  it("creates every table", async () => {
    const found = (await rows<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )).map((r) => r.table_name);
    expect(found.sort()).toEqual([...TABLES].sort());
  });

  it("creates every index, the live index being partial", async () => {
    const idx = await rows<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const names = idx.map((i) => i.indexname);
    for (const name of INDEXES) expect(names).toContain(name);
    const live = idx.find((i) => i.indexname === "catalog_outputs_live_uq");
    expect(live?.indexdef).toMatch(/UNIQUE INDEX .*\(product_id, channel, n\) WHERE is_live/);
  });

  it("allows two non-live outputs but rejects a second live one per (product, channel, n)", async () => {
    const [batch] = await db.insert(catalogBatches).values({ brandSlug: "uspa", brandName: "USPA", name: "b", createdBy: "t" }).returning();
    const [product] = await db
      .insert(catalogProducts)
      .values({ brandSlug: "uspa", isTest: false, productKey: "LIVE1", pathKey: "LIVE1", identifier: "LIVE1" })
      .returning();
    const [src] = await db
      .insert(catalogSourceImages)
      .values({ productId: product!.id, batchId: batch!.id, n: 1, sha256: "x", originalName: "LIVE1_1.jpg", rawUri: "gs://b/r", mime: "image/jpeg" })
      .returning();
    const out = (isLive: boolean) => ({
      batchId: batch!.id, productId: product!.id, sourceImageId: src!.id, channel: "noon" as const, n: 1,
      canvasW: 1000, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, renderKey: "k",
      objectPath: "catalog/uspa/LIVE1/noon/LIVE1_1.jpg", publicUrl: "https://x/LIVE1_1.jpg", isLive,
    });
    await db.insert(catalogOutputs).values(out(false));
    await db.insert(catalogOutputs).values(out(false));
    await db.insert(catalogOutputs).values(out(true));
    await expect(db.insert(catalogOutputs).values(out(true))).rejects.toThrow();
    // Another channel or shot number is a different slot.
    await db.insert(catalogOutputs).values({ ...out(true), channel: "amazon" });
    await db.insert(catalogOutputs).values({ ...out(true), n: 2 });
  });

  it("rejects duplicate product keys and alias keys per (brand, is_test)", async () => {
    const values = { brandSlug: "uspa", isTest: false, productKey: "DUP1", pathKey: "DUP1", identifier: "DUP1" };
    const [p] = await db.insert(catalogProducts).values(values).returning();
    await expect(db.insert(catalogProducts).values(values)).rejects.toThrow();
    // Another product key on the same path_key would share public paths.
    await expect(db.insert(catalogProducts).values({ ...values, productKey: "DUP(1)" })).rejects.toThrow();
    await db.insert(catalogProducts).values({ ...values, isTest: true });

    const alias = { brandSlug: "uspa", isTest: false, aliasKey: "DUP1", productId: p!.id, kind: "identifier" as const };
    await db.insert(catalogProductAliases).values(alias);
    await expect(db.insert(catalogProductAliases).values({ ...alias, kind: "manual" })).rejects.toThrow();
    await db.insert(catalogProductAliases).values({ ...alias, brandSlug: "penti" });
  });

  it("rejects a value outside an enum array", async () => {
    await expect(
      db.execute(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('uspa', 'USPA', 'x', 't', 'paused')`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into brand_master (name, slug, line, source) values ('A', 'a', 'midline', 'manual')`),
    ).rejects.toThrow();
    await db.execute(sql`insert into brand_master (name, slug, line, source) values ('A', 'a', 'softline', 'manual')`);
  });

  it("fills batch defaults from the contract", async () => {
    const [b] = await db.insert(catalogBatches).values({ brandSlug: "uspa", brandName: "USPA", name: "d", createdBy: "t" }).returning();
    expect(b).toMatchObject({ status: "draft", isTest: false, productType: "auto", channels: [] });
    expect(b!.options).toEqual({ identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null });
    expect(b!.counts.products).toBe(0);
    expect(b!.cost.usdPerIdentifier).toBeNull();
  });
});
