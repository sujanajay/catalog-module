# What test cleanup leaves in the public bucket, and why that is fine (spec 18 H4)

## The question
After a load run, `catalog-test-cleanup` deletes every generation under the run's `catalog-test/` prefixes in
both buckets (`deleteTestObjects`, `packages/core/src/storage.ts`). Can deleted test objects still be found in
the public bucket, and does anything have to be done about them?

## How the public bucket keeps old bytes
- **Object versioning is on.** `infra/bootstrap.sh` turns it on for `image-links-agent-public` (check-then-update).
  Overwriting or deleting a live object without a generation keeps the old bytes as a noncurrent version.
- **Lifecycle rules** (`infra/lifecycle-public.json`, applied by `ensure_lifecycle` in bootstrap): a noncurrent
  version is deleted 30 days after it became noncurrent (`isLive: false, daysSinceNoncurrentTime: 30`), and any
  version with 4 or more newer versions is deleted (`numNewerVersions: 4`).
- **Soft delete is Google's default, not ours.** New buckets get a 7-day soft-delete retention from Google. The
  repo never sets or changes it: bootstrap has no soft-delete step, and `deleteTestObjects` leaves the policy
  alone. A hard-deleted generation stays restorable (and billed as soft-deleted storage) for 7 days, then goes.

## What cleanup leaves behind
`deleteTestObjects` lists with `versions: true` and deletes each generation by number, so neither the live
object nor any noncurrent version stays listable. What stays:
- soft-deleted copies of every deleted generation, for 7 days, visible only with
  `gcloud storage ls --soft-deleted`; they expire on their own;
- nothing else from the cleanup itself. A noncurrent version can only remain if it was created after the
  listing (a delivery still running when cleanup started); the 30-day and 4-newer rules remove it.

Production objects under `catalog/` are never touched: `assertTestPrefix` guards the prefix and every listed name
before the first delete starts.

## The check
Spec 17 step 7 (and the spec 18 load's cleanup step) confirms the empty listing of the run's prefixes after
cleanup. That listing must include noncurrent versions:

    gcloud storage ls --all-versions "gs://image-links-agent-public/catalog-test/<brand>/<pathKey>/**"

Empty means done. Do not expect `--soft-deleted` to be empty for 7 days, and do not change the soft-delete
policy or the lifecycle to make it so: the retention is a cheap safety net and costs only a week of test bytes.

## No GCP change
Nothing in the bucket configuration changes for this. `infra/bootstrap.sh` behaviour stays as it is.
