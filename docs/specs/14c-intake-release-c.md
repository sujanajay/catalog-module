# 14c Intake release C: resume and progress

Catalog module, spec 14, release C of four. Execute with `docs/specs/00-execution-protocol.md`. Parent:
`docs/specs/14-intake-resilience.md`; read its terms, sections 1 to 6 and section 8 before this file.
Source of truth: `docs/SPEC.md`. Depends on releases A (`14a-intake-release-a.md`) and B
(`14b-intake-release-b.md`) merged and deployed; it uses the batch status `cancelled` from B's
migration `0003_intake_states.sql`. Branch `feat/catalog-14c-intake-resume`, worktree
`C:\Users\Sujan AH\Desktop\catalog-module-wt\14c-intake-resume`. Deploys `catalog-web` and
`catalog-worker` (no migration). Approval: approved by the owner on 2026-10-27 (parent section 11,
decision 4). This release ships as one PR, called PR C in the text below.

## 1. What changes for the operator

- The batch list opens with "Your unfinished batches": each draft, collecting or failed-before-start
  batch with its state in words, its age, Continue (or "Fix and continue") and Cancel. Cancelled
  batches leave the default list.
- Every intake wait shows the phase, a count and, once measured, an honest time: "Downloading photos
  612 of 1,400, about 7 min left", then "Placing photos 300 of 1,400". The batch stays "collecting"
  until the grouping is ready, so it never looks ready with nothing in it.
- A batch that failed before Start is fixed in place: "Fix and continue" reopens it with its inputs and
  shows the reason in step 1.
- Continue on step 2 with nothing changed returns at once, and placing never re-copies a photo that is
  already in place.
- A platform timeout page no longer shows a raw parse error.

## 2. Scope

In scope: `web/components/catalog/{CatalogWizard,WizardStep1,WizardStep2,WizardStep4,BatchBanner}.tsx`,
`web/components/catalog/wizard-client.ts`, new `web/components/catalog/UnfinishedBatches.tsx`,
`web/app/catalog/{page,[id]/page,new/page}.tsx`, `web/lib/catalog/{batches,uploads,preview,copy}.ts`, the
new routes `cancel` POST and `reopen` POST under `web/app/api/catalog/batches/[id]/`,
`packages/core/src/catalog/pipeline/status.ts` (`deriveBatchState`, `intakeTimeText`),
`packages/core/src/catalog/types.ts` (`BatchCounts` fields), `ingest/index.ts` (lease, phase, guards,
`placeRaw`), `apps/worker/src/catalog/{ingest,sweep}.ts` (cancel guards; the sweep ignores cancelled
batches), and tests.

Out of scope here: everything the parent lists as out of scope, and every fix or part assigned to
releases A, B and D (parent section 7).

## 3. Fixes

Sentences in quotes are exact (parent section 4).

### 3.1 F4 part 2: the unfinished list and Cancel

Part 1 of F4 (the way back) shipped in 14a section 3.4.

- The list (`web/app/catalog/page.tsx`): a section "Your unfinished batches" above the table, listing
  the signed-in user's `draft`, `ingesting` and failed-before-start batches (admins see everyone's,
  with the creator; viewers see the section read-only, with no buttons), newest first, each row: name,
  brand, state words, age ("created 5 minutes ago", "2 days ago"), and the actions "Continue" and
  "Cancel". A failed-before-start row shows "Fix and continue" instead of "Continue": it performs the
  reopen of F8 (section 3.4) and then navigates to `/catalog/new?batch=<id>`. The section is absent when
  empty. The main table excludes `cancelled` batches by default and gets a "Show cancelled" link. On
  phones the section is a card list, and the main table keeps its State column on screen (the Channels
  column collapses first).
- The batch page gets "Cancel this batch" as a secondary action next to "Continue setting up".
- `POST /cancel` (draft, ingesting, or failed-before-start; operator): sets status `cancelled`
  (from migration `0003_intake_states.sql`, 14b section 4.1); releases nothing (drafts hold no locks: db
  section 2); refuses a batch that has started. `deriveBatchState` gets state `cancelled`, pill
  "Cancelled", list pill "Cancelled". The sweep ignores cancelled batches.
- Cancel guards (the worker can never revive a cancelled batch): the worker's final status writes
  (`finishBatch`, `placeBatch` and the closing `patchCounts`) apply only `WHERE status = 'ingesting'`
  and while the caller holds the placing lease of F6 (section 3.2); `runIngest` and `placeBatch` exit at
  the start of each delivery when the batch is cancelled.
- `UPLOAD_STATUSES` gains `removed` (PR B) and `BATCH_STATUSES` gains `cancelled` (used from PR C),
  both from 14b's migration `0003_intake_states.sql` (14b section 4.1).
- State words for unfinished rows (from `deriveBatchState`, new field `intake: string`):
  - pending uploads: "<n> files did not finish uploading"
  - no input: "Nothing added yet"
  - collecting: "Downloading photos <done> of <total>" or "Reading your sheet" or "Unpacking your
    zip" or "Checking your uploaded files" (by source, as `collectingText` picks today) + the time
    of F6 (section 3.2)
  - placing: "Placing photos <placed> of <total>" + time
  - ready, no channels: "Ready to check"
  - waiting for a column: "Needs your input: which column holds the identifier?"
  - ready with channels: "Ready to start"
  - stalled: the existing `COLLECT_STALLED_TEXT`
  - failed before start: "Could not start: <failReason>"
  - cancelled: "Cancelled <age>"; expired by the sweep: "Expired after <N> days with no activity"
- Also in PR C, as must (F7 part 1, section 3.3): the sha256 skip and the instant step 2 Continue, so a
  returning operator does not wait for a full re-copy.
- Copy: section heading "Your unfinished batches"; buttons "Continue", "Cancel", "Fix and continue",
  "Continue setting up", "Cancel this batch"; cancel confirmation (inline, not a modal): "Cancel
  <name>? Nothing was processed and nothing was charged." with "Yes, cancel" and "Keep it"; leaving line
  from PR C (replacing the PR A line): "You can close this page. Find this batch under Your unfinished
  batches and press Continue when it is ready."
- Acceptance, part 2 (PR C): cancel of a draft, of an ingesting batch, of a failed-before-start batch
  succeeds and of a `matting` batch is 409; tier 2 `ingest.test.ts`: cancel a batch mid-collection, run
  the remaining deliveries and the placing: the batch is still `cancelled` after the last delivery and
  no `catalog_source_images` rows were written; the list page shows the section for the creator and
  not for another operator (admin sees both; a viewer sees the rows without buttons); a
  failed-before-start row carries "Fix and continue", which reopens and opens step 1; browser test
  (scenario 5, PR C form, section 6): close and reopen `/catalog`: the section shows the batch "Ready to
  check" with Continue, which opens step 2 with the grouping; Continue to step 4 and reload: step 4.
- Also in release C: the `?batch=` page test of 14a section 3.4 gains a cancelled batch, which
  redirects to `/catalog/<id>`.

### 3.2 F6, worker side: phase, rate, placing lease and merge writes

The release A part of F6 shipped in 14a section 3.3.

- `BatchCounts` gains `phase: "uploading" | "downloading" | "reading" | "unpacking" | "checking" |
  "placing" | "ready" | "needs_input" | null`, `placed: number`, `placeTotal: number | null`,
  `rate: { at: string; phase: string; done: number }[]` (the last 5 samples, written by the worker with
  each counts update; `done` is `placed` during placing) and `placingClaim: { token: string; until:
  string } | null`. All live in the existing `counts` jsonb; no migration.
- `runIngest` writes `phase` with every `bumpCollected`; `finishIfLast` sets `phase: "placing"` and
  `placeTotal`; placing writes `placed` after every chunk of F7 part 2 (14d section 3.1) (until that
  ships, once at the end) and `phase: "ready"` or `"needs_input"` with `previewReady`. The worker clears
  `rate` whenever it changes `phase`.
- Placing lease. The batch stays `ingesting` until `previewReady` or `failed`: the `finishIfLast` claim
  no longer sets `draft`. It claims with one atomic update that merges `placingClaim = { token, until }`
  into counts (`counts = counts || jsonb_build_object('placingClaim', ...)`) `WHERE status = 'ingesting'
  AND (counts->'placingClaim' IS NULL OR (counts->'placingClaim'->>'until')::timestamptz < now()) AND
  NOT EXISTS (<uploads not collected or failed or removed>)`. `token` is derived from the claiming
  delivery (its run and upload id), so a Cloud Tasks retry of the same task presents the same token;
  `until` is now + `PLACING_LEASE_MS` (builder constant, longer than the 900 s request deadline).
  Continuation deliveries (F7 part 2, 14d section 3.1) carry the token and renew `until` after each
  chunk. A delivery whose token does not match a live lease does nothing. A thrown error leaves the lease
  in place, so the retry with the same token continues from the cursor (F7 part 2) or, before that ships,
  runs the placing again (cheap through the sha256 skip of F7 part 1, section 3.3). A lease that runs out
  without renewal is a stall under the existing `COLLECT_STALL_MS` rule; Try again and `regroupBatch`
  clear it. The closing `patchCounts` sets status `draft` and clears the lease, guarded as in F4 part 2
  (section 3.1).
- Web-tier writes to `counts` while a batch may be `ingesting` merge only the field they change
  (`counts = counts || '{"previewReady": false}'::jsonb`) instead of replacing the object (today
  `regroupBatch` replaces it, `web/lib/catalog/uploads.ts:97`).
- `deriveBatchState` therefore shows "collecting" with the placing text through the whole phase.
- `intakeTimeText(counts, now)` in `status.ts`: uses only the samples of the current `phase`; from the
  last two of them at least 20 s apart, the rate per minute; "about <m> min left" with
  `ceil((total - done) / rate)`, where `total` is that phase's total (`fileCount` while collecting,
  `placeTotal` while placing); "a few minutes left" when under 2 min; omitted when the total is unknown
  or fewer than two current-phase samples exist. Never fitted; the text appears only once a rate is
  measured.
- `deriveBatchState.text` for collecting: "<phase words> <done> of <total><, about <m> min left>",
  phase words from the state words of F4 part 2 (section 3.1). List pill: "<phase words> <done> of
  <total>".
- Step 2 hides the grouping cards while `phase` is not `ready` or `needs_input`. Step 4's bar uses
  `placed` during placing.
- Copy:
  - Leaving line: the PR A line (F4 part 1, 14a section 3.4), replaced in PR C by the line of F4
    part 2 (section 3.1).
  - Collecting banner text: "<phase words> <done> of <total> from your <source>, about <m> min left".
- Acceptance (release C): tier 1 `status.ts`: `intakeTimeText` with placing samples 0 at t0 and 200 at
  t0+100 s over a `placeTotal` of 1,400 gives "about 10 min left"; downloading samples present next to
  one placing sample give no text; no text with one sample; `deriveBatchState` for `ingesting` with
  `phase: "placing"` gives "Placing photos 300 of 1,400"; tier 2 `ingest.test.ts`: during placing the
  batch stays `ingesting` with `phase: "placing"`, then `draft` with `phase: "ready"`; `rate` is emptied
  when the phase changes; a thrown placing leaves the lease and a retry with the same token runs it to
  the end; a delivery with another token while the lease is live does nothing; a lapsed lease can be
  claimed; a `regroupBatch` during `ingesting` leaves `phase` and `placingClaim` untouched (merge).

### 3.3 F7 part 1: placing never re-copies (must, shipped with F4)

Part 2 of F7 (chunked, resumable placing) is in 14d section 3.1.

- `placeRaw`: before copying, `headObject` on the target; when it exists and its stored sha256 (object
  metadata `sha256`, set on write) equals the item's sha256, skip the copy (04's promise).
- `patchDetected` with no change (same options, same sheet choices) returns at once without regrouping,
  so step 2 Continue with nothing changed is instant.
- Acceptance (tier 2): a second placing run on the same batch performs zero copies (the fake storage
  counts `copy` calls); a `patchDetected` with unchanged values performs no enqueue and no upload status
  change.

### 3.4 F8: a batch that failed before Start can be fixed in place (must)

- `POST /reopen` (operator), using `reopenBatch` (written in F5 part 1, 14b section 3.3): a batch with
  status `failed` and `startedAt` null returns to `draft`, `counts.failReason` cleared, `previewReady`
  false, uploads untouched (manifests and staged bytes are reused by the sha256 skip and the manifest
  results). Refused for started batches.
- `assertDraft` sentences by status: `failed` + never started: "This batch could not start. Press Fix
  and continue to change its photos or links."; `ingesting`: "This batch is still collecting. Wait for
  it to finish, or press Try again if nothing has moved for 10 minutes."; any started status: the
  existing "This batch has already started. Make a new batch to add more photos."; `cancelled`: "This
  batch was cancelled. Make a new batch."
- "Fix and continue" (failed batch page, replacing "Start again"; and failed-before-start rows of "Your
  unfinished batches", F4 part 2, section 3.1) performs the reopen, then navigates to
  `/catalog/new?batch=<id>`; step 1 shows the previous `failReason` above the input list. The wizard
  never renders on a failed batch (F4 part 1, 14a section 3.4).
- Acceptance (tier 2 routes): reopen a never-started failed batch: draft, reason cleared, inputs kept;
  reopen a started failed batch: 409; the `assertDraft` sentences; browser test (scenario 3, PR C form,
  section 6): the grid with every link 404 fails, "Fix and continue" opens step 1 with the reason and the
  paste, the operator pastes one link per line, Continue, step 2 ready.
- Copy switch from F5 part 1 (14b section 3.3), made in this release: the all-permanent ending of the
  no-photos sentence for links becomes "Check that the links open in a browser, then press Fix and
  continue and paste the corrected links." (the PR B ending is removed), and the batch page banner for
  a failed links batch carries "Fix and continue" next to the sentence (and, only when some failures
  may be temporary, "Try the failed links again" as in release B). Acceptance: `ingest.test.ts` asserts
  the new all-permanent sentence; the removed-sentences test covers the PR B ending.

### 3.5 F11 part 1: platform errors

Part 2 of F11 (paged hand-off) is in 14d section 3.4.

Part 1 (PR C): `wizardApi`: when `response.headers.get("content-type")` is not JSON or the body does
not parse, throw `WizardApiError` with status and the sentence "The server did not answer in time. Your
files are safe. Reload this page to continue." (502, 503, 504) or "This did not finish. Reload this page
and try again." (anything else). Acceptance: `fetch.test.ts`: an HTML 504 gives the sentence.

## 4. Data and state changes

No migration (the status `cancelled` comes from 14b's `0003_intake_states.sql`). Rows of the parent
data table (section 5) implemented here: `counts.phase`, `placed`, `placeTotal`, `rate` (with `phase`
per sample) and `placingClaim` in the existing `counts` jsonb (`EMPTY_BATCH_COUNTS` gets defaults; old
rows read as null/0); the batch status `cancelled` in use; the new routes `POST cancel` and `POST
reopen`. Builder constant `PLACING_LEASE_MS` (parent section 5). No new env var.

## 5. Copy

Exact sentences are in the fixes above and in the parent copy register (section 6), rows marked "C":
List section; Batch page ("Cancel this batch", "Fix and continue"); Cancel confirmation; State words;
Time; Leaving line, from PR C; No photos, links (the from-PR-C ending); assertDraft; Platform error.
Sentences removed by this release: the PR A leaving line and the PR B no-photos ending.

## 6. Acceptance tests

- Tiers 1 and 2 (`pnpm test`, CI): every "Acceptance" item in section 3, in the test files named
  there, plus `apps/web/test/catalog-intake-routes.test.ts` (cancel, reopen) and
  `apps/web/test/catalog-intake-ui.test.ts` (UnfinishedBatches), and the general rules of parent 8.2.
- Browser test (parent 8.3 harness), scenarios extended or landing with this release:
  3. grid, all 404, release C extension: after the release B form, "Fix and continue" reopens step 1
     with the paste; one link per line pasted; step 2 ready (F5, F8).
  5. leave and return, release C extension: after the release A form, navigate to `/catalog`: "Your
     unfinished batches" with the state words; Continue opens step 2; once ready, Continue to step 4,
     reload, step 4 (F4, F6).
  7. phone: scenarios 2 and 5 at 390 x 844 assert the section and the State column are visible without
     horizontal scroll.
- Tier 3 and tier 4: not required. Tier 5: runs inside `infra/deploy.sh` as always.

## 7. Fixtures

No new fixture. Uses all four fixtures of parent 8.1 (created by releases A and B).

## 8. Local verification

From the feature worktree:
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`, then
`pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts` (scenarios 1
to 7 green, with 3 and 5 in their release C form).

## 9. Live verification (after deploy, Test Brand only)

Step 0: the quiet check and the rules of parent 8.4. From this release, every batch a step makes is
also cancelled through the UI at the end.

1. Paste the large-sheet stand-in as a real Google Sheet (a sheet shared with `catalog-web@`, 60 rows),
   Continue, close the tab after the first count moves; from the list's "Your unfinished batches" press
   Continue; the count shows phase words and, once measured, the time; finish to step 4 without
   starting; reload tests on steps 2 and 4; back to step 2 and press Continue with no change: it returns
   within 3 s (no re-copy); cancel with the new confirmation.
2. Paste a single `http` link into a new batch: it fails before start; "Fix and continue" opens step 1
   with the reason.
3. Then, after the operator is told: cancel the two BHPC test drafts (574f2025, 09dd86f2) through the UI
   and clean their `catalog-test/` prefixes once with `deleteTestObjects` (proposal section 5, "What to
   do with the existing drafts"; decision 3 in parent section 11: both are cancelled whatever the BHPC
   key turns out to be); no manual database writes.
4. Clean the run's batch objects with `deleteTestObjects` and confirm an empty listing of the run's
   prefixes.

## 10. Rollout and rollback

Merge, then `infra/deploy.sh` deploys web and worker (no migration); the tier 5 smoke runs inside
deploy.sh as always. Rollback per 00 section 6 (`SKIP_BUILD=1` from the previous commit). A rollback
keeps cancelled batches cancelled (the status stays valid under B's constraints); the previous code
does not list them specially.

## 11. Report

The 00 section 10 report, plus: the per-fix acceptance results; the browser test video or GIF of
scenarios 3 and 5 (release C form); the live verification log of section 9 with the quiet-check
timestamps and the cleanup listing; the contract changes proposed to 02 (`BatchCounts` fields, the
`cancel` and `reopen` routes); the state of the existing drafts after the cancellations of section 9
step 3; the measured placing rate used by `intakeTimeText` on the live stand-in. Last line: "Ready for
the next spec: 14d Intake release D".

## 12. Done when

- [ ] F4 part 2, the F6 worker side, F7 part 1, F8 (with the F5 copy switch) and F11 part 1 are built
      and every acceptance item in section 3 passes in CI.
- [ ] Browser scenarios 3 and 5 (release C form) and 7 pass locally and in CI; all earlier scenarios
      still pass.
- [ ] The removed sentences of section 5 are absent from `apps/web` and `packages/core` sources.
- [ ] PR C merged; `catalog-web` and `catalog-worker` deployed; tier 5 smoke green.
- [ ] Live verification of section 9 done, including the draft cancellations, with the quiet check
      logged and `catalog-test/` cleanup confirmed.
- [ ] Report written.
