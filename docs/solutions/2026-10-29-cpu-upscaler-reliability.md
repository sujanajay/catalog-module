# The CPU upscaler fell back silently on every photo (2026-10-29, spec 18)

Learning entry for `docs/specs/18-reliable-enlargement.md`. Written from the spec 17 speed-test diagnosis
(2026-10-29) and the spec 18 H1 to H4 stream and review reports. Like the spec 17 entry
(`docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md`), every learning names the check it added.

Words: the upscaler is the AI model that doubles a photo's pixels before the render resizes it to a marketplace's
canvas ("enlargement"). A plain resize is the old non-AI way (Lanczos). A breaker is a switch in the client that
stops calling a service for a while after several failures.

## What happened on 2026-10-29

The 200-product speed test (batch 8628295f, 935 source photos, 9 channels) published every product, with zero
silent outputs. But 935 of 935 enlargements had fallen back to a plain resize, with no flag, no hold and no
cost row. The owner's rule of 2026-10-21 ("the upscaler is on wherever a photo is enlarged beyond 1.5x") had
never been honoured in production.

The numbers, from the worker and service logs of that run:

- 599 fallbacks because the CPU service's breaker was open ("CPU service is paused"), 327 because the call hit
  the 60 s client limit, 9 because of HTTP 429.
- The CPU service did finish 308 enlargements, each over 60 s (average 121.5 s). The worker had already given
  up on every one of them, so all of that CPU work was wasted.
- The fallback waits cost 60,342 s of worker time (about 64.5 s per photo).
- 128 breaker lines, all for the CPU service, all opened by `/health` calls that timed out or got 429.

Why, from the code at 999ada0:

1. **The unit cost was never measured under load.** Spec 16 sized the upscaler at 5.9 to 7.8 s per photo (one
   photo at a time in the spec 11 smoke), the scale model at 7 s. Under load one 800x1200 photo took about 121 s
   on a 4 vCPU instance (12 tiles, one at a time).
2. **A constant timeout below the real time.** `UPSCALE_TIMEOUT_MS` was a hard 60 s. Every call that would have
   succeeded was abandoned first.
3. **`/health` behind the work.** The CPU instance served one request at a time (concurrency 1), and `/health`
   waited behind the running upscale. So the health check timed out, and the breaker treated a busy service as a
   dead one and turned enlargement off for the whole worker.
4. **An abandoned Cloud Run call keeps its slot.** When the client gives up, Cloud Run keeps running the request
   to the end. Up to 192 photos competed for 16 slots, and each abandoned call kept one busy for another minute.
5. **Failure was silent.** `sourceX2` logged `upscale failed; used the plain enlargement` at WARNING and the
   render went on with Lanczos.

The warning was already in the repo a day earlier: during the spec 17 GPU evals on 2026-10-28, 115 renders used
the plain enlargement (57 timeouts, 58 breaker pauses). The GPU ladder report listed it under "nearby problems,
not fixed". Same pattern as spec 17: a note, not a guard.

## The first principles applied

| Principle | What it means here |
|---|---|
| Measure before sizing. | No upscaler shape goes live until its p50 and p95 per photo size are a measured table. The 5.9 to 7.8 s figure is no longer used anywhere. |
| Nothing in the hot path waits on a slow service. | The render never calls the upscaler. Each photo is enlarged by its own queued task, the 2x image is stored, and the render reads the stored bytes. The chunk waits (parked) until its photos are settled. |
| Client timeout > server timeout > deadline, clamped per attempt. | The client waits longer than the service is allowed to run (`UPSCALE_TIMEOUT_S + 30 s`), the service timeout is at least 2 x the measured p95, and every attempt is clamped to the time left before the Cloud Tasks deadline (no attempt starts with less than 60 s left). No `/health` call, no breaker. |
| No silent degradation: hold with a reason. | A photo that needs enlargement ends `upscaled` or its product is held with `enlargement_failed` and an operator sentence. The plain path exists only when the upscaler is deliberately off (`UPSCALE_MODEL=off`). |
| Capacity is arithmetic, refused by shape checks. | The CPU quota, the queue rate and the timeout bounds are computed in `infra/lib/shape.sh` and a shape that does not fit is refused before anything deploys. |

## Learning -> check added (file)

| Learning | Check added | File |
|---|---|---|
| An upscaler shape must not be sized from an estimate. | Refusal "measure first: run infra/check-matting.sh --probe-upscale" when the shape's (vCPU, threads, concurrency) has no measured row `UPSCALE_P95_S_<vcpu>C_<threads>T_<conc>CONC_<WxH>` (whole seconds, rounded up). A row that is set but not a whole number is refused too. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs` |
| The measurement must be the real request shape. | Probe mode `--probe-upscale`: per size, one warm call, then concurrent rounds; table `size, vCPU, threads, tile, conc, p50, p95, max, non-200, output sha256`; exits non-zero on any non-200 or on two different outputs for the same input. | `services/matting/tests/cloudrun_check.py`, `infra/check-matting.sh`, `infra/tests/check-matting-probe.test.mjs`, `services/matting/README.md` "Measured on CPU" |
| A timeout below the real time wastes every call. | Refusals: `UPSCALE_TIMEOUT_S >= 2 x p95` of the largest size, and `<= UPSCALE_TIMEOUT_MAX_S` (1740 = the enlarge task's 1800 s deadline, the Cloud Tasks maximum, minus the client and task margins; 840 before the 2026-10-29 PR review), and `2 x UPSCALE_MAX_PIXELS x the slowest measured p95 per pixel <= UPSCALE_TIMEOUT_S` (the enlarge task sends the whole photo, so the largest accepted photo, not the probe sizes, sets the longest call); a vitest asserts the TypeScript default equals the shell constant. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs`, `packages/core/src/catalog/enlarge.ts` and its test |
| The worker env must carry the service timeout on every path. | `deploy.sh` emits `UPSCALE_TIMEOUT_S` for the cpu and gpu paths too (from `MATTING_TIMEOUT_S`), and a test runs the enlarge call with an empty env against a fake service and asserts the service is called. | `infra/deploy.sh`, `infra/lib/services.sh`, `apps/worker/src/catalog/enlarge.test.ts` |
| A dedicated service must not take traffic before its client exists. | `ENLARGE_CLIENT_WIRED` in the shape: with 0, `UPSCALE_SERVICE=dedicated` is refused with the reason. It is 1 since H3 shipped the durable enlarge client. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs` |
| CPU quota is shared by every service. | Refusal: worker + CPU cut-out + `catalog-upscale` (`UPSCALE_MAX_INSTANCES x UPSCALE_CPU_VCPU`) + web + jobs must be at most 190 vCPU, with the breakdown printed. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs` |
| A queue must not send faster than the service can serve. | Refusal: `ENLARGE_DISPATCHES_PER_SECOND <= instances x concurrency / p50` (the p95 stands in when p50 is empty); enlarge lane slots at most `catalog-upscale` instances x concurrency. | `infra/lib/shape.sh`, `infra/lib/queues.sh`, `infra/tests/queues.test.mjs` |
| `/health` must not wait behind the work. | The matting service's `/health` never takes the inference lock; the enlarge client never calls `/health` and has no breaker. | `services/matting/app.py`, `services/matting/tests/test_app.py` (`test_health_never_waits_for_the_inference_lock`), `packages/core/src/catalog/enlarge.ts` and its test |
| An output-critical service must not be called inline from a chunk. | Enlargement is a durable Cloud Tasks task (`/tasks/catalog/enlarge`, operator and bulk lanes, 8 attempts, 30 to 300 s back-off); the render chunk is parked (`task_name='enlarging'`) until every photo settles; the render reads the stored x2 only. Protocol rule added. | `apps/worker/src/catalog/enlarge.ts`, `apps/worker/src/catalog/chunk.ts`, `packages/core/src/catalog/pipeline/enlargement.ts`, `docs/specs/00-execution-protocol.md` section 11 |
| No silent plain resize. | A missing, failed or mismatched stored x2 gives the flag `enlargement_failed`, which holds the product; the WARNING fallback path is gone. | `packages/core/src/catalog/render.ts`, `packages/core/src/catalog/qa/reasons.ts`, `apps/worker/src/catalog/enlarge.test.ts` (through the real `renderAllChannels`) |
| Silence must be caught in production too. | Invariant `enlarged_without_upscaler` (ERROR): a verified output with scale > 1.5 and no `upscaled` flag in a batch with `options.enlargement`. | `packages/core/src/catalog/invariants/checks.ts`, `invariants.test.ts` |
| The queue's retry count also counts 429s answered before the app ran. | Only deliveries that reached the handler count: `x2_attempts = LEAST(8, x2_attempts + 1)`; the queue's retry count is not used for the terminal decision. | `apps/worker/src/catalog/enlarge.ts`, `enlarge.test.ts` |
| A lost task must be re-sent, but a slow paced lane is not a lost task. | Lane-aware stale re-send: every enlarge delivery of a batch refreshes `progress_at` on every parked chunk of that batch; queued photos are sent again (next round) only when the batch's enlarge lane was quiet for `ENLARGE_STALE_MS` (60 min since the enlarge task deadline became 30 min; 30 min before). | `packages/core/src/catalog/pipeline/enlargement.ts`, `packages/core/src/catalog/pipeline/dispatch.ts`, `enlargement.test.ts` |
| Two deliveries of one photo must not both pay. | In-flight claim `x2_claimed_at` (migration 0005) taken before the service call, held for the dispatch deadline; the loser answers 503 `in_flight`; the success write is guarded on `x2_uri IS NULL`, so a late writer adds no write and no cost row. | `packages/core/drizzle/0005_enlargement.sql`, `apps/worker/src/catalog/enlarge.ts`, `enlarge.test.ts` |
| The stored image must say which model made it. | The x2 object key names the upscaler (`<pathKey>_<n>.<upscaler>.x2.jpg`) and its metadata carries `sourceSha256` and `upscaler`; an image of another upscaler is re-queued at the render stage, never primed. | `packages/core/src/catalog/naming.ts` (`enlargedPath`), `apps/worker/src/catalog/enlarge.ts`, `apps/worker/src/catalog/chunk.ts` (`requeueOtherUpscaler`) |
| Measuring must not touch production services. | `UPSCALE_MEASURE=1 bash infra/deploy.sh` deploys only `catalog-upscale` as a tagged candidate; gate tests cover it. | `infra/deploy.sh`, `infra/lib/gate.sh`, `infra/tests/gate.test.mjs` |
| Quality (spec 18 3.6): a 1.2x Lanczos stretch is visibly soft, and x2 plus a Lanczos stretch to 3x looks pixelated. | The upscaler makes every enlargement above 1.0x (`UPSCALE_MIN_SCALE` 1); above 2.0x one x4 pass then a Lanczos downscale; AI output is never sharpened. Render tests at 1.2x, 1.5x (x2) and 2.5x (x4); a 1.2x failure holds. | `packages/core/src/catalog/upscale.ts` (`upscalersFor`), `render.ts`, `enhance.ts`, `upscale.test.ts` |
| Choose a model by measuring against ground truth, not by "one call is simpler". | The x2/x4 split was chosen because x4 lost to x2 on PSNR, SSIM and deltaE at 1.2x, 1.5x and 2.0x in the bake-off (`.runs/2026-10-29-18-quality-bakeoff.md`); the numbers are in spec 18 3.6.3. | `docs/specs/18-reliable-enlargement.md` |
| The threshold lives in one place per batch. | The invariant reads the batch's `options.enlargement.minScale` (older batches: 1.5), so a batch made at 1.0 is checked at 1.0. | `packages/core/src/catalog/invariants/checks.ts`, `invariants.test.ts` |
| A second image per photo must not need a migration or a longer call. | The job is the comma list in `x2_model`; each delivery makes one image and hands the next to the queue with 503 `next_image`, not counted as an attempt; the lanes' max-attempts 8 -> 9 for that hand-off. | `apps/worker/src/catalog/enlarge.ts`, `packages/core/src/catalog/pipeline/enlargement.ts`, `infra/lib/queues.sh`, `enlarge.test.ts` |
| Crop before upscaling must keep the matte aligned exactly. | The stored image carries its `region`; the render cuts at (crop - region) x factor and refuses a crop outside it. A nearest-neighbour fake proves the region path byte-identical to the whole-photo path at x2 and x4. | `packages/core/src/catalog/upscale.ts`, `render.ts` (`shotEnlargementRegion`), `upscale.test.ts` |
| The shape must hold for the slowest model and its output memory. | `UPSCALE_X4_TIME_RATIO` (1.3) in the timeout rule, so `UPSCALE_MAX_PIXELS` 6.4 MP; a memory rule (4096 MiB + 160 B per input pixel <= 80% of `UPSCALE_MEMORY`); the deploy probe times x4 and checks its rerun is byte-identical. | `infra/lib/shape.sh`, `infra/lib/services.sh`, `infra/tests/shape.test.mjs`, `gate.test.mjs`, `services/matting/tests/cloudrun_check.py` |

## Decisions recorded in the reviews

### H4 (b): the finalize contract

Recorded in full in `docs/solutions/finalize-reopen.md`. In one line: `recheckOk` is never overwritten on a
repeat; counts are rewritten only on an explicit reopen: an operator decision after done, Add SKU ids, or a
changed late delivery. A repeat finalize of a done batch answers `already_done` and writes nothing. This fixed
the three finalizes per batch seen on 2026-10-29, which had overwritten the load driver's re-check count.

### H4 (c): the 13-minute wait

It was not a wait for the batch. The cleanup deleted 19,241 objects one at a time (about 40 ms each). Test
cleanup now deletes up to 32 at once after checking every listed name against the `catalog-test/` prefix, and
the load driver writes its report before the cleanup and again after it.

### H4 (d): MaxListenersExceededWarning

Not reproduced locally (a fake GCS server with 100 parallel saves and downloads gave 0 warnings). Shipped: every
process warning becomes one structured WARNING line `process warning` with its stack, emitter, event and listener
count (first 5 of each kind, then one per 1,000). `setMaxListeners` was not raised. The fix itself stays open
until a live batch's `process warning` lines name the emitter.

### The `requeueOtherUpscaler` race during a rolling deploy (low risk, open)

`requeueOtherUpscaler` (`apps/worker/src/catalog/chunk.ts`) re-queues, at the render stage, a photo whose
stored x2 was made by another upscaler than the worker's `UPSCALE_MODEL`. While a deploy changes `UPSCALE_MODEL`
and the old and new worker revisions both serve for a short time, a render on one revision can re-queue a photo
for its model and a render on the other revision can re-queue it back. Each round costs one extra enlargement;
the photo is never primed with another model's bytes and never published silently, and the back and forth ends
when the old revision stops serving. Accepted as low risk; open, with no ticket yet. It only arises when the
model changes, which is an owner decision.

### Measure mode semantics

- `UPSCALE_MEASURE=1` deploys only `catalog-upscale`. It builds only the matting image if missing, skips
  migrations and queues, leaves the other four services and the worker's env as they are, prints the candidate
  URL and the probe command, and stops.
- Each rung is tagged `measure-<cpu>c-<threads>t-<concurrency>r`, so every rung keeps its own URL.
- Rung 1 of a brand-new service serves its service URL, because Cloud Run cannot create a service with
  `--no-traffic`. Nothing calls it: the worker's `UPSCALE_URL` does not name it until the measured-table PR.
- `measure-*` revisions are never tagged `previous`, never count as a SKIP match, and `--rollback` goes to one
  only when it is named.

## Still open

- Spec 18 quality: the x4 time ratio (1.3) and the x4 memory figure are from a laptop and the bake-off; the first
  deploy's gate probe times x4 on the real shape. Replace `UPSCALE_X4_TIME_RATIO` with a measured x4 p95 row then.
- Spec 18 quality: the swinir-x4 ONNX hash `f477a052` was exported locally with the pinned tools (they reproduce the
  x2 hash exactly); the first Cloud Build prints its own, which must match `UPSCALE_MODEL_VERSIONS`.

- The measured CPU table ("Measured on CPU" in `services/matting/README.md`) and the shape picked from it come
  from the spec 18 section 9 live run.
- The MaxListeners emitter (above).
- The `requeueOtherUpscaler` race (above).
- Throughput on CPU stays slow (about 2 minutes per 800x1200 photo); a GPU upscaler is the later lever (spec 18
  section 13).
