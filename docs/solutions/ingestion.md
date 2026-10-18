# Ingestion - learnings

Spec 04, built and tested 2026-10-18. Code: `packages/core/src/catalog/ingest/`,
`apps/worker/src/catalog/ingest.ts`, `apps/worker/src/catalog-local.ts`.

## unzipper stalled on GCS range streams
Symptom: the tier 3 Anta zip (630 entries) read only 193 entries in 600 s, then failed with
`FetchError: ... Images.zip?alt=media failed, reason: socket hang up` (`ECONNRESET`).

Cause: `unzipper` `Open.custom` asks the source for range streams lazily, stops reading them part-way
and attaches no error listener. The GCS responses were left half read, which blocked the parallel
entry reads; destroying them mid-response broke the kept-alive sockets as well.

Fix (`zip.ts`, `gcsZipSource`): read each requested range to its end at once and hand unzipper a
stream over those bytes; errors on the range stream fail the open or the entry instead of going
uncaught. unzipper also calls `stream(offset)` with no length, which means "to the last byte".
Afterwards 8 parallel entry reads took 0.9 s and the whole Anta zip about 170 s.

## unzipper requires @aws-sdk/client-s3
The worker bundle (esbuild) failed to resolve `@aws-sdk/client-s3`, which unzipper requires only
inside `Open.s3_v3`. It is marked external in `apps/worker/build.mjs`; we never call that method, so
the package is not installed.

## uploadPath drops the folder separators
02's `uploadPath(prefix, uploadId, fileName)` runs `sanitizeSegment` over the whole name, so a
relative path `Rectangle/ABC_1.jpg` would land as `RectangleABC_1.jpg`. That breaks the folder
identifier mode, numeric stems (`ABC/1.jpg`) and the Rectangle/Square suffixes. Ingestion sanitises
each path segment instead (`uploadObjectPath` in `local-files.ts`); for a file with no folder the
result equals `uploadPath`. Proposed for 02: make `uploadPath` sanitise per segment so there is one
helper. Side effect today: folder names come back sanitised (spaces become `_`); `normalizeKey` is
unaffected.

## Production fetches must use the DNS-pinned fetch
`safeFetch` uses its DNS-pinned fetch only when no `fetch` is passed. The worker first passed
`globalThis.fetch` as `IngestDeps.fetch`, which reached `safeFetch` as `opts.fetch` and skipped the
pinning (a host whose address turns private between the check and the connect would have been
fetched). `pinnedFetch` is now exported from `safe-url.ts`, and `workerIngestDeps()` and
`localIngestDeps()` pass it; tests assert that.

## PGlite start-up timed out under parallel tests
With one vitest worker per CPU (14 on the dev laptop) every test file boots its own PGlite, and under
load the 30 s hook timeout was hit in a dozen files that had nothing to do with the change.
`vitest.config.ts` now sets `maxWorkers: 4` (the size of a GitHub runner). If timeouts come back,
check CPU load from other processes first.

## Vitest hides test logs under an agent
Vitest 5 switches to a minimal reporter when it detects an AI agent, which hides the `stdout` of
passing tests, including the tier 3 counts and the `deleted <n> objects under ...` cleanup lines. Run
tier 3 with `pnpm test:real --reporter=default --silent=false` to keep them.

## Long tier 3 runs die with the session
The French Connection case (3,280 images, two batches) takes about 25 minutes. A background run is
stopped when the agent session ends, possibly between the two cleanups in `finally`. After an
interrupted run, list `gs://image-links-agent-assets/catalog-test/` and remove only the run's own
`catalog-test/<brand>/<batchId>/` prefixes before re-running.

## Open: can catalog-worker@ read what was shared with catalog-web@?
Not answered yet. Operators share Google Sheets and Drive folders with
`catalog-web@image-links-agent.iam.gserviceaccount.com` only, so the web tier collects Google sources
(`collectGoogleSheetOnWeb`, `collectDriveFolderOnWeb`) and the worker reads the copies in our bucket.
To answer it: a person creates a Google Sheet from one delivery xlsx, shares it with `catalog-web@` as
Viewer, and runs tier 3 with `REAL_GSHEET_URL=<sheet url>`, `REAL_GSHEET_XLSX=<the xlsx>` and
`REAL_WORKER_ADC=<ADC file from gcloud auth application-default login
--impersonate-service-account=catalog-worker@image-links-agent.iam.gserviceaccount.com>`. If the
worker can read it (for example through a shared drive or a Google group holding both addresses), a
later spec moves the collection to the worker and the web tier keeps only the access check.
