# 14 Intake resilience

Catalog module, spec 14. Execute with `docs/specs/00-execution-protocol.md`. Source of truth:
`docs/SPEC.md` (ingestion sources, UI, non-goals). Depends on 02 (schema, storage, tasks), 04 (the
adapters, `Detected`, `groupItems`, `runIngest`, `buildDetectedStep2`, `buildPreview`), 06 (the wizard,
the batch page, the list, `deriveBatchState`, `ingestBatch`, `regroupBatch`). Branch
`feat/catalog-14-intake-resilience`. Deploys `catalog-web` and `catalog-worker` (and the migrate job if
decision 1 is yes). Proposal and evidence: `docs/plans/proposals/2026-10-27-intake-resilience/00-proposal.md`
and the `.runs/2026-10-27-*` reports it cites. Approval: OPEN (section 12); nothing in this spec is
built until the owner says so.

Plain-language terms. Draft: a batch that exists but has not been started. Collection: the system
downloading or reading the photos. Placing: copying each photo to its product's `raw/` object (the
first half of what the code calls `finishBatch`). Grouping: sorting photos into products. Readback:
the sentence the system says back about what it understood from an input, before anything runs.
Transient failure: one that may succeed on a second try (a timeout, a 429 or a 5xx); permanent: one
that will not (404, 403, not an image).

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

The same four steps. Differences, in the order an operator meets them:

1. Step 1 lists everything the batch holds (files, pastes, Google links), each with Remove. Editing the
   paste box changes the paste in place. A paste gets a readback: rows, links, links per row, how
   products will be named, and whether the first three links open. Unsupported share links are refused
   with the alternative.
2. Pressing Continue puts the batch id in the address bar. From then on reload, Back, a crash, a closed
   tab or a day away lose nothing: the batch list opens with "Your unfinished batches" at the top, each
   with its state in words, its age, Continue and Cancel.
3. Step 2 renders at once. While the system works it shows the phase, a count and a time: "Downloading
   photos 612 of 1,400, about 7 minutes left", then "Placing photos 300 of 1,400". A sheet that is
   still being read says so. Nothing shows zeros as results.
4. Failures are listed by row and link with the reason and the next step, separately from unreadable
   files. Transient failures were already retried. "Try the failed links again" re-fetches only those.
5. The batch page of a draft says "created", carries Continue, and its Compare and Links sheet tabs say
   the batch has not started. A failed batch offers "Fix and continue" with the inputs kept.

No new setting, no model name, no technical word in any sentence. The spec 07 banned-names test keeps
passing.

## 3. Scope

In scope: `web/components/catalog/{CatalogWizard,WizardStep1,WizardStep2,WizardStep3,WizardStep4,
PasteBox,Uploader,BatchBanner,RetryCollectButton}.tsx`, `web/components/catalog/wizard-client.ts`,
new `web/components/catalog/{InputList,UnfinishedBatches,LinkFailures}.tsx`, `web/app/catalog/{page,
new/page,[id]/page,brands/[slug]/page}.tsx`, new `web/app/catalog/error.tsx`, `web/lib/catalog/{batches,
uploads,links,preview,copy,exports}.ts`, the routes under `web/app/api/catalog/batches/[id]/` (new:
`uploads/[uploadId]` DELETE, `links/[uploadId]` PATCH and DELETE, `cancel` POST, `reopen` POST,
`retry-links` POST), `ingest/{url-list,links-sheet,detect,detect-step,group,image-check,index}.ts`,
`packages/core/src/catalog/pipeline/status.ts`, `packages/core/src/catalog/types.ts` (`BatchCounts`,
statuses), `apps/worker/src/catalog/{ingest,sweep}.ts`, `packages/core/src/db/schema.ts` and
`packages/core/drizzle/0003_intake_states.sql` (decision 1), tests and fixtures.

Out of scope: everything after `POST /start`; the identifier, precedence and column detection rules
of 04 (only the cell split and the readback change); new input routes; resumable browser uploads;
Drive folder collection beyond 4.13; the list's search or paging beyond the unfinished section.

## 4. Contracts

Each subsection is one fix of the proposal (F1 to F13), with behaviour, contracts, copy and acceptance
tests. Sentences in quotes are exact. `<n>` placeholders are numbers with thousands separators and
singular/plural handled by the existing `plural` helper.

### 4.1 F1: a sheet upload never crashes step 2

- `CatalogWizard.loadDetected` sets `sheets` from `value.sheets` on every call, not only when
  `previewReady` is true (today `CatalogWizard.tsx:65-70`). A sheet already chosen by the operator keeps
  its choice (merge by `uploadId`).
- `WizardStep2` renders a sheet whose choice is missing as read-only text; it never dereferences a
  missing choice.
- `buildDetectedStep2` reports a sheet upload whose `detected` has no `columns` (not read yet) with a
  new field `reading: true` and `cannotRead: null`; `cannotRead` is reserved for a sheet that was read
  and has no detectable identifier column. Type change in `DetectedStep2.sheets[]`: add `reading:
  boolean`.
- New `web/app/catalog/error.tsx` (client error boundary for every page under `/catalog`).
- Copy:
  - Sheet card while reading: "Reading your sheet. The columns will appear here when it has been read."
  - Error page heading: "Something went wrong on our side." Body: "Your batch is safe; nothing was lost.
    Open it again from the batch list." Links: "Open this batch" (when the URL carries `?batch=` or the
    page is `/catalog/<id>`) and "All batches". Button: "Try this page again" (calls `reset`).
- Acceptance: unit test renders `WizardStep2` with a sheet entry and `sheets: []` and asserts no throw
  and the reading sentence; browser test (8.3) uploads `intake-xlsx-grid.xlsx`, presses Continue and
  asserts step 2 is visible within 2 s with the reading sentence, then the column sentence once
  collected; a test renders `error.tsx` and asserts both links.

### 4.2 F2: a pasted grid is understood, with a readback

Parser (`ingest/url-list.ts`), replacing `parseUrlList`:

```ts
export interface PastedRow { row: number; identifier: string | null; urls: string[] }
export interface PastedTable { rows: PastedRow[]; links: number; linksPerRow: { min: number; max: number }; shape: "one_per_line" | "id_and_links" | "links_grid"; ignoredCells: number }
export function parsePastedLinks(text: string): PastedTable;
```

Rules:
- Split into lines; split each line into cells on tabs; when a line has no tab, also split on
  commas, semicolons and runs of whitespace, but only between tokens that are http(s) links (a cell
  such as `BH-4610-NE Black` is not split).
- A cell is a link when it matches `^https?://\S+$` after trimming. Every link cell of a row is a URL
  of that row, in column order. The first non-link cell of a row is its identifier; later non-link
  cells, `0`, `-`, `n/a` and blank cells are ignored and counted in `ignoredCells`. A link is never an
  identifier.
- `shape`: `one_per_line` when every row has exactly one link and no identifier (grouping stays by file
  name as today); `id_and_links` when rows have an identifier; `links_grid` when rows have more than
  one link and no identifier (one product per row, named from the file name of the first link by
  `parseShotName`, shots in column order).
- Rows without any link are skipped. A row with several links produces items `n = 1..k` in column
  order; a single-link row keeps `parseShotName(fileName)`.
- `urlListItems` consumes `PastedTable`; `originalName` is the file name of each link, never of the
  row.

Sheet cells (`ingest/links-sheet.ts` `cellUrls`): split on `,`, `;`, newlines and runs of whitespace
between links; identical rule to the paste cell split.

Readback (`ingest/detect.ts` `checkLinkAccess` for `url_list`, run by `POST /links`): returns
`Detected` with `rows`, `fileCount` (= links), new fields `linksPerRow: {min, max}`, `shape`,
`sample: { tried: number; ok: number; failures: { url: string; reason: string }[] }` from a range GET
(bytes 0 to 1023) of the first three links through `safeFetch` with a 5 s timeout each, and `message`
built as below. The sample never blocks the paste; its failures are information. A list whose every
sampled link fails still gets status `uploaded` (the worker's retry and reporting of 4.5 take over).

Refusals at paste (`detectPastedText`): a line whose host is `dropbox.com`, `www.dropbox.com`,
`onedrive.live.com`, `1drv.ms`, `wetransfer.com`, `we.tl`, or a `drive.google.com/file/d/` link is a
share page. When every link of the paste is a share page the paste is refused (400, batch unchanged).
When some are, they are listed in `detected.rejected` with the reason and the rest proceed.

Copy:
- Readback pill: "<rows> rows, <links> links" (or "<links> image links" when `one_per_line`). Line:
  "<min> to <max> links per row. Products will be named <from the file names, for example <id>> | <by
  the first column, for example <id>>. We opened the first <tried> links: <all fine | <ok> of <tried>
  opened; <reason of the first failure>>." The `<min> to <max>` part reads "<k> links per row" when
  equal, and is omitted for `one_per_line`.
- Refused share links: "These are <Dropbox | OneDrive | WeTransfer | Google Drive file> share pages,
  not image links. Download the photos and drop them here, or paste direct image links (they end in
  .jpg or .png)."
- Ignored cells, when `ignoredCells > 0`: "<n> empty or non-link cells were ignored."

Acceptance (tier 1, `url-list.test.ts`): the fixture `intake-pasted-grid.txt` (8.1) gives 6 rows, 27
links, 4 to 5 per row, shape `links_grid`, 3 ignored cells, every identifier null, items named
`BH-4610-NE` etc. with `n` 1..5; the 2-column row gives one product with 2 shots and no URL
identifier; `id<TAB>url<TAB>url` gives `id_and_links`; one link per line is unchanged against the
existing tests; a line `https://h/a_1.jpg https://h/a_2.jpg` gives 2 links; `cellUrls` on
`"a.jpg\nb.jpg"` and `"a.jpg b.jpg"` gives 2. `detect.test.ts`: the readback message for the grid
fixture equals "6 rows, 27 links" + "4 to 5 links per row. Products will be named from the file
names, for example BH-4610-NE. We opened the first 3 links: all fine."; a Dropbox-only paste is refused
with the sentence; a fake fetch records 3 range GETs and nothing else. Tier 2 (`ingest.test.ts`): the
grid fixture collected end to end gives 6 products, 27 photos, 0 rejects, `unsupportedFiles` 0.

### 4.3 F3: inputs can be corrected without duplicates

- The paste box binds to one `url_list` upload row per batch. `POST /links` with `url_list` text
  updates the batch's existing `url_list` row (if any) instead of inserting by `sourceUrl`; Google
  lines keep one row per link as today. `PATCH /links/[uploadId]` `{text}` replaces; `DELETE
  /links/[uploadId]` and `DELETE /uploads/[uploadId]` remove (draft only; `assertDraft`).
- "Remove" semantics (decision 1): with the migration, the row gets status `removed` and is ignored
  by `ingestBatch`, `finishIfLast`, `buildDetectedStep2`, `buildPreview` and the counts; its object
  under `uploads/` is left for the lifecycle. Without the migration, the row is deleted and its object
  under `uploads/<uploadId>/` is deleted (private, batch-owned, never public; the `assertWithinProduct`
  rule concerns public objects and is not involved).
- Removing or changing an input sets `counts.previewReady = false` and, when the batch is
  `ingesting`, is refused with the collecting sentence of 4.8.
- `Uploader` Retry: when `row.plan` is older than `SIGNED_PUT_TTL_SEC` (900 s, 02) it plans again
  before the PUT. A failed row has Remove. Continue is disabled only by rows the operator can act on.
- New `InputList.tsx` under step 1 lists every upload of the batch from the server (`GET batch`
  already returns uploads) with kind word, name, size, state word and Remove; it is the same list the
  resumed wizard shows (4.4).
- Copy: Remove button "Remove"; confirmation none (a removed input can be added again). State words:
  "Uploading <p>%", "Uploaded", "Checked", "Upload failed. Try again or remove it.", "Removed".
- Acceptance (tier 2, `catalog-wizard-routes.test.ts`): paste A (3 links), then PATCH with text B (2
  links): one `url_list` row, 2 links, preview invalidated; DELETE an upload: the row is `removed` (or
  gone) and `ingestBatch` ignores it; a batch with one removed and one uploaded row collects the
  uploaded one only; `catalog-uploader-ui.test.ts`: a failed row older than the TTL re-plans on Retry
  (the fake records a second `/uploads` POST); browser test (8.3): paste the grid, clear the box, paste
  one link per line, Continue; step 2 shows the second paste's products only.

### 4.4 F4: every unfinished batch can be found and resumed

- `web/app/catalog/new/page.tsx` accepts `?batch=<id>`: loads the batch (404 sentence of `queryBatch`
  when missing; viewer refused as today), refuses a batch that is not `draft`, `ingesting` or
  failed-before-start with a redirect to `/catalog/<id>`, and renders `CatalogWizard` with
  `initialBatch` (id, brand, name, product type, channels, options, uploads, counts, status).
- `CatalogWizard`: as soon as `ensureBatch` returns, `router.replace` adds `?batch=<id>` to the URL.
  On mount with `initialBatch`, the step is derived by `wizardStepFor(batch, uploads)` in
  `packages/core/src/catalog/pipeline/status.ts`:

```ts
export type WizardStep = 1 | 2 | 3 | 4;
/** The step an existing batch opens at: 1 with no usable input or a pending upload; 2 while collecting, placing, ready without channels, or waiting for a column; 3 never (it is reached from 2 by Continue); 4 when ready with channels. */
export function wizardStepFor(batch: { status: BatchStatus; channels: ChannelId[]; counts: BatchCounts }, uploads: { status: string }[]): WizardStep;
```

- The batch page (`[id]/page.tsx`) shows, for `draft` and `ingesting` batches that have not started,
  the primary action "Continue setting up" linking to `/catalog/new?batch=<id>`, placed in the banner
  (`BatchBanner`) where "Start again" sits for failed batches today; and "Cancel this batch" as a
  secondary action.
- The list (`web/app/catalog/page.tsx`): a section "Your unfinished batches" above the table, listing
  the signed-in user's `draft`, `ingesting` and failed-before-start batches (admins see everyone's,
  with the creator), newest first, each row: name, brand, state words, age ("created 5 minutes ago",
  "2 days ago"), "Continue", "Cancel". The section is absent when empty. The main table excludes
  `cancelled` batches by default and gets a "Show cancelled" link. On phones the section is a card
  list, and the main table keeps its State column on screen (the Channels column collapses first).
- The brand page lists the brand's unfinished batches above the product search with the same rows.
- `POST /cancel` (draft, ingesting, or failed-before-start; operator): sets status `cancelled`
  (decision 1 yes) or `options.cancelled = { at, by }` with status unchanged (decision 1 no); releases
  nothing (drafts hold no locks: db section 2); refuses a batch that has started. `deriveBatchState`
  gets state `cancelled`, pill "Cancelled", list pill "Cancelled". The sweep ignores cancelled batches.
- `UPLOAD_STATUSES` gains `removed` and `BATCH_STATUSES` gains `cancelled` with decision 1 (section 5).
- State words for unfinished rows (from `deriveBatchState`, new field `intake: string`):
  - uploading (a pending upload): "Waiting for <n> files to finish uploading"
  - no input: "Nothing added yet"
  - collecting: "Downloading photos <done> of <total>" or "Reading your sheet" or "Unpacking your
    zip" or "Checking your uploaded files" (by source, as `collectingText` picks today) + the time
    of 4.6
  - placing: "Placing photos <placed> of <total>" + time
  - ready, no channels: "Ready to check"
  - waiting for a column: "Needs your input: which column holds the identifier?"
  - ready with channels: "Ready to start"
  - stalled: the existing `COLLECT_STALLED_TEXT`
  - failed before start: "Could not start: <failReason>"
  - cancelled: "Cancelled <age>"; expired by the sweep: "Expired after <N> days with no activity"
- Copy: section heading "Your unfinished batches"; buttons "Continue", "Cancel", "Continue setting
  up", "Cancel this batch"; cancel confirmation (inline, not a modal): "Cancel <name>? Nothing was
  processed and nothing was charged. The photos it collected stay for <N> days." with "Yes, cancel"
  and "Keep it"; the wizard's leaving line (4.6).
- Acceptance: tier 1 `wizardStepFor` table test over every state in the table above; tier 2 routes:
  `GET /catalog/new?batch=` of a draft renders the wizard with the batch's inputs (page test with the
  `catalog-pages.test.ts` harness); cancel of a draft, of an ingesting batch, of a failed-before-start
  batch succeeds and of a `matting` batch is 409; the list page shows the section for the creator and
  not for another operator (admin sees both); browser test (8.3): paste the large-sheet stand-in,
  Continue, reload the page: step 2 with the count; close and reopen `/catalog`: the section shows the
  batch "Ready to check" with Continue, which opens step 2 with the grouping; Continue to step 4 and
  reload: step 4.

### 4.5 F5: link failures are named, classified and retried

- `image-check.ts` `classifyImageReject` gains kind `link` for reasons produced by `fetchSourceUrl`
  (any reason ending in "did not return an image (got <x>)." or starting with "Only https links").
  `whatWasFound` and `noPhotosReason` use it. `readPhrase` (`group.ts`) gets a link case.
- Item results in the manifest gain `attempts: number` and `final: boolean`. A transient failure
  (network error, timeout, 408, 425, 429, 500, 502, 503, 504) is retried inside the delivery up to
  `LINK_RETRY_ATTEMPTS` (builder constant, 3) with backoff 2 s, 8 s, and stored with `final: false`;
  every later run (continuation, Try again, regroup, 4.5's retry action) re-tries non-final items. A
  permanent failure (404, 403, 410, not an image, http only, SSRF refusal) is stored `final: true`.
  Retries use a 20 s timeout (the first attempt keeps the existing 60 s). The delivery gets a time
  budget next to the item budget: after `INGEST_TIME_BUDGET_MS` (builder constant, 600 s) of work it
  starts no new item, saves the manifest with the results so far and re-enqueues itself with the
  cursor, so a slow or dead host can no longer push a delivery past the 900 s deadline and lose the
  whole chunk (paths #30). The builder proves in tier 2 that a fake host answering after 60 s every
  time still yields a saved manifest and a continuation.
- Reasons carry position: pasted grid "row <r>, column <c>"; sheet "row <r>, column <header>" (04
  already specifies this for sheets; the worker now stores it).
- `BatchCounts` gains `linkFailures: number` (final link rejects); `unsupportedFiles` no longer
  counts links.
- `buildDetectedStep2` returns `linkFailures: { total: number; byReason: { reason: string; count: number;
  first: { url: string; where: string } }[]; products: number }` next to `unreadable` (which keeps
  files only). `buildPreview.warnings` gains the link pair below. `GET /preview` returns the full
  failure list under `linkFailureRows` (url, where, reason, attempts) for the "Show all" table.
- `POST /retry-links` (draft, operator): marks the batch's non-final and final link rejects for a
  re-fetch (sets `final: false` on all link rejects of the chosen uploads) and runs `ingestBatch`.
  The step 2 and step 4 cards and the batch page carry the button while `linkFailures > 0`.
- Copy:
  - Step 2 card heading "Links that could not be downloaded" (only when `linkFailures > 0`):
    "<total> of <links> links could not be downloaded (<products> products affected). <count> <reason
    phrase>, for example <url> (<where>)." one line per reason, then "Transient problems were tried
    <attempts> times." when any, then buttons "Try the failed links again" and "Show all <total>".
  - Reason phrases: "answered 'not found' (404)", "were refused (403)", "did not answer in time",
    "returned a web page instead of an image", "use http instead of https", "could not be reached".
  - Step 4 warning pair: "<k> links could not be downloaded." + "<products> products are missing
    shots: <ids, first 10>. Try the failed links again, fix the sheet, or continue without them."
  - No-photos sentence for links: "No photos could be downloaded from the <n> links you <pasted |
    listed in <sheet>>. <count> <reason phrase>, for example <url> (<where>). Check that the links
    open in a browser, fix them, then press Try the failed links again." (The file version of the
    sentence is unchanged.)
  - Batch page banner for a failed links batch: the sentence above with the two buttons "Try the
    failed links again" and "Fix and continue" (4.8).
- Acceptance (tier 2 `ingest.test.ts`): a fake fetch that answers 503 twice then 200 for one item
  gives 1 photo with `attempts: 3`; a 404 item is `final: true` and not re-fetched on a second run
  (fetch count unchanged); a 429 item left non-final is re-fetched on the second run; the grid fixture
  with every link 404 fails with the exact no-photos sentence, `linkFailures` 27, `unsupportedFiles`
  0; `detect-step.test.ts`: the `linkFailures` block from the manifest; `group.test.ts`: the step 4
  pair; routes: `POST /retry-links` re-fetches only rejects (fake fetch count equals the reject count).

### 4.6 F6: a count, a phase and an honest time on every intake wait

- `BatchCounts` gains `phase: "uploading" | "downloading" | "reading" | "unpacking" | "checking" |
  "placing" | "ready" | "needs_input" | null`, `placed: number`, `placeTotal: number | null`, and
  `rate: { at: string; done: number }[]` (the last 5 samples, written by the worker with each counts
  update; the same shape as the processing `samples`). All live in the existing `counts` jsonb; no
  migration.
- `runIngest` writes `phase` with every `bumpCollected`; `finishIfLast` sets `phase: "placing"` and
  `placeTotal`; `finishBatch` writes `placed` after every chunk of 4.7 (until 4.7 ships, once at the
  end) and `phase: "ready"` or `"needs_input"` with `previewReady`.
- The batch stays `ingesting` until `previewReady` or `failed`: the `finishIfLast` claim no longer sets
  `draft`; it claims by an atomic update of `counts.placingClaimedAt` (`WHERE status = 'ingesting' AND
  counts->>'placingClaimedAt' IS NULL AND NOT EXISTS (<uploads not collected or failed or removed>)`);
  on error the marker is cleared. `patchCounts` at the end sets status `draft`. `deriveBatchState`
  therefore shows "collecting" with the placing text through the whole phase, and the stall rule
  (`COLLECT_STALL_MS`) covers it; `regroupBatch` clears the marker.
- `intakeTimeText(counts, now)` in `status.ts`: from the last two samples at least 20 s apart, the
  rate per minute; "about <m> min left" with `ceil((total - done) / rate)`; "a few minutes" when
  under 2 min; omitted when the total is unknown or fewer than two samples exist. Never fitted; the
  text appears only once a rate is measured.
- `deriveBatchState.text` for collecting: "<phase words> <done> of <total><, about <m> min left>",
  phase words from the table in 4.4. List pill: "<phase words> <done> of <total>".
- Wizard steps 2 and 3 show `state.text` from the batch response they already poll (replacing the
  fixed sentences at `CatalogWizard.tsx:146,148`), plus the leaving line; step 2 hides the grouping
  cards (identifier mode, formats, sheet columns, Google access) while `phase` is not `ready` or
  `needs_input` and shows the sheet reading card of 4.1 when a sheet is being read. Step 4's bar uses
  `placed` during placing.
- Copy:
  - Leaving line (steps 2 to 4 while collecting, and the batch page overview): "You can close this
    page. Find this batch under Your unfinished batches and press Continue when it is ready." replaces
    "Processing starts by itself. You can close this page." (`copy.ts:65-67`).
  - Collecting banner text: "<phase words> <done> of <total> from your <source>, about <m> min left".
- Acceptance: tier 1 `status.ts`: `intakeTimeText` with samples 0 at t0 and 200 at t0+100 s over a
  total of 1,400 gives "about 10 min left"; no text with one sample; `deriveBatchState` for
  `ingesting` with `phase: "placing"` gives "Placing photos 300 of 1,400"; tier 2 `ingest.test.ts`:
  during `finishBatch` the batch stays `ingesting` with `phase: "placing"`, then `draft` with
  `phase: "ready"`; a thrown `finishBatch` clears the marker and a retry runs it; wizard UI test:
  steps 2 and 3 render the polled text and never the string "0 of 0 products"; the banned string
  "Processing starts by itself" is absent from the source tree (test in `catalog-pages.test.ts`).

### 4.7 F7: placing is resumable and never re-copies

- `placeRaw`: before copying, `headObject` on the target; when it exists and its stored sha256 (object
  metadata `sha256`, set on write) equals the item's sha256, skip the copy (04's promise).
- `finishBatch` is split: `placeBatch` (copies in chunks of `PLACE_BUDGET_ITEMS`, builder constant,
  chosen to stay well inside 900 s at the measured 280 photos/min, start 800; after each chunk writes
  `counts.placed` and re-enqueues itself with a cursor like `runIngest`) and `groupBatch` (the database
  step, run once by the delivery that places the last chunk). The placing cursor lives in
  `preview-state.json`'s sibling `place-state.json` under `derived/_ingest/`.
- `regroupBatch` after a step 2 change whose only effect is options (identifier mode, precedence,
  sheet columns, sheet kind) does not touch upload statuses; it enqueues `placeBatch` with the new
  options, and the sha256 skip makes unchanged photos free. `patchDetected` with no change (same
  options, same sheet choices) returns at once without regrouping.
- Acceptance (tier 2): 1,000 fake items with `PLACE_BUDGET_ITEMS` 300: four deliveries, `placed`
  moves 300, 600, 900, 1,000, the batch is `ingesting` with `phase: "placing"` throughout, then
  `draft` ready; a second `finishBatch` run on the same batch performs zero copies (the fake storage
  counts `copy` calls); a `patchDetected` with unchanged values performs no enqueue; a killed delivery
  (the test throws after chunk 2) leaves the marker and cursor so the retry continues at chunk 3.

### 4.8 F8: a batch that failed before Start can be fixed in place

- `POST /reopen` (operator): a batch with status `failed` and `startedAt` null returns to `draft`,
  `counts.failReason` cleared, `previewReady` false, uploads untouched (manifests and staged bytes are
  reused by the sha256 skip and the manifest results). Refused for started batches.
- `assertDraft` sentences by status: `failed` + never started: "This batch could not start. Press Fix
  and continue to change its photos or links."; `ingesting`: "This batch is still collecting. Wait for
  it to finish, or press Try again if nothing has moved for 10 minutes."; any started status: the
  existing "This batch has already started. Make a new batch to add more photos."; `cancelled`: "This
  batch was cancelled. Make a new batch."
- The failed batch page replaces "Start again" with "Fix and continue" (reopen, then
  `/catalog/new?batch=<id>`); step 1 shows the previous `failReason` above the input list.
- Acceptance (tier 2 routes): reopen a never-started failed batch: draft, reason cleared, inputs kept;
  reopen a started failed batch: 409; the three `assertDraft` sentences; browser test (8.3): the grid
  with every link 404 fails, "Fix and continue" opens step 1 with the reason and the paste, the
  operator pastes one link per line, Continue, step 2 ready.

### 4.9 F9: draft and failed screens tell the truth

- Batch header: "created <time> by <email>" when `startedAt` is null; the channel list is omitted when
  empty (no "· ·").
- Draft banner: text "Ready to check. Press Continue setting up to see the grouping and choose
  marketplaces." (ready), the state words of 4.4 otherwise; the Continue button inside the banner.
- "How this works" gets a draft paragraph: "This batch has not started. Continue setting it up to
  check the grouping, choose marketplaces and start. Nothing is processed and nothing is charged until
  you press Start."
- Compare tab and Links sheet tab for batches that have not started: one line, "This batch has not
  started. <photos> photos found for <products> products; nothing has been made yet." and no table.
  The "Add SKU ids" button is hidden on a batch with 0 products.
- List: failed rows show the reason under the name (first 120 characters, full on hover/title); the
  phone layout keeps State visible (4.4).
- Brand page: "No products of <brand> match <query>." only when a query exists; otherwise "No products
  of <brand> yet."
- Acceptance: page tests assert each sentence in each state; `catalog-compare-ui.test.ts` asserts the
  not-started line for a draft with photos; the no-model-names test still passes.

### 4.10 F10: the same photos in another batch are flagged

- `buildOverwritePreview` gains `sameBatches: { batchId: string; name: string; createdAt: string;
  state: string; sharedPhotos: number; example: { here: string; there: string } | null }[]`: the brand's
  other `draft`, `ingesting` and failed-before-start batches (same `is_test`) whose source rows share at
  least 10 sha256 values or 20% of this batch's, with one example of the two identifier spellings
  when they differ. And `duplicatePhotos: { sha256: string; identifiers: string[]; name: string }[]`
  for photos under two identifiers in this batch (the Tan/Black case).
- Step 4 warning pairs:
  - "These photos are already in <name> (<state>, created <age>)." + "<shared> of <photos> photos are
    the same<, under different identifiers (<there> there, <here> here)>. Continue that batch or cancel
    it before starting this one, so the same product is not made twice."
  - "<k> photos appear under two products." + "<name> is in <id a> and <id b>; <more>. Check the
    sheet before starting."
- Neither blocks Start (the operator may be re-delivering on purpose).
- Acceptance (tier 2 `overwrite-preview.test.ts`): two drafts with the same 12 hashes under `X` and
  `X_OD` give one `sameBatches` entry with the example; a started batch is not listed; one photo under
  two identifiers gives one `duplicatePhotos` entry; `group.test.ts`: both pairs.

### 4.11 F11: platform errors and large hand-offs

- `wizardApi`: when `response.headers.get("content-type")` is not JSON or the body does not parse,
  throw `WizardApiError` with status and the sentence "The server did not answer in time. Your files
  are safe. Reload this page to continue." (502, 503, 504) or "This did not finish. Reload this page
  and try again." (anything else).
- `ingestBatch` enqueues at most `HAND_OFF_PAGE` uploads (builder constant, 500) per request; when
  more remain it returns `{ collecting: true, remaining }` and the worker's last task of the page
  enqueues the next page (new task `/tasks/catalog/ingest-more` `{batchId, run}` that hands over the
  next page of `uploaded` rows), so one Continue is enough for any count.
- Acceptance: `fetch.test.ts`: an HTML 504 gives the sentence; routes: 1,200 fake uploads produce 3
  pages and every upload reaches the queue (fake queue count).

### 4.12 F12: draft housekeeping and a trace per delivery

- Sweep: a `draft` batch (never started, not cancelled) whose `updated_at` is older than
  `DRAFT_EXPIRY_DAYS` (env, default 14; decision 2) is cancelled with `options.expired = { at, days
  }`; the list shows "Expired after <N> days with no activity". Objects are untouched; for `is_test`
  batches a second sweep step deletes the batch prefix under `catalog-test/` after `TEST_DRAFT_CLEANUP_DAYS`
  (decision 2; default off until decided).
- `handleIngestTask` logs one INFO line per delivery: `{ event: "ingest", batchId, uploadId, phase,
  done, total, ms, outcome }`.
- Acceptance: `sweep.test.ts`: a 15-day draft is cancelled with `expired`, a 13-day one is not, a
  cancelled one is untouched, a real-brand draft never has objects deleted; `ingest.test.ts`: the log
  spy sees one line per delivery with the batch id.

### 4.13 F13: Google and Drive edge cases (later)

- `PasteBox`: "Check again" next to a "No access yet" pill re-posts the same text (bypassing the
  `savedText` guard).
- Drive folder: the size check (`DRIVE_FOLDER_MAX_BYTES`) runs at paste time from the full listing
  and the "too large" sentence of 04 is shown at paste; the worker keeps `prior.rejected` when
  rebuilding `detected`.
- Acceptance: routes test with the Google fakes of 04.

## 5. Data and state changes

| Change | Where | Migration? |
|---|---|---|
| `counts.phase`, `placed`, `placeTotal`, `rate`, `linkFailures`, `placingClaimedAt` | `catalog_batches.counts` jsonb (`BatchCounts` type) | No (jsonb; `EMPTY_BATCH_COUNTS` gets defaults; old rows read as null/0) |
| `detected.linksPerRow`, `shape`, `sample`, `reading`; manifest `attempts`, `final`; `place-state.json` | `catalog_uploads.detected` jsonb; bucket objects | No |
| `options.cancelled`, `options.expired` (decision 1 no) | `catalog_batches.options` jsonb | No |
| Upload status `removed` | `catalog_uploads.status` CHECK constraint (`schema.ts:275,283`) | **Yes**: `0003_intake_states.sql` drops and recreates the two CHECK constraints with the new values |
| Batch status `cancelled` | `catalog_batches.status` CHECK constraint (`schema.ts:237,256`) | **Yes** (same migration) |
| New routes `DELETE uploads/[uploadId]`, `PATCH|DELETE links/[uploadId]`, `POST cancel`, `POST reopen`, `POST retry-links`; worker task `/tasks/catalog/ingest-more` | web, worker | No |
| Env `DRAFT_EXPIRY_DAYS` (14), `TEST_DRAFT_CLEANUP_DAYS` (unset = off), `LINK_RETRY_ATTEMPTS` (3) | worker, deploy.sh | No |

Migration flag (00 section 11): only specs 02 and 03 ship migrations, and a contract change to 02 is
proposed in the report, never made silently. This spec proposes the two new status values as a 02
contract change and needs the owner's explicit yes (decision 1) before the migration is written.
Precedent: `0002_cost_events.sql` (PR #90). Without the yes, the no-migration path of 4.3 and 4.4
is built instead (hard delete of removed uploads; `options.cancelled` for cancelled batches, with
`deriveBatchState` reading it before the status).

## 6. Copy register

Every new or changed sentence, for the no-model-names test and for review. Placeholders in angle
brackets. No raw rule ids, no model ids, no technical words.

| Where | Sentence |
|---|---|
| Step 2 sheet reading | Reading your sheet. The columns will appear here when it has been read. |
| Error page | Something went wrong on our side. / Your batch is safe; nothing was lost. Open it again from the batch list. / Open this batch / All batches / Try this page again |
| Paste readback | <rows> rows, <links> links / <min> to <max> links per row. Products will be named from the file names, for example <id>. We opened the first <tried> links: all fine. |
| Paste readback, sample failed | We opened the first <tried> links: <ok> of <tried> opened; <reason phrase of the first failure>. |
| Paste ignored cells | <n> empty or non-link cells were ignored. |
| Paste refused | These are <service> share pages, not image links. Download the photos and drop them here, or paste direct image links (they end in .jpg or .png). |
| Input list | Remove / Uploading <p>% / Uploaded / Checked / Upload failed. Try again or remove it. / Removed |
| List section | Your unfinished batches / Continue / Cancel / Show cancelled |
| Batch page | Continue setting up / Cancel this batch / Fix and continue / Try the failed links again |
| Cancel confirmation | Cancel <name>? Nothing was processed and nothing was charged. The photos it collected stay for <N> days. / Yes, cancel / Keep it |
| State words | Waiting for <n> files to finish uploading / Nothing added yet / Downloading photos <done> of <total> / Reading your sheet / Unpacking your zip / Checking your uploaded files / Placing photos <placed> of <total> / Ready to check / Needs your input: which column holds the identifier? / Ready to start / Could not start: <reason> / Cancelled <age> / Expired after <N> days with no activity |
| Time | about <m> min left / a few minutes left |
| Leaving line | You can close this page. Find this batch under Your unfinished batches and press Continue when it is ready. |
| Link failures card | Links that could not be downloaded / <total> of <links> links could not be downloaded (<products> products affected). / <count> <reason phrase>, for example <url> (<where>). / Transient problems were tried <attempts> times. / Show all <total> |
| Reason phrases | answered 'not found' (404) / were refused (403) / did not answer in time / returned a web page instead of an image / use http instead of https / could not be reached |
| Step 4 link pair | <k> links could not be downloaded. / <products> products are missing shots: <ids>. Try the failed links again, fix the sheet, or continue without them. |
| No photos, links | No photos could be downloaded from the <n> links you <pasted / listed in <sheet>>. <count> <reason phrase>, for example <url> (<where>). Check that the links open in a browser, fix them, then press Try the failed links again. |
| assertDraft | This batch could not start. Press Fix and continue to change its photos or links. / This batch is still collecting. Wait for it to finish, or press Try again if nothing has moved for 10 minutes. / This batch was cancelled. Make a new batch. |
| Platform error | The server did not answer in time. Your files are safe. Reload this page to continue. / This did not finish. Reload this page and try again. |
| Draft banner | Ready to check. Press Continue setting up to see the grouping and choose marketplaces. |
| How this works, draft | This batch has not started. Continue setting it up to check the grouping, choose marketplaces and start. Nothing is processed and nothing is charged until you press Start. |
| Not-started tabs | This batch has not started. <photos> photos found for <products> products; nothing has been made yet. |
| Header | created <time> by <email> |
| Brand page empty | No products of <brand> yet. |
| Same photos pair | These photos are already in <name> (<state>, created <age>). / <shared> of <photos> photos are the same, under different identifiers (<there> there, <here> here). Continue that batch or cancel it before starting this one, so the same product is not made twice. |
| Duplicate photo pair | <k> photos appear under two products. / <name> is in <id a> and <id b>. Check the sheet before starting. |

Removed sentences: "Processing starts by itself. You can close this page."; "N image links" for a grid;
"<n> other files" for links; "started <time>" on unstarted batches.

## 7. Workstreams and build order

| PR | Workstreams | Worktree | Files | Depends on |
|---|---|---|---|---|
| A (small, first) | 4.1 F1, 4.9 F9, the copy and step 2 text of 4.6 (phase word from the existing counts, no worker change) | `catalog-module-wt/14-intake-resilience-a-truth` | wizard step 2, `loadDetected`, `error.tsx`, batch page, list, brand page, `copy.ts`, tests | nothing; deployable alone |
| B | 4.2 F2, 4.3 F3, 4.5 F5 | `catalog-module-wt/14-intake-resilience-b-inputs` | `url-list.ts`, `links-sheet.ts`, `detect.ts`, `detect-step.ts`, `image-check.ts`, `group.ts`, `index.ts` (results, retry), `links.ts`, `uploads.ts`, new routes, `PasteBox`, `Uploader`, `InputList`, `LinkFailures`, tests, fixtures | A merged |
| C | 4.4 F4, 4.6 F6 (worker side), 4.8 F8, 4.11 F11, migration (decision 1) | `catalog-module-wt/14-intake-resilience-c-resume` | `new/page.tsx`, `CatalogWizard`, `status.ts`, `index.ts` (claim, phase), `batches.ts`, `cancel`/`reopen` routes, list and brand page sections, `schema.ts`, `0003_intake_states.sql`, `wizard-client.ts`, tests | A, B merged |
| D | 4.7 F7, 4.10 F10, 4.12 F12 | `catalog-module-wt/14-intake-resilience-d-placing` | `index.ts` (placeBatch), `overwrite-preview.ts`, `group.ts`, `sweep.ts`, worker `ingest.ts`, tests | C merged |
| later | 4.13 F13 | own PR | `PasteBox`, `drive-folder.ts`, `index.ts` | none |

Within a PR, workstreams that touch the same files run one after the other in the PR's worktree (00
section 3). Builders follow the 00 section 4 brief and fetch current docs through Context7 before using
ExcelJS, Next.js error boundaries, `router.replace`, or drizzle constraint changes.

## 8. Tests per tier

### 8.1 Fixtures (the three real inputs, replayed with small Test Brand stand-ins)

Under `packages/core/test-fixtures/catalog/intake/`, all with `test_brand` identifiers and example.com
hosts (served by the tests' fake fetch; never the real `sceimage` host):

- `intake-xlsx-grid.xlsx` (attempt 1 stand-in): one sheet, a title row above the header, header row
  with 12 columns including `Option Id` at column E, `EAN` at column G, `Image Link 1` to `Image Link 5`
  at columns H to L; 8 data rows for 6 products (two identifiers repeated on a second row, as sizes),
  one row with 4 links, blank cells elsewhere. Expected: identifier column E, photo columns H to L, 6
  products, 27 photos, the duplicate-identifier warning with 2.
- `intake-pasted-grid.txt` (attempt 2 stand-in): the same 6 products as tab-separated rows of 4 to 5
  links each, two trailing `0` cells and one blank cell (27 links, 3 ignored cells); a second file
  `intake-pasted-variants.txt` with a 2-column row (URL, URL), an `id<TAB>url<TAB>url` row, a line
  with two links separated by a space, a Dropbox share link, and an http link.
- `intake-large-sheet.csv` (attempt 3 stand-in, the Google Sheet as the csv the web tier writes):
  `Unicommerce Code` + 5 link columns, 60 rows, 287 links (the real link count divided by 5), with
  identifiers that are the xlsx fixture's identifiers plus `_OD` for the first 6 rows (for 4.10). Used
  with a fake fetch that delays 50 ms per link and `INGEST_BUDGET_ITEMS` lowered to 40 so the batch
  takes several deliveries and shows moving counts.
- A builder script `packages/core/test-fixtures/catalog/intake/build.ts` regenerates the xlsx from the
  csv so the two stay in step; the generated files are committed.

### 8.2 Tiers 1 and 2 (`pnpm test`, CI)

Every acceptance item of section 4 is tier 1 or 2 as marked, in the existing test files named there
plus `apps/web/test/catalog-intake-routes.test.ts` (new routes) and `apps/web/test/catalog-intake-ui.test.ts`
(InputList, LinkFailures, UnfinishedBatches). The spec 04 and 06 suites stay green; the no-model-names
test runs over the new sentences; a new test asserts the removed sentences of section 6 are absent
from `apps/web` and `packages/core` sources.

### 8.3 Browser test (tier 4-style, local; `apps/web/test/catalog-intake.browser.spec.ts`)

A committed version of the local harness used for the ux report (`apps/web/.playwright/intake-ux-local.test.ts`,
git-ignored): the real wizard bundle, the real route handlers, PGlite, in-memory storage, a fake queue
that runs `runIngest`, a fake image host, Google disabled. Scenarios, each a replay of a real attempt
or of a principle:

1. xlsx: upload the xlsx fixture, Continue; step 2 within 2 s with the reading sentence; column
   sentence and 6 products once collected (4.1).
2. grid: paste the grid, readback equals the sentence of 4.2, Continue, 6 products and 27 photos (4.2).
3. grid, all 404: the fake host answers 404; the no-photos sentence names links with row and column;
   "Fix and continue" reopens step 1 with the paste; one link per line pasted; step 2 ready (4.5, 4.8).
4. correction: paste the grid, clear, paste the variants file; the input list shows one paste; step 2
   shows only the second paste's products (4.3).
5. leave and return: paste the large sheet stand-in, Continue; the count moves on step 2 within 10 s
   ("Downloading photos 40 of 287"); reload: same step, same count; navigate to `/catalog`: "Your
   unfinished batches" with the state words; Continue opens step 2; once ready, Continue to step 4,
   reload, step 4 (4.4, 4.6).
6. crash boundary: a forced render error on step 2 shows the error page with "Open this batch" that
   returns to the wizard (4.1).
7. phone: scenarios 2 and 5 at 390 x 844 assert the section and the State column are visible without
   horizontal scroll.

Runs locally and in CI the way the ordering spec runs today: `pnpm --filter @catalog/web exec playwright
test --config test/catalog-intake.config.ts` (a copy of `catalog-wizard-ordering.config.ts` with the
new `testMatch`; the builder adds the CI step next to the ordering one).

### 8.4 Live verification (after each deploy, Test Brand only)

Rules: no load or eval runs while an operator is active. Before each step, the quiet check: no operator
POST in the web request log in the last 60 minutes (`gcloud logging read` on `catalog-web` request
logs, `httpRequest.requestMethod="POST"` by non-owner principals) and no batch in `ingesting` or a
processing status. Every object written lands under `catalog-test/test_brand/<batchId>/`; every
batch is cancelled at the end and its prefix deleted (`deleteTestObjects`, allowed under
`catalog-test/`). Inputs are small (at most 30 photos); the 1,400-photo scale is not replayed live.

1. After PR A: upload `intake-xlsx-grid.xlsx` on the deployed wizard; step 2 renders; the draft's batch
   page says "created" and carries Continue setting up.
2. After PR B: paste the grid; the readback appears; Continue; 6 products. Paste the variants file
   into a new batch; the Dropbox line is refused with the sentence; the `http` link fails with its
   reason phrase and the retry button appears.
3. After PR C: paste the large-sheet stand-in as a real Google Sheet (a sheet shared with
   `catalog-web@`, 60 rows), Continue, close the tab after the first count moves; from the list press
   Continue; finish to step 4 without starting; cancel. Reload tests on steps 2 and 4.
4. After PR D: a step 2 Continue with no change on a ready batch returns within 3 s (no re-copy); the
   two BHPC drafts are cancelled through the UI (proposal section 5, after the operator is told).
5. Each step ends with `catalog-test/` cleanup confirmed by an empty listing of the run's prefixes.

## 9. Deploy and rollout order

PR A: merge, deploy web (no worker change). PR B: merge, deploy web and worker. PR C: if decision 1 is
yes, the migrate job runs `0003_intake_states.sql` before the web and worker deploys (deploy.sh already
runs the migrate job first); deploy web and worker. PR D: deploy worker and web. Each deploy runs the
tier 5 smoke inside `infra/deploy.sh` as always. Rollback per 00 section 6 (`SKIP_BUILD=1` from the
previous commit); the migration is additive (wider CHECK constraints) and needs no down step.

## 10. Report

The 00 section 10 report, plus: the per-fix acceptance results; the browser test video or GIF of
scenarios 2, 3 and 5; the live verification log of 8.4 with the quiet-check timestamps and the cleanup
listing; the contract changes proposed to 02 (the two status values, `BatchCounts` fields, the new
routes); the state of the existing drafts after the cancellations of proposal section 5; the measured
placing rate used by `intakeTimeText` on the live stand-in; and the OPEN decisions still open.

## 11. Assumptions (stated, not asked)

1. The three attempts are representative of operator behaviour even though they come from one person
   on one evening (db, section 5 item 7); the fixes are ordinary resilience and are worth building
   regardless.
2. The sample fetch of three links at paste time (4.2) is acceptable: it is a range GET of 1 KiB
   through `safeFetch`, the same SSRF-safe path the worker uses, and never a write.
3. The paste box holds one `url_list` row per batch; an operator who wants two lists pastes them
   together. Google links keep one row each.
4. "Failed before Start" means `status = failed` and `startedAt` null; a swept batch (2 hours without
   progress during collection) also qualifies and can be reopened.
5. A cancelled draft keeps its bytes; cleanup is the sweep's job under decision 2 and only under
   `catalog-test/` unless the owner widens it later.
6. `wizardStepFor` never returns 3: step 3 is reached from step 2 by Continue, which is cheap once
   the grouping is ready; a batch with channels already chosen opens at 4.
7. The placing chunk size and the link retry bounds are builder constants proven in tier 2 against
   the 900 s deadline; they are not tuned live.
8. Admins see every operator's unfinished batches; operators see their own; viewers see none of the
   actions.

## 12. Owner decisions (OPEN; recorded in `docs/SPEC.md` when closed)

1. One migration (`removed`, `cancelled`) yes or no. Recommended yes.
2. `DRAFT_EXPIRY_DAYS` (recommended 14) and whether cancelled test-brand drafts' bytes are deleted
   after `TEST_DRAFT_CLEANUP_DAYS` (recommended yes, 14, `catalog-test/` only).
3. BHPC product key (Option Id or Unicommerce Code), asked of the operator once; both test drafts
   cancelled either way.
4. The must-fix set (F1 to F6, F9) and the PR order A, B, C, D.
