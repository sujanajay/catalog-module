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
that will not (404, 403, not an image). Lease: a claim with an expiry time that its holder renews while
it works; when the holder dies, the lease runs out and someone else may take over.

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
   products will be named (with a hint when the paste has no product code column), rows that would get
   the same name, and whether the first three links open; "Checking your links..." shows while the check
   runs. Links that turn out to be share pages are explained with the alternative. A file cut off by a
   closed tab says so and can be removed.
2. As soon as the batch exists (the first file or paste), its id is in the address bar. From then on
   reload, Back, a crash, a closed tab or a day away lose nothing: the batch page carries "Continue
   setting up", which reopens the wizard at the right step, and the batch list opens with "Your
   unfinished batches" at the top, each with its state in words, its age, Continue and Cancel.
3. Step 2 renders at once. While the system works it shows the phase, a count and a time: "Downloading
   photos 612 of 1,400, about 7 min left", then "Placing photos 300 of 1,400". A sheet that is still
   being read says so. Nothing shows zeros as results.
4. Failures are listed by row and link with the reason and the next step, separately from unreadable
   files. "Try the failed links again" re-fetches only those, and is offered only when some failures
   may be temporary. Transient failures are retried by the system first (4.5 part 2).
5. The batch page of a draft says "created", carries Continue setting up, and its Compare and Links
   sheet tabs say the batch has not started. A failed batch offers "Fix and continue" with the inputs
   kept.

No new setting, no model name, no technical word in any sentence. The spec 07 banned-names test keeps
passing.

## 3. Scope

In scope: `web/components/catalog/{CatalogWizard,WizardStep1,WizardStep2,WizardStep3,WizardStep4,
PasteBox,Uploader,BatchBanner,RetryCollectButton}.tsx`, `web/components/catalog/wizard-client.ts`,
new `web/components/catalog/{InputList,UnfinishedBatches,LinkFailures}.tsx`, `web/app/catalog/{page,
new/page,[id]/page,brands/[slug]/page}.tsx`, new `web/app/catalog/error.tsx`, `web/lib/catalog/{batches,
uploads,links,preview,copy,exports}.ts`, the routes under `web/app/api/catalog/batches/[id]/` (new:
`uploads/[uploadId]` DELETE, `links/[uploadId]` PATCH and DELETE, `cancel` POST, `reopen` POST,
`retry-links` POST), `ingest/{url-list,links-sheet,detect,detect-step,group,image-check,overwrite-preview,
drive-folder,index}.ts`, `packages/core/src/safe-url.ts`, `packages/core/src/catalog/pipeline/status.ts`,
`packages/core/src/catalog/types.ts` (`BatchCounts`, statuses), `apps/worker/src/catalog/{ingest,sweep}.ts`
(including the new `/tasks/catalog/ingest-more` handler, registered in `apps/worker/src/index.ts`),
`packages/core/src/db/schema.ts` and `packages/core/drizzle/0003_intake_states.sql` (decision 1), tests
and fixtures.

Out of scope: everything after `POST /start`; the identifier, precedence and column detection rules
of 04 (only the cell split and the readback change); new input routes; resumable browser uploads;
Drive folder collection beyond 4.13; the list's search or paging beyond the unfinished section.

## 4. Contracts

Each subsection is one fix of the proposal (F1 to F13), with behaviour, contracts, copy and acceptance
tests. Where a fix ships in two PRs, its parts are marked with the PR (section 7). Sentences in quotes
are exact. `<n>` placeholders are numbers with thousands separators and singular/plural handled by the
existing `plural` helper.

### 4.1 F1: a sheet upload never crashes step 2 (PR A)

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
  and the reading sentence; browser test (8.3) uploads `intake-xlsx-grid.xlsx`, presses Continue and
  asserts step 2 is visible within 2 s with the reading sentence, then the column sentence once
  collected; a test renders `error.tsx` with a batch id (heading, safe sentence, both links, button) and
  without one (heading, "All batches", button; no safe sentence, no "Open this batch").

### 4.2 F2: a pasted grid is understood, with a readback (PR B)

Parser (`ingest/url-list.ts`), replacing `parseUrlList`:

```ts
export interface PastedRow { row: number; identifier: string | null; urls: string[]; name: string | null }
export interface PastedTable { rows: PastedRow[]; links: number; linksPerRow: { min: number; max: number }; shape: "one_per_line" | "id_and_links" | "links_grid"; ignoredCells: number; collisions: { name: string; rows: number[] }[] }
export function parsePastedLinks(text: string): PastedTable;
```

Rules:
- A link cell is one that starts with `http://` or `https://` (case-insensitive) after trimming. A link
  may contain spaces (`https://h/BHSS2620Z-WHITE NAVY_1.JPG` is one link); internal spaces are kept in
  `urls` and percent-encoded (`%20`) before any fetch; `originalName` is the decoded file name.
- Split into lines; split each line into cells on tabs. Inside a cell, and in a line with no tab, split
  further only on a run of whitespace, commas or semicolons immediately before a following `http://` or
  `https://` token; never inside a URL. A cell such as `BH-4610-NE Black` is not split.
- Every link cell of a row is a URL of that row, in column order. The first non-link cell of a row is
  its identifier; later non-link cells, `0`, `-`, `n/a` and blank cells are ignored and counted in
  `ignoredCells`. A link is never an identifier.
- Naming, per row, by precedence:
  - a row with an identifier is named by it;
  - a row with two or more links and no identifier is one product named from its first link's file
    name by `parseShotName` (the full stem before the shot number: `BH-4610-NE-NERO_1.JPG` gives
    `BH-4610-NE-NERO`), shots `n = 1..k` in column order;
  - a single-link row without an identifier has `name: null` and keeps today's grouping by file name
    (`parseShotName(fileName)`).
- `shape`, by precedence: `id_and_links` if any row has an identifier; else `links_grid` if any row has
  two or more links; else `one_per_line`.
- `collisions`: rows with a non-null `name` that equals another row's name, with their row numbers.
- Rows without any link are skipped.
- `urlListItems` consumes `PastedTable`; `originalName` is the file name of each link, never of the
  row.

Sheet cells (`ingest/links-sheet.ts` `cellUrls`): the same link rule and the same split rule (split only
before a following http(s) token, newlines included), so a Google Sheet cell holding a link with a
space stays one link and the working Google Sheet route does not regress.

`safeFetch` (`packages/core/src/safe-url.ts`): `SafeFetchOptions` gains `headers?: Record<string,
string>` (sent on every hop) and `truncateAt?: number`. With `truncateAt`, the call reads at most that
many bytes, cancels the rest of the body and returns `{ status, mime, bytes }` for any final status
instead of throwing on a non-2xx answer; an SSRF refusal still throws `UnsafeUrlError`. Without it,
behaviour is unchanged for every existing caller.

Readback (`ingest/detect.ts` `checkLinkAccess` for `url_list`, run by `POST /links`): returns
`Detected` with `rows`, `fileCount` (= links), new fields `linksPerRow: {min, max}`, `shape`,
`collisions`, `sample: { tried: number; ok: number; webPages: number; failures: { url: string; reason:
string }[] }` from the first three links, each fetched through `safeFetch` with `headers: { Range:
"bytes=0-1023" }`, `truncateAt: 1024` and a 5 s timeout, and `message` built as below. Verdict per
sampled link, from the status and the content type or the sniffed bytes: ok when the status is 200 or
206 and the content type is `image/*` or the first bytes carry a known image signature (JPEG, PNG, WebP,
GIF, HEIC); web page when the content type is `text/html` or the first non-blank byte is `<`; otherwise
a failure with the reason phrase of 4.5 for its status. There is no list of refused hosts. The sample
never blocks the paste; its failures are information. A list whose every sampled link fails still gets
status `uploaded` (the reporting of 4.5 takes over).

Waiting state (`PasteBox`): from paste or blur until the readback returns, the pill reads "Checking your
links..."; Continue stays enabled; a later edit aborts the pending check and starts a new one, and only
the latest answer is shown.

Copy:
- Readback pill: "<rows> rows, <links> links" (or "<links> image links" when `one_per_line`).
- Readback line: "<min> to <max> links per row." (reads "<k> links per row." when equal; omitted for
  `one_per_line`), then the naming sentence, then the sample sentence:
  - naming, `id_and_links`: "Products will be named by the first column, for example <id>."
  - naming, `links_grid`: "This paste has no product code column, so products will be named from the
    photo file names, for example <name>. To name them yourself, copy the product code column in as the
    first column."
  - naming, `one_per_line`: "Products will be named from the file names, for example <name>."
  - sample: "We opened the first <tried> links: all fine." or "We opened the first <tried> links: <ok>
    of <tried> opened; <reason phrase of the first failure>."
- Share pages, when any sampled link is a web page: "These look like share pages, not image links.
  Download the photos and drop them here, or paste direct image links."
- Collisions, one line each: "Rows <r1> and <r2> would get the same name, <name>. Check those rows
  before you continue." (three or more rows: "Rows <r1>, <r2> and <r3> ...").
- Ignored cells, when `ignoredCells > 0`: "<n> empty or non-link cells were ignored."
- Waiting pill: "Checking your links..."

Acceptance (tier 1, `url-list.test.ts`): the fixture `intake-pasted-grid.txt` (8.1) gives 6 rows, 27
links, 4 to 5 per row, shape `links_grid`, 3 ignored cells, every identifier null, names
`BH-4610-NE-NERO` etc. with `n` 1..5, no collisions; its space-name row gives one product
`BHSS2620Z-WHITE NAVY` with all 5 shots, and its fetch URLs carry `%20`; `intake-pasted-variants.txt`
gives 7 rows, 12 links, 1 to 2 per row, shape `id_and_links`, row 1 (URL, URL) one product with 2 shots
and no URL identifier, row 2 named by its identifier, row 3 (two links separated by a space) 2 links,
rows 4 and 5 `name: null`, and `collisions` `[{ name: "TB-F", rows: [6, 7] }]`; one link per line is
unchanged against the existing tests; `cellUrls` on `"https://h/a_1.jpg\nhttps://h/a_2.jpg"`,
`"https://h/a_1.jpg https://h/a_2.jpg"` and `"https://h/a_1.jpg,https://h/a_2.jpg"` gives 2, and on
`"https://h/X-WHITE NAVY_1.jpg"` gives 1. `safe-url.test.ts`: `truncateAt: 1024` returns 1,024 bytes
and status 404 without throwing; `headers` are sent on every redirect hop; existing behaviour unchanged
without the options. `detect.test.ts`: the readback for the grid fixture equals "6 rows, 27 links" +
"4 to 5 links per row. This paste has no product code column, so products will be named from the photo
file names, for example BH-4610-NE-NERO. To name them yourself, copy the product code column in as the
first column. We opened the first 3 links: all fine." + "3 empty or non-link cells were ignored."; the
readback for the variants file equals "7 rows, 12 links" + "1 to 2 links per row. Products will be
named by the first column, for example TB-B. We opened the first 3 links: all fine." + "Rows 6 and 7
would get the same name, TB-F. Check those rows before you continue."; a paste of one Dropbox share link
whose fake host answers `text/html` gives the share-page sentence and status `uploaded`; a fake fetch
records 3 GETs carrying the Range header and nothing else; PasteBox UI test: the waiting pill shows
until the readback resolves, Continue stays enabled, and an edit during the check shows only the second
answer. Tier 2 (`ingest.test.ts`): the grid fixture collected end to end gives 6 products, 27 photos,
0 rejects, `unsupportedFiles` 0, and the space-name product with 5 shots; `links-sheet` tier 2 with
`intake-large-sheet.csv` and the xlsx fixture each give the space-name product with all its shots.

### 4.3 F3: inputs can be corrected without duplicates (PR B)

- The paste box binds to one `url_list` upload row per batch. `POST /links` with `url_list` text
  updates the batch's existing `url_list` row (if any) instead of inserting by `sourceUrl`; Google
  lines keep one row per link as today. `PATCH /links/[uploadId]` `{text}` replaces; `DELETE
  /links/[uploadId]` and `DELETE /uploads/[uploadId]` remove (draft only; `assertDraft`).
- "Remove" semantics (decision 1): with the migration (shipped in this PR, section 5), the row gets
  status `removed` and is ignored by `ingestBatch`, `finishIfLast`, `buildDetectedStep2`,
  `buildPreview` and the counts; its object under `uploads/` is left for the lifecycle. Without the
  migration, the row is deleted and its object under `uploads/<uploadId>/` is deleted (private,
  batch-owned, never public; the `assertWithinProduct` rule concerns public objects and is not
  involved).
- Removing or changing an input sets `counts.previewReady = false` (a merge, see 4.6) and, when the
  batch is `ingesting`, is refused with the collecting sentence of 4.8.
- `Uploader` Retry: when `row.plan` is older than `SIGNED_PUT_TTL_SEC` (900 s, 02) it plans again
  before the PUT. A failed row has Remove. Continue is disabled only by rows the operator can act on.
- New `InputList.tsx` under step 1 lists every upload of the batch from the server (`GET batch`
  already returns uploads) with kind word, name, size, state word and Remove; it is the same list the
  resumed wizard shows (4.4). A server row still `pending` that this browser session is not uploading
  (not among `Uploader`'s in-memory rows), for example because the tab was closed mid-upload, shows
  "Upload did not finish. Add the file again or remove it." with Remove. `wizardStepFor` opens step 1
  for such a batch (4.4).
- Copy: Remove button "Remove"; confirmation none (a removed input can be added again). State words:
  "Uploading <p>%", "Uploaded", "Checked", "Upload failed. Try again or remove it.", "Upload did not
  finish. Add the file again or remove it.", "Removed".
- Acceptance (tier 2, `catalog-wizard-routes.test.ts`): paste A (3 links), then PATCH with text B (2
  links): one `url_list` row, 2 links, preview invalidated; DELETE an upload: the row is `removed` (or
  gone) and `ingestBatch` ignores it; a batch with one removed and one uploaded row collects the
  uploaded one only; `catalog-uploader-ui.test.ts`: a failed row older than the TTL re-plans on Retry
  (the fake records a second `/uploads` POST); `catalog-intake-ui.test.ts`: a `pending` server row with
  no matching in-memory row shows the did-not-finish sentence and Remove; browser test (8.3): paste the
  grid, clear the box, paste one link per line, Continue; step 2 shows the second paste's products only.

### 4.4 F4: every unfinished batch can be found and resumed (part 1 PR A, part 2 PR C)

Part 1, the way back (PR A):

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

Part 2, the unfinished list and Cancel (PR C):

- The list (`web/app/catalog/page.tsx`): a section "Your unfinished batches" above the table, listing
  the signed-in user's `draft`, `ingesting` and failed-before-start batches (admins see everyone's,
  with the creator; viewers see the section read-only, with no buttons), newest first, each row: name,
  brand, state words, age ("created 5 minutes ago", "2 days ago"), and the actions "Continue" and
  "Cancel". A failed-before-start row shows "Fix and continue" instead of "Continue": it performs the
  reopen of 4.8 and then navigates to `/catalog/new?batch=<id>`. The section is absent when empty. The
  main table excludes `cancelled` batches by default and gets a "Show cancelled" link. On phones the
  section is a card list, and the main table keeps its State column on screen (the Channels column
  collapses first).
- The batch page gets "Cancel this batch" as a secondary action next to "Continue setting up".
- `POST /cancel` (draft, ingesting, or failed-before-start; operator): sets status `cancelled`
  (decision 1 yes) or `options.cancelled = { at, by }` with status unchanged (decision 1 no); releases
  nothing (drafts hold no locks: db section 2); refuses a batch that has started. `deriveBatchState`
  gets state `cancelled`, pill "Cancelled", list pill "Cancelled". The sweep ignores cancelled batches.
- Cancel guards (the worker can never revive a cancelled batch): the worker's final status writes
  (`finishBatch`, `placeBatch` and the closing `patchCounts`) apply only `WHERE status = 'ingesting'`
  and while the caller holds the placing lease of 4.6; `runIngest` and `placeBatch` exit at the start of
  each delivery when the batch is cancelled.
- `UPLOAD_STATUSES` gains `removed` (PR B) and `BATCH_STATUSES` gains `cancelled` (used from PR C) with
  decision 1 (section 5).
- State words for unfinished rows (from `deriveBatchState`, new field `intake: string`):
  - pending uploads: "<n> files did not finish uploading"
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
- Also in PR C, as must (4.7 part 1): the sha256 skip and the instant step 2 Continue, so a returning
  operator does not wait for a full re-copy.
- Copy: section heading "Your unfinished batches"; buttons "Continue", "Cancel", "Fix and continue",
  "Continue setting up", "Cancel this batch"; cancel confirmation (inline, not a modal): "Cancel
  <name>? Nothing was processed and nothing was charged." with "Yes, cancel" and "Keep it"; leaving line
  from PR C (replacing the PR A line): "You can close this page. Find this batch under Your unfinished
  batches and press Continue when it is ready."
- Acceptance, part 1 (PR A): tier 1 `wizardStepFor` table test over every state in the doc comment
  (no input, pending upload, collecting, placing, waiting for a column, ready without channels, ready
  with channels); tier 2 page tests (`catalog-pages.test.ts` harness): `GET /catalog/new?batch=` of a
  draft renders the wizard at its step; of a failed and of a started batch redirects to
  `/catalog/<id>` (a cancelled batch is added to this test in PR C); the draft batch page carries "Continue setting up" with the link;
  browser test (8.3 scenario 5, PR A form): paste the grid, the URL carries `?batch=`, reload: same
  step; open the batch from the list, press Continue setting up: the wizard at the step.
- Acceptance, part 2 (PR C): cancel of a draft, of an ingesting batch, of a failed-before-start batch
  succeeds and of a `matting` batch is 409; tier 2 `ingest.test.ts`: cancel a batch mid-collection, run
  the remaining deliveries and the placing: the batch is still `cancelled` after the last delivery and
  no `catalog_source_images` rows were written; the list page shows the section for the creator and
  not for another operator (admin sees both; a viewer sees the rows without buttons); a
  failed-before-start row carries "Fix and continue", which reopens and opens step 1; browser test
  (8.3 scenario 5, PR C form): close and reopen `/catalog`: the section shows the batch "Ready to
  check" with Continue, which opens step 2 with the grouping; Continue to step 4 and reload: step 4.

### 4.5 F5: link failures are named, classified and retried (part 1 PR B, must; part 2 PR D, should)

Part 1, the visible part (PR B):

- `image-check.ts` `classifyImageReject` gains kind `link` for reasons produced by `fetchSourceUrl`
  (any reason ending in "did not return an image (got <x>)." or starting with "Only https links").
  `whatWasFound` and `noPhotosReason` use it. `readPhrase` (`group.ts`) gets a link case.
- Each link reason is classified as may-be-temporary (network error, timeout, 408, 425, 429, 500, 502,
  503, 504) or permanent (404, 403, 410, a web page or other non-image, http only, SSRF refusal), from
  the stored reason.
- Reasons carry position: pasted grid "row <r>, column <c>"; sheet "row <r>, column <header>" (04
  already specifies this for sheets; the worker now stores it).
- `BatchCounts` gains `linkFailures: number` (link rejects); `unsupportedFiles` no longer counts links.
- `buildDetectedStep2` returns `linkFailures: { total: number; temporary: number; byReason: { reason:
  string; count: number; first: { url: string; where: string } }[]; products: number }` next to
  `unreadable` (which keeps files only). `buildPreview.warnings` gains the link pair below. `GET
  /preview` returns the full failure list under `linkFailureRows` (url, where, reason) for the "Show
  all" table.
- `POST /retry-links` (operator) accepts a `draft` batch and a failed-before-start batch. For a
  failed-before-start batch it first performs the reopen of 4.8 (`reopenBatch` in `batches.ts`, written
  in this PR and exposed as `POST /reopen` in PR C). It then drops the link reject results from the
  manifests of the batch's non-removed uploads so those items count as unread, sets those uploads back
  to `uploaded` (as `regroupBatch` does, `web/lib/catalog/uploads.ts:96`) and calls `ingestBatch`.
  Refused for an `ingesting` batch (the collecting sentence of 4.8) and for a started one.
- "Try the failed links again" is shown (step 2 card, step 4, batch page) only when `linkFailures > 0`
  and at least one failure may be temporary.
- Copy:
  - Step 2 card heading "Links that could not be downloaded" (only when `linkFailures > 0`):
    "<total> of <links> links could not be downloaded (<products> products affected). <count> <reason
    phrase>, for example <url> (<where>)." one line per reason, then the buttons "Try the failed links
    again" (only when some may be temporary) and "Show all <total>".
  - Reason phrases: "answered 'not found' (404)", "were refused (403)", "did not answer in time",
    "returned a web page instead of an image", "use http instead of https", "could not be reached".
  - Step 4 warning pair: "<k> links could not be downloaded." + "<products> products are missing
    shots: <ids, first 10>." followed by "Try the failed links again, fix the sheet, or continue without
    them." when some may be temporary, or "Fix the links, or continue without them." when all are
    permanent.
  - No-photos sentence for links: "No photos could be downloaded from the <n> links you <pasted |
    listed in <sheet>>. <count> <reason phrase>, for example <url> (<where>)." followed by:
    - when every failure is permanent: "Check that the links open in a browser, then press Fix and
      continue and paste the corrected links." (from PR C; in PR B, before "Fix and continue" exists:
      "Check that the links open in a browser, then make a new batch and paste the corrected links.")
      and no retry button;
    - when some may be temporary: "Some of these may work on a second try. Press Try the failed links
      again." and the retry button.
    (The file version of the sentence is unchanged.)
  - Batch page banner for a failed links batch: the sentence above with "Fix and continue" (4.8, from
    PR C) and, only when some may be temporary, "Try the failed links again".
- Acceptance (part 1): tier 2 `ingest.test.ts`: the grid fixture with every link 404 fails with the
  exact all-permanent no-photos sentence, `linkFailures` 27, `unsupportedFiles` 0; with some links 503
  the some-temporary sentence; `detect-step.test.ts`: the `linkFailures` block (with `temporary`) from
  the manifest; `group.test.ts`: both step 4 pairs; routes: `POST /retry-links` on a draft re-fetches
  only rejects (fake fetch count equals the reject count); `POST /retry-links` on a failed-before-start
  links batch reopens it (reason cleared), re-fetches only the rejects and ends `draft` ready when the
  host now answers; on a started batch 409; UI: the retry button is absent when every failure is
  permanent.

Part 2, automatic retry (PR D):

- Item results in the manifest gain `attempts: number` and `final: boolean`. A transient failure is
  retried inside the delivery up to `LINK_RETRY_ATTEMPTS` (builder constant, 3) with backoff 2 s, 8 s,
  and stored with `final: false`; retries use a 20 s timeout (the first attempt keeps the existing
  60 s). A permanent failure is stored `final: true`.
- Within one run, continuations never re-fetch non-final items: they carry the run's results forward.
  Only a new run (Try again, regroup, `POST /retry-links`) clears non-final results so they are fetched
  again. After `LINK_MAX_ATTEMPTS` (builder constant, 9) attempts across runs, a link is stored
  `final: true` with its reason. `POST /retry-links` is the operator's explicit request and drops the
  results with their attempt history (part 1).
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

### 4.6 F6: a count, a phase and an honest time on every intake wait (copy PR A, worker side PR C)

PR A (no worker change): wizard steps 2 and 3 show `state.text` from the batch response they already
poll (replacing the fixed sentences at `CatalogWizard.tsx:146,148`), using today's `collectingText`
and counts; step 2 hides the grouping cards (identifier mode, formats, sheet columns, Google access)
while the batch is collecting and shows the sheet reading card of 4.1 when a sheet is being read; the
leaving line of 4.4 part 1 replaces "Processing starts by itself. You can close this page."
(`copy.ts:65-67`).

PR C (worker side):

- `BatchCounts` gains `phase: "uploading" | "downloading" | "reading" | "unpacking" | "checking" |
  "placing" | "ready" | "needs_input" | null`, `placed: number`, `placeTotal: number | null`,
  `rate: { at: string; phase: string; done: number }[]` (the last 5 samples, written by the worker with
  each counts update; `done` is `placed` during placing) and `placingClaim: { token: string; until:
  string } | null`. All live in the existing `counts` jsonb; no migration.
- `runIngest` writes `phase` with every `bumpCollected`; `finishIfLast` sets `phase: "placing"` and
  `placeTotal`; placing writes `placed` after every chunk of 4.7 part 2 (until that ships, once at the
  end) and `phase: "ready"` or `"needs_input"` with `previewReady`. The worker clears `rate` whenever it
  changes `phase`.
- Placing lease. The batch stays `ingesting` until `previewReady` or `failed`: the `finishIfLast` claim
  no longer sets `draft`. It claims with one atomic update that merges `placingClaim = { token, until }`
  into counts (`counts = counts || jsonb_build_object('placingClaim', ...)`) `WHERE status = 'ingesting'
  AND (counts->'placingClaim' IS NULL OR (counts->'placingClaim'->>'until')::timestamptz < now()) AND
  NOT EXISTS (<uploads not collected or failed or removed>)`. `token` is derived from the claiming
  delivery (its run and upload id), so a Cloud Tasks retry of the same task presents the same token;
  `until` is now + `PLACING_LEASE_MS` (builder constant, longer than the 900 s request deadline).
  Continuation deliveries (4.7 part 2) carry the token and renew `until` after each chunk. A delivery
  whose token does not match a live lease does nothing. A thrown error leaves the lease in place, so the
  retry with the same token continues from the cursor (4.7 part 2) or, before that ships, runs the
  placing again (cheap through the sha256 skip of 4.7 part 1). A lease that runs out without renewal is
  a stall under the existing `COLLECT_STALL_MS` rule; Try again and `regroupBatch` clear it. The closing
  `patchCounts` sets status `draft` and clears the lease, guarded as in 4.4 part 2.
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
  phase words from the table in 4.4. List pill: "<phase words> <done> of <total>".
- Step 2 hides the grouping cards while `phase` is not `ready` or `needs_input`. Step 4's bar uses
  `placed` during placing.
- Copy:
  - Leaving line: the PR A line (4.4 part 1), replaced in PR C by the line of 4.4 part 2.
  - Collecting banner text: "<phase words> <done> of <total> from your <source>, about <m> min left".
- Acceptance: PR A: wizard UI test: steps 2 and 3 render the polled text and never the string "0 of 0
  products"; the banned string "Processing starts by itself" is absent from the source tree (test in
  `catalog-pages.test.ts`). PR C: tier 1 `status.ts`: `intakeTimeText` with placing samples 0 at t0 and
  200 at t0+100 s over a `placeTotal` of 1,400 gives "about 10 min left"; downloading samples present
  next to one placing sample give no text; no text with one sample; `deriveBatchState` for `ingesting`
  with `phase: "placing"` gives "Placing photos 300 of 1,400"; tier 2 `ingest.test.ts`: during placing
  the batch stays `ingesting` with `phase: "placing"`, then `draft` with `phase: "ready"`; `rate` is
  emptied when the phase changes; a thrown placing leaves the lease and a retry with the same token runs
  it to the end; a delivery with another token while the lease is live does nothing; a lapsed lease can
  be claimed; a `regroupBatch` during `ingesting` leaves `phase` and `placingClaim` untouched (merge).

### 4.7 F7: placing is resumable and never re-copies (part 1 PR C, must; part 2 PR D, should)

Part 1 (PR C, shipped with F4 as must):

- `placeRaw`: before copying, `headObject` on the target; when it exists and its stored sha256 (object
  metadata `sha256`, set on write) equals the item's sha256, skip the copy (04's promise).
- `patchDetected` with no change (same options, same sheet choices) returns at once without regrouping,
  so step 2 Continue with nothing changed is instant.
- Acceptance (tier 2): a second placing run on the same batch performs zero copies (the fake storage
  counts `copy` calls); a `patchDetected` with unchanged values performs no enqueue and no upload status
  change.

Part 2 (PR D, should):

- `finishBatch` is reordered and split. `groupBatch` runs first: `removeDraftRows`, `assemble`,
  matching and `findOrCreateProduct`, then saves the planned shot list (`{ productId, pathKey, n,
  sourceUri, sha256 }[]`) to `place-state.json` under `derived/_ingest/` (sibling of
  `preview-state.json`). `placeBatch` then copies that list in chunks of `PLACE_BUDGET_ITEMS` (builder
  constant, chosen to stay well inside 900 s at the measured 280 photos/min, start 800) with the sha256
  skip; after each chunk it writes `counts.placed`, renews the lease of 4.6 and re-enqueues itself with
  the cursor and the lease token. The delivery that places the last chunk inserts the
  `catalog_source_images` rows, writes `preview-state.json` and sets the counts (`previewReady`,
  `phase`, status `draft`, guarded as in 4.4 part 2).
- `regroupBatch` after a step 2 change whose only effect is options (identifier mode, precedence,
  sheet columns, sheet kind) does not touch upload statuses; it reruns `groupBatch` with the new options
  and then `placeBatch`, where the sha256 skip makes unchanged photos free.
- Unproven risk: `groupBatch` alone at about 2,000 products has not been measured against the 900 s
  deadline. The builder measures it in tier 2 with fakes at that size and reports the time (section 10);
  if it does not fit with a wide margin, that is raised as an open issue, not solved silently.
- Acceptance (tier 2): 1,000 fake items with `PLACE_BUDGET_ITEMS` 300: four placing deliveries,
  `placed` moves 300, 600, 900, 1,000, the batch is `ingesting` with `phase: "placing"` throughout, then
  `draft` ready; `catalog_source_images` rows appear only after the last chunk; a killed delivery (the
  test throws after chunk 2) leaves the lease and cursor so the retry with the same token continues at
  chunk 3; an options-only regroup runs `groupBatch` then `placeBatch` with zero copies and no upload
  status change.

### 4.8 F8: a batch that failed before Start can be fixed in place (PR C, must)

- `POST /reopen` (operator), using `reopenBatch` (4.5 part 1): a batch with status `failed` and
  `startedAt` null returns to `draft`, `counts.failReason` cleared, `previewReady` false, uploads
  untouched (manifests and staged bytes are reused by the sha256 skip and the manifest results). Refused
  for started batches.
- `assertDraft` sentences by status: `failed` + never started: "This batch could not start. Press Fix
  and continue to change its photos or links."; `ingesting`: "This batch is still collecting. Wait for
  it to finish, or press Try again if nothing has moved for 10 minutes."; any started status: the
  existing "This batch has already started. Make a new batch to add more photos."; `cancelled`: "This
  batch was cancelled. Make a new batch."
- "Fix and continue" (failed batch page, replacing "Start again"; and failed-before-start rows of "Your
  unfinished batches", 4.4 part 2) performs the reopen, then navigates to `/catalog/new?batch=<id>`;
  step 1 shows the previous `failReason` above the input list. The wizard never renders on a failed
  batch (4.4 part 1).
- Acceptance (tier 2 routes): reopen a never-started failed batch: draft, reason cleared, inputs kept;
  reopen a started failed batch: 409; the `assertDraft` sentences; browser test (8.3): the grid with
  every link 404 fails, "Fix and continue" opens step 1 with the reason and the paste, the operator
  pastes one link per line, Continue, step 2 ready.

### 4.9 F9: draft and failed screens tell the truth (PR A)

- Batch header: "created <time> by <email>" when `startedAt` is null; the channel list is omitted when
  empty (no "· ·").
- Draft banner: text "Ready to check. Press Continue setting up to see the grouping and choose
  marketplaces." (ready), the state words of 4.4 otherwise; the "Continue setting up" button of 4.4
  part 1 inside the banner.
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

### 4.10 F10: the same photos in another batch are flagged (PR D)

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

### 4.11 F11: platform errors and large hand-offs (part 1 PR C; part 2 PR D)

Part 1 (PR C): `wizardApi`: when `response.headers.get("content-type")` is not JSON or the body does
not parse, throw `WizardApiError` with status and the sentence "The server did not answer in time. Your
files are safe. Reload this page to continue." (502, 503, 504) or "This did not finish. Reload this page
and try again." (anything else). Acceptance: `fetch.test.ts`: an HTML 504 gives the sentence.

Part 2 (PR D, should): `ingestBatch` hands over at most `HAND_OFF_PAGE` (builder constant, 500)
`uploaded` rows in the web request, then enqueues one `/tasks/catalog/ingest-more` task `{batchId, run}`
and returns `{ collecting: true, remaining }`. That task (handler in `apps/worker/src/catalog/ingest.ts`,
registered in `apps/worker/src/index.ts`) hands over the next `HAND_OFF_PAGE` rows still `uploaded` and
re-enqueues itself until none remain, so one Continue is enough for any count. Acceptance: routes and
worker: 1,200 fake uploads produce one web page and two `ingest-more` deliveries, and every upload
reaches the queue exactly once (fake queue count).

### 4.12 F12: draft housekeeping and a trace per delivery (PR D)

- Sweep: a `draft` batch (never started, not cancelled) whose `updated_at` is older than
  `DRAFT_EXPIRY_DAYS` (env, default 14; decision 2) is cancelled with `options.expired = { at, days
  }`; the list shows "Expired after <N> days with no activity". Objects are untouched.
- `handleIngestTask` logs one INFO line per delivery: `{ event: "ingest", batchId, uploadId, phase,
  done, total, ms, outcome }`.
- Acceptance: `sweep.test.ts`: a 15-day draft is cancelled with `expired`, a 13-day one is not, a
  cancelled one is untouched, no objects are deleted; `ingest.test.ts`: the log spy sees one line per
  delivery with the batch id.

### 4.13 F13: Google and Drive edge cases (later)

- `PasteBox`: "Check again" next to a "No access yet" pill re-posts the same text (bypassing the
  `savedText` guard).
- Drive folder (`ingest/drive-folder.ts`): the size check (`DRIVE_FOLDER_MAX_BYTES`) runs at paste time
  from the full listing and the "too large" sentence of 04 is shown at paste; the worker keeps
  `prior.rejected` when rebuilding `detected`.
- Acceptance: routes test with the Google fakes of 04.

## 5. Data and state changes

| Change | Where | Migration? |
|---|---|---|
| `counts.phase`, `placed`, `placeTotal`, `rate` (with `phase` per sample), `linkFailures`, `placingClaim` | `catalog_batches.counts` jsonb (`BatchCounts` type) | No (jsonb; `EMPTY_BATCH_COUNTS` gets defaults; old rows read as null/0) |
| `detected.linksPerRow`, `shape`, `collisions`, `sample`, `reading`; manifest `attempts`, `final` (PR D); `place-state.json` (PR D) | `catalog_uploads.detected` jsonb; bucket objects | No |
| `options.cancelled`, `options.expired` (decision 1 no; `expired` either way) | `catalog_batches.options` jsonb | No |
| Upload status `removed` | `catalog_uploads.status` CHECK constraint (`schema.ts:275,283`) | **Yes**: `0003_intake_states.sql` (PR B) drops and recreates the two CHECK constraints with the new values |
| Batch status `cancelled` | `catalog_batches.status` CHECK constraint (`schema.ts:237,256`) | **Yes** (same migration, PR B; first used in PR C) |
| `SafeFetchOptions.headers`, `truncateAt` | `packages/core/src/safe-url.ts` | No |
| New routes `DELETE uploads/[uploadId]`, `PATCH|DELETE links/[uploadId]`, `POST retry-links` (PR B), `POST cancel`, `POST reopen` (PR C); worker task `/tasks/catalog/ingest-more` (PR D) | web, worker | No |
| Env `DRAFT_EXPIRY_DAYS` (14) | worker, deploy.sh | No |

Builder constants (in code, not env, proven in tier 2): `LINK_RETRY_ATTEMPTS` (3), `LINK_MAX_ATTEMPTS`
(9), `INGEST_TIME_BUDGET_MS` (600 s), `PLACE_BUDGET_ITEMS` (start 800), `PLACING_LEASE_MS`,
`HAND_OFF_PAGE` (500).

Migration flag (00 section 11): only specs 02 and 03 ship migrations, and a contract change to 02 is
proposed in the report, never made silently. This spec proposes the two new status values as a 02
contract change and needs the owner's explicit yes (decision 1) before the migration is written. The
migration ships in PR B together with `schema.ts`, because PR B is the first to use `removed`; PR C
uses `cancelled` from it. Precedent: `0002_cost_events.sql` (PR #90). Without the yes, the
no-migration path of 4.3 and 4.4 is built instead (hard delete of removed uploads; `options.cancelled`
for cancelled batches, with `deriveBatchState` reading it before the status).

## 6. Copy register

Every new or changed sentence, for the no-model-names test and for review. Placeholders in angle
brackets. No raw rule ids, no model ids, no technical words.

| Where | Sentence |
|---|---|
| Step 2 sheet reading | Reading your sheet. The columns will appear here when it has been read. |
| Error page, batch known | Something went wrong on our side. / Your batch is safe; nothing was lost. / Open this batch / All batches / Try this page again |
| Error page, no batch known | Something went wrong on our side. / All batches / Try this page again |
| Paste waiting | Checking your links... |
| Paste readback | <rows> rows, <links> links / <links> image links / <min> to <max> links per row. / <k> links per row. |
| Paste naming | Products will be named by the first column, for example <id>. / This paste has no product code column, so products will be named from the photo file names, for example <name>. To name them yourself, copy the product code column in as the first column. / Products will be named from the file names, for example <name>. |
| Paste sample | We opened the first <tried> links: all fine. / We opened the first <tried> links: <ok> of <tried> opened; <reason phrase of the first failure>. |
| Paste share pages | These look like share pages, not image links. Download the photos and drop them here, or paste direct image links. |
| Paste same name | Rows <r1> and <r2> would get the same name, <name>. Check those rows before you continue. |
| Paste ignored cells | <n> empty or non-link cells were ignored. |
| Input list | Remove / Uploading <p>% / Uploaded / Checked / Upload failed. Try again or remove it. / Upload did not finish. Add the file again or remove it. / Removed |
| List section | Your unfinished batches / Continue / Fix and continue / Cancel / Show cancelled |
| Batch page | Continue setting up / Cancel this batch / Fix and continue / Try the failed links again |
| Cancel confirmation | Cancel <name>? Nothing was processed and nothing was charged. / Yes, cancel / Keep it |
| State words | <n> files did not finish uploading / Nothing added yet / Downloading photos <done> of <total> / Reading your sheet / Unpacking your zip / Checking your uploaded files / Placing photos <placed> of <total> / Ready to check / Needs your input: which column holds the identifier? / Ready to start / Could not start: <reason> / Cancelled <age> / Expired after <N> days with no activity |
| Time | about <m> min left / a few minutes left |
| Leaving line, PR A | You can close this page. Open this batch again from the batch list and press Continue setting up when it is ready. |
| Leaving line, from PR C | You can close this page. Find this batch under Your unfinished batches and press Continue when it is ready. |
| Link failures card | Links that could not be downloaded / <total> of <links> links could not be downloaded (<products> products affected). / <count> <reason phrase>, for example <url> (<where>). / Show all <total> / Transient problems were tried <attempts> times. (PR D) |
| Reason phrases | answered 'not found' (404) / were refused (403) / did not answer in time / returned a web page instead of an image / use http instead of https / could not be reached |
| Step 4 link pair | <k> links could not be downloaded. / <products> products are missing shots: <ids>. Try the failed links again, fix the sheet, or continue without them. / <products> products are missing shots: <ids>. Fix the links, or continue without them. |
| No photos, links | No photos could be downloaded from the <n> links you <pasted / listed in <sheet>>. <count> <reason phrase>, for example <url> (<where>). + one of: Check that the links open in a browser, then press Fix and continue and paste the corrected links. (all permanent, from PR C) / Check that the links open in a browser, then make a new batch and paste the corrected links. (all permanent, PR B only) / Some of these may work on a second try. Press Try the failed links again. (some temporary) |
| assertDraft | This batch could not start. Press Fix and continue to change its photos or links. / This batch is still collecting. Wait for it to finish, or press Try again if nothing has moved for 10 minutes. / This batch was cancelled. Make a new batch. |
| Platform error | The server did not answer in time. Your files are safe. Reload this page to continue. / This did not finish. Reload this page and try again. |
| Draft banner | Ready to check. Press Continue setting up to see the grouping and choose marketplaces. |
| How this works, draft | This batch has not started. Continue setting it up to check the grouping, choose marketplaces and start. Nothing is processed and nothing is charged until you press Start. |
| Not-started tabs | This batch has not started. <photos> photos found for <products> products; nothing has been made yet. |
| Header | created <time> by <email> |
| Brand page empty | No products of <brand> yet. |
| Same photos pair | These photos are already in <name> (<state>, created <age>). / <shared> of <photos> photos are the same, under different identifiers (<there> there, <here> here). Continue that batch or cancel it before starting this one, so the same product is not made twice. (<name> links to that batch) |
| Duplicate photo pair | <k> photos appear under two products. / <name> is in <id a> and <id b>. Check the sheet before starting. |

Removed sentences: "Processing starts by itself. You can close this page."; "N image links" for a grid;
"<n> other files" for links; "started <time>" on unstarted batches; the PR A leaving line and the PR B
no-photos ending, once PR C ships.

## 7. Workstreams and build order

Must set: F1, F2, F3, F4, F5 (visible part), F6, F8, F9. PR order A, B, C, D.

| PR | Workstreams | Worktree | Files | Depends on |
|---|---|---|---|---|
| A, truth and way back (small, first) | 4.1 F1, 4.9 F9, the PR A part of 4.6 (copy and step 2 text from the existing counts, no worker change), 4.4 part 1 (`?batch=` in the URL, `/catalog/new?batch=` for draft and ingesting batches, `wizardStepFor`, "Continue setting up" on the batch page) | `catalog-module-wt/14-intake-resilience-a-truth` | `WizardStep2`, `CatalogWizard` (`loadDetected`, URL, `initialBatch`), `new/page.tsx`, `status.ts` (`wizardStepFor`), `error.tsx`, batch page, `BatchBanner`, list, brand page, `copy.ts`, tests | nothing; deployable alone |
| B, inputs and failures | 4.2 F2, 4.3 F3, 4.5 F5 part 1, migration `0003_intake_states.sql` + `schema.ts` (decision 1) | `catalog-module-wt/14-intake-resilience-b-inputs` | `url-list.ts`, `links-sheet.ts`, `detect.ts`, `safe-url.ts`, `detect-step.ts`, `image-check.ts`, `group.ts`, `index.ts` (link class, positions), `links.ts`, `uploads.ts`, `batches.ts` (`reopenBatch`), new routes (uploads, links, retry-links), `PasteBox`, `Uploader`, `InputList`, `LinkFailures`, `schema.ts`, `0003_intake_states.sql`, tests, fixtures | A merged |
| C, resume and progress | 4.4 part 2 (unfinished section, Cancel, cancel guards), 4.6 worker side (phase, rate, lease, merge writes), 4.7 part 1 (sha256 skip, instant Continue), 4.8 F8, 4.11 part 1 | `catalog-module-wt/14-intake-resilience-c-resume` | `CatalogWizard`, `status.ts`, `index.ts` (lease, phase, guards, `placeRaw`), `preview.ts`, `uploads.ts`, `batches.ts`, `cancel`/`reopen` routes, list section (`UnfinishedBatches`), batch page, `wizard-client.ts`, tests | A, B merged |
| D (should) | 4.7 part 2 (groupBatch first, chunked placeBatch), 4.5 part 2 (automatic retry), 4.10 F10, 4.11 part 2 (`ingest-more`), 4.12 F12 | `catalog-module-wt/14-intake-resilience-d-placing` | `index.ts` (groupBatch, placeBatch, retry), `overwrite-preview.ts`, `group.ts`, `sweep.ts`, worker `ingest.ts` and `index.ts`, `uploads.ts` (`ingestBatch` paging), tests | C merged |
| later | 4.13 F13 | own PR | `PasteBox`, `drive-folder.ts`, `index.ts` | none |

Within a PR, workstreams that touch the same files run one after the other in the PR's worktree (00
section 3). Builders follow the 00 section 4 brief and fetch current docs through Context7 before using
ExcelJS, Next.js error boundaries, `router.replace`, or drizzle constraint changes.

## 8. Tests per tier

### 8.1 Fixtures (the three real inputs, replayed with small Test Brand stand-ins)

Under `packages/core/test-fixtures/catalog/intake/`, all created in `test_brand` and with example.com
hosts (served by the tests' fake fetch; never the real `sceimage` host). File names follow the real
style (`BH-4610-NE-NERO_1.JPG`), and in every fixture one of the six products has file names with a
space (`BHSS2620Z-WHITE NAVY_1.JPG` style), as in the real list:

- `intake-xlsx-grid.xlsx` (attempt 1 stand-in): one sheet, a title row above the header, header row
  with 12 columns including `Option Id` at column E, `EAN` at column G, `Image Link 1` to `Image Link 5`
  at columns H to L; 8 data rows for 6 products (two identifiers repeated on a second row, as sizes);
  three products with 4 links and three with 5 (27 links); blank cells elsewhere. Expected: identifier
  column E, photo columns H to L, 6 products, 27 photos, the duplicate-identifier warning with 2, and the
  space-name product with all its shots.
- `intake-pasted-grid.txt` (attempt 2 stand-in): the same 6 products as tab-separated rows without an
  identifier column, three rows of 4 links and three of 5, two trailing `0` cells and one blank cell
  (27 links, 3 ignored cells), one row's links containing a literal space. Expected: shape `links_grid`,
  the readback of 4.2, 6 products, 27 photos, the space-name product with 5 shots.
- `intake-pasted-variants.txt`: 7 rows, 12 links: (1) a 2-column row (URL, URL) with no identifier;
  (2) an `id<TAB>url<TAB>url` row with identifier `TB-B`; (3) a line with two links separated by a
  space; (4) a Dropbox share link (the fake host answers `text/html`); (5) an `http` link; (6) and (7)
  a colliding pair: two rows of 2 links each, no identifier, whose first links share the stem `TB-F`.
  Expected: shape `id_and_links`, the readback of 4.2 with "Rows 6 and 7 would get the same name,
  TB-F."; at collection, row 4 fails as "returned a web page instead of an image" and row 5 as "use http
  instead of https" (both permanent).
- `intake-large-sheet.csv` (attempt 3 stand-in, the Google Sheet as the csv the web tier writes):
  `Unicommerce Code` + 5 link columns, 60 rows, 287 links (the real product count, used here as the link
  count), with identifiers that are the xlsx fixture's identifiers plus `_OD` for the first 6 rows (for
  4.10; this includes the space-name product). Used with a fake fetch that delays 50 ms per link and
  `INGEST_BUDGET_ITEMS` lowered to 40 so the batch takes several deliveries and shows moving counts.
- A builder script `packages/core/test-fixtures/catalog/intake/build.ts` regenerates the xlsx from the
  csv so the two stay in step; the generated files are committed.

### 8.2 Tiers 1 and 2 (`pnpm test`, CI)

Every acceptance item of section 4 is tier 1 or 2 as marked, in the existing test files named there
plus `apps/web/test/catalog-intake-routes.test.ts` (new routes) and `apps/web/test/catalog-intake-ui.test.ts`
(InputList, LinkFailures, UnfinishedBatches, PasteBox waiting state). The spec 04 and 06 suites stay
green; the no-model-names test runs over the new sentences; a new test asserts the removed sentences of
section 6 are absent from `apps/web` and `packages/core` sources (each from the PR that removes it).

### 8.3 Browser test (tier 4-style, local; `apps/web/test/catalog-intake.browser.spec.ts`)

A committed version of the local harness used for the ux report (`apps/web/.playwright/intake-ux-local.test.ts`,
git-ignored): the real wizard bundle, the real route handlers, PGlite, in-memory storage, a fake queue
that runs `runIngest`, a fake image host, Google disabled. Scenarios, each a replay of a real attempt
or of a principle, each landing with the PR named:

1. xlsx (PR A): upload the xlsx fixture, Continue; step 2 within 2 s with the reading sentence; column
   sentence and 6 products once collected (4.1).
2. grid (PR B): paste the grid, "Checking your links..." then the readback of 4.2, Continue, 6 products
   and 27 photos, the space-name product with 5 shots (4.2).
3. grid, all 404 (PR B, extended in PR C): the fake host answers 404; the no-photos sentence names links
   with row and column and no retry button is shown; from PR C, "Fix and continue" reopens step 1 with
   the paste; one link per line pasted; step 2 ready (4.5, 4.8).
4. correction (PR B): paste the grid, clear, paste the variants file; the input list shows one paste and
   the same-name warning for rows 6 and 7; step 2 shows only the second paste's products (4.3).
5. leave and return (PR A form, extended in PR C): paste the large sheet stand-in, Continue; the URL
   carries `?batch=`; the count moves on step 2 within 10 s ("Downloading photos 40 of 287"); reload:
   same step, same count; open the batch from the list and press Continue setting up: the wizard at the
   step. From PR C: navigate to `/catalog`: "Your unfinished batches" with the state words; Continue
   opens step 2; once ready, Continue to step 4, reload, step 4 (4.4, 4.6).
6. crash boundary (PR A): a forced render error on step 2 shows the error page with "Open this batch"
   that returns to the wizard (4.1).
7. phone (PR C): scenarios 2 and 5 at 390 x 844 assert the section and the State column are visible
   without horizontal scroll.

Runs locally and in CI the way the ordering spec runs today: `pnpm --filter @catalog/web exec playwright
test --config test/catalog-intake.config.ts` (a copy of `catalog-wizard-ordering.config.ts` with the
new `testMatch`; the builder adds the CI step next to the ordering one).

### 8.4 Live verification (after each deploy, Test Brand only)

Rules: no load or eval runs while an operator is active. Before each step, the quiet check: no operator
POST in the web request log in the last 60 minutes (`gcloud logging read` on `catalog-web` request
logs, `httpRequest.requestMethod="POST"` by non-owner principals) and no batch in `ingesting` or a
processing status. Every object written lands under `catalog-test/test_brand/<batchId>/`; every
batch made by a step is cleaned at the end with `deleteTestObjects` (allowed under `catalog-test/`)
and, from PR C, cancelled through the UI. Inputs are small (at most 30 photos); the 1,400-photo scale
is not replayed live. Each step checks only what its PR ships.

1. After PR A: upload `intake-xlsx-grid.xlsx` on the deployed wizard; step 2 renders with the reading
   sentence, then the columns; the address bar carries `?batch=`; reload: same step; the leaving line is
   the PR A line; open the batch from the batch list: the page says "created" and carries "Continue
   setting up", which opens the wizard at its step.
2. After PR B: confirm the migrate job applied `0003_intake_states.sql` (decision 1 yes). Paste the
   grid; "Checking your links..." then the readback with the no-product-code-column sentence; Continue;
   6 products, the space-name product with all its shots. Remove the paste and add it again: one
   input. Paste the variants file into a new batch: the readback flags rows 6 and 7; after collection
   the Dropbox line and the `http` link fail with their reason phrases and "Try the failed links again"
   is not shown (both permanent).
3. After PR C: paste the large-sheet stand-in as a real Google Sheet (a sheet shared with
   `catalog-web@`, 60 rows), Continue, close the tab after the first count moves; from the list's "Your
   unfinished batches" press Continue; the count shows phase words and, once measured, the time; finish
   to step 4 without starting; reload tests on steps 2 and 4; back to step 2 and press Continue with no
   change: it returns within 3 s (no re-copy); cancel with the new confirmation. Paste a single `http`
   link into a new batch: it fails before start; "Fix and continue" opens step 1 with the reason.
   Then, after the operator is told: cancel the two BHPC test drafts (574f2025, 09dd86f2) through the UI
   and clean their `catalog-test/` prefixes once with `deleteTestObjects` (proposal section 5).
4. After PR D: an options-only change on step 2 of a ready batch regroups with zero copies (the INFO
   line per delivery shows it); two Test Brand drafts with the same photos show the same-photos warning
   on step 4 with a working link to the other batch; one sweep run cancels no draft younger than
   `DRAFT_EXPIRY_DAYS`.
5. Each step ends with `catalog-test/` cleanup confirmed by an empty listing of the run's prefixes.

## 9. Deploy and rollout order

PR A: merge, deploy web (no worker change). PR B: if decision 1 is yes, the migrate job runs
`0003_intake_states.sql` before the web and worker deploys (deploy.sh already runs the migrate job
first); deploy web and worker. PR C: deploy web and worker (no migration; it uses `cancelled` from PR
B's migration). PR D: deploy worker and web. Each deploy runs the tier 5 smoke inside `infra/deploy.sh`
as always. Rollback per 00 section 6 (`SKIP_BUILD=1` from the previous commit); the migration is
additive (wider CHECK constraints) and needs no down step.

## 10. Report

The 00 section 10 report, plus: the per-fix acceptance results; the browser test video or GIF of
scenarios 2, 3 and 5; the live verification log of 8.4 with the quiet-check timestamps and the cleanup
listing; the contract changes proposed to 02 (the two status values, `BatchCounts` fields, the new
routes); the state of the existing drafts after the cancellations of proposal section 5; the measured
placing rate used by `intakeTimeText` on the live stand-in; the measured `groupBatch` time at about
2,000 fake products (4.7 part 2); and the OPEN decisions still open.

## 11. Assumptions (stated, not asked)

1. The three attempts are representative of operator behaviour even though they come from one person
   on one evening (db, section 5 item 7); the fixes are ordinary resilience and are worth building
   regardless.
2. The sample fetch of three links at paste time (4.2) is acceptable: it is a range GET of 1 KiB
   through `safeFetch` in its truncate mode, the same SSRF-safe path the worker uses, and never a write.
3. The paste box holds one `url_list` row per batch; an operator who wants two lists pastes them
   together. Google links keep one row each.
4. "Failed before Start" means `status = failed` and `startedAt` null; a swept batch (2 hours without
   progress during collection) also qualifies and can be reopened.
5. A cancelled or expired draft keeps its bytes until the existing raw lifecycle. The only deletion is
   the one-off cleanup of the two BHPC test drafts under `catalog-test/` in 8.4.
6. `wizardStepFor` never returns 3: step 3 is reached from step 2 by Continue, which is cheap once
   the grouping is ready; a batch with channels already chosen opens at 4.
7. The placing chunk size, the lease length and the link retry bounds are builder constants proven in
   tier 2 against the 900 s deadline; they are not tuned live.
8. Admins see every operator's unfinished batches; operators see their own; viewers see "Your
   unfinished batches" read-only, with no actions.
9. A server upload row still `pending` that the current browser session is not uploading is treated as
   cut off (closed tab); the operator decides whether to add it again or remove it.

## 12. Owner decisions (OPEN; recorded in `docs/SPEC.md` when closed)

1. One migration (`removed`, `cancelled`) yes or no, shipped in PR B. Recommended yes.
2. `DRAFT_EXPIRY_DAYS`: after how many days the sweep cancels an untouched draft. Recommended 14.
3. BHPC product key (Option Id or Unicommerce Code), asked of the operator once; both test drafts
   cancelled either way.
4. The must set (F1, F2, F3, F4, F5 visible part, F6, F8, F9) and the PR order A, B, C, D.
5. Whether the system tells the operator when a long collection finishes (for example an email to the
   batch's creator), given that no batch was ever started more than 30 minutes after creation. Yes: a
   new should-fix after PR C that adds the product's first outgoing message (sender, creator's address).
   No: the leaving line and "Your unfinished batches" stay the only way back. Recommended yes, after
   PR C.

Interim, until PR A ships (proposal section 7): the owner tells the operator to use the Google Sheet
route and keep the wizard tab open until step 2 shows the grouping.
