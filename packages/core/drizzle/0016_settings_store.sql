-- M12-S1 settings store (docs/program/requirements/M12-admin-self-serve.md M12-F1, slice M12-S1): every setting value
-- as an append-only version (catalog_setting_versions, the setting.changed record), the version set each batch reads
-- once at Start (catalog_settings_snapshots), and a nullable settings_snapshot_id on catalog_batches and
-- catalog_outputs. Additive only: two new tables and two nullable columns; nothing existing is renamed, dropped or
-- retyped, and old code ignores the new columns. Re-runnable: IF NOT EXISTS everywhere, foreign keys added only when
-- missing. On the two existing tables every statement is cheap whatever their size: ADD COLUMN of a nullable column
-- with no default is a catalog-only change, and the two foreign keys are added NOT VALID (no scan of existing rows,
-- which are all null; new rows are checked). Numbered 0016 at merge, after M0-S2 0013, M1-S3 0014 and M1-S4 0015.
-- (roadmap 3.2). No seed rows: an unset setting reads its registry default.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_setting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"key" text NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb,
	"schema_version" integer NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text,
	"reverts_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_setting_versions_version_check" CHECK ("catalog_setting_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_settings_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"batch_id" uuid,
	"data" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_batches" ADD COLUMN IF NOT EXISTS "settings_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "catalog_outputs" ADD COLUMN IF NOT EXISTS "settings_snapshot_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_setting_versions_reverts_version_id_fk') THEN
    ALTER TABLE "catalog_setting_versions" ADD CONSTRAINT "catalog_setting_versions_reverts_version_id_fk" FOREIGN KEY ("reverts_version_id") REFERENCES "public"."catalog_setting_versions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_settings_snapshots_batch_id_catalog_batches_id_fk') THEN
    ALTER TABLE "catalog_settings_snapshots" ADD CONSTRAINT "catalog_settings_snapshots_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_setting_versions_org_key_scope_version_uq" ON "catalog_setting_versions" USING btree ("org_id","key","scope_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_settings_snapshots_batch_id_idx" ON "catalog_settings_snapshots" USING btree ("batch_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_batches_settings_snapshot_id_fk') THEN
    ALTER TABLE "catalog_batches" ADD CONSTRAINT "catalog_batches_settings_snapshot_id_fk" FOREIGN KEY ("settings_snapshot_id") REFERENCES "public"."catalog_settings_snapshots"("id") ON DELETE no action ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_outputs_settings_snapshot_id_fk') THEN
    ALTER TABLE "catalog_outputs" ADD CONSTRAINT "catalog_outputs_settings_snapshot_id_fk" FOREIGN KEY ("settings_snapshot_id") REFERENCES "public"."catalog_settings_snapshots"("id") ON DELETE no action ON UPDATE no action NOT VALID;
  END IF;
END $$;
