# 14a Intake release A: truth and way back

Catalog module, spec 14, release A of four. Execute with `docs/specs/00-execution-protocol.md`. Parent:
`docs/specs/14-intake-resilience.md`; read its terms, sections 1 to 6 (purpose, principles,
conventions, shared data model, copy register) and section 8 (shared fixtures, harness and live rules)
before this file. Source of truth: `docs/SPEC.md`. Depends on 02, 04 and 06 (merged) and on no other
release of spec 14; this is the first. Branch `feat/catalog-14a-intake-truth`, worktree
`C:\Users\Sujan Ajay\Desktop\catalog-module-wt\14a-intake-truth`. Deploys `catalog-web` only (no worker
change, no migration). Approval: approved by the owner on 2026-10-27 (parent section 11, decision 4).
This release ships as one PR, called PR A in the text below.

## 1. What changes for the operator

- Uploading an xlsx, xlsm or csv no longer crashes step 2: step 2 renders at once with "Reading your
  sheet" and then the columns. Any crash under `/catalog` shows a plain error page with a way back.
- The batch id is in the address bar as soon as the batch exists, so reload, Back or a closed tab lose
  nothing: `/catalog/new?batch=<id>` reopens the wizard at the right step, and the batch page of a
  draft carries "Continue setting up".
- Steps 2 and 3 show the live count the wizard already polls instead of a fixed sentence, and never
  show zeros as results. The false "Processing starts by itself. You can close this page." is replaced
  by a leaving line that is true in this release.
- Draft and failed screens tell the truth: "created" instead of "started", a draft banner with a
  button, not-started Compare and Links sheet tabs, the failure reason in the list, and a correct
  brand page sentence.

## 2. Scope

In scope: `web/components/catalog/{CatalogWizard,WizardStep2,WizardStep3,WizardStep4,BatchBanner}.tsx`,
`web/app/catalog/{page,new/page,[id]/page,brands/[slug]/page}.tsx` and the batch page's Compare and
Links sheet tabs, `web/lib/catalog/exports.ts`, new `web/app/catalog/error.tsx`,
`web/lib/catalog/copy.ts`, `ingest/detect-step.ts` (`buildDetectedStep2`, the `reading` field),
`packages/core/src/catalog/pipeline/status.ts` (`wizardStepFor`), the fixtures `intake-xlsx-grid.xlsx`,
`intake-large-sheet.csv` and `build.ts` (parent 8.1), the browser harness
`apps/web/test/catalog-intake.browser.spec.ts` with `apps/web/test/catalog-intake.config.ts` and its CI
step (parent 8.3), and tests.

Out of scope here: everything the parent lists as out of scope, and every fix or part assigned to
releases B, C and D (parent section 7). Builders fetch current docs through Context7 before using
ExcelJS (the fixture builder), Next.js error boundaries or `router.replace`.

## 3. Fixes

Sentences in quotes are exact (parent section 4).

### 3.1 F1: a sheet upload never crashes step 2

- `CatalogWizard.loadDetected` sets `sheets` from `value.sheets` on every call, not only when
  `previewReady` is true (today `CatalogWizard.tsx:65-70`). A sheet already chosen by the operator keeps
  its choice (merge by `uploadId`).
- `WizardStep2` renders a sheet whose choice is missing as read-only text; it never dereferences a
  missing choice.
- `buildDetectedStep2` reports a sheet upload whose `detected` has no `columns` (not read yet) with a
  new field `reading: true` and `cannotRead: null`; `cannotRead` is reserved for a sheet that was read
  and has no detectable identifier column. Type change in `DetectedStep2.sheets[]`: add `reading:
  boolean`.
- New `web/app/catalog/error.tsx` (client error boundary for every page under `/catalog`). A batch id is
  known when the URL carries `?batch=` or the page is `/catalog/<id>`.
- Copy:
  - Sheet card while reading: "Reading your sheet. The columns will appear here when it has been read."
  - Error page heading: "Something went wrong on our side." With a known batch id, the body "Your batch
    is safe; nothing was lost." and the link "Open this batch"; without one, no body sentence and no
    batch link. Always: the link "All batches" and the button "Try this page again" (calls `reset`).
- Acceptance: unit test renders `WizardStep2` with a sheet entry and `sheets: []` and asserts no throw
  and the reading sentence; browser test (scenario 1, section 6) uploads `intake-xlsx-grid.xlsx`, presses
  Continue and asserts step 2 is visible within 2 s with the reading sentence, then the column sentence
  once collected; a test renders `error.tsx` with a batch id (heading, safe sentence, both links, button)
  and without one (heading, "All batches", button; no safe sentence, no "Open this batch").

### 3.2 F9: draft and failed screens tell the truth

- Batch header: "created <time> by <email>" when `startedAt` is null; the channel list is omitted when
  empty (no "· ·").
- Draft banner: text "Ready to check. Press Continue setting up to see the grouping and choose
  marketplaces." (ready), the state words of F4 part 2 (14c section 3.1; until release C
  ships, the existing state text) otherwise; the "Continue setting up" button of F4 part 1 (section 3.4)
  inside the banner.
- "How this works" gets a draft paragraph: "This batch has not started. Continue setting it up to
  check the grouping, choose marketplaces and start. Nothing is processed and nothing is charged until
  you press Start."
- Compare tab and Links sheet tab for batches that have not started: one line, "This batch has not
  started. <photos> photos found for <products> products; nothing has been made yet." and no table.
  The "Add SKU ids" button is hidden on a batch with 0 products.
- List: failed rows show the reason under the name (first 120 characters, full on hover/title); the
  phone layout keeps State visible (as in F4 part 2, 14c section 3.1).
- Brand page: "No products of <brand> match <query>." only when a query exists; otherwise "No products
  of <brand> yet."
- Acceptance: page tests assert each sentence in each state; `catalog-compare-ui.test.ts` asserts the
  not-started line for a draft with photos; the no-model-names test still passes.

### 3.3 F6, release A part: the polled count and true leaving copy (no worker change)

The worker side of F6 is in 14c section 3.2.

PR A (no worker change): wizard steps 2 and 3 show `state.text` from the batch response they already
poll (replacing the fixed sentences at `CatalogWizard.tsx:146,148`), using today's `collectingText`
and counts; step 2 hides the grouping cards (identifier mode, formats, sheet columns, Google access)
while the batch is collecting and shows the sheet reading card of F1 (section 3.1) when a sheet is being
read; the leaving line of F4 part 1 (section 3.4) replaces "Processing starts by itself. You can close
this page." (`copy.ts:65-67`).

- Acceptance (release A): wizard UI test: steps 2 and 3 render the polled text and never the string "0
  of 0 products"; the banned string "Processing starts by itself" is absent from the source tree (test
  in `catalog-pages.test.ts`).

### 3.4 F4 part 1: the way back

Part 2 of F4 (the unfinished list and Cancel) is in 14c section 3.1.

- `web/app/catalog/new/page.tsx` accepts `?batch=<id>`: loads the batch (404 sentence of `queryBatch`
  when missing; viewer refused as today). Only a `draft` or `ingesting` batch that has not started opens
  the wizard; anything else (failed, cancelled, started) redirects to `/catalog/<id>`. The wizard never
  renders on a failed batch. Renders `CatalogWizard` with `initialBatch` (id, brand, name, product
  type, channels, options, uploads, counts, status).
- `CatalogWizard`: as soon as `ensureBatch` returns (the first file or paste), `router.replace` adds
  `?batch=<id>` to the URL. On mount with `initialBatch`, the step is derived by
  `wizardStepFor(batch, uploads)` in `packages/core/src/catalog/pipeline/status.ts`:

```ts
export type WizardStep = 1 | 2 | 3 | 4;
/** The step an existing batch opens at: 1 while inputs are pending or missing; 2 while collecting, placing, waiting for a column, or ready without channels; 3 never (it is reached from 2 by Continue); 4 when ready with channels. */
export function wizardStepFor(batch: { status: BatchStatus; channels: ChannelId[]; counts: BatchCounts }, uploads: { status: string }[]): WizardStep;
```

- The batch page (`[id]/page.tsx`) shows, for `draft` and `ingesting` batches that have not started,
  the primary action "Continue setting up" linking to `/catalog/new?batch=<id>`, placed in the banner
  (`BatchBanner`) where "Start again" sits for failed batches today.
- The batch list rows already link the batch name to `/catalog/<id>` (`web/app/catalog/page.tsx:17`), so
  every batch is reachable from the list; no list change is needed for part 1.
- In PR A the resumed step 1 shows the uploader and paste box as today; the server-side input list
  arrives with F3 (PR B).
- Leaving line in PR A (steps 2 to 4 while collecting, and the batch page overview): "You can close this
  page. Open this batch again from the batch list and press Continue setting up when it is ready."
- Acceptance, part 1 (PR A): tier 1 `wizardStepFor` table test over every state in the doc comment
  (no input, pending upload, collecting, placing, waiting for a column, ready without channels, ready
  with channels); tier 2 page tests (`catalog-pages.test.ts` harness): `GET /catalog/new?batch=` of a
  draft renders the wizard at its step; of a failed and of a started batch redirects to
  `/catalog/<id>` (a cancelled batch is added to this test in PR C); the draft batch page carries
  "Continue setting up" with the link;
  browser test (scenario 5, PR A form, section 6): paste the grid, the URL carries `?batch=`, reload:
  same step; open the batch from the list, press Continue setting up: the wizard at the step.

## 4. Data and state changes

No migration and no worker change. Rows of the parent data table (section 5) implemented here:
`detected.reading` (via `DetectedStep2.sheets[].reading`, F1). No new route; `/catalog/new` gains the
`?batch=` parameter. No new env var.

## 5. Copy

Exact sentences are in the fixes above and in the parent copy register (section 6), rows marked "A":
Step 2 sheet reading; Error page, batch known; Error page, no batch known; Leaving line, PR A; Draft
banner; How this works, draft; Not-started tabs; Header; Brand page empty; and from the Batch page row
"Continue setting up". Sentences removed by this release: "Processing starts by itself. You can close
this page." and "started <time>" on unstarted batches.

## 6. Acceptance tests

- Tiers 1 and 2 (`pnpm test`, CI): every "Acceptance" item in section 3, in the test files named
  there, plus the general rules of parent 8.2 (spec 04 and 06 suites green, the no-model-names test
  over the new sentences, the removed-sentences test for the two sentences of section 5).
- Browser test (parent 8.3 harness, created by this release), scenarios landing with this release:
  1. xlsx: upload the xlsx fixture, Continue; step 2 within 2 s with the reading sentence; column
     sentence and 6 products once collected (F1).
  5. leave and return, release A form: paste the large sheet stand-in, Continue; the URL carries
     `?batch=`; the count moves on step 2 within 10 s ("Downloading photos 40 of 287"); reload: same
     step, same count; open the batch from the list and press Continue setting up: the wizard at the
     step (F4, F6). The release C extension is in 14c.
  6. crash boundary: a forced render error on step 2 shows the error page with "Open this batch" that
     returns to the wizard (F1).
- Tier 3: not required. Tier 4: not required (the browser test above is the local tier 4-style run).
  Tier 5: runs inside `infra/deploy.sh` as always.

## 7. Fixtures

From parent 8.1, created by this release: `intake-xlsx-grid.xlsx`, `intake-large-sheet.csv` and the
builder script `build.ts` that regenerates the xlsx from the csv (both generated files committed).

## 8. Local verification

From the feature worktree:
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`, then
`pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts` (scenarios 1, 5
and 6 green).

## 9. Live verification (after deploy, Test Brand only)

Step 0: the quiet check and the rules of parent 8.4 (no operator POST in the last 60 minutes, no batch
collecting or processing, no load or eval while an operator is active, every object under
`catalog-test/test_brand/<batchId>/`, at most 30 photos).

1. Upload `intake-xlsx-grid.xlsx` on the deployed wizard; step 2 renders with the reading sentence,
   then the columns; the address bar carries `?batch=`; reload: same step; the leaving line is the PR A
   line; open the batch from the batch list: the page says "created" and carries "Continue setting up",
   which opens the wizard at its step.
2. Clean the run's batch objects with `deleteTestObjects` (allowed under `catalog-test/` only) and
   confirm an empty listing of the run's prefixes. (Cancel through the UI arrives in release C; until
   then the test draft stays as a draft.)

## 10. Rollout and rollback

Merge, then deploy web with `infra/deploy.sh` (no worker change, no migration; the tier 5 smoke runs
inside deploy.sh as always). Rollback per 00 section 6: `SKIP_BUILD=1 bash infra/deploy.sh` from a
checkout of the previous commit. Until this release is live, the interim advice of parent section 11
applies.

## 11. Report

The 00 section 10 report, plus: the per-fix acceptance results; the browser test video or GIF of
scenario 5 (release A form); the live verification log of section 9 with the quiet-check timestamp and
the cleanup listing. Last line: "Ready for the next spec: 14b Intake release B".

## 12. Done when

- [ ] F1, F9, the release A part of F6 and F4 part 1 are built and every acceptance item in section 3
      passes in CI.
- [ ] Browser scenarios 1, 5 (release A form) and 6 pass locally and in CI.
- [ ] The removed sentences of section 5 are absent from `apps/web` and `packages/core` sources.
- [ ] PR A merged; `catalog-web` deployed; tier 5 smoke green.
- [ ] Live verification of section 9 done with the quiet check logged and `catalog-test/` cleanup
      confirmed.
- [ ] Report written.
