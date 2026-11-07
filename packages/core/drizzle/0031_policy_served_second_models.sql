-- R1 exit proof (2026-11-07): three global policy rows name a second cut-out model that the matting services never served
-- (services/matting/app.py INPUT_SIZES; the live /health of both services lists the same four). The repair ladder and the
-- matte guard skip a model the service does not list, so these product types had no second cut-out at all.
-- These rows were seeded before the built-in table (qa/policy.ts) dropped the two names, and that seed never overwrites a row.
-- Each row moves to a served model. The first choice stays bria-rmbg on all three, so the second differs from it.
--   */apparel_model: birefnet-general-lite, the bake-off runner-up on every measured apparel_model brand row.
--   */bag_accessory: birefnet-general, by the rule in qa/policy.ts (a retired id becomes birefnet-general unless that is first).
--   */other: birefnet-general, exactly the built-in row for this type.
-- A brand row is not touched: none names a retired model. On a fresh database no statement matches, and the seed is right already.
-- Every statement can run again harmlessly; the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
UPDATE "model_policy" SET "matte_model_second" = 'birefnet-general-lite', "updated_at" = now() WHERE "brand_slug" = '*' AND "category" = 'apparel_model' AND "matte_model_second" = 'birefnet-dynamic-matting';--> statement-breakpoint
UPDATE "model_policy" SET "matte_model_second" = 'birefnet-general', "updated_at" = now() WHERE "brand_slug" = '*' AND "category" = 'bag_accessory' AND "matte_model_second" = 'birefnet-hr-matting';--> statement-breakpoint
UPDATE "model_policy" SET "matte_model_second" = 'birefnet-general', "updated_at" = now() WHERE "brand_slug" = '*' AND "category" = 'other' AND "matte_model_second" = 'birefnet-dynamic-matting';
