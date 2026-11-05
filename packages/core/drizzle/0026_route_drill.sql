-- M7-S2 follow-up (2026-11-05, R1 exit item 3): the kill-switch drill's stored expiry on vendor_routes. A drill turns
-- route 1 off with restore_state (the state to go back to) and restore_at (when); the router honours an expired drill
-- and writes the restore. Additive only: two nullable columns and two CHECKs added NOT VALID, then validated (every
-- existing row has both columns null). Every statement can run again harmlessly; the short lock timeout keeps the
-- migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "vendor_routes" ADD COLUMN IF NOT EXISTS "restore_state" text;--> statement-breakpoint
ALTER TABLE "vendor_routes" ADD COLUMN IF NOT EXISTS "restore_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_routes" DROP CONSTRAINT IF EXISTS "vendor_routes_restore_state_check";--> statement-breakpoint
ALTER TABLE "vendor_routes" ADD CONSTRAINT "vendor_routes_restore_state_check" CHECK ("vendor_routes"."restore_state" IN ('registered', 'benchmarked', 'shadow', 'canary', 'serving', 'retired', 'off')) NOT VALID;--> statement-breakpoint
ALTER TABLE "vendor_routes" VALIDATE CONSTRAINT "vendor_routes_restore_state_check";--> statement-breakpoint
ALTER TABLE "vendor_routes" DROP CONSTRAINT IF EXISTS "vendor_routes_restore_pair_check";--> statement-breakpoint
ALTER TABLE "vendor_routes" ADD CONSTRAINT "vendor_routes_restore_pair_check" CHECK (("vendor_routes"."restore_state" IS NULL) = ("vendor_routes"."restore_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "vendor_routes" VALIDATE CONSTRAINT "vendor_routes_restore_pair_check";
