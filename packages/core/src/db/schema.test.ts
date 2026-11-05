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
  "catalog_batch_products", "catalog_shot_numbers", "catalog_product_aliases", "catalog_product_events", "catalog_source_images",
  "catalog_outputs", "catalog_chunks", "catalog_eval_labels", "catalog_eval_judgements", "spend_days",
  "users", // 0001_users.sql (spec 03)
  "catalog_cost_events", // 0002_cost_events.sql (observability plan, part A)
  "catalog_enlargements", // 0006_enlargements.sql (spec 18 lifecycle)
  // 0009_catalog_graph.sql (M0-S1), the outcome-keys view included
  "catalog_options", "catalog_channel_listings", "catalog_listing_keys", "catalog_key_mappings", "catalog_assets",
  "catalog_content_versions", "catalog_change_events", "catalog_live_intervals", "catalog_treatment_assignments",
  "catalog_backfill_runs", "catalog_graph_export_runs", "catalog_outcome_keys",
  // 0010_taxonomy.sql (M2-S1 taxonomy store)
  "catalog_taxonomy_nodes", "catalog_attribute_defs", "catalog_shot_roles", "catalog_taxonomy_changes",
  "vendor_routes", "vendor_route_changes", // 0011_vendor_routes.sql (M7-S2)
  "catalog_key_conflicts", // 0013_graph_key_sync.sql (M0-S2)
  "catalog_auto_decide_rules", // 0014_auto_decide_rules.sql (M1-S3)
  "catalog_improvements", // 0015_improvements.sql (M1-S4)
  "catalog_setting_versions", "catalog_settings_snapshots", // 0016_settings_store.sql (M12-S1)
  // 0017_channel_rules.sql (M5-S1 channel rules store)
  "catalog_rulesets", "catalog_ruleset_snapshots", "catalog_rules", "catalog_rule_conflicts", "catalog_rule_decisions",
  "catalog_channel_records", "catalog_image_policies", "catalog_rule_results",
  "catalog_change_types", // 0019_change_types.sql (M10-S1a)
  // 0020_batch_outcomes_incidents.sql (M6-S6)
  "catalog_batch_outcomes", "catalog_incidents", "catalog_batch_touches", "catalog_revisions",
  "catalog_upscaler_health", // 0022_upscaler_health.sql (M1-S4b)
  "catalog_cost_days", "catalog_cost_allocations", // 0023_cost_reconciliation.sql (M6-S2)
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
  "vendor_routes_capability_adapter_model_uq", "vendor_routes_capability_rank_idx", "vendor_route_changes_route_id_at_idx",
  "catalog_auto_decide_rules_cause_channel_uq",
  "catalog_improvements_batch_photo_uq",
  "catalog_outputs_provisional_plain_idx",
  "catalog_setting_versions_org_key_scope_version_uq", "catalog_settings_snapshots_batch_id_idx",
  "catalog_rules_ruleset_version_idx", "catalog_rule_decisions_conflict_id_idx", "catalog_rule_results_version_rule_uq",
  "catalog_rule_results_ruleset_version_idx",
  "catalog_batch_outcomes_ended_at_idx", "catalog_incidents_kind_started_at_idx", "catalog_incidents_batch_id_idx",
  "catalog_incidents_dedupe_key_uq", "catalog_batch_touches_batch_id_idx", "catalog_revisions_first_seen_at_idx",
  "catalog_cost_days_day_component_env_source_uq", "catalog_cost_allocations_day_batch_component_uq", "catalog_cost_allocations_batch_id_idx",
  "catalog_batches_parent_batch_id_idx", "catalog_shot_numbers_batch_id_idx", // 0024_follow_up_batches.sql (M1-S6)
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
