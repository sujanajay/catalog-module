-- M1-S4 improvement tasks (docs/program/requirements/M1-intake.md M1-F3-R4, R5; numbered 0019 so parallel slices can take
-- the numbers between; renumber at merge if needed). Additive: one new table, nothing existing changes. One row per batch
-- and photo whose plain render was delivered `provisional`: tries made, the last try, and when it was improved.
-- IF NOT EXISTS keeps a re-run harmless.
CREATE TABLE IF NOT EXISTS "catalog_improvements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source_image_id" uuid NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"last_tried_at" timestamp with time zone,
	"improved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_improvements_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_improvements_batch_photo_uq" ON "catalog_improvements" USING btree ("batch_id","source_image_id");
