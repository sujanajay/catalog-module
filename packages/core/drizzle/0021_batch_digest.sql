-- M1-S5 (2026-11-05; the number is taken at merge time, M1 D3). The batch digest (M1-F4-R1) as one nullable jsonb
-- column on catalog_batches, and the "Wait" touch (hold_start) on catalog_batch_touches. Additive only: the column is
-- nullable and the CHECK only widens, so the live code and the new code both work on this schema. Every statement can
-- run again harmlessly; the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_batches" ADD COLUMN IF NOT EXISTS "digest" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_batch_touches" DROP CONSTRAINT IF EXISTS "catalog_batch_touches_action_check";--> statement-breakpoint
ALTER TABLE "catalog_batch_touches" ADD CONSTRAINT "catalog_batch_touches_action_check" CHECK ("catalog_batch_touches"."action" IN ('decision', 'retry_photo', 'replace_photo', 'retry_collect', 'retry_links', 'fix_and_continue', 'cancel', 'add_sku_ids', 'hold_start')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_batch_touches" VALIDATE CONSTRAINT "catalog_batch_touches_action_check";
