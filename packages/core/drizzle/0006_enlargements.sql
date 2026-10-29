-- Spec 18 enlargement lifecycle (docs/plans/2026-10-29-spec-18-enlargement-lifecycle.md 3.1): one row per (batch,
-- photo, identity) a batch wants, owned by the lifecycle module. Additive and safe on the live database: a new table
-- (IF NOT EXISTS, so a re-run is harmless), its indexes, and the product events CHECK re-created with two new kinds
-- (enlargement_retried, plain_accepted), which old code never writes. No existing table is rewritten. A short lock
-- timeout makes the migrate job fail and stay re-runnable instead of queueing behind a long transaction.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_enlargements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action,
	"product_id" uuid NOT NULL,
	"source_image_id" uuid NOT NULL,
	"upscaler" text NOT NULL,
	"factor" integer NOT NULL,
	"scale" real NOT NULL,
	"out_w" integer NOT NULL,
	"out_h" integer NOT NULL,
	"route" text NOT NULL,
	"pixel_hash" text NOT NULL,
	"identity_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"wanted" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"timeouts" integer DEFAULT 0 NOT NULL,
	"delays" integer DEFAULT 0 NOT NULL,
	"probe_timeouts" integer DEFAULT 0 NOT NULL,
	"identity_releases" integer DEFAULT 0 NOT NULL,
	"sends" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"tiles_done" integer DEFAULT 0 NOT NULL,
	"uri" text,
	"error" text,
	"error_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_enlargements_status_check" CHECK ("catalog_enlargements"."status" IN ('queued', 'done', 'failed')),
	CONSTRAINT "catalog_enlargements_route_check" CHECK ("catalog_enlargements"."route" IN ('direct', 'tiles', 'downscale', 'downscale_tiles', 'none'))
);;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_enlargements_batch_id_idx" ON "catalog_enlargements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_enlargements_source_image_id_idx" ON "catalog_enlargements" USING btree ("source_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_enlargements_identity_uq" ON "catalog_enlargements" USING btree ("batch_id","source_image_id","identity_hash");--> statement-breakpoint
ALTER TABLE "catalog_product_events" DROP CONSTRAINT IF EXISTS "catalog_product_events_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_product_events" ADD CONSTRAINT "catalog_product_events_kind_check" CHECK ("catalog_product_events"."kind" IN ('created', 'overwritten', 'shots_removed', 'channel_added', 'unchanged', 'reordered', 'sku_ids_added', 'alias_added', 'removed_photo', 'replacement_uploaded', 'restored', 'removed', 'enlargement_retried', 'plain_accepted'));
