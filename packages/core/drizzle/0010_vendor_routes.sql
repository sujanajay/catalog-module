-- M7-S2 vendor interface (docs/program/requirements/M7-quality-benchmark.md M7-F2): the route table every capability
-- call goes through (state is the kill switch; only serving routes are called) and the route.changed log. Additive:
-- two new tables, nothing existing changes. IF NOT EXISTS keeps a re-run harmless. Seed rows are written by the worker
-- (ensureSeedRoutes, check-then-insert), not here. Numbered after M0-S1's 0009; renumber at merge time (roadmap 3.2).
CREATE TABLE IF NOT EXISTS "vendor_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"rank" integer NOT NULL,
	"adapter" text NOT NULL,
	"model" text NOT NULL,
	"params_version" text DEFAULT '1' NOT NULL,
	"price_usd" numeric(12, 6),
	"rate_limit_per_min" integer,
	"region" text,
	"licence" text,
	"no_training_terms" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_routes_capability_check" CHECK ("vendor_routes"."capability" IN ('vision.read', 'judge.render', 'image.matte', 'image.upscale', 'ocr.read', 'people.detect')),
	CONSTRAINT "vendor_routes_adapter_check" CHECK ("vendor_routes"."adapter" IN ('openrouter', 'matting-gpu', 'matting-cpu', 'upscale-gpu', 'upscale-cpu', 'photoroom')),
	CONSTRAINT "vendor_routes_state_check" CHECK ("vendor_routes"."state" IN ('registered', 'benchmarked', 'shadow', 'canary', 'serving', 'retired', 'off'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_route_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" text NOT NULL,
	"capability" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"from_rank" integer,
	"to_rank" integer NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text NOT NULL,
	"run_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_route_changes_capability_check" CHECK ("vendor_route_changes"."capability" IN ('vision.read', 'judge.render', 'image.matte', 'image.upscale', 'ocr.read', 'people.detect')),
	CONSTRAINT "vendor_route_changes_from_state_check" CHECK ("vendor_route_changes"."from_state" IN ('registered', 'benchmarked', 'shadow', 'canary', 'serving', 'retired', 'off')),
	CONSTRAINT "vendor_route_changes_to_state_check" CHECK ("vendor_route_changes"."to_state" IN ('registered', 'benchmarked', 'shadow', 'canary', 'serving', 'retired', 'off')),
	CONSTRAINT "vendor_route_changes_route_id_vendor_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."vendor_routes"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_route_changes_route_id_at_idx" ON "vendor_route_changes" USING btree ("route_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_routes_capability_adapter_model_uq" ON "vendor_routes" USING btree ("capability","adapter","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_routes_capability_rank_idx" ON "vendor_routes" USING btree ("capability","rank");