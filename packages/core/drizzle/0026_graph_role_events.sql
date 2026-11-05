-- R1 exit item 5 (docs/program/requirements/M0-catalog-graph.md, decisions D23 revised and D28; numbered 0026 after
-- M1-S5's 0025, renumbered at merge if another slice takes it). Additive only, so the live code and the new code both
-- work on this schema:
-- 1. catalog_content_versions.role takes two more values, `main` (slot 1) and `additional` (a later slot), the role the
--    pipeline writes until M2 reads each photo's view (D28). The old CHECK is dropped and a wider one added NOT VALID:
--    every existing row holds a value of the older, smaller set, and new rows are checked.
-- 2. catalog_change_events: a publish event for a product with no option, or no listing on the channel, yet names its
--    product and channel instead of a listing (D23 revised). listing_id becomes nullable; two nullable columns
--    (product_id, channel; no foreign key on product_id: an operator may delete a product, never its log); a CHECK
--    that an event names a listing or both of product and channel, NOT VALID (every existing row has a listing, since
--    listing_id was NOT NULL; new rows are checked); a partial index for the last listing-less event of a product's
--    channel slot.
-- No VALIDATE: drizzle runs every pending migration in one transaction, so a VALIDATE here would scan
-- catalog_content_versions while ADD CONSTRAINT's ACCESS EXCLUSIVE lock is still held and renders wait for it. The
-- old rows satisfy both CHECKs by construction (review of #184, P3-2), the same choice as 0012.
-- IF EXISTS / IF NOT EXISTS keep a re-run harmless and the short lock timeout keeps the migrate job re-runnable instead
-- of queueing behind a long write.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_content_versions" DROP CONSTRAINT IF EXISTS "catalog_content_versions_role_check";--> statement-breakpoint
ALTER TABLE "catalog_content_versions" ADD CONSTRAINT "catalog_content_versions_role_check" CHECK ("catalog_content_versions"."role" IN ('front', 'back', 'side', 'detail', 'head_shoulders', 'full_length', 'flat', 'packshot', 'size_chart', 'main', 'additional', 'unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_change_events" ALTER COLUMN "listing_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_change_events" ADD COLUMN IF NOT EXISTS "product_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog_change_events" ADD COLUMN IF NOT EXISTS "channel" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_change_events_product_slot_idx" ON "catalog_change_events" USING btree ("product_id","channel","slot") WHERE "catalog_change_events"."listing_id" IS NULL;--> statement-breakpoint
ALTER TABLE "catalog_change_events" DROP CONSTRAINT IF EXISTS "catalog_change_events_channel_check";--> statement-breakpoint
ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_channel_check" CHECK ("catalog_change_events"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')) NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog_change_events" DROP CONSTRAINT IF EXISTS "catalog_change_events_target_check";--> statement-breakpoint
ALTER TABLE "catalog_change_events" ADD CONSTRAINT "catalog_change_events_target_check" CHECK ("catalog_change_events"."listing_id" IS NOT NULL OR ("catalog_change_events"."product_id" IS NOT NULL AND "catalog_change_events"."channel" IS NOT NULL)) NOT VALID;
