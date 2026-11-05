-- M5-S3 (docs/program/requirements/M5-channel-rules.md section 3.3, M5-F4-R8): the channel ruleset version a batch
-- reads once at Start and keeps to the end, so a rules publish mid-batch reaches only the batches that start after it.
-- Additive only: one nullable integer column on catalog_batches; old code ignores it and older batches keep null (they
-- read the latest published version, as before). ADD COLUMN of a nullable column with no default is a catalog-only
-- change, cheap whatever the table size. Re-runnable: IF NOT EXISTS. No foreign key, because a version read from the
-- snapshot file when the snapshot table cannot be read (F4-R8) is pinned the same way. The number is taken at merge.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_batches" ADD COLUMN IF NOT EXISTS "ruleset_version" integer;
