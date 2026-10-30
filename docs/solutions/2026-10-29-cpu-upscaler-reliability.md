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
| Client timeout > server timeout > deadline, clamped per attempt. | The client waits longer than the service is allowed to run (`UPSCALE_TIMEOUT_S + 30 s`), the service timeout is at least 2 x the measured p95, and every attempt is clamped to the time left before the Cloud Tasks deadline (no attempt starts with less than 60 s left). The health probe waits `UPSCALE_COLD_START_S + 60 s`, so a cold start is never mistaken for an outage; no breaker. |
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
| CPU quota is shared by every service. | Refusal: worker + CPU cut-out + `catalog-upscale` (`UPSCALE_MAX_INSTANCES x UPSCALE_CPU_VCPU`) + web + jobs must be at most 190 vCPU, with the breakdown printed. Since 2026-10-30: the granted 400 vCPU less 24 for the other apps of the region (ila, npd), with the other catalog stack (preview or production) counted too, and the same refusal for memory (800 GiB less 24); memory had no check, and the configured total (439 GiB) was above the 400 GiB quota. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs` |
| A queue must not send faster than the service can serve. | Refusal: `ENLARGE_DISPATCHES_PER_SECOND <= instances x concurrency / p50` (the p95 stands in when p50 is empty); enlarge lane slots at most `catalog-upscale` instances x concurrency. Since 2026-10-30 the bulk lane has its own rate (`ENLARGE_BULK_DISPATCHES_PER_SECOND`) and the refusal checks the SUM of every lane's rate, both stacks, since Cloud Tasks paces each queue on its own. | `infra/lib/shape.sh`, `infra/lib/queues.sh`, `infra/tests/queues.test.mjs` |
| `/health` must not wait behind the work. | The matting service's `/health` never takes the inference lock; the enlarge handler's probe tolerates a cold start and, after 3 probe timeouts in a row, makes the call anyway. | `services/matting/app.py`, `services/matting/tests/test_app.py` (`test_health_never_waits_for_the_inference_lock`), `apps/worker/src/catalog/enlarge.ts` and `enlarge.test.ts` (T62) |
| An output-critical service must not be called inline from a chunk. | Enlargement is a durable Cloud Tasks task per identity (`/tasks/catalog/enlarge`, operator and bulk lanes that never drop a task: unlimited attempts, 30 to 900 s back-off); the render chunk is parked (`task_name='enlarging'`) while one of its photos has a wanted queued row; the render reads stored images only. Protocol rule added. | `apps/worker/src/catalog/enlarge.ts`, `apps/worker/src/catalog/chunk.ts`, `packages/core/src/catalog/pipeline/enlargement.ts`, `infra/lib/queues.sh`, `docs/specs/00-execution-protocol.md` section 11 |
| No silent plain resize. | Only a terminal enlargement gives the flag `enlargement_failed`, which holds the product; not ready makes the render wait, never fall back. The WARNING fallback path is gone. | `packages/core/src/catalog/render.ts`, `packages/core/src/catalog/qa/reasons.ts`, `apps/worker/src/catalog/enlarge.test.ts` (through the real `renderAllChannels`) |
| Silence must be caught in production too. | Invariant `enlarged_without_upscaler` (ERROR): a staged or verified output above the batch's threshold without `upscaled` in a batch with `options.enlargement`, unless accepted plain by the operator; `plain_accepted_outputs` (INFO), `parked_chunk_quiet` (WARNING), `enlargement_waiting_long` (INFO). | `packages/core/src/catalog/invariants/checks.ts`, `invariants.test.ts` |
| A lost task must be re-sent, but a slow paced lane is not a lost task. | Lane-aware stale re-send: every enlarge delivery of a batch refreshes `progress_at` on its parked chunks; a wanted queued row is sent again with `sends+1` (a new task id) only when the lane was quiet for `ENLARGE_STALE_MS` (60 min); after 20 sends the pace drops to 6 h with an ERROR line, never a failure. The sweep recovers every live batch with a queued or running chunk, done batches included. | `packages/core/src/catalog/pipeline/enlargement.ts`, `packages/core/src/catalog/pipeline/dispatch.ts`, `apps/worker/src/catalog/sweep.ts`, `enlarge.operator.test.ts` (T41) |
| Measuring must not touch production services. | `UPSCALE_MEASURE=1 bash infra/deploy.sh` deploys only `catalog-upscale` as a tagged candidate; gate tests cover it. | `infra/deploy.sh`, `infra/lib/gate.sh`, `infra/tests/gate.test.mjs` |
| Quality (spec 18 3.6): a 1.2x Lanczos stretch is visibly soft, and x2 plus a Lanczos stretch to 3x looks pixelated. | The upscaler makes every enlargement above 1.0x (`UPSCALE_MIN_SCALE` 1); above 2.0x one x4 pass then a Lanczos downscale; AI output is never sharpened. Render tests at 1.2x, 1.5x (x2) and 2.5x (x4); a 1.2x failure holds. | `packages/core/src/catalog/upscale.ts` (`upscalersFor`), `render.ts`, `enhance.ts`, `upscale.test.ts` |
| Choose a model by measuring against ground truth, not by "one call is simpler". | The x2/x4 split was chosen because x4 lost to x2 on PSNR, SSIM and deltaE at 1.2x, 1.5x and 2.0x in the bake-off (`.runs/2026-10-29-18-quality-bakeoff.md`); the numbers are in spec 18 3.6.3. | `docs/specs/18-reliable-enlargement.md` |
| The threshold lives in one place per batch. | The invariant reads the batch's `options.enlargement.minScale` (older batches: 1.5), so a batch made at 1.0 is checked at 1.0. | `packages/core/src/catalog/invariants/checks.ts`, `invariants.test.ts` |
| The shape must hold for the slowest model and its output memory. | `UPSCALE_X4_TIME_RATIO` (1.3) in the timeout rule; a memory rule (4096 MiB + 160 B per input pixel <= 80% of `UPSCALE_MEMORY`); the deploy probe times x4, checks its rerun is byte-identical and (`--x4-ratio`) fails an x4 p95 above 1.3 x the x2 p95. | `infra/lib/shape.sh`, `infra/lib/services.sh`, `infra/tests/shape.test.mjs`, `gate.test.mjs`, `services/matting/tests/cloudrun_check.py` |
| A gate must check the property, on enough calls (2026-10-30: one x4 call over one x2 call, 1.51 against a 1.3 limit, refused a healthy revision). | The x4 check is 2 x `UPSCALE_MAX_PIXELS_X4` x the x4 p95 seconds per MP <= the timeout, over the rounds and the 12 determinism calls on the service's `X-Upscale-Ms` (a cold start never counts), one slow call of 10 or more set aside; x4 cap 6.4 -> 4.9 MP, `UPSCALE_X4_TIME_RATIO` 1.3 -> 1.7. | `services/matting/tests/cloudrun_check.py` (`x4_timeout_check`), `infra/lib/services.sh`, `infra/lib/shape.sh`, tests |
| A cap sized for the slowest model holds work the faster model could do (2026-10-29 review: a 2500 px product on Centrepoint at 1.2x crops to 6.57 MP, over a shared 6.4 MP cap, and was held). | One pixel cap per model, each checked against the timeout with its own time per pixel: `UPSCALE_MAX_PIXELS` 8 MP for x2 (1668 s), `UPSCALE_MAX_PIXELS_X4` 6.4 MP for x4 (1734 s). The worker, the service and shape.sh read the same two variables. | `packages/core/src/catalog/upscale.ts` (`upscaleMaxPixels`), `services/matting/app.py`, `infra/lib/shape.sh`, tests |
| A build pin that only a person compares is no pin. | The converter fails the build when an ONNX export's sha256 does not start with its pin, and a pytest checks the pins equal `UPSCALE_MODEL_VERSIONS`. | `services/matting/tools/convert_upscalers.py`, `services/matting/tests/test_upscale.py` |
| I1 Identity: an image is (prepared pixels, upscaler with export hash, effective scale), always the whole photo. | `identityOf`, `pixelHashOf`, `enlargedPath` with the identity; one validator `validateEnlargedObject` for the handler and the render. | `packages/core/src/catalog/pipeline/enlargement.ts`, `naming.ts`; tests T4, T5, T7, T8, T10, T16, T20, T31, T38, T45, T48, T51-T53, T64 |
| I2 One owner: only the lifecycle module writes `catalog_enlargements` and answers readiness. | `reconcileEnlargements`, `primeReadiness`, `handleEnlargeTask` are the only entry points; the comma job, `storedImageState` and `requeueEnlargementGaps` are gone. | `apps/worker/src/catalog/enlarge.ts`; tests T47, T63 |
| I3 Completeness: every needed identity is done, queued with an owner, or failed after its bounds; a chunk is parked exactly while it has a wanted queued row. | Park and unpark in the settle's transaction; tiles and downscale routes so size alone never holds what a route can make. | `chunk.ts`, `pipeline/enlargement.ts` (`unparkSettledChunks`); tests T6, T28, T30, T33, T35, T53, T54, T68; the state-machine model T40 |
| I4 Not ready is never a verdict. | Render answers 503 without a chunk error; the ladder and the flush cut record the step as skipped; only terminal gives `enlargement_failed`. | `upscale.ts` (`EnlargementNotReadyError`), `auto-resolve.ts`, `chunk.ts`; tests T8-T10, T22, T23, T29, T43, T50, T51, T54, T63 |
| I5 No silent plain resize. | "Use as is" only after the plain warning (409 with the channels); the invariant excludes operator-accepted outputs and counts them. | `packages/core/src/catalog/decisions.ts`, `invariants/checks.ts`, `apps/web/lib/catalog/decisions.ts`; tests T13, T34, T59 |
| I6 Bounded attempts, unbounded patience. | 8 counted attempts, 24 unexplained failures (counted unless a re-probe proves absence), 3 identity changes per photo; waits never count; queues retry without limit. | `apps/worker/src/catalog/enlarge.ts`, `infra/lib/queues.sh`; tests T4, T14, T15, T18, T19, T24-T27, T52, T53, T58, T61, T62, T66, T67 |
| I7 A change of inputs is a new identity, never a reset. | Release (`wanted=false`, status kept) in the same transaction; a failed row wanted again stays failed; a wanted photo that a delivery did not prepare keeps its rows (found by T40). | `releaseEnlargements`, `reconcileEnlargements`; tests T11, T32, T34, T45, T46, T49, T64 |
| I8 No deadlock, no stranded chunk, no time-based failure. | Unpark in the settle, direct enqueue on a non-processing batch, stale re-send, parked batches excluded from the 2 h no-progress rule, finalize re-queue at 10 min while parked. | `pipeline/dispatch.ts`, `sweep.ts`, `finalize.ts`; tests T12, T17, T19, T21, T24, T25, T27, T31, T36, T37, T41, T42, T44, T48, T55, T65, T68 |
| I9 Pinned route. | `options.enlargement` written at Start and read by `routeFor(batch)`; only `UPSCALE_MODEL=off` overrides. | `packages/core/src/catalog/pipeline/enlargement.ts`; tests T1-T3 |

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

### The CPU quota request (filed and granted 2026-10-30)

Outcome: the owner approved the request on 2026-10-30; CPU 400 vCPU and memory 800 GiB in asia-south1 were both
granted the same day. The shape then grew to what they allow (spec 18 section 8, scale-out): `catalog-upscale` 50 x 4
vCPU / 8Gi, the bulk enlarge lane 44 slots, the worker 32 instances. `MATTING_CPU_MAX_INSTANCES` stayed at 4 (the GPU
does the cut-outs), so the vCPU went to the upscaler. The original text follows.

The real limit of enlargement throughput is the Cloud Run CPU quota in asia-south1: 190 vCPU, of which 187 are
assigned (16 x 4 for `catalog-upscale`, the CPU cut-out service at 4 instances, the worker, the web). Until it grows,
a full upscaler fleet answers `busy` and batches wait; nothing fails. Text for the quota form (Google Cloud console,
IAM and admin, Quotas, filter "Cloud Run Admin API", "CPU allocation, per region", region asia-south1):

> Project image-links-agent, region asia-south1: please raise Cloud Run CPU allocation to 400 vCPU. We run a
> CPU image upscaler (catalog-upscale, 4 vCPU per instance, concurrency 1, scale to zero) next to our catalog worker.
> At 190 vCPU it is capped at 16 instances; 400 vCPU lets it scale to 32 instances and restores our cut-out service to
> 16 instances. Usage is bursty (catalog batches), min instances are 0, so idle cost is zero.

After the grant: `UPSCALE_MAX_INSTANCES` 32 and `MATTING_CPU_MAX_INSTANCES` 16 through `infra/lib/shape.sh` and its
tests, with `CPU_QUOTA_LIMIT` (190 today, the share the shape may use) raised to match the grant.

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
  x2 hash exactly); the first Cloud Build now fails if its export differs, rather than only printing it.

- The measured CPU table ("Measured on CPU" in `services/matting/README.md`) and the shape picked from it come
  from the spec 18 section 9 live run.
- The MaxListeners emitter (above).
- The CPU quota request (above).
- Throughput on CPU stays slow (about 2 minutes per 800x1200 photo); a GPU upscaler is the later lever (spec 18
  section 13).
