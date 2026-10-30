-- Spec 18 enlargement lifecycle 3.10 (final check 2026-10-30): when a row's current paid call started. The handler
-- writes it together with `timeouts + 1` before the call and its settle clears it, so a call whose delivery ended
-- without a settle (killed at the dispatch deadline, its worker gone) is already counted. Additive, nullable, no
-- backfill; IF NOT EXISTS keeps a re-run harmless, and the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_enlargements" ADD COLUMN IF NOT EXISTS "call_started_at" timestamp with time zone;
