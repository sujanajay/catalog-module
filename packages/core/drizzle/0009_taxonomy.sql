-- M2-S1 taxonomy store (docs/program/requirements/M2-analyze.md M2-F1-R1 to R3, decision D1): the one category tree,
-- attribute definitions and shot roles as data, plus an append-only change log whose highest id is the taxonomy
-- revision. Additive and safe on the live database: four new tables only, nothing existing is touched. IF NOT EXISTS
-- keeps a re-run harmless, and the short lock timeout keeps the migrate job re-runnable. The seed rows are written by
-- the migrate job (analyze/taxonomy-seed.ts, check then insert), not here, so an admin edit is never overwritten.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_taxonomy_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"level" text NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_taxonomy_nodes_parent_id_catalog_taxonomy_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."catalog_taxonomy_nodes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "catalog_taxonomy_nodes_level_check" CHECK ("catalog_taxonomy_nodes"."level" IN ('vertical', 'department', 'group', 'type')),
	CONSTRAINT "catalog_taxonomy_nodes_status_check" CHECK ("catalog_taxonomy_nodes"."status" IN ('released', 'not_released', 'retired'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_taxonomy_nodes_parent_id_idx" ON "catalog_taxonomy_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_attribute_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value_type" text NOT NULL,
	"allowed_values" jsonb,
	"unit" text,
	"node_ids" jsonb NOT NULL,
	"tier" text NOT NULL,
	"source_precedence" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attribute_defs_value_type_check" CHECK ("catalog_attribute_defs"."value_type" IN ('enum', 'number', 'text', 'colour')),
	CONSTRAINT "catalog_attribute_defs_tier_check" CHECK ("catalog_attribute_defs"."tier" IN ('decision', 'listing')),
	CONSTRAINT "catalog_attribute_defs_status_check" CHECK ("catalog_attribute_defs"."status" IN ('active', 'retired'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_shot_roles" (
	"node_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"definition" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_shot_roles_node_id_key_pk" PRIMARY KEY("node_id","key"),
	CONSTRAINT "catalog_shot_roles_node_id_catalog_taxonomy_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."catalog_taxonomy_nodes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "catalog_shot_roles_status_check" CHECK ("catalog_shot_roles"."status" IN ('active', 'retired'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_taxonomy_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_taxonomy_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"data" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_taxonomy_changes_entity_check" CHECK ("catalog_taxonomy_changes"."entity" IN ('node', 'attribute', 'shot_role')),
	CONSTRAINT "catalog_taxonomy_changes_action_check" CHECK ("catalog_taxonomy_changes"."action" IN ('seed', 'create', 'update'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_taxonomy_changes_entity_idx" ON "catalog_taxonomy_changes" USING btree ("entity","entity_id");
