# 14d Intake release D: the should set

Catalog module, spec 14, release D of four. Execute with `docs/specs/00-execution-protocol.md`. Parent:
`docs/specs/14-intake-resilience.md`; read its terms, sections 1 to 6 and section 8 before this file.
Source of truth: `docs/SPEC.md`. Depends on releases A, B and C (`14a-intake-release-a.md`,
`14b-intake-release-b.md`, `14c-intake-release-c.md`) merged and deployed. Branch
`feat/catalog-14d-intake-should`, worktree
`C:\Users\Sujan Ajay\Desktop\catalog-module-wt\14d-intake-should`. Deploys `catalog-worker` and
`catalog-web` (no migration). Approval: approved by the owner on 2026-10-27 (parent section 11,
decisions 2 and 4). This release ships as one PR, called PR D in the text below.

## 1. What changes for the operator

- Large batches finish: placing runs in resumable chunks with a moving count, and a change of options
  only on step 2 regroups without re-copying.
- Temporary link failures (a busy server, a timeout) are retried by the system before the operator sees
  them; the card says how often.
- Step 4 warns when the same photos are already in another unfinished batch of the brand (with a link
  to it), and when one photo sits under two products.
- One Continue is enough for any number of loose files.
- Drafts untouched for 14 days are cancelled by the system as "Expired after 14 days with no activity";
  their photos are kept.

F14 (an email to the batch creator when a long collection finishes) was dropped by the owner on
2026-10-27 (parent section 11, decision 5): operators return to the dashboard (Your unfinished
batches). Nothing of F14 is built.

## 2. Scope

In scope: `ingest/{index,overwrite-preview,group}.ts` (`groupBatch`, `placeBatch`, link retry, time
budget), `apps/worker/src/catalog/{ingest,sweep}.ts`, `apps/worker/src/index.ts` (the
`/tasks/catalog/ingest-more` handler), `web/lib/catalog/uploads.ts` (`ingestBatch` paging),
`web/components/catalog/{WizardStep2,WizardStep4,LinkFailures}.tsx` (warnings, the retried sentence),
`infra/deploy.sh` (worker env `DRAFT_EXPIRY_DAYS`), and tests.

Out of scope here: everything the parent lists as out of scope, every fix or part assigned to releases
A, B and C (parent section 7), F13 (parent section 9, deferred) and F14 (dropped). Builders fetch
current docs through Context7 before using Cloud Tasks or any other library they touch.

## 3. Fixes

Sentences in quotes are exact (parent section 4).

### 3.1 F7 part 2: placing in resumable chunks (should)

Part 1 of F7 (the sha256 skip, instant Continue) shipped in 14c section 3.3.

- `finishBatch` is reordered and split. `groupBatch` runs first: `removeDraftRows`, `assemble`,
  matching and `findOrCreateProduct`, then saves the planned shot list (`{ productId, pathKey, n,
  sourceUri, sha256 }[]`) to `place-state.json` under `derived/_ingest/` (sibling of
  `preview-state.json`). `placeBatch` then copies that list in chunks of `PLACE_BUDGET_ITEMS` (builder
  constant, chosen to stay well inside 900 s at the measured 280 photos/min, start 800) with the sha256
  skip; after each chunk it writes `counts.placed`, renews the lease of F6 (14c section 3.2) and
  re-enqueues itself with the cursor and the lease token. The delivery that places the last chunk inserts
  the `catalog_source_images` rows, writes `preview-state.json` and sets the counts (`previewReady`,
  `phase`, status `draft`, guarded as in F4 part 2, 14c section 3.1).
- `regroupBatch` after a step 2 change whose only effect is options (identifier mode, precedence,
  sheet columns, sheet kind) does not touch upload statuses; it reruns `groupBatch` with the new options
  and then `placeBatch`, where the sha256 skip makes unchanged photos free.
- Unproven risk: `groupBatch` alone at about 2,000 products has not been measured against the 900 s
  deadline. The builder measures it in tier 2 with fakes at that size and reports the time (section 11);
  if it does not fit with a wide margin, that is raised as an open issue, not solved silently.
- Acceptance (tier 2): 1,000 fake items with `PLACE_BUDGET_ITEMS` 300: four placing deliveries,
  `placed` moves 300, 600, 900, 1,000, the batch is `ingesting` with `phase: "placing"` throughout, then
  `draft` ready; `catalog_source_images` rows appear only after the last chunk; a killed delivery (the
  test throws after chunk 2) leaves the lease and cursor so the retry with the same token continues at
  chunk 3; an options-only regroup runs `groupBatch` then `placeBatch` with zero copies and no upload
  status change.

### 3.2 F5 part 2: automatic retry of transient link failures (should)

Part 1 of F5 (the visible part) shipped in 14b section 3.3.

- Item results in the manifest gain `attempts: number` and `final: boolean`. A transient failure is
  retried inside the delivery up to `LINK_RETRY_ATTEMPTS` (builder constant, 3) with backoff 2 s, 8 s,
  and stored with `final: false`; retries use a 20 s timeout (the first attempt keeps the existing
  60 s). A permanent failure is stored `final: true`.
- Within one run, continuations never re-fetch non-final items: they carry the run's results forward.
  Only a new run (Try again, regroup, `POST /retry-links`) clears non-final results so they are fetched
  again. After `LINK_MAX_ATTEMPTS` (builder constant, 9) attempts across runs, a link is stored
  `final: true` with its reason. `POST /retry-links` is the operator's explicit request and drops the
  results with their attempt history (part 1, 14b section 3.3).
- The delivery gets a time budget next to the item budget: after `INGEST_TIME_BUDGET_MS` (builder
  constant, 600 s) of work it starts no new item, saves the manifest with the results so far and
  re-enqueues itself with the cursor, so a slow or dead host can no longer push a delivery past the
  900 s deadline and lose the whole chunk (paths #30).
- Copy, added to the step 2 card when any link was retried: "Transient problems were tried <attempts>
  times."
- Acceptance (part 2, tier 2 `ingest.test.ts`): a fake fetch that answers 503 twice then 200 for one
  item gives 1 photo with `attempts: 3`; a 404 item is `final: true` and not re-fetched on a second run
  (fetch count unchanged); a 429 item left non-final is not re-fetched by a continuation of the same run
  and is re-fetched by a new run; after `LINK_MAX_ATTEMPTS` attempts across runs it is stored final with
  its reason; a fake host answering after 60 s every time still yields a saved manifest and a
  continuation.

### 3.3 F10: the same photos in another batch are flagged

- `buildOverwritePreview` gains `sameBatches: { batchId: string; name: string; createdAt: string;
  state: string; sharedPhotos: number; example: { here: string; there: string } | null }[]`: the brand's
  other `draft`, `ingesting` and failed-before-start batches (same `is_test`) whose source rows share at
  least 10 sha256 values or 20% of this batch's, with one example of the two identifier spellings
  when they differ. And `duplicatePhotos: { sha256: string; identifiers: string[]; name: string }[]`
  for photos under two identifiers in this batch (the Tan/Black case).
- Step 4 warning pairs:
  - "These photos are already in <name> (<state>, created <age>)." + "<shared> of <photos> photos are
    the same<, under different identifiers (<there> there, <here> here)>. Continue that batch or cancel
    it before starting this one, so the same product is not made twice." `<name>` is a link to
    `/catalog/<batchId>`.
  - "<k> photos appear under two products." + "<name> is in <id a> and <id b>; <more>. Check the
    sheet before starting."
- Neither blocks Start (the operator may be re-delivering on purpose).
- Acceptance (tier 2 `overwrite-preview.test.ts`): two drafts with the same 12 hashes under `X` and
  `X_OD` give one `sameBatches` entry with the example; a started batch is not listed; one photo under
  two identifiers gives one `duplicatePhotos` entry; `group.test.ts`: both pairs; UI: the batch name in
  the first pair links to the other batch.

### 3.4 F11 part 2: paged hand-off (should)

Part 1 of F11 (platform errors) shipped in 14c section 3.5.

Part 2 (PR D, should): `ingestBatch` hands over at most `HAND_OFF_PAGE` (builder constant, 500)
`uploaded` rows in the web request, then enqueues one `/tasks/catalog/ingest-more` task `{batchId, run}`
and returns `{ collecting: true, remaining }`. That task (handler in `apps/worker/src/catalog/ingest.ts`,
registered in `apps/worker/src/index.ts`) hands over the next `HAND_OFF_PAGE` rows still `uploaded` and
re-enqueues itself until none remain, so one Continue is enough for any count. Acceptance: routes and
worker: 1,200 fake uploads produce one web page and two `ingest-more` deliveries, and every upload
reaches the queue exactly once (fake queue count).

### 3.5 F12: draft housekeeping and a trace per delivery

- Sweep: a `draft` batch (never started, not cancelled) whose `updated_at` is older than
  `DRAFT_EXPIRY_DAYS` (env, default 14; decided 2026-10-27, parent section 11
  decision 2) is cancelled with `options.expired = { at, days }`; the list shows "Expired after <N> days
  with no activity". Objects are untouched.
- `handleIngestTask` logs one INFO line per delivery: `{ event: "ingest", batchId, uploadId, phase,
  done, total, ms, outcome }`.
- Acceptance: `sweep.test.ts`: a 15-day draft is cancelled with `expired`, a 13-day one is not, a
  cancelled one is untouched, no objects are deleted; `ingest.test.ts`: the log spy sees one line per
  delivery with the batch id.

## 4. Data and state changes

No migration. Rows of the parent data table (section 5) implemented here: manifest `attempts` and
`final`; `place-state.json`; `options.expired`; the worker task `/tasks/catalog/ingest-more`; env
`DRAFT_EXPIRY_DAYS` (14, decided 2026-10-27). Builder constants
`LINK_RETRY_ATTEMPTS`, `LINK_MAX_ATTEMPTS`, `INGEST_TIME_BUDGET_MS`, `PLACE_BUDGET_ITEMS` and
`HAND_OFF_PAGE` (parent section 5).

## 5. Copy

Exact sentences are in the fixes above and in the parent copy register (section 6), rows marked "D":
Link failures card ("Transient problems were tried <attempts> times."); State words ("Expired after <N>
days with no activity"); Same photos pair; Duplicate photo pair. No sentence is removed by this release.

## 6. Acceptance tests

- Tiers 1 and 2 (`pnpm test`, CI): every "Acceptance" item in section 3, in the test files named there,
  and the general rules of parent 8.2. The `groupBatch` timing at about 2,000 fake products (section
  3.1) is measured and reported.
- Browser test (parent 8.3 harness): no new scenario; scenarios 1 to 7 still pass.
- Tier 3 and tier 4: not required. Tier 5: runs inside `infra/deploy.sh` as always.

## 7. Fixtures

No new fixture file. Uses `intake-large-sheet.csv` (its `_OD` identifiers for F10) and the tier 2
fakes named in section 3 (1,000 and 1,200 fake items, about 2,000 fake products for the `groupBatch`
timing).

## 8. Local verification

From the feature worktree:
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`, then
`pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts` (scenarios 1
to 7 green), then `pnpm --filter @catalog/web build`.

## 9. Live verification (after deploy, Test Brand only)

Step 0: the quiet check and the rules of parent 8.4. Every batch a step makes is cancelled through the
UI at the end.

1. An options-only change on step 2 of a ready batch regroups with zero copies (the INFO line per
   delivery shows it); two Test Brand drafts with the same photos show the same-photos warning on step
   4 with a working link to the other batch; one sweep run cancels no draft younger than
   `DRAFT_EXPIRY_DAYS`.
2. Clean the run's batch objects with `deleteTestObjects` and confirm an empty listing of the run's
   prefixes.

## 10. Rollout and rollback

Merge. From the main checkout on `main`: `infra/deploy.sh` deploys worker and web (the worker now
registers `/tasks/catalog/ingest-more` and reads `DRAFT_EXPIRY_DAYS`, default 14); the tier 5 smoke
runs inside deploy.sh as always. Deploy the worker before or with the web, since the web enqueues
`ingest-more` tasks. Rollback per 00 section 6 (`SKIP_BUILD=1` from the previous commit).

## 11. Report

The 00 section 10 report, plus: the per-fix acceptance results; the live verification log of section 9
with the quiet-check timestamps and the cleanup listing; the measured `groupBatch` time at about 2,000
fake products (section 3.1); the contract change proposed to 02 (the `ingest-more` task). The last
line is "Spec 14 complete; no next release."

## 12. Done when

- [ ] F7 part 2, F5 part 2, F10, F11 part 2 and F12 are built and every acceptance item in section
      3 passes in CI.
- [ ] The `groupBatch` timing is measured and reported (an open issue if it does not fit with a wide
      margin).
- [ ] PR D merged; `catalog-worker` and `catalog-web` deployed; tier 5 smoke green.
- [ ] Live verification steps 1 and 2 of section 9 done with the quiet check logged and
      `catalog-test/` cleanup confirmed.
- [ ] Report written.
