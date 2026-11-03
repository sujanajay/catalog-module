// Tier 2 (PGlite; real Postgres when TEST_PG_URL is set), M0-S1 acceptance: 0009_catalog_graph.sql applied over a
// database at 0008 (the live schema, built by the same migrations) that holds a batch with a product, a photo and a
// published output: the graph tables, view, columns, indexes and CHECKs exist, the two new columns on existing tables
// are null and old rows are untouched, and a second run of the file changes nothing, graph rows included.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite, createRealTestDb, TEST_PG_URL } from "./testing";

let db: Db;
let close: () => Promise<void>;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

const GRAPH_TABLES = [
  "catalog_options", "catalog_channel_listings", "catalog_listing_keys", "catalog_key_mappings", "catalog_assets",
  "catalog_content_versions", "catalog_change_events", "catalog_live_intervals", "catalog_treatment_assignments",
  "catalog_backfill_runs", "catalog_graph_export_runs",
];

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const upTo0008 = await mkdtemp(path.join(tmpdir(), "catalog-0008-"));
  try {
    await mkdir(path.join(upTo0008, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const first9 = journal.entries.filter((e) => e.idx <= 8);
    for (const e of first9) await copyFile(path.join(real, `${e.tag}.sql`), path.join(upTo0008, `${e.tag}.sql`));
    await writeFile(path.join(upTo0008, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first9 }));
    if (TEST_PG_URL) {
      ({ db, close } = await createRealTestDb({ migrationsFolder: upTo0008 }));
    } else {
      const created = createDbFromPglite();
      db = created.db;
      close = () => created.client.close();
      await runMigrations(db, upTo0008);
    }
  } finally {
    await rm(upTo0008, { recursive: true, force: true });
  }
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe(`0009_catalog_graph.sql (M0-S1) on ${TEST_PG_URL ? "real Postgres" : "PGlite"}`, () => {
  it("adds the graph over a live-shaped database, leaves old rows untouched, and a second run changes nothing", async () => {
    expect(await rows(sql`select table_name from information_schema.tables where table_name = 'catalog_options'`)).toEqual([]);
    const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'done') returning id`);
    const [product] = await rows<{ id: string }>(sql`insert into catalog_products (brand_slug, is_test, product_key, path_key, identifier) values ('test_brand', true, 'p', 'p', 'p') returning id`);
    const [photo] = await rows<{ id: string }>(sql`insert into catalog_source_images (product_id, batch_id, n, sha256, original_name, raw_uri, mime) values (${product!.id}, ${batch!.id}, 1, 'abc', 'p_1.jpg', 'gs://a/p_1.jpg', 'image/jpeg') returning id`);
    await db.execute(sql`insert into catalog_outputs (batch_id, product_id, source_image_id, channel, n, canvas_w, canvas_h, scale, placed_x, placed_y, render_key, object_path, public_url, is_live, status, published_at) values (${batch!.id}, ${product!.id}, ${photo!.id}, 'noon', 1, 100, 100, 1, 0, 0, 'rk', 'catalog-test/p/noon/1.jpg', 'https://x/1.jpg', true, 'verified', now())`);

    await runMigrations(db, resolveMigrationsFolder());
    const journal = JSON.parse(await readFile(path.join(resolveMigrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0009_catalog_graph");
    const [applied] = await rows<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied!.n).toBe(journal.entries.length);

    const tables = (await rows<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(GRAPH_TABLES));
    expect(await rows(sql`select table_name from information_schema.views where table_name = 'catalog_outcome_keys'`)).toHaveLength(1);

    // Old rows: untouched, the two new columns null.
    expect(await rows(sql`select option_id, identifier from catalog_products`)).toEqual([{ option_id: null, identifier: "p" }]);
    expect(await rows(sql`select content_version_id, is_live, public_url from catalog_outputs`)).toEqual([{ content_version_id: null, is_live: true, public_url: "https://x/1.jpg" }]);

    const columns = async (table: string) =>
      new Map((await rows<{ column_name: string; is_nullable: string; column_default: string | null }>(sql`select column_name, is_nullable, column_default from information_schema.columns where table_name = ${table}`)).map((c) => [c.column_name, c]));
    for (const table of GRAPH_TABLES) {
      const org = (await columns(table)).get("org_id");
      expect([table, org?.is_nullable, org?.column_default]).toEqual([table, "NO", "'opptra'::text"]);
    }
    const versionCols = await columns("catalog_content_versions");
    for (const name of ["language", "market", "route_id", "prompt_version", "settings_snapshot_id", "parent_version_ids", "ai_generated", "hash_kind"]) expect(versionCols.has(name), name).toBe(true);
    expect(versionCols.get("ai_generated")!.is_nullable).toBe("NO");
    const eventCols = await columns("catalog_change_events");
    // Nullable, with catalog_change_events_reason_check requiring it except on observed_other and backfill rows (D9).
    expect(eventCols.get("reason_kind")!.is_nullable).toBe("YES");
    const checks = (await rows<{ conname: string }>(sql`select conname from pg_constraint where contype = 'c' and conrelid = 'catalog_change_events'::regclass`)).map((r) => r.conname);
    expect(checks).toContain("catalog_change_events_reason_check");
    // catalog_key_mappings ships empty in 0009 (D10); 0013 (M0-S2) seeds it, so after the whole folder it holds only
    // 0013's 14 rows. Its key_kind CHECK holds the doc's list.
    expect(await rows(sql`select count(*)::int as n from catalog_key_mappings`)).toEqual([{ n: 14 }]);
    await expect(db.execute(sql`insert into catalog_key_mappings (sku_column, channel, market, key_kind) values ('noon_ae', 'noon', 'ae', 'gtin')`)).rejects.toThrow();
    for (const name of ["change_type_id", "change_set_id", "experiment_id", "evidence_ref", "reason_ref"]) expect(eventCols.has(name), name).toBe(true);
    const optionCols = await columns("catalog_options");
    for (const name of ["style_key", "style_key_source", "style_key_confidence", "key_source", "in_master"]) expect(optionCols.has(name), name).toBe(true);

    const indexes = (await rows<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public'`)).map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining([
      "catalog_products_option_id_idx", "catalog_outputs_content_version_id_idx", "catalog_options_option_key_idx",
      "catalog_listing_keys_opptra_sku_idx", "catalog_content_versions_option_id_idx", "catalog_content_versions_asset_sha256_idx",
      "catalog_content_versions_batch_id_idx", "catalog_change_events_listing_slot_at_idx", "catalog_change_events_experiment_id_idx",
      "catalog_treatment_assignments_active_idx",
    ]));
    // Cheap on the existing tables: the two foreign keys skip the scan (NOT VALID) and the two indexes are partial.
    expect(await rows(sql`select conname, convalidated from pg_constraint where conname in ('catalog_outputs_content_version_id_fk', 'catalog_products_option_id_catalog_options_id_fk') order by conname`)).toEqual([
      { conname: "catalog_outputs_content_version_id_fk", convalidated: false },
      { conname: "catalog_products_option_id_catalog_options_id_fk", convalidated: false },
    ]);
    const partial = await rows<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname in ('catalog_outputs_content_version_id_idx', 'catalog_products_option_id_idx')`);
    expect(partial).toHaveLength(2);
    for (const p of partial) expect(p.indexdef).toMatch(/WHERE \(\w+ IS NOT NULL\)/);
    expect(await rows(sql`select tgname from pg_trigger where tgname = 'catalog_treatment_assignments_lock_listing'`)).toHaveLength(1);
    const fks = (await rows<{ conname: string }>(sql`select conname from pg_constraint where contype = 'f' and conrelid::regclass::text like 'catalog_%'`)).map((r) => r.conname);
    for (const name of fks) expect(name.length, name).toBeLessThanOrEqual(63);

    // Graph rows before the re-run, to show it keeps them.
    const [option] = await rows<{ id: string }>(sql`insert into catalog_options (brand_slug, option_key, key_source) values ('test_brand', 'opt-1', 'master') returning id`);
    const [listing] = await rows<{ id: string }>(sql`insert into catalog_channel_listings (option_id, channel, market) values (${option!.id}, 'noon', 'ae') returning id`);
    await db.execute(sql`insert into catalog_listing_keys (listing_id, opptra_sku, channel, market, key_kind, key_value, source) values (${listing!.id}, 'SKU1', 'noon', 'ae', 'partner_sku', 'P-1', 'master')`);
    await db.execute(sql`update catalog_products set option_id = ${option!.id}`);
    expect(await rows(sql`select key_kind, key_value, channel, market from catalog_outcome_keys`)).toEqual([{ key_kind: "partner_sku", key_value: "P-1", channel: "noon", market: "ae" }]);

    // CHECKs refuse values outside the lists.
    await expect(db.execute(sql`insert into catalog_channel_listings (option_id, channel, market) values (${option!.id}, 'flipkart', 'ae')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_channel_listings (option_id, channel, market) values (${option!.id}, 'noon', 'in')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_listing_keys (listing_id, channel, market, key_kind, key_value, source) values (${listing!.id}, 'noon', 'ae', 'zsku', '0', 'master')`)).rejects.toThrow();

    // The file again, as a re-run of the migrate job would: nothing changes.
    const file = await readFile(path.join(resolveMigrationsFolder(), "0009_catalog_graph.sql"), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
    });
    await runMigrations(db, resolveMigrationsFolder());
    expect(await rows(sql`select count(*)::int as n from catalog_options`)).toEqual([{ n: 1 }]);
    expect(await rows(sql`select count(*)::int as n from catalog_listing_keys`)).toEqual([{ n: 1 }]);
    expect(await rows(sql`select option_id from catalog_products`)).toEqual([{ option_id: option!.id }]);
    expect(await rows(sql`select key_value from catalog_outcome_keys`)).toEqual([{ key_value: "P-1" }]);
    const fksAfter = (await rows<{ conname: string }>(sql`select conname from pg_constraint where contype = 'f' and conrelid::regclass::text like 'catalog_%'`)).map((r) => r.conname);
    expect(fksAfter.sort()).toEqual([...fks].sort());
  });
});
