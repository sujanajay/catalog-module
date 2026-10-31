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
  x UPSCALE_CONCURRENCY`; since 2026-10-30 the sum of every lane's rate is checked, section 8);
- CPU quota: `WORKER_MAX_INSTANCES x WORKER_CPU (96) + MATTING_CPU_MAX_INSTANCES x MATTING_CPU_VCPU +
  UPSCALE_MAX_INSTANCES x UPSCALE_CPU_VCPU + WEB_MAX_INSTANCES x WEB_CPU + JOBS_CPU_BUDGET (11 together) <= 190`
  (`CPU_QUOTA_LIMIT`; since 2026-10-30 the 400 vCPU quota with every service of the region counted, and a memory
  check beside it, section 8).
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

3.3.1 Queues (`infra/lib/queues.sh`): a kind `enlarge` with two lanes, operator `<queue>-enlarge` and bulk
`<queue>-enlarge-bulk` (bulk batches as `isBulkBatch` decides), each paced by `--max-dispatches-per-second` from
`ENLARGE_DISPATCHES_PER_SECOND`. A lane never drops a task: `--max-attempts=-1 --max-retry-duration=0s
--min-backoff=30s --max-backoff=900s --max-doublings=5`. The handler alone decides when an enlargement is terminal
(3.3.3); a wait answers 503 and the queue retries every 15 minutes at most, for as long as it takes. Their slots count
in `SLOTS_TOTAL`. `infra/tests/queues.test.mjs` asserts both lanes, their rate and retry.

3.3.2 Tasks (`packages/core/src/tasks.ts`): route `/tasks/catalog/enlarge`, one task per enlargement row, task id
`enlarge-<enlargementId>-<sends>` (`sends` grows on every re-send, so a re-send never meets a used name), body
`{ batchId, productId, enlargementId }`.

3.3.3 Identity and rows. An enlarged image is identified by the prepared pixels (sha256 over the bytes the service
receives plus the size), the upscaler (its id with the export hash) and the effective scale; it always covers the whole
prepared photo, so no matte change, ladder step or judged cut changes it. One table, `catalog_enlargements`
(migration 0006), holds one row per identity a batch wants for a photo: `status` `queued`, `done` or `failed`;
`wanted` (false once released); the counters `attempts`, `timeouts`, `delays`, `probe_timeouts`,
`identity_releases`, `sends`, `retries`; the claim; `tiles_done`; `uri`, `error`, `error_kind`. Rows are per batch,
objects per identity: `<brand prefix>/derived/<pathKey>/<pathKey>_<n>.<upscaler>.s<scale>.<identity>.jpg` in the
private assets bucket (`enlargedPath`), tiles beside it, metadata naming the identity. A second batch of the same photo
finds the object and makes no call. One validator, `validateEnlargedObject`, judges every stored object (the identity
in the metadata, a JPEG that decodes, exactly the row's `out_w x out_h`); the handler and the render use it, so they
never disagree. The route of one identity (`enlargementRouteFor`): `direct` (one call), `tiles` (a photo above the
model's pixel cap, cut into overlapping tiles, one call and one object each, stitched in the worker), `downscale` or
`downscale_tiles` (a photo whose output would exceed `ENLARGE_MAX_OUTPUT_PIXELS`, 64 MP: shrunk first, as long as the
effective scale still meets the need), or none (too large for the need: held with the size sentence before any call).

Worker handler `apps/worker/src/catalog/enlarge.ts` (`handleEnlargeTask`, the only writer of `done` and `failed`):
1. A row that is missing, not `queued` or released, or a failed or cancelled batch: 200, nothing to do. A done batch
   still runs (Try again and replacements on a done batch).
2. `UPSCALE_MODEL=off` on this worker: the product's queued rows are released and its chunks unparked, no call.
3. Prepare the photo as the render does. A storage or matting outage is a wait (503, no count); a raw file that does
   not decode counts. A prepared pixel hash that differs from the row's releases the row (`identity_changed`) and
   unparks the product's chunks, so the next render wants the new identity; after 3 release events for the photo in
   the batch the row fails instead ("This photo could not be prepared the same way twice.").
4. An object that exists and passes the validator settles `done` without a call; one that fails it counts an attempt
   and is made again.
5. Claim the row (a live claim of another delivery answers 503 `in_flight`), probe `/health` with a timeout of
   `UPSCALE_COLD_START_S` + 60 s (a cold start passes; after 3 probe timeouts in a row the call is made anyway), then
   make the next unit of work (the whole image, or at least one tile).
6. Settle under the product's chunk locks: a valid reply is uploaded and `done`; a counted failure (bad input, a
   rejection, the service's own error, a reply the validator refuses) is `attempts+1`, terminal at 8; an unexplained
   failure (a timeout, a reset, a 5xx without the service's body) is `timeouts+1`, terminal at 24, unless a re-probe
   positively proves the service absent (connection refused, DNS, its own 503 body), which makes it a wait. Waits
   (busy, unavailable, in flight, more tiles) never count. A terminal row logs ERROR `enlargement failed`. Every settle
   unparks the chunks with no wanted queued row left and enqueues them (or tops up the window of a processing batch).

3.3.4 Reconcile and park (`chunk.ts`, `reconcileEnlargements`). At the end of the matte stage and per product in the
render loop, the product's wanted identities are computed from its prepared photos, the batch's pinned route
(`options.enlargement`, recorded at Start: model, x4 model, threshold) and the channel plan: wanted rows are upserted
(an existing row keeps its status, so a failed row stays terminal and a done row is reused), rows of photos that no
longer want an image (decided, replaced) or whose identity is no longer planned are released, and the tasks of
wanted queued rows are sent. A photo that still wants an image but was not prepared in this delivery keeps its rows.
A product with a queued row is skipped by the render; the chunk then parks (`task_name='enlarging'`,
`dispatched_at` set) and holds no window slot. A chunk is parked exactly while one of its photos has a wanted queued
row.

3.3.5 Readiness (`primeReadiness`). Right after a photo is prepared (render, ladder, flush cut), its wanted rows decide
one of three answers per candidate upscaler: `ready` (a done row whose object passes the validator, primed into the
upscale cache on that exact prepared buffer), `terminal` (a failed row), or not ready (queued, an object that went
missing or fails the validator: the row goes back to `queued` and is sent again, or a storage error). Not ready is
never a verdict: the render answers 503 without counting a chunk error, the ladder records the step as skipped. Only
`terminal` gives the flag `enlargement_failed`, which holds the product (`needs_attention`). Flag copy, model-free, in
`qa/reasons.ts`: "This photo could not be enlarged to this marketplace's size. Try again, or ask the brand for a
larger photo." No plain resize stands in for a failed enlargement; the plain path remains only when
`UPSCALE_MODEL=off`.

3.3.6 Batch status copy "Enlarging photos x of y" (`packages/core/src/catalog/pipeline/status.ts`) from the batch
counts `enlargeTotal`, `enlargeDone`, `enlargeFailed`, counted from the wanted rows. Ops page (admin) lines
"Enlargements waiting", "Enlargements failed", "waiting more than 20 h", "plain accepted" and "started before
enlargement" (`ops.ts`, copy in `ops-copy.ts`). The batch option `options.enlargement = { model, x4Model, minScale }`
is written at Start (absent when `UPSCALE_MODEL=off`) and pins the route for the batch's whole life.

3.3.7 Invariants in `invariants/checks.ts`: `enlarged_without_upscaler` (ERROR): an output that is staged or
verified, has a scale above the batch's `options.enlargement.minScale`, has no `upscaled` flag, in a batch with
`options.enlargement`, unless the operator accepted it plain ("Use as is" after the warning, 3.6.4).
`plain_accepted_outputs` (INFO) counts those. `parked_chunk_quiet` (WARNING): a parked chunk with no enlarge delivery
for twice `ENLARGE_STALE_MS`. `enlargement_waiting_long` (INFO): wanted queued rows older than 20 h (visibility, never
a failure). Older batches made before the stage have no `options.enlargement` and stay as they are.

3.3.8 `apps/worker/src/catalog/scale-model.ts` learns the enlarge queue (its lanes, rate and the measured ms from the
H1 table in place of `upscaleMs: 7_000`) and the parked render chunk, so the local scale test predicts the CPU time.

3.3.9 State: migration `0006` adds `catalog_enlargements` (3.3.3) and the product event kinds
`enlargement_retried` and `plain_accepted`; it is additive. The `x2_*` columns of migration `0005` on
`catalog_source_images` remain, nullable and unused (a later cleanup may drop them).

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

### 3.6 Quality: AI enlargement above 1.0x, x2/x4 routing, crop before upscaling (2026-10-29)

Owner, 2026-10-29: "The output image quality is so shitty ... It's pixelated ... make sure, in a reliable way, we're
able to fix it." Reliability first; more time is acceptable. Owner decisions kept: a terminal enlargement failure
holds the product with `enlargement_failed`, never a silent plain resize; the dedicated `catalog-upscale` stays at
16 x 4 vCPU, 4 threads, concurrency 1.

3.6.1 Threshold. The upscaler makes every enlargement with scale > 1.0 (`DEFAULT_UPSCALE_MIN_SCALE` 1.0,
`UPSCALE_MIN_SCALE` default 1 in `deploy.sh`; it was 1.5). The 1.0 to 1.5 band is held with `enlargement_failed`
on failure like any other enlargement, and `enlarged_without_upscaler` covers it (3.3.7).

3.6.2 Models. SwinIR-S lightweight x4 (`002_lightweightSR_DIV2K_s64w8_SwinIR-S_x4.pth`, Apache-2.0, sha256
`09fad24e32ae62722e1a055efde9921328f4137981bab0a42a4a3a806306c58e`) is served beside SwinIR-S x2 as `swinir-x4`
(ONNX export sha256 `f477a052...`, `UPSCALE_MODEL_VERSIONS`). No Real-ESRGAN model is served. The weights are baked
into the matting image at build time from their pinned URL and sha256 (the Dockerfile's `upscale-models` stage), as
the x2 weights are, so no bucket upload step is needed. `UPSCALER_VERSION` 1 -> 2 (no more residual sharpening, the
crop and the x4 model change the bytes), so upscaled outputs re-render once.

3.6.3 Routing (decided from `.runs/2026-10-29-18-quality-bakeoff.md`, ground-truth downscale-then-enlarge):

| scale | PSNR dB x2 / x4 | SSIM x2 / x4 | deltaE x2 / x4 |
|---|---|---|---|
| 1.2x | 29.56 / 28.13 | 0.873 / 0.867 | 0.63 / 1.51 |
| 1.5x | 26.29 / 25.27 | 0.792 / 0.788 | 0.63 / 1.51 |
| 2.0x | 23.92 / 23.42 | 0.704 / 0.690 | 0.63 / 1.35 |

x4 is not at least as good as x2 at or below 2.0x on any metric, so one x4 call per photo was not chosen. The route:
1.0 < s <= 2.0 uses the x2 image (Lanczos to the exact size), s > 2.0 one x4 pass then a Lanczos downscale. AI output
is never sharpened. One image per photo per model: the matte stage (`enlargementFactors`) decides which models a
photo needs across all its channels, and every channel and re-render of that photo reuses them. In the x2 band the
render may use the x4 image when the photo has no x2 image (a uniform scale may place a photo lower than the matte
stage planned); above 2.0x only x4 is used. `UPSCALE_MODEL_X4=off` sends every enlargement to the x2 model.

3.6.4 Operator actions on a held photo. "Try again" (`retryEnlargement` in core `decisions.ts`, route
`POST /api/catalog/outputs/[id]/retry-enlargement`): the photo's failed rows go back to `queued` with their counters
reset, its held outputs to `pending`, a one-photo render chunk is parked, and the tasks are sent; the ordinary path
then enlarges, renders, judges and publishes (a done batch re-opens, `finalize-reopen.md`). No cap on clicks; each is
logged (`enlargement_retried`). "Use as is" on a photo held with `enlargement_failed` answers 409 `plain_warning`
with the channels until the operator confirms: "This photo could not be enlarged. If you use it as it is, the
<channels> images will be stretched and may look soft. Use it anyway?". On "Use anyway" the decision applies as
usual, the flag stays as the record, and a `plain_accepted` event is written. "Remove" and "Replace" release the
photo's rows and unpark its chunks.

3.6.5 Whole photo, not a crop. The enlarge task sends the whole prepared photo, so the stored image does not depend on
the matte: every crop the render, the ladder or the judged cut draws is cut from it at `out_w / width` and
`out_h / height`, aligned with the matte within half an output pixel. `shotEnlargementRegion` still gives the shot
geometry; it is no longer an input of the identity.

3.6.6 Shape (`infra/lib/shape.sh` `upscale_check`). `UPSCALE_X4_TIME_RATIO` 1.3 (x4 over x2 on the same image: about
1.0 in the bake-off and 1.193 on a 4-thread laptop with a worst pair of 1.283; both laptop runs, no Cloud Run x4 time
exists yet). Each model has its own pixel cap (2026-10-29 review), checked against the timeout with its own time per
pixel: x2 2 x ceil(`UPSCALE_MAX_PIXELS` / 1e6 x 104.17 s) <= `UPSCALE_TIMEOUT_S`, so `UPSCALE_MAX_PIXELS` 8,000,000
(1668 s); x4 2 x ceil(`UPSCALE_MAX_PIXELS_X4` / 1e6 x 104.17 s x 1.3) <= `UPSCALE_TIMEOUT_S`, so
`UPSCALE_MAX_PIXELS_X4` 6,400,000 (2 x 867 = 1734 s <= 1740 s). The caps bound the product region, not the photo. One
shared 6.4 MP cap was refused in review: a 2500 px product on Centrepoint at 1.2x crops to 6.57 MP and was held,
although x2 fits it. Memory rule per cap: 4096 MiB resident + 160 B per input pixel (measured about 86 B locally) <=
80% of `UPSCALE_MEMORY`: about 5317 MiB at 8 MP, of 16 GiB. The worker and the service apply the same caps
(`upscaleMaxPixels`, `app.py upscale_max_pixels`). The deploy gate's probe calls both models
(`--model=swinir-x2,swinir-x4`) and requires each to be its exact scale and byte-identical on a rerun; its budget
adds the x4 calls at 1.3 x the x2 p95, and `--x4-ratio` fails the gate when an x4 p95 exceeds 1.3 x the x2 p95 at a
size.

3.6.7 Stored-image identity. A stored image is reused only under its own identity (3.3.3): the same prepared
pixels, the same upscaler with its export hash, the same effective scale. A changed prepare, a replaced photo or the
rollback switch makes a new identity and releases the old row; it never resets a row. A failed row wanted again stays
failed (only Try again resets it); a done row wanted again is reused after the validator accepts its object.

### 3.7 GPU upscaler `catalog-upscale-gpu` (2026-10-30)

Owner decision 2026-10-30: AI enlargement may run on GPUs in asia-south2; speed matters a lot, cost does not,
reliability is a must. The CPU `catalog-upscale` stays as the rollback switch.

3.7.1 Service. `catalog-upscale-gpu` in `UPSCALE_GPU_REGION` (asia-south2, the one service outside asia-south1;
AGENTS.md), image `matting-gpu`, one RTX PRO 6000 per instance, 20 vCPU, 80 GiB, concurrency 4, max instances 3 (the
granted quota), timeout 300 s, min instances 0. Measured numbers: `services/matting/README.md` "Measured on RTX PRO
6000" (about 1 s per 800x1200 x2 photo, byte-identical across instances, cold start about 42 s). The deploy gate
probes it with both models at concurrency 4, 3 rounds, and a 600 s determinism budget so the round reaches several
instances.

3.7.2 Routing. `UPSCALE_TARGET` (cpu or gpu, default gpu since 2026-10-31, cpu before) picks where new batches enlarge. Start pins it in
`options.enlargement.target` ("gpu", or absent for the worker's CPU `UPSCALE_URL`), so flipping the switch never moves
a running batch, and a batch never mixes CPU and GPU outputs. The upscaler ids differ (`swinir-x2+cpu` on CPU, plain
`swinir-x2` on GPU), so their stored images, render keys and identities never collide; a stored image of the other
upscaler is an `another_upscaler` gap and is re-made on the batch's own target, as before. The worker sends a `+cpu` id to
`UPSCALE_URL` and a plain id to `UPSCALE_GPU_URL` with its own `UPSCALE_GPU_TIMEOUT_S` (300) and
`UPSCALE_GPU_COLD_START_S` (180); with no GPU URL a plain id is refused ("rejected"), never made on CPU. The worker's
project-level `roles/run.invoker` covers the service in asia-south2.

3.7.3 Shape. `shape_check` refuses the GPU service without measured rows for its GPU type, a shape outside the GPU
type's limits (RTX PRO 6000 at least 20 vCPU and 80 GiB; L4 4 to 8 vCPU and 16 to 32 GiB), concurrency above 4, max
instances above `UPSCALE_GPU_QUOTA`, a timeout below 2 x the largest p95, `UPSCALE_TARGET=gpu` without the service,
and, with the target on gpu, enlarge slots (operator, bulk and preview lanes) above instances x concurrency or a
summed lane rate (both stacks, as for the CPU) above what the GPU p50 serves. Flip shape (tested):
`UPSCALE_TARGET=gpu ENLARGE_MAX_DISPATCHES=2 ENLARGE_BULK_MAX_DISPATCHES=8 ENLARGE_DISPATCHES_PER_SECOND=0.5
ENLARGE_BULK_DISPATCHES_PER_SECOND=2` (slots 2 + 8 + preview 2 = 12 = 3 x 4; rates 0.5 x 2 operator lanes + 2 = 3/s
= 12 / p50 4 s).

3.7.4 Rollout. Deploy with `UPSCALE_TARGET=cpu` (the service is live, the worker knows its URL, no batch uses it).
Flip by deploying with the flip shape once no load or operator batch is running. Roll back by deploying with
`UPSCALE_TARGET=cpu`: batches started on GPU finish on GPU; new ones enlarge on CPU. `UPSCALE_GPU_SERVICE=0` removes
the service from the deploy (only with the target on cpu). More GPUs: `infra/request-gpu-upscale-quota.sh` (6 GPUs),
then raise `UPSCALE_GPU_QUOTA` and `UPSCALE_GPU_MAX_INSTANCES`.

## 4. Data and state changes

Migration `0005` (`x2_*` columns, unused since 0006) and migration `0006` (table `catalog_enlargements`, the event
kinds `enlargement_retried` and `plain_accepted`), both additive. Objects
`<brand prefix>/derived/<pathKey>/<pathKey>_<n>.<upscaler>.s<scale>.<identity>.jpg` (and `.tile-<i>.jpg`) in the
private assets bucket, kept at least 180 days (never public, never raw). `catalog_batches.counts` has
`enlargeTotal`, `enlargeDone`, `enlargeFailed`; `catalog_batches.options` has `enlargement` (the pinned route). A
chunk row carries `task_name='enlarging'` while parked. Flag `enlargement_failed` in `OUTPUT_FLAGS`. Cloud Run:
service `catalog-upscale`. Cloud Tasks: `<queue>-enlarge` and `<queue>-enlarge-bulk`. Invariants of 3.3.7.

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
`UPSCALE_MEASURE` (0 or 1, measure mode, 3.2.4), `ENLARGE_CLIENT_WIRED` (shape.sh, 1), `UPSCALE_TIMEOUT_MAX_S` (1740,
a constant: the enlarge task's 1800 s dispatch deadline less 30 s for the client and 30 s for the settle),
`UPSCALE_LIVE_VCPU` (the live catalog-upscale's vCPU, counted beside a measure rung), `UPSCALE_SERVICE=dedicated` as a third value, `MATTING_TIMEOUT_S` (300, services.sh). Changed: the worker's `UPSCALE_URL` names
`catalog-upscale`; `MATTING_CPU_MAX_INSTANCES` 16 -> 4 and `WORKER_CONCURRENCY` 2 -> 3 as proposed, each only if the
table and `shape_check` agree. The live shape at the start of this spec is spec 17's (shape.sh `SHAPE_DEFAULTS` at
999ada0).

Chosen shape (2026-10-29, from the ladder in `services/matting/README.md` "Measured on CPU"; PR "measured table +
shape defaults"): `UPSCALE_SERVICE=dedicated`, `UPSCALE_CPU_VCPU=4`, `UPSCALE_THREADS=4`, `UPSCALE_CONCURRENCY=1`,
`UPSCALE_MAX_INSTANCES=16`, `UPSCALE_MEMORY=16Gi`, `UPSCALE_TIMEOUT_S=1740` and `UPSCALE_MAX_PIXELS=8000000` (x2; `UPSCALE_MAX_PIXELS_X4=6400000` for x4
since spec 18 quality, 3.6.6, with `UPSCALE_X4_TIME_RATIO=1.3`, `UPSCALE_RESIDENT_MIB=4096`,
`UPSCALE_X4_BYTES_PER_PIXEL=160`, `UPSCALE_MODEL_X4=swinir-x4` and `UPSCALE_MIN_SCALE=1`; fixed
after the PR review of 2026-10-29: the enlarge task sends the whole photo, so the timeout must cover the largest photo
the service takes, not only the probe sizes; 2 x 8 MP x 104.2 s per MP, the slowest measured p95 per pixel, = 1668 s
<= 1740 s, and shape_check refuses a pair that does not fit; the enlarge task's dispatch deadline is 1800 s, the Cloud
Tasks maximum, and the worker's Cloud Run timeout matches it), `MATTING_CPU_MAX_INSTANCES=4` (asia-south1 vCPU 96 + 16
+ 64 + 11 = 187 of 190), `ENLARGE_MAX_DISPATCHES=4` and `ENLARGE_BULK_MAX_DISPATCHES=10` (with the preview's 2, which
calls the same live catalog-upscale, 16 = 16 x 1), `ENLARGE_DISPATCHES_PER_SECOND=0.075`
per lane (Cloud Tasks paces each queue on its own, so the operator and bulk lanes together dispatch 0.15/s <= 16 x 1 /
p50 99 s = 0.16/s; shape_check counts the rate once per lane with slots), `ENLARGE_CLIENT_WIRED=1`. New refusal:
`UPSCALE_CONCURRENCY` above 1 for the dedicated service, because concurrency 2 gave non-identical outputs (ladder rungs
2 and 4). Measured rows (`UPSCALE_MEASURED_ON=2026-10-29`, whole seconds rounded up, p50 / p95):

| shape (vCPU, threads, conc) | 800x1200 | 1600x1600 | deterministic |
|---|---|---|---|
| 4C 4T 1CONC (chosen) | 99 / 100 | 215 / 216 | yes |
| 4C 4T 2CONC | 126 / 260 | 494 / 521 | no |
| 8C 8T 1CONC | 78 / 80 | 159 / 165 | yes, same bytes as 4 threads |
| 8C 8T 2CONC | 79 / 103 | 168 / 342 | no |

Scale-out (2026-10-30, owner-approved, applied during the live 200-product test). The live run was limited by the
bulk lane (0.075/s and 10 slots: about 4 enlargements a minute, 16 instances never full). The asia-south1 Cloud Run
quotas were raised to 400 vCPU and 800 GiB (both granted, `gcloud beta quotas preferences list`), and the shape grows to
what they allow, same per-call shape (4 vCPU, 4 threads, concurrency 1, so the measured rows above still apply):
- `UPSCALE_MAX_INSTANCES` 16 -> 50 and `UPSCALE_MEMORY` 16Gi -> 8Gi (the live hourly p99 was 2.9 GiB; the largest x4
  working set, 5073 MiB, stays under 80% of 8 GiB);
- `ENLARGE_BULK_MAX_DISPATCHES` 10 -> 44 (4 + 44 + the preview's 2 = 50 = 50 x 1);
- the bulk lane gets its own rate, `ENLARGE_BULK_DISPATCHES_PER_SECOND=0.42`, and the operator lanes 0.075 -> 0.04: each
  about its slots / p50 99 s. The rate refusal now checks the SUM over every lane with slots, both stacks:
  `ENLARGE_DISPATCHES_PER_SECOND x operator lanes + ENLARGE_BULK_DISPATCHES_PER_SECOND x bulk lanes <=
  UPSCALE_MAX_INSTANCES x UPSCALE_CONCURRENCY / p50`, here 2 x 0.04 + 0.42 = 0.50 <= 50 / 99 = 0.505;
- `WORKER_MAX_INSTANCES` 24 -> 32 so the worker's slots cover every queue: 8 + 36 + 4 + 4 + 44 = 96 = 32 x 3
  (`WORKER_CONCURRENCY` stays 3; connections 32 x 6 + 8 = 200 of 393);
- the quota refusals count every service in the region at max instances: this stack, the other catalog stack (preview
  or production, from its rows), the catalog jobs (8 vCPU, 16 GiB) and `OTHER_APPS_VCPU` / `OTHER_APPS_MEMORY_GIB` (24
  each: ila, npd and the other jobs at their max). CPU: 128 + 16 + 200 + 11 + preview 19 = 374 <= 400 - 24 = 376. A
  memory refusal is new (the old total, 439 GiB, was above the 400 GiB quota unnoticed): 128 + 64 + 400 + 19 + 19 = 630
  <= 800 - 24 = 776. CPU binds; memory has room.
Rollback values are the comment line above `SHAPE_DEFAULTS` in `infra/lib/shape.sh`.

GPU default (2026-10-31, owner-approved after the CPU live test): `UPSCALE_TARGET=gpu`, so new batches enlarge on `catalog-upscale-gpu` with the flip lanes of 3.7.3 (2 + 8 + the preview's 2 = 12 = 3 x 4 slots, 2 x 0.5 + 2 = 3/s), and batches already pinned to the CPU (`+cpu` ids) finish there.
Rollback: `UPSCALE_TARGET=cpu bash infra/deploy.sh` restores the CPU path exactly (target cpu and the CPU lanes of `ENLARGE_CPU_LANES`: 4 + 44 slots at 0.04/s and 0.42/s); batches started on the GPU finish on the GPU.

Cap timeout gate (2026-10-31): the deploy gate checks each pixel cap against the timeout, not a ratio: it fails when
2 x the cap x that model's p95 per MP is above the timeout (p95 per size over the rounds and the 12 determinism calls,
the service's own time, one slow call of 10 or more set aside); the ratio of one x4 call over one x2 call refused a
healthy revision at 1.51. Measured Cloud Run x2 reached 158 s per MP and x4 151 s per MP, so `UPSCALE_MAX_PIXELS` 8 ->
5.4 MP with a new `UPSCALE_X2_TIME_RATIO` 1.52, and `UPSCALE_MAX_PIXELS_X4` 6.4 -> 4.9 MP with `UPSCALE_X4_TIME_RATIO`
1.3 -> 1.7. A region above a cap is made in tiles (worker and service read the same variables).

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
   signed in; disk space check.
1. Spec 18 doc PR (H5 part 1). Merge.
2. PR H4 (a, b, d, e, c diagnosis) -> deploy via the gate.
3. PR H1+H2 -> candidate service no-traffic -> probe ladder -> PR "measured table + shape defaults" -> deploy,
   traffic to `catalog-upscale`.
4. PR H3 and the lifecycle (PR #125: migration 0006, the enlargement table, readiness, Try again, the plain warning)
   -> deploy via the gate, whose smoke runs the enlargement case (an x4 and an x2 photo, one held by an injected
   fault, then Try again).
5. Section 9 step 4, in an owner-approved quiet window.
6. PR H5 part 2, spec 17 step 7 cleanup, final reports, worktrees, handoff, memory lines.
Rollback per layer: a service by `gcloud run services update-traffic <name> --to-revisions <previous>=100`
(`deploy.sh --rollback <name>`); code by `SKIP_BUILD=1 bash infra/deploy.sh` from the previous commit; enlargement
off by `UPSCALE_MODEL=off` (the worker releases queued rows and renders plain; outputs above the threshold are then
plain on purpose and `enlarged_without_upscaler` reports them). A batch started before the lifecycle has no recorded
route and runs the plain path, reported on Ops as "started before enlargement". Migrations 0005 and 0006 only add
columns, a table and event kinds, so older code runs on them; they are never reversed.

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
  Waits never fail anything: a batch can wait 20 hours or more for its enlargements.
- The real limit is the Cloud Run CPU quota in asia-south1 (190 vCPU, 187 assigned). The request text is in
  `docs/solutions/2026-10-29-cpu-upscaler-reliability.md`; until it is granted, a full upscaler fleet is a wait.
- A very large photo with a small product (above 64 MP divided by the needed scale squared) is held with the size
  sentence, although a crop could serve it; every brand source seen so far is at most 1.2 MP.
- `UPSCALE_COLD_START_S` is 120 s until the gate measures the cold start; a slower cold start costs probe timeouts
  (after 3 the call is made anyway), never a failure.
- Older batches made with the silent fallback stay as they are; the invariant is scoped by `options.enlargement`.

Later options:
- A GPU upscaler: built on 2026-10-30 as `catalog-upscale-gpu` on RTX PRO 6000 in asia-south2 (3.7), with the same
  queues and table and its own URL, measured with the same probe.
- Owner-only items: the CPU quota request; cancelling the two BHPC drafts (alert 11).

## 14. Done when

- [ ] H4 merged and live: load driver recheck grouped by reason with the CSV; finalize idempotent; the 13-minute wait
      explained and fixed; the MaxListeners warning gone; `docs/solutions/bucket-retention.md` written.
- [x] H1 merged: `--probe-upscale` exists; the README holds "Measured on CPU" with the ladder; shape.sh refuses an
      unmeasured shape, a timeout outside its bounds, a queue rate above capacity and a shape over 190 vCPU.
      Measured table and shape defaults: 2026-10-29, section 8.
- [ ] H2 merged and live: `catalog-upscale` takes traffic through the gate; the worker's `UPSCALE_URL` names it;
      `enlarge.ts` calls it with timeout = server + 30 s and a cold-start-tolerant health probe, no breaker.
- [ ] H3 and the lifecycle merged and live: migration 0006 applied; one row per identity in `catalog_enlargements`,
      made by durable tasks that never drop; the render honours readiness (ready, terminal, not ready);
      `enlargement_failed` holds the product only after the bounded attempts; Try again and the plain warning work;
      no plain fallback outside `UPSCALE_MODEL=off` and operator-accepted plain outputs; "Enlarging photos x of y"
      and the Ops lines show; the invariants of 3.3.7 run; the gate's smoke passes its enlargement case.
- [ ] Section 9 done: every reliability item passed, with wall time, photos per minute and the 2,000 and 7,000
      projections reported; cleanup confirmed; invariants zero ERROR.
- [ ] H5 merged: protocol sections 9 and 11, SPEC.md contract change, spec 16 3.1.3, spec 17 G5 leftovers and its
      final report, solutions entry, handoff written, memory lines saved, worktrees removed.
- [ ] The final report ends "Ready for the next spec: 19 <title to be chosen>" or "Blocked: <exact thing>".
