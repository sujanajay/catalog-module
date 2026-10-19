# 06 Pipeline and UI

Catalog module, spec 06 of 09. Execute with `docs/specs/00-execution-protocol.md`. Source of
truth: `docs/SPEC.md`. Depends on 02 (types, naming, storage, tasks, schema, sheet writers, sweeper,
sync), 03 (sign-in, roles, `requireRole`, the Playwright login helper), 04 (ingest adapters,
`/tasks/catalog/ingest`, `detected`, preview rows) and 05 (`render.ts`, `compliance.ts`,
`MattingClient`, `catalog-matting`). Visual contract: `01-ui-prototype.md` v2. Its screens, states,
button labels and copy are reproduced below where they matter; when in doubt, 01 is the record of
the approved wording, and `CONTRACTS.md` names win over any older draft.

Contracts from earlier specs used here and not redefined:
- Defined in 02: `CHANNEL_IDS`, `BATCH_STATUSES`, `OUTPUT_STATUSES`, `CHANGE_KINDS`,
  `EVENT_KINDS`, `OUTPUT_FLAGS`, `DECISIONS`, `BatchOptions`, `BatchCounts`, `BatchCost`,
  `ResolvedPolicy`, `CHANNEL_ORDER`, `CHANNEL_RULES_VERSION`, `STYLI_SKIP_LOW_RESOLUTION`,
  `STYLI_MIN_SOURCE_HEIGHT_PX`; `parseShotName`, `sanitizeSegment`, `normalizeKey`, `rootPrefix`,
  `batchPrefix`, `productPrefix`, `shotStem`, `uploadPath`, `rawPath`, `derivedPath`,
  `stagingPath`, `exportPath`, `brandExportPath`, `publicObjectPath`, `publicUrl`,
  `assertWithinProduct`, `assertTestPrefix`, `TEST_PREFIX`; `getPublicBucketName`, `signedPutUrl`,
  `signedUrl`, `headObject`, `listObjects`, `stageCopyToPublic`, `deletePublicObject`,
  `setCustomTime`, `deleteTestObjects`, `uploadBuffer`, `downloadBuffer`, `PUBLIC_CACHE_CONTROL`;
  `enqueueTask`, `TaskRoute`; `sheetColumns`, `writeLinksXlsx`, `writeLinksCsv`,
  `fillProductListWorkbook`, `compareXlsxCsv`; `flagReason`; `resolveSkus`; `recordCost`,
  `checkCaps`; the storage retry rule (every write, copy, delete and verify GET retries on 429, 5xx
  and network errors up to 3 times with exponential backoff, 1 s, 2 s, 4 s, builder constants); the
  tables in CONTRACTS section 10; the routes `/tasks/catalog/sync-master` and
  `/tasks/catalog/sweep`; `/health`.
- Defined in 03: `currentUser`, `requireRole`, `ForbiddenError` and its sentence "You can view
  this but not change it. Ask an admin for the operator role."; `ROLES`; the People modal;
  `apps/web/test/human/login.ts` and `.playwright/auth-state.json`.
- Defined in 04: `runIngest`, `handleIngestTask`, `planSignedUploads`, `completeUploads`,
  `detectUploadKind`, `detectPastedText`, `checkLinkAccess`, `readSheetTable`, `detectColumns`,
  `previewRows` (with `PreviewRow.files`), `DetectedStep2` (with `sheets[]` and `groupedBy`),
  `catalog_uploads.detected`, the alias matching at ingest, the shot position rule, the overwrite
  preview data.
- Defined in 05: `prepare` (which converts HEIC and HEIF through `MattingClient.convert` before
  decoding), `planProduct`, `renderAllChannels`, `checkOutput`, `MattingClient`, `matteFor`, the
  per-model send size from `/health`, the breaker and the flood-fill fallback, `MATTING_URL` and
  `MATTING_GPU_URL`, `catalog-local`.

## 1. Goal

After this spec an operator can open the deployed app, sign in with Google, create a batch for any
brand from the four-step wizard, start it, watch it run, and download a links sheet whose every
link is live, compliant and resolves to the recorded object generation. A product's links stay the
same for life: a later batch for the same product replaces the pictures behind its links in place,
removes the photos the new upload no longer has, and says so in the sheet. The worker runs the
whole pipeline in parallel chunks on Cloud Tasks, publishes product by product, resumes after any
crash without redoing finished work, and nothing fails silently. All three services (`catalog-web`,
`catalog-worker`, `catalog-matting`) are deployed by `infra/deploy.sh`.

## 2. Scope

In scope
- Worker routes `/tasks/catalog/chunk`, `/tasks/catalog/publish` and `/tasks/catalog/finalize`,
  added to the route table in `apps/worker/src/server.ts` (same OIDC and `HandleResult` contract
  as 02). `/tasks/catalog/ingest` (04), `/tasks/catalog/sync-master` and `/tasks/catalog/sweep`
  (02) already exist.
- Chunk planning: whole products, about `CATALOG_CHUNK_IMAGES` (25) source images per chunk.
  Stages `matte` -> `render` (07 adds `qa` between `render` and publish). Rendering goes to the
  private `staging/` prefix, never straight to the public bucket.
- Publish per product: the stage, verify, swap, delete sequence of section 5.5, with product
  locks, `render_key` skips, scoped deletes, events and the `change` column.
- Finalize: links sheet (xlsx and csv) with the `change` and `changed_at` tail columns, the
  filled product-list workbook when a product list was uploaded, the xlsx-versus-csv comparison,
  the independent re-check of the sheet just written (the re-check library
  `packages/core/src/catalog/recheck/` is built here; 09 adds its CLI and sheet-level modes),
  `report-v<k>.json` with `summary`, `overwrites`, `notRefreshedChannels`, `removedLinks`,
  `recheck` and `exports`, counts, cost.
- Web: `/catalog` list; `/catalog/new` four-step wizard ("Brand and files", "Check what we found",
  "Where will these images go?", "Start"); `/catalog/[id]` batch page with tabs Overview, Needs
  attention (shell), Links sheet, Details; product page `/catalog/products/[brand]/[key]`; brand
  page `/catalog/brands/[slug]`; downloads; direct-to-GCS uploads; Google Sheet and Drive link
  wiring through the 04 adapters. Every page and API route states its required role.
- Infra: `infra/deploy.sh` deploys all three services; the worker env vars of section 4.5; the
  smoke gate.
- Tests: tiers 1 to 5 (CONTRACTS section 15) as listed in section 9, including the Playwright run
  on the deployed URL and the per-brand smoke that runs every product twice.

Out of scope (later specs)
- QA judge, product-type classifier, decisions ("Use as is", "Remove this photo", "Replace photo
  N"), "Add SKU ids", eval labels, the INR cost line (07). This spec ships the attention tab as a
  shell: the tab, its product count and the product cards listing compliance and render problems,
  with the three buttons rendered disabled and the tooltip "Available after the quality-check
  update". Until 07, a product with a problem photo keeps its previous live images (or has none)
  and shows `pending_attention` in the sheet.
- Model policy rows and the bake-off (08). Until 07 ships `resolvePolicy`, the worker uses the
  `default` model reported by `catalog-matting` `/health` and stores it in
  `catalog_batches.options.policy` with `source = "default"` (section 5.2).
- Load test, tuning, hand-over docs (09).

Rules that apply throughout: never crop; nothing added where the channel sheet is silent; Supabase
is only ever read; no GCP deletes; test cleanup only under `catalog-test/`; the operator never sees
a model name; the worker writes and deletes public objects only under the prefix of a product its
batch holds the lock for, and only on the channels of that batch.

## 3. Files

Add
- `packages/core/src/catalog/pipeline/plan-chunks.ts` `planChunks` (pure).
- `packages/core/src/catalog/pipeline/status.ts` `deriveBatchState` and progress text (pure).
- `packages/core/src/catalog/pipeline/verify.ts` `verifyPublic` (injectable fetch).
- `packages/core/src/catalog/pipeline/publish.ts` `renderKey`, `lockProducts`, `releaseLocks`,
  `planPublish`, `publishProduct` (DB and storage through the deps bag).
- `packages/core/src/catalog/pipeline/report.ts` `buildReport`, `notRefreshedChannels`.
- `packages/core/src/catalog/recheck/index.ts` `recheckSheet(xlsx: Buffer, { fetch, concurrency })
  -> { ok, total, failures: [{ url, reason }] }`: a fresh reader, plain GETs, no DB; checks each link
  cell is a hyperlink whose `hyperlink` equals its `text`, the URL path ends in `.jpg`, every URL is
  unique, one row per identifier, and each GET returns 200, `image/jpeg`, `FF D8 FF`; bounded
  concurrency (default 16, builder constant). 09 adds the CLI, `--batch`, `--csv` and `--sample`.
- `packages/core/src/catalog/test-cleanup.ts` prefix-checked cleanup for test batches.
- `packages/core/src/catalog/pipeline/*.test.ts`.
- `apps/worker/src/catalog/chunk.ts`, `publish.ts`, `finalize.ts` handlers (`ingest.ts` exists
  from 04, `sync-master.ts` and `sweep.ts` from 02).
- `apps/worker/src/catalog/deps.ts` dependency bag: db, storage, `MattingClient`, tasks, fetch,
  now, log, `resolvePolicy` (placeholder here, replaced by 07).
- `apps/worker/src/catalog/*.test.ts` PGlite integration tests.
- `apps/web/app/catalog/page.tsx` batch list.
- `apps/web/app/catalog/new/page.tsx` wizard; `apps/web/components/catalog/WizardStep1.tsx`,
  `WizardStep2.tsx`, `WizardStep3.tsx`, `WizardStep4.tsx`, `Uploader.tsx`, `PasteBox.tsx`,
  `ShareBox.tsx`, `ChannelPicker.tsx`, `GroupingPreview.tsx`, `OverwritePreview.tsx`.
- `apps/web/app/catalog/[id]/page.tsx` batch page; `apps/web/components/catalog/BatchBanner.tsx`,
  `BatchKpis.tsx`, `BatchTabs.tsx`, `AttentionList.tsx` (shell), `AttentionProductCard.tsx`
  (shell), `SheetPreview.tsx`, `DetailsTab.tsx`, `NotRefreshedLine.tsx`.
- `apps/web/app/catalog/products/[brand]/[key]/page.tsx` product page;
  `apps/web/components/catalog/ProductImages.tsx`, `ProductEvents.tsx`, `AddAliasForm.tsx`,
  `RemoveProductDialog.tsx`.
- `apps/web/app/catalog/brands/[slug]/page.tsx` brand page; `apps/web/components/catalog/ProductSearch.tsx`.
- `apps/web/lib/catalog/batches.ts`, `uploads.ts`, `preview.ts`, `exports.ts`, `links.ts`,
  `products.ts`, `brands.ts`.
- `apps/web/app/api/catalog/...` routes listed in section 4.4 (those marked 07 are not added here).
- `apps/web/test/human/catalog.human.spec.ts` (Playwright; the login helper is 03's).
- `apps/web/playwright.config.ts`.
- `apps/worker/src/catalog-smoke.ts` per-brand smoke (tier 5), an esbuild entry like
  `catalog-local`; root `package.json` script `catalog:smoke` runs `node apps/worker/dist/catalog-smoke.js`.
- `docs/solutions/catalog-pipeline.md` only if something non-obvious happened.

Change
- `apps/worker/src/index.ts`: register `chunk`, `publish` and `finalize` in the route table; wire
  catalog deps; `/health` lists `routes`.
- `apps/web/app/page.tsx`: redirect to `/catalog`. `apps/web/app/layout.tsx`: nav "Opptra" logo,
  "Catalog images", user button "<email> · <Role> ▾" (03).
- `infra/deploy.sh`: section 7.
- `README.md`: one paragraph pointing to the catalog section that 09 completes.
- `.gitignore`: `.playwright/`.

Do not touch: `packages/core/src/catalog/channels.ts`, `naming.ts`, `render.ts`, `compliance.ts`,
`matte.ts`, the ingest adapters, `schema.ts` and the migrations, `server.ts` (other than
registering routes through its table), `services/matting/`, `cloudbuild.yaml`, `bootstrap.sh`,
`apps/web/lib/iap.ts`, `lib/auth-rules.ts`, `lib/user.ts`. If a column or helper turns out to be missing,
the manager stops and reports it as a contract change (00); nothing is added silently.

## 4. Contracts

### 4.1 Storage paths (all produced by 02's `naming.ts`; restated for orientation)

`prefix = batchPrefix(brandSlug, batchId, isTest)` = `catalog/<brand>/<batchId>` or
`catalog-test/<brand>/<batchId>` for test batches (section 4.7).

Private bucket `image-links-agent-assets` (env `BUCKET`), batch-scoped because everything in it is
history or scratch:
- `<prefix>/uploads/<uploadId>/<sanitised name>` browser PUTs (`uploadPath`, 180 days).
- `<prefix>/raw/<pathKey>/<pathKey>_<n>.<ext>` canonical copy of each source (`rawPath`); current
  raw has no `customTime` and is never removed; a superseded raw gets `customTime` and goes after
  180 days.
- `<prefix>/derived/<pathKey>/<pathKey>_<n>.matte.png` matte cache (`derivedPath`, 180 days).
- `<prefix>/staging/<pathKey>/<channel>/<pathKey>_<n>.jpg` rendered, not yet public
  (`stagingPath`, 30 days; the worker never deletes staging).
- `<prefix>/exports/links-v<k>.xlsx|csv`, `report-v<k>.json` (`exportPath`, kept).
- `<root>/<brand>/exports/links-<yyyymmdd-hhmmss>.xlsx|csv` brand sheets on demand (`brandExportPath`, kept).

Public bucket `image-links-agent-public` (env `PUBLIC_BUCKET`), product-scoped:
- `publicObjectPath(brandSlug, pathKey, channel, n, isTest)` =
  `<root>/<brand>/<pathKey>/<channel>/<pathKey>_<n>.jpg`; URL from `publicUrl`. Example:
  `https://storage.googleapis.com/image-links-agent-public/catalog/uspa/ABC123/noon/ABC123_2.jpg`.
- No batch id, no version suffix, no SKU id in any public path. `path_key` is fixed when the
  product row is created; `identifier` (verbatim) is what the sheet shows.
- Objects are written only by `stageCopyToPublic` with `ifGenerationMatch` (section 5.5) and
  carry `Cache-Control: public, max-age=300`. Bucket versioning keeps previous generations 30 days,
  at most three per path (02 lifecycle).

### 4.2 Tables and JSON shapes used (CONTRACTS section 10; no migration ships here)

This spec reads and writes `catalog_batches`, `catalog_uploads`, `catalog_products`,
`catalog_batch_products`, `catalog_product_aliases`, `catalog_product_events`,
`catalog_source_images`, `catalog_chunks`, `catalog_outputs` and `spend_days`.
- `catalog_batches.options` (`BatchOptions`): `identifierMode`, `precedence`, `sheetColumns` are
  set by the wizard (04 `detected` defaults); `policy` is set once by the worker (5.2).
- `catalog_batches.counts` (`BatchCounts`), written here: `products`, `sources`, `outputs`,
  `verified`, `needsAttention`, `attentionProducts`, `failed`, `skipped`, `unchanged`,
  `skuResolved`, `missingImages`, `notInSheet`, `unsupportedFiles`, `duplicateFiles`, `collected`,
  `collectTotal`, `previewReady`, `latestExport`, `failReason`, `finalizePending`,
  `policyFallback`, `newProducts`, `existingProducts`, `shotsToRemove`, `recheckOk`, `recheckTotal`.
- `catalog_batches.cost` (`BatchCost`), written here: `computeVcpuSeconds`, `mattingMs`,
  `renderMs`, `computeUsd`; 07 writes `qaUsd`, `qaCalls`, `identifiers`, `usdPerIdentifier`,
  `inrPerIdentifier`.
- `catalog_batches.status` moves `draft` -> `ingesting` -> `draft` (04) -> `matting` ->
  `rendering` -> (`qa`, 07) -> `publishing` -> `done`; `failed` only for a batch that could not
  start or was swept.
- `catalog_products.lock_batch_id`, `last_batch_id`, `path_key`, `identifier`, `opptra_sku_ids`.
- `catalog_batch_products.change` (`CHANGE_KINDS`), `link_status`, `flags`, `notes`.
- `catalog_source_images`: one row per (product, n, version); `is_current`, `sha256`,
  `superseded_at`, `replaces_id`; `batch_id` means "brought by".
- `catalog_outputs`: one row per (source version, channel) created in this batch; `render_key`,
  `staging_uri`, `object_path`, `public_url`, `generation`, `crc32c`, `is_live`, `status`,
  `flags`, `reason`, `decision`, `published_at`, `published_by`, `superseded_at`,
  `superseded_by_output_id`, `attempt`. Exactly one live row per (product, channel, n).
- `catalog_chunks.stage` runs `matte` then `render` here (07 adds `qa`); `status`
  `queued|running|done|failed`; `index` is the chunk's position; `attempt` counts deliveries.

### 4.3 Worker routes

All `POST`, JSON body, OIDC bearer for `WORKER_SA_EMAIL` with audience `WORKER_URL`, through 02's
`authorize()`. Response `{ outcome }` with `HandleResult.httpStatus`: 200 done (success or a
terminal failure recorded in the DB), 503 retry later, 500 unexpected. The retry count comes from
`x-cloudtasks-taskretrycount`.

| Route | Body | Behaviour |
|---|---|---|
| `/tasks/catalog/ingest` (04) | `{batchId, uploadId, cursor?}` | 04's `handleIngestTask`. Unchanged. The web `/ingest` route enqueues it once per upload. |
| `/tasks/catalog/chunk` (new) | `{chunkId}` | Runs the chunk's current stage (5.3). Re-enqueues itself for the next stage. After its last stage it enqueues `/tasks/catalog/publish` for each of its products; the last chunk of the batch to finish also sets status `publishing` and enqueues finalize. |
| `/tasks/catalog/publish` (new) | `{batchId, productId}` | Publishes one product (5.5): gate, swap, verify, scoped delete, events, `change`. Idempotent; 200 with outcome `held` when the gate is closed. Enqueues finalize when it changed anything. |
| `/tasks/catalog/finalize` (new) | `{batchId}` | When every chunk is terminal and every product of the batch has a `change`: writes exports and the report, final counts, status `done`, releases locks (5.6). Otherwise 200 with outcome `not_ready` and re-enqueues itself with `delaySec: 30`. |
| `/tasks/catalog/sync-master` (02) | `{}` | Unchanged. |
| `/tasks/catalog/sweep` (02) | `{}` | Unchanged; section 5.8 says what this spec must write so the sweeper can see progress. |

Enqueue through 02's `enqueueTask(route, body, { delaySec?, taskId? })` on queue `TASKS_QUEUE`
(default `catalog`, 20 concurrent dispatches, 5 attempts, 10 s minimum backoff). Task ids for
deduplication: chunk tasks `chunk-<chunkId>-<stage>`; publish tasks
`publish-<batchId>-<productId>-<trigger>` where `trigger` is `chunk`, or the decision or
replacement id in 07; finalize has no task id and is guarded by `counts.finalizePending` (set when
enqueued, cleared when it runs). `TASKS_INLINE=1` posts straight to `WORKER_URL` for local dev.

### 4.4 Web API routes (role per row; pages and routes call `requireRole` from 03)

A viewer can open every page and every `GET` below. Action buttons are absent for a viewer and the
action routes answer 403 with the 03 sentence. Routes marked "07" are added by spec 07.

| Route | Role | Body or query | Returns or does |
|---|---|---|---|
| `GET /catalog` | viewer | | batch list page |
| `GET /catalog/new` | operator | | wizard page |
| `GET /catalog/[id]` | viewer | | batch page |
| `GET /catalog/brands/[slug]` | viewer | | brand page |
| `GET /catalog/products/[brand]/[key]` | viewer | | product page |
| `POST /api/catalog/batches` | operator | `{brandSlug, name?, productType}` | `{id}`; status `draft`; `brand_name` from `brand_master`; `is_test` when the name starts with `catalog-test`; `created_by` = the signed-in email |
| `GET /api/catalog/batches` | viewer | | list rows |
| `GET /api/catalog/batches/[id]` | viewer | | batch, counts, cost, derived state (5.7), uploads, `notRefreshedChannels` |
| `PATCH /api/catalog/batches/[id]` | operator | `{name?, channels?, options?}` | only while `draft` |
| `POST /api/catalog/batches/[id]/uploads` | operator | `{files: [{name, size, mime, relativePath}]}` | `[{uploadId, putUrl, headers}]` through 04's `planSignedUploads` |
| `POST /api/catalog/batches/[id]/uploads/[uploadId]/complete` | operator | | marks `uploaded` after `headObject` confirms size |
| `POST /api/catalog/batches/[id]/links` | operator | `{text}` | 04's `detectPastedText` and `checkLinkAccess`; `{kind, access: ok\|no_access\|blocked, summary}`; stores a `catalog_uploads` row |
| `POST /api/catalog/batches/[id]/ingest` | operator | | enqueues ingest per `uploaded` upload; status `ingesting`; re-callable after a "Check what we found" change |
| `GET /api/catalog/batches/[id]/detected` | operator | | step 2 data from 04's `DetectedStep2`: identifier mode, precedence, formats, `sheets[]` (identifier column, image columns, kind, `cannotRead`), Google access, `groupedBy` |
| `PATCH /api/catalog/batches/[id]/detected` | operator | `{identifierMode?, precedence?, sheets?: [{uploadId, identifierColumn, imageColumns, kind}]}` | saves the step 2 controls into `options` and `catalog_uploads.detected`, then re-runs grouping from `raw/` (no re-download); `previewReady` false until it finishes |
| `GET /api/catalog/batches/[id]/preview` | operator | | step 4 data: `{ready, previewAt, groupedBy, counts, warnings[], estimate: {inr, images, qaChecks} \| null, groups[] (first 50, signed thumbnails, files: [{n, originalName, width, height}]), overwrite: {newProducts, existingProducts: [{identifier, liveShots, uploadShots, shotsToRemove[]}], renameHints[], sameProductPairs[]}, busy: [{identifier, batchName}], collected, collectTotal}` |
| `POST /api/catalog/batches/[id]/start` | operator | `{previewAt}` | 5.2; status `matting`; toast text comes from the page |
| `GET /api/catalog/batches/[id]/export?format=xlsx\|csv\|report\|filled` | viewer | | 302 to a signed URL (7 days) of the latest export; `filled` is the filled product-list workbook (404 with "No product list was uploaded in this batch." when none) |
| `GET /api/catalog/batches/[id]/attention` | viewer | | `AttentionProduct[]` (4.8), read-only here |
| `POST /api/catalog/outputs/[id]/decision` | operator | 07 | |
| `POST /api/catalog/outputs/[id]/replacement`, `.../replacement/complete` | operator | 07 | |
| `POST /api/catalog/batches/[id]/sku-map` | operator | 07 | |
| `GET`, `POST /api/catalog/batches/[id]/eval-labels` | operator | 07 | |
| `GET /api/catalog/brands/[slug]/products?q=` | viewer | | product search: identifier, aliases, SKU ids, live channels, last batch |
| `POST /api/catalog/brands/[slug]/export` | operator | `{productIds: string[]}` | brand sheet for the selected products, every live channel, written to `brandExportPath`; `{url}` signed |
| `POST /api/catalog/products/[id]/aliases` | operator | `{alias}` | inserts `catalog_product_aliases` with `kind = manual`; event `alias_added`; 409 "That name already points to <identifier>." |
| `DELETE /api/catalog/products/[id]` | operator | `{confirm: <identifier>}` | refuses while locked ("<identifier> is being processed in batch <name>."); deletes the product's live public objects with `deletePublicObject` (assertWithinProduct) on every live channel, marks outputs superseded, writes event `removed`, deletes aliases and the product row |

Errors are sentences with an action, HTTP 4xx, through `apps/web/lib/errors.ts`; 403 uses the 03
sentence. Every route reads the user with `currentUser()` and passes the email as the actor.

### 4.5 Env vars added by this spec (CONTRACTS section 13)

- `CATALOG_CHUNK_IMAGES` default `25` (worker; "about 25 images"; 09 tunes it).
- `COMPUTE_USD_PER_VCPU_SECOND` unset means compute USD is recorded as 0 until 09 sets it from
  the Cloud Run price list (worker).
No new secrets. Everything else used here was added by 02 to 05.

### 4.6 Matting client use

The worker uses 05's `MattingClient` and `matteFor` unchanged: `POST <service>/matte?model=<id>`
with the image at the model's send size (from the service's `/health` `inputSize`), PNG matte back
with `x-model`, `x-ms`; `POST <service>/convert` for HEIC and HEIF sources inside `prepare()`; OIDC
token for the service's audience; timeout `MATTING_TIMEOUT_MS`; the breaker inside the client
(5.4). The worker reads `MATTING_URL` (CPU service) and `MATTING_GPU_URL` (GPU service, optional;
both defined in 05) and picks the matting service by model id: each service's `/health` lists
`models: [{ id, inputSize, target }]`, and the worker sends a model to the service that lists it,
preferring `gpu`; when `MATTING_GPU_URL` is unset every model runs on the CPU service. The model
id passed is `options.policy.matteModel` (5.2). `catalog-worker@` has a project-level
`roles/run.invoker` binding from 02's bootstrap.

### 4.7 Test batches

A batch whose name starts with `catalog-test` is created with `is_test = true`. For test batches
every object path uses `rootPrefix(true)` = `catalog-test` in both buckets, products live in the
`is_test` namespace (unique per `(brand_slug, is_test, product_key)`) so they never collide with
real products, the list shows a "Test" pill, and `test-cleanup.ts` may delete their objects
(`deleteTestObjects`, which calls `assertTestPrefix`) and their DB rows. No code path deletes
anything outside `catalog-test/` except the scoped product deletes of section 5.5 and 4.4.

### 4.8 Attention item model (shared with 07)

```ts
export interface AttentionPhoto { n: number; channel: ChannelId; outputId: string; originalUrl: string; outputUrl: string | null; why: string; whatToDo: string; liveObjectExists: boolean }
export interface AttentionProduct { productId: string; identifier: string; totalShots: number; problemLine: string; photos: AttentionPhoto[] }
```
`GET /api/catalog/batches/[id]/attention` groups the batch's outputs with status `needs_attention`
or `failed` by product, one `AttentionPhoto` per problem (shot, channel), `originalUrl` a signed
URL of the current `raw_uri`, `outputUrl` a signed URL of `staging_uri` or null when nothing was
made, `why` and `whatToDo` from 02's `flagReason` (07 replaces them with its reasons table),
`liveObjectExists` true when a live output exists for that (product, channel, n). `problemLine` is
built by 07; this spec uses the first `why`.

## 5. Pipeline design

### 5.1 Ingest (04)

Ingest is 04's `runIngest`, unchanged: one task per `catalog_uploads` row with status `uploaded`,
the matching adapter, items streamed into `raw/<pathKey>/<pathKey>_<n>.<ext>` with `sha256`
computed on copy, then the batch-wide grouping once every upload is collected. Rules it applies:
`parseShotName` accepts `_<n>`, `-<n>` and `_0<n>`; `precedence` decides between uploaded bytes
and sheet URLs for the same `(identifier, n)` (default `uploads_then_links`); a duplicate
`(identifier, n)` halts only that product (`duplicate_shot`, both files in the report, 04's
sentence "Two files claim shot <n> of <identifier>: <a>, <b>. Rename one and re-upload."); HEIC and
HEIF are normal images (converted automatically, never "cannot be read"); BMP, other undecodable
formats and corrupt files get `unsupported` with a plain reason ("<name> is a BMP file. Save it as
JPEG or PNG and add it again."); shot `n` is the file's position in the product's upload counted
from the numbers in the file names (defined in 02), so a gap never leaves a blank cell; the product
gets `numbering_gap` and the sheet note "Shot numbers <list> are missing in the upload; images
shifted left in this row." No language model takes part in grouping, counting, column detection,
SKU resolution or link construction. Each grouped identifier is matched to an existing product through aliases
(alias hit, then `resolveSkus` option key, else new product with `path_key` fixed now). A source
is recorded as a new version row with `is_current = false` and `replaces_id` pointing at the
current one; the switch to current happens in the publish step (5.5) when the product goes live,
never while the batch is a draft. The product list (if any) sets
`link_status` per row: `ok`, `missing_images`, `not_in_sheet`. SKU resolution fills
`option_id_style_color` and `opptra_sku_ids` when the warehouse knows the identifier; a missing
SKU id is never a warning. Progress is `counts.collected / counts.collectTotal`
("Collecting files 48 of 310").

### 5.2 Start

`POST /api/catalog/batches/[id]/start` (operator) does, in order:
1. Refuses unless `channels` is non-empty and `counts.previewReady` is true. Refuses with "Files
   changed since the preview. Open step 4 again." when `previewReady` is false or any upload
   completed after the `previewAt` the page sent. Refuses with "No photos were found in what you
   uploaded." (plus the stored detail, for example "The zip only contained a folder of PDFs. Upload
   photos and start again.") when no product has a source; the batch becomes `failed` with
   `counts.failReason`. No question is ever asked after Start.
2. Refuses when two identifiers of the upload map to the same existing product: "ABC-123 and
   ABC123 are the same product. Keep one."
3. `lockProducts(db, batchId, productIds)` in one transaction: `UPDATE catalog_products SET
   lock_batch_id = :batch WHERE id IN (...) AND lock_batch_id IS NULL`; if the row count is short
   it rolls back and the route answers 409 with "<identifier> and <k> others are still being
   processed in batch <name>. Wait for it to finish or remove them from this upload." (one
   identifier when k is 0). The preview already showed this list as `busy`, so Start is normally
   disabled before the click.
4. `planChunks(products, CATALOG_CHUNK_IMAGES)` (5.3), inserts `catalog_chunks` rows with
   `stage = matte`, `status = queued`, enqueues one chunk task each.
5. Sets `status = matting`, `started_at`, `counts.products|sources|outputs` (outputs = current
   sources x channels, before `render_key` skips), `newProducts`, `existingProducts`,
   `shotsToRemove`; writes `catalog_batch_products` rows with `change = null`.
The policy is resolved by the worker, not the web app (the web service cannot call the private
matting service): the first chunk that runs calls `deps.resolvePolicy(brandSlug, category)` with
the batch's forced product type (or `"*"` for "Detect automatically") and stores the result once as
the batch-level policy with a compare-and-set `UPDATE ... WHERE options->'policy' IS NULL`. In this
spec `resolvePolicy` is a placeholder returning `{ matteModel: <the default from
catalog-matting /health>, qaModel: CATALOG_QA_DEFAULT_MODEL or "", threshold: 75, floor: 60,
qaMode: "per_source", qaSampleRate: 1, source: "default" }`; 07 replaces it and adds per-product
resolution by the detected product type (the matte model actually used is on
`catalog_source_images.matte_model`, and `renderKey` takes the policy that was applied to that
source). Nothing from the policy is rendered anywhere.

### 5.3 Chunks

`planChunks(products: {productId, sourceCount}[], chunkImages)` groups whole products in
identifier order so a chunk holds about `chunkImages` current sources; a product with more sources
than that is its own chunk. Each chunk runs its stages in order, one task delivery each.

`matte`
- Planning: for every current source of every product in the chunk and every batch channel,
  compute `render_key = sha256(source sha256 | channel | CHANNEL_RULES_VERSION | policy key | n)`
  with `renderKey(...)`; the policy key is `model_policy.id + updated_at` when a row was used, else
  `default|<matteModel>`. If the live output of the same (product, channel, n) has the same key,
  no output row is created: that pair is kept as is and costs nothing. Otherwise a `catalog_outputs`
  row is inserted with `status = pending` and the key. Styli outputs for sources under
  `STYLI_MIN_SOURCE_HEIGHT_PX` are inserted as `skipped` with 05's note "Skipped for Styli: the
  photo is smaller than Styli needs." (`STYLI_SKIP_LOW_RESOLUTION` is always on).
- Matting: for each source with at least one `pending` output and no `matte_uri`: download raw,
  `prepare()` (05; HEIC and HEIF go through `/convert` first), `matteFor()` (05; the client on the
  service that lists the policy's model, or the flood-fill fallback when the breaker is open or the
  call fails), store the matte at `derivedPath`, set `matte_uri`, `matte_model`, `matte_ms`, status
  `matted`. A fallback matte flags the source `fallback_matte` and marks every
  pending output of that source `needs_attention` with `flagReason("fallback_matte")`. A source that
  cannot be decoded is `failed` with "The file is corrupt and could not be decoded." and every
  pending output of it is `failed`. One decode per source, shared by all channels.

`render`
- For each `pending` output: render with 05's `renderAllChannels` (one prepared source, all
  channels of the batch at once; `planProduct` gives the uniform scale), run `checkOutput`, upload
  the JPEG to `stagingPath(prefix, pathKey, channel, n)` with `contentType: image/jpeg` and
  `cacheControl: PUBLIC_CACHE_CONTROL`, record `staging_uri`, `bytes`, `crc32c` (from
  `headObject`), canvas and placement fields, `flags`. Compliance pass -> `status = staged`;
  compliance failure -> `needs_attention` with `failed_compliance` and the failures as `reason`.
  Information flags (`low_resolution`, `no_shadow_source`, `passthrough`, `alpha_source`) do not
  change the status. `small_source` (long side under 500 px) -> `needs_attention`.
- Any exception for one output marks that output `failed` with the error sentence and continues
  with the next; a chunk is `failed` only when the handler itself cannot proceed (DB unreachable,
  for example).

Idempotency: every step checks the DB first (matte exists, output not `pending`) and the object
store second (`headObject` on the staging path with the expected size), so a redelivery after a
crash repeats nothing that finished. The chunk row's `attempt` increments per delivery; after the
queue's 5 attempts the chunk is `failed` with its error and its remaining `pending` outputs are
`failed` with "Processing stopped after repeated errors: <error>". When a chunk finishes its last
stage (`render` here, `qa` after 07) it enqueues `/tasks/catalog/publish` for each of its products
(`trigger = chunk`). The last chunk to finish sets `status = publishing` and enqueues finalize.
Batch `status` moves `matting` -> `rendering` when the first chunk reaches `render`.

Spend: each chunk adds its matting `x-ms` sum and render wall time to `cost.mattingMs`,
`cost.renderMs`, `cost.computeVcpuSeconds` (wall seconds times the worker's `--cpu`, 2) and calls
`recordCost(db, { brandSlug, batchId, engine: "catalog_compute", costUsd })`.
`cost.computeUsd = computeVcpuSeconds * COMPUTE_USD_PER_VCPU_SECOND` when set, else 0.

### 5.4 Circuit breaker

The breaker is 05's `MattingClient.breaker`, one per worker process: `closed` -> `open` after
`MATTING_BREAKER_FAILURES` consecutive failures (5xx, timeout, network), `open` -> `half-open`
after `MATTING_BREAKER_COOLDOWN_MS`, one trial call decides. While open, matting calls are not
attempted and the fallback runs at once, so a dead matting service slows nothing and fails
nothing; it produces `needs_attention` outputs with a clear reason. Every transition is logged with
the batch id. Nothing here reimplements it.

### 5.5 Publish per product (`/tasks/catalog/publish`, `publishProduct`)

The unit of publication is one product in one batch across every channel the batch selected. A
listing with photo 1 new and photo 2 old is worse than a fully old listing, so a product goes live
only when every planned output is decided. Products are published one by one as they become
ready, so ten held products do not hold up 2,690 others. Steps, all inside one idempotent task:

1. Load the product (it must have `lock_batch_id = batchId`; otherwise 200 with outcome
   `not_locked` and a log line), its current sources, the batch's channels, the outputs created
   in this batch, and the live outputs of the product.
2. Gate: every output created in this batch must be `staged`, `skipped`, or carry a decision
   (`use_as_is` or `remove`, 07). Any `pending`, `needs_attention` without decision, or `failed`
   without decision closes the gate: `catalog_batch_products.change = pending_attention`, outcome
   `held`, nothing written to the public bucket. The previous live images stay exactly as they
   were. (In this spec no decision can be made, so held products wait for 07.)
3. `planPublish(...)` returns the product's plan:
   - copies: for each `staged` or `use_as_is` output, target `publicObjectPath(...)`, the live
     output's `generation` as `ifGenerationMatch` (0 when the path has no live object), staged
     `crc32c` and `bytes`;
   - deletes: for each batch channel, every live output whose `n` is not among the current
     sources, or whose output in this batch carries decision `remove`, with its live `generation`
     as `ifGenerationMatch`;
   - kept: live outputs whose `render_key` matched at planning (no output row), counted as
     `unchanged`.
   Every target path is checked with `assertWithinProduct(objectPath, productPrefix(brandSlug,
   pathKey, isTest))`; a mismatch throws and the handler answers 500 (this is a programming error,
   never an operator state).
4. Swap: for each copy, `stageCopyToPublic(stagingUri, objectPath, { ifGenerationMatch })`
   (server-side `file.copy` with `preconditionOpts`, `contentType: "image/jpeg"`, `cacheControl:
   PUBLIC_CACHE_CONTROL`; confirmed in current docs; builders re-confirm before coding). The copy
   is atomic per object: readers see the old bytes or the new bytes, never a partial file. The
   returned `generation` and `crc32c` are stored on the output. A precondition failure means
   another writer changed the object: the output is `failed` with "Changed by another run. Start
   the batch again for this product." and the product stops at this step with `change = failed`
   (the lock makes this rare; `ifGenerationMatch` is the second guard). Retry rule: before copying,
   `headObject` on the public path; when it exists with the staged `crc32c` the copy is treated as
   done and its generation is read from the head.
5. Verify-then-live (`verifyPublic(url, { size, generation })`): a plain `GET` on the public URL
   with request header `Cache-Control: no-cache`, requiring HTTP 200, `content-type` with media
   type `image/jpeg` (a `; charset=...` suffix is ignored; any other type fails), `content-length`
   equal to the staged size, first bytes `FF D8 FF`, the URL path ending in `.jpg`, and the
   response header `x-goog-generation` equal to the copied generation. An older generation in the
   response is retried a few times (`VERIFY_RETRIES`, builder constant, with a short wait) before
   it counts as a failure, because Google's front end may still serve the previous generation
   inside the 300 s window. A failed check is retried once within the same delivery: the staged
   bytes are copied again (same `ifGenerationMatch` rules, now against the generation the first
   copy produced) and the GET repeated. Only after the second failure is the output marked `failed`
   with "Uploaded file could not be read back from the public link". On success: `is_live = true`,
   `status = verified`, `public_url`, `published_at`, `published_by` (the email that started the
   batch or made the decision), and the previous live row gets `is_live = false`, `superseded_at`,
   `superseded_by_output_id`. After a failure the previous generation is still in the bucket's
   version history and a manager can copy it back (`docs/solutions/`); the product is reported
   with its live state spelled out ("Noon images 1 to 3 are new, 4 is still the old one"), never
   left silent. Every storage copy, delete and verify GET in this sequence follows 02's retry rule
   (up to 3 retries with exponential backoff on 429, 5xx and network errors) before any of the
   failure sentences above is written; an output whose public object already verifies is never
   re-written.
6. Scoped deletes: for each delete target, `deletePublicObject(objectPath, productPrefix, {
   ifGenerationMatch })` (which calls `assertWithinProduct` first, then `file.delete({
   ifGenerationMatch })`). An object already gone (404) counts as deleted. The live output row gets
   `is_live = false`, `superseded_at`, status `skipped`, reason "Removed in batch <name>" (or
   "Removed by <email>" for a decision). Deletes touch only this product's prefix and only the
   batch's channels; channels the batch did not select keep every object.
7. Events (`catalog_product_events`, actor = the batch's `created_by` or the decision maker,
   `details` with channels, shot numbers, old and new generations, sha256 values):
   `created` when the product had no live output before; `overwritten` when at least one existing
   object was replaced; `shots_removed` when step 6 deleted anything; `channel_added` for each
   batch channel that had no live object for this product before (an existing product only);
   `reordered` when the set of current sha256 values equals the previous set but at a different
   `n`; `unchanged` when every pair was kept and nothing was copied or deleted. Several events may
   be written for one publish.
8. Source versions: for every shot of the product that this batch brought, the new
   `catalog_source_images` row becomes `is_current = true`; the row it replaces gets `is_current =
   false`, `superseded_at`, and `setCustomTime(old.raw_uri, now)` on its raw object (02 lifecycle).
   An `unchanged` pair keeps the old row current and the new row stays not current.
   `catalog_batch_products.change`: `new` for a created product; `shots_removed` when anything was
   deleted (it wins over the rest); `reordered` when the set of sha256 values is unchanged but at
   least one sits at a different `n` (same URLs, different pictures behind them); `updated` when
   anything else was copied or a channel added; `unchanged` when nothing changed;
   `failed` when step 4 or 5 failed for any output (the live state is described in `notes`).
   `last_batch_id` is set on the product. `notes` gains "photos <list> removed in batch <name>"
   after deletes.
9. Enqueue finalize if `counts.finalizePending` is false.

Idempotent retry: outputs already `verified` with a matching public `crc32c` are skipped; deletes
of objects already gone are skipped; events are written once per (batch, product, kind) by
checking before insert. The window in which a product is mixed is the seconds between the first and
last copy; Cloud Tasks retries within minutes. This is documented, not hidden.

Identical photos re-uploaded: every pair kept at planning, no matte, no render, no copy, event
`unchanged`, `change = unchanged`, zero cost, and the sheet is still regenerated.

### 5.6 Finalize and exports

Finalize runs when every chunk is terminal and every `catalog_batch_products` row has a `change`.
Otherwise it answers `not_ready` and re-enqueues itself with `delaySec: 30`. It writes, using 02's
sheet writers:
- `links-v<k>.xlsx`, exactly `sheetColumns`: `brand`, `identifier`, `option_id_style_color`,
  `opptra_sku_ids` (`;`-joined), then for each batch channel in `CHANNEL_ORDER` of the batch's
  ticks a merged header with the channel label over `Image 1..N` (N = the highest live shot number
  in that channel across the batch's products), then `status`, `notes`, `change`, `changed_at`.
  Cells hold clickable hyperlinks of live outputs (`is_live` rows at finalize time, so the sheet is
  a view of product state). `status` is `ok`, `needs_attention`, `missing_images` or `not_in_sheet`
  (`SHEET_STATUSES`). A product with `change = pending_attention` shows its previous live links
  (if any) with status `needs_attention` and the reasons in `notes`; a new held product has empty
  cells. Removed shots leave the cell empty with `notes` "photos 4 and 5 removed in batch <name>".
  `notes` collects "<Channel> img <n>: <reason>" for every skipped, failed or held output.
  `missing_images` rows carry no links and the status word; `not_in_sheet` rows carry their links
  and the status word. Identifier-like columns are text (`numFmt "@"`), both header rows bold, the
  sheet frozen below the header, rows in natural sort order of `identifier` (02 writer rules).
  `changed_at` is the latest `published_at` of the product's live outputs on the batch's channels.
- `links-v<k>.csv`: `writeLinksCsv`, flat header `<Channel> Image n`, then `status`, `notes`,
  `change`, `changed_at`. Finalize then runs `compareXlsxCsv(xlsx, csv)` on the two files it just
  wrote and records `exportsMatch: true`; a mismatch is a bug and finalize fails loudly (chunk-style
  `failed` with the differences in `error`; the batch is not marked `done`).
- Filled product-list workbook (when a product list xlsx was uploaded): `fillProductListWorkbook
  (original, spec, matchColumn)` writes `<prefix>/exports/<original-stem>-filled-v<k>.xlsx` and one
  csv per sheet `<original-stem>-<sheet>-filled-v<k>.csv`. Every sheet, column and value of the
  supplied file is kept; `link_status` and, per batch channel, `<Channel> Image 1..N` are appended on
  the right; per-size rows repeat their colourway's links; one row per `not_in_sheet` product is
  appended at the bottom with its identifier in the match column (text), its links and
  `link_status`. The upload under `uploads/` is never modified. The match column and sheet names
  come from `catalog_uploads.detected` (04).
- Independent re-check: after writing `links-v<k>.xlsx`, finalize runs `recheckSheet` on the file
  it just wrote (fresh reader, plain GETs, no DB) and records `recheck: { ok, total, failures[] }`
  in the report and `counts.recheckOk`, `counts.recheckTotal`. A failure here never deletes or
  rewrites anything; it is shown (5.7) and listed.
- `report-v<k>.json` (`buildReport`): `{batchId, brand, channels, summary: {linksPlanned,
  linksVerified, linksSkipped, productsHeld}, counts, cost, products: [{identifier, pathKey,
  linkStatus, change, changedAt, optionIdStyleColor, opptraSkuIds, sources: [{n, originalName,
  origin, sourceUrl | relativePath, mime, width, height, sha256, rawUri, status}], outputs:
  [{channel, n, status, url, generation, flags, reason}]}], overwrites: [{identifier, kind,
  channels, shots, oldGeneration, newGeneration, sha256}], notRefreshedChannels: [{channel,
  lastBatchId, lastBatchName}], removedLinks: [{identifier, channel, n, url}], recheck: {ok, total,
  failures[]}, exports: {xlsx, csv, report, filledProductList: {xlsx, csv[]} | null, exportsMatch},
  unsupportedFiles[], duplicates[], unresolvedIdentifiers[], chunks: [{index, stage, status,
  attempt, error}]}`. `linksPlanned` = outputs planned minus skipped. No model id is written to any
  export; models live only in the DB columns 02 names and in logs.
- `notRefreshedChannels(db, batchId)`: for each channel in `CHANNEL_IDS` not in the batch's
  channels, if any product of the batch has a live output on it, list it with the batch that
  delivered it most recently (by `published_at`). Rendered as "Not refreshed in this batch:
  <channels> (last delivered in batch <name>)"; one line per earlier batch name when they differ.
- `counts`: `verified`, `needsAttention`, `attentionProducts` (products with
  `change = pending_attention`), `failed`, `skipped`, `unchanged` (sum over products of current
  sources x channels minus output rows created in the batch), `latestExport = k`.
`k` increments on every finalize (07 re-runs finalize after decisions, replacements and SKU
mapping; the sync re-runs it when ids arrive); older exports stay. `report_uri`, `sheet_xlsx_uri`,
`sheet_csv_uri` point at the newest files. Status becomes `done`; `finished_at` is set;
`releaseLocks(db, batchId)` clears `lock_batch_id` for every product of the batch whose `change`
is not `pending_attention` (a held product stays locked by this batch until its decision publishes
it, so another batch cannot overwrite it meanwhile; the preview names the batch).

### 5.7 Batch status and progress text (`deriveBatchState`)

Derived for display from status, counts and chunk states:
- `collecting` when status `ingesting`: pill "Collecting files", "<collected> of <collectTotal>
  files copied from your <source>" (source = "Drive folder", "Google Sheet", "zip", "links").
- `processing` when status in `matting|rendering|qa|publishing`: pill "Processing", bar, "<made>
  of <planned> images made, not counting <skipped> skipped (too small for Styli or removed) and
  <unchanged> unchanged · about <eta> left" where planned = outputs - skipped - unchanged (the same
  figure as wizard step 4's "images will be made"), made = verified + needsAttention + failed +
  staged, the "not counting" parts are shown only when non-zero, and eta comes from the rate over
  the last 5 minutes; the eta part is shown only once a rate exists.
- `attention` when `done` and `counts.attentionProducts > 0`: pill "<n> products need your
  attention", "Everything else is done and in the sheet. Decide now or download the sheet as it
  is; each decision updates the sheet."
- `ready` when `done`, nothing needs attention, `counts.verified` equals `linksPlanned` (outputs
  minus skipped) and `counts.recheckOk` equals `counts.recheckTotal`: pill "Ready", "All <n> images
  are live and passed every check. Nothing needs your attention."
- `recheck_failed` when `done`, nothing needs attention, but the two counts above do not match:
  warn pill "<k> links did not pass the independent re-check", "The sheet is ready but <k> links
  did not pass the independent re-check. See Details before sharing it."
- `failed`: pill "Could not start", the stored `counts.failReason` sentence.
List pills (CONTRACTS section 12): "Needs attention (N products)", "Processing 1,240 of 4,800",
"Ready to download", "Collecting files 48 of 310", "Could not start".

### 5.8 Sweeper interplay (02 `/tasks/catalog/sweep`)

The sweeper marks a batch with no chunk progress for 2 hours as `failed` and releases its locks.
So that it can see progress, this spec writes `catalog_chunks.started_at` and `finished_at` on
every stage, `catalog_outputs.updated_at` on every output change and `published_at` on publish;
"progress" is the latest of these for the batch. The sweeper never touches `done` or `failed`
batches, so a held product of a `done` batch stays locked until its decision (5.6). A swept batch
shows "Could not start" with the sentence "No progress for 2 hours. Start the batch again." (02)
and the "Start again" button; products it had already published are live and consistent and a
re-run skips them as `unchanged`.

## 6. Web UI by screen (visual contract: prototype v2)

Fonts, colours and layout follow the prototype (`Spectral` headings, `Raleway` body, navy top bar,
orange primary buttons, one centred column, cards only where an object needs separating). Reuse
`apps/web/components/ui.tsx` and `AutoRefresh.tsx`. Nav: "Opptra" logo, "Catalog images", user
button "<email> · <Role> ▾" with "People" (admins) and "Sign out" (03). The role decides what is
rendered: viewers see every page but no "New batch", no "Start again", no action buttons, no
"Add alias", no "Remove product", no brand export button.

### 6.1 `/catalog` list (viewer)

Title "Catalog images", lead "Turn a brand's product photos into marketplace-ready images and get
a sheet of links. One brand per batch.", button "New batch" (operator). Table columns Brand (with
a Softline or Hardline pill, and "Test" for test batches), Batch, Channels, Products, State,
Created. State pills from 5.7. Footer: "A product's links stay the same for life. Uploading a
product again replaces the pictures behind its links. Marketplaces keep their own copy, so
re-submit changed products there." Rows link to the batch page. Auto-refresh while any row is
collecting or processing.

### 6.2 `/catalog/new` wizard (operator; four steps on one page)

Step indicator: "Brand and files", "Check what we found", "Where will these images go?", "Start".

Step 1 "Brand and files", left card: "Which brand?" select with "Choose a brand" and the
Softline and Hardline groups from `brand_master`; help "Brand not in the list? Email
sujan@opptra.com." (mail link; there is no add-brand form). "Batch name (optional)" with a
placeholder like "USPA kids sneakers, Oct lot". "What kind of products?" select: "Detect
automatically (recommended)", "Footwear", "Apparel on a model", "Apparel laid flat", "Bags and
accessories", "Other"; help "A folder can mix footwear, apparel and accessories; we detect each
product separately." The select is an override; the default stores `auto` and the type is detected
per product (07). Right card "What do you have?": drop zone "Drop images, folders, zips or a links
sheet here" with "Or click to choose. Photos should be named like ABC123_1.jpg, ABC123_2.jpg so we
know which shots belong together."; the file list shows name, a kind pill (`zip`, `product list`,
`links sheet`, `cannot read` for BMP and corrupt files only; HEIC files upload like any photo), size
and a progress bar; after upload "Uploaded". Folder drops keep relative paths. "Or paste a link" textarea
with placeholder "A Google Sheet link, a Google Drive folder link, or image links one per line".
The share box appears only when a pasted line is a Google Sheet or Drive link: "Share it with
<SHARE_SA_EMAIL> [Copy]" ("Copied" for 1.5 s) and "Viewer is enough; we only read. We never change
your files." Help under the textarea: "We check access as soon as you paste." On paste the
`/links` route answers and the help becomes one of: pill "Access confirmed" + "Google Sheet
"<title>", <rows> rows, <k> image columns found."; pill "No access yet" + "Share the folder with
the address above, then paste again."; pill "<n> image links" + "We will download them when you
start. No sharing needed." "Continue" creates or updates the draft, waits for uploads to
complete, calls `/ingest`, and moves on.

Uploads: files PUT directly to the signed URLs (CORS from 02's `infra/cors.json`), several in
parallel, per-file progress; on failure the row shows "Upload failed. Try again." and a retry
button; the wizard cannot continue while any upload is unfinished. Several zips are supported.

Step 2 "Check what we found" (data from `/detected`): lead "We have looked at what you gave us.
The usual answers are already selected; press Continue if they look right." Cards:
- "How should we tell products apart?" radios "By file name before the last _number" with
  "Recommended: ABC123_1.jpg, ABC123_2.jpg. This is what we detected.", "By folder name" with "One
  folder per product.", "By the identifier column in your sheet"; under the chosen mode three
  example rows (identifier in mono, "from ABC123_1.jpg … _5.jpg" or "<folder>/ · 5 files in the
  folder" or "column B, 5 photo links", thumbnails) and the note "3 of <n> products, so you can
  check the grouping." Sets `options.identifierMode`.
- "You gave us a folder and a sheet of links. Which wins when both have the same product?" (shown
  only when both kinds exist; note "Shown because you added both."): "Use the uploaded photos, fill
  gaps from the links" (Recommended.), "Use the links only", "Use the uploaded photos only". Sets
  `options.precedence`.
- "Photo formats": one summary line like "1,612 JPG, 34 PNG (transparent backgrounds kept), 2 HEIC
  (iPhone format, converted automatically)." and help "No action needed." Unreadable files are
  counted as "<n> files cannot be read (<names>)".
- "Sheet columns" (shown only with a sheet; note "Shown because you added a sheet."): one line per
  sheet upload "Sheet `<name>`: identifier column `<header>`, <m> image columns, read as <links
  sheet | product list>" with "Change"; Change reveals three real controls: "Identifier column"
  select, "Photo columns" multi-select, and "Read this sheet as" (links sheet / product list). When
  detection could not decide, the line reads "Could not tell which column holds the identifier.",
  the controls are open, and Continue is disabled until a column is chosen; detection never guesses.
  Saving calls `PATCH .../detected`, which re-runs grouping from `raw/`. Sets `options.sheetColumns`
  and `catalog_uploads.detected`.
- "Google access": "For Google Sheets and Drive folders, share them with <SHARE_SA_EMAIL> as
  Viewer. Viewer is enough; we only read. We never change your files." then one row per pasted
  Google link with pill "Access confirmed" or "No access yet", the link, "Google Sheet" or "Drive
  folder", and "Check again" when not confirmed.
Back and Continue; Continue is disabled while any sheet is `cannot read`. A change here re-groups
from `raw/` (no re-download).

Step 3 "Where will these images go?": lead "Tick every marketplace you want images for. Each one
is made to that marketplace's own rules. Nothing is pre-selected." Group "Usually listed first"
(Namshi, Noon, Trendyol, Amazon) and "Also available" (Styli, 6thStreet, Centrepoint, VogaCloset,
Shein). Each card: checkbox, label, rule text from the prototype (Namshi "1080 x 1480, light grey
background, 10% space above and below"; Noon "1080 x 1480, light grey background, 10% space above
and below, 5% at the sides"; Trendyol "1200 x 1800, light grey background, no spaces in file
names"; Amazon "2000 x 2000. First image on pure white, the rest light grey"; Styli "2342 x 3123,
light grey, product at the bottom centre inside Styli's guides, same placement on every angle";
6thStreet "2000 x 2667, light grey background"; Centrepoint "3000 x 3000 square, light grey
background. Nothing is cropped; space is added at the sides"; VogaCloset "2000 x 2667, light grey
background"; Shein "2000 x 2000. First image on pure white, the rest light grey"). Back and
Continue; Continue disabled until one channel is ticked. There is no extra options section.

Step 4 "Start" (polls `/preview`; while not ready a bar "Collecting files <x> of <y>"):
- KPIs "products found", "photos", "marketplaces", "images will be made" (photos times channels,
  minus Styli skips and minus `unchanged` pairs).
- Warning list, one sentence each with the plain action, built from counts: "<n> products have no
  photos. They are in your product list but no files matched: <ids>. They will appear in the sheet
  as "missing images"."; "<k> products have photos but are not in your product list: <ids>. They
  will appear in the sheet as not in sheet."; "<k> products have two files for the same shot number:
  <ids>. They are left out until one file is renamed; see the grouping table."; "Your upload has <k>
  top-level folders (<names>). Everything in them will be filed under <brand>. If these are
  different brands, make one batch per brand." (whenever more than one top-level folder contains
  images); "<k> identifiers appear more than once in `<sheet>`; the first row of each is used.";
  "<k> size rows matched <m> products."; "<k> files could not be read." followed by "<names>:
  <reason>. Fix them and use them in a new batch, or continue without them."; "<n> photos are
  smaller than Styli needs (under <STYLI_MIN_SOURCE_HEIGHT_PX> px). Styli will skip them and note it
  in the sheet, as agreed with Styli." There is no warning about missing Opptra SKU ids and none
  about HEIC.
- Estimate line: "Estimated cost: about INR <x> (<n> images, <m> quality checks)" from
  `estimateCost(counts, env)` (07's `cost.ts`: QA calls at the policy's `qaMode`, compute at
  `COMPUTE_USD_PER_VCPU_SECOND`, `INR_PER_USD`); "Estimated cost: not available" when
  `INR_PER_USD` is unset or until 07 ships the function (this spec wires the line to a stub that
  returns null).
- Overwrite preview block (copy owned by 01 and this spec): "<n> products are new." and, when
  existing products are present, "<m> products already exist and will be overwritten: <list>." with
  one line per product whose shots shrink, "ABC123: 5 photos live, 3 in this upload; _4 and _5
  will be removed."; the rename hint "NEW-ID has the same photos as ABC123. If this is a rename, add
  an alias on the product page instead of uploading."; the busy line "<identifier> and <k> others
  are still being processed in batch <name>. Wait for it to finish or remove them from this
  upload." (Start disabled while any product is busy); the duplicate-spelling line "ABC-123 and
  ABC123 are the same product. Keep one." (Start disabled). There is no separate confirmation
  dialog; the operator sees this and presses Start.
- Announcement line above the table, from 04's `groupedBy`: "Grouped by file name
  (`<identifier>_<n>`)", "Grouped by folder name", "Grouped by the sheet column `<header>`",
  "Grouped by style and colour code (`<style>` + `<colour>`)" or "Matched by style and colour code
  found inside the file names".
- "How we grouped your photos" table: Identifier, Opptra SKU ids, Photos, First photo (thumbnail),
  Status pill (`ok`, `missing images`, `not in sheet`, `two files for one shot`, `existing`); each
  row expands to list its source file names in shot order with the shot number and size
  (`PreviewRow.files`); help "Showing 6 of 412. If a grouping looks wrong, go back to "Check what we
  found" and change how we tell products apart."
- Footer note "Once you start, you cannot add more photos to this batch. Make a new batch for
  anything else." and "Start processing", which calls `/start`, toasts "Batch started. We will show
  progress here." and opens the batch page.

### 6.3 `/catalog/[id]` batch page (viewer; actions operator)

Header: "← All batches", batch name, sub-line "<Brand> · <channel labels> · started <when> by
<email>" (or "finished <when>"). Banner by derived state (5.7). KPIs: products; images made and
verified; products need attention (amber when > 0); could not be made. Actions: "Download links
sheet (Excel)", "Download CSV" and, when a product list workbook was uploaded, "Download filled
product list", all when an export exists; "Start again" (operator) on `failed`,
which opens the wizard with the same brand. Below the banner, when `notRefreshedChannels` is not
empty: "Not refreshed in this batch: <channels> (last delivered in batch <name>)".

Tabs: Overview, "Needs attention (N products)" (hidden when 0), Links sheet, Details.
- Overview: card "How this works": "We check every image against the marketplace rules and our
  quality check. Images that pass go straight into the links sheet. Only products with a problem are
  listed under Needs attention." plus the state line (processing: "You can close this page; nothing
  stops."; collecting: "We copy your files first so the batch does not depend on the Drive folder
  later. Processing starts automatically."; attention: "Open "Needs attention" for the <n> products
  with a problem."; ready: "Download the sheet and paste the links into the marketplace
  templates."; failed: "Nothing was processed and nothing was charged."). When the batch touched
  existing products: "Marketplaces keep their own copy. Re-submit the image columns for products
  marked updated, shots_removed or reordered in the sheet." Card "Cost so far": this spec shows
  "Cost per style arrives with the quality-check update"; 07 replaces it with "INR <x> per style so
  far · agency reference INR 60 per style".
- Needs attention (shell): lead "Everything else is done and in the sheet. Only the products below
  have a problem, and only the photos with a problem are shown. Your decision is applied to the
  links sheet straight away." One card per `AttentionProduct`: identifier (mono), "<k> of <total>
  photos need a decision", the problem line, and per photo: figure "Photo <n> of <total>, original",
  figure "Photo <n> of <total>, made for <Channel>" (or the placeholder "Could not be made"), bold
  `why`, `whatToDo`, buttons "Use as is" (green), "Remove this photo", "Replace photo <n>", all
  disabled with the tooltip "Available after the quality-check update". Hidden for viewers.
- Links sheet: lead "One row per product. Each marketplace has its own set of links. Open the
  Excel file to get clickable links; this is a preview." Preview table with the merged channel
  headers and the `status`, `notes`, `change`, `changed_at` columns, first 50 rows, then "Download
  links sheet (Excel)", "Download CSV", "Download filled product list" (when present), a disabled
  "Add SKU ids" (07), and help "Opptra SKU ids are filled in automatically when they exist."
- Details: card "For the technical team": "batch <id> · raw files:
  gs://image-links-agent-assets/catalog/<brand>/<batchId>/raw/ · public links:
  https://storage.googleapis.com/image-links-agent-public/catalog/<brand>/<pathKey>/<channel>/ ·
  report.json" (the public path carries the product key, not the batch id; `catalog-test/` for
  test batches); the two count lines "Links verified: <verified> of <planned>" and "Independent
  re-check: <ok> of <total> OK" (with the failing URLs listed when they differ); the "Not refreshed"
  line; error block "<n> image(s) could not be made." then one
  sentence per failed output "<file> for <Channel>: <reason>. Replace it from the Needs attention
  tab." No model names anywhere.
Auto-refresh while collecting or processing.

### 6.4 `/catalog/products/[brand]/[key]` product page (viewer; actions operator)

Title: the identifier; sub-line "<Brand> · <path_key>" and the live public prefix. Section "Live
images": one row per channel with a live output, thumbnails in shot order with the shot number and
the link under each; empty state "No live images yet." Section "Opptra SKU ids": the list or "None
yet. They are filled in automatically when the warehouse knows this product, or from a mapping
sheet on the batch page."; `option_id_style_color` when known. Section "Also known as" (aliases
with their kind) and the form "Add alias" (operator): input, button "Add alias", toast "<alias>
now points to <identifier>." Section "History": events newest first, "<when> · <kind in plain
words> · <actor> · <details>" (created "First delivered in batch <name>", overwritten "Pictures
replaced in batch <name> on <channels>", shots_removed "Photos <list> removed in batch <name>",
channel_added, unchanged, reordered, sku_ids_added, alias_added, removed_photo,
replacement_uploaded, restored, removed). Buttons: "Download links" (xlsx of this product's live
links through the brand export route) and "Remove product" (operator) opening a dialog "Remove
<identifier>? This deletes its live images on <channels>. Marketplaces keep their copy. Type the
identifier to confirm." with Cancel and "Remove product"; toast "<identifier> removed." A locked
product shows "Being processed in batch <name>" instead of the buttons.

### 6.5 `/catalog/brands/[slug]` brand page (viewer; export operator)

Title: brand name with the line pill. Search box "Search by identifier, alias or Opptra SKU id"
calling `/products?q=`. Results table: Identifier, Opptra SKU ids, Live channels, Last batch (link),
checkbox per row. Button "Download links for selected products" (operator) calls the brand export
route and offers the file; help "Every live channel of the selected products. Regenerating never
changes a link." Empty search: "No products of <brand> match <q>."

### 6.6 Sign-in and roles: who sees what

There is no public page: IAP in front of `catalog-web` (03) sends everyone to Google's sign-in and
admits only `@opptra.com` accounts, and every page and route calls `currentUser()` or `requireRole()`
(03), which verifies the IAP JWT. Viewer: list, batch pages, sheet preview, attention tab (read-only),
downloads, product and brand pages. Operator: everything a viewer sees plus "New batch", the wizard,
Start, Start again, the attention buttons (07), Add SKU ids (07), Add alias, Remove product, brand
export. Admin: operator plus the People modal. Buttons are absent, not greyed, for roles that lack
them; the API answers 403 with the 03 sentence if called anyway. "Preview as viewer" (03) hides
the same buttons for an admin.

## 7. Infra and deploy

Already in place from earlier specs and not touched here: the `catalog` queue, the public bucket
with versioning and lifecycle, `infra/cors.json`, the scheduler jobs `catalog-sync-master` and
`catalog-sweep`, the service accounts and IAM (02 `bootstrap.sh`); the `catalog-matting` service
(05).

`infra/deploy.sh` (idempotent, `set -euo pipefail`, `export CLOUDSDK_CORE_PROJECT=image-links-agent`,
`gcv()`, `retry`, `SKIP_BUILD=1`, image tag = git short SHA):
- Builds and deploys all three images `${AR}/web:${TAG}`, `${AR}/worker:${TAG}`,
  `${AR}/matting:${TAG}` and runs the `catalog-migrate` job.
- `catalog-worker`: `--cpu=2 --memory=2Gi --concurrency=2 --min-instances=0 --max-instances=10
  --timeout=900`; env adds `CATALOG_CHUNK_IMAGES` and, when set in the operator's environment,
  `COMPUTE_USD_PER_VCPU_SECOND`; `MATTING_URL`, `MATTING_GPU_URL` (when the GPU service is
  deployed, 05), `WORKER_URL`, `WORKER_SA_EMAIL` as before.
- `catalog-web`: private with `--iap` and the `domain:opptra.com` grant as in 03 (never
  `--allow-unauthenticated`), `IAP_AUDIENCE`, `ALLOWED_HOSTED_DOMAIN`, `SHARE_SA_EMAIL`.
- `catalog-matting`: unchanged from 05.
- Runs the per-brand smoke (section 9, tier 5) before `gcloud builds submit`; stops on a non-zero
  exit so a failing smoke blocks the deploy.
- Prints `WEB_URL`, `WORKER_URL`, `MATTING_URL` at the end.
`/health` on the worker returns `{ ok, version, routes }` with the six task routes; on matting
the version, loaded models and the default (05). `bash infra/deploy.sh` twice: the second run
changes nothing.

## 8. Build order (subagent workstreams)

Each workstream gets this file, `docs/SPEC.md`, the 02 to 05 exports it needs, and its file list.
Before touching Playwright, `@google-cloud/storage` copy and delete preconditions, Next.js route
handlers or `currentUser()` in route handlers (03's IAP JWT check), the subagent reads the current docs through
Context7 (the call shapes in 5.5 and 9 are confirmed in current docs; builders re-confirm before
coding). Worktrees `C:\Users\Sujan AH\Desktop\catalog-module-wt\06-<workstream>`.

- W1 worker pipeline (`06-worker`): `plan-chunks.ts`, `status.ts`, `verify.ts`, `publish.ts`,
  `report.ts`, `test-cleanup.ts`, the `chunk`, `publish` and `finalize` handlers, `deps.ts`,
  `index.ts` wiring, tier 1 and tier 2 tests.
- W2 wizard and uploads (`06-wizard`): `/catalog`, `/catalog/new`, step components, `Uploader`,
  `PasteBox`, `ShareBox`, `OverwritePreview`; API routes for batches, uploads, links, ingest,
  detected, preview, start; route tests including the role checks.
- W3 batch, product and brand pages and downloads (`06-pages`): `/catalog/[id]`, banner, KPIs,
  tabs, attention shell, sheet preview, details, "Not refreshed" line; product page and brand page
  with their routes (attention, export, products search, brand export, aliases, product delete);
  home redirect and nav.
- W4 infra (`06-infra`): `deploy.sh`, worker `/health` routes, `.gitignore`, `playwright.config.ts`.
- W5 tests (`06-tests`, starts after W1 to W4 merge on the feature branch): `catalog-smoke.ts`,
  the tier 3 real-data case, `catalog.human.spec.ts`.
W1 to W4 are independent. W2 and W3 share `apps/web/lib/catalog/*`: W2 owns `batches.ts`,
`uploads.ts`, `preview.ts`, `links.ts`; W3 owns `exports.ts`, `products.ts`, `brands.ts` and adds
read-only query functions to `batches.ts` as new exports only. The integration subagent merges,
runs the gates, then W5 runs.

## 9. Test plan

Tier 1 unit (vitest): `planChunks` (whole products, about 25 images, a big product alone, stable
order); `deriveBatchState` for every state including `publishing` and `recheck_failed`, and the
eta; `verifyPublic` with a fake fetch for every failure mode including a wrong or stale
`x-goog-generation`, a `; charset=` suffix accepted, a `.jpeg` path rejected, and the single
re-copy retry before `failed`; `recheckSheet` on a synthetic xlsx (hyperlink equals text, unique
URLs, one row per identifier, `.jpg` suffix, GET results); finalize's use of `compareXlsxCsv`
(a mismatch fails finalize);
`planPublish` maths (copies with `ifGenerationMatch` = live generation or 0; deletes only for
missing shots and `remove` decisions, only on the batch's channels; kept pairs counted); `renderKey`
changes with source sha256, channel, `CHANNEL_RULES_VERSION`, policy key and `n`, and is stable
otherwise; sheet layout from a synthetic report (merged headers, empty cell plus note for held or
removed outputs, `;`-joined SKU ids, `change` and `changed_at` tail columns, previous live links
for a held product); `buildReport` fills `overwrites`, `notRefreshedChannels`, `removedLinks`;
every public write and delete path goes through `assertWithinProduct` (a spy counts calls equal to
copies plus deletes); `test-cleanup.ts` refuses any prefix outside `catalog-test/`.

Tier 2 integration (PGlite, fake storage, fake matting, fake tasks; role checks with a fake
session): ingest groups a zip fixture with `_1/_2`, `-1`, `_01` names and a product list into
`ok|missing_images|not_in_sheet` (fixture built to the Anta delivery's 586 rows: 472/56/58);
duplicate `(identifier, n)` halts only that product; a HEIC fixture is grouped as a normal image
and a BMP fixture is listed as unsupported with its sentence; finalize writes the filled product
list workbook with per-size rows repeating their colourway's links and a `not_in_sheet` row
appended at the bottom; `not_in_sheet` sheet rows carry links and `missing_images` rows carry
none; the re-check numbers land in `counts.recheckOk` and `counts.recheckTotal` and the report;
the `ready` state needs both counts to match; chunk redelivery
after a simulated crash repeats no matte, render or copy (count fake calls); one output throwing
does not stop the others; with the fake matting server failing, the breaker opens after
`MATTING_BREAKER_FAILURES` and outputs become `needs_attention` with `fallback_matte` and its
sentence; the publish gate holds a product (`change = pending_attention`, no public write) while
one output is undecided and publishes it once every output is `staged` or `skipped`; a re-upload
of a product with one changed photo and one removed shot writes the same object paths, a new
generation only for the changed shot, one delete call only for the removed shot and only on the
batch's channels, leaves an untouched channel's generation unchanged, writes `overwritten` and
`shots_removed` events, and sets `change = shots_removed` with the note; an identical re-upload
yields `change = unchanged`, zero renders, zero copies and an `unchanged` event; lock contention
(a second batch on a locked product) is refused with the busy sentence and rolls back; finalize
before completion returns `not_ready` and re-enqueues; finalize twice yields `links-v1` and
`links-v2`; the route table returns 404 for unknown paths and 401 without OIDC; every operator
route in 4.4 answers 403 with the 03 sentence for a viewer and 200 for an operator.

Tier 3 real-data pipeline (`REAL_DATA=1 pnpm test:real`, worker and matting in Docker, real GCS
under `catalog-test/<run-id>/`): the Anta set
`C:\Users\Sujan AH\Desktop\opptra-image-links\new_resources_4\Images` (630 footwear images, 800x800,
pure white) zipped, plus a pasted list of live Supabase links from
`new_resources_3\*.xlsx` (Campus and Keds rows), through all nine channels as a `catalog-test`
batch; assert every non-skipped output is `verified` and live with the recorded generation
(`verifyPublic` from a fresh process), compliance 100%, the sheet opens with the `change` column
all `new`; then run a second batch with one photo altered (one pixel) and one shot dropped, and
assert the overwrite contract: same URLs, a new generation only for the altered shot, 404 on the
removed link after the cache window, the untouched shots' generations unchanged, `change` values
`updated`, `shots_removed`, `unchanged` as expected, events written, `removedLinks` in the report;
then `test-cleanup.ts` deletes `catalog-test/<run-id>/` in both buckets and the rows. Supabase is
read only.

Tier 4 human-like browser test (Playwright, deployed URL, the tester is an admin). Call shapes
confirmed in current docs; builders re-confirm before coding:
- 03's `apps/web/test/human/login.ts`: `chromium.launch({ headless: false, channel: "chrome" })`,
  open `WEB_URL`, the tester signs in on Google's IAP page, then
  `await context.storageState({ path: ".playwright/auth-state.json" })`. Gitignored, never printed.
- `catalog.human.spec.ts`: `browser.newContext({ storageState: ".playwright/auth-state.json",
  recordVideo: { dir: ".playwright/videos" } })`, `test.setTimeout(...)` sized for a real run,
  `await context.close()` so the video is saved (09 turns it into the GIF).
- Steps 1 to 6: 1 open `/catalog`, click "New batch"; 2 choose "USPA", name `catalog-test human
  run`, `locator.setInputFiles(<zip>)` on the drop zone with the operator's USPA footwear set (or
  the Anta zip when that set is not yet available, stated in the report), paste a Supabase link
  list into "Or paste a link", expect the "image links" pill; 3 Continue, check step 2 shows "By
  file name before the last _number" selected, Continue, tick Noon and Styli, Continue; 4 expect
  the KPIs, the overwrite block "<n> products are new." and "How we grouped your photos", click
  "Start processing"; 5 poll the banner with `expect(locator).toBeVisible({ timeout })` until
  "Ready" or "need your attention"; 6 `const dl = page.waitForEvent("download")`, click "Download
  links sheet (Excel)", `await (await dl).saveAs(path)`, open the xlsx with the 02 reader, take
  three links, `page.goto` each and assert `content-type` `image/jpeg`; when a product list was
  used, click "Download filled product list" and assert the appended columns are present; read
  "Links verified" and "Independent re-check" on Details and assert both read N of N.
- Overwrite steps: 6a new batch with the same zip and the same channels -> every product
  `unchanged` in the sheet and the report shows no new generations; 6b new batch with one photo
  changed and one removed -> open the changed link and see the new picture (compare bytes with the
  downloaded file), open the removed link and get 404 after the cache window, read the `change`
  column (`updated`, `shots_removed`). Steps 7 to 10 (decisions, mapping sheet) are added by 07.
  The run ends with `test-cleanup.ts` on the test batches.
- Exploratory runs may use the Chrome extension instead; the recorded Playwright run is the gate.

Tier 5 per-brand smoke (`pnpm catalog:smoke`, `apps/worker/src/catalog-smoke.ts`): one product
per brand from the real sets (and 08's golden set once it exists), all nine channels, local Docker
worker and matting, objects under `catalog-test/smoke/<run>/`, run twice: the second pass alters
one photo and drops one shot and asserts same URLs, new generations only for the altered shot, the
removed link gone, the untouched channel's generation unchanged, `change` values as expected. HTML
report with thumbnails and the per-output generation at `catalog-test/smoke/<run>/report.html`;
exit code non-zero on any `failed_compliance` or any overwrite assertion failure. `infra/deploy.sh`
runs it before building and stops on a non-zero exit. No OpenRouter call is made (QA arrives in 07
and is mocked in the smoke unless `LIVE_SMOKE=1`). Cleanup at the end of the run.

CI gate on the PR: `pnpm lint && pnpm typecheck && pnpm test`.

## 10. Done criteria

- All six worker routes live behind OIDC; `/health` on worker and matting show versions and the
  worker lists its routes.
- A batch created in the deployed UI for a real brand with a zip and a pasted link list, two
  channels ticked, finishes with every non-skipped output `verified`, `is_live` with the recorded
  generation, a downloadable xlsx whose links open as JPEGs and whose `change` column reads `new`,
  the Details tab reading "Links verified: N of N" and "Independent re-check: N of N OK", and the
  filled product list downloadable when a product list was uploaded.
- A second batch for the same products with one photo changed and one removed leaves every URL the
  same, replaces only the changed picture, removes only the dropped shot on the batch's channels,
  leaves other channels untouched and lists them as "Not refreshed in this batch", and the sheet's
  `change` column says `updated` and `shots_removed`.
- An identical re-upload costs nothing: no matte, no render, no copy, every product `unchanged`.
- Killing the worker mid-chunk and redelivering repeats no finished work (tier 2 evidence).
- Stopping `catalog-matting` during a run yields `needs_attention` outputs with the fallback
  reason, the affected products are held with their previous images live, and the batch still
  finishes.
- A viewer can open every page and download the sheet but sees no action button; every operator
  route answers 403 for a viewer (tier 2 evidence).
- The per-brand smoke passes for every brand with real images available, both passes; the report
  is attached.
- The Playwright run passes on the deployed URL with the video saved.
- No model name appears in any page, API response or export (grep test over rendered HTML, JSON
  and the report for the candidate ids; 07 extends it).
- `bash infra/deploy.sh` twice: the second run changes nothing.

## 11. Merge, deploy, report

Per `00-execution-protocol.md`: one PR from `feat/catalog-06-pipeline-and-ui`, gates green, code
review and simplify pass, merge, `bash infra/deploy.sh`, per-brand smoke, learnings in
`docs/solutions/` if any (the restore-a-previous-generation procedure goes there), then the single
report: what shipped, test evidence (tier 2 counts, tier 3 compliance and overwrite figures, smoke
report link, Playwright video), exclusions, and "Ready for the next spec: 07 QA, attention and SKU ids".
