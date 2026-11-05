-- M1-S6 follow-up batches (docs/program/requirements/M1-intake.md M1-F5-R2, D25 and D30): adding inputs to a started
-- batch makes a linked follow-up batch, which names the batch it adds to in catalog_batches.parent_batch_id, and the
-- follow-up's shot numbers are held per product in catalog_shot_numbers (primary key product_id, n), so two batches
-- can never hold one number. Additive only: one nullable column with no default, a new empty table, their indexes and
-- foreign keys. The self-referencing key on catalog_batches is added NOT VALID (existing rows are all null, so nothing
-- is scanned; new rows are checked); deleting a parent leaves its follow-ups standing (ON DELETE SET NULL). Re-runnable:
-- IF NOT EXISTS everywhere and the foreign keys only when missing. Numbered 0023 at the merge with main (M1 D3).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_batches" ADD COLUMN IF NOT EXISTS "parent_batch_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_batches_parent_batch_id_fk') THEN
    ALTER TABLE "catalog_batches" ADD CONSTRAINT "catalog_batches_parent_batch_id_fk" FOREIGN KEY ("parent_batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_batches_parent_batch_id_idx" ON "catalog_batches" USING btree ("parent_batch_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_shot_numbers" (
	"product_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"batch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_shot_numbers_product_id_n_pk" PRIMARY KEY("product_id","n")
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_shot_numbers_product_id_catalog_products_id_fk') THEN
    ALTER TABLE "catalog_shot_numbers" ADD CONSTRAINT "catalog_shot_numbers_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_shot_numbers_batch_id_catalog_batches_id_fk') THEN
    ALTER TABLE "catalog_shot_numbers" ADD CONSTRAINT "catalog_shot_numbers_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_shot_numbers_batch_id_idx" ON "catalog_shot_numbers" USING btree ("batch_id");
