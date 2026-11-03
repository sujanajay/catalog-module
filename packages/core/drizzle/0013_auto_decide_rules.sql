-- M1-S3 auto-decide (docs/program/requirements/M1-intake.md M1-F3-R1; numbered 0013 after M6-S4's 0012). Additive: one
-- new table and its seed rows, nothing existing changes. Each hold cause maps to an automatic action for one channel or
-- every channel (`*`); the id `<cause>:<channel>` is recorded on every output a rule decided. Start copies the enabled
-- rules into the batch (options.autoDecide). IF NOT EXISTS and ON CONFLICT DO NOTHING keep a re-run harmless and never
-- undo an admin's later change. The seed must match DEFAULT_AUTO_DECIDE_RULES (catalog/auto-decide.ts; a test checks).
CREATE TABLE IF NOT EXISTS "catalog_auto_decide_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"cause" text NOT NULL,
	"channel" text NOT NULL,
	"action" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_auto_decide_rules_cause_check" CHECK ("catalog_auto_decide_rules"."cause" IN ('wrong_item', 'collage', 'unusable', 'corrupt', 'unchecked', 'photo_one', 'every_photo', 'not_publishable', 'code_fault', 'not_enlarged')),
	CONSTRAINT "catalog_auto_decide_rules_channel_check" CHECK ("catalog_auto_decide_rules"."channel" IN ('*', 'noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_auto_decide_rules_action_check" CHECK ("catalog_auto_decide_rules"."action" IN ('deliver', 'drop'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_auto_decide_rules_cause_channel_uq" ON "catalog_auto_decide_rules" USING btree ("cause","channel");--> statement-breakpoint
INSERT INTO "catalog_auto_decide_rules" ("id", "cause", "channel", "action", "updated_by") VALUES
	('not_publishable:*', 'not_publishable', '*', 'deliver', 'seed'),
	('unusable:*', 'unusable', '*', 'deliver', 'seed'),
	('photo_one:*', 'photo_one', '*', 'deliver', 'seed'),
	('every_photo:*', 'every_photo', '*', 'deliver', 'seed'),
	('unchecked:*', 'unchecked', '*', 'deliver', 'seed'),
	('code_fault:*', 'code_fault', '*', 'deliver', 'seed'),
	('not_enlarged:*', 'not_enlarged', '*', 'deliver', 'seed'),
	('corrupt:*', 'corrupt', '*', 'drop', 'seed'),
	('wrong_item:*', 'wrong_item', '*', 'drop', 'seed'),
	('collage:*', 'collage', '*', 'drop', 'seed')
ON CONFLICT ("id") DO NOTHING;
