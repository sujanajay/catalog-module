-- M1 D43 (manager's decision of 2026-11-06, on the judge comparison of 169 images): the first judge passed every defect, so it no
-- longer judges in any path. New order for `judge.render`: Haiku, then Flash 3.8. The old first judge and Qwen stay as rows, retired,
-- so history keeps its route ids. `vision.read` (the classifier) is not changed. Every policy row that named the old first judge moves;
-- a row that names another judge keeps it. On a fresh database the seed writes these rows and every statement here matches nothing.
-- Every statement can run again harmlessly; the short lock timeout keeps the migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
INSERT INTO "vendor_route_changes" ("route_id", "capability", "from_state", "to_state", "from_rank", "to_rank", "changed_by", "reason")
  SELECT "id", "capability", "state", 'retired', "rank", 9, 'migration 0030', 'M1 D43: the first judge caught 0 of 14 known defects' FROM "vendor_routes"
  WHERE "id" = 'judge.render:openrouter:google/gemini-2.5-flash-lite' AND "state" <> 'retired';--> statement-breakpoint
UPDATE "vendor_routes" SET "state" = 'retired', "rank" = 9, "restore_state" = NULL, "restore_at" = NULL, "drill_id" = NULL, "updated_at" = now()
  WHERE "id" = 'judge.render:openrouter:google/gemini-2.5-flash-lite' AND "state" <> 'retired';--> statement-breakpoint
INSERT INTO "vendor_route_changes" ("route_id", "capability", "from_state", "to_state", "from_rank", "to_rank", "changed_by", "reason")
  SELECT "id", "capability", "state", 'retired', "rank", 10, 'migration 0030', 'M1 D43: no evidence it can judge alone; see the judge exam results in D43' FROM "vendor_routes"
  WHERE "id" = 'judge.render:openrouter:qwen/qwen3-vl-30b-a3b-instruct' AND "state" <> 'retired';--> statement-breakpoint
UPDATE "vendor_routes" SET "state" = 'retired', "rank" = 10, "restore_state" = NULL, "restore_at" = NULL, "drill_id" = NULL, "updated_at" = now()
  WHERE "id" = 'judge.render:openrouter:qwen/qwen3-vl-30b-a3b-instruct' AND "state" <> 'retired';--> statement-breakpoint
INSERT INTO "vendor_route_changes" ("route_id", "capability", "from_state", "to_state", "from_rank", "to_rank", "changed_by", "reason")
  SELECT "id", "capability", "state", "state", "rank", 1, 'migration 0030', 'M1 D43: first judge' FROM "vendor_routes"
  WHERE "id" = 'judge.render:openrouter:anthropic/claude-haiku-5.5' AND "rank" <> 1;--> statement-breakpoint
UPDATE "vendor_routes" SET "rank" = 1, "price_usd" = 0.00074, "updated_at" = now() WHERE "id" = 'judge.render:openrouter:anthropic/claude-haiku-5.5' AND "rank" <> 1;--> statement-breakpoint
INSERT INTO "vendor_routes" ("id", "capability", "rank", "adapter", "model", "params_version", "price_usd", "rate_limit_per_min", "region", "licence", "no_training_terms", "state", "daily_cap_usd")
  SELECT 'judge.render:openrouter:google/gemini-3.8-flash', "capability", 2, "adapter", 'google/gemini-3.8-flash', "params_version", 0.00556, "rate_limit_per_min", "region", "licence", "no_training_terms", 'serving', "daily_cap_usd" FROM "vendor_routes"
  WHERE "id" = 'judge.render:openrouter:anthropic/claude-haiku-5.5'
  ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "vendor_route_changes" ("route_id", "capability", "from_state", "to_state", "from_rank", "to_rank", "changed_by", "reason")
  SELECT "id", "capability", NULL, "state", NULL, "rank", 'migration 0030', 'M1 D43: second judge and next fallback' FROM "vendor_routes"
  WHERE "id" = 'judge.render:openrouter:google/gemini-3.8-flash' AND NOT EXISTS (SELECT 1 FROM "vendor_route_changes" WHERE "route_id" = 'judge.render:openrouter:google/gemini-3.8-flash');--> statement-breakpoint
UPDATE "model_policy" SET "qa_model" = 'anthropic/claude-haiku-5.5', "qa_model_second" = 'google/gemini-3.8-flash', "updated_at" = now() WHERE "qa_model" = 'google/gemini-2.5-flash-lite';--> statement-breakpoint
UPDATE "model_policy" SET "qa_model_second" = 'google/gemini-3.8-flash', "updated_at" = now() WHERE "qa_model_second" = 'google/gemini-2.5-flash-lite';
