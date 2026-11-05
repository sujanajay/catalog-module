-- R1 exit item 4 (2026-11-05): the batch outcome keeps the batch's recorded cost, every cost ledger row of the batch
-- (the digest's figure before idle is added; true_cost_usd stays the reconciled cost). Additive only: one nullable
-- column, so the live code and the new code both work on this schema. Re-runnable; the short lock timeout keeps the
-- migrate job re-runnable.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "catalog_batch_outcomes" ADD COLUMN IF NOT EXISTS "recorded_cost_usd" numeric(12, 6);
