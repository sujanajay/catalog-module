-- M1-S4b (2026-11-05; renumbered from 0021 to 0022 after 0021_batch_ruleset_version merged). The upscaler outage deadline
-- (docs/program/requirements/M1-intake.md D13): one health ledger row per upscaler service (GPU, CPU), and the incident
-- kind `upscaler_outage` for the outage and deadline incidents. Additive: a new table, and the incidents kind check
-- replaced by a wider one (added NOT VALID, then validated: a small table). Every statement is re-runnable; the short lock timeout
-- bounds the wait for the check constraint's lock.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_upscaler_health" (
	"service" text PRIMARY KEY NOT NULL,
	"healthy_at" timestamp with time zone,
	"unhealthy_since" timestamp with time zone,
	"last_probe" text,
	"last_probe_at" timestamp with time zone,
	"last_source" text,
	"last_symptom_at" timestamp with time zone,
	"last_upscaler" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_upscaler_health_service_check" CHECK ("catalog_upscaler_health"."service" IN ('cpu', 'gpu'))
);
--> statement-breakpoint
ALTER TABLE "catalog_incidents" DROP CONSTRAINT IF EXISTS "catalog_incidents_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_incidents" ADD CONSTRAINT "catalog_incidents_kind_check" CHECK ("catalog_incidents"."kind" IN ('batch_failed', 'chunk_gave_up', 'invariant', 'http_5xx', 'deploy_refused', 'contamination', 'alert', 'upscaler_outage')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_incidents" VALIDATE CONSTRAINT "catalog_incidents_kind_check";
