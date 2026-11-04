-- M6-S6 (2026-11-04; numbered 0020 at merge, after the R1 slices 0013-0019). Batch
-- success tracking (docs/program/requirements/M6-reliability-cost.md M6-F3): batch outcomes, incidents, operator
-- touches and the revision registry behind deploy_overlap. New tables only (M6-F2-R1 additive), so the live code and
-- the new code both work on this schema. Foreign keys are written inside CREATE TABLE IF NOT EXISTS and every index
-- has IF NOT EXISTS, so a re-run is harmless; the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_batch_outcomes" (
	"batch_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."catalog_batches"("id") ON DELETE cascade,
	"status" text NOT NULL,
	"success" boolean NOT NULL,
	"cause" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"first_links_at" timestamp with time zone,
	"links_ready_at" timestamp with time zone,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ms" bigint,
	"touches" integer DEFAULT 0 NOT NULL,
	"incidents" integer DEFAULT 0 NOT NULL,
	"deploy_overlap" boolean DEFAULT false NOT NULL,
	"products" integer DEFAULT 0 NOT NULL,
	"products_with_links" integer DEFAULT 0 NOT NULL,
	"true_cost_usd" numeric(12, 6),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_batch_outcomes_status_check" CHECK ("catalog_batch_outcomes"."status" IN ('done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_batch_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL REFERENCES "public"."catalog_batches"("id") ON DELETE cascade,
	"output_id" uuid,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_batch_touches_action_check" CHECK ("catalog_batch_touches"."action" IN ('decision', 'retry_photo', 'replace_photo', 'retry_collect', 'retry_links', 'fix_and_continue', 'cancel', 'add_sku_ids'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"batch_id" uuid REFERENCES "public"."catalog_batches"("id") ON DELETE cascade,
	"cause_code" text NOT NULL,
	"cause" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"repeat_of" uuid,
	"dedupe_key" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_incidents_kind_check" CHECK ("catalog_incidents"."kind" IN ('batch_failed', 'chunk_gave_up', 'invariant', 'http_5xx', 'deploy_refused', 'contamination', 'alert')),
	CONSTRAINT "catalog_incidents_severity_check" CHECK ("catalog_incidents"."severity" IN ('warning', 'error'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_revisions" (
	"revision" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_batch_outcomes_ended_at_idx" ON "catalog_batch_outcomes" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_batch_touches_batch_id_idx" ON "catalog_batch_touches" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_incidents_kind_started_at_idx" ON "catalog_incidents" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_incidents_batch_id_idx" ON "catalog_incidents" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_incidents_dedupe_key_uq" ON "catalog_incidents" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_revisions_first_seen_at_idx" ON "catalog_revisions" USING btree ("first_seen_at");
