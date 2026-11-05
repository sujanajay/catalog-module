-- M6-S2 (2026-11-05; renumber at merge if another migration lands first). Cost reconciliation
-- (docs/program/requirements/M6-reliability-cost.md M6-F1-R4 to R6, section 7.1): the daily billed, attributed, idle and
-- shared cost per component, and its allocation to batches. New tables only (M6-F2-R1 additive), so the live code and
-- the new code both work on this schema. Foreign keys are written inside CREATE TABLE IF NOT EXISTS and every index has
-- IF NOT EXISTS, so a re-run is harmless; the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_cost_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"component" text NOT NULL,
	"kind" text NOT NULL,
	"region" text,
	"env" text NOT NULL,
	"source" text NOT NULL,
	"billable_seconds" numeric(14, 3),
	"billed_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"credits_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"attributed_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"idle_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"shared_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"estimated" boolean DEFAULT true NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"detail" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_cost_days_kind_check" CHECK ("catalog_cost_days"."kind" IN ('service', 'job', 'shared', 'vendor')),
	CONSTRAINT "catalog_cost_days_env_check" CHECK ("catalog_cost_days"."env" IN ('live', 'preview', 'test', 'unlabelled')),
	CONSTRAINT "catalog_cost_days_source_check" CHECK ("catalog_cost_days"."source" IN ('monitoring', 'billing'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_cost_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"batch_id" uuid NOT NULL REFERENCES "public"."catalog_batches"("id") ON DELETE cascade,
	"component" text NOT NULL,
	"source" text NOT NULL,
	"busy_ms" bigint DEFAULT 0 NOT NULL,
	"attributed_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"idle_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"shared_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_cost_allocations_source_check" CHECK ("catalog_cost_allocations"."source" IN ('monitoring', 'billing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_cost_days_day_component_env_source_uq" ON "catalog_cost_days" USING btree ("day","component","env","source");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_cost_allocations_day_batch_component_uq" ON "catalog_cost_allocations" USING btree ("day","batch_id","component");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_cost_allocations_batch_id_idx" ON "catalog_cost_allocations" USING btree ("batch_id");
