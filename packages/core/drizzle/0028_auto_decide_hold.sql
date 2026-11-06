-- M1 D39 (owner decision of 2026-11-06, recorded by the manager): an auto-decide rule may keep a photo back for a person
-- (`hold`) as the rare last resort. New cause `visible_defect`: a defect a shopper would see, still there after the repair
-- loop. A photo that could not be cut out (`unusable`) and a visible defect are no longer delivered with a warning. Rows an
-- admin changed keep their value. A re-cut logs its own event kind (D41). Widening a CHECK: dropped, added NOT VALID, validated. Every statement can run again
-- harmlessly; the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_auto_decide_rules" DROP CONSTRAINT IF EXISTS "catalog_auto_decide_rules_cause_check";--> statement-breakpoint
ALTER TABLE "catalog_auto_decide_rules" ADD CONSTRAINT "catalog_auto_decide_rules_cause_check" CHECK ("catalog_auto_decide_rules"."cause" IN ('wrong_item', 'collage', 'unusable', 'corrupt', 'unchecked', 'photo_one', 'every_photo', 'not_publishable', 'code_fault', 'not_enlarged', 'visible_defect')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_auto_decide_rules" VALIDATE CONSTRAINT "catalog_auto_decide_rules_cause_check";--> statement-breakpoint
ALTER TABLE "catalog_auto_decide_rules" DROP CONSTRAINT IF EXISTS "catalog_auto_decide_rules_action_check";--> statement-breakpoint
ALTER TABLE "catalog_auto_decide_rules" ADD CONSTRAINT "catalog_auto_decide_rules_action_check" CHECK ("catalog_auto_decide_rules"."action" IN ('deliver', 'drop', 'hold')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_auto_decide_rules" VALIDATE CONSTRAINT "catalog_auto_decide_rules_action_check";--> statement-breakpoint
ALTER TABLE "catalog_product_events" DROP CONSTRAINT IF EXISTS "catalog_product_events_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_product_events" ADD CONSTRAINT "catalog_product_events_kind_check" CHECK ("catalog_product_events"."kind" IN ('created', 'overwritten', 'shots_removed', 'channel_added', 'unchanged', 'reordered', 'sku_ids_added', 'alias_added', 'removed_photo', 'replacement_uploaded', 'restored', 'removed', 'enlargement_retried', 'plain_accepted', 'photo_recut')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_product_events" VALIDATE CONSTRAINT "catalog_product_events_kind_check";--> statement-breakpoint
INSERT INTO "catalog_auto_decide_rules" ("id", "cause", "channel", "action", "updated_by") VALUES ('visible_defect:*', 'visible_defect', '*', 'hold', 'seed') ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "catalog_auto_decide_rules" SET "action" = 'hold' WHERE "id" = 'unusable:*' AND "updated_by" = 'seed' AND "action" = 'deliver';
