-- M1-S6 follow-up batches (docs/program/requirements/M1-intake.md M1-F5-R2): adding inputs to a started batch makes a
-- linked follow-up batch, which names the batch it adds to in catalog_batches.parent_batch_id. Additive only: one
-- nullable column with no default (a catalog-only change on the existing table), its index and a self-referencing
-- foreign key added NOT VALID (existing rows are all null, so nothing is scanned; new rows are checked). Deleting a
-- parent leaves its follow-ups standing (ON DELETE SET NULL). Re-runnable: IF NOT EXISTS everywhere and the foreign key
-- only when missing. Numbered 0021 for now; the number is taken at merge (M1 D3, roadmap 3.2).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_batches" ADD COLUMN IF NOT EXISTS "parent_batch_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_batches_parent_batch_id_fk') THEN
    ALTER TABLE "catalog_batches" ADD CONSTRAINT "catalog_batches_parent_batch_id_fk" FOREIGN KEY ("parent_batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_batches_parent_batch_id_idx" ON "catalog_batches" USING btree ("parent_batch_id");
