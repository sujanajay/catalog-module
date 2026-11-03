-- M6-S4 and M6-S1 (2026-11-03). Additive only (M6-F2-R1), so the live code and the new code both work on this schema.
-- catalog_cost_events: three nullable columns (component, content_version_id, billable_ms); batch_id and brand_slug
-- become nullable for rows of no batch (a job run, the sweep); stage, kind and outcome take a superset of their values
-- (the old CHECK dropped and a wider one added in the same transaction; NOT VALID, so Postgres does not re-read every
-- ledger row, and every existing row already holds a value of the older, smaller set). catalog_uploads.ingest_failures
-- counts the failed ingest deliveries of an upload in a row (M6-F2-R4). IF EXISTS / IF NOT EXISTS keep a re-run harmless
-- and the short lock timeout keeps the migrate job re-runnable instead of queueing behind a long write.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_cost_events" DROP CONSTRAINT IF EXISTS "catalog_cost_events_stage_check";--> statement-breakpoint
ALTER TABLE "catalog_cost_events" DROP CONSTRAINT IF EXISTS "catalog_cost_events_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_cost_events" DROP CONSTRAINT IF EXISTS "catalog_cost_events_outcome_check";--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ALTER COLUMN "batch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ALTER COLUMN "brand_slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD COLUMN IF NOT EXISTS "component" text;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD COLUMN IF NOT EXISTS "content_version_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD COLUMN IF NOT EXISTS "billable_ms" integer;--> statement-breakpoint
ALTER TABLE "catalog_uploads" ADD COLUMN IF NOT EXISTS "ingest_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD CONSTRAINT "catalog_cost_events_stage_check" CHECK ("catalog_cost_events"."stage" IN ('matte', 'render', 'upscale', 'qa', 'classify', 'publish', 'finalize', 'ingest', 'system')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD CONSTRAINT "catalog_cost_events_kind_check" CHECK ("catalog_cost_events"."kind" IN ('llm_call', 'matte_call', 'render', 'upscale_call', 'compute', 'job', 'wait')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD CONSTRAINT "catalog_cost_events_outcome_check" CHECK ("catalog_cost_events"."outcome" IN ('ok', 'failed', 'rate_limited', 'cap', 'fallback', 'timeout', 'killed', 'duplicate')) NOT VALID;
