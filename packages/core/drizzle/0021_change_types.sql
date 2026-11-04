-- M10-S1a change-type library v0 (docs/program/requirements/M10-learning.md M10-F1-R1, slice M10-S1a): the
-- catalog_change_types table, its seed rows (the F1-R1 list; they must equal CHANGE_TYPE_SEED in
-- src/learning/change-types.ts, a test checks), and a foreign key from catalog_change_events.change_type_id so an
-- unknown type is refused. Additive only: one new table and one constraint; nothing existing is renamed, dropped or
-- retyped. Re-runnable: IF NOT EXISTS, ON CONFLICT DO NOTHING (never undoes a later admin edit), the foreign key added
-- only when missing. The foreign key is NOT VALID, so existing events are not scanned (every new event is checked).
-- Numbered 0021 by the R1 build plan; renumber at merge time if needed (roadmap 3.2).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_change_types" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'opptra' NOT NULL,
	"name" text NOT NULL,
	"component" text NOT NULL,
	"action" text NOT NULL,
	"cost_class" text NOT NULL,
	"channels" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"since_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_change_types_id_check" CHECK ("catalog_change_types"."id" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "catalog_change_types_component_check" CHECK ("catalog_change_types"."component" IN ('image', 'title', 'bullet', 'description', 'attribute', 'size_chart', 'keyword')),
	CONSTRAINT "catalog_change_types_action_check" CHECK ("catalog_change_types"."action" IN ('add', 'replace', 'reorder', 'remove')),
	CONSTRAINT "catalog_change_types_cost_class_check" CHECK ("catalog_change_types"."cost_class" IN ('negligible', 'compute', 'model_call', 'generation')),
	CONSTRAINT "catalog_change_types_status_check" CHECK ("catalog_change_types"."status" IN ('active', 'retired'))
);
--> statement-breakpoint
INSERT INTO "catalog_change_types" ("id", "name", "component", "action", "cost_class", "channels", "since_version") VALUES
	('img_shotset_crops', 'Missing photo roles filled by crops', 'image', 'add', 'negligible', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('img_shotset_generated', 'Missing photo roles filled by generated images', 'image', 'add', 'generation', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('img_main_replaced', 'Main image replaced', 'image', 'replace', 'negligible', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('img_reordered', 'Gallery re-ordered', 'image', 'reorder', 'negligible', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('img_background_fixed', 'Background fixed to the channel rule', 'image', 'replace', 'negligible', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('img_upscaled', 'Image enlarged with the quality pass', 'image', 'replace', 'compute', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('img_footwear_views_added', 'Footwear views added', 'image', 'add', 'generation', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('title_rewritten_en', 'English title rewritten', 'title', 'replace', 'model_call', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('title_arabic_added', 'Arabic title added', 'title', 'add', 'model_call', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('bullets_added', 'Bullets added', 'bullet', 'add', 'model_call', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('attributes_completed', 'Attributes completed', 'attribute', 'add', 'model_call', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('keyword_added_title', 'Keyword added to the title', 'title', 'replace', 'model_call', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('keyword_added_backend', 'Backend search keyword added', 'keyword', 'add', 'model_call', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('infographic_added', 'Infographic added', 'image', 'add', 'generation', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1),
	('size_chart_added', 'Size chart added', 'size_chart', 'add', 'negligible', '["noon", "namshi", "trendyol", "styli", "centrepoint", "sixthstreet", "vogacloset", "amazon", "shein"]'::jsonb, 1)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_change_events_change_type_id_fk') THEN
    ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_change_type_id_fk" FOREIGN KEY ("change_type_id") REFERENCES "public"."catalog_change_types"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
  END IF;
END $$;
