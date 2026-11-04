-- M5-S1 channel rules store (docs/program/requirements/M5-channel-rules.md 3.3, M5-F1, M5-F2): rulesets and their
-- frozen snapshots, every version of every rule, the conflict register and its decisions, the channel registry, image
-- set policies and rule results keyed by M0 content versions. Additive and safe on the live database: eight new tables
-- only, nothing existing is touched. IF NOT EXISTS keeps a re-run harmless, and the short lock timeout keeps the
-- migrate job re-runnable. The rows (ruleset v1 from the dataset, v2 with the gate-1 decisions) are written by the
-- migrate job (catalog/rules/seed.ts, check then insert), not here. The number is taken at merge time (roadmap 3.2).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_rulesets" (
	"version" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"changed_rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "catalog_rulesets_status_check" CHECK ("catalog_rulesets"."status" IN ('draft', 'published')),
	CONSTRAINT "catalog_rulesets_version_check" CHECK ("catalog_rulesets"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_ruleset_snapshots" (
	"version" integer PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_ruleset_snapshots_version_catalog_rulesets_version_fk" FOREIGN KEY ("version") REFERENCES "public"."catalog_rulesets"("version") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_rules" (
	"rule_id" text NOT NULL,
	"version" integer NOT NULL,
	"ruleset_version" integer NOT NULL,
	"channel" text NOT NULL,
	"market" text,
	"category_scope" jsonb NOT NULL,
	"dataset_scope" jsonb,
	"audience" jsonb,
	"brand_scope" text DEFAULT 'all' NOT NULL,
	"language" text NOT NULL,
	"component" text NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"value" jsonb,
	"text" text,
	"declared_severity" text NOT NULL,
	"evidence" text NOT NULL,
	"confirmed_by" text,
	"source" text NOT NULL,
	"conflicts_with" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checkable" boolean NOT NULL,
	"judge_method" text,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_rules_rule_id_version_pk" PRIMARY KEY("rule_id","version"),
	CONSTRAINT "catalog_rules_market_check" CHECK ("catalog_rules"."market" IN ('GCC', 'IN', 'AE', 'SA')),
	CONSTRAINT "catalog_rules_language_check" CHECK ("catalog_rules"."language" IN ('en', 'ar', 'any')),
	CONSTRAINT "catalog_rules_component_check" CHECK ("catalog_rules"."component" IN ('image', 'title', 'bullets', 'description', 'keywords', 'attributes', 'size_chart', 'a_plus', 'video', 'file')),
	CONSTRAINT "catalog_rules_declared_severity_check" CHECK ("catalog_rules"."declared_severity" IN ('block', 'warn')),
	CONSTRAINT "catalog_rules_evidence_check" CHECK ("catalog_rules"."evidence" IN ('documented', 'reported', 'assumed', 'playbook')),
	CONSTRAINT "catalog_rules_status_check" CHECK ("catalog_rules"."status" IN ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "catalog_rules_reason_check" CHECK (btrim("catalog_rules"."reason") <> ''),
	CONSTRAINT "catalog_rules_ruleset_version_catalog_rulesets_version_fk" FOREIGN KEY ("ruleset_version") REFERENCES "public"."catalog_rulesets"("version") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_rule_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"severity" text NOT NULL,
	"rule_ids" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"recommendation" text NOT NULL,
	"reasoning" text NOT NULL,
	"status" text NOT NULL,
	"decision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_rule_conflicts_severity_check" CHECK ("catalog_rule_conflicts"."severity" IN ('high', 'medium', 'low')),
	CONSTRAINT "catalog_rule_conflicts_status_check" CHECK ("catalog_rule_conflicts"."status" IN ('open', 'decided'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_rule_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"conflict_id" text NOT NULL,
	"option" text NOT NULL,
	"reason" text NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"ruleset_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_rule_decisions_conflict_id_catalog_rule_conflicts_id_fk" FOREIGN KEY ("conflict_id") REFERENCES "public"."catalog_rule_conflicts"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "catalog_rule_decisions_ruleset_version_catalog_rulesets_version_fk" FOREIGN KEY ("ruleset_version") REFERENCES "public"."catalog_rulesets"("version") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_channel_records" (
	"channel_id" text NOT NULL,
	"version" integer NOT NULL,
	"ruleset_version" integer NOT NULL,
	"label" text NOT NULL,
	"group" text NOT NULL,
	"min_canvas" jsonb NOT NULL,
	"target_canvas" jsonb NOT NULL,
	"margins" jsonb NOT NULL,
	"anchor" text NOT NULL,
	"background" text NOT NULL,
	"first_image_background" text,
	"dpi" integer NOT NULL,
	"fixed_canvas" boolean NOT NULL,
	"uniform_scale_default" boolean NOT NULL,
	"sheet_text" text NOT NULL,
	"notes" text,
	"markets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"push_method" text,
	"file_kind" text,
	"owner" text,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_channel_records_channel_id_version_pk" PRIMARY KEY("channel_id","version"),
	CONSTRAINT "catalog_channel_records_group_check" CHECK ("catalog_channel_records"."group" IN ('P1', 'P2')),
	CONSTRAINT "catalog_channel_records_anchor_check" CHECK ("catalog_channel_records"."anchor" IN ('centre', 'bottom-centre')),
	CONSTRAINT "catalog_channel_records_status_check" CHECK ("catalog_channel_records"."status" IN ('draft', 'active', 'retired')),
	CONSTRAINT "catalog_channel_records_push_method_check" CHECK ("catalog_channel_records"."push_method" IN ('portal_file', 'managed_by_channel', 'api_read_only')),
	CONSTRAINT "catalog_channel_records_ruleset_version_catalog_rulesets_version_fk" FOREIGN KEY ("ruleset_version") REFERENCES "public"."catalog_rulesets"("version") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_image_policies" (
	"channel_id" text NOT NULL,
	"node_id" text NOT NULL,
	"version" integer NOT NULL,
	"ruleset_version" integer NOT NULL,
	"roles" jsonb NOT NULL,
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_count" integer,
	"max_count" integer,
	"evidence" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_image_policies_channel_id_node_id_version_pk" PRIMARY KEY("channel_id","node_id","version"),
	CONSTRAINT "catalog_image_policies_evidence_check" CHECK ("catalog_image_policies"."evidence" IN ('documented', 'reported', 'assumed', 'playbook')),
	CONSTRAINT "catalog_image_policies_status_check" CHECK ("catalog_image_policies"."status" IN ('active', 'retired')),
	CONSTRAINT "catalog_image_policies_node_id_catalog_taxonomy_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."catalog_taxonomy_nodes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "catalog_image_policies_ruleset_version_catalog_rulesets_version_fk" FOREIGN KEY ("ruleset_version") REFERENCES "public"."catalog_rulesets"("version") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_rule_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_version_id" uuid NOT NULL,
	"ruleset_version" integer NOT NULL,
	"channel" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"effective_severity" text NOT NULL,
	"measured" jsonb,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_rule_results_outcome_check" CHECK ("catalog_rule_results"."outcome" IN ('pass', 'fail', 'not_applicable', 'needs_judge')),
	CONSTRAINT "catalog_rule_results_effective_severity_check" CHECK ("catalog_rule_results"."effective_severity" IN ('block', 'warn')),
	CONSTRAINT "catalog_rule_results_content_version_id_catalog_content_versions_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."catalog_content_versions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "catalog_rule_results_ruleset_version_catalog_rulesets_version_fk" FOREIGN KEY ("ruleset_version") REFERENCES "public"."catalog_rulesets"("version") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_rule_conflicts_decision_id_catalog_rule_decisions_id_fk') THEN ALTER TABLE "catalog_rule_conflicts" ADD CONSTRAINT "catalog_rule_conflicts_decision_id_catalog_rule_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."catalog_rule_decisions"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_rule_decisions_conflict_id_idx" ON "catalog_rule_decisions" USING btree ("conflict_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_rule_results_version_rule_uq" ON "catalog_rule_results" USING btree ("content_version_id","ruleset_version","channel","rule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_rule_results_ruleset_version_idx" ON "catalog_rule_results" USING btree ("ruleset_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_rules_ruleset_version_idx" ON "catalog_rules" USING btree ("ruleset_version");
