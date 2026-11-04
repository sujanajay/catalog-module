-- M1-S4 improvement tasks (docs/program/requirements/M1-intake.md M1-F3-R4, R5, D11, D13; numbered 0019 so parallel
-- slices can take the numbers between; renumber at merge if needed). Additive: one new table, one new nullable column,
-- two new indexes; nothing existing changes. IF NOT EXISTS keeps a re-run harmless.
-- catalog_improvements: one row per batch and photo whose plain render was delivered `provisional`: tries made, the
-- last try, the delivered outputs kept while a try runs (`previous`), when it was improved or why it ended.
-- Review round 2: the short lock timeout (as 0004-0012) keeps the migrate job re-runnable instead of queueing live
-- writes behind it. CONCURRENTLY is not possible: the drizzle migrator runs pending files in one transaction. The
-- partial index build holds writes on catalog_outputs while it scans the table (estimate: seconds per 100k rows on
-- db-f1-micro), so migrate while no batch runs; check the size first (pg_class.reltuples for catalog_outputs) and,
-- above about 500k rows, build the index CONCURRENTLY from an infra script first (this IF NOT EXISTS is then a no-op).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_improvements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source_image_id" uuid NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"last_tried_at" timestamp with time zone,
	"improved_at" timestamp with time zone,
	"previous" jsonb,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_improvements_end_reason_check" CHECK ("catalog_improvements"."end_reason" IN ('superseded', 'not_passed')),
	CONSTRAINT "catalog_improvements_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Owner decision 2026-11-04 (D13): since when the upscaler has been unreachable for a queued enlargement.
ALTER TABLE "catalog_enlargements" ADD COLUMN IF NOT EXISTS "delayed_since" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_improvements_batch_photo_uq" ON "catalog_improvements" USING btree ("batch_id","source_image_id");--> statement-breakpoint
-- The improvement sweep's candidate query (every 10 minutes) reads only the live provisional plain renders.
CREATE INDEX IF NOT EXISTS "catalog_outputs_provisional_plain_idx" ON "catalog_outputs" USING btree ("published_at") WHERE "catalog_outputs"."is_live" AND "catalog_outputs"."status" = 'verified' AND "catalog_outputs"."flags" @> '["provisional", "enlargement_failed"]'::jsonb;
