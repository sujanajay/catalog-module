# What test cleanup leaves in the public bucket, and why that is fine (spec 18 H4)

## The question
After a load run, `catalog-test-cleanup` deletes every generation under the run's `catalog-test/` prefixes in
both buckets (`deleteTestObjects`, `packages/core/src/storage.ts`). Can deleted test objects still be found in
the public bucket, and does anything have to be done about them?

## What this note describes
This note describes the bucket configuration the repo files set (`infra/bootstrap.sh`,
`infra/lifecycle-public.json`, `infra/lifecycle-assets.json`). It is not a reading of the live buckets. Spec 18
section 13 lists a live lifecycle change of unknown origin as open (reset it to the repo file or explain it), so
the live rules may differ from what is written here until that is settled. 2026-10-29: explained in
`docs/solutions/infra-bootstrap.md` (bootstrap re-applied `infra/lifecycle-assets.json` to the assets bucket on
every run); both buckets' live lifecycles read that day equal the repo files.

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
- nothing else from the cleanup itself, with one gap: a delivery still running when cleanup listed the prefix can
  write a new object after the listing. That object is a live generation, and neither lifecycle rule ever removes
  a live generation (the 30-day rule needs `isLive: false`; the 4-newer rule needs 4 newer versions, which a test
  object never gets). Run the cleanup again after the run's deliveries have stopped; the check below shows it.

Production objects under `catalog/` are never touched: `assertTestPrefix` guards the prefix and every listed name
before the first delete starts.

## The assets bucket
The private bucket `image-links-agent-assets` is shared with the earlier app. Bootstrap sets only its lifecycle
(`infra/lifecycle-assets.json`): an object under `catalog/` or `catalog-test/` is deleted 180 days after its custom
time (`daysSinceCustomTime: 180`). The worker sets the custom time when it retires an object (a superseded raw
photo, `setCustomTime`), so an object with no custom time is never removed by this rule. The repo files never turn
versioning on or off for this bucket and never check it, so its versioning state is whatever the shared bucket
already had; if it is on, `deleteTestObjects` still removes every generation because it lists with
`versions: true`.

## The check
Spec 17 step 7 (and the spec 18 load's cleanup step) confirms the empty listing of the run's prefixes after
cleanup. That listing must include noncurrent versions:

    gcloud storage ls --all-versions "gs://image-links-agent-public/catalog-test/<brand>/<pathKey>/**"

Empty means done. Do not expect `--soft-deleted` to be empty for 7 days, and do not change the soft-delete
policy or the lifecycle to make it so: the retention is a cheap safety net and costs only a week of test bytes.

## No GCP change
Nothing in the bucket configuration changes for this. `infra/bootstrap.sh` behaviour stays as it is.
