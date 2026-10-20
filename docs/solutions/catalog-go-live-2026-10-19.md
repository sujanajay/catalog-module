# Catalog go-live (2026-10-19) - learnings

Non-obvious things from the expedited go-live of specs 05 to 09 (see `docs/PROGRESS.md`).

## Tier 5 smoke runs on the just-built image, after migrate
What happened: the smoke used to run in-process on the operator's machine. It now runs as the
remote Cloud Run job `catalog-test-smoke` on `worker:$TAG`. deploy.sh order: preflight, build,
migrate, smoke, then matting, worker, web. A failing smoke stops before any service is updated.
Why: the smoke needs the migrated schema and the `test_brand` row that the migrate job seeds.
Running it before migrate, or on an older image, tests the wrong thing.
What to do next time: keep migrate before the smoke. Use `CATALOG_LOCAL_SMOKE=1` only when you
really want the old in-process path. Brands without fixtures report "skipped", not "failed".

## A dirty working tree stops the deploy
What happened: the first 06 deploy stopped at the smoke step. The manager had uncommitted edits
to `docs/PROGRESS.md` in the main checkout. deploy.sh checks `git status --porcelain` at the
start, and `infra/catalog-test-jobs.sh` and `infra/catalog-smoke-linux.sh` check it again, so an
edit made while deploy.sh runs fails at the smoke step.
Why: the image tag must identify exactly the source being built and tested.
What to do next time: never edit files in the main checkout while it deploys. Keep bookkeeping
(PROGRESS.md and similar) on its own branch and worktree, here `docs/go-live-progress` in
`catalog-module-wt/docs-progress`, merged through a docs PR at the end.

## Squash merges confuse `git merge origin/main`
What happened: merging main into the long-lived spec 07 feature branch showed 29 conflicts, and
almost all of them were false. Main only holds squash commits, so git picked an old common
ancestor and replayed changes the branch already had.
Why: a squash commit on main has no parent link to the branch it came from, so git cannot see
that the branch's work is already in main.
What to do next time: find the tip of the branch that main was squashed from (for spec 07 this
was `87d1eb5`, the 06 tip whose tree equals main). Run
`git merge-tree --write-tree --merge-base=<that tip> HEAD origin/main` to get the real
conflicts (spec 07 had one, in `catalog-smoke.ts`), then record a real merge commit with both
parents so later merges find the right ancestor.

## Redelivered shots are not operator replacements (PR #17)
What happened: the first 07 deploy failed at the smoke gate (`catalog-test-smoke-qrl72`) with
"Product was not published: failed" on French Connection's changed batch. Ingest sets
`replacesId` on every redelivered shot. Spec 07 treated any `replacesId` as an operator
replacement and staged it under `<batch>/replacements-<id>/staging/...`. The publish guard
`assertStagedForTarget` only accepts `<root>/<brand>/<batch>/staging/...`, so it threw and the
product failed.
Why: the unit tests used a fake `stageCopyToPublic` that skips the guard, and seeded
redeliveries never had `replacesId` set. The bug only showed in the cloud smoke.
What to do next time: use the replacement prefix only when the raw copy sits under
`<batch>/replacements-` (written by `completeReplacement`). Fakes for storage guards should run
the real guard. The operator Replace flow still has the same guard problem; it is a separate fix.

## Test cleanup must keep today's spend rows (PR #18)
What happened: `cleanupTestBatches` deleted the `spend_days` rows of the batches it removed.
Why: the daily cap (`DAILY_SPEND_CAP_USD`, `checkCaps`) sums `spend_days` for the current UTC
day. A cleanup on the same day as a live judge run lowered the total and let the cap be passed.
What to do next time: a test batch that spent money today keeps its row (set to `failed`,
`options.cleanedUp = true`, hidden from the batch list) and its spend rows. A cleanup on a later
day removes them. Any new cleanup code must not delete spend rows of the current UTC day.

## Anta is not in the warehouse brand master
What happened: Anta is missing from the wizard's brand list.
Why: the warehouse masters (`raw_gcc_dimensions.master_sl` and `sku_master_sheet_hl`, source and
mirror alike) have no Anta rows. The nightly sync works fine.
What to do next time: if Anta is needed as a real brand, run option 1 of
`docs/solutions/manual-brand.md` in Cloud SQL Studio. For testing, use the dummy brand
`test_brand`: the migrate job seeds it, its batches are always `is_test`, and its fixture is the
real Anta photos.

## The OpenRouter key is on the worker too
What happened: the infra workstream first mounted the OpenRouter key on the jobs only, following
the "live OpenRouter calls only in LIVE_SMOKE jobs" rule in AGENTS.md. Spec 07 section 3 also
needs it on `catalog-worker`, because the QA stage runs in the worker. It is never on
`catalog-web`.
Why: the AGENTS.md rule is about tests, not about the production QA stage.
What to do next time: tests still mock OpenRouter. The smoke's judge is always mocked, and the
smoke job has no OpenRouter key at all.

## The `code-review` skill can review the wrong target
What happened: a subagent in a worktree invoked the `code-review` skill for spec 07. It reviewed
the main checkout's working tree instead of the branch diff `main...HEAD`.
Why: the skill appears to pick its target from the main checkout, not from the calling worktree.
What to do next time: pass the diff or PR explicitly (for example the PR number, or the output
of `git diff main...HEAD` from the worktree), or review by hand with the same focus.

## Independent re-check must wait out the public cache
What happened: the second cloud smoke published (48 verified, recheck 48/48, 7 changed, 7
removed), but the `--verify-manifest` re-read of the changed links ran 309 s after an overwrite.
The public CDN (`Cache-Control: max-age=300`, as SPEC allows) still served the old generation,
so it failed with "The public link returned a different generation".
Why: `verifyPublic` tolerates a stale generation for under 2 s (3 retries). That suits publish,
not a re-read minutes later.
What to do next time: PR #20 added `verifyPublicSettled` to
`packages/core/src/catalog/pipeline/verify.ts`. It re-polls only the stale-generation case every
10 s for up to 310 s, the window the smoke already allows for removed links. The smoke's
`--verify-manifest` uses it; publish keeps `verifyPublic`. Fresh-reader checks must allow the
full cache window. The compliance step after the version check re-fetches the plain link and
could still score cached old bytes (harmless, not exact).
The third smoke run showed the same staleness on the publish-side read-back (a link read seconds
before an overwrite stayed stale longer than publish's 1.75 s of retries), so PR #21 made
`verifyPublic` fall back to a pinned `?generation=<copied>` read (anonymous pinned reads work on
public GCS objects: right version 200, wrong one 404), made the compliance re-fetch read the
exact version, and now logs the unpublished reason before cleanup. PR #22 set
`PUBLIC_CACHE_WINDOW_MS = 600_000` in `verify.ts`, shared by the removed-link wait and the
settled reader.

## "Detect automatically" stored `auto` as the product type (PR #24)
What happened: every product of the quality-gate batch `b489e466` rendered as `other`, so model
photos got a synthesised shadow, which the spec forbids.
Why: the wizard's "Detect automatically" stored the literal `auto` on the batch and on each
product. The matte stage classifies only when the type is empty, and `"auto"` is truthy, so the
classifier never ran. The render treats `auto` as `other`.
What to do next time: never store a placeholder as data. PR #24 keeps `auto` off products,
classifies legacy `auto` rows, and `shadowSynthesisAllowed` allows a made shadow only for
footwear, bag_accessory and other. An unknown type means no shadow and a `no_shadow_source` flag.

## Three faults in shadow.ts (PR #29)
What happened: the quality gate saw grey blocks with hard straight edges behind feet on 7 of 14
viewed images, all marked "verified".
Why: `shadowLayer` clipped the layer to the safe box with a binary mask; the synthesised shadow
squashed the bottom 20% of mask rows, at full silhouette width, into one band; kept shadows
stopped on the straight top line of the measuring band.
What to do next time: shadows are now cast from the silhouette, feathered, and faded to zero.
`shadow-silhouette.test.ts` fails when neighbouring shadow pixels differ by more than 6 grey
levels or a straight shadow edge is longer than 5% of the width. Size and margin checks miss
such defects; guard them with pixel tests.

## Cropped source photos: the cut is in the photo, not the render (PR #27)
What happened: the owner reported faces cut. The render crops nothing: the photos arrive
already cut (mid-jeans, head and shoulders), and the mattes are clean.
Why: a white band of 8 to 15 px at the photo's edge hides that it is cut. With the normal bottom
margin, the cut line floated over the grey background and read as "we cut the body".
What to do next time: PR #27 detects a cut side (an opaque run over 25% of the box side), places
it flush with the canvas edge on every channel, makes no shadow under it, and adds the
information flag `cut_in_source` with a sheet note, never a hold. It misses a knee-level cut at
22%.

## channels.ts had drifted from SPEC.md (PR #27)
What happened: Trendyol was not delivered at its accepted 1200x1800, and the angles of one
product came out on different canvas sizes.
Why: the 1.5x upscale cap won over the marketplace's exact size, and the canvas was computed per
shot.
What to do next time: compare `channels.ts` with the SPEC.md channel table after any render
change. Trendyol is now a fixed 1200x1800 canvas (`low_resolution` stays information),
`planProduct` gives one canvas per product per channel (the largest of its shots), and
`CHANNEL_RULES_VERSION` went to 4 so products re-render. Amazon and Shein stay square: the
SPEC.md table says up to 2000x2000, its quoted sheet text says "3:4 portrait". The owner decides.

## Cloud Tasks createTask is never retried by the client library (PR #25)
What happened: in e2e flow 4 (batch `63409122`) POST /ingest returned 500 "14 UNAVAILABLE: read
ECONNRESET", the retry got 409, and the batch stuck at "Collecting files 0 of ?".
Why: `@google-cloud/tasks` 7.3.0 marks `CreateTask` non-idempotent with no retry codes, so one
reset connection on a web instance woken from idle failed at once. The batch was already
`ingesting`, and the wizard's PATCH only works on drafts.
What to do next time: retry non-idempotent client calls yourself. `retryTransient`
(`packages/core/src/retry.ts`) retries named tasks (`ingest-<uploadId>-<run>`; ALREADY_EXISTS
counts as success, so no duplicates). When nothing was queued the batch rolls back to draft; a
batch stalled for 10 minutes shows "Try again".

## Judge spend was rounded away; compute spend was not counted (PRs #28, #31)
What happened: the cost line showed "USD 0.00" after live judge calls.
Why: spend was recorded all along (batch `b489e466`: 52 calls, USD 0.0072, about USD 0.00014
per check); the cost line rounded to 2 decimals. Compute counted as 0 because
`COMPUTE_USD_PER_VCPU_SECOND` was unset, though compute (2023 vCPU-seconds, about USD 0.05) cost
roughly 7 times the judge.
What to do next time: read the finalize report before suspecting the spend path. USD now shows 4
decimals, every judge call is logged (status, tokens, USD; failures at WARNING), and deploy.sh
defaults `COMPUTE_USD_PER_VCPU_SECOND` to 0.0000265 (asia-south1 Tier 1 request-based CPU plus
1 GiB memory). Re-read the price page when the region or billing mode changes.

## Judge false positives: view-blind prompt, mean-of-scores verdict (PR #32)
What happened: both holds in batch `b489e466` were wrong or inconsistent. A sole view was
flagged as a different product, and a shadow defect held Centrepoint while it passed on 7
other channels.
Why: the prompt compared every photo with photo 1 without saying other views are expected,
ignored the product type, and asked about placement the judge cannot see. The verdict was the mean
of scores.
What to do next time: give the judge the view role and product type, check each dimension
against its own threshold, get a second opinion before a wrong-item hold, and apply a photo's
result to every channel. Hard holds only: confirmed wrong item, collage, corrupt file, photo 1
unusable, all photos unusable.

## gcloud `--args` and signed URLs in the eval job (PR #33)
What happened: the first live `catalog-eval` run refused `--sample 1 --seed 1`, and
`contact-sheet` and `report` could not sign URLs.
Why: `gcloud run jobs execute --args` refuses any value that appears twice, in every form (plain
list, `^|^` delimiter, flags file). Signing a URL on Cloud Run calls
`iam.serviceAccounts.signBlob` on the job's own service account, which needs
`roles/iam.serviceAccountTokenCreator` on itself.
What to do next time: pass job arguments as `--flag=value` tokens (`infra/catalog-eval.sh` folds
pairs into that form). `infra/bootstrap.sh` now grants `catalog-worker@` the role on itself; run
bootstrap before the next deploy.

## The mattes are clean: look for output defects in the render first
What happened: the owner asked whether background removal damaged the products. The cloud smoke
and a matting investigation (16 photos, 4 models, CPU and GPU, 48+ calls) found every matte clean
and complete: laces, soles, hair, fingers and thin straps kept, no holes, CPU and GPU identical.
Why: every visible defect came from our render: cut lines placed with a gap, and the shadow
layer.
What to do next time: when an output looks wrong, compare the staged cut-out with the render
before changing matting models or paying for a commercial API. The open-source models we run
need no replacement for these photo sets.
