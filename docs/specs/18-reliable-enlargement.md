# 18 Reliable enlargement on CPU: measured upscaler, durable enlargement, hold on failure (release H)

Catalog module, spec 18. Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`.
Depends on spec 17 (release G, code-complete and live at main 999ada0). Branch
`feat/catalog-18-reliable-enlargement`; one worktree per stream under
`C:\Users\Sujan Ajay\Desktop\catalog-module-wt\18-<stream>`; one PR per stream (H1 to H5; H1 and H2 may share one
PR, section 10), each merged on its own, in the order of section 10. Never on `main` directly.

Owner instruction (Sujan, 2026-10-29, in the owner's words): "solve this entire problem end to end via just the CPU
that we have ... reliable ... does not break in the middle. It's okay if more time is being taken." Speed comes
later with GPUs. "Close out any open bugs that are there, and make sure the product is live." Full authority to
merge and deploy; no babysitting; the manager delegates everything to subagents.

Owner decisions (Sujan, 2026-10-29):
1. On terminal enlargement failure: hold the product for the operator with the reason "enlargement failed".
   Never publish a plain resize silently.
2. Add a dedicated CPU enlargement service `catalog-upscale` (same image), deployed through the spec 17 gate.
3. Migration `0005` on `catalog_source_images` (per-photo enlargement columns `x2_uri`, `x2_model`, `x2_error`,
   `x2_attempts`) is approved. It is a contract change to 02 (only specs 02 and 03 ship migrations, 00 section 11),
   approved with this spec: quality and simplicity over the no-migration workaround, which would hide engineering
   state in `catalog_outputs.compliance` jsonb.
4. The `docs/SPEC.md` contract change "an enlargement that fails holds the output with a reason; a plain resize
   never stands in" is approved (section 3.5.2).
5. Soft delete on the buckets stays at Google's 7-day default (H4 e).
6. Spec 17 G5 is finished inside this spec, and spec 17's final report ends "Blocked: 150 photos/min not reached".
7. Cost ceiling for this spec's live steps: USD 40 (probes about 3, load about 25 with a 2-hour enlargement,
   operator batch about 1, margin).
8. The SPEC.md decision of 2026-10-21 stands and is now enforced: the upscaler is on wherever a photo must be
   enlarged beyond 1.5x, and cost is not a concern (`docs/SPEC.md` "Image enhancement").

## Words used here

- Enlargement: making a photo bigger than its source pixels to fill a channel's canvas. Scale: canvas px per source
  px on the limiting side. A photo "needs enlargement" when some channel's plan has scale > `UPSCALE_MIN_SCALE` (1.5).
- Upscaler: the AI model (x2, deterministic) that doubles a photo's pixels before the render resizes it to the
  canvas. Plain resize (Lanczos): the old non-AI enlargement. Plain fallback: a plain resize used because the
  upscaler failed. After this spec there must never be one (except `UPSCALE_MODEL=off`, the upscaler deliberately
  disabled).
- Tile: the fixed square the ONNX export of the upscaler works on (384 px today); a photo is cut into tiles that run
  one at a time. vCPU: one virtual CPU core of Cloud Run. Threads: `ORT_INTRA_OP_THREADS`, how many cores ONNX
  Runtime uses for one tile.
- Stored x2: the upscaler's 2x image of one source photo, written once to the private assets bucket and read by the
  render. Enlargement task: one Cloud Tasks task that makes one stored x2.
- p50, p95, p99: the time under which 50, 95 or 99 of 100 calls finish.
- Held product, silent output, probe, gate, candidate, invariant: as in spec 17 "Words used here".
- Manager: the main session. Builder, review, watcher, researcher, planner: subagents with their own context.

## 0. Why this spec exists (what happened on 2026-10-29)

Spec 17 is code-complete and live, but the 2026-10-29 200-product test showed the photo enlargement step (AI
upscaler, SwinIR x2) never works in production: 935 of 935 enlargements fell back to a plain resize, silently and
with no flag. Causes, from the code and the logs (evidence gathered 2026-10-29 by three read-only subagents,
pointers at origin/main 999ada0):

1. The real unit cost was never measured under load. Spec 16 assumed 5.9 to 7.8 s per photo (3.1.3, from the spec 11
   CPU smoke); the scale model assumes 7 s (`apps/worker/src/catalog/scale-model.ts`, `cpuService.upscaleMs`); the
   test measured about 121 s on the 4 vCPU CPU service (12 SwinIR tiles, one at a time).
2. The call is synchronous inside the render with a hard 60 s constant (`packages/core/src/catalog/upscale.ts`
   `UPSCALE_TIMEOUT_MS`), no retry on timeout or 429, a breaker that trips after 5 failures and switches enlargement
   off per worker (`packages/core/src/catalog/matte.ts` `upscaleBreaker`, `BREAKER_FAILURES`), and a `/health` gate
   that times out behind the single-slot CPU instance. Up to 192 photos compete for 16 slots. Cloud Run keeps running
   the abandoned request, so the slot stays busy.
3. Failure is silent: plain Lanczos resize, no flag, no hold, no cost row (`upscale.ts` `sourceX2` logs
   `upscale failed; used the plain enlargement` at WARNING and returns null). The owner decision of 2026-10-21
   (`docs/SPEC.md` "Image enhancement": upscaler on wherever a photo must be enlarged beyond 1.5x, cost is not a
   concern) is not honoured today.

The lesson, from first principles, continues spec 17's (a lesson in a document is not a guard):

| Principle | Guard built here |
|---|---|
| P1. Measure before sizing. Nothing is tuned until the per-photo time is a measured table. | H1 probe `--probe-upscale`, "Measured on CPU" table, shape refusals that read it. |
| P2. Nothing in the hot path waits on a slow service. | H3 durable enlargement: queued, rate-limited, idempotent tasks; the render reads stored bytes only. |
| P3. Client timeout > server timeout > measured p99; retries with backoff; no breaker gating on `/health`. | H2 client `enlarge.ts`, H1 refusal `UPSCALE_TIMEOUT_S >= 2 x p95`. |
| P4. No silent degradation. Every photo that needs > 1.5x ends `upscaled` or held with a reason. | H3 flag `enlargement_failed`, invariant `enlarged_without_upscaler`, plain path only for `UPSCALE_MODEL=off`. |
| P5. Capacity is arithmetic, refused by shape checks when it does not fit. | H1 CPU quota and queue-rate refusals in `infra/lib/shape.sh`. |

## 1. What changes for the operator

- A photo that must be enlarged is enlarged by the upscaler, every time, or the product is held with the reason
  "This photo could not be enlarged to this marketplace's size. Try again, or ask the brand for a larger photo."
  No plain resize is ever published in its place.
- The batch page shows one more phase while enlargements run: "Enlarging photos x of y".
- Big batches with many enlargements take longer on CPU (about 2 minutes per photo, section 13). The time is
  reported, not judged; the GPU follow-up makes it fast.
- The admin Ops page gains two lines: "Enlargements waiting" and "Enlargements failed".
- No model name anywhere on screen.

## 2. Scope

| Stream | Files owned | Depends on |
|---|---|---|
| H1 Measure | `services/matting/tests/cloudrun_check.py` (probe mode `--probe-upscale`), `services/matting/tests/*` (its tests), `infra/check-matting.sh`, `services/matting/app.py` (env `ORT_INTRA_OP_THREADS` only), `services/matting/README.md` ("Measured on CPU"), `infra/lib/shape.sh` (`UPSCALE_*` rows and refusals) and `infra/tests/shape.test.mjs`, `infra/tests/check-matting-probe.test.mjs` | nothing for the code; the measured table needs H2's candidate service |
| H2 Dedicated service `catalog-upscale` | `infra/lib/services.sh` (registry row and probe), `infra/deploy.sh` (worker `UPSCALE_URL`), `infra/bootstrap.sh` (invoker grant), `services/matting/app.py` (env `PRELOAD_MATTE` only), new `packages/core/src/catalog/enlarge.ts` and test, the shared `idTokenFor` helper (extracted from `matte.ts`), `infra/tests/gate.test.mjs` | H1 code (the probe it names as gate probe); traffic only after H1's table |
| H3 Durable enlargement | `infra/lib/queues.sh` and `infra/tests/queues.test.mjs`, `packages/core/src/tasks.ts`, new `apps/worker/src/catalog/enlarge.ts` and test, `apps/worker/src/catalog/chunk.ts`, `packages/core/src/catalog/pipeline/dispatch.ts`, `packages/core/src/catalog/naming.ts` (`enlargedPath`), `packages/core/src/catalog/upscale.ts`, `packages/core/src/catalog/types.ts` (flag), `packages/core/src/catalog/qa/reasons.ts` (flag copy), `packages/core/src/catalog/pipeline/status.ts`, `packages/core/src/catalog/invariants/checks.ts`, `apps/web/lib/catalog/ops.ts` and `ops-copy.ts`, `apps/worker/src/catalog/scale-model.ts`, `packages/core/src/db/schema.ts` and new `packages/core/drizzle/0005_*.sql` with its snapshot and `migration-0005.test.ts`, the batch Start writer of `options.enlargement` | H2 merged (client and service URL) |
| H4 Open bugs | (a) `apps/worker/src/catalog-load.ts`, `packages/core/src/catalog/recheck/check.ts` (call site only); (b) `apps/worker/src/catalog/finalize.ts`, `apps/worker/src/catalog/sweep.ts`, the `enqueueFinalize` caller; (c) read-only diagnosis, then the file it names; (d) `packages/core/src/storage.ts` and the worker entry (`process.on("warning")`); (e) new `docs/solutions/bucket-retention.md` | nothing |
| H5 Docs and spec 17 leftovers | this file, `docs/specs/README.md`, `docs/specs/00-execution-protocol.md` (sections 9 and 11), `docs/SPEC.md` ("Image enhancement" and the channel-table paragraph), `docs/specs/16-throughput.md` (3.1.3), `docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md` (spec 17 G5), `docs/plans/2026-10-28-post-deploy-status.md`, a new `docs/solutions/` entry for this spec, handoff via ce-handoff | part 1 (this file, README row) first; part 2 after section 9 |

Out of scope: a GPU upscaler (section 13), client-side tiling (section 13), batching several photos in one call,
re-rendering older batches made with the silent fallback, any quota request, any GCP delete, cancelling the BHPC
drafts, changing other operator copy.

Builders fetch current docs through Context7 before using ONNX Runtime (session options, thread settings), Cloud Run
(`--no-traffic`, `--tag`, concurrency, request timeout, CPU), Cloud Tasks (`--max-dispatches-per-second`,
`--max-attempts`, `--min-backoff`, `--max-backoff`), `@google-cloud/storage` or `google-auth-library`.

## 3. Fixes

### 3.1 H1: measure

3.1.1 Probe mode `services/matting/tests/cloudrun_check.py --probe-upscale --sizes 800x1200,1600x1600
--concurrency <n> --rounds <k>`, run by `infra/check-matting.sh --probe-upscale <url>` as the existing Cloud Run
probe job against a URL argument (same pattern as spec 17 3.3.1). It times `POST /upscale` on the candidate service
for each size: one warm call, then `concurrency` calls at once for `rounds` rounds. Output: a markdown table
`size | vCPU | threads | tile | conc | p50 | p95 | max | non-200 | output sha256` and a JSON file under
`gs://image-links-agent-assets/catalog-test/probe/<run>/`. Exit non-zero on any non-200 or on two different output
sha256 for the same input at the same threads (the upscaler must stay deterministic).

3.1.2 `services/matting/app.py`: new env `ORT_INTRA_OP_THREADS` for the upscaler session (today hard-coded 4 at
`options.intra_op_num_threads = 4`); unset keeps 4. pytest with mocked ONNX asserts the option reaches the session.

3.1.3 The ladder, each rung one no-traffic candidate of `catalog-upscale` (H2) through the gate: 4 vCPU with
threads 4, 8 vCPU with threads 8, each at concurrency 1 and 2, both sizes. About USD 3 in all. The table and its
date go into `services/matting/README.md` "Measured on CPU" (next to "Measured on L4").

3.1.4 Tile size is baked into the ONNX export (`services/matting/tools/convert_upscalers.py`). A larger tile is tried
only if 384 fails the time bar. A sha256 change across thread counts bumps `UPSCALER_VERSION` in `upscale.ts` (render
keys change once, by design).

3.1.5 `infra/lib/shape.sh` gains rows `UPSCALE_MAX_INSTANCES`, `UPSCALE_CPU_VCPU`, `UPSCALE_MEMORY`,
`UPSCALE_CONCURRENCY`, `UPSCALE_THREADS`, `UPSCALE_TIMEOUT_S`, `UPSCALE_MAX_PIXELS`, `ENLARGE_DISPATCHES_PER_SECOND`
and the measured table as data (`UPSCALE_MEASURED_ON`, `UPSCALE_P50_S_<vcpu>C_<threads>T_<conc>CONC_<WxH>` and
`UPSCALE_P95_S_<vcpu>C_<threads>T_<conc>CONC_<WxH>`, for example `UPSCALE_P95_S_4C_4T_1CONC_1600x1600`, in whole
seconds rounded up; empty = not measured, a value that is not a whole number is refused). As shipped: the vCPU row
is `UPSCALE_CPU_VCPU`, because `UPSCALE_CPU=1` stays the matting service's switch for serving `/upscale`.
Refusals, each printed by `shape_check` with the numbers:
- a shape whose (vCPU, threads, concurrency) has no measured row is refused with "measure first: run
  infra/check-matting.sh --probe-upscale";
- `UPSCALE_TIMEOUT_S >= 2 x p95(largest size)` and `UPSCALE_TIMEOUT_S <= 840` (the worker task deadline is 900 s,
  `DISPATCH_DEADLINE_SEC`; the client adds 30 s, 3.2.3);
- queue rate: `ENLARGE_DISPATCHES_PER_SECOND <= UPSCALE_MAX_INSTANCES x UPSCALE_CONCURRENCY / p50 (s)` (as shipped:
  the p95 of the same size stands in while p50 is empty; the enlarge lanes' slots are at most `UPSCALE_MAX_INSTANCES
  x UPSCALE_CONCURRENCY`);
- CPU quota: `WORKER_MAX_INSTANCES x WORKER_CPU (96) + MATTING_CPU_MAX_INSTANCES x MATTING_CPU_VCPU +
  UPSCALE_MAX_INSTANCES x UPSCALE_CPU_VCPU + WEB_MAX_INSTANCES x WEB_CPU + JOBS_CPU_BUDGET (11 together) <= 190`
  (`CPU_QUOTA_LIMIT`).
Proposed split, decided by the table: `MATTING_CPU_MAX_INSTANCES` 16 -> 4 (the GPU does cut-outs; the CPU cut-out is
a fallback), upscale 16 x 4 vCPU or 8 x 8 vCPU: 96 + 16 + 64 + 11 = 187 <= 190. `infra/tests/shape.test.mjs`
asserts: today's live shape plus 16 x 4 upscale is refused by the quota line; the proposed split passes; an
unmeasured upscale shape is refused by name; a timeout under 2 x p95 or over 840 is refused.

### 3.2 H2: dedicated service `catalog-upscale`

3.2.1 Registry row `service_catalog_upscale` in `infra/lib/services.sh`, before `catalog-worker` in `SERVICES`
(the worker reads its URL; as shipped the order is `catalog-matting`, `catalog-upscale`, `catalog-matting-gpu`,
`catalog-worker`, `catalog-web`): image `matting:$TAG` (the same image as
`catalog-matting`), region asia-south1, env `UPSCALE_CPU=1,PRELOAD_MATTE=0,ORT_INTRA_OP_THREADS=$UPSCALE_THREADS`,
`--cpu`, `--memory`, `--concurrency`, `--timeout=$UPSCALE_TIMEOUT_S`, `--max-instances`, `--min-instances=0` from
`shape.sh`; gate probe `infra/check-matting.sh --probe-upscale` at concurrency `UPSCALE_CONCURRENCY`, one round (as
shipped: every size of `UPSCALE_SIZES`, 800x1200 and 1600x1600, not 800x1200 only; stricter). `PRELOAD_MATTE` is a new env in `app.py`: `0` skips loading any cut-out model at start, so the service
holds only the upscaler. Unset keeps today's behaviour.

3.2.2 `infra/deploy.sh`: the worker gets `UPSCALE_URL=<gate url of catalog-upscale>`; the line
`WORKER_ENV+=",UPSCALE_URL=$MATTING_URL"` goes. `infra/bootstrap.sh`: invoker grant for the worker service account on
`catalog-upscale` (check-then-create; at project level if the resource-level grant is denied, noted in
`docs/solutions/`).

3.2.3 New client `packages/core/src/catalog/enlarge.ts`:
- ID token for the service URL (audience = service URL, also for candidate tag URLs, as fixed in #116), through one
  shared `idTokenFor(audience)` helper extracted from `matte.ts` and used by both clients.
- Timeout = `UPSCALE_TIMEOUT_S + 30 s` (client > server > measured p99). As shipped, each attempt's timeout is
  clamped to the time left before the task deadline, and no attempt starts with less than 60 s left
  (`ENLARGE_ATTEMPT_FLOOR_MS`). `deploy.sh` sets `UPSCALE_TIMEOUT_S` on the worker for every `UPSCALE_SERVICE`
  (cpu and gpu from `MATTING_TIMEOUT_S`, 300), so the default env never trips the deadline guard.
- Retries with backoff (10 s, 20 s, 40 s, then 60 s, with jitter) on 429, 503, other 5xx and timeout, while the
  remaining task deadline allows another attempt; then it throws. As shipped the errors are typed subclasses of
  `EnlargeError` (busy, timeout, server, bad input, rejected, model unavailable) instead of one
  `EnlargeFailedError`.
- No `/health` call, no breaker. A 4xx other than 429 is not retried.
- Returns `{ jpeg, ms, model }`; the model id stays in logs and `x2_model` only.
Tests (vitest, fake fetch and fake clock): retry on 429, 503, 500 and timeout; no retry on 400; stops inside the
deadline; the timeout equals the env plus 30 s; no `/health` request is ever made.

3.2.4 Rollout: deployed first as a no-traffic candidate for H1's ladder; traffic only after the table exists and the
shape picked from it passes `shape_check`. As shipped:
- Measure mode: `UPSCALE_MEASURE=1 bash infra/deploy.sh` deploys only `catalog-upscale` (builds only the matting
  image if missing, skips migrations and queues, leaves the other services and the worker's env as they are,
  prints the candidate URL and the probe command, then stops). Each rung is tagged
  `measure-<cpu>c-<threads>t-<concurrency>r`. Rung 1 of a brand-new service serves its service URL, because Cloud
  Run cannot create a service with `--no-traffic`; nothing calls it. `measure-*` revisions are never tagged
  `previous`, never count as a SKIP match, and `--rollback` goes to one only when it is named.
- `UPSCALE_SERVICE` takes `gpu`, `cpu` or `dedicated`; the default stays `cpu` until the measured-table PR sets
  `dedicated`. `ENLARGE_CLIENT_WIRED` (shape.sh, 1 since H3) refuses `dedicated` when 0, so the service can never
  take traffic before the durable enlarge client exists.

### 3.3 H3: durable enlargement between cut-out and render

3.3.1 Queues (`infra/lib/queues.sh`): a new kind `enlarge` with two lanes, operator `<queue>-enlarge` and bulk
`<queue>-enlarge-bulk` (bulk batches as `isBulkBatch` decides), each with `--max-dispatches-per-second` from
`ENLARGE_DISPATCHES_PER_SECOND`, and retry by attempt count: `--max-attempts=8 --min-backoff=30s
--max-backoff=300s`. Their slots count in `SLOTS_TOTAL`. `WORKER_CONCURRENCY` 2 -> 3 proposed, refused by
`shape_check` if the DB budget disagrees. `infra/tests/queues.test.mjs` asserts both lanes, their rate and retry.

3.3.2 Tasks (`packages/core/src/tasks.ts`): route `/tasks/catalog/enlarge`, task id
`enlarge-<sourceImageId>-<round>`, body `{ batchId, productId, sourceImageId }`.

3.3.3 Worker handler `apps/worker/src/catalog/enlarge.ts`:
1. Head the target object (idempotent): if it exists with the expected metadata, write done and settle (step 5).
2. Else download raw, prepare (the same `prepare` the render uses, so the sizes match), call the service (3.2.3),
   verify the reply is exactly 2x in both axes.
3. Upload JPEG q95 4:4:4 (`UPSCALE_UPLOAD_JPEG`) with metadata `sourceSha256` and `upscaler` (the `upscalerId`) to
   `<batchPrefix>/derived/<pathKey>/<pathKey>_<n>.<upscaler>.x2.jpg` in the private assets bucket (the key names the
   upscaler, so another model's image is another object; 2026-10-29 review; as shipped `<upscaler>` is the upscaler
   id lower-cased with anything outside `a-z0-9.-` replaced by `-`). A stored image of another upscaler is re-queued
   at the render stage for the configured one (`requeueOtherUpscaler` in `chunk.ts`), never primed. New
   `enlargedPath(prefix, pathKey, n, upscaler)` in `naming.ts` next to `derivedPath`.
4. Write `x2_uri`, `x2_model`, clear `x2_error`; one cost ledger row (stage `upscale`, kind `upscale_call`, engine
   `cpu`, the service ms).
5. On failure: increment `x2_attempts`, write `x2_error`, answer 503 so Cloud Tasks retries, until the attempt count
   reaches the queue cap (8); then mark the photo failed (`x2_error` kept, `x2_uri` null), log ERROR
   `enlargement_failed` with batch, product, source image, attempts and last status. As shipped: only deliveries
   that reached the handler count (`x2_attempts = LEAST(8, x2_attempts + 1)`); the queue's retry count, which also
   counts 429s answered before the app ran, is not used. The log message is `enlargement failed`. Bad input, a photo
   over `UPSCALE_MAX_PIXELS`, a reply that is not exactly 2x and an unsupported source fail at once.
   In-flight claim (as shipped, review fix): before the service call the delivery sets `x2_claimed_at`; a second
   delivery while the claim holds (the task's dispatch deadline) answers 503 `in_flight`; the success write is
   guarded on `x2_uri IS NULL`, so a late writer adds no write and no cost row.
6. Settle the chunk gate (3.3.4) in both the done and the terminal-failed case.
Tests (PGlite + fakes): idempotent on a second delivery (no second service call); retry then success; 8 failures then
failed with ERROR log; the object path; the cost row; settle on the last photo dispatches the parked chunk exactly
once under two concurrent last deliveries.

3.3.4 `apps/worker/src/catalog/chunk.ts`, matte stage: `enlargementNeeded(channels, box, size)` is computed per photo
from the cut-out box (a superset of the render's decision, so the render never needs a photo that was not enlarged).
A needed photo is marked queued and its task enqueued. At the stage advance (matte -> render) the render chunk is
parked with the sentinel `task_name='enlarging'` (precedent `REDISPATCHED_TASK` in `pipeline/dispatch.ts`) until every
photo of the chunk is settled; the last enlarge settles it atomically and calls `dispatchChunks`. A chunk with no
needed photo advances as today. `recoverBatchChunks` re-sends stale enlarge tasks with the next round number. As
shipped, the stale rule is lane-aware: every enlarge delivery of a batch refreshes `progress_at` on every parked chunk
of that batch, and queued photos are sent again only when the batch's enlarge lane was quiet for `ENLARGE_STALE_MS`
(30 minutes), so a long but moving paced lane is never duplicated. The need is decided per product over the
product's canvas (`enlargementNeeds`), not per photo box; the per-photo superset over-flagged noon. Chunk
stages stay `matte -> render -> qa`: adding a stage would change a CHECK constraint and the whole chunk model; the
sentinel gate avoids that.

3.3.5 Render stage: the render loads the stored x2 and primes the upscale cache (`sourceX2` in `upscale.ts`, keyed by
the prepared photo) with it; it makes no service call. The stored x2 must be exactly 2x the prepared size and its
`sourceSha256` must match, else it counts as missing. A needed enlargement that is failed or missing gives the new
flag `enlargement_failed` on the output, which holds the product (`needs_attention`). Flag copy, model-free, in
`qa/reasons.ts`: "This photo could not be enlarged to this marketplace's size. Try again, or ask the brand for a
larger photo." The WARNING fallback path (`upscale failed; used the plain enlargement`) is removed; the plain path
remains only when `UPSCALE_MODEL=off`.

3.3.6 Batch status copy "Enlarging photos x of y" (`packages/core/src/catalog/pipeline/status.ts`) from the batch
counts `enlargeTotal`, `enlargeDone`, `enlargeFailed`. Ops page (admin) lines "Enlargements waiting: N" and
"Enlargements failed: N" (`ops.ts`, copy in `ops-copy.ts`). The batch option `options.enlargement = { model }` is
written at Start (absent when `UPSCALE_MODEL=off`).

3.3.7 Invariant `enlarged_without_upscaler` (ERROR) in `invariants/checks.ts`: an output that is verified, has
scale > 1.5, has no `upscaled` flag, in a batch with `options.enlargement`. Older batches made with the silent
fallback have no `options.enlargement` and stay as they are. PGlite fixtures: one violating, one satisfying, one
older batch ignored.

3.3.8 `apps/worker/src/catalog/scale-model.ts` learns the enlarge queue (its lanes, rate and the measured ms from the
H1 table in place of `upscaleMs: 7_000`) and the parked render chunk, so the local scale test predicts the CPU time.

3.3.9 Per-photo state: migration `0005` on `catalog_source_images` adds `x2_uri text`, `x2_model text`,
`x2_error text`, `x2_attempts integer not null default 0` (mirrors `matte_uri` / `matte_model`), and, as shipped,
`x2_claimed_at timestamptz` (the in-flight claim of 3.3.3 step 5; folded into `0005_enlargement.sql` before release,
no 0006). Owner-approved
contract change (owner decision 3). `migration-0005.test.ts` applies 0000 to 0005 on PGlite and checks the columns.

### 3.4 H4: open bugs (reproduction test first, then fix)

- (a) Load driver (`apps/worker/src/catalog-load.ts`, the recheck block around lines 358-404): keep per-link recheck
  failures grouped by reason; write the recheck CSV with `recheckCsv` (`recheck/check.ts`, unused today); write the
  report before cleanup; two retries on `fetch_error`, 5xx and 429.
- (b) Finalize idempotent: a done batch returns `already_done` (`finalize.ts`, next to the `failed` -> `stopped`
  early return); `enqueueFinalize` skips done and failed batches; the sweep's pending query excludes done
  (`sweep.ts`); `recheckOk` is never overwritten once written (`finalize.ts`, the `counts` write).
- (c) The 13-minute pre-cleanup wait: a researcher reads the 2026-10-29 batch logs (finalize timings against the last
  publish) first; most likely explained by (b); the fix follows the finding.
- (d) `MaxListenersExceededWarning`: capture the stack (`process.on("warning")`); the expected emitter is the
  `@google-cloud/storage` stream fan-out in `storage.ts` (the `save` and `download` calls); the fix is bounded
  parallelism or one shared client.
- (e) Bucket retention: document in `docs/solutions/bucket-retention.md` that versioning plus lifecycle (30 days, 4
  versions) is the contract and soft delete stays at Google's 7-day default. No GCP change, no delete.

### 3.5 H5: docs and spec 17 leftovers

3.5.1 Part 1 (first PR of the spec): this file and the `docs/specs/README.md` row, so builders read it from `main`.

3.5.2 Part 2 (after section 9):
- `00-execution-protocol.md` section 9: the service list names `catalog-upscale` and every service's probe; section 11
  adds the rule "a service an output depends on is never called inline from a chunk delivery".
- `docs/SPEC.md` "Image enhancement" (the 2026-10-21 decision) and the channel-table paragraph ("a photo is made even
  if the upscale call fails, with the soft note"; "Lanczos otherwise"): replaced by the approved contract change "an
  enlargement that fails holds the output with a reason; a plain resize never stands in", and the upscaler named as
  the CPU service `catalog-upscale`.
- `16-throughput.md` 3.1.3: the measured numbers from the H1 table in place of "5.9 to 7.8 s per photo".
- Spec 17 G5 leftovers: `docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md`, protocol sections 9 and 11,
  the spec 16 corrections, the owner status doc `docs/plans/2026-10-28-post-deploy-status.md`.
- A `docs/solutions/` entry for this spec with the table "learning -> check added (file)".
- Spec 17 step 7 cleanup (operator batch `616a7386-8fe9-4a2c-b929-2e7f7dafa791`, speed batch
  `8628295f-1582-47ac-ac40-cca81d8c5e8d`) and an invariants run; spec 17's final section 10 report ("Blocked: 150
  photos/min not reached"); spec 17 worktree removal.

## 4. Data and state changes

Migration `0005` (3.3.9, with `x2_claimed_at`). Object path `<batchPrefix>/derived/<pathKey>/<pathKey>_<n>.<upscaler>.x2.jpg` in the private assets
bucket (never public, never raw, inside the batch prefix). `catalog_batches.counts` gains `enlargeTotal`,
`enlargeDone`, `enlargeFailed`; `catalog_batches.options` gains `enlargement`. A chunk row may carry
`task_name='enlarging'` while parked. New flag `enlargement_failed` in `OUTPUT_FLAGS`. Cloud Run: service
`catalog-upscale`. Cloud Tasks: `<queue>-enlarge` and `<queue>-enlarge-bulk`. Invariant `enlarged_without_upscaler`.

## 5. Copy

Operator-facing (English): the flag sentence "This photo could not be enlarged to this marketplace's size. Try again,
or ask the brand for a larger photo."; the batch phase "Enlarging photos x of y". Admin Ops page (`ops-copy.ts`):
"Enlargements waiting", "Enlargements failed". No model ids, no service names on screen.

## 6. Tests

Tier 1 and 2 (vitest, pytest, infra tests, in CI): probe table and exit codes (H1); `ORT_INTRA_OP_THREADS` and
`PRELOAD_MATTE` with mocked ONNX; shape refusals (unmeasured, timeout bounds, queue rate, CPU quota; the proposed
split passes); registry order with `catalog-upscale` before the worker, its env and probe; `enlarge.ts` retries,
timeout, no `/health`; queues lanes, rate and retry; enlarge handler (idempotent, retries, terminal failure, cost row,
settle once); chunk parking and release; render reads the stored x2 and makes no service call; missing or mismatched
x2 gives `enlargement_failed` and a hold; `UPSCALE_MODEL=off` keeps the plain path with no flag; status copy; Ops
lines; the invariant; migration 0005; H4 reproduction tests (a, b, d).
Tier 5: the smoke inside the worker gate, now with enlargement through `catalog-upscale` candidates.
Tier 6: section 9.

## 7. Local scale test

`apps/worker/src/catalog/scale.test.ts` gains the enlarge queue with the measured ms and asserts: every needed
enlargement settles before its render chunk runs; one forced terminal failure gives one held product with
`enlargement_failed` and zero silent outputs; the parked chunk is dispatched exactly once.

## 8. Env and shape

New env, all with today's behaviour as default unless noted: `ORT_INTRA_OP_THREADS` (4), `PRELOAD_MATTE` (unset =
load as today), `UPSCALE_TIMEOUT_S`, `UPSCALE_MAX_INSTANCES`, `UPSCALE_CPU_VCPU`, `UPSCALE_MEMORY`,
`UPSCALE_CONCURRENCY`, `UPSCALE_THREADS`, `UPSCALE_MAX_PIXELS` (24,000,000), `ENLARGE_DISPATCHES_PER_SECOND`,
`UPSCALE_MEASURED_ON` and the `UPSCALE_P50_S_*` / `UPSCALE_P95_S_*` rows (whole seconds, 3.1.5). As shipped also:
`UPSCALE_MEASURE` (0 or 1, measure mode, 3.2.4), `ENLARGE_CLIENT_WIRED` (shape.sh, 1), `UPSCALE_TIMEOUT_MAX_S` (840,
a constant), `UPSCALE_SERVICE=dedicated` as a third value, `MATTING_TIMEOUT_S` (300, services.sh). Changed: the worker's `UPSCALE_URL` names
`catalog-upscale`; `MATTING_CPU_MAX_INSTANCES` 16 -> 4 and `WORKER_CONCURRENCY` 2 -> 3 as proposed, each only if the
table and `shape_check` agree. The live shape at the start of this spec is spec 17's (shape.sh `SHAPE_DEFAULTS` at
999ada0).

## 9. Live verification (after the H4, H1+H2 and H3 deploys)

Step 0, read-only: `gcloud auth print-access-token` works (the manager starts `gcloud auth login` itself and asks the
human only for the browser click); describe the services, the queues, the tier. Record the live revisions.

Step 1: H4 deployed through the gate.

Step 2: H1+H2: `catalog-upscale` deployed as a no-traffic candidate; the probe ladder of 3.1.3 (about USD 3); a
planner picks the shape from the table (section 11); PR "measured table + shape defaults"; deploy; traffic to
`catalog-upscale`.

Step 3: H3 deployed through the gate; tier 5 smoke in the gate.

Step 4: the 200-product Test Brand load on the P1 channels including Trendyol, Styli and Centrepoint
(`bash infra/catalog-scale-jobs.sh load 200 b`). Inside it, at minute 5, an operator-first 5-product batch (the
smoke's real-run path, operator queue class, manager-started). The reliability bar (reliability only):
- every output with scale > 1.5 is `upscaled` or held with `enlargement_failed`;
- zero silent outputs;
- zero plain fallbacks;
- zero holds caused by timeouts;
- invariants zero ERROR on the batch;
- the operator-first batch finishes.
Wall time and photos per minute are reported, not judged. The report gives the 2,000 and 7,000 product projections.

Step 5: cleanup under `catalog-test/` in both buckets with `infra/catalog-test-cleanup.sh`; confirm the empty listing
of the run's prefixes; the invariants job runs once more and reports zero ERROR.

If step 4 fails a reliability item, the manager does not retry for speed: it records the failure with the evidence
and the report ends "Blocked: <what failed and the evidence>".

## 10. Rollout and rollback

Order:
0. Preconditions: `git pull` on main; copy worktree-only `.runs` reports to the main `.runs`; gcloud token and `gh`
   signed in; disk space check (removing the spec 17 worktrees early frees several GB).
1. Spec 18 doc PR (H5 part 1). Merge.
2. PR H4 (a, b, d, e, c diagnosis) -> deploy via the gate.
3. PR H1+H2 -> candidate service no-traffic -> probe ladder -> PR "measured table + shape defaults" -> deploy,
   traffic to `catalog-upscale`.
4. PR H3 -> deploy via the gate -> tier 5 smoke in the gate.
5. Section 9 step 4.
6. PR H5 part 2, spec 17 step 7 cleanup, final reports, worktrees, handoff, memory lines.
Rollback per layer: a service by `gcloud run services update-traffic <name> --to-revisions <previous>=100`
(`deploy.sh --rollback <name>`); code by `SKIP_BUILD=1 bash infra/deploy.sh` from the previous commit; enlargement
off by `UPSCALE_MODEL=off` (the plain path, no flag, the invariant does not apply because `options.enlargement` is
not written). Migration 0005 only adds nullable or defaulted columns, so older code runs on it; it is never reversed.

## 11. How the manager runs this spec (binding, as spec 17 section 11)

The manager's context is small and must stay small. The manager coordinates; it does not read code, logs, test output
or probe tables itself.
- Every stream is a builder subagent (`kit:worker`, Opus) in its own worktree
  `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\18-<stream>` on branch
  `feat/catalog-18-reliable-enlargement--<stream>`, with a self-contained brief (00 section 4 template) that pastes the
  stream's section of this spec and the contracts verbatim. The brief ends with: "write the full report to
  `.runs/2026-<mm>-<dd>-<slug>.md` in the main checkout and reply in at most 120 words (outcome, branch/PR, tests,
  blockers, report path)".
- Log analysis (H4 c, section 9 evidence) goes to `kit:researcher`; CI, deploys, probes and the load run are watched
  by `kit:watcher`, which reports only on change, failure or completion. The manager never sleep-polls.
- Judgement calls (the shape picked from the H1 table) go to `kit:opus-planner` with the table in the brief. The
  manager relays the verdict; it does not re-derive it.
- Review per PR: `ce-code-review`, then `ce-simplify-code`; fixes by the same builder. Merge on CI green (owner
  authority given 2026-10-29). Deploy only through `infra/deploy.sh` (the gate). At most three attempts per failing
  gate, then the blocking rules.
- Task board (00 section 5) kept in the session, pasted into each milestone's handoff and the final report.
- Handoff (ce-handoff) to `~/ai-personal/handoffs/catalog-module/18-reliable-enlargement.md` at each merge, before each
  deploy, after the load test, and whenever context passes about 250K tokens. Resume from the newest handoff.
- Memory: at the end, one line each to the project memory on the measured CPU upscaler numbers' location and the rule
  "an output-critical service is never called inline from a chunk".
- Cost ceiling for this spec's live steps: USD 40. Past it the manager stops and reports.

## 12. Blocking rules for this spec (in addition to 00 section 11)

Stop and report, do not guess, when: an IAM denial blocks the service, the invoker grant or `update-traffic`; the CPU
quota refuses the measured shape (the quota form is the owner's call); a step would delete or overwrite a GCP
resource; an invariant violation is found on a delivered (non-test) batch; the cost ceiling is reached; a gate still
fails after three attempts.

## 13. Later options and known risks (not in H)

Known risks, stated, not solved here:
- Throughput on CPU: about 2 minutes per 800x1200 photo x 16 slots is about 8 photos per minute of enlargement; 880
  such photos take about 2 hours; 7,000 products are in the order of days. Reported; the GPU follow-up fixes speed.
- A single 1600x1600 enlargement past about 14 minutes cannot fit a 900 s task: then `UPSCALE_MAX_PIXELS` is lowered
  and larger photos are held with a reason.
- Older batches made with the silent fallback stay as they are; the invariant is scoped by `options.enlargement`.

Later options:
- A GPU upscaler once the L4 quota allows it (a quota increase is the owner's call): the same queue and stored x2,
  `UPSCALE_URL` pointing to a GPU service, measured with the same probe.
- Client-side tiling: the worker cuts a large photo into tiles and sends several smaller calls, so no single call
  approaches the task deadline and a 1600x1600 photo is never held for size.
- Owner-only items: the quota form only if the measured shape needs more than 190 vCPU; cancelling the two BHPC
  drafts (alert 11); the bucket lifecycle change of unknown origin (reset to the repo file or explain).

## 14. Done when

- [ ] H4 merged and live: load driver recheck grouped by reason with the CSV; finalize idempotent; the 13-minute wait
      explained and fixed; the MaxListeners warning gone; `docs/solutions/bucket-retention.md` written.
- [ ] H1 merged: `--probe-upscale` exists; the README holds "Measured on CPU" with the ladder; shape.sh refuses an
      unmeasured shape, a timeout outside its bounds, a queue rate above capacity and a shape over 190 vCPU.
- [ ] H2 merged and live: `catalog-upscale` takes traffic through the gate; the worker's `UPSCALE_URL` names it;
      `enlarge.ts` has retries, timeout = server + 30 s, no `/health`, no breaker.
- [ ] H3 merged and live: migration 0005 applied; enlargement runs as durable tasks; the render reads stored x2 only;
      `enlargement_failed` holds the product; no plain fallback outside `UPSCALE_MODEL=off`; "Enlarging photos x of
      y" and the Ops lines show; invariant `enlarged_without_upscaler` runs.
- [ ] Section 9 done: every reliability item passed, with wall time, photos per minute and the 2,000 and 7,000
      projections reported; cleanup confirmed; invariants zero ERROR.
- [ ] H5 merged: protocol sections 9 and 11, SPEC.md contract change, spec 16 3.1.3, spec 17 G5 leftovers and its
      final report, solutions entry, handoff written, memory lines saved, worktrees removed.
- [ ] The final report ends "Ready for the next spec: 19 <title to be chosen>" or "Blocked: <exact thing>".
