-- Spec 15 (release E): chunk leases, step tokens, the batch window and progress. Additive and safe on a live
-- database with chunks in flight: the new columns are added with constant defaults (no table rewrite), and
-- code from before 0004 never reads them. The backfill runs only in the run that adds the columns, so a
-- second run changes nothing: every existing row counts as already dispatched (the window never queues it
-- again) and as a pre-0004 row whose tasks carry no step (step_known = false). A short lock timeout makes
-- the migrate job fail and stay re-runnable instead of queueing behind a long transaction.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'catalog_chunks' AND column_name = 'step_known') THEN
    ALTER TABLE "catalog_chunks"
      ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "step" integer DEFAULT 0 NOT NULL,
      ADD COLUMN "step_known" boolean DEFAULT true NOT NULL,
      ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "progress_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "stalls" integer DEFAULT 0 NOT NULL;
    UPDATE "catalog_chunks" SET "dispatched_at" = coalesce("started_at", "created_at"), "step_known" = false;
  END IF;
END $$;
