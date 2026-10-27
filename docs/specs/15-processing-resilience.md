# 15 Processing resilience (release E)

Catalog module, spec 15. Execute with `docs/specs/00-execution-protocol.md`. Source of truth:
`docs/SPEC.md` (pipeline, chunks, sweeper, `docs/SPEC.md:787-810`). Evidence: the investigation of batch
09dd86f2 (2026-10-27) and its gap analysis `.runs/2026-10-27-batch-09dd86f2-gaps.md` in the main checkout.
Depends on 02, 05, 06 and 07 (merged) and on migration `0003_intake_states.sql` from 14b (PR B, #102; this
spec ships `0004`). It is independent of spec 14 releases C and D, which forbid processing changes
(`14-intake-resilience.md` section 12). Branch `feat/catalog-15-processing-resilience`, stacked on
`feat/catalog-14b-intake-inputs` (PR B) so that `0003` lands before `0004`; it is rebased onto `main` after
PR B merges. Worktree `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\15-processing-resilience` (a builder may
work in its own isolated worktree instead).
Deploys: migrate job, `catalog-worker`, `catalog-web`. It also changes `infra/bootstrap.sh` (the sweep cadence) and
`infra/monitoring.sh` (one policy). Ships as one PR, called PR E.

Status: APPROVED by the owner on 2026-10-27 (build, migration `0004` included). Section 13 records the decisions.

Plain-language terms. Chunk: a group of whole products that moves through cut-out (`matte`), image making
(`render`) and the quality check (`qa`) together. Delivery: one HTTP request from the queue to the worker for
one chunk. Lease: a claim with an expiry time that its holder renews while it works; when the holder dies, the
lease runs out and someone else may take over. Heartbeat: the regular renewal of a lease. Hand-off: a
delivery stops early, saves what it did and queues the rest as a new task. Step: a counter on the chunk that
names its one current task; a task with an old step is stale. Window: the most chunks of one batch that may
be in the queue or running at once.

## 1. What changes for the operator

- Large batches finish without the work being repeated or lost: no request runs past its time limit, and
  no running chunk is taken over while it is still working.
- A second batch started while a big one runs starts making images within minutes instead of waiting
  for the big one's whole queue.
- The batch page shows what is really happening: "Preparing photos 340 of 1,400 · 120 of 5,600 images
  made · about 25 min left". The time comes from the measured speed. When the usual time is passed, the page
  says so instead of "about 1 min left". When nothing has moved for 20 minutes, it says that the system is
  retrying by itself.
- The false "Starting the image services..." line no longer stays up for an hour.

## 2. Scope

In scope: `apps/worker/src/catalog/{chunk,qa-stage,sweep,deps}.ts`, new
`packages/core/src/catalog/pipeline/dispatch.ts` (window, budget and task ids), `packages/core/src/tasks.ts`
(a `chunkTaskId` helper only), `packages/core/src/db/schema.ts` and new
`packages/core/drizzle/0004_chunk_leases.sql` (+ snapshot and journal), `packages/core/src/catalog/pipeline/status.ts`
(processing text), `packages/core/src/catalog/types.ts` (`BatchCounts` fields), `apps/web/lib/catalog/{start,decisions}.ts`
(dispatch through the window), `apps/worker/src/catalog-load.ts` (same), `infra/deploy.sh` (chunk size,
window and budget env), `infra/bootstrap.sh` (sweep cron check-then-update), `infra/monitoring.sh` with a new
policy JSON under `infra/monitoring/policies/`, `docs/solutions/chunk-leases.md` (new), and tests.

Out of scope: intake (spec 14); per-photo concurrency, stage queues, GPU residency, the judge limiter and the
Cloud SQL tier (the parked throughput plan `docs/plans/2026-10-21-throughput-7000.md`); always-on CPU;
raising the 900 s deadline; publish and finalize (their tasks are short today). Builders fetch current
docs through Context7 for `@google-cloud/tasks`, drizzle-orm (migrations, `FOR UPDATE SKIP LOCKED`), and the
gcloud commands `scheduler jobs update http`, `logging metrics create` and `monitoring policies create`.

## 3. Fixes

Sentences in quotes are exact. Fix ids E1 to E8.

### 3.1 E1: a delivery never reaches the deadline (time budget and hand-off)

- Builder constant `CHUNK_TIME_BUDGET_MS = 480_000` in `dispatch.ts`. The env `CATALOG_CHUNK_TIME_BUDGET_MS`
  (positive integer, at most 480000) may lower it, and is used only for proof runs (sections 6 and 9).
  Function `budgetLeft() = started + budget - deps.now() > 0`.
- `handleChunkTask` checks `budgetLeft()` before each product and before each source in all three stages:
  - matte: before the per-source block (`chunk.ts:157`). A source with `matteUri` set is already skipped.
  - render: before each source in the prepare loop and before each source's outputs (`chunk.ts:235,255`).
    A mid-product stop is safe because staged outputs are skipped and the product plan is rebuilt from the
    stored mattes (`chunk.ts:239-243,261`). A test asserts the same canvas both ways.
  - qa: `runQaStage` gains `shouldStop: () => boolean` and returns `{ complete: boolean }`. It stops between
    photo groups (`qa-stage.ts:122`) and skips `applyTriage` (`qa-stage.ts:204`) for a product that is not
    complete. The continuation judges only rows with `qaScores IS NULL` (as today) and then triages.
- The QA back-off budget becomes `min(QA_DELIVERY_BACKOFF_MS, started + DISPATCH_DEADLINE_SEC*1000 - 120_000 - now)`.
  The matte retry and guard deadlines (`chunk.ts:63,201`) are unchanged.
- When the budget stops the loop: the end-of-delivery writes run as today (compute row and ledger flush,
  `chunk.ts:300-308`; `refreshBatchProgress`). Then, in one update guarded by `ownsClaim()`:
  `status='queued', step=step+1, lease_until=null, task_name=null, dispatched_at=now`. Then it enqueues
  `chunkTaskId(id, stage, step+1)` with body `{chunkId, stage, step}`, logs the delivery line (E7) with
  `outcome: "handed_off"`, and returns 200. If the enqueue throws, it logs WARNING `chunk dispatch failed` and
  returns 200; the sweep re-dispatches it (E4).
- A stage advances only when its loop finished without a budget stop.
- Acceptance (tier 2, `pipeline.test.ts`, fake clock in `deps.now`, fake matting that advances the clock):
  1. 10 photos at 60 s each, budget 480 s: delivery 1 does 8 photos and hands off (`chunk-<id>-matte-1`);
     delivery 2 does 2, advances to render and enqueues `chunk-<id>-render-2`; no photo is matted twice
     (fake call count 10).
  2. Worst case: a photo that starts at 479 s and takes 400 s ends at 879 s. No simulated delivery passes
     900 s in any test of this file (a helper asserts it on every delivery).
  3. Render stopped mid-product: the final canvas, scale and placement of every output equal those of an
     uninterrupted run.
  4. QA stopped between groups: triage runs once per product, after its last group; judged rows are not
     judged again.
  5. A hand-off writes one compute ledger row for its own delivery (the sum over deliveries equals the
     wall time x 2 vCPU, as today).

### 3.2 E2: heartbeat lease

- Column `lease_until timestamptz` (section 4). Builder constants `CHUNK_LEASE_MS = 120_000` and
  `CHUNK_HEARTBEAT_MS = 30_000`.
- Claim (replaces `chunk.ts:82`): `status='queued'`, or `status='running' AND coalesce(lease_until,
  started_at + interval '960 seconds') < now`. The `coalesce` covers pre-E rows. It sets `running`, the claim
  UUID, `lease_until = now + CHUNK_LEASE_MS`, `started_at`, and `attempt = attempt + 1`.
- Heartbeat: after the claim, a timer every `CHUNK_HEARTBEAT_MS` runs `UPDATE ... SET lease_until = now +
  CHUNK_LEASE_MS WHERE ownsClaim()`. When it updates 0 rows, it sets a `lost` flag. It stops renewing after
  `started + DISPATCH_DEADLINE_SEC*1000`, so anything that outlives its request lets its lease lapse within
  120 s. The timer is cleared in a `finally`. `underClaim` throws "Chunk ownership changed." when `lost` is set,
  and its row lock becomes `UPDATE ... SET lease_until = ... WHERE ownsClaim() RETURNING id`, so every write also
  renews.
- `CATALOG_TASK_LEASE_MS` (`deps.ts:55`) is kept only for the legacy `coalesce` above. The sweep no longer
  uses it.
- Acceptance (tier 2, `pipeline.test.ts`): a delivery holding a live lease with heartbeats is never claimed
  by a second delivery at any clock time up to its deadline; after the holder's heartbeat stops (test hook)
  and 121 s pass, a second delivery claims it, and the first's next `underClaim` throws; heartbeat renewal
  stops at the deadline; a row with `lease_until` null and `started_at` 10 min ago is not claimable, and one
  17 min ago is.

### 3.3 E3: one live task per chunk (step tokens)

- `chunkTaskId(chunkId, stage, step)` returns `chunk-<chunkId>-<stage>-<step>`. Every chunk enqueue uses it,
  with body `{chunkId, stage, step}`: Start and window (E5), the advance to render and qa (`chunk.ts:313,319`),
  hand-off (E1), sweep (E4), replacement (`apps/web/lib/catalog/decisions.ts:35`), load
  (`catalog-load.ts:153`), and the resume path of Start (`start.ts:19-22`). The stage advance also does
  `step = step + 1, dispatched_at = now`. It sets `attempt = 0` so log attempts count per stage and the first
  delivery logs 1.
- Handler order, before any claim:
  1. Chunk missing: 200 `not_found` (today). Done or failed: 200, as today (`chunk.ts:80`).
  2. The body carries `step` and (`stage`, `step`) differs from the row's: 200 `stale`, no write.
  3. The body has no `step` (a legacy task from before E): it may claim only a row with `step_known = false`
     (a pre-E row, section 4); a successful claim sets `step_known = true`. Any other row gives 200 `stale`.
  4. Claim refused because a live lease exists: when the body's step equals the row's and
     `retryCount < 3`, answer 503 `busy`. This is the same task's own retry after a crash, and it will claim
     once the lease lapses (back-off 10, 20, 40 s). Otherwise answer 200 `duplicate`, no write.
- The terminal rule stays `retryCount >= 4` with a thrown error (`chunk.ts:328-334`). It now counts only real
  errors, because hand-offs, stale and duplicate tasks never fail.
- Acceptance (tier 2): three copies of one task arriving while a delivery is live: the two other-step
  copies answer 200 with no row change, and the fake queue gets no new task; a render-step task arriving
  while the row is in qa answers 200 `stale`; the same-step retry after a simulated crash claims after the
  lease lapses; `tasks.test.ts`: `chunkTaskId` matches the task id rule (`tasks.ts:81`).

### 3.4 E4: the sweep recovers only dead chunks

Replaces `sweep.ts:54-67`. The 2-hour batch failure (`sweep.ts:68-99`) stays. Runs per batch in `matting`,
`rendering` or `qa`:

- Dead holder: `status='running' AND coalesce(lease_until, started_at + 960 s) < now`. It sets `queued`,
  `step+1`, `step_known=true`, `dispatched_at=now` and enqueues the new step's task.
- Lost task: `status='queued' AND dispatched_at < now - CHUNK_QUEUED_STALE_MS` (builder constant 30 min).
  It re-dispatches with `step+1`. If the old task was only slow, it now answers `stale`, so a mistaken
  recovery costs one no-op request.
- Window top-up: E5's `dispatchChunks(batchId)`.
- Never: a `running` chunk with a live lease, or a `queued` chunk dispatched less than 30 min ago.
- Stalls: column `progress_at`, set under the claim each time a photo finishes in any stage. At claim
  time, if the previous delivery of this chunk finished no photo (`progress_at` older than that delivery's
  `started_at`), `stalls = stalls + 1`, otherwise `stalls = 0`. At `CHUNK_MAX_STALLS` (3) the delivery takes the
  terminal path: the chunk fails, pending outputs fail with "Processing stopped: no photo finished in three tries in a
  row.", and the line `chunk failed` logs at ERROR (existing alert 1).
- One INFO line per recovery: `chunk recovered` `{batchId, chunkId, stage, step, reason: "lease_lapsed" |
  "task_lost"}`.
- Cadence: `SWEEP_CRON="*/10 * * * *"` in `bootstrap.sh:26`. `ensure_scheduler_job` (`bootstrap.sh:492-505`)
  becomes check-then-update: when the job exists with another schedule, run `gcloud scheduler jobs update http`
  with the new one; the second run prints SKIP. The 2-hour rule stays.
- The Start resume path (`start.ts:19-22`, a second press on a processing batch) runs the same per-batch
  rules instead of re-enqueueing every queued chunk.
- Acceptance (`sweep.test.ts`, tier 2): a queued chunk dispatched 10 min ago, in a batch whose other
  chunks run, is untouched; at 31 min it is re-dispatched once with `step+1`, and a second sweep run in the same
  minute changes nothing; a `running` chunk with a live lease is untouched at 5 h of age; a lapsed lease
  is recovered; the old-step task then answers `stale`; three no-progress deliveries fail the chunk with
  the sentence above; the fake queue never holds two live-step tasks for one chunk across a 2-hour
  simulated run with random crashes (property-style test, 50 seeds).

### 3.5 E5: a window per batch (stage and batch fairness, bounded queue)

- Column `dispatched_at timestamptz`. `dispatchChunks(db, enqueue, batchId, window)` in `dispatch.ts`:
  in one transaction, it counts the batch's chunks with `dispatched_at` not null and status not done or
  failed. It selects up to `window - active` rows with `dispatched_at IS NULL ORDER BY index FOR UPDATE SKIP
  LOCKED`, sets `dispatched_at = now`, commits, then enqueues `chunkTaskId(id, "matte", step)`. It is
  idempotent: a second call with a full window does nothing.
- Window: env `CATALOG_CHUNK_WINDOW` (default 8 = `TASKS_MAX_DISPATCHES` + 2, so a freed slot always finds a
  waiting task), set in `deploy.sh` for web and worker.
- Callers: `startBatch` (`start.ts:61`, replacing the loop); `finish()` in `chunk.ts:339-343` after a chunk
  is done or failed; the sweep (E4); `catalog-load.ts:153`. A replacement chunk (`decisions.ts:35`) is created
  with `dispatched_at = now` and dispatched at once (one chunk, outside the window).
- Batch status words are unchanged. The batch moves to `rendering` at the first advance (`chunk.ts:312`) and to
  `qa` when every chunk has reached qa (`chunk.ts:318`).
- Acceptance (tier 2): a batch of 20 chunks with window 3: Start enqueues 3; each finished chunk enqueues
  exactly one more; at the end all 20 are done, and no chunk was dispatched twice. Two batches A (20 chunks)
  and B (2 chunks) on a FIFO fake queue with 2 slots: B's first image is made before A's 6th chunk starts.
  At any time the queue holds at most `window` chunk tasks per batch.

### 3.6 E6: chunk size 10

- `deploy.sh:35` default `CATALOG_CHUNK_IMAGES` 25 becomes 10. `docs/SPEC.md:787-788` gets updated in the docs PR
  (section 11). `planChunks` is unchanged: a product with more than 10 photos is its own chunk.
- Reason: at the measured 23-61 s per photo (investigation 5.1), 10 photos take 4 to 10 min per stage, so
  most stages finish in one delivery and hand-offs stay the exception.
- Acceptance: `plan-chunks.test.ts` keeps passing; a deploy-script test (`infra/tests`) asserts the default
  is 10 and that a non-integer value is refused (as today, `deploy.sh:36`).

### 3.7 E7: the operator sees true processing progress

- `refreshBatchProgress` (`deps.ts:67-73`) adds to `counts`: `prepared` (sources of the batch with
  `matte_uri` set, or status `failed`, or flagged `chart_image`), `progressAt` (max `progress_at` of the
  batch's chunks), and `processingRate`: the last 5 samples `{ at, made }`, appended when `made` changed.
  It is called at the end of every delivery, hand-offs included.
- `deriveBatchState` for `matting`, `rendering` and `qa` (`status.ts:71-80`):
  - Text: when `prepared < sources`, "Preparing photos <prepared> of <sources> · <done> of <planned> images
    made<notMade><time>." otherwise "<done> of <planned> images made<notMade><time>." followed by
    `CLOSE_PAGE_TEXT`.
  - Time: from the `processingRate` samples at least 60 s apart, "about <m> min left". With no rate and
    elapsed time under the step 4 range's upper end, the range less the elapsed time (today's
    `timeLeftText`, `status.ts:52-58`). With no rate and elapsed time past the range's upper end, "taking longer
    than usual". It is never "about 1 min left" from a fit.
  - Stall: when `now - progressAt > PROCESSING_STALL_MS` (builder constant 20 min), add the sentence
    "Nothing has moved for <m> minutes. The system is retrying by itself; you do not need to do anything."
  - `STARTING_SERVICES_TEXT` shows only while `prepared` is 0 and less than 5 min have passed since Start.
  - The list pill is unchanged: "Processing <done> of <planned>".
- Log: one INFO line `chunk delivery` per delivery: `{batchId, chunkId, stage, step, attempt, outcome:
  "done" | "handed_off" | "stale" | "duplicate" | "busy" | "lost" | "failed", photos, ms, msPerStep: {download,
  prepare, matte, guard, render, upscale, judge, write}}`. The existing `chunk delivered` line is kept for the
  old filters.
- Alert: a log-based metric `catalog/chunk_timeout` on the Cloud Run request log (`catalog-worker`,
  `httpRequest.status=504`, `requestUrl` containing `/tasks/catalog/chunk`) and policy 10 "A chunk task ran out of
  time", firing on more than 0 in 15 min to `catalog-email-tech`. After E a 504 means the budget is wrong. The
  policy is created check-then-create in `monitoring.sh`. Before creating it, the builder confirms the current
  Cloud Monitoring alerting price (unverified here) and reports it.
- Acceptance: tier 1 `status.test.ts` for each sentence and state: preparing; making; measured time; range;
  "taking longer than usual"; stall at 21 min and none at 19; the starting-services line at 4 min and not at 6.
  No "about 1 min left" appears for a batch 2 h past its range with no rate. Tier 2: a delivery and a hand-off
  each move `prepared` and `processingRate`. `monitoring.test.mjs` covers the new metric and policy filters.
  The spec 07 no-model-names test runs over the new sentences.

### 3.8 E8: rollout without a purge (legacy tasks and rows)

- Migration `0004_chunk_leases.sql` (section 4) backfills `dispatched_at = coalesce(started_at, created_at)` and
  `step_known = false` on existing rows. Pre-E chunks are therefore never dispatched a second time by the window.
- Legacy tasks (body `{chunkId}` only, including the `-recovery-` copies) go through E3 rule 3. The first one
  that meets a claimable row adopts it and sets `step_known = true`. Every other copy answers 200 `stale` or
  `duplicate` in milliseconds. A bloated queue drains by itself in a few minutes of slot time. There is no
  `gcloud tasks queues purge`: it would also delete other batches' publish and finalize tasks.
- Acceptance (tier 2, a "legacy" fixture): a batch in the state of 09dd86f2. That means 6 chunks `running` with
  `started_at` from 2 to 20 min ago, 10 `queued` chunks, and 3 legacy tasks per chunk plus 2 recovery copies.
  After migration: no running chunk with `started_at` under 16 min is taken over; every chunk finishes
  exactly once; the queue ends empty; every legacy copy past the first answers 200.

## 4. Data and state changes

Migration `packages/core/drizzle/0004_chunk_leases.sql` (additive; approved by the owner on 2026-10-27, section 13):

```sql
ALTER TABLE catalog_chunks
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN step integer NOT NULL DEFAULT 0,
  ADD COLUMN step_known boolean NOT NULL DEFAULT true,
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN progress_at timestamptz,
  ADD COLUMN stalls integer NOT NULL DEFAULT 0;
UPDATE catalog_chunks SET dispatched_at = coalesce(started_at, created_at), step_known = false;
```

`schema.ts` `catalogChunks` gains the six columns. New rows from E: `attempt` set to 0 in code at insert and at
each stage advance (the column default is unchanged).

`BatchCounts` (jsonb, no migration): `prepared: number`, `progressAt: string | null`, `processingRate: { at: string;
made: number }[]`. `EMPTY_BATCH_COUNTS` gets defaults, and old rows read as 0 or null.

Task contract (02 change, proposed in the report): the chunk body becomes `{chunkId, stage, step}`, and the
chunk task id becomes `chunk-<chunkId>-<stage>-<step>`.

Env: `CATALOG_CHUNK_IMAGES` default 10; `CATALOG_CHUNK_WINDOW` default 8 (web and worker); optional
`CATALOG_CHUNK_TIME_BUDGET_MS` (worker; unset means 480000). Builder constants: `CHUNK_TIME_BUDGET_MS` 480 s,
`CHUNK_LEASE_MS` 120 s, `CHUNK_HEARTBEAT_MS` 30 s, `CHUNK_QUEUED_STALE_MS` 30 min, `CHUNK_MAX_STALLS` 3,
`PROCESSING_STALL_MS` 20 min. Infra: sweep cron every 10 min; metric `catalog/chunk_timeout` and policy 10.

Cost: no always-on resource. The heartbeat adds about 12 small updates a minute at 6 running chunks. The sweep
adds 144 short requests a day on a min-instances 0 service. Scheduler pricing is per job, not per run. Policy 10:
the alerting price is to be confirmed by the builder.

## 5. Copy

New sentences (processing banner and batch page):
- "Preparing photos <prepared> of <sources> · <done> of <planned> images made<notMade><time>."
- "taking longer than usual" (in the `<time>` slot, as " · taking longer than usual")
- "Nothing has moved for <m> minutes. The system is retrying by itself; you do not need to do anything."
- Output reason: "Processing stopped: no photo finished in three tries in a row."

Changed behaviour: "Starting the image services. The first pictures usually take a minute or two on the first
batch after a quiet spell." now shows only in the first 5 minutes, before any photo is prepared. No model
name and no technical word appears; "cut-out", "chunk" and "lease" never reach the operator.

## 6. Acceptance tests

- Tiers 1 and 2 (`pnpm test`, CI): every "Acceptance" item of section 3, in `pipeline.test.ts`,
  `sweep.test.ts`, `status.test.ts`, `tasks.test.ts`, `plan-chunks.test.ts`, new `dispatch.test.ts`,
  `catalog-wizard-routes.test.ts` (Start dispatches `window` tasks, not all chunks; today's assertion at line
  169 changes to the new id), `infra/tests/monitoring.test.mjs`, and an `infra/tests` check of the deploy and
  bootstrap defaults. The spec 06 and 07 suites stay green.
- A no-deadline guard in the test helper: every simulated delivery in `pipeline.test.ts` asserts
  `elapsed < 900 s`.
- Tier 3: `REAL_DATA=1 pnpm test:real` on the existing set, with `CATALOG_CHUNK_TIME_BUDGET_MS=60000` and
  chunk size 10. At least one real hand-off per stage, and outputs equal to a run without hand-off (same render
  keys and byte counts). Matting runs locally in Docker. OpenRouter is mocked.
- Tier 5: runs inside `infra/deploy.sh` as always (the smoke batch is small; it must pass with the new task ids).

## 7. Fixtures

- `pipeline.test.ts` gains a fake clock and a slow fake matting and judge (per-call duration parameter).
- The legacy-state fixture of E8 (rows and queued legacy task bodies), built in the test from the
  09dd86f2 shape: 58 chunks, 6 running, 18 done, 2 failed and the rest queued, scaled down to 16 chunks.
- No new image fixtures; tier 3 reuses the existing real-data set.

## 8. Local verification

From the feature worktree: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`, then
the tier 3 run of section 6 with Docker matting. The `bootstrap.sh` and `monitoring.sh` changes cannot run
locally. They are covered by `infra/tests` here and by the two live re-runs of section 9 step 4.

## 9. Live verification (after deploy, Test Brand only)

Step 0, the quiet check: no operator POST on `catalog-web` in the last 60 minutes, and no batch in `ingesting`,
`matting`, `rendering`, `qa` or `publishing`, except 09dd86f2 if the owner chose option (b) in section 13. No
load or eval runs while an operator is active. Every object goes under `catalog-test/test_brand/<batchId>/`.

1. Drain: `gcloud tasks list --queue=catalog --location=asia-south1 --limit=1000` (read only) within 15 min of
   the deploy shows at most `window` chunk tasks per processing batch. The worker log shows legacy copies
   answering `stale` or `duplicate` and no `Chunk ownership changed`.
2. A 30-photo Test Brand batch (3 chunks of 10) on the production stack: zero 504 on `/tasks/catalog/chunk`; zero
   `chunk recovered`; every `chunk delivery` line under 900 s with `msPerStep` recorded; the batch page
   shows "Preparing photos" moving, then images made with a measured time, and finishes `done`.
3. Hand-off proof on the preview stack only:
   `CATALOG_PREVIEW=1 CATALOG_CHUNK_TIME_BUDGET_MS=60000 bash infra/deploy.sh` (preview services and the
   `catalog-preview` queue; production untouched). Run the same 30-photo batch through the preview web: at least one
   `handed_off` per stage, every chunk done once, and the same outputs as step 2. The builder first confirms that
   the preview stack uses the migrated schema. If it does not, this step is replaced by the tier 3 run and noted
   in the report.
4. `bash infra/bootstrap.sh` twice: the first run updates the sweep cron to every 10 minutes, and the second prints
   SKIP for everything. `bash infra/monitoring.sh` twice: the second prints SKIP.
5. Clean the run's batches with `deleteTestObjects` (allowed under `catalog-test/` only) and confirm an empty
   listing of their prefixes. If the owner chose (a) for 09dd86f2, clean its prefix too once it is `done`.

## 10. Rollout and rollback

Merge, then `infra/bootstrap.sh` (cron update) and `infra/deploy.sh` (migrate job, smoke, worker, web,
monitoring). Rollback per 00 section 6: `SKIP_BUILD=1 bash infra/deploy.sh` from the previous commit. The
migration is additive, and old code ignores the new columns and body fields. Under old code, chunks not yet
dispatched by the window have no task, so the old sweep's age rule re-queues them within 30 min. Rollback
therefore heals itself, with today's inefficiency. The 10-minute cron is harmless for old code.

## 11. Report

The 00 section 10 report, plus: per-fix acceptance results; the tier 3 hand-off evidence; the live
verification log with the quiet-check timestamps, the queue depth before and after the drain, and the
per-step timings of step 2 (this answers the open question of where the matte time goes); the confirmed
alerting price; the 02 contract change (chunk task body and id); a `docs/solutions/chunk-leases.md` note (lease,
steps, window and why no purge); and in the docs PR, `docs/SPEC.md:787-810` updated (chunk size 10, window,
lease, sweep every 10 minutes). Last line: "Ready for the next spec".

## 12. Done when

- [ ] E1 to E8 are built and every acceptance item in section 3 passes in CI.
- [ ] Tier 3 shows real hand-offs with outputs equal to an uninterrupted run.
- [ ] Migration 0004 applied by the migrate job; PR E merged; `catalog-worker` and `catalog-web` deployed;
      tier 5 smoke green.
- [ ] Live steps 1 to 5 done: no 504 and no ownership change on the test batch, the queue drained without
      a purge, bootstrap and monitoring re-runs all SKIP, and `catalog-test/` cleanup confirmed.
- [ ] Report written; `docs/solutions/chunk-leases.md` and the SPEC update merged.

## 13. Owner decisions

Decided 2026-10-27: 1 yes (the owner approved building E, migration `0004` included), 2 yes, 4 yes (builder
defaults). Decision 3 is taken at deploy time by the manager with the owner.

1. Approve migration `0004_chunk_leases.sql` (00 section 11 allows migrations only in 02/03 unless approved).
   Recommended: yes. The alternative (packing the lease into `task_name` and `started_at`) overloads
   columns and was rejected.
2. Order: build E now in its own worktree, in parallel with 14c/14d, deploy it as soon as it is green (deploys
   serialized with spec 14's), and in any case before the real BHPC batch. Recommended: yes.
3. Batch 09dd86f2: (a) let it finish under today's code, then clean its `catalog-test/` prefix (recommended);
   or (b) deploy E while it runs (E8 adopts it safely). Either way, 14c section 9 step 3 changes: a started batch
   cannot be cancelled.
4. Window default 8 and chunk size 10, as builder defaults that later measurements may tune. Recommended: yes.

## 14. Assumptions

1. Photo times from the investigation (23-61 s per photo in matte) are representative. E7's per-step log
   measures them on the first live batch.
2. The longest single photo, started just before the budget, finishes within 420 s: the first cut-out call
   is capped at 180 s (`MATTING_TIMEOUT_MS`, `packages/core/src/catalog/matte.ts:37`), retries and the guard
   ladder stop at 660 s (`chunk.ts:63,201`), and the QA back-off is capped by E1. Tier 2 proves the bound with
   fakes. A pathological photo is caught by the stall rule (E4).
3. Cloud Run instance clocks are synchronised closely enough for 120 s leases compared in application time
   (the code already compares lease times in application time).
4. Cloud Tasks dispatches older tasks roughly first. Nothing in E depends on it for correctness, only for the
   fairness measured in tier 2 with a FIFO fake.

## 15. Non-goals

- No higher deadline, no always-on CPU, no more worker instances or connections.
- No per-photo parallelism, stage queues, GPU or judge changes (the parked throughput plan).
- No queue purge and no deletion of any GCP resource.
- No change to publish, finalize, locks, `assertWithinProduct` or the scoped overwrite rule.
- No new operator setting. Chunk, lease and step never appear in the UI.
