-- Spec 18 (release H, owner decision 3 of 2026-10-29): per-photo state of the stored enlargement (the upscaler's
-- 2x image, made once by the enlarge task and read by the render). Additive and safe on a live database: nullable
-- columns plus one with a constant default (no table rewrite), and code from before 0005 never reads them. IF NOT
-- EXISTS keeps a re-run harmless. A short lock timeout makes the migrate job fail and stay re-runnable instead of
-- queueing behind a long transaction.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_source_images"
  ADD COLUMN IF NOT EXISTS "x2_uri" text,
  ADD COLUMN IF NOT EXISTS "x2_model" text,
  ADD COLUMN IF NOT EXISTS "x2_error" text,
  ADD COLUMN IF NOT EXISTS "x2_attempts" integer DEFAULT 0 NOT NULL;
