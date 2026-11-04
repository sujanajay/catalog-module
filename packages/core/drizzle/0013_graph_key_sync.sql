-- M0-S2 graph key sync (docs/program/requirements/M0-catalog-graph.md F1-R3 and F1-R5; decisions D10 and D15 to D19):
-- the key conflict list, and the seed of catalog_key_mappings that 0009 shipped empty. Additive only: one new table and
-- data rows in a table no code wrote before. Re-runnable: IF NOT EXISTS on the table, ON CONFLICT DO NOTHING on the seed,
-- so a mapping an admin later changes is never overwritten by a re-run. The short lock timeout keeps the migrate job
-- re-runnable instead of queueing behind a long transaction.
--
-- The seed comes from the read-only BigQuery key-coverage check of 2026-11-04 (raw_gcc_dimensions.master_sl against
-- fact_gcc.unified_sales_tertiary_v2 and the channel reports). key_kind names who issued the code: zsku and child_zsku
-- are channel-issued ids at option and size level (the Z-codes of Namshi and Noon, the numeric ids of Styli and
-- Centrepoint, the Shein option id); partner_sku is our own code as entered on the channel; barcode is the EAN; asin is
-- Amazon's id. channel null (child_zsku): the key goes on every listing of the SKU. market null (trendyol, amazon): the
-- market comes from the sales rows of that key, else ae_sa. voga_closet has no row: it holds the flag 'PASS', not a key.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_key_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"channel" text NOT NULL,
	"market" text NOT NULL,
	"key_kind" text NOT NULL,
	"key_value" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "catalog_key_conflicts_org_key_uq" UNIQUE("org_id","channel","market","key_kind","key_value"),
	CONSTRAINT "catalog_key_conflicts_channel_check" CHECK ("catalog_key_conflicts"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_key_conflicts_market_check" CHECK ("catalog_key_conflicts"."market" IN ('ae', 'sa', 'ae_sa')),
	CONSTRAINT "catalog_key_conflicts_key_kind_check" CHECK ("catalog_key_conflicts"."key_kind" IN ('zsku', 'child_zsku', 'partner_sku', 'barcode', 'asin', 'seller_sku', 'style_id'))
);
--> statement-breakpoint
INSERT INTO "catalog_key_mappings" ("sku_column", "channel", "market", "key_kind") VALUES
	('namshi_ae', 'namshi', 'ae', 'zsku'),
	('namshi_sa', 'namshi', 'sa', 'zsku'),
	('child_zsku', NULL, NULL, 'child_zsku'),
	('noon_ae', 'noon', 'ae', 'partner_sku'),
	('noon_sa', 'noon', 'sa', 'partner_sku'),
	('trendyol', 'trendyol', NULL, 'barcode'),
	('centerpoint_ae_ksa', 'centrepoint', 'ae_sa', 'child_zsku'),
	('sixth_street_ae', 'sixthstreet', 'ae', 'partner_sku'),
	('sixth_street_sa', 'sixthstreet', 'sa', 'partner_sku'),
	('styli_ae_ksa', 'styli', 'ae_sa', 'zsku'),
	('styli_sku', 'styli', 'ae_sa', 'child_zsku'),
	('amazon', 'amazon', NULL, 'asin'),
	('amazon_uae_ksa_asin', 'amazon', NULL, 'asin'),
	('shein', 'shein', 'ae_sa', 'zsku')
ON CONFLICT ("org_id", "sku_column") DO NOTHING;
