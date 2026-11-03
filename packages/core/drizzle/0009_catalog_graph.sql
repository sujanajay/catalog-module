-- M0 catalog graph (docs/program/requirements/M0-catalog-graph.md 3.1 and 7.1, slice M0-S1): options, channel
-- listings and their keys, the key mapping, assets, content versions, the change log, live intervals, treatment
-- assignments, the backfill and export run tables, the outcome-keys view, and two nullable columns on existing tables
-- (catalog_products.option_id, catalog_outputs.content_version_id). Additive only: no existing column is renamed,
-- dropped or retyped, and old code ignores the new columns. Re-runnable: IF NOT EXISTS everywhere, foreign keys added
-- only when missing, the view replaced. The two new columns on existing tables are all null, so their foreign key checks
-- and indexes take seconds. A short lock timeout makes the migrate job fail and stay re-runnable instead of queueing
-- behind a long transaction.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_assets" (
	"sha256" text PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"uri" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" bigint,
	"phash" bigint,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_assets_sha256_check" CHECK ("catalog_assets"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_backfill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"job" text NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_change_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"idempotency_key" text NOT NULL,
	"listing_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"from_version_id" uuid,
	"to_version_id" uuid,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" text NOT NULL,
	"evidence_ref" text,
	"actor" text NOT NULL,
	"reason_kind" text NOT NULL,
	"reason_ref" text,
	"change_type_id" text,
	"change_set_id" uuid,
	"batch_id" uuid,
	"experiment_id" text,
	CONSTRAINT "catalog_change_events_idempotency_key_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "catalog_change_events_slot_check" CHECK ("catalog_change_events"."slot" ~ '^(image|title|bullet|description|attribute|size_chart|keyword)(:[1-9][0-9]*)?$'),
	CONSTRAINT "catalog_change_events_kind_check" CHECK ("catalog_change_events"."kind" IN ('planned', 'links_delivered', 'submitted', 'verified_live', 'observed_other', 'removed', 'reverted')),
	CONSTRAINT "catalog_change_events_evidence_check" CHECK ("catalog_change_events"."evidence" IN ('channel_field', 'scrape', 'tool_publish', 'channel_upload_record', 'operator', 'backfill')),
	CONSTRAINT "catalog_change_events_reason_kind_check" CHECK ("catalog_change_events"."reason_kind" IN ('rule', 'experiment', 'operator', 'learning', 'outside_change', 'backfill', 'auto_decide', 'rejection_fix', 'new_content')),
	CONSTRAINT "catalog_change_events_change_type_check" CHECK ("catalog_change_events"."change_type_id" IS NOT NULL OR "catalog_change_events"."kind" = 'observed_other' OR "catalog_change_events"."reason_kind" = 'backfill'),
	CONSTRAINT "catalog_change_events_to_version_check" CHECK (("catalog_change_events"."to_version_id" IS NULL) = ("catalog_change_events"."kind" = 'removed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_channel_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"option_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"market" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"first_seen_live_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_channel_listings_option_channel_market_uq" UNIQUE("option_id","channel","market"),
	CONSTRAINT "catalog_channel_listings_channel_check" CHECK ("catalog_channel_listings"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_channel_listings_market_check" CHECK ("catalog_channel_listings"."market" IN ('ae', 'sa', 'ae_sa')),
	CONSTRAINT "catalog_channel_listings_status_check" CHECK ("catalog_channel_listings"."status" IN ('unknown', 'live', 'not_live', 'not_listed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"option_id" uuid,
	"scope" text NOT NULL,
	"component" text NOT NULL,
	"role" text,
	"position" integer,
	"source" text NOT NULL,
	"ai_generated" boolean NOT NULL,
	"producer" text NOT NULL,
	"producer_ref" text,
	"asset_sha256" text,
	"text_value" text,
	"json_value" jsonb,
	"content_hash" text NOT NULL,
	"hash_kind" text DEFAULT 'sha256' NOT NULL,
	"parent_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"public_url" text,
	"language" text,
	"market" text,
	"route_id" text,
	"prompt_version" text,
	"settings_snapshot_id" text,
	"batch_id" uuid,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_content_versions_identity_uq" UNIQUE NULLS NOT DISTINCT("option_id","scope","component","content_hash","producer","producer_ref"),
	CONSTRAINT "catalog_content_versions_scope_check" CHECK ("catalog_content_versions"."scope" IN ('master', 'noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_content_versions_component_check" CHECK ("catalog_content_versions"."component" IN ('image', 'title', 'bullet', 'description', 'attribute', 'size_chart', 'keyword')),
	CONSTRAINT "catalog_content_versions_role_check" CHECK ("catalog_content_versions"."role" IN ('front', 'back', 'side', 'detail', 'head_shoulders', 'full_length', 'flat', 'packshot', 'size_chart', 'unknown')),
	CONSTRAINT "catalog_content_versions_source_check" CHECK ("catalog_content_versions"."source" IN ('brand', 'scraped_live', 'crop', 'cleanup', 'upscaled', 'generated', 'vendor', 'operator')),
	CONSTRAINT "catalog_content_versions_hash_kind_check" CHECK ("catalog_content_versions"."hash_kind" IN ('sha256', 'crc32c')),
	CONSTRAINT "catalog_content_versions_language_check" CHECK ("catalog_content_versions"."language" IN ('en', 'ar')),
	CONSTRAINT "catalog_content_versions_market_check" CHECK ("catalog_content_versions"."market" IN ('ae', 'sa', 'ae_sa')),
	CONSTRAINT "catalog_content_versions_producer_check" CHECK ("catalog_content_versions"."producer" ~ '^(M([0-9]|1[0-2])|backfill)$'),
	CONSTRAINT "catalog_content_versions_position_check" CHECK ("catalog_content_versions"."position" >= 1),
	CONSTRAINT "catalog_content_versions_ai_generated_check" CHECK ("catalog_content_versions"."source" <> 'generated' OR "catalog_content_versions"."ai_generated"),
	CONSTRAINT "catalog_content_versions_payload_check" CHECK (num_nonnulls("catalog_content_versions"."asset_sha256", "catalog_content_versions"."text_value", "catalog_content_versions"."json_value") = 1 OR (num_nonnulls("catalog_content_versions"."asset_sha256", "catalog_content_versions"."text_value", "catalog_content_versions"."json_value") = 0 AND "catalog_content_versions"."hash_kind" = 'crc32c'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_graph_export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_per_table" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_seq" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_key_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"sku_column" text NOT NULL,
	"channel" text,
	"market" text,
	"key_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_key_mappings_org_column_uq" UNIQUE("org_id","sku_column"),
	CONSTRAINT "catalog_key_mappings_sku_column_check" CHECK ("catalog_key_mappings"."sku_column" IN ('namshi_ae', 'namshi_sa', 'child_zsku', 'noon_ae', 'noon_sa', 'trendyol', 'centerpoint_ae_ksa', 'sixth_street_ae', 'sixth_street_sa', 'styli_ae_ksa', 'styli_sku', 'amazon', 'voga_closet', 'shein', 'amazon_uae_ksa_asin')),
	CONSTRAINT "catalog_key_mappings_channel_check" CHECK ("catalog_key_mappings"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_key_mappings_market_check" CHECK ("catalog_key_mappings"."market" IN ('ae', 'sa', 'ae_sa')),
	CONSTRAINT "catalog_key_mappings_key_kind_check" CHECK ("catalog_key_mappings"."key_kind" IN ('zsku', 'child_zsku', 'partner_sku', 'barcode', 'asin', 'seller_sku', 'style_id'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_listing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"listing_id" uuid NOT NULL,
	"opptra_sku" text,
	"channel" text NOT NULL,
	"market" text NOT NULL,
	"key_kind" text NOT NULL,
	"key_value" text NOT NULL,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_listing_keys_channel_market_kind_value_uq" UNIQUE("channel","market","key_kind","key_value"),
	CONSTRAINT "catalog_listing_keys_channel_check" CHECK ("catalog_listing_keys"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_listing_keys_market_check" CHECK ("catalog_listing_keys"."market" IN ('ae', 'sa', 'ae_sa')),
	CONSTRAINT "catalog_listing_keys_key_kind_check" CHECK ("catalog_listing_keys"."key_kind" IN ('zsku', 'child_zsku', 'partner_sku', 'barcode', 'asin', 'seller_sku', 'style_id')),
	CONSTRAINT "catalog_listing_keys_source_check" CHECK ("catalog_listing_keys"."source" IN ('master', 'sales', 'channel_report', 'scrape', 'manual')),
	CONSTRAINT "catalog_listing_keys_key_value_check" CHECK (btrim("catalog_listing_keys"."key_value") <> '' AND "catalog_listing_keys"."key_value" <> '0')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_live_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"listing_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"version_id" uuid,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_live_intervals_listing_slot_from_uq" UNIQUE("listing_id","slot","valid_from"),
	CONSTRAINT "catalog_live_intervals_slot_check" CHECK ("catalog_live_intervals"."slot" ~ '^(image|title|bullet|description|attribute|size_chart|keyword)(:[1-9][0-9]*)?$'),
	CONSTRAINT "catalog_live_intervals_state_check" CHECK ("catalog_live_intervals"."state" IN ('verified', 'assumed')),
	CONSTRAINT "catalog_live_intervals_range_check" CHECK ("catalog_live_intervals"."valid_to" IS NULL OR "catalog_live_intervals"."valid_to" > "catalog_live_intervals"."valid_from")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"brand_slug" text NOT NULL,
	"option_key" text NOT NULL,
	"key_source" text NOT NULL,
	"line" text,
	"product_type" text,
	"department" text,
	"audience" text,
	"in_master" boolean DEFAULT true NOT NULL,
	"style_key" text,
	"style_key_source" text,
	"style_key_confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_options_brand_option_key_uq" UNIQUE("brand_slug","option_key"),
	CONSTRAINT "catalog_options_key_source_check" CHECK ("catalog_options"."key_source" IN ('master', 'sku_option', 'sku_fallback')),
	CONSTRAINT "catalog_options_line_check" CHECK ("catalog_options"."line" IN ('softline', 'hardline')),
	CONSTRAINT "catalog_options_style_key_source_check" CHECK ("catalog_options"."style_key_source" IN ('brand_style_code', 'name_colour_rule', 'own_cluster')),
	CONSTRAINT "catalog_options_style_key_confidence_check" CHECK ("catalog_options"."style_key_confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_treatment_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"experiment_id" text NOT NULL,
	"listing_id" uuid NOT NULL,
	"arm" text NOT NULL,
	"pair_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	"do_not_touch" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "catalog_treatment_assignments_experiment_listing_uq" UNIQUE("experiment_id","listing_id"),
	CONSTRAINT "catalog_treatment_assignments_arm_check" CHECK ("catalog_treatment_assignments"."arm" IN ('treatment', 'control', 'excluded'))
);
--> statement-breakpoint
ALTER TABLE "catalog_outputs" ADD COLUMN IF NOT EXISTS "content_version_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN IF NOT EXISTS "option_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_change_events_listing_id_catalog_channel_listings_id_fk') THEN
    ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_listing_id_catalog_channel_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."catalog_channel_listings"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_change_events_batch_id_catalog_batches_id_fk') THEN
    ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_change_events_from_version_id_fk') THEN
    ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_from_version_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."catalog_content_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_change_events_to_version_id_fk') THEN
    ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_to_version_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."catalog_content_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_channel_listings_option_id_catalog_options_id_fk') THEN
    ALTER TABLE "catalog_channel_listings" ADD CONSTRAINT "catalog_channel_listings_option_id_catalog_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."catalog_options"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_content_versions_option_id_catalog_options_id_fk') THEN
    ALTER TABLE "catalog_content_versions" ADD CONSTRAINT "catalog_content_versions_option_id_catalog_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."catalog_options"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_content_versions_asset_sha256_catalog_assets_sha256_fk') THEN
    ALTER TABLE "catalog_content_versions" ADD CONSTRAINT "catalog_content_versions_asset_sha256_catalog_assets_sha256_fk" FOREIGN KEY ("asset_sha256") REFERENCES "public"."catalog_assets"("sha256") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_content_versions_batch_id_catalog_batches_id_fk') THEN
    ALTER TABLE "catalog_content_versions" ADD CONSTRAINT "catalog_content_versions_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_listing_keys_listing_id_catalog_channel_listings_id_fk') THEN
    ALTER TABLE "catalog_listing_keys" ADD CONSTRAINT "catalog_listing_keys_listing_id_catalog_channel_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."catalog_channel_listings"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_live_intervals_listing_id_fk') THEN
    ALTER TABLE "catalog_live_intervals" ADD CONSTRAINT "catalog_live_intervals_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."catalog_channel_listings"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_live_intervals_version_id_fk') THEN
    ALTER TABLE "catalog_live_intervals" ADD CONSTRAINT "catalog_live_intervals_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."catalog_content_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_treatment_assignments_listing_id_fk') THEN
    ALTER TABLE "catalog_treatment_assignments" ADD CONSTRAINT "catalog_treatment_assignments_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."catalog_channel_listings"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_change_events_listing_slot_at_idx" ON "catalog_change_events" USING btree ("listing_id","slot","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_change_events_experiment_id_idx" ON "catalog_change_events" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_content_versions_option_id_idx" ON "catalog_content_versions" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_content_versions_asset_sha256_idx" ON "catalog_content_versions" USING btree ("asset_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_content_versions_batch_id_idx" ON "catalog_content_versions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_listing_keys_opptra_sku_idx" ON "catalog_listing_keys" USING btree ("opptra_sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_listing_keys_listing_id_idx" ON "catalog_listing_keys" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_options_option_key_idx" ON "catalog_options" USING btree ("option_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_options_style_key_idx" ON "catalog_options" USING btree ("style_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_treatment_assignments_active_idx" ON "catalog_treatment_assignments" USING btree ("listing_id") WHERE "catalog_treatment_assignments"."released_at" IS NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_outputs_content_version_id_fk') THEN
    ALTER TABLE "catalog_outputs" ADD CONSTRAINT "catalog_outputs_content_version_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."catalog_content_versions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_products_option_id_catalog_options_id_fk') THEN
    ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_option_id_catalog_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."catalog_options"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_outputs_content_version_id_idx" ON "catalog_outputs" USING btree ("content_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_products_option_id_idx" ON "catalog_products" USING btree ("option_id");--> statement-breakpoint
CREATE OR REPLACE VIEW "public"."catalog_outcome_keys" AS (select "catalog_listing_keys"."listing_id", "catalog_channel_listings"."option_id", "catalog_channel_listings"."channel", "catalog_channel_listings"."market", "catalog_listing_keys"."key_kind", "catalog_listing_keys"."key_value", "catalog_listing_keys"."opptra_sku", "catalog_listing_keys"."org_id" from "catalog_listing_keys" inner join "catalog_channel_listings" on "catalog_channel_listings"."id" = "catalog_listing_keys"."listing_id");