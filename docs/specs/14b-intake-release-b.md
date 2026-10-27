# 14b Intake release B: inputs, failures and migration 0003

Catalog module, spec 14, release B of four. Execute with `docs/specs/00-execution-protocol.md`. Parent:
`docs/specs/14-intake-resilience.md`; read its terms, sections 1 to 6 and section 8 before this file.
Source of truth: `docs/SPEC.md`. Depends on release A (`14a-intake-release-a.md`) merged and deployed.
Branch `feat/catalog-14b-intake-inputs`, worktree
`C:\Users\Sujan AH\Desktop\catalog-module-wt\14b-intake-inputs`. Deploys the `catalog-migrate` job
(migration `0003_intake_states.sql`), then `catalog-web` and `catalog-worker`. Approval: approved by
the owner on 2026-10-27, including the migration (parent section 11, decisions 1 and 4). This release
ships as one PR, called PR B in the text below.

## 1. What changes for the operator

- A grid of links pasted from a spreadsheet is understood: each row is a product, links with spaces
  stay whole, `0` and blank cells are ignored, and before anything runs the paste box says back what it
  understood (rows, links, links per row, how products will be named, rows that would get the same name,
  whether the first three links open). Share-page links are explained with the alternative.
- What the batch holds is listed in step 1 with Remove; editing the paste changes it in place instead
  of adding a copy; an upload whose signed link expired can be retried; a file cut off by a closed tab
  says so.
- Failed links are named by row and column with the reason, separately from unreadable files, with
  "Show all"; "Try the failed links again" re-fetches only those, and only appears when some failures
  may be temporary. The no-photos sentence for links gives the real next step.

## 2. Scope

In scope: `ingest/{url-list,links-sheet,detect,detect-step,group,image-check,index}.ts` (link class,
positions), `packages/core/src/safe-url.ts`, `packages/core/src/catalog/types.ts`
(`BatchCounts.linkFailures`, `UPLOAD_STATUSES`, `BATCH_STATUSES`), `packages/core/src/db/schema.ts`,
`packages/core/drizzle/0003_intake_states.sql`, `web/lib/catalog/{links,uploads,batches,preview,copy}.ts`
(`batches.ts`: `reopenBatch`), the new routes under `web/app/api/catalog/batches/[id]/`
(`uploads/[uploadId]` DELETE, `links/[uploadId]` PATCH and DELETE, `retry-links` POST),
`web/components/catalog/{WizardStep1,WizardStep2,WizardStep4,PasteBox,Uploader,BatchBanner,RetryCollectButton}.tsx`,
new `web/components/catalog/{InputList,LinkFailures}.tsx`, the fixtures `intake-pasted-grid.txt` and
`intake-pasted-variants.txt` (parent 8.1), and tests.

Out of scope here: everything the parent lists as out of scope, and every fix or part assigned to
releases A, C and D (parent section 7). Builders fetch current docs through Context7 before using
drizzle constraint changes.

## 3. Fixes

Sentences in quotes are exact (parent section 4).

### 3.1 F2: a pasted grid is understood, with a readback

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
a failure with the reason phrase of F5 (section 3.3) for its status. There is no list of refused hosts.
The sample never blocks the paste; its failures are information. A list whose every sampled link fails
still gets status `uploaded` (the reporting of F5, section 3.3, takes over).

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

Acceptance (tier 1, `url-list.test.ts`): the fixture `intake-pasted-grid.txt` (parent 8.1) gives 6 rows,
27 links, 4 to 5 per row, shape `links_grid`, 3 ignored cells, every identifier null, names
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

### 3.2 F3: inputs can be corrected without duplicates

- The paste box binds to one `url_list` upload row per batch. `POST /links` with `url_list` text
  updates the batch's existing `url_list` row (if any) instead of inserting by `sourceUrl`; Google
  lines keep one row per link as today. `PATCH /links/[uploadId]` `{text}` replaces; `DELETE
  /links/[uploadId]` and `DELETE /uploads/[uploadId]` remove (draft only; `assertDraft`).
- "Remove" semantics (decision 1, decided yes): with the migration (shipped in this PR, section 4.1),
  the row gets status `removed` and is ignored by `ingestBatch`, `finishIfLast`, `buildDetectedStep2`,
  `buildPreview` and the counts; its object under `uploads/` is left for the lifecycle. (Hard-deleting
  the row and its object was the no-migration alternative; it was rejected and is not built.)
- Removing or changing an input sets `counts.previewReady = false` (a merge, as F6 in 14c section 3.2
  specifies for web-tier counts writes) and, when the batch is `ingesting`, is refused with the
  collecting sentence of F8 (14c section 3.4; until release C ships, the existing refusal).
- `Uploader` Retry: when `row.plan` is older than `SIGNED_PUT_TTL_SEC` (900 s, 02) it plans again
  before the PUT. A failed row has Remove. Continue is disabled only by rows the operator can act on.
- New `InputList.tsx` under step 1 lists every upload of the batch from the server (`GET batch`
  already returns uploads) with kind word, name, size, state word and Remove; it is the same list the
  resumed wizard shows (F4 part 1, 14a section 3.4). A server row still `pending` that this browser
  session is not uploading (not among `Uploader`'s in-memory rows), for example because the tab was
  closed mid-upload, shows "Upload did not finish. Add the file again or remove it." with Remove.
  `wizardStepFor` opens step 1 for such a batch (14a section 3.4).
- Copy: Remove button "Remove"; confirmation none (a removed input can be added again). State words:
  "Uploading <p>%", "Uploaded", "Checked", "Upload failed. Try again or remove it.", "Upload did not
  finish. Add the file again or remove it.", "Removed".
- Acceptance (tier 2, `catalog-wizard-routes.test.ts`): paste A (3 links), then PATCH with text B (2
  links): one `url_list` row, 2 links, preview invalidated; DELETE an upload: the row is `removed` and
  `ingestBatch` ignores it; a batch with one removed and one uploaded row collects the uploaded one only;
  `catalog-uploader-ui.test.ts`: a failed row older than the TTL re-plans on Retry (the fake records a
  second `/uploads` POST); `catalog-intake-ui.test.ts`: a `pending` server row with no matching in-memory
  row shows the did-not-finish sentence and Remove; browser test (scenario 4, section 6): paste the grid,
  clear the box, paste one link per line, Continue; step 2 shows the second paste's products only.

### 3.3 F5 part 1: link failures are named and classified (must)

Part 2 of F5 (automatic retry) is in 14d section 3.2.

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
  failed-before-start batch it first performs the reopen of F8 (14c section 3.4; `reopenBatch` in
  `batches.ts`, written in this PR and exposed as `POST /reopen` in PR C). It then drops the link reject
  results from the manifests of the batch's non-removed uploads so those items count as unread, sets
  those uploads back to `uploaded` (as `regroupBatch` does, `web/lib/catalog/uploads.ts:96`) and calls
  `ingestBatch`. Refused for an `ingesting` batch (the collecting sentence of F8, 14c section 3.4; until
  release C ships, the existing refusal) and for a started one.
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
  - Batch page banner for a failed links batch: the sentence above with "Fix and continue" (F8, 14c
    section 3.4, from PR C) and, only when some may be temporary, "Try the failed links again".
- Acceptance (part 1): tier 2 `ingest.test.ts`: the grid fixture with every link 404 fails with the
  exact all-permanent no-photos sentence, `linkFailures` 27, `unsupportedFiles` 0; with some links 503
  the some-temporary sentence; `detect-step.test.ts`: the `linkFailures` block (with `temporary`) from
  the manifest; `group.test.ts`: both step 4 pairs; routes: `POST /retry-links` on a draft re-fetches
  only rejects (fake fetch count equals the reject count); `POST /retry-links` on a failed-before-start
  links batch reopens it (reason cleared), re-fetches only the rejects and ends `draft` ready when the
  host now answers; on a started batch 409; UI: the retry button is absent when every failure is
  permanent.

## 4. Data and state changes

### 4.1 Migration `0003_intake_states.sql` (decided)

The owner approved the migration on 2026-10-27 (parent section 11, decision 1). It drops and recreates
the two CHECK constraints with the new values: upload status `removed` on `catalog_uploads.status`
(`schema.ts:275,283`) and batch status `cancelled` on `catalog_batches.status` (`schema.ts:237,256`),
together with `UPLOAD_STATUSES` and `BATCH_STATUSES` in `schema.ts`. It ships in this release because
this release is the first to use `removed`; release C uses `cancelled` from it. The migration is
additive (wider CHECK constraints) and needs no down step. Precedent: `0002_cost_events.sql` (PR #90).
Migration flag (00 section 11): only specs 02 and 03 ship migrations, and a contract change to 02 is
proposed in the report, never made silently; this release lists the two status values as a 02
contract change in its report, approved in advance by decision 1.

### 4.2 Other rows

Rows of the parent data table (section 5) implemented here: `counts.linkFailures`;
`detected.linksPerRow`, `shape`, `collisions`, `sample`; `SafeFetchOptions.headers` and `truncateAt`;
the new routes `DELETE uploads/[uploadId]`, `PATCH|DELETE links/[uploadId]` and `POST retry-links`; the
two status values above. No new env var.

## 5. Copy

Exact sentences are in the fixes above and in the parent copy register (section 6), rows marked "B":
Paste waiting; Paste readback; Paste naming; Paste sample; Paste share pages; Paste same name; Paste
ignored cells; Input list; Link failures card (without the release D sentence); Reason phrases; Step 4
link pair; No photos, links (the PR B ending and the some-temporary ending); Batch page "Try the failed
links again". Sentences removed by this release: "N image links" for a grid and "<n> other files" for
links.

## 6. Acceptance tests

- Tiers 1 and 2 (`pnpm test`, CI): every "Acceptance" item in section 3, in the test files named
  there, plus `apps/web/test/catalog-intake-routes.test.ts` (the new routes) and
  `apps/web/test/catalog-intake-ui.test.ts` (InputList, LinkFailures, PasteBox waiting state), and the
  general rules of parent 8.2. A migration test applies `0003_intake_states.sql` on PGlite over a
  database at `0002` and asserts that `removed` and `cancelled` are accepted and an unknown status is
  still refused.
- Browser test (parent 8.3 harness), scenarios landing with this release:
  2. grid: paste the grid, "Checking your links..." then the readback of F2, Continue, 6 products and
     27 photos, the space-name product with 5 shots (F2).
  3. grid, all 404, release B form: the fake host answers 404; the no-photos sentence names links with
     row and column and no retry button is shown (F5). The release C extension is in 14c.
  4. correction: paste the grid, clear, paste the variants file; the input list shows one paste and the
     same-name warning for rows 6 and 7; step 2 shows only the second paste's products (F3).
- Tier 3 and tier 4: not required. Tier 5: runs inside `infra/deploy.sh` as always.

## 7. Fixtures

From parent 8.1, created by this release: `intake-pasted-grid.txt` and `intake-pasted-variants.txt`.
Also used: `intake-xlsx-grid.xlsx` and `intake-large-sheet.csv` from release A (F2 tier 2).

## 8. Local verification

From the feature worktree:
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`, then
`pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts` (scenarios 1
to 6 green, with 3 in its release B form).

## 9. Live verification (after deploy, Test Brand only)

Step 0: the quiet check and the rules of parent 8.4.

1. Confirm the migrate job applied `0003_intake_states.sql`. Paste the grid; "Checking your links..."
   then the readback with the no-product-code-column sentence; Continue; 6 products, the space-name
   product with all its shots. Remove the paste and add it again: one input. Paste the variants file
   into a new batch: the readback flags rows 6 and 7; after collection the Dropbox line and the `http`
   link fail with their reason phrases and "Try the failed links again" is not shown (both permanent).
2. Clean the run's batch objects with `deleteTestObjects` and confirm an empty listing of the run's
   prefixes.

## 10. Rollout and rollback

Merge, then `infra/deploy.sh`: it runs the migrate job with `0003_intake_states.sql` first, then deploys
web and worker; the tier 5 smoke runs inside deploy.sh as always. Rollback per 00 section 6
(`SKIP_BUILD=1` from the previous commit); the migration is additive and stays in place (the previous
code never writes the new values).

## 11. Report

The 00 section 10 report, plus: the per-fix acceptance results; the browser test video or GIF of
scenarios 2 and 3; the live verification log of section 9 with the quiet-check timestamp and the
cleanup listing; the contract changes proposed to 02 (the two status values, `BatchCounts.linkFailures`,
the new routes). Last line: "Ready for the next spec: 14c Intake release C".

## 12. Done when

- [ ] F2, F3 and F5 part 1 are built and every acceptance item in section 3 passes in CI.
- [ ] `0003_intake_states.sql` and `schema.ts` ship together; the migration test passes.
- [ ] Browser scenarios 2, 3 (release B form) and 4 pass locally and in CI; 1, 5 and 6 still pass.
- [ ] The removed sentences of section 5 are absent from `apps/web` and `packages/core` sources.
- [ ] PR B merged; migrate job, `catalog-web` and `catalog-worker` deployed; tier 5 smoke green.
- [ ] Live verification of section 9 done with the quiet check logged and `catalog-test/` cleanup
      confirmed.
- [ ] Report written.
