# Spec 18: the enlargement lifecycle, designed once (2026-10-29, amended 2026-10-30)

**Status: FROZEN 2026-10-30.** Design, read-only review of PR #125 head 55c472c (branch
`feat/catalog-18-quality--x4-routing`) against main 1dcc565, through four review rounds. Nothing in this document was
built. It is the single source of truth for the fix that ends the fix-review loop on the AI photo enlargement
feature. One Opus implementer builds it in one pass (section 7). Changes after this date go through a new review
round, not an edit.

Amendment history:
- 2026-10-30 a: adversarial review `.runs/2026-10-29-18-lifecycle-plan-review.md` (P0 0, P1 9, P2 21). Every P1 and
  P2 is dispositioned in section 9. The route is now pinned per batch, the region branch is gone, `superseded` is a
  flag not a status, readiness is primed on the render's own buffer, done batches and the sweep are handled.
- 2026-10-30 b: owner decisions in the owner's words. (1) "Use as is" on a failed enlargement: "Allow, with a clear
  warning". (2) "if it is a very large enlargement or it's a slow enlargement, it's okay if it takes 4 to 20 hours
  ... what is very critical is that it's able to get the output, whatever is needed, in a very reliable way." (3)
  "the cost ceiling of USD 40 is again arbitrary ... We have no limits at all." Consequences: no wall-clock timer
  fails, sweeps or holds enlargement work; attempts are bounded, time is not; outages and pauses delay and never count;
  over-cap photos are tiled, then downscaled, held only when no route can make the output; money is not a constraint,
  GCP quota is, and it is named.
- 2026-10-30 c: verification pass `.runs/2026-10-30-18-lifecycle-plan-verify.md` (4 new P1, 9 new P2, 3 partials).
  Every repeating path now either makes progress or counts: a crash-shaped failure while the service answers health
  counts (N1), the health probe tolerates a cold start and yields to the real call (N2), one shared validator is the
  only judge of a stored object (N3), the size arithmetic is one consistent set of numbers (N4), identity churn and
  the tile budget have floors, and section 3.10 is the termination argument.
- 2026-10-30 d (final): narrow check `.runs/2026-10-30-18-lifecycle-plan-verify-2.md` (P1-A, P1-B, P1-C). The
  counting rule is now: a failed call is uncounted only when the re-probe positively proves the service absent
  (connection refused, DNS error, the service's own 503 body); a probe timeout, a 429 or "no instance" does not
  prove absence, so the failure counts. The output size is `f x shrunk`, never `floor(width x scale)`. Identity
  changes are counted as release events (`identity_releases`), not rows. Frozen after this round.

Words used here (plain language, defined once):
- Enlargement: the AI step that makes a bigger copy of a photo (x2 or x4) before the render fits it on a marketplace
  canvas. "Plain resize" is the old non-AI stretch (Lanczos).
- Identity: everything an enlarged image was made from. Two images with the same identity are interchangeable.
- Terminal: a failure of the upscaler itself on this exact input, repeated enough times that a retry cannot fix it.
  Only a terminal failure may hold a product.
- Delay: an answer that means "not now" (busy, down, paused, quota, deploying). A delay never counts toward terminal.
- Hold: an output in `needs_attention` with a reason, waiting for the operator.
- Park: a chunk waiting for its photos' enlargements (`task_name='enlarging'`), with no task and no window slot.
- Judge of readiness: any code that decides what to do based on whether an enlarged image exists: the render, the
  repair ladder, the QA stage, publish.
- Route: which models a batch uses (x2 model, x4 model or none) and from which scale (the threshold). Pinned per
  batch at Start.

## 0. Verdict in five lines

1. The lifecycle has no owner on 55c472c: five modules read `x2_*` columns and object metadata directly and each
   decides for itself. The permanent hold found by the latest re-check (the QA ladder's second matte) is one of
   three instances of the same gap, all caused by a judge that treats "no usable image" as "failed" instead of "not
   ready" (section 1.6).
2. The fix is a state model, not another patch: one row per (batch, photo, identity), owned by one module, with one
   reconcile function every stage calls, readiness primed on the render's own buffer, and one tri-state answer
   (ready, terminal, not ready) every judge must honour. Section 2 states the nine invariants; section 3 the mechanism.
3. Keep PR #125's branch. Its service, infra, render and routing work is correct and reviewed; only the lifecycle
   (worker `enlarge.ts`, core `pipeline/enlargement.ts`, the gap check in `chunk.ts`, the ladder's `ok()`, the park
   and sweep predicates, decisions) is replaced (section 5).
4. One additive migration (0006: a new table and two new event kinds). Nothing of spec 18 is live, so no live data is
   affected.
5. 66 failure rows (F1-F63 plus F8b, F24b, F25b), 67 scenario tests plus the end-to-end T39 and the state-machine
   T40 (T1-T69), all through the real stage entry points.

## 1. Inventory: every code path that touches an enlarged image or its state (55c472c)

### 1.1 Creating, queueing and settling

| # | Path | Where (file:line) | What it does |
|---|---|---|---|
| C1 | Start records the route | `apps/web/lib/catalog/start.ts:67-69` | writes `options.enlargement = {model, x4Model?, minScale}` from env (`enlargementOptionFromEnv`, `packages/core/src/catalog/pipeline/enlargement.ts:55-60`). Scope of the invariant. The worker does not read it back (the design makes it the batch's pinned route). |
| C2 | Matte stage decides and queues | `apps/worker/src/catalog/chunk.ts:412` (shots kept with `rgb`), `:424` (call), `apps/worker/src/catalog/enlarge.ts:212-246 queueEnlargements` | per product after every photo is cut out: `enlargementFactors` (`packages/core/src/catalog/render.ts:526-547`) over all shots with a matte; writes `x2_model` (the comma job, `:239-241`) under the chunk claim; enqueues round 0 (`:244`). Reads `pending` outputs only (`:217`). |
| C3 | The park | `chunk.ts:526-531` | at matte -> render advance, `chunkHasQueuedEnlargement()` (`pipeline/enlargement.ts:121-123`) parks the chunk (`task_name='enlarging'`, `dispatched_at null`) under the chunk's FOR UPDATE. |
| C4 | The enlarge task handler | `enlarge.ts:315-444 handleEnlargeTask` | stopped on failed or done batch (`:328`); settled if not queued (`:332`); off (`:335`); job remap to route (`:339`); progress refresh on every parked chunk of the batch (`:348`); loads photo and matte (`:354-359`); region (`:362`); missing images (`:364-369`); claim (`:376-381`, `claim() :452-459`); re-check under claim (`:385`); per-model cap and output side (`:393-395`); the one call (`:401`); exact-size check (`:413`); upload with metadata (`:417`); `next_image` 503 (`:422-425`); done settle (`:427`); catch: terminal or retry (`:429-444`). |
| C5 | The settle (only writer of `x2_uri`, `x2_attempts`) | `enlarge.ts:468-498 settle` | locks the product's chunks (`lockProductChunks`, `pipeline/enlargement.ts:162-167`), writes the photo (failure `:476-482`, done or partial `:483-485`, other `:486-488`), cost rows, `unparkSettledChunks` (`pipeline/enlargement.ts:175-181`), then `topUpWindow` and `refreshBatchProgress`. |
| C6 | In-process runner (evals, real runs, QA check) | `chunk.ts:95-113 deliverChunkToEnd / enlargeInProcess` | runs the parked chunk's queued photos through `handleEnlargeTask` up to 8 times each, then the safety-net unpark (`:111`). Used by `catalog-real-run.ts:180`, `catalog-eval.ts:154`, `catalog-qa-check.ts:64`. |
| C7 | Render-stage gap re-queue | `chunk.ts:253-260` (call), `:577-604 requeueEnlargementGaps`, `enlarge.ts:267-308 enlargementGaps` | before rendering: lists gaps (not_queued, another_upscaler, stale_image, queued) over **pending** outputs only (`enlarge.ts:271-272`); resets the job (`chunk.ts:590`: `x2Uri null, x2Attempts 0`); enqueues round `step+1` (`:594`); parks under its own lock (`:595-602`). |
| C8 | Lane-aware stale re-send | `packages/core/src/catalog/pipeline/dispatch.ts:198-216 resendStaleEnlargements`, called from `recoverBatchChunks :171-189`, which the sweep runs only for processing batches (`apps/worker/src/catalog/sweep.ts:88-89`) | unparks settled chunks (safety net), then any parked chunk with `progress_at` older than `ENLARGE_STALE_MS` (60 min, `pipeline/enlargement.ts:31`) takes the next step and its queued photos are sent again as that round. Unbounded rounds. |
| C9 | Queue and task plumbing | `packages/core/src/tasks.ts:43,55` (route), `:106` (1800 s deadline), `:129` (`enlarge-<sourceImageId>-<round>`), `:159-161` (lane by batch class), `:248` (ALREADY_EXISTS counts as sent); `infra/lib/queues.sh:27` (`--max-attempts=9`, 30-300 s back-off), `:45-49` (lanes) | one task per photo and round; the queue retries 503s nine times then drops the task. |
| C10 | The service call | `packages/core/src/catalog/enlarge.ts:54-90` (`EnlargeError` kinds busy, unavailable, timeout, bad_input, rejected, server; timeout clamped to the deadline, floor 60 s), `enlarge.ts:60-67 workerEnlargeCall` | one attempt per delivery. |
| C11 | The service | `services/matting/app.py:557-594 upscale`, `:429-438` (fixed ONNX tile, `UPSCALE_OVERLAP`) | per-model caps (`:577-580`), model unavailable 503 (`:572,584`), exact scale, JPEG q95 4:4:4, tiles under `INFERENCE_LOCK` (`:119`). |
| C12 | Batch dispatch and the sweep | `dispatch.ts:41` (`PROCESSING_STATUSES` matting, rendering, qa), `:140` (dispatchChunks serves processing batches only), `:144` (active count: `dispatched_at IS NOT NULL`), `:148` (`notParked()`), `:176-177` (lost-task rule, no park filter), `:225-226` (unstarted rule: `task_name IS NULL`, processing only); `sweep.ts:17` (2 h), `:88-89` (recovery for processing batches), `:100-109` (no-progress fail over `updated_at`, `started_at`, `finished_at`) | the batch machinery the lifecycle must live inside. A parked chunk on a done batch is reached by nothing; a batch whose only work is a parked chunk is failed after 2 h. |
| C13 | Throughput model | `apps/worker/src/catalog/scale-model.ts`, `scale.test.ts` | models the park and unpark and one task per photo. |

### 1.2 Reading, reusing and priming

| # | Path | Where | What it does |
|---|---|---|---|
| R1 | Stored-image identity check | `enlarge.ts:109-120 storedImageState` | ok, stale or missing from object metadata (`sourceSha256`, `upscaler`, `region`, `matte`: `X2_METADATA :88`) against the photo as it is now. The only identity rule, called from three places with different inputs (C4 `:366`, C7 `:302`, R2 `:160`). |
| R2 | Render-stage priming | `chunk.ts:441-444` -> `enlarge.ts:145-175 primeStoredEnlargement` -> `packages/core/src/catalog/upscale.ts:265-274 primeSourceX2` | downloads each image of the job and primes the per-upscaler cache, which is a WeakMap keyed by the prepared photo's `rgb` Buffer object (`upscale.ts:255-260`). Its boolean result is ignored at `chunk.ts:443`. |
| R3 | The render gate | `render.ts:647-655` (`needsUpscaler`, `routedUpscale :722-729`: the first candidate of `upscalersFor` (`upscale.ts:187-190`, x2 then x4 for scale <= 2.0, x4 only above) that has an image), `upscale.ts:277-296 sourceX2` (a stored upscaler's `upscale()` throws `StoredEnlargementMissingError` `:155`, caught at `:289-292` and turned into null), `upscaledRgb :305-318` (crop outside region -> null `:310`) | any null becomes the flag `enlargement_failed` plus the sentence; the plain image is still rendered and staged (`render.ts:645-646`). No distinction between "terminally failed" and "not primed yet". |
| R4 | Resume shortcut | `chunk.ts:461` | a pending output whose staged file already has the row's byte count is re-marked from its old flags without a render; it keeps an old `enlargement_failed` even when the image exists now. |
| R5 | Ladder priming | `apps/worker/src/catalog/auto-resolve.ts:47-52 preparePrimed` | re-prepares the photo and primes (same as R2) for the QA-stage ladder; the render-stage ladder gets `prepared` and `matte` from the render loop (`chunk.ts:492`). `flushCutPhoto` (`qa-stage.ts:255`, `auto-resolve.ts:252`) calls `renderAllChannels` directly. |
| R6 | Live-output reuse at publish | `packages/core/src/catalog/pipeline/publish.ts:53 renderKeys`, `:196-204 configuredUpscalerIds`, `upscale.ts:138-141 upscalerKey` (`UPSCALER_VERSION` `:26`) | a live output with the same render key (model, export hash and version) is reused rather than re-made. |
| R7 | Web preview and evals | `apps/web/lib/catalog/preview.ts:8,77`, `packages/core/src/catalog/evals/enhancement.ts:34` | count planned images by the configured upscaler ids; evals name candidates. Read-only. |

### 1.3 Invalidating

| # | Path | Where | What it does |
|---|---|---|---|
| V1 | Ladder matte persistence | `auto-resolve.ts:201-208` | when a second-matte or passthrough variant "wins" on any channel, the photo's `matte_uri`, `matte_model`, flags are overwritten. Nothing touches `x2_*`; no re-queue follows (C7 runs only at the render stage and only over pending outputs). |
| V2 | Render-stage gap reset | `chunk.ts:590` | resets a job in place (attempts 0) for any gap reason. |
| V3 | Replacement photo | `packages/core/src/catalog/decisions.ts:79-112 completeReplacement` | a new source row (`replaces_id`), a one-source matte chunk enqueued directly (`:110`, `dispatched_at now`), `lockBatchId` set. The replaced row's `x2_*` stay. |
| V4 | Upscaler off mid-batch | `enlarge.ts:335` | the handler clears `x2_model`; nothing reaches a chunk that is already parked. |
| V5 | Model or x4 route change | `enlarge.ts:339` (`jobForRoute`), C7 `another_upscaler`/`not_queued` | the configured env route always wins; a stored image of another upscaler is re-made; two worker revisions ping-pong. |

### 1.4 Judging quality or readiness

| # | Path | Where | Verdict on a missing or stale image |
|---|---|---|---|
| J1 | Render | `render.ts:655` | **fail** (flag `enlargement_failed`, hold). Correct only when terminal. |
| J2 | Ladder `ok()` | `auto-resolve.ts:53` | **pass** (status ok, compliance ok, jpeg present: the flag is ignored). A variant rendered without its enlargement is adopted, written `needs_attention` and its matte persisted (V1). The open P1-1 path, at `qa-stage.ts:277` and `chunk.ts:492`. |
| J3 | QA stage judging | `qa-stage.ts:114 NOT_JUDGED`, `:133` (candidates with `qa_scores` null: a redelivery never re-judges), `:240 repairable` | an `enlargement_failed` output is judged and may enter the ladder. |
| J4 | Triage | `packages/core/src/catalog/qa/triage.ts:24 RENDER_HOLD_FLAGS`, `:79 hold("not_enlarged")` | **hold**. Correct. |
| J5 | Publish | `publish.ts:119-121` | a product with a held output is `pending_attention`. Correct. |
| J6 | Operator "Use as is" | `decisions.ts:27-30 decisionScope` (siblings across channels unless every problem flag is a channel flag), `:44-57 applyDecision` (refuses only `failed`), `apps/web/lib/catalog/decisions.ts:20-26` | sets `staged` on the whole scope, publishes each output's own plain-resize staging file, and `enlarged_without_upscaler` (`invariants/checks.ts:79-91`) then fires on them. |
| J7 | Finalize and re-open | `apps/worker/src/catalog/finalize.ts:30-61` (`not_ready` re-queued after 30 s with `reopen`), `docs/solutions/finalize-reopen.md`, `apps/worker/src/catalog/publish.ts:18` | a parked chunk counts as running, so finalize waits and re-queues itself every 30 s. Correct, but with C12 it never ends on a done batch. |
| J8 | Status, Ops, counts | `apps/worker/src/catalog/deps.ts:116-120`, `packages/core/src/catalog/pipeline/status.ts:127,240`, `apps/web/lib/catalog/ops.ts:227-235` | read `x2_*` through the SQL predicates (`pipeline/enlargement.ts:101-108`). |
| J9 | Invariant | `invariants/checks.ts:79-91` | ERROR for a verified output above the batch's `minScale` without `upscaled`, scoped by `options.enlargement`. |
| J10 | Deploy-time probe | `infra/lib/services.sh:111-126`, `services/matting/tests/cloudrun_check.py` (sha256 and `instanceId` per call) | proves each model answers at its scale, byte-identical on a rerun. `apps/worker/src/catalog-smoke.ts` and `apps/worker/src/catalog/fault-proxy.ts` contain no enlargement case. |

### 1.5 States

An output (`catalog_outputs`): `pending` -> `staged` | `needs_attention` | `failed` | `skipped` -> `verified`;
`decision` null | `use_as_is` | `remove` | `replaced` (CHECK `0000_init.sql:142`, `schema.ts:479`). Enlargement
flags: `upscaled`, `enlargement_failed`. Product events `kind` has a CHECK too (`0000_init.sql:164`, `schema.ts:370`,
`types.ts:28 EVENT_KINDS`).

A photo's job today (`catalog_source_images.x2_*`, `pipeline/enlargement.ts:125-130`): `not_needed`, `queued`
(`in_flight` under `x2_claimed_at`), `done` (`partly_failed`), `failed`. A job is one row for up to two images, so
"attempts" and "claim" are shared by the x2 and the x4 image.

A chunk: `queued` (task_name null, dispatched) | `queued` parked (task_name `enlarging`, dispatched_at null) |
`running` | `done` | `failed`; stage `matte` | `render` | `qa`; `step` grows at every hand-off, park and re-send.

### 1.6 The three instances of the same gap

1. QA-stage ladder (`qa-stage.ts:277` -> `auto-resolve.ts:162-185 matteRound` -> `:111-115 render`): the variant's
   crops lie outside the stored region (`upscale.ts:310`), the render flags `enlargement_failed` (`render.ts:655`),
   `ok()` passes it, the output is written `needs_attention` and the new matte saved (`:201-208`). The outputs are no
   longer pending, so `enlargementGaps` (`enlarge.ts:271`) never sees them. Permanent, non-terminal hold.
2. Render-stage ladder (`chunk.ts:492`, trigger `failed_compliance`): the same `matteRound`, after the gap check of
   the same delivery already ran. Same outcome.
3. Any transient failure while priming (`chunk.ts:443` ignores the result; `enlarge.ts:169-172` logs a download or
   decode error as "missing"): the render holds a photo whose image is fine. Non-terminal hold, cleared only by a
   re-run.

The PR's test for P1-1 (`enlarge.test.ts:658-697`) changed `matte_uri` in the database and drove the render stage,
which is the one path that does re-queue; it never drove the ladder.

## 2. Invariants

The smallest set of rules that, always true, make every owner requirement hold.

- I1 Identity. An enlarged image is identified by `(prepared pixel hash, upscaler id with export hash, effective
  scale)`, where the prepared pixel hash is sha256 over `prepared.rgb` plus `width x height` (the exact bytes the
  service receives), and the effective scale is the model's factor (2 or 4) or, on the downscale route, factor x
  shrink. The image always covers the whole prepared photo. An image is never reused under another identity, and an
  identity is never served by an object whose metadata names another identity.
- I2 One owner. Enlargement state lives in one table (`catalog_enlargements`, one row per identity wanted by a batch
  for a photo) and is written only through the lifecycle module's functions. No other code reads object metadata or
  the table to decide readiness; it asks the owner and gets `ready`, `terminal` or `not_ready` per (photo, candidate
  list).
- I3 Completeness. For every pending output of a product in a batch that is not failed or cancelled, every identity
  its render may need is in exactly one of: `done` with an object that matches (ready); `queued` with a task in the
  queue or a parked chunk whose recovery will send it (not ready); `failed` because the upscaler itself failed on this
  input `ENLARGE_TASK_MAX_ATTEMPTS` (8) times, or failed without explanation (timeout, crash-shaped answer) while it
  answered health `ENLARGE_MAX_TIMEOUTS` (24) times, or the photo could not be prepared the same way
  `ENLARGE_MAX_IDENTITY_CHANGES` (3) times, or no route can make the output (terminal). A chunk is parked if and only
  if it has a wanted `queued` row.
- I4 Not ready is never a verdict. Every judge (render, ladder, flush-cut, QA, publish) treats `not_ready` as "do not
  decide now" (throw and let the delivery retry, or record the step as skipped), never as pass and never as fail.
  Only `terminal` may produce `enlargement_failed`; only `enlargement_failed` may hold a product for enlargement.
- I5 No silent plain resize. In a batch made with the enlargement stage, no output above the batch's threshold is
  staged or published without `upscaled` unless (a) the operator accepted it knowingly through "Use as is" after the
  plain warning (recorded as a decision and a product event; the invariant counts it and never flags it), or (b) the
  worker-wide rollback switch `UPSCALE_MODEL=off` was used, in which case the outputs are plain on purpose and the
  invariant still reports them (rollback note in spec 18 section 10). Nothing else stages a plain image above the
  threshold.
- I6 Bounded attempts, unbounded patience. Per identity and per operator retry: at most 8 counted attempts and 24
  counted unexplained failures while healthy; delays (busy, down, paused, quota, deploying, in flight) never count
  and are retried with exponential back-off up to a 15 min ceiling, for as long as it takes. A failed call is a
  delay only when the re-probe right after it positively proves the service absent (connection refused, a DNS
  error, or the service's own 503 body: not loaded, paused); a probe that times out, or meets a 429 or "no
  instance", proves nothing, so the failure counts (3.4 step 9). Per photo per batch at most 2 identities (x2 and x4
  of the pinned route) plus at most 3 identity releases. These bounds exist for correctness (no runaway loop, no
  duplicate work), not to save money: cost is not a constraint (owner, 2026-10-30). Every repeating path either makes
  progress or counts (3.10).
- I7 Every change of inputs is a new identity, never a reset. A replaced photo, a changed prepare, the rollback switch
  release the old rows (`wanted=false`, status kept) in the same transaction that makes them unwanted, so a parked
  chunk never waits on an unwanted row and a terminal row stays terminal when it is wanted again.
- I8 No deadlock, no stranded chunk, no time-based failure. Every parked chunk either has a live task for a wanted
  `queued` row, or the recovery (which runs for every batch with a parked chunk except failed and cancelled) re-sends
  it within `ENLARGE_STALE_MS` of the lane going quiet; when the last wanted `queued` row of a chunk settles, the chunk
  is unparked in that transaction and, on a batch that is not processing, enqueued directly. No sweep, timer or
  deadline fails, holds or re-routes a batch, chunk or output because an enlargement is waiting; a legitimate wait of
  20 hours or more is normal.
- I9 Pinned route. A batch uses the route recorded at Start for its whole life (`options.enlargement`: model, x4Model,
  minScale). The worker's env route applies to new batches only. The only override is the rollback switch
  `UPSCALE_MODEL=off`.

Owner module and the single function. Core, pure: `packages/core/src/catalog/pipeline/enlargement.ts` (identity,
states, SQL predicates, the park and unpark rules, `releaseEnlargements`). Worker, with I/O:
`apps/worker/src/catalog/enlarge.ts`, which exports exactly three entry points for the rest of the worker:

- `reconcileEnlargements(deps, scope, mode)`: for a product (or a photo), computes the wanted identities from the
  photo's prepared pixels, the batch's pinned route and the channel plan; upserts wanted rows, releases unwanted ones,
  sends tasks (mode `queue`) or only reads (mode `check`), and returns `{queued: boolean, terminal: Map<photo, reason>}`
  so the caller can park. Called by the matte stage end, the render stage per product, the operator retry (through
  core), `enlargeInProcess`.
- `primeReadiness(deps, source, prepared)`: on the exact `prepared.rgb` buffer the render is about to use and the
  `deps.upscaler` / `deps.upscalerX4` objects it is bound to, heads and downloads the photo's wanted `done` rows and
  primes each one, marks a `failed` row terminal in the cache, and returns `EnlargementReadiness`. Called right after
  a photo is prepared in the render loop, in the ladder's `preparePrimed`, and in `flushCutPhoto`.
- `handleEnlargeTask(deps, body)`: makes one identity's image, the only writer of `done` and `failed`.

Everything else (`chunk.ts`, `auto-resolve.ts`, `qa-stage.ts`, `deps.ts` counts, `ops.ts`, `status.ts`, the sweep,
`decisions.ts`) consumes the readiness or the table's columns through functions exported by the two files.
`storedImageState`, `primeStoredEnlargement`, `enlargementGaps`, `requeueEnlargementGaps`, `jobUpscalers` and the
comma job are removed.

## 3. The mechanism

### 3.1 Table `catalog_enlargements` (migration 0006, additive)

| column | type | meaning |
|---|---|---|
| id | uuid pk | the row; task ids use it |
| batch_id, product_id, source_image_id | uuid, indexed by (batch_id), (source_image_id) | whose |
| upscaler | text | upscaler id with export hash (`swinir-x2+cpu@f477a052` form, `upscalerIdentityId`) |
| factor | int | the model's factor, 2 or 4 |
| scale | real | the effective scale: `factor` on the direct and tile routes, `factor x shrink` on the downscale route |
| out_w, out_h | int | the exact output size in pixels, fixed at insert by `enlargedDims` (3.2); the one truth the handler, the validator and the render share |
| route | text | `direct`, `tiles`, `downscale`, `downscale_tiles` (CHECK) |
| pixel_hash | text | sha256 of `prepared.rgb` + `${width}x${height}`, 16 hex |
| identity_hash | text | 16 hex of sha256(`pixel_hash|upscaler|scale`) |
| status | text | `queued`, `done`, `failed` (CHECK). Nothing else. |
| wanted | boolean default true | true while some pending output of this batch may need it; `false` = released |
| attempts | int default 0 | counted upscaler failures on this input (bad_input, rejected, server, a reply the validator refuses, a corrupt raw file) |
| timeouts | int default 0 | counted unexplained failures while the service answered health right after: timeouts and crash-shaped answers (connection reset, 5xx without the service's body) |
| delays | int default 0 | delay answers, for visibility only, never a bound |
| probe_timeouts | int default 0 | consecutive health-probe timeouts; reset on any probe success; at 3 the call is made without the probe (3.4 step 7) |
| identity_releases | int default 0 | release events with `identity_changed` on this row; never reset by a re-want; summed per (batch, photo) against `ENLARGE_MAX_IDENTITY_CHANGES` (3); reset by Try again |
| sends | int default 0 | task sends; the task-id counter, monotonic for the row's life |
| retries | int default 0 | operator "Try again" clicks |
| claimed_at timestamptz, claim_token text | | the in-flight claim and who holds it |
| tiles_done | int default 0 | tile route progress (3.2) |
| uri text, error text, error_kind text, created_at, updated_at | | |

Unique index `(batch_id, source_image_id, identity_hash)`. Rows are per batch; objects are per identity and shared
across batches (3.1 key). The `x2_*` columns of 0005 stay (nullable, unused by new code; a later cleanup drops them).
Migration 0006 is `CREATE TABLE IF NOT EXISTS` plus indexes, `lock_timeout 10s`, and drops and re-creates
`catalog_product_events_kind_check` with two new kinds, `enlargement_retried` and `plain_accepted` (old code never
writes them, so the swap is additive). Safe on the live database: no rewrite of existing tables.

Object key: `enlargedPath(prefix, pathKey, n, upscaler, scale, identityHash)` =
`<prefix>/derived/<pathKey>/<pathKey>_<n>.<upscaler slug>.s<scale>.<hash>.jpg`, tiles at `<key>.tile-<i>.jpg`.
Metadata: `pixelHash`, `upscaler`, `scale`, `identity`. Same identity, same key: a re-delivery, a re-wanted row or a
second batch finds the object and settles without a call. The assets bucket keeps `derived/` objects for at least
180 days (bootstrap lifecycle; no cost constraint); F30 covers a deleted object anyway.

### 3.2 The route for one identity (whole photo, always)

The image covers the whole prepared photo, so a matte change (every ladder step, the judged cut, a second cut-out)
never changes the identity. One consistent set of numbers, all in `packages/core/src/catalog/pipeline/enlargement.ts`
and tied to the shape by a test:

- Service caps per call (measured, `shape.sh`): `upscaleMaxPixels(2)` = 8,000,000 and `upscaleMaxPixels(4)` =
  6,400,000 source pixels. The slowest measured rate is 104 s/MP at 4 vCPU (800x1200 p95 100 s); 8 MP is about
  830 s, under the 1740 s timeout with margin.
- Worker output limit, every route: `ENLARGE_MAX_OUTPUT_PIXELS` = 64,000,000 output pixels (192 MB decoded RGB).
  A shape test asserts `3 B x 64 MP x 2 buffers x WORKER_CONCURRENCY <= 50% of WORKER_MEMORY` (1.15 GB of 4 GiB at
  concurrency 3); raising `WORKER_MEMORY` raises the limit in proportion (cost is not a constraint). Every output
  side stays under the JPEG limit of 65,500 px because 64 MP at any aspect used here is at most 16,000 px wide.
- The effective scale of a photo of `P = width x height` pixels at factor `f`: `scale = min(f, sqrt(64,000,000 / P))`,
  rounded down to 3 decimals. The shrunk input is `shrunk = (floor(width x scale / f), floor(height x scale / f))`
  (the photo itself when `scale = f`), and the output size `enlargedDims(width, height, f, scale)` is exactly
  `f x shrunk` in both axes (the model enlarges the shrunk photo by its integer factor, so nothing else is possible),
  stored on the row as `out_w, out_h`. `scale` is never used to compute a size; the render maps by
  `sx = out_w / width`, `sy = out_h / height`. The direct limit per model is therefore
  `min(upscaleMaxPixels(f), 64,000,000 / f^2)`: 8 MP for x2, 4 MP for x4.
- `neededScale` is the largest planned scale of the photo over the batch's channels (`enlargementFactors`) plus 5%,
  so a ladder variant of nearly the same box still fits.

`enlargementRouteFor(width, height, f, neededScale)` picks, in quality order:
1. `direct`: `scale = f` and `P <= upscaleMaxPixels(f)`: one call.
2. `tiles`: `scale = f` and `P > upscaleMaxPixels(f)` (only x2 can get here: 8 MP < P <= 16 MP). The photo is cut
   into a grid of tiles each `<= upscaleMaxPixels(f)` with `ENLARGE_TILE_OVERLAP` 64 px of overlap (the service's
   own internal tile overlap is `UPSCALE_OVERLAP`, so a worker seam is the same kind of seam the service already
   makes). Each tile is one call and one object (`.tile-<i>.jpg`, metadata names the identity and the tile index).
   The handler makes missing tiles in order: **at least one tile per delivery, whatever the budget says**, then more
   while `ENLARGE_TILE_BUDGET_MS` (deadline minus the per-model p95 of one tile minus margins) allows, then answers
   503 `more_tiles` (a delay, not an attempt; each delivery made progress). When every tile exists it downloads them,
   crops the overlap, stitches with sharp, validates the whole (3.3), uploads it, settles `done`. Idempotent by tile
   key; deterministic because each tile is.
3. `downscale` (and `downscale_tiles`): `scale < f` and `scale >= neededScale`. Lanczos shrink in the worker to
   `shrunk`, then route 1 or 2 on the shrunk photo (x4: the shrunk photo is at most 4 MP, direct; x2: at most 16 MP,
   direct or tiles); the reply is `f x shrunk` = `(out_w, out_h)`. The render maps a crop by `sx = out_w / width`,
   `sy = out_h / height` (fractional, for example 7996 / 2400 = 3.3317): it extracts the outward-rounded box from the
   enlarged image and resizes it to the target with the exact fractional offset, so colour stays aligned with the
   alpha within 0.5 output px (T69).
4. no route: `scale < neededScale`. Terminal before any call, reason "This photo is too large to enlarge for
   <channels>: W x H px." (no model id). The only enlargement hold that is not an upscaler failure.

Worked examples (the test fixtures of T28, T53, T54), each as `photo at xf: scale, shrunk, out_w x out_h, route`:
- 3000x3000 at x2: scale 2, shrunk 3000x3000, out 6000x6000, tiles (2).
- 4000x4000 at x2: scale 2, shrunk 4000x4000, out 8000x8000 (64 MP), tiles (3).
- 5000x4000 at x2: scale 1.788, shrunk 4470x3576 (16 MP), out 8940x7152, `downscale_tiles`; serves a need up to 1.70.
- 2400x2400 at x4: 5.76 MP, under the 6.4 MP service cap but the x4 output would be 92 MP; scale 3.333, shrunk
  1999x1999 (`floor(2400 x 3.333 / 4)` = `floor(1999.8)`), out 7996x7996, direct; `sx` = 3.3317; serves a need up
  to 3.17 and holds at 3.5.
- 6000x6000 at x2: scale 1.333, shrunk 3999x3999, out 7998x7998, `downscale_tiles`; a need of 1.2 (1.26 with slack)
  is served, a need of 1.4 (1.47) holds.
- 10000x10000 at any factor: scale 0.8, always held.

Why tiles before downscale: tiles keep every source pixel; downscale loses some. Why not crop to the product region:
the region depends on the matte, and the matte changes inside the ladder (section 1.6); whole-photo identities make
that whole class of bug impossible. The price is that a very large photo with a small product (above 64 MP / need^2
pixels) is held although a crop route could serve it; that is a residual risk (section 8) with a count on Ops, not a
design gap, because every real brand source today is at most 1.2 MP and the direct route serves all of them.

### 3.3 Readiness, the tri-state every judge honours

`EnlargementReadiness` for a photo: `{ ready: Set<Upscaler>, terminal: Map<Upscaler, reason>, notReady: boolean }`,
evaluated per candidate list: `upscalersFor(scale)` gives `[x2, x4]` up to 2.0x and `[x4]` above; the render is ready
for a crop when any candidate in its list is primed, terminal when every candidate in its list is terminal, not ready
otherwise.
- `ready`: the row is `wanted` and `done`, `validateEnlargedObject` accepts the object, the cache is primed on this
  `prepared.rgb`.
- `terminal`: the row is `failed` (cache entry resolves null: `markEnlargementTerminal`).
- `notReady`: `queued`; or `done` with an object the validator refuses (then `primeReadiness` invalidates it: the
  row goes back to `queued` with `attempts+1`, `error_kind='invalid_object'`, the object key is overwritten by the
  next make, and the task is sent in the same pass under `lockProductChunks`); or a storage error on head or
  download (5xx, network: `EnlargementNotReadyError` with `transient=true`, no row change).

One validator, `validateEnlargedObject(bytes, row)` in core, is the only judge of a stored object, used by the
handler on its own reply before the upload, by the handler after a head (step 5, on the downloaded bytes), and by
`primeReadiness`: metadata `identity` equals the row's `identity_hash`; the JPEG decodes; its size is exactly
`(out_w, out_h)` from the row (never recomputed from `scale`); a tile object additionally names its index and has
the tile's expected size. The handler and the render can therefore never disagree about an object. A product whose
reconcile returned `queued=true` is skipped in the render loop (no `primeReadiness`, no render), so `sourceX2` throws
only on a transient storage error.

Core changes that make the render honour it: `sourceX2` for a stored upscaler with no cache entry throws
`EnlargementNotReadyError` (it no longer catches `StoredEnlargementMissingError` into null, `upscale.ts:289-292`);
`routedUpscale` lets it propagate. The render's `enlargement_failed` branch (`render.ts:655`) is then reachable only
through terminal entries. In `chunk.ts` the per-output catch (`:485`) rethrows `EnlargementNotReadyError`; the
delivery answers 503 `retry` **without** `recordError` (a not-ready is not a chunk error and never counts toward
`CHUNK_MAX_ERRORS`); the next delivery parks or renders. The ladder's `render()` (`auto-resolve.ts:111-115`) catches
it as `LadderStopped` (the step is recorded "skipped: enlargement not ready"), `flushCutPhoto` records `flush_cut`
as skipped the same way, and `ok()` becomes `status ok && compliance ok && jpeg && !flags.includes("enlargement_failed")`,
so a variant without its enlargement is never adopted and never persists a matte.

### 3.4 The handler, per row

Body `{batchId, productId, enlargementId}`; task id `enlarge-<enlargementId>-<sends>`. Steps:
1. Load row and batch. Row missing, not `queued`, or not `wanted` -> 200 `settled` (a row in flight under another
   token still settles, step 9). Batch `failed` or `cancelled` -> 200 `stopped`. Any other batch status, `done`
   included, proceeds (operator retry and replacement on a done batch).
2. Rollback switch: `UPSCALE_MODEL=off` on this worker -> `releaseEnlargements` for the batch's queued rows of this
   product, unpark its chunks under `lockProductChunks`, 200 `off`, no call.
3. Refresh `progress_at` on every parked chunk of the batch.
4. Prepare the photo (download raw, `prepare`, which may call the matting service's `convert`): a storage or matting
   5xx, connection error or timeout -> 503 `unavailable` (delay, no count); a raw file that does not decode, or a raw
   object that no longer exists -> counted (`attempts+1`, `error_kind='bad_source'`), terminal at 8. Compute the
   pixel hash; a mismatch with the row -> the row is released (`wanted=false`, `error_kind='identity_changed'`, status
   kept, `identity_releases+1`), the product's chunks unparked, 200 `settled`; the next render delivery wants the new
   identity (a re-want of an existing row keeps its `identity_releases`). When the sum of `identity_releases` over
   this batch and photo already equals `ENLARGE_MAX_IDENTITY_CHANGES` (3), the row is instead `failed` with "This
   photo could not be prepared the same way twice." (terminal; Try again resets the sum to 0). Release events are
   counted, not rows, so a `prepare` that alternates between two results reaches the cap on its 4th mismatch.
5. Head the object; when it exists, download it and run `validateEnlargedObject` (3.3): accepted -> settle `done`
   (no call); refused -> `attempts+1`, `error_kind='invalid_object'`, and the make below overwrites it.
6. Claim (`claimed_at` free or lapsed by `ENLARGE_CLAIM_MS`, set `claim_token`); a live claim by another token -> 503
   `in_flight` (delay). Re-head under the claim.
7. Health: `GET <upscale>/health` with a timeout of `UPSCALE_COLD_START_S` + 60 s (`UPSCALE_COLD_START_S` is
   measured by the gate as the time from a scale-to-zero state to the first `/health` 200 and recorded in `shape.sh`;
   default 120 s until measured: the ladder saw about 20 s of model load on top of the container start). A 503 or
   connection refused -> 503 `unavailable` (delay, `delays+1`, no call, `probe_timeouts` unchanged). A probe timeout
   -> `probe_timeouts+1` and a delay, except that at 3 consecutive probe timeouts the call is made anyway (step 8)
   and its result is classified by the re-probe in step 9. Any probe success resets `probe_timeouts`.
8. The route (3.2): the next unit of work (the whole photo, or at least one and then as many tiles as the budget
   allows), with `deadlineAt`.
9. Settle, guarded on `claim_token` and `status='queued'` (not on `wanted`: an in-flight row that was released still
   writes `done`, its object and its cost rows; nothing reads it until it is wanted again):
   - success: the reply passes `validateEnlargedObject` -> upload, `done`, `uri`, cost rows per call; `more_tiles`
     -> `tiles_done`, 503 (delay with progress).
   - counted failure (`attempts+1`): `bad_input`, `rejected`, `server` with the service's own error body, a reply the
     validator refuses. At 8 -> `failed`, `error`, `error_kind`, ERROR line, cost rows.
   - unexplained failure: a timeout, a connection reset, a 5xx without the service's own body, or any failure of a
     call made without a probe (step 7 at 3). The handler re-probes `/health` (same timeout). **The failure counts
     (`timeouts+1`) unless the re-probe positively proves the service absent**: connection refused, a DNS error, or
     the service's own 503 body (model not loaded, paused). A re-probe that answers 200, times out, or meets a 429
     or Cloud Run's "no instance" 503 proves nothing about this input (a full fleet at concurrency 1 answers 429 to
     a probe all day), so the failure counts: the service is up, and a call that died on this input while the
     fleet was full is still a call that died on this input (a hang, an instance killed by this input, a native
     crash). At 24 -> `failed` ("the enlargement did not finish 24 times"). Only positive proof of absence makes it
     a delay (the service itself is down, deploying or restarting).
   - delay (`delays+1`, never terminal): `busy` (429, Cloud Run 503 no instance), `unavailable` (the service's own
     503: model not loaded, paused, deploying), connection refused, DNS, quota exhaustion (instances cannot start),
     an unexplained failure whose re-probe proved absence, `in_flight`, `more_tiles`. Answer 503; the queue retries with
     exponential back-off (3.8) for as long as it takes.
   Every settle locks the product's chunks first (id order), then the row, unparks the chunks with no wanted `queued`
   row left in that transaction, then (batch processing) `topUpWindow`, or (batch not processing) `tryEnqueueChunk`
   for each unparked chunk, then `refreshBatchProgress`.

### 3.5 Reconcile, per product

1. Photos: the product's current sources of the batch (replaced ones excluded), with a matte, not chart images, with
   their prepared pixels (the matte stage holds `shots` with `rgb`, `chunk.ts:412`; the render stage has `prepared`
   per photo; the operator retry prepares once in the worker's render delivery, not in the web).
2. Wanted set: `enlargementFactors` with the batch's pinned route (`routeFor(batch)` = `options.enlargement`; a batch
   without one was started before the stage: no wanted set, plain path, outside the invariant, reported by Ops as
   "started before enlargement"); per photo and factor one identity from 3.2.
3. Under the chunk claim, then `lockProductChunks` (product chunks in id order), then the rows: upsert wanted rows
   (`wanted=true`, status untouched when the row exists); release (`wanted=false`) every row of the product in this
   batch that is not in the wanted set, including rows of replaced sources (`replaces_id` chain). Mode `check` reads
   only.
4. Mode `queue`: send a task for every wanted `queued` row with its current `sends` (the same task id on a repeat, so
   Cloud Tasks deduplicates; `sends` is bumped only by the stale re-send, 3.8). The matte stage then parks the chunk
   if any wanted row is `queued` (I3). In the render loop, reconcile runs per product before any photo of it is
   prepared; a product with `queued=true` is skipped entirely (no `primeReadiness`, no render, no 503), the loop goes
   on to the next product, and the chunk parks at the end of the delivery (outputs already rendered in that delivery
   stay as written; the shortcut skips them next time). A render delivery therefore never busy-loops on a waiting
   enlargement.
5. Returns `{queued, terminal}`; readiness is not returned (it belongs to the buffer, 3.3).

Lock order everywhere: product row (decisions only) -> product chunks by id -> enlargement rows by id. The settle
never takes a chunk claim; a chunk delivery never waits on a settle.

### 3.6 Operator actions

- "Use as is" when any output in `decisionScope` carries `enlargement_failed` (owner, 2026-10-30: "Allow, with a
  clear warning"): the API answers 409 `plain_warning` with the channels unless the request carries
  `acceptPlain: true`. The UI shows: "This photo could not be enlarged. If you use it as it is, the <Centrepoint and
  Styli> images will be stretched and may look soft. Use it anyway?" with "Use anyway" and "Cancel". On "Use anyway"
  the decision is applied to the scope exactly as today (`decision='use_as_is'`, `decided_by`, `decided_at`, status
  `staged`), each output publishes its own staging file (its own key, its own bytes: never a sibling's), the flag
  `enlargement_failed` stays on the output as the record of why it is plain, and a product event
  `plain_accepted` {n, channels, actor} is recorded. The invariant `enlarged_without_upscaler` excludes outputs with
  `decision='use_as_is' AND flags @> '["enlargement_failed"]'`, and a new INFO check `plain_accepted_outputs` counts
  them (visible on Ops, never an error). Nothing stages a plain image without this click. The copy never names a
  model. The 400 for `failed` outputs is unchanged.
- "Try again" is not an output decision (the `decision` CHECK and `undecided()` stay as they are). `retryEnlargement`
  lives in `packages/core/src/catalog/decisions.ts`: in one transaction, lock the product (same rules as
  `lockProduct`), take the photo's undecided outputs of the batch with `enlargement_failed`, require at least one
  `failed` wanted row (else 409 "Nothing to try again."), reset those rows (`status='queued'`, `attempts=0`,
  `timeouts=0`, `retries+1`, `claimed_at=null`, `tiles_done=0`), reset the outputs to `pending` (clear `qa_scores`,
  keep `compliance.auto_actions`, drop `enlargement_failed` and `reason`), lock the product to the batch, insert a
  one-source chunk at stage `render` parked (`task_name='enlarging'`, `dispatched_at=now()`, step 0), record event
  `enlargement_retried` {n, retries, actor}, and send the rows' tasks through core `enqueueEnlargements`. No cap on
  clicks: each is a human act, logged, and costs at most 8 attempts plus 24 timeouts. From there the ordinary path
  runs: enlarge -> unpark -> (done batch) direct enqueue -> render -> QA -> publish (`changed=true` re-opens a done
  batch, `finalize-reopen.md`). A photo retried and failed again is held again and can be Used, Removed or Replaced.
- "Remove" and "Replace" are unchanged, except that `completeReplacement` and `applyDecision(remove)` call core
  `releaseEnlargements` for the photo's rows of the batch when the photo has no undecided or pending output left, and
  unpark the product's chunks (`unparkSettledChunks`), so a parked chunk never waits on a thrown-away photo.

### 3.7 Everything else

- QA stage: `enlargement_failed` joins `NOT_JUDGED` and is excluded from `repairable`: no judge call on an image
  whose hold cannot change, no ladder churn.
- Resume shortcut (`chunk.ts:461`): applies only when the row's flags do not include `enlargement_failed`; such an
  output is re-rendered (readiness decides again).
- Ladder variants that need an identity the batch did not want (a second matte moves the box across 2.0x, or above
  the threshold): the step is recorded "skipped: enlargement not ready" and no matte is persisted; the output keeps
  its original hold (`failed_compliance` or the judge's flag), which the operator resolves. Counted in the run report.
- `deps.ts` counts and `ops.ts`: from the table, scoped to batches not failed or cancelled (`wanted AND
  status='queued'`, `status='failed' AND wanted`), plus "waiting more than 20 h" and "plain accepted".
- Status copy, Ops copy, triage, `low_resolution`: unchanged.
- `finalize.ts`: `not_ready` re-queues after 10 min instead of 30 s when every running chunk of the batch is parked
  (a done batch waiting hours on an enlargement makes 6 finalize tasks an hour, not 120).

### 3.8 Park, dispatch, sweep and queue (the batch machinery)

- Park: `task_name='enlarging'`, `dispatched_at=now()` (not null, so 8d4f940's dispatch, which picks
  `dispatched_at IS NULL`, never sends a parked chunk during the deploy shift; its lost-task rule requires
  `task_name IS NULL`, so it skips them too). The new `dispatchChunks` waiting set (`:148`) already has
  `notParked()`; the active count (`:144`) and the lost-task rule (`:176-177`) get `notParked()` as well, so a parked
  chunk holds no window slot and is never re-sent as a stage task. Unpark: `task_name=null, dispatched_at=null`
  (processing batch: the window picks it up) or `task_name=null, dispatched_at=now()` plus `tryEnqueueChunk`
  (any other batch status except failed and cancelled).
- Recovery: the sweep runs `recoverBatchChunks` for processing batches as today and, in addition, for every batch
  that is not failed or cancelled and has any chunk in `queued` or `running` (a done batch with an operator retry,
  a replacement or a parked chunk): the lapsed-lease rule, the lost-task rule (a queued, unparked chunk whose task
  was queued more than 30 min ago and never started: the chunk whose direct enqueue failed after an unpark), the
  enlargement part (`unparkSettledChunks` safety net, `resendStaleEnlargements`, direct enqueue of unparked chunks).
  Only the window top-up stays processing-only. No chunk of a live batch is ever without an owner.
- Stale re-send: a parked chunk whose batch saw no enlarge delivery for `ENLARGE_STALE_MS` (60 min) has its wanted
  `queued` rows sent again with `sends+1` (a new task id), `progress_at` refreshed. After 20 sends of one row the
  pace drops to every 6 h and each re-send logs ERROR "enlargement task cannot be delivered" (visible on Ops): the
  row is never failed for it (owner: re-queue, never fail, work that has no live owner).
- Sweep no-progress rule (`sweep.ts:100-109`): a batch with a parked chunk is excluded from the 2 h rule (the
  lifecycle owns it), and `max(c.progress_at)` joins the GREATEST for every batch. A parked chunk cannot be swept.
- Enlarge queues: `--max-attempts=unlimited --max-retry-duration=0s --min-backoff=30s --max-backoff=900s
  --max-doublings=5` (the implementer verifies the flag forms against the current gcloud docs through Context7). A
  task lives until the handler answers 2xx; delays cost one HTTP attempt per back-off (at most 96 a day per row).
  Dispatch deadline stays 1800 s. The `in_flight` claim stays `ENLARGE_CLAIM_MS` 1800 s.
- Invariants: `parked_chunk_quiet` WARNING (parked, no enlarge delivery for 2 x `ENLARGE_STALE_MS`: the re-send is
  not running); `enlargement_waiting_long` INFO (wanted queued rows older than 20 h: visibility, never a failure);
  `plain_accepted_outputs` INFO (3.6).

### 3.9 Bounds (attempts, not time; correctness, not cost)

- Per identity per operator retry: 8 counted attempts, 24 counted unexplained failures while healthy, unbounded
  delays with a 15 min back-off ceiling. Per photo per batch: 2 identities (pinned route) plus at most 3 identity
  releases (events, not rows). Operator retries: unbounded, human, logged.
- Calls per identity to a terminal: at most 8 + 24 = 32 (plus tiles: at most `tiles x 32`, every tile object kept, so
  a retry re-makes only missing tiles). A succeeding identity costs exactly one call per tile (one call on the direct
  route). A second batch of the same photo costs nothing (object by identity). A call that is made without a probe
  (3 probe timeouts) or whose failure is unexplained is always classified by a re-probe, so no paid call repeats
  without a counter unless the service is in fact down.
- Time to terminal: none for delays. Counted failures can reach terminal in minutes (a deterministic 400) or, for
  hangs, 24 x 30 min of service time spread over as long as the queue's back-off makes it.
- Money: no ceiling (owner). About USD 3 was spent on the ladder; the live run below is roughly USD 15-40 at 4 vCPU
  16 GiB x about 100 s per call, and that number is reported, not judged.
- The real limit is GCP quota, not money: Cloud Run CPU allocation in asia-south1 is 190 vCPU, of which 187 are
  assigned (16 x 4 for catalog-upscale, matting at 4 instances, worker, web). Request an increase to 400 vCPU
  ("Cloud Run Admin API: CPU allocation, per region, asia-south1") so that `UPSCALE_MAX_INSTANCES` can go to 32
  (removes most `busy` delays) and `MATTING_CPU_MAX_INSTANCES` back to 16. Until it is granted the design behaves as
  now: `busy` is a delay, batches wait, nothing fails. Cloud Tasks limits (500 dispatches/s per queue, millions of
  tasks) are far above the lanes' 0.075/s. Cloud SQL db-f1-micro connections are unchanged (the handler holds one
  short transaction per settle).

### 3.10 Termination argument

Every path that can repeat work either makes progress (the state moves toward `done`) or counts toward a terminal
bound for that identity. The only repeats that neither progress nor count are waits on a dependency whose absence
is positively proven (the upscale service answers connection refused, a DNS error or its own 503 body; storage
answers 5xx; the queue is paused); each costs no service call, is paced by the back-off, and ends when the
dependency returns. Anything short of proof (a probe timeout, a 429, Cloud Run's "no instance") is not absence: a
paid call that failed under it counts. That is the owner's rule: outages delay, they never count, and time is never
a limit; it is also what keeps the rule sound, because "absent" can only be true while the service is in fact down.

| Repeating path | Why it ends |
|---|---|
| Queue redelivery after a delay | each delivery is cheap (no call); it repeats only while the pre-call probe proves the service absent or the service answers `busy`/`unavailable` itself before any call; a call that was made and failed counts unless the re-probe proves absence; when the call succeeds, the row is `done` |
| Health probe timeouts | 3 consecutive timeouts force the real call; a forced call that fails counts unless the re-probe proves absence (a re-probe timeout is not proof), so the forced-call loop cannot repeat uncounted; a probe success resets the counter |
| A crash-shaped failure while the fleet is full (429 or "no instance" on the re-probe) | counts: 429 proves the service is up, not absent; 24 then terminal; the saturated run never hides a poison input |
| `in_flight` 503 | ends when the claim lapses (`ENLARGE_CLAIM_MS`, 30 min) or the holder settles |
| `more_tiles` 503 | every delivery makes at least one tile; tiles are finite; a tile failure counts against the identity |
| Validator refusal (handler or `primeReadiness`) | counts one attempt and re-makes the object; the same refusal 8 times is terminal; the handler and the render use the same validator, so they cannot alternate |
| Stale re-send | no call; a new task id each hour, slowing to 6 h after 20; it ends when a delivery reaches the handler, which is bounded by the rows above |
| Park and unpark | a chunk parks only with a wanted `queued` row; it unparks only when the last such row settles (`done`, `failed`, released); each settle is a counted attempt, a success or a release, so the number of park cycles per chunk is at most identities x (8 + 24 + 1) |
| Release and re-want | the route is pinned, so a row is re-wanted only by an operator retry (human), a hash flip back (bounded by revisions) or identity churn (3 per photo, then terminal); a re-wanted `failed` row stays terminal |
| Identity change | at most 3 release events per batch and photo (`identity_releases`, summed, never reset by a re-want), then terminal; an alternating `prepare` that reuses the same two rows still reaches 3 |
| Render not-ready 503 | a product with a queued row is skipped, never thrown; the throw is only a transient storage error, which is a dependency wait; it does not count toward `CHUNK_MAX_ERRORS`, and the chunk's `started_at` keeps the batch alive |
| Chunk redelivery on other errors | `CHUNK_MAX_ERRORS` (5) as today |
| Finalize re-queue | ends when the chunk finishes, which the rows above bound |
| Operator retry | a human click, logged; each resets at most 8 + 24 counted failures |
| Direct enqueue failure after an unpark | the lost-task rule on every live batch re-sends within 30 min; the sweep runs every 10 min |

## 4. Failure-mode table

Each row: the event, the outcome under section 3, and the test id (section 6). "Bounded" means I6.

| # | Event or sequence | Outcome under the design | Why no permanent hold, no silent resize, no loop | Test |
|---|---|---|---|---|
| F1 | Deploy mid-batch: a batch started before the stage (no recorded route) is in matting or rendering | no wanted set: plain path for the whole batch as before the stage, never held, outside the invariant, reported by Ops; parked chunks of new batches are invisible to 8d4f940's dispatch (3.8) | I9 | T1 |
| F2 | `UPSCALE_MIN_SCALE` env differs from the batch's recorded `minScale` | the batch's recorded threshold wins; env applies to new batches; invariant and worker agree | I9 | T2 |
| F3 | `UPSCALE_MODEL_X4` or `UPSCALE_MODEL` env changes mid-batch | no effect on the running batch (pinned); the next batch uses the new route | I9 | T3 |
| F4 | Two worker revisions with different export hashes for the same model id serve one batch | each revision wants its own identity (the id carries the hash); each is made at most once; bounded by 2 revisions; the object of each is kept | I1, I6 | T4 |
| F5 | `UPSCALER_VERSION` or export hash bump at deploy | render keys change; staged outputs keep theirs; live outputs re-render in their next batch; a new export hash is a new identity | I1 | T5 |
| F6 | A per-model pixel cap lowered mid-batch below a queued photo | the handler re-routes (tiles or downscale) on its next delivery; a queued row never fails for size unless no route exists | I3 | T6 |
| F7 | Matte change at the matte stage (guard: second model, padded, passthrough) | whole-photo identity, unchanged | I1 | T7 |
| F8 | Matte change by the render-stage ladder (`failed_compliance` -> second matte) | the variant renders upscaled from the same image, matte persisted; never `enlargement_failed` from a variant | I1, I4 | T8 |
| F8b | A ladder variant moves the box across 2.0x (x4 needed, only x2 wanted) or above the threshold | the step is recorded "skipped: enlargement not ready", no matte persisted, the output keeps its original hold | I4 | T50 |
| F9 | Matte change by the QA-stage ladder (judge: `product_removed`, passthrough) | same as F8; `ok()` refuses a variant with `enlargement_failed`; the QA redelivery never re-judges (`qa_scores` set) | I4 | T9 |
| F10 | `flushCutPhoto` (judged cut) re-render; and the same while not ready | covered by the whole-photo image; not ready -> `flush_cut` recorded skipped, the QA delivery goes on | I1, I4 | T10, T51 |
| F11 | Operator replaces a photo (processing batch) | new source row, new identities under the replacement prefix; the old photo's rows released and the product's chunks unparked in `completeReplacement`; the one-source matte chunk parks and enlarges | I7 | T11 |
| F12 | Re-open of a done batch (operator decision, Add SKU ids, late delivery) while a chunk is parked | finalize `not_ready`, re-queued every 10 min with `reopen`; the settle enqueues the unparked chunk directly; finalize completes | I8, J7 | T12 |
| F13 | "Use as is" on an output whose scope has `enlargement_failed` (clicked output, or a sibling held for another reason) | 409 `plain_warning` naming the channels; with `acceptPlain` the scope is staged, each output publishes its own file, event `plain_accepted`, invariant counts and does not flag | I5 | T13 |
| F14 | "Try again" on a held photo, twice, then after a success | rows reset per click, one-source render chunk, full path to publish and re-open; `retries` counts; a photo with no failed row answers 409 | I6 | T14 |
| F15 | Duplicate Cloud Tasks delivery of one task, concurrent | one claims and calls; the other answers 503 `in_flight` (delay); the retry finds the object and settles | I6 | T15 |
| F16 | Late delivery of an old send after a newer send finished | row is `done`: 200 `settled`, no write | I1 | T16 |
| F17 | Stale re-send while the original waits in the paced FIFO | any delivery of the batch refreshes `progress_at`; nothing is re-sent while the lane moves; a re-sent old task answers `settled` | I8 | T17 |
| F18 | Service busy (429, Cloud Run 503 no instance), slots shared | delay, no attempt counted, back-off to 15 min, forever if needed; `delays` visible | I6 | T18 |
| F19 | Crash after the claim, before the call | the queue keeps redelivering (unlimited attempts); `in_flight` until the claim lapses (30 min), then proceeds; no attempt counted | I6, I8 | T19 |
| F20 | Crash after the upload, before the settle | the next delivery heads the object, identity matches, settles `done` without a call | I1 | T20 |
| F21 | Chunk crash between the rows' upsert and the enqueue, or between the park and the enqueue | rows `queued`, chunk parked; the redelivered matte stage sends the same task ids (deduplicated); if the chunk is not redelivered, the re-send after 60 min quiet | I8 | T21 |
| F22 | Render crash between the output patch (flags, bytes) and the status write | redelivery: the shortcut is skipped for `enlargement_failed`; readiness decides again | I4 | T22 |
| F23 | Priming fails transiently (GCS 5xx on head or download) | `EnlargementNotReadyError(transient)`: 503 without `recordError`, never a flag, never a chunk failure; retried by the chunk lane; a batch with the chunk still delivering is never swept while parked chunks exist, and a chunk that is not parked keeps `started_at` fresh | I4 | T23 |
| F24 | The service hangs on one input (answers health after each timeout) | one timeout per delivery, 30 min each, 24 then terminal; other identities keep flowing; the batch is never swept (parked = owned) | I6, I8 | T24 |
| F24b | A legitimate 20 h wait (tile route on a 60 MP photo at x2, or a 16-slot queue with thousands of photos ahead) | the chunk stays parked, finalize waits, the sweep excludes the batch, Ops shows "waiting more than 20 h" as information; the output is made | I8 | T42 |
| F25 | The service is down (connection refused), scaled to zero, paused, or answers "model unavailable" 503, for longer than 4 h | every delivery is a delay (health probe fails or the kind is unavailable); no attempt counted; back-off 15 min; when the service returns the next delivery proceeds; nothing was held or failed | I6 | T25 |
| F25b | A deploy of the upscale service or the worker during a long wait | in-flight calls fail as delays (connection reset, 503); the claim lapses; the new revision proceeds on the same rows; identity unchanged unless the export hash changed (then F4) | I6, I1 | T52 |
| F26 | CPU quota exhausted (instances cannot start) for hours | 429/503 no instance: delay; the batch waits; the quota request in 3.9 is the fix | I6 | T26 |
| F27 | The queue drops a task (purged, recreated) or the enqueue failed silently | no attempt counted; the re-send after 60 min quiet with `sends+1`; after 20 sends ERROR lines every 6 h, never terminal | I6, I8 | T27 |
| F28 | Photo above the per-model cap; above the output limit; too big for any route | tiles; downscale when the effective scale meets the need; hold only with the size reason before any call | I3 | T28, T53, T54 |
| F29 | The service answers a wrong size or an undecodable JPEG | counted attempt (the bytes will not change on a retry); 8 then terminal, ERROR line | I4 | T29 |
| F30 | A stored object (or a tile) is deleted or overwritten | head says missing: `primeReadiness` sets the row back to `queued` (counters kept) and sends in the same pass; parked, re-made | I3 | T30 |
| F31 | Batch cancelled or failed while rows are queued | handler answers `stopped`; recovery skips the batch; counts exclude it; nothing loops | I8 | T31 |
| F32 | Source replaced while its old identity is still queued | the old rows released in `completeReplacement`; the chunk unparks when nothing else is queued; a late task answers `settled`; zero calls for the old photo | I7 | T32 |
| F33 | Live state at deploy: no stored objects, migrations 0005 and 0006 unapplied | both apply (additive); batches in flight take F1; live outputs with version-1 keys re-render in their next batch | I3 | T33 |
| F34 | `UPSCALE_MODEL=off` while chunks are parked (rollback) | the next enlarge delivery or recovery releases the rows and unparks; plain path, no flag; the invariant reports those outputs (rollback note); zero service calls | I5(b), I7 | T34 |
| F35 | Photo with no product found, a chart image, a corrupt file | no identity wanted; the render fails or skips it as today | I3 | T35 |
| F36 | Two photos of one product settle at once; one photo in each of two products of one chunk | each settle locks the product's chunks in id order; exactly one unpark, one render task | I8 | T36 |
| F37 | A settle lands before the park | the park's `EXISTS wanted queued row` check sees the settled row; the chunk goes straight to its render | I8 | T37 |
| F38 | Nondeterministic bytes across instances (same identity made twice after a delete) | an identity is made at most once per object; publish compares crc and writes a new generation; never a hold | I1 | T38 |
| F39 | "Try again" or a replacement on a done batch | the settle unparks and enqueues the chunk directly (batch not processing); the recovery covers a lost task; finalize completes with `reopen` | I8 | T41 |
| F40 | The 2 h sweep during a long enlargement (last product waiting) | a batch with a parked chunk is excluded; `progress_at` is refreshed by every delivery and re-send; the batch ends done with the output made or one held photo | I8 | T42 |
| F41 | "Try again" fails again terminally | the outputs are held again with `decision` null; Use as is (with warning), Remove and Replace all work | I4 | T43 |
| F42 | 8d4f940's top-up runs while the new build has parked a chunk | parked chunks carry `dispatched_at=now()` and `task_name`: the old dispatch and the old lost-task rule skip them; the old active count only loses a slot | I8 | T44 |
| F43 | A new build changes `prepare` (conversion, colour) between the matte stage and the handler, or between the handler and the render | the handler's pixel hash differs from the row: row released, chunk unparked, the render-stage reconcile wants the new identity; the render never pairs an image with other pixels | I1, I7 | T45 |
| F44 | A released row is wanted again (replacement undone by a re-run, off -> on, hash flip back) | `wanted=true` only; a `failed` row stays terminal (the hold stays clearable by Try again), a `done` row is reused, a `queued` row continues with its counters | I7 | T46 |
| F45 | A row is released while its handler is mid-call | the settle still writes `done`, the object and the cost rows (guard is `claim_token` and `status`, not `wanted`); nothing reads it until wanted | I2 | T47 |
| F46 | The same photo in a second batch (re-run, Start again after a failure) | a new row for the new batch; the object is found by identity at head time; `done` without a call | I1 | T48 |
| F47 | "Remove" on a held photo whose rows are still queued (operator retry chunk in flight) | rows released when no undecided or pending output remains; chunk unparks; a late task settles | I7 | T49 |
| F48 | Finalize re-queue while a done batch's chunk is parked for 20 h | every 10 min, 120 tasks over 20 h, ends when the chunk finishes; bounded by the enlargement, which is bounded by attempts | I8 | T41 |
| F49 | The health probe passes, the call times out, and the service was in fact overloaded | the timeout counts (1 of 24); the budget is sized so that 24 of them in a row on one input while others succeed is input-specific; an overloaded service shows as `busy` delays on the other rows, visible on Ops | I6 | T24 |
| F50 | Tile route: crash after 3 of 7 tiles | tiles are objects; the next delivery heads them and makes tile 4 on; `more_tiles` answers are delays | I1, I6 | T53 |
| F51 | Tile route: one tile fails deterministically | the row's counted attempts cover the identity, not the tile; 8 then terminal for the whole identity, with the tile index in `error` | I6 | T53 |
| F52 | Downscale route: the ladder's variant needs more scale than `scale` gives | the render maps crops at `scale`; a crop that would need more than `scale` (beyond the 5% slack) is `not_ready` for a non-wanted identity: F8b | I4 | T54 |
| F53 | A batch with a parked chunk is cancelled by the operator, then started again | cancelled: `stopped`, rows left as they are; the new batch has its own rows and finds the objects | I8, I1 | T31, T48 |
| F54 | The upscale service pauses at the Cloud Run level (zero instances by policy) for a day | every delivery a delay; the chunk parked; Ops "waiting more than 20 h"; nothing fails; the next day the work continues | I6, I8 | T25 |
| F55 | Cloud Tasks queue paused by an operator for hours | no deliveries; `progress_at` goes stale; the re-send (which needs the queue) sends new tasks that also wait; when resumed, duplicates answer `settled` or `in_flight`; nothing fails | I8 | T55 |
| F56 | A poison input: the call kills its instance every time (OOM, native crash), seen as a connection reset or a 5xx without the service's body; also while the fleet is full, so the re-probe meets 429 or "no instance" | the re-probe does not prove absence (200, timeout, 429, no instance all count), so each failure counts (`timeouts`); 24 then terminal; other photos flow; never an unbounded series of paid calls, full queue or not | I6 | T61 |
| F57 | A lone row meets a cold, scale-to-zero service on every delivery (model load at start); or a service whose probe keeps timing out | the probe waits `UPSCALE_COLD_START_S` + 60 s, so a cold start passes; at 3 consecutive probe timeouts the call is made without a probe; a forced call that fails counts unless the re-probe proves absence (a re-probe timeout counts), so the forced-call cycle is bounded by 24; the row cannot wait forever on a service that is up | I6 | T62 |
| F58 | A stored object has the right metadata but the wrong size or does not decode (a bug, a partial upload, a rounding mismatch) | the one validator refuses it in the handler and in `primeReadiness` alike: `attempts+1`, re-made, `done` on a good reply; the same refusal 8 times is terminal; the handler can never settle `done` on an object the render will refuse | I2, I4 | T63 |
| F59 | `prepare` is not byte-stable for a photo (a remote conversion that differs across instances), alternating between two results so the same two rows are released and re-wanted | each mismatch is a release event (`identity_releases+1` on the row, kept through re-wants); when the sum over the photo reaches 3 the next mismatch is terminal with its own sentence; Try again resets; the render never pairs an image with other pixels | I1, I7 | T64 |
| F60 | After an unpark on a done batch the direct enqueue fails | the chunk is queued, unparked, with no task; the lost-task rule now runs for every live batch, re-sends within 30 min; finalize completes | I8 | T65 |
| F61 | The handler cannot prepare the photo: matting `convert` down (5xx) or the raw object gone or corrupt | down -> delay, no count; gone or corrupt -> counted (`bad_source`), 8 then terminal with the sentence, Replace clears it | I6 | T66 |
| F62 | Tile route: the budget computes to zero or less (a tile p95 near the deadline) | at least one tile per delivery; `more_tiles` is always progress; tiles are finite | I6 | T67 |
| F63 | A render delivery reaches a product whose rows are queued | the product is skipped and the chunk parks at the end of the delivery; no 503, no window slot held, no re-prepare storm | I3, I8 | T68 |

Deadlock check: the locks taken are (settle) product chunks in id order then the row; (park) one chunk row;
(reconcile) the chunk claim, then product chunks in id order, then rows; (decisions) the product row, then product
chunks, then rows. The settle never takes a chunk claim; a chunk delivery never waits on a settle.

## 5. Gap analysis against PR #125 (55c472c)

### 5.1 Keep as is

- Service: `services/matting/app.py` (x4 model, per-model caps, scale check), `tools/convert_upscalers.py` (pinned
  export hashes), `Dockerfile`, `tests/cloudrun_check.py --x4-ratio`, `container_smoke.py`, pytest.
- Infra: `infra/lib/shape.sh` (`UPSCALE_MAX_PIXELS`, `_X4`, `UPSCALE_X4_TIME_RATIO`, memory rule, concurrency
  refusal), `infra/lib/services.sh` probe budget and `--x4-ratio`, `infra/deploy.sh` env wiring, `infra/tests/*`
  except the queue retry test.
- Core render and routing: `render.ts:526-553` (`enlargementFactors`, `shotEnlargementRegion` stays for the shot
  geometry, no longer an identity input), `upscale.ts` caps, config, `upscaleFactorFor`, `upscalersFor`,
  `enlargeRegion`, `enhance.ts` (no sharpening of AI colour), `types.ts` flags and sentences, `qa/reasons.ts`,
  `qa/triage.ts`, `pipeline/publish.ts`, `apps/web/lib/catalog/preview.ts`, `evals/enhancement.ts`.
- Tests that stay: `upscale.test.ts` (routing, alignment, caps), render tests at 1.2x/1.5x/2.5x, pytest,
  `naming.test.ts` (extended).

### 5.2 Change

| Where | Change |
|---|---|
| `packages/core/drizzle/0006_enlargements.sql`, `db/schema.ts`, `types.ts:28 EVENT_KINDS` | new table (3.1); events CHECK re-created with `enlargement_retried`, `plain_accepted`; snapshot and journal |
| `packages/core/src/catalog/pipeline/enlargement.ts` | drop the comma job (`ENLARGEMENT_JOB_SEPARATOR`, `jobUpscalers`, `enlargementJob`, `jobOnRoute`, `jobForRoute`, `photoEnlargementState` on `x2_*`); add `identityOf`, `pixelHashOf`, `routeFor` (batch), `enlargementRouteFor` (3.2), `releaseEnlargements`, the predicates on the table (`wantedQueuedExists()` for park and unpark, `queuedEnlargementsOfChunk`), error classes `EnlargementNotReadyError`, constants `ENLARGE_MAX_TIMEOUTS` 24, `ENLARGE_MAX_OUTPUT_PIXELS`, `ENLARGE_TILE_OVERLAP` 64, `ENLARGE_SEND_WARN` 20; keep `ENLARGE_TASK_MAX_ATTEMPTS` 8, `ENLARGE_STALE_MS`, `ENLARGE_CLAIM_MS`, `lockProductChunks`, `unparkSettledChunks` (predicate swapped, direct enqueue for non-processing batches), `enqueueEnlargements` (body by row id) |
| `packages/core/src/catalog/upscale.ts:255-296` | `sourceX2` throws `EnlargementNotReadyError` for a stored upscaler without a cache entry; `markEnlargementTerminal`; `upscalerIdentityId` (id with export hash); `SourceX2.factor` becomes `scale: number` (fractional on the downscale route) with outward-rounded crop mapping in `upscaledRgb` |
| `packages/core/src/catalog/render.ts:722-729` | `routedUpscale` propagates not-ready; readiness per candidate list (3.3) |
| `packages/core/src/catalog/pipeline/dispatch.ts:144, 176-177, 171-189, 198-216` | `notParked()` in the active count and the lost-task rule; recovery's enlargement part for any batch with a parked chunk; re-send by rows with the 20-send ERROR pace |
| `packages/core/src/catalog/decisions.ts:27-57, 79-112` | `plain_warning` and `acceptPlain`; `plain_accepted` event; `retryEnlargement`; `releaseEnlargements` in `completeReplacement` and remove |
| `packages/core/src/catalog/invariants/checks.ts:79-91` and the list | exclude operator-accepted plain outputs; add `plain_accepted_outputs` INFO, `parked_chunk_quiet` WARNING, `enlargement_waiting_long` INFO |
| `packages/core/src/tasks.ts` | body `{batchId, productId, enlargementId}`, `enlargeTaskId(enlargementId, sends)` |
| `packages/core/src/catalog/naming.ts:144-155` | `enlargedPath` with scale and identity hash, `enlargedTilePath`; `enlargedSibling` removed |
| `apps/worker/src/catalog/enlarge.ts` | rewrite around `reconcileEnlargements`, `primeReadiness`, `handleEnlargeTask` (3.3-3.5), the tile and downscale routes, the health probe, the error classification; keep `workerEnlargeCall`, `derivedPrefixFor`, `loadShotFromMatte`, metadata keys |
| `apps/worker/src/catalog/chunk.ts:253-260, 424, 441-444, 461, 485, 492, 526-531, 557-566, 577-604` | reconcile at the matte stage end and per product in the render loop before preparing (a queued product is skipped, the chunk parks at the end); `primeReadiness` after prepare; park with `dispatched_at=now()`; not-ready rethrow answered 503 without `recordError`; shortcut guard; delete `requeueEnlargementGaps`; `enlargeInProcess` on rows |
| `apps/worker/src/catalog/auto-resolve.ts:48-53, 111-115, 162-185, 252` | `preparePrimed` -> `primeReadiness`; `ok()` refuses `enlargement_failed`; `render()` maps not-ready to `LadderStopped`; `flushCutPhoto` records a skip |
| `apps/worker/src/catalog/qa-stage.ts:114, 240` | `enlargement_failed` in `NOT_JUDGED`; excluded from `repairable` |
| `apps/worker/src/catalog/sweep.ts:100-109, 88-89` | parked-chunk exclusion and `progress_at` in the no-progress rule; recovery (lapsed, lost, enlargement; not the top-up) for every live batch with a queued or running chunk |
| `infra/lib/shape.sh` | `UPSCALE_COLD_START_S` (measured by the gate, default 120), the worker output-limit test (`3 B x ENLARGE_MAX_OUTPUT_PIXELS x 2 x WORKER_CONCURRENCY <= 50% WORKER_MEMORY`), the gate records the cold start |
| `packages/core/src/catalog/pipeline/enlargement.ts` (validator) | `validateEnlargedObject(bytes, row)`, `enlargedDims`, `ENLARGE_MAX_IDENTITY_CHANGES` 3, `ENLARGE_PROBE_TIMEOUTS_MAX` 3 |
| `apps/worker/src/catalog/finalize.ts:61` | 10 min re-queue when every running chunk is parked |
| `apps/worker/src/catalog/deps.ts:116-120`, `apps/web/lib/catalog/ops.ts:227-235`, `pipeline/status.ts` | counts from the table; "waiting more than 20 h", "plain accepted", "started before enlargement" |
| `apps/worker/src/catalog/scale-model.ts`, `scale.test.ts` | one task per identity, parked chunks hold no slot |
| `apps/worker/src/catalog-smoke.ts`, `apps/worker/src/catalog/fault-proxy.ts` | the enlargement smoke (unit 7b) |
| `apps/web` decision route and attention card | `acceptPlain`, the warning dialog, the "Try again" button and route `POST /api/catalog/outputs/[id]/retry-enlargement` (decision auth), copy in `apps/web/lib/catalog/copy.ts` |
| `infra/lib/queues.sh:27` and its test, `infra/bootstrap.sh` lifecycle file | unlimited attempts with 15 min back-off ceiling; `derived/` kept 180 days |
| `apps/worker/src/catalog/enlarge.test.ts` | rewrite to section 6; keep the fakes |

### 5.3 Remove

`enlargedSibling` (`naming.ts:155`), the `next_image` answer and the `partial` settle (`enlarge.ts:422-425, 468-485`),
`requeueEnlargementGaps` (`chunk.ts:577-604`), `enlargementGaps` (`enlarge.ts:267-308`), `primeStoredEnlargement`
(`enlarge.ts:145-175`), `storedImageState` (`enlarge.ts:109-120`), `photoRegion` (`enlarge.ts:95`), the comma-job
helpers (`pipeline/enlargement.ts:69-95`), the `x2_*` SQL predicates (`:101-108`; the columns stay), the region
metadata of stored images (`X2_METADATA` region and matte keys), the known-risk lines in spec 18 section 13 that
describe the partial-failure and ping-pong behaviours, the `--max-attempts=9` comment block in `queues.sh`.

### 5.4 Branch decision: finish on PR #125's branch

Lower risk. The service, infra and render pieces (about 60% of the diff) passed two reviews and CI; the lifecycle is
a bounded set of files that the design replaces wholesale, which reads as one coherent commit series on top. A fresh
branch from main would re-create those pieces by cherry-pick (fcf17ec, 0df4c86, parts of c95fd60, 6aecd74, 0934853)
and re-review them for no benefit, and would leave two open PRs for the same spec. Do it as commits on
`feat/catalog-18-quality--x4-routing` (no history rewrite), PR #125's title and body updated to name the lifecycle
rewrite, and this document linked from the PR.

## 6. Test plan

All tests drive the real entry points: `handleChunkTask` (matte, render, qa stages via `currentChunkTask`),
`handleEnlargeTask`, `handlePublishTask`, `handleFinalizeTask`, `runSweep`, `recoverBatchChunks`, `applyDecision`,
`retryEnlargement`, `completeReplacement`; the upscale service, GCS, Cloud Tasks and the judge are fakes. No test
writes `catalog_enlargements`, `x2_*` or `matte_uri` directly; a matte change is produced by the ladder itself (the
fake judge returns `product_removed`, the fake matting service returns a second matte that passes).

Helpers that exist and are reused (55c472c): `apps/worker/test/catalog-fakes.ts` (`fakeWorld` with in-memory GCS,
metadata map, task list with `retryCount`, deliveries log; `seedBatch` by layout; `chunkRow`), `createTestDb` (PGlite,
`packages/core/src/db/testing`), and from `apps/worker/src/catalog/enlarge.test.ts:28-88`: `fakeService(factor)` with a
failure queue, `enlargingWorld`, `realRender`, `holdFirstCall`, `watchRenderEnqueues`, `upscaleRows`, `matteStage`,
`boxMatte` (`:652-656`), and the queue driver loop of the section 7 test (`:577-584`), which becomes a shared
`drainQueue(w, deliver)` helper. `apps/worker/src/catalog/pipeline.test.ts` `world()` for the judge and classifier
fakes. `qa-mock.ts cannedQa` for canned verdicts.

New helpers (small): `secondMatteWorld()`, `judgeFlags(flags)`, `crashAfter(deps, point)`, `tick(w, minutes)` (time
travel for the sweep, the claim and the back-off), `serviceMode(w, mode)` (ok, busy, down, paused, unavailable,
wrongSize, slow, badInput, healthyButHangs, crashOnThisInput, coldStart, probeTimesOut, saturated; the fake answers
`/health` by mode, with 429 under `saturated`, so the re-probe is real), `oldRevision(w)` (a dispatch with 8d4f940 semantics), `bigPhoto(w, h)` (a
synthetic prepared photo of any size for the route tests, never sent through a real model), `corruptObject(w, key)`
(overwrites a stored object with wrong-size bytes under the right metadata), `unstablePrepare(w)` (a `prepare` that
alternates two colour handlings), `enqueueFailsOnce(w)`.

| Test | Covers | Drives | Asserts |
|---|---|---|---|
| T1 | F1 | batch seeded without `options.enlargement`, matte and render stages | plain path, no flag, no rows, invariant query returns nothing, Ops line |
| T2 | F2 | batch pinned at `minScale` 1.5, worker env 1.0 | 1.2x outputs render plain without a flag; invariant agrees |
| T3 | F3 | x4 env switched on after the matte stage of a batch pinned without x4 | no new rows; x2 serves; a new batch wants x4 |
| T4 | F4 | two `deps` with different export hashes delivering the same rows | each identity made once; no hold; both objects kept |
| T5 | F5 | export hash changed in `UPSCALE_MODEL_VERSIONS` | new identity, old object untouched, render key changes |
| T6 | F6 | `UPSCALE_MAX_PIXELS` lowered below the photo between send and delivery | the handler takes the tile route; done; no hold |
| T7 | F7 | matte-stage guard replaces the first matte (passthrough) | identity unchanged, one row |
| T8 | F8 | render-stage ladder: compliance failure fixed by the second matte | variant upscaled, matte persisted, no `enlargement_failed` |
| T9 | F9 | QA stage: judge flags `product_removed`, second matte passes | as T8; the judge is called once across the redelivery |
| T10 | F10 | judge saw a source cut; `flushCutPhoto` | upscaled, covered |
| T11 | F11 | `completeReplacement` on a processing batch while the old photo's row is queued | old rows released, chunk unparked, new rows under the replacement prefix, one call |
| T12 | F12 | done batch, "Try again" chunk parked, finalize task | `not_ready` with 10 min re-queue; after the chunk, finalize writes `links-v2` |
| T13 | F13 | `applyDecision(use_as_is)` on (a) the held output, (b) a sibling held for `fallback_matte` | 409 `plain_warning` listing the channels; with `acceptPlain` both staged, each published from its own key (bytes compared), event `plain_accepted`, invariant returns nothing, INFO count 2 |
| T14 | F14 | retry twice then after a success | rows reset per click, outputs pending, chunk parked, full path to `verified`; `retries` 2; 409 when nothing failed |
| T15 | F15 | two concurrent deliveries (`holdFirstCall`) | one call, one cost row, loser 503 `in_flight`, `attempts` 0, gate settles once |
| T16 | F16 | deliver `sends=0` task after `sends=1` finished | `settled`, no write, no cost row |
| T17 | F17 | three parked chunks, 70 min, deliveries for one product only | no re-send while deliveries continue; re-send after a quiet hour; old task answers `settled` |
| T18 | F18 | 40 busy answers then success | `attempts` 0, `delays` 40, then done; never terminal |
| T19 | F19 | `crashAfter("claim")`, deliveries every 5 min | `in_flight` until 30 min, then the call; `attempts` 0 throughout |
| T20 | F20 | `crashAfter("upload")` | next delivery: no call, `done`, one cost row |
| T21 | F21 | enqueue throws at the matte stage; chunk redelivered; separately, no redelivery and a sweep after 60 min | same task id on the redelivery (one task in the fake queue); re-send with `sends` 1 otherwise |
| T22 | F22 | `crashAfter("output patch")` on a terminal photo; then "Try again" makes the image | the redelivery renders again and uses the image |
| T23 | F23 | storage head throws 5 times during render deliveries | each 503 `retry`, `chunkErrors` unchanged, chunk never failed, sixth delivery renders upscaled; no flag ever written |
| T24 | F24, F49 | `healthyButHangs` 24 times | one timeout per delivery, `timeouts` 24, then terminal with the sentence; batch never swept (sweep every 10 min throughout) |
| T25 | F25, F54 | service down 6 h (connection refused), then paused (503 unavailable) 24 h, then up | `attempts` 0, `delays` > 0, no hold, no sweep, done after recovery |
| T26 | F26 | 429 no instance for 3 h | as T25 |
| T27 | F27 | tasks dropped before the handler for 25 re-send rounds | `sends` 25, ERROR lines from 21 on, row still `queued`, batch alive; a delivery then completes it |
| T28 | F28 | 3000x3000 photo at x2 (9 MP, above the 8 MP service cap, output 36 MP) | tile route, 2 tiles, stitched size exactly `(out_w, out_h)` = 6000x6000, `done` |
| T29 | F29 | fake answers factor 3 | counted; 8 then terminal, ERROR |
| T30 | F30 | delete the object after `done`; render stage | row back to queued (counters kept), sent in the same pass, parked, re-made, upscaled |
| T31 | F31, F53 | batch cancelled while rows queued, then a new batch of the same products | handler `stopped`; recovery skips; counts exclude; new rows, objects reused |
| T32 | F32 | replacement while the old photo's row is queued and a late task arrives | old row released; chunk unparks; late task `settled`; zero calls for the old photo |
| T33 | F33 | migration test applies 0000 to 0006 on PGlite twice | columns, table, CHECK present; idempotent |
| T34 | F34 | chunk parked with a queued row, then `UPSCALE_MODEL=off`, then an enlarge delivery; separately the sweep | zero service calls, rows released, chunk unparked, plain path, no flag; invariant reports the outputs |
| T35 | F35 | chart image and corrupt file in a product with one good photo | no rows for them; the good photo's row only |
| T36 | F36 | the two existing race tests (`enlarge.test.ts:376-421`) ported to rows | one unpark, one render task, lock order from the query log |
| T37 | F37 | settle before park (`:422-440` ported) | chunk never parks |
| T38 | F38 | different bytes on the second make after a delete | publish writes a new generation; no hold |
| T39 | section 7 end to end | the ported section 7 queue test with the real render and one forced terminal product | zero silent outputs, every parked chunk's render queued once, held product has `enlargement_failed` |
| T40 | state machine | see below | invariants after every step |
| T41 | F39, F48 | done batch: "Try again", and a replacement; lose the try-again task; sweep | the render task is enqueued after the settle (direct), output `verified`, finalize `links-v2`; the lost task is re-sent by the sweep; finalize tasks every 10 min |
| T42 | F24b, F40 | one-product batch; the service takes 20 h (time travel); sweep every 10 min | the batch is never swept, Ops "waiting more than 20 h" appears at 20 h, the output ends `upscaled` |
| T43 | F41 | retry, terminal again | outputs held with `decision` null; Use as is (with warning), Remove, Replace all succeed |
| T44 | F42 | `oldRevision(w)` top-up while a chunk is parked | the parked chunk is not dispatched; after unpark the new dispatch sends it once |
| T45 | F43 | prepare changed between matte stage and handler (fake `prepare` swaps colour handling) | row released with `identity_changed`, no call, the render-stage reconcile wants the new identity, done |
| T46 | F44 | a `failed` row released then wanted again | stays `failed`, hold stays, Try again clears it; a `done` row released then wanted: reused |
| T47 | F45 | release while the handler is mid-call (`holdFirstCall`) | `done` written, cost row written, no reader |
| T48 | F46 | second batch of the same photo | new row, no call, `done` from the head |
| T49 | F47 | remove on a held photo with a queued row | rows released; chunk unparked |
| T50 | F8b | ladder variant crossing 2.0x | step recorded skipped, no matte persisted, original hold kept |
| T51 | F10 | `flushCutPhoto` while not ready | `flush_cut` recorded skipped, QA delivery completes |
| T52 | F25b | worker and service "deploy" mid-wait (deps swapped, in-flight call reset) | claim lapses, new deps complete the same row, one object |
| T53 | F28, F50, F51 | 4000x4000 at x2 (16 MP, output 64 MP: tiles, 3) with a crash after 2 tiles and, separately, one tile answering a deterministic 400; 5000x4000 at x2 with need 1.5 (20 MP: `downscale_tiles`, scale 1.788, shrunk 4470x3576, out 8940x7152); 2400x2400 at x4 with need 2.5 (5.76 MP, output would be 92 MP: downscale, scale 3.333, shrunk 1999x1999, out 7996x7996, direct) | tiles resumed from objects after the crash; `more_tiles` answers are delays with progress; the tile failure counts on the identity, terminal at 8 with the tile index; `out_w`, `out_h` equal `f x shrunk` exactly and the fake service's reply (which enlarges the shrunk photo by `f`) passes the validator on the first make; the render maps crops by `out_w / width` = 3.3317 |
| T54 | F28, F52 | 2400x2400 at x4 with need 3.5; 6000x6000 at x2 with need 1.2 and with need 1.4; 10000x10000 at x4 with need 1.0 | 3.333 < 3.675 holds with the size sentence before any call; 1.333 >= 1.26 takes `downscale_tiles` and renders, 1.333 < 1.47 holds; 0.8 < 1.05 holds |
| T55 | F55 | queue paused 5 h (fake queue holds tasks), then resumed | duplicates answer `settled`/`in_flight`; nothing fails; done |
| T56 | unit 7b | the enlargement smoke on fakes | both fixtures `upscaled`, the fault photo held, retry clears it |
| T57 | invariants | `parked_chunk_quiet`, `enlargement_waiting_long`, `plain_accepted_outputs`, `enlarged_without_upscaler` exclusion | each fires only on its fixture |
| T58 | infra | `queues.sh` retry flags and the lifecycle file | unlimited attempts, 900 s ceiling; `derived/` 180 days |
| T59 | web | the decision route with and without `acceptPlain`; the retry route auth and 409 | copy has no model id |
| T60 | scale model | `scale-model.ts` with parked chunks | parked chunks hold no slot; one task per identity |
| T61 | F56 | `serviceMode(crashOnThisInput)`: connection reset on one photo, other photos succeed; run three times with the re-probe answering (a) 200, (b) 429 / "no instance" (`serviceMode(saturated)` on top), (c) a timeout; and a fourth run with the re-probe answering connection refused | (a), (b), (c): `timeouts` grows by one per delivery, `attempts` 0, terminal at 24 with the sentence, the other photos `done`, the count of paid calls on the poison row is exactly 24; (d): `delays` grows, `timeouts` 0, no terminal while the service is absent, and once it answers again the next failure counts |
| T62 | F57 | a fake service whose `/health` takes 30 s on the first call after idle (`UPSCALE_COLD_START_S` 20 in the test); separately, a service whose probe always times out but whose calls succeed; separately, a service whose probe always times out and whose calls fail | the first: one delivery, probe passes, call made, `done`; the second: `probe_timeouts` 1, 2, 3, then the call is made, succeeds, `done`, `probe_timeouts` reset; the third: the forced call's failure counts (`timeouts+1`) because a re-probe timeout is not proof of absence, and the row is terminal after 24 forced calls, never a silent loop |
| T63 | F58 | an object with the right metadata but 1 px short on one side; and one that does not decode | `primeReadiness` and the handler both refuse it: `attempts+1`, re-made, `done`; with a service that always answers 1 px short: terminal at 8, never `done`, the render never primed it |
| T64 | F59 | a fake `prepare` that alternates two colour handlings, so only two distinct rows ever exist | release events 1, 2, 3 (`identity_releases` summed over the two rows equals 3 while the row count stays 2), the 4th mismatch leaves the row `failed` with the prepared-twice sentence, hold, Try again resets the sum and a stable `prepare` completes |
| T65 | F60 | done batch, Try again, `enqueue` throws once at the unpark | chunk queued and unparked with no task; the sweep's lost-task rule re-sends within 30 min; output `verified`; finalize `links-v2` |
| T66 | F61 | matting `convert` 5xx for 2 h, then a raw object deleted | `attempts` 0 during the outage, done after; the deleted raw: `bad_source` 8 then terminal; Replace clears |
| T67 | F62 | tile route with `ENLARGE_TILE_BUDGET_MS` forced to 0 | one tile per delivery, `more_tiles` each time, `done` after `tiles` deliveries |
| T68 | F63 | render delivery for a chunk with two products, one with a queued row | the other product renders; the queued product is not prepared and not rendered; the delivery answers 200 `enlarging` and the chunk is parked; the fake storage saw no download for the queued product's objects |
| T69 | downscale mapping | the downscale route on a photo with a sharp alpha edge, at an integer case (5000x4000, `sx` 1.788) and a non-integer case (2400x2400, out 7996, `sx` 3.3317) | the validator accepts the reply on the first make in both cases; colour and alpha edges differ by at most 0.5 output px at 200% (the mask-edge check of the quality run, run on fakes) |

T40, the state-machine test (`apps/worker/src/catalog/enlarge.model.test.ts`): a seeded PRNG (no new dependency; an
`Math.imul` LCG with the seed printed on failure) draws 200 sequences of 60 events over a 3-product batch on PGlite
with the real handlers: `deliverChunk`, `deliverEnlarge(row, duplicate?)`, `crashEnlargeAfter(claim|upload|tile)`,
`crashRenderAfter(patch)`, `flip(off)` while parked, `judgeProductRemoved`, `complianceFail`, `replacePhoto`,
`useAsIs(acceptPlain?)`, `retryEnlargement`, `remove`, `sweep(+N min, up to +24 h)`, `deleteObject`,
`serviceMode(ok|busy|down|paused|wrongSize|badInput|healthyButHangs|slow|crashOnThisInput|coldStart|probeTimesOut|saturated)`
(`saturated` makes every probe answer 429 and is combined with `crashOnThisInput` by the generator),
`invalidObject` (overwrite a done object with a wrong-size one), `nondeterministicPrepare`, `enqueueFail`,
`loseTask`, `oldRevisionDeliver`, `finalizeToDone`, `publish`, `batchCancel`. After every event it asserts: (a) a
chunk is parked iff it has a wanted `queued` row; (b) every `needs_attention` output with `enlargement_failed` has a
`failed` wanted row for each candidate list its plan needs, or a size-route refusal; (c) no staged or verified output
above the batch's threshold lacks `upscaled` unless it has `decision='use_as_is'` with the flag, or `off` was drawn
(then the batch is skipped for this check); (d) every `done` row's object passes `validateEnlargedObject`; (e)
`attempts <= 8`, `timeouts <= 24`, `probe_timeouts <= 3`, the sum of `identity_releases` per photo `<= 3`,
`status in (queued, done, failed)`; (f) ok `upscale_call` cost rows equal the number of distinct (identity, tile)
objects made plus the counted failures that reached the service; (g) no two wanted rows of one photo share an
identity; (h) the batch is never `failed` unless `batchCancel` was drawn; (i) every queued chunk of a live batch has
a live task, or is parked with a wanted `queued` row, or is picked up by the next sweep's lost-task rule; (j) a
parked chunk is never dispatched by `oldRevisionDeliver`; (k) no paid call without a counter: for every delivery of
a row in which the fake service received a call, `attempts + timeouts + tiles_done + (status = done)` grew by that
delivery, unless the service mode was `down` or `paused` at the re-probe (the termination argument, 3.10, checked
mechanically); (l) no call-free loop: a row never answers `in_flight` more than `ENLARGE_CLAIM_MS / back-off floor`
times in a row without the holder settling. At the end it drains (deliver
everything until quiet, sweep with time travel up to 48 h, service `ok`) and asserts that each batch reached `done`,
no output is `pending`, and every held output has a terminal reason.

## 7. Implementation plan (one Opus implementer, in order)

Branch: `feat/catalog-18-quality--x4-routing` from 55c472c. Conventional commits, no co-author, no em dashes, model ids
never in UI copy. The suite is expected red between units 2 and 4 (the core throw lands before the stages honour
it); from unit 4 on, every unit ends green on `pnpm typecheck`, `pnpm lint` and the whole suite.

1. Core state (`packages/core`): migration `0006_enlargements.sql` (table, indexes, events CHECK) plus schema,
   snapshot, journal, `migration-0006.test.ts` (T33); `types.ts` event kinds; `pipeline/enlargement.ts` rewritten
   (3.1, 3.2 pure parts: `identityOf`, `pixelHashOf`, `enlargementRouteFor`, `routeFor(batch)`, predicates,
   `releaseEnlargements`, constants, `unparkSettledChunks` with direct enqueue); `tasks.ts` body and task id;
   `naming.ts` paths; invariants `checks.ts` (exclusion and the three new checks, T57). Tests: `enlargement.test.ts`,
   `naming.test.ts`, `tasks.test.ts`.
2. Core readiness (`upscale.ts`, `render.ts`): `EnlargementNotReadyError`, the throw in `sourceX2`,
   `markEnlargementTerminal`, `upscalerIdentityId`, fractional `scale` with outward-rounded crop mapping,
   `routedUpscale` propagation. Tests in `upscale.test.ts`; render tests assert the throw propagates.
3. Worker lifecycle (`apps/worker/src/catalog/enlarge.ts`): `reconcileEnlargements`, `primeReadiness`,
   `handleEnlargeTask` with the health probe (cold-start timeout, 3-timeout fallback), the re-probe classification,
   the shared validator on the reply and on heads, identity-change cap, the direct, tile (one tile minimum) and
   downscale routes; `dispatch.ts` (`notParked()` in the count and the lost rule, recovery for every live batch,
   re-send pace); `sweep.ts`; `finalize.ts`; `deps.ts` and `ops.ts` counts; `scale-model.ts`. Tests T15, T16,
   T18-T20, T24-T32, T36-T38, T42, T44-T48, T52-T55, T60-T67, T69.
4. Stages (`chunk.ts`): matte stage end and render loop call reconcile (per product, before preparing) and
   `primeReadiness`; a queued product is skipped; park with `dispatched_at=now()`; not-ready 503 without
   `recordError`; shortcut guard; `enlargeInProcess` on rows. Tests T1-T7, T17, T21-T23, T34, T35, T68.
5. Judges (`auto-resolve.ts`, `qa-stage.ts`): `ok()`, `render()` mapping, `flushCutPhoto` skip, `NOT_JUDGED`,
   `repairable`. Tests T8-T10, T50, T51.
6. Operator actions: `decisions.ts` (`plain_warning`, `acceptPlain`, `plain_accepted` event, `retryEnlargement`,
   releases in replacement and remove); web route `POST /api/catalog/outputs/[id]/retry-enlargement` and the
   `acceptPlain` field on the decision route (same auth), the warning dialog and the "Try again" button on the
   attention card next to "Replace", copy in `apps/web/lib/catalog/copy.ts`; `ENLARGEMENT_FAILED_WHAT` reads "Try
   again, use it as it is after the warning, replace the photo, or ask the brand for a larger one." Tests T11-T14,
   T41, T43, T49, T59.
7. State-machine test T40 and the end-to-end T39.
7b. Smoke: `catalog-smoke.ts` gains an enlargement case with two named fixtures (one product above 2.0x: x4; one in
   1.0-2.0x: x2) and a fault rule in `fault-proxy.ts` that answers 8 x 400 (bad input) for one photo's `/upscale`,
   then the retry through core `retryEnlargement` with the fault lifted, asserting every output above the threshold
   `upscaled`, the fault photo held with `enlargement_failed` then cleared, invariants zero ERROR. T56 runs it on
   fakes. Part of the deploy gate.
8. Infra and docs: `queues.sh` retry flags and its test (T58, flag forms verified through Context7); bootstrap
   lifecycle `derived/` 180 days; `shape.sh` `UPSCALE_COLD_START_S` and the output-limit test; the bake-off scripts
   copied from this session's scratchpad
   (`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\6ddc6f33-e492-4352-a944-247afdf1326b\scratchpad\bake\scripts`:
   `assemble.js`, `canvas.js`, `colour.py`, `convert.py`, `driver.py`, `fetch.py`, `grid.py`, `infer.py`, the two
   `batch*.ps1`) into `apps/worker/src/catalog-output-evals/bake/` in this pass, so step 9 does not depend on a temp
   folder (wiring them as the `--enlargement` mode stays in step 9); the CPU quota request text in
   `docs/solutions/2026-10-29-cpu-upscaler-reliability.md`;
   spec 18 sections 3.3.3-3.3.5, 3.6.4, 3.6.7, 4, 10, 13 and 14 rewritten to this design (the spec says what is
   true, no history); `docs/SPEC.md` enlargement contract paragraph (pinned route, tri-state readiness, bounded
   attempts, unbounded patience, operator-accepted plain outputs); the solutions doc gets one row per invariant I1-I9
   with the test that guards it and loses the partial-failure, next_image and ping-pong rows;
   `docs/solutions/finalize-reopen.md` gains the "Try again" trigger and the 10 min re-queue; PR #125 body.
9. After the deploy, as its own step with its own report: the quality run (section 7.3). Not part of this pass.

Migrations: 0006 only, additive (`CREATE TABLE IF NOT EXISTS`, indexes, the events CHECK swap, `lock_timeout 10s`).
Safe on the live database: nothing reads the table until the new worker serves; 0005 stays as merged. No backfill.

Shape and infra changes: none to the service shape until the quota is granted (16 x 4 vCPU, 4 threads, concurrency
1, 1740 s, caps 8 MP and 6.4 MP). After the CPU quota increase (3.9): `UPSCALE_MAX_INSTANCES` 32,
`MATTING_CPU_MAX_INSTANCES` 16, through `shape.sh` with its tests. `queues.sh` retry flags. No new env.

### 7.1 Definition of done

- Every function in section 5.3 is gone; `grep -rn "x2Model\|x2Uri\|x2Attempts\|jobUpscalers\|next_image\|partlyFailed\|storedImageState" apps packages` finds only the schema columns and migration 0005.
- T1-T69 pass; T40 includes the done-batch, sweep, off-while-parked, old-revision, 20 h, poison-input, cold-start, invalid-object, nondeterministic-prepare and enqueue-failure events and the checks (k) and (l); the full root vitest, infra tests and pytest pass; typecheck and lint clean; no em dash in changed files.
- One validator: `grep -rn "metadata.width\|meta.width" apps/worker/src/catalog/enlarge.ts packages/core/src/catalog/upscale.ts` finds nothing outside `validateEnlargedObject`.
- The three paths of section 1.6 each have a test that drives the ladder (T8, T9, T23), and the test that pokes `matte_uri` directly is deleted.
- The enlargement smoke passes on fakes (T56) and is wired into the deploy gate.
- No code path fails, sweeps or holds on a wall-clock condition for enlargement work: `grep -n "SWEEP_STALE_MS\|ENLARGE_STALE_MS" packages apps` shows only the exclusion, the progress refresh and the re-send.
- Spec 18, `docs/SPEC.md` and the solutions doc describe the design in section 2 and 3 words, and the PR body links this plan.
- CI green on the PR; the manager merges; deploy through `infra/deploy.sh`.

### 7.2 Deploy gate (what the probe and the smoke must prove before traffic moves)

- catalog-upscale candidate: both models answer at exact scale for 800x1200 and 1600x1600, byte-identical on the
  rerun, x4 p95 <= 1.3 x x2 p95 per size (already in the gate), **and** a determinism round at
  `UPSCALE_MAX_INSTANCES >= 4` concurrency 1 that calls the same 800x1200 image 12 times in parallel (429s retried)
  and records sha256 and `instanceId` per call: the gate fails if any two successful calls differ, or if fewer than 2
  distinct instance ids answered (then the round repeats up to 3 times before failing). Extra probe calls cost
  nothing that matters.
- Worker candidate: the unit 7b smoke through the candidate upscale service, with the real fault proxy.
- Both: `/health` on every service, traffic 100% on the new revisions, enlarge lanes exist with the new retry
  config (`gcloud tasks queues describe`), invariants job zero ERROR on the smoke batches.
- Cold start: the gate scales catalog-upscale to zero (or waits for idle), times the first `/health` 200, and
  records it as `UPSCALE_COLD_START_S` in the run report; the deploy refuses when it exceeds the `shape.sh` value.

### 7.3 Live test (spec 18 section 9 step 4; run only in an owner-approved quiet window, the manager asks first)

- Reliability bar, the only bar of this pass: 200 products on trendyol, styli, centrepoint and noon, 3 photos per
  product, a 5-product operator batch at minute 5; every output above 1.0x is `upscaled` or held with
  `enlargement_failed`; zero silent outputs; zero plain fallbacks; zero holds from timeouts, outages or sweeps;
  invariants zero ERROR; the operator batch finishes; "Enlargements failed" on Ops equals the ERROR lines; ok
  `upscale_call` rows equal `done` rows plus tiles; time is reported, not judged, with the 2,000 and 7,000 projections.
  Cost is reported, not judged.
- Deliberate faults during the run (not with real users on the site): pause the upscale service for 30 min at minute
  20 (no attempt counted, no hold, the batch continues after); a worker deploy of the same build at minute 60
  (in-flight claims lapse and complete).
- Quality run (step 9, own report): the five real source sets (USPA 636x466, Z3CB 800x1200, img_2 and img_3
  800x1200, HCB 1000x1000) on all four channels, measured by the bake-off scripts (already in the repo after unit 8
  at `apps/worker/src/catalog-output-evals/bake/`, wired as an `--enlargement` mode in this step): sharpness ratio
  against the plain path >= 1.3 above 1.5x and >= 1.0 at 1.0-1.5x; back-SSIM >= 0.99 and back deltaE <= 0.3; the 2 MB
  encode cap at `quality >= 80` on Centrepoint and Styli with nothing below 75 (if lower, the fix is the encoder
  floor, reported); mask edges at 200% with no stair step wider than 2 canvas px (reported, not gating); x4 p95 at
  both sizes recorded as `UPSCALE_P95_S_*_X4` rows in `shape.sh`; determinism across batches by object sha256.

## 8. Residual risks (not designed away) and how each is detected

| Risk | Detection |
|---|---|
| Bytes differ across instances at concurrency 1 (shape review P2-5) | the 12-call gate round (sha256 and instance id, at least 2 instances) fails the gate; in production, two batches of one photo give different object sha256 in the ledger report |
| The 1.3 x4 time ratio and the 8 MP / 6.4 MP caps are extrapolated from 1600x1600 | the gate probe's `--x4-ratio` fails the deploy; a cap that is too generous shows as timeouts (counted, visible, never a sweep); after the live run the measured x4 rows replace the ratio |
| 24 timeouts on one input is misread as input-specific when the service is in fact overloaded | `busy` delays on other rows at the same time on Ops; the hold is clearable by Try again; the quota increase removes the overload |
| Ladder repairs that cross the x4 boundary are skipped (F8b) | the skip record on the output; counted in the run report |
| The invariant fires on in-flight batches when `UPSCALE_MODEL=off` is used as a rollback | expected and documented in spec 18 section 10; the alert names the batch |
| Worker memory on the tile and downscale routes (192 MB decoded per identity at the output limit) | Cloud Run memory alerts on the worker; `container/memory/utilizations` during the load run; `CATALOG_PHOTO_CONCURRENCY` 1 is the mitigation and the default |
| Tile seams on the tile route | the quality run's back-SSIM on a synthetic over-cap fixture; the service's internal tiling has the same property |
| SwinIR-S keeps JPEG noise of poor sources; small sources still need 3x or more after x4 | the quality run's back-SSIM and the visual sheets; `low_resolution` stays information only (owner decision) |
| A row that can never be delivered (queue misconfigured) re-sends every 6 h forever | ERROR line each time, Ops count; the fix is the queue, never the row |
| The CPU quota request is slow | `busy` delays and "waiting more than 20 h" on Ops; the batch finishes anyway |
| A very large photo with a small product (above 64 MP / need^2 pixels) is held although a crop route could serve it | the size-hold count on Ops and in the run report (`error_kind='no_route'`); if it ever appears on a real brand source, raise `WORKER_MEMORY` (the limit scales with it) or add a product-crop route as its own spec |
| A crash-shaped failure right after a deploy of the service (instance killed by the rollout) counts one of 24 | `timeouts` 1 on many rows at the deploy minute, visible in the run report; harmless at that count |
| During the deploy shift the old web shows an empty label for the two new event kinds | cosmetic; the new web names them (typed `EVENT_KINDS`) |

## 9. Review disposition (`.runs/2026-10-29-18-lifecycle-plan-review.md`, 2026-10-30)

| Finding | Disposition |
|---|---|
| P1-1 done-batch chunks never render | Amended 3.4 step 9, 3.8, F39, T41: unpark enqueues directly on non-processing batches; recovery runs for every batch with a parked chunk |
| P1-2 cache keyed by Buffer | Amended 2, 3.3, 3.5: `primeReadiness(deps, source, prepared)` on the render's own buffer; reconcile returns no readiness |
| P1-3 2 h sweep | Amended 3.8, F40, T42: parked-chunk exclusion and `progress_at`; under the owner's patience rule no timer fails enlargement work |
| P1-4 off cannot release parked chunks | Amended 3.4 step 2, 3.8, F34, T34: handler and recovery release and unpark; T34 parks first |
| P1-5 "Use as is" sibling | Amended 3.6, F13, T13: the warning covers the whole scope and names the channels; each output publishes its own file (owner: allow with a clear warning) |
| P1-6 decision CHECK | Amended 3.6, 3.1: "Try again" is not a decision; events CHECK re-created in 0006; T43 proves later decisions work |
| P1-7 smoke does not exist | Amended unit 7b, T56, definition of done |
| P1-8 `superseded` loses state | Amended 3.1, 3.4, 3.5, F44, F45, T46, T47: `wanted` flag only; settle guard on token and status |
| P1-9 T40 blind spots | Amended T40: new events and checks (h), (i), (j), end condition on `done` |
| P2-1 sends after Try again | Amended differently: no send cap at all (owner: re-queue, never fail); `sends` monotonic; 20 is a visibility threshold |
| P2-2 sends bumped by reconcile | Amended 3.5 step 4: reconcile sends the current `sends`; only the re-send bumps |
| P2-3 queue gives up before the claim lapses | Amended 3.8, F19, T19: unlimited attempts, 15 min ceiling |
| P2-4 replaced photo's rows | Amended 3.5 step 3, 3.6, F11, F32, T32: released in `completeReplacement` and by reconcile |
| P2-5 not-ready mixes causes | Amended 3.3: queued -> park; missing object -> requeue and send in the same pass; storage error -> throw |
| P2-6 `flushCutPhoto` | Amended 3.3, F10, T51 |
| P2-7 identity on raw sha256 | Amended I1, 3.1, 3.4 step 4, F43, T45: prepared pixel hash, checked by the handler |
| P2-8 8d4f940 dispatches parked chunks | Amended 3.8, F42, T44: `dispatched_at=now()` with `task_name`; `notParked()` in count and lost rule |
| P2-9 crossing variant | Amended 3.7, F8b, T50: recorded skip, no silent loss; a reconcile for the new identity is rejected because a mid-delivery park would lose the render-stage ladder's output on redelivery (the output is no longer pending) |
| P2-10 five transient not-ready | Amended 3.3, F23, T23: not counted toward `CHUNK_MAX_ERRORS` |
| P2-11 web cannot call worker | Amended 3.6: `retryEnlargement` in core; the worker's render delivery prepares and reconciles |
| P2-12 unit order | Amended 7: tests reassigned; red window stated |
| P2-13 I5 vs F34 | Amended I5(b) |
| P2-14 `parked_chunk_quiet` | Amended unit 1, T57, `checks.ts` in 5.2 |
| P2-15 determinism probe | Amended 7.2: at least 2 instance ids, 12 calls, repeat up to 3 times |
| P2-16 quiet rule | Amended 7.3 |
| P2-17 scripts in scratchpad | Amended 7.3: absolute source named; the copy is a step of the quality run |
| P2-18 pinned route | Accepted as I9 (removes F3/F4 route flips, V5, most releases) |
| P2-19 region branch | Accepted: dropped. Over-cap photos take tiles, then downscale, then hold (owner: get the output) |
| P2-20 quality tooling | Accepted: the quality run is step 9 with its own report; the reliability bar stays |
| P2-21 text and counts | Corrected; `scale-model.ts` in C13 and 5.2; 5.1 no longer lists files 5.2 changes |
| Owner (2026-10-30) Use as is | I5(a), 3.6, F13, T13, T59, `plain_accepted` event and INFO check |
| Owner (2026-10-30) patience | I6, I8, 3.4 step 9, 3.8, 3.9, F18, F19, F24, F24b, F25, F25b, F26, F27, F40, F49, F54, F55, T18, T19, T24-T27, T42, T52, T55 |
| Owner (2026-10-30) over-cap | 3.2 routes, F6, F28, F50-F52, T6, T28, T53, T54 |
| Owner (2026-10-30) no cost ceiling | 3.9, 7.2, 7.3, 8: no ceiling anywhere; bounds are for correctness; the CPU quota is the real limit and its increase is named |
| Scope-guardian: is "Try again" required | Kept: it is the only recovery that re-makes the image after an outage-era terminal, and the owner's "Use as is" exit covers the rest |
| Verification (`.runs/2026-10-30-18-lifecycle-plan-verify.md`) | |
| N1 poison input is a delay forever | Amended 3.4 step 9, I6, F56, T61, T40 (k): an unexplained failure is re-probed; healthy -> counted toward the 24 budget |
| N2 health probe livelock on cold start | Amended 3.4 step 7, 3.1 `probe_timeouts`, `shape.sh` `UPSCALE_COLD_START_S` (gate-measured, default 120 s, timeout +60 s), F57, T62, 7.2: after 3 consecutive probe timeouts the call is made anyway and classified by the re-probe |
| N3 head-only done vs. render validation | Amended 3.3, 3.4 steps 5 and 9, 3.1 `out_w, out_h`, F58, T63, definition of done: one `validateEnlargedObject` in core, used by the handler on its reply and on heads and by `primeReadiness`; a refused object counts one attempt and is re-made |
| N4 size arithmetic vs. tests | Amended 3.2: `ENLARGE_MAX_OUTPUT_PIXELS` (64 MP) applies to every route, `scale = min(f, sqrt(64M / P))`, `enlargedDims` by floor, direct limits 8 MP (x2) and 4 MP (x4), worked examples; T28, T53, T54 recomputed; a shape test ties the limit to `WORKER_MEMORY` |
| P2-new-1 identity churn | Amended 3.4 step 4, I3, F59, T64: 3 releases per batch and photo, then terminal with its own sentence |
| P2-new-2 enqueue failure after an unpark on a done batch (P1-1 partial) | Amended 3.8, F60, T65: the lapsed and lost-task rules run for every live batch with a queued or running chunk |
| P2-new-3 prepare and convert errors | Amended 3.4 step 4, F61, T66: matting or storage down -> delay; raw gone or corrupt -> counted `bad_source` |
| P2-new-4 tile budget at zero | Amended 3.2 route 2, F62, T67: at least one tile per delivery |
| P2-new-5 render busy-loop on a queued product | Amended 3.3, 3.5 step 4, F63, T68: reconcile per product before preparing; a queued product is skipped, the chunk parks at the end |
| P2-new-6 fractional scale misaligns colour and alpha | Amended 3.2 route 3, 3.1 `out_w, out_h`, T69: crops map by `out_w / width`, extract outward then resize with the exact fractional offset, mask-edge test on fakes |
| P2-new-7 very large photo with a small product is held | Accepted as a residual risk (section 8) with the size-hold count; a crop route is its own spec if it ever appears |
| P2-new-8 old web shows empty event labels during the shift | Noted in section 8; cosmetic |
| P2-new-9 counts drift (P2-21 partial) | Corrected: verdict line 5 counts F1-F63 plus F8b, F24b, F25b (66 rows) and T1-T69 (67 scenario tests plus T39 and T40) |
| P2-17 partial (scripts in a temp folder) | Amended unit 8: the scripts are copied from the named session scratchpad into `apps/worker/src/catalog-output-evals/bake/` in this pass |
| Final self-check: every repeating path progresses or counts | Section 3.10, the termination argument, plus T40 checks (k) and (l) |
| Narrow check 2 (`.runs/2026-10-30-18-lifecycle-plan-verify-2.md`), final round | |
| P1-A re-probe reads "full" as "absent" (N1 and N2 partials) | Amended I6, 3.4 step 9, 3.10 (intro and three rows), F56, F57, T61 (runs a-d incl. `saturated`), T62 (forced call that fails), T40 `saturated` mode: a failure is uncounted only on positive proof of absence (connection refused, DNS error, the service's own 503 body); a probe timeout, 429 or "no instance" counts |
| P1-B output size `floor(width x scale)` vs. the service's `f x shrunk` | Amended 3.2 (definition, route 3, every worked example), 3.1 `out_w, out_h`, T53 (2400x2400: shrunk 1999, out 7996), T69 (non-integer case): `out = f x shrunk`, `scale` never computes a size |
| P1-C identity cap counts rows | Amended 3.1 `identity_releases`, 3.4 step 4, 3.9, 3.10, F59, T64, T40 (e): release events summed per (batch, photo), never reset by a re-want, reset by Try again |
| `<session>` placeholder (cosmetic) | Removed from 7.3; the scripts live in the repo after unit 8 |
| Plan status | FROZEN 2026-10-30 (top of the document) |

## 10. Progress (milestones only; not a design change)

- [x] Lifecycle built and merged: #125 (2026-10-30), with #126 to #129 from its first deploys.
- [x] Deployed through the gate; the worker gate's smoke passed.
- [x] Load driver pins `options.enlargement` at Start like the web: #128.
- [x] Live test (7.3 reliability bar) PASS on CPU: load c90d496c, 8,415 of 8,415 `upscaled`; operator batch
      0af259f9 finished in 75 min (`.runs/2026-10-30-18-load-5.md`). The deliberate faults of 7.3 were not run.
- [x] Service-level max set on every deploy: #130. CPU scale-out to the granted quotas: #131.
- [x] GPU upscaler `catalog-upscale-gpu` (RTX PRO 6000, asia-south2): #132, #133, #134; deployed 2026-10-31 at
      747c854.
- [x] GPU made the default target for new batches: #135, deployed 2026-10-31 at a26ad15; GPU check acc773a5 PASS
      (5 products in 4 min 11 s).
- [x] Close-out: test cleanup, invariants zero ERROR outside 09dd86f2, spec 18 section 14 and final reports, owner
      status doc, solutions entry (`docs/solutions/2026-10-31-spec-18-live-lessons.md`).
- [ ] A 200-product load on GPU: not run yet.
