-- M3-S5 (docs/program/requirements/M3-images.md M3-F2-R3): the daily spend cap of an overflow vendor route. Additive: one
-- nullable column, nothing existing changes; a null cap on an overflow route means it is never called. IF NOT EXISTS
-- keeps a re-run harmless. Numbered 0016 because 0013-0015 are claimed by open branches; renumber at merge time
-- (roadmap 3.2) so the journal "when" keeps increasing with idx.
ALTER TABLE "vendor_routes" ADD COLUMN IF NOT EXISTS "daily_cap_usd" numeric(12, 6);
