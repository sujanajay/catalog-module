-- M1-S4 improvement tasks (docs/program/requirements/M1-intake.md M1-F3-R4, R5, D11; numbered 0015 after M1-S3's 0014; parallel slices
-- renumber at merge). Additive: one new table and two new indexes; nothing
-- existing changes. IF NOT EXISTS keeps a re-run harmless.
-- Locks: the short lock timeout (as 0004-0012) keeps the migrate job re-runnable instead of queueing live writes behind
-- it. CONCURRENTLY is not possible: the drizzle migrator runs pending files in one transaction, so every lock is held
-- to the commit. The partial index on catalog_outputs is therefore built first, while it is the only lock this file
-- holds; it blocks writes (not reads) on catalog_outputs for its heap scan, estimated seconds for about 0.5 M rows and
-- up to 2-3 minutes cold for about 2 M rows on the live tier (db-custom-2-7680). Migrate while no batch runs; check the
-- size first (pg_class.reltuples, pg_relation_size for catalog_outputs) and, above about 1 GB of heap, build the index
-- CONCURRENTLY from an infra script first (the IF NOT EXISTS below is then a no-op). The new table and its foreign key
-- (a short lock on catalog_batches) come after, so that lock is held only for the moments before the commit.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
-- The improvement sweep's candidate query (every 10 minutes) reads only the live provisional plain renders.
CREATE INDEX IF NOT EXISTS "catalog_outputs_provisional_plain_idx" ON "catalog_outputs" USING btree ("published_at") WHERE "catalog_outputs"."is_live" AND "catalog_outputs"."status" = 'verified' AND "catalog_outputs"."flags" @> '["provisional", "enlargement_failed"]'::jsonb;--> statement-breakpoint
-- catalog_improvements: one row per batch and photo whose plain render was delivered `provisional` (or re-made by Try
-- again): tries made, the last try, the delivered outputs kept while a re-make runs (`previous`), when it was improved
-- or why it ended.
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
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_improvements_batch_photo_uq" ON "catalog_improvements" USING btree ("batch_id","source_image_id");
