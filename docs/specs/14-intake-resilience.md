# 14 Intake resilience

Catalog module, spec 14, the parent of four release specs. This file is not executed by itself: each
release is executed on its own with `docs/specs/00-execution-protocol.md`, strictly in the order of
section 7, and each release file reads this one first. Source of truth: `docs/SPEC.md` (ingestion
sources, UI, non-goals). Depends on 02 (schema, storage, tasks), 04 (the adapters, `Detected`,
`groupItems`, `runIngest`, `buildDetectedStep2`, `buildPreview`), 06 (the wizard, the batch page, the
list, `deriveBatchState`, `ingestBatch`, `regroupBatch`). Proposal and evidence:
`docs/plans/proposals/2026-10-27-intake-resilience/00-proposal.md` and the `.runs/2026-10-27-*` reports
it cites. Approval: every owner decision was made on 2026-10-27 (section 11); the releases are approved
to build in order.

| Release | Spec file | Branch | Deploys |
|---|---|---|---|
| A, truth and way back | [`14a-intake-release-a.md`](14a-intake-release-a.md) | `feat/catalog-14a-intake-truth` | `catalog-web` |
| B, inputs, failures, migration 0003 | [`14b-intake-release-b.md`](14b-intake-release-b.md) | `feat/catalog-14b-intake-inputs` | migrate job, `catalog-web`, `catalog-worker` |
| C, resume and progress | [`14c-intake-release-c.md`](14c-intake-release-c.md) | `feat/catalog-14c-intake-resume` | `catalog-web`, `catalog-worker` |
| D, the should set | [`14d-intake-release-d.md`](14d-intake-release-d.md) | `feat/catalog-14d-intake-should` | `catalog-worker`, `catalog-web` |

Plain-language terms. Draft: a batch that exists but has not been started. Collection: the system
downloading or reading the photos. Placing: copying each photo to its product's `raw/` object (the
first half of what the code calls `finishBatch`). Grouping: sorting photos into products. Readback:
the sentence the system says back about what it understood from an input, before anything runs.
Transient failure: one that may succeed on a second try (a timeout, a 429 or a 5xx); permanent: one
that will not (404, 403, not an image). Lease: a claim with an expiry time that its holder renews while
it works; when the holder dies, the lease runs out and someone else may take over. Release: one of the
four parts A to D of this spec; each ships as one PR, called PR A to PR D in the release files.
Paths: `web/` means `apps/web/`, `ingest/` means `packages/core/src/catalog/ingest/`.

## 1. Purpose

The first real operator made three batches on 2026-10-26 and started none: an uploaded xlsx crashed
step 2; a pasted grid of links was glued into broken URLs and failed with a wrong reason; a Google
Sheet collected for 17 minutes behind a fixed sentence and the operator left before it was ready.
None of the three could be resumed. This spec makes intake accommodate how people actually work:
they bring links in whatever shape they have, they retry, they leave and come back, they try several
routes. The principles of the proposal (section 3 there) are the acceptance bar: understood or
refused with a readback; nothing silently lost or invented; the batch, not the tab, is the unit of
work; every wait shows a count and an honest time; every failure names rows, reason and next step and
transient failures are retried by the system; every unfinished batch can be found and resumed; a
correction never restarts and never duplicates; and no screen says something false.

## 2. What the operator sees

The same four steps. Differences, in the order an operator meets them (the release that brings each is
in brackets):

1. Step 1 lists everything the batch holds (files, pastes, Google links), each with Remove. Editing the
   paste box changes the paste in place. A paste gets a readback: rows, links, links per row, how
   products will be named (with a hint when the paste has no product code column), rows that would get
   the same name, and whether the first three links open; "Checking your links..." shows while the check
   runs. Links that turn out to be share pages are explained with the alternative. A file cut off by a
   closed tab says so and can be removed. [B]
2. As soon as the batch exists (the first file or paste), its id is in the address bar. From then on
   reload, Back, a crash, a closed tab or a day away lose nothing: the batch page carries "Continue
   setting up", which reopens the wizard at the right step [A], and the batch list opens with "Your
   unfinished batches" at the top, each with its state in words, its age, Continue and Cancel [C].
3. Step 2 renders at once [A]. While the system works it shows the phase, a count and a time:
   "Downloading photos 612 of 1,400, about 7 min left", then "Placing photos 300 of 1,400" [C]. A sheet
   that is still being read says so. Nothing shows zeros as results. [A]
4. Failures are listed by row and link with the reason and the next step, separately from unreadable
   files. "Try the failed links again" re-fetches only those, and is offered only when some failures
   may be temporary [B]. Transient failures are retried by the system first (F5 part 2) [D].
5. The batch page of a draft says "created", carries Continue setting up, and its Compare and Links
   sheet tabs say the batch has not started [A]. A failed batch offers "Fix and continue" with the
   inputs kept [C].

No new setting, no model name, no technical word in any sentence. The spec 07 banned-names test keeps
passing.

## 3. Scope

In scope: the files listed in section 2 of each release file, and tests and fixtures.

Out of scope: everything after `POST /start`; the identifier, precedence and column detection rules
of 04 (only the cell split and the readback change); new input routes; resumable browser uploads;
Drive folder collection beyond F13 (section 9); the list's search or paging beyond the unfinished
section.

## 4. Conventions for the fix sections

Each fix of the proposal (F1 to F12) is specified in a release file with behaviour, contracts, copy
and acceptance tests; where a fix ships in two releases, each release file holds its own part and
points to the other. F13 is deferred and specified in section 9 here. F14 (the finished-collection
email) was dropped on 2026-10-27 (section 11, decision 5). Sentences in quotes are exact.
`<n>` placeholders are numbers with thousands separators and singular/plural handled by the existing
`plural` helper. Cross-references name the fix and the file, for example "F8 (14c section 3.4)".

## 5. Shared data model and state table

| Change | Where | Migration? | Release |
|---|---|---|---|
| `counts.phase`, `placed`, `placeTotal`, `rate` (with `phase` per sample), `placingClaim` | `catalog_batches.counts` jsonb (`BatchCounts` type) | No (jsonb; `EMPTY_BATCH_COUNTS` gets defaults; old rows read as null/0) | C |
| `counts.linkFailures` | same | No | B |
| `detected.reading` | `catalog_uploads.detected` jsonb (via `DetectedStep2.sheets[].reading`) | No | A |
| `detected.linksPerRow`, `shape`, `collisions`, `sample` | `catalog_uploads.detected` jsonb | No | B |
| manifest `attempts`, `final`; `place-state.json` | bucket objects | No | D |
| `options.expired` | `catalog_batches.options` jsonb | No | D |
| Upload status `removed` | `catalog_uploads.status` CHECK constraint (`schema.ts:275,283`) | **Yes**: `0003_intake_states.sql` drops and recreates the two CHECK constraints with the new values (14b section 4.1) | B |
| Batch status `cancelled` | `catalog_batches.status` CHECK constraint (`schema.ts:237,256`) | **Yes** (same migration; first used in release C) | B, used from C |
| `SafeFetchOptions.headers`, `truncateAt` | `packages/core/src/safe-url.ts` | No | B |
| New routes `DELETE uploads/[uploadId]`, `PATCH|DELETE links/[uploadId]`, `POST retry-links` | web | No | B |
| New routes `POST cancel`, `POST reopen` | web | No | C |
| Worker task `/tasks/catalog/ingest-more` | worker | No | D |
| Env `DRAFT_EXPIRY_DAYS` (14) | worker, deploy.sh | No | D |

Builder constants (in code, not env, proven in tier 2): `LINK_RETRY_ATTEMPTS` (3), `LINK_MAX_ATTEMPTS`
(9), `INGEST_TIME_BUDGET_MS` (600 s), `PLACE_BUDGET_ITEMS` (start 800), `PLACING_LEASE_MS`,
`HAND_OFF_PAGE` (500).

State table (where an unfinished batch can be, and what the operator sees):

| State | Status and counts | State words (copy register) | Release |
|---|---|---|---|
| No input | `draft`, no non-removed upload | Nothing added yet | A (wizard step), C (words) |
| Pending uploads | `draft`, uploads `pending` | <n> files did not finish uploading | C |
| Collecting | `ingesting`, `phase` downloading, reading, unpacking or checking | Downloading photos <done> of <total> / Reading your sheet / Unpacking your zip / Checking your uploaded files, + time | A (polled text), C (phase and time) |
| Placing | `ingesting`, `phase: "placing"`, `placingClaim` live | Placing photos <placed> of <total> + time | C |
| Needs a column | `draft`, `phase: "needs_input"` | Needs your input: which column holds the identifier? | C |
| Ready, no channels | `draft`, `previewReady`, no channels | Ready to check | C |
| Ready with channels | `draft`, `previewReady`, channels chosen | Ready to start | C |
| Stalled | `ingesting`, no progress for `COLLECT_STALL_MS` | the existing `COLLECT_STALLED_TEXT` | existing |
| Failed before start | `failed`, `startedAt` null | Could not start: <reason> | C |
| Cancelled | `cancelled` | Cancelled <age> | C |
| Expired | `cancelled` with `options.expired` | Expired after <N> days with no activity | D |

Migration (decided): the owner approved `0003_intake_states.sql` on 2026-10-27 (section 11, decision
1). It ships in release B with `schema.ts`; the no-migration alternative (hard-deleting removed uploads
and marking cancellation in `options`) was rejected and is not built.

## 6. Copy register

The single source of every new or changed sentence, for the no-model-names test and for review.
Placeholders in angle brackets. No raw rule ids, no model ids, no technical words. The Release column
says which release introduces the row; the release files point here.

| Where | Sentence | Release |
|---|---|---|
| Step 2 sheet reading | Reading your sheet. The columns will appear here when it has been read. | A |
| Error page, batch known | Something went wrong on our side. / Your batch is safe; nothing was lost. / Open this batch / All batches / Try this page again | A |
| Error page, no batch known | Something went wrong on our side. / All batches / Try this page again | A |
| Paste waiting | Checking your links... | B |
| Paste readback | <rows> rows, <links> links / <links> image links / <min> to <max> links per row. / <k> links per row. | B |
| Paste naming | Products will be named by the first column, for example <id>. / This paste has no product code column, so products will be named from the photo file names, for example <name>. To name them yourself, copy the product code column in as the first column. / Products will be named from the file names, for example <name>. | B |
| Paste sample | We opened the first <tried> links: all fine. / We opened the first <tried> links: <ok> of <tried> opened; <reason phrase of the first failure>. | B |
| Paste share pages | These look like share pages, not image links. Download the photos and drop them here, or paste direct image links. | B |
| Paste same name | Rows <r1> and <r2> would get the same name, <name>. Check those rows before you continue. | B |
| Paste ignored cells | <n> empty or non-link cells were ignored. | B |
| Input list | Remove / Uploading <p>% / Uploaded / Checked / Upload failed. Try again or remove it. / Upload did not finish. Add the file again or remove it. / Removed | B |
| List section | Your unfinished batches / Continue / Fix and continue / Cancel / Show cancelled | C |
| Batch page | Continue setting up (A) / Cancel this batch (C) / Fix and continue (C) / Try the failed links again (B) | A, B, C |
| Cancel confirmation | Cancel <name>? Nothing was processed and nothing was charged. / Yes, cancel / Keep it | C |
| State words | <n> files did not finish uploading / Nothing added yet / Downloading photos <done> of <total> / Reading your sheet / Unpacking your zip / Checking your uploaded files / Placing photos <placed> of <total> / Ready to check / Needs your input: which column holds the identifier? / Ready to start / Could not start: <reason> / Cancelled <age> / Expired after <N> days with no activity (D) | C, D |
| Time | about <m> min left / a few minutes left | C |
| Leaving line, PR A | You can close this page. Open this batch again from the batch list and press Continue setting up when it is ready. | A (removed in C) |
| Leaving line, from PR C | You can close this page. Find this batch under Your unfinished batches and press Continue when it is ready. | C |
| Link failures card | Links that could not be downloaded / <total> of <links> links could not be downloaded (<products> products affected). / <count> <reason phrase>, for example <url> (<where>). / Show all <total> / Transient problems were tried <attempts> times. (D) | B, D |
| Reason phrases | answered 'not found' (404) / were refused (403) / did not answer in time / returned a web page instead of an image / use http instead of https / could not be reached | B |
| Step 4 link pair | <k> links could not be downloaded. / <products> products are missing shots: <ids>. Try the failed links again, fix the sheet, or continue without them. / <products> products are missing shots: <ids>. Fix the links, or continue without them. | B |
| No photos, links | No photos could be downloaded from the <n> links you <pasted / listed in <sheet>>. <count> <reason phrase>, for example <url> (<where>). + one of: Check that the links open in a browser, then press Fix and continue and paste the corrected links. (all permanent, from PR C) / Check that the links open in a browser, then make a new batch and paste the corrected links. (all permanent, PR B only) / Some of these may work on a second try. Press Try the failed links again. (some temporary) | B, C |
| assertDraft | This batch could not start. Press Fix and continue to change its photos or links. / This batch is still collecting. Wait for it to finish, or press Try again if nothing has moved for 10 minutes. / This batch was cancelled. Make a new batch. | C |
| Platform error | The server did not answer in time. Your files are safe. Reload this page to continue. / This did not finish. Reload this page and try again. | C |
| Draft banner | Ready to check. Press Continue setting up to see the grouping and choose marketplaces. | A |
| How this works, draft | This batch has not started. Continue setting it up to check the grouping, choose marketplaces and start. Nothing is processed and nothing is charged until you press Start. | A |
| Not-started tabs | This batch has not started. <photos> photos found for <products> products; nothing has been made yet. | A |
| Header | created <time> by <email> | A |
| Brand page empty | No products of <brand> yet. | A |
| Same photos pair | These photos are already in <name> (<state>, created <age>). / <shared> of <photos> photos are the same, under different identifiers (<there> there, <here> here). Continue that batch or cancel it before starting this one, so the same product is not made twice. (<name> links to that batch) | D |
| Duplicate photo pair | <k> photos appear under two products. / <name> is in <id a> and <id b>. Check the sheet before starting. | D |

Removed sentences: "Processing starts by itself. You can close this page." (A); "N image links" for a
grid (B); "<n> other files" for links (B); "started <time>" on unstarted batches (A); the PR A leaving
line and the PR B no-photos ending, once PR C ships (C).

## 7. Releases and build order

Must set: F1, F2, F3, F4, F5 (visible part), F6, F8, F9 (releases A to C). Should set: release D.
Order A, B, C, D, each merged and deployed before the next starts (approved,
section 11, decision 4).

| Release | Fixes | Worktree | Depends on |
|---|---|---|---|
| A, truth and way back (small, first) | F1, F9, the release A part of F6 (copy and step 2 text from the existing counts, no worker change), F4 part 1 (`?batch=` in the URL, `/catalog/new?batch=` for draft and ingesting batches, `wizardStepFor`, "Continue setting up" on the batch page) | `catalog-module-wt\14a-intake-truth` | nothing; deployable alone |
| B, inputs and failures | F2, F3, F5 part 1, migration `0003_intake_states.sql` + `schema.ts` | `catalog-module-wt\14b-intake-inputs` | A merged |
| C, resume and progress | F4 part 2 (unfinished section, Cancel, cancel guards), F6 worker side (phase, rate, lease, merge writes), F7 part 1 (sha256 skip, instant Continue), F8, F11 part 1 | `catalog-module-wt\14c-intake-resume` | A, B merged |
| D (should) | F7 part 2 (groupBatch first, chunked placeBatch), F5 part 2 (automatic retry), F10, F11 part 2 (`ingest-more`), F12 | `catalog-module-wt\14d-intake-should` | C merged |
| later | F13 (section 9) | own PR | none |

Within a release, workstreams that touch the same files run one after the other in the release's
worktree (00 section 3). Builders follow the 00 section 4 brief and fetch current docs through Context7
before using any library, framework, API or SDK (each release file names the ones it uses).

## 8. Shared tests

### 8.1 Fixtures (the three real inputs, replayed with small Test Brand stand-ins)

Each fixture is created by the first release that uses it (named in brackets).

Under `packages/core/test-fixtures/catalog/intake/`, all created in `test_brand` and with example.com
hosts (served by the tests' fake fetch; never the real `sceimage` host). File names follow the real
style (`BH-4610-NE-NERO_1.JPG`), and in every fixture one of the six products has file names with a
space (`BHSS2620Z-WHITE NAVY_1.JPG` style), as in the real list:

- `intake-xlsx-grid.xlsx` [A] (attempt 1 stand-in): one sheet, a title row above the header, header row
  with 12 columns including `Option Id` at column E, `EAN` at column G, `Image Link 1` to `Image Link 5`
  at columns H to L; 8 data rows for 6 products (two identifiers repeated on a second row, as sizes);
  three products with 4 links and three with 5 (27 links); blank cells elsewhere. Expected: identifier
  column E, photo columns H to L, 6 products, 27 photos, the duplicate-identifier warning with 2, and the
  space-name product with all its shots.
- `intake-pasted-grid.txt` [B] (attempt 2 stand-in): the same 6 products as tab-separated rows without an
  identifier column, three rows of 4 links and three of 5, two trailing `0` cells and one blank cell
  (27 links, 3 ignored cells), one row's links containing a literal space. Expected: shape `links_grid`,
  the readback of F2 (14b section 3.1), 6 products, 27 photos, the space-name product with 5 shots.
- `intake-pasted-variants.txt` [B]: 7 rows, 12 links: (1) a 2-column row (URL, URL) with no identifier;
  (2) an `id<TAB>url<TAB>url` row with identifier `TB-B`; (3) a line with two links separated by a
  space; (4) a Dropbox share link (the fake host answers `text/html`); (5) an `http` link; (6) and (7)
  a colliding pair: two rows of 2 links each, no identifier, whose first links share the stem `TB-F`.
  Expected: shape `id_and_links`, the readback of F2 (14b section 3.1) with "Rows 6 and 7 would get
  the same name, TB-F."; at collection, row 4 fails as "returned a web page instead of an image" and row
  5 as "use http instead of https" (both permanent).
- `intake-large-sheet.csv` [A] (attempt 3 stand-in, the Google Sheet as the csv the web tier writes):
  `Unicommerce Code` + 5 link columns, 60 rows, 287 links (the real product count, used here as the link
  count), with identifiers that are the xlsx fixture's identifiers plus `_OD` for the first 6 rows (for
  F10, 14d section 3.3; this includes the space-name product). Used with a fake fetch that delays 50 ms
  per link and `INGEST_BUDGET_ITEMS` lowered to 40 so the batch takes several deliveries and shows moving
  counts.
- [A] A builder script `packages/core/test-fixtures/catalog/intake/build.ts` regenerates the xlsx from
  the csv so the two stay in step; the generated files are committed.

### 8.2 Tiers 1 and 2 (`pnpm test`, CI)

Every acceptance item of every release is tier 1 or 2 as marked, in the existing test files named there
plus `apps/web/test/catalog-intake-routes.test.ts` (new routes) and
`apps/web/test/catalog-intake-ui.test.ts` (InputList, LinkFailures, UnfinishedBatches, PasteBox waiting
state). The spec 04 and 06 suites stay green; the no-model-names test runs over the new sentences; a new
test asserts the removed sentences of section 6 are absent from `apps/web` and `packages/core` sources
(each from the release that removes it).

### 8.3 Browser test harness (tier 4-style, local; `apps/web/test/catalog-intake.browser.spec.ts`)

A committed version of the local harness used for the ux report
(`apps/web/.playwright/intake-ux-local.test.ts`, git-ignored): the real wizard bundle, the real route
handlers, PGlite, in-memory storage, a fake queue that runs `runIngest`, a fake image host, Google
disabled. The harness is created by release A. Scenarios are each a replay of a real attempt or of a
principle; they are in the release files: 1, 5 (first form) and 6 in 14a; 2, 3 (first form) and 4 in 14b;
the extensions of 3 and 5, and 7, in 14c.

Runs locally and in CI the way the ordering spec runs today: `pnpm --filter @catalog/web exec playwright
test --config test/catalog-intake.config.ts` (a copy of `catalog-wizard-ordering.config.ts` with the
new `testMatch`; the builder adds the CI step next to the ordering one).

### 8.4 Live verification rules (after each deploy, Test Brand only)

Rules: no load or eval runs while an operator is active. Before each step, the quiet check: no operator
POST in the web request log in the last 60 minutes (`gcloud logging read` on `catalog-web` request
logs, `httpRequest.requestMethod="POST"` by non-owner principals) and no batch in `ingesting` or a
processing status. Every object written lands under `catalog-test/test_brand/<batchId>/`; every
batch made by a step is cleaned at the end with `deleteTestObjects` (allowed under `catalog-test/`)
and, from PR C, cancelled through the UI. Inputs are small (at most 30 photos); the 1,400-photo scale
is not replayed live. Each step checks only what its PR ships. Each release file lists its own live
steps; each ends with `catalog-test/` cleanup confirmed by an empty listing of the run's prefixes.

## 9. F13: Google and Drive edge cases (deferred, later)

Deferred because no operator has used Drive folders yet (proposal, F13). Built in its own PR when
needed, after release D, executed with 00 like a release.

- `PasteBox`: "Check again" next to a "No access yet" pill re-posts the same text (bypassing the
  `savedText` guard).
- Drive folder (`ingest/drive-folder.ts`): the size check (`DRIVE_FOLDER_MAX_BYTES`) runs at paste time
  from the full listing and the "too large" sentence of 04 is shown at paste; the worker keeps
  `prior.rejected` when rebuilding `detected`.
- Acceptance: routes test with the Google fakes of 04.

## 10. Assumptions (stated, not asked)

1. The three attempts are representative of operator behaviour even though they come from one person
   on one evening (db, section 5 item 7); the fixes are ordinary resilience and are worth building
   regardless.
2. The sample fetch of three links at paste time (F2, 14b section 3.1) is acceptable: it is a range
   GET of 1 KiB through `safeFetch` in its truncate mode, the same SSRF-safe path the worker uses, and
   never a write.
3. The paste box holds one `url_list` row per batch; an operator who wants two lists pastes them
   together. Google links keep one row each.
4. "Failed before Start" means `status = failed` and `startedAt` null; a swept batch (2 hours without
   progress during collection) also qualifies and can be reopened.
5. A cancelled or expired draft keeps its bytes until the existing raw lifecycle. The only deletion is
   the one-off cleanup of the two BHPC test drafts under `catalog-test/` in 14c section 9 step 3.
6. `wizardStepFor` never returns 3: step 3 is reached from step 2 by Continue, which is cheap once
   the grouping is ready; a batch with channels already chosen opens at 4.
7. The placing chunk size, the lease length and the link retry bounds are builder constants proven in
   tier 2 against the 900 s deadline; they are not tuned live.
8. Admins see every operator's unfinished batches; operators see their own; viewers see "Your
   unfinished batches" read-only, with no actions.
9. A server upload row still `pending` that the current browser session is not uploading is treated as
   cut off (closed tab); the operator decides whether to add it again or remove it.

## 11. Owner decisions (decided 2026-10-27; to be recorded in `docs/SPEC.md`)

1. One migration (`removed`, `cancelled`), shipped in release B: **yes**. The no-migration alternative
   is rejected.
2. `DRAFT_EXPIRY_DAYS`, after how many days the sweep cancels an untouched draft: **14**.
3. BHPC product key (Option Id or Unicommerce Code): **as recommended**. The operator is asked once and
   the answer is recorded in the brand's notes before any real BHPC batch; both test drafts (574f2025,
   09dd86f2) are cancelled either way (14c section 9).
4. The must set (F1, F2, F3, F4, F5 visible part, F6, F8, F9) and the release order A, B, C, D:
   **approved**.
5. Email when a long collection finishes: **no**, dropped on 2026-10-27; operators return to the
   dashboard (Your unfinished batches).

Interim, until release A ships (proposal section 7): the owner tells the operator to use the Google
Sheet route and keep the wizard tab open until step 2 shows the grouping.

## 12. Non-goals

- No change to processing after Start (matting, render, QA, publish, sheets, re-check).
- No change to the core flow: four steps, one brand per batch, no stored defaults, channels chosen
  fresh every batch (SPEC.md non-goals).
- No new input routes (Dropbox, OneDrive, WeTransfer APIs); a share page is explained with a clear
  sentence and the existing alternative (download and drop).
- No resumable or chunked browser uploads; a big zip on a flaky line still restarts.
- No language model anywhere in intake; no model names or technical settings in any new sentence.
- No change to the identifier rules, precedence rules or sheet column detection of spec 04, except the
  cell split (F2) and the readback.
- No automatic merging of the two BHPC drafts; a person chooses the key.
- No outgoing email or other notifications (F14 was dropped on 2026-10-27; operators return to the
  dashboard, Your unfinished batches).
