# GPU shape, held siblings and a deploy that could not protect itself (2026-10-27, spec 17)

Written for spec 17 G5 (`docs/specs/17-reliable-throughput.md` section 3.5.1) from the stream reports of
2026-10-28 and 2026-10-29. The rule this entry follows: a lesson in a document is not a guard. Every learning
below names the check that now enforces it.

## What happened on 2026-10-27, in plain words

Three things went wrong in one evening after the spec 16 deploy. Each had already been written down somewhere
in this repo, and each came back because the note never became a measurement, a refusal, a test or an alert.

### 1. The GPU shape was set from a guess

The spec 16 "F2 shape" kept 3 cut-out models loaded on each L4 GPU, capped each model's memory pool at 6 GiB
(`GPU_MEM_LIMIT_BYTES=6442450944`) and served 2 requests at once. Every bria-rmbg call failed: 225 of 225 HTTP
500, each an ONNX Runtime "arena" (memory pool) allocation failure.

- The card did not run out. The cap is per model (`services/matting/app.py`, `cuda_options`), and one model
  alone needs more than 6 GiB at 1024 px. Nobody had measured how much one model needs.
- The same failure (an 822,083,584-byte arena allocation) was already in `services/matting/README.md` ("the
  822 MB arena failure") and in `docs/specs/05-matting-and-render.md`. The README said "whether three sessions
  fit is measured in the first GPU run after deploy". That first run was production.
- Measured on 2026-10-28 (spec 17 G3, one L4, 1024 px, card-wide peak from `nvidia-smi`): birefnet-general
  13,704 MiB, birefnet-hrsod 13,696 MiB, bria-rmbg 12,424 MiB, birefnet-general-lite 10,842 MiB, against about
  22,528 MiB usable. One model fits; two do not reliably.
- The arithmetic now in `infra/lib/shape.sh`: two resident models need 2 x 13,704 + 2,048 (CUDA overhead) =
  29,456 MiB, more than 22,528, so the shape is refused. A probe of two resident models passed with one image
  repeated, but under real mixed traffic (the spec 10 eval) it failed 8 of 349 calls with the same arena error.
  The arithmetic was right; a short probe was not enough evidence on its own.

### 2. "124 silent outputs" were the held siblings

The 200-product speed test reported "124 silent outputs" and failed. A silent output is an image that was
neither published nor explained by a hold, so it would be lost work. These were not lost.

- 8 products were held for the operator ("Needs attention"). A held product waits as a whole: its good images
  stay `staged` on purpose until the operator decides. Those good images are the "held siblings".
- The arithmetic: 8 held products x about 4.4 photos x 4 channels is about 140 outputs = 124 staged + 16
  `needs_attention`. The re-check said 3,436 of 3,576 OK, and 3,576 - 3,436 = 140.
- The load driver's `classifyOutputs` (`packages/core/src/catalog/load/classify.ts`) never read the product's
  `change` column, so it could not tell a held sibling from lost work.
- The same misreading was recorded on 2026-10-21 in `docs/PROGRESS.md` ("staged 208 ... the held products'
  siblings, not lost work") and not fixed.

### 3. The deploy tested the old revision and could not roll back by itself

- The preview stack had no GPU service; it read the live GPU URL from the production worker.
- The smoke test ran before any service was updated and copied the cut-out service URLs from the old worker, so
  it tested the old GPU revision, not the one being deployed.
- When the live GPU broke, the next deploy's smoke waited on it for up to 3,600 s, so the rollback had to bypass
  `infra/deploy.sh`.
- One chunk of 100 tailed for 20 minutes and nothing watched it: the sweep and all ten alerts read chunks and
  batches, never `catalog_outputs`.

The tail chunk was diagnosed on 2026-10-28 (batch d9469ed5, 19:11Z to 20:02Z): two chunks lost their render
task. The worker answered 152 HTTP 429 ("no instance free") to Cloud Tasks with 0 ms latency between 19:15 and
19:32Z. The queue then had `maxAttempts 5`, so five 429s in a row deleted the task, and the sweep's 30-minute
lost-task rule picked the chunk up 32 and 34 minutes later. That added about 18 minutes to the batch (median
chunk span 390 s, tail chunk 2,215 s).

## The five invariants

An invariant here is a sentence that must always be true. Spec 17 section 0 turned the three failures into
five of them:

| Invariant | What guards it now |
|---|---|
| I1. A GPU setting serves operators only after it was measured on the real GPU under the real request shape. | The probe (`infra/check-matting.sh --probe`), the measured table ("Measured on L4" in `services/matting/README.md`) and the shape refusals that read it (`infra/lib/shape.sh`). |
| I2. A deploy tests the revision it deploys, and rollback never depends on the thing that may be broken. | The deploy gate (`infra/lib/gate.sh`): no-traffic candidate, probe, traffic shift, one-command rollback; the smoke runs against the candidates. |
| I3. A test's pass check and the system's state model agree. | `classifyOutputs` with holds, and the same rule as a production invariant checked every 10 minutes, not only in the load driver. |
| I4. Every learning names the check it added. | The rule in `docs/specs/00-execution-protocol.md` section 11, and this table. |
| I5. One change at a time toward production. | One PR per stream; one GPU knob per candidate; `deploy.sh` deploys one service at a time behind its gate. |

## Learning -> check added (file)

| Learning | Check added | File |
|---|---|---|
| A per-model memory cap below one model's need fails every call of that model. | Refusal: `GPU_MEM_LIMIT_BYTES` must be at least the measured peak of every served model plus 512 MiB. | `infra/lib/shape.sh` (`gpu_memory_check`), `infra/tests/shape.test.mjs` ("F2 shape refused by the real bria peak") |
| Resident models must fit the card by arithmetic, with measured numbers. | Refusal: `MAX_RESIDENT_SESSIONS x max(cap, largest peak) + GPU_CUDA_OVERHEAD_MIB + upscaler peak <= 22,528 MiB`; 2 and 4 resident refused by the real peaks. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs` |
| An unmeasured model must never go live on a new GPU shape. | Refusal "measure first: run infra/check-matting.sh --probe" for a model with no `GPU_MODEL_PEAK_MIB_<model>` row. | `infra/lib/shape.sh`, `infra/tests/shape.test.mjs` |
| A GPU number is measured on the real card, not assumed. | Probe mode: per model, warm call, concurrent rounds and the real switching order, peak VRAM read after every step; exits non-zero on any non-200. | `services/matting/tests/cloudrun_check.py --probe`, `infra/check-matting.sh --probe`, `infra/tests/check-matting-probe.test.mjs` |
| The measured numbers must sit where the next person looks. | "Measured on L4" tables per model at concurrency 1 and 2, with the date; peaks copied into the shape rows with `GPU_MEASURED_ON`. | `services/matting/README.md`, `infra/lib/shape.sh` |
| A short probe can pass a shape that real traffic breaks (two resident models). | Not yet a check. Ticket: an interleaved mixed-model probe phase when `maxResident > 1` (spec 17 GPU ladder report, "Open"). Until then the arithmetic refusal is what blocks it. | ticket, follow-up |
| A held product's good images are not lost work. | `isHeldSibling(output, heldIds)` shared by the sheet writer and `classifyOutputs(outputs, holds)`; the report line "Held with the product (waiting for the operator): N. Silent outputs (must be none): M."; only M fails a pass. | `packages/core/src/catalog/pipeline/report.ts`, `packages/core/src/catalog/load/classify.ts` and `classify.test.ts` |
| Lost work must be found in production too, not only in a test driver. | Invariants table (`silent_outputs`, `held_without_reason`, `stale_running_chunk`, `slow_chunk`, `done_batch_with_open_chunk`), run by the sweep every 10 minutes and by the `catalog-invariants` job; alerts 11 (silent outputs) and 12 (slow chunk). | `packages/core/src/catalog/invariants/checks.ts`, `run.ts`, `invariants.test.ts`; `apps/worker/src/catalog/sweep.ts`; `infra/monitoring/policies/11-silent-outputs.json`, `12-slow-chunk.json` |
| A product whose copy fails must not leave staged leftovers (publish gap B). | Test: a copy that fails on the second of four outputs leaves one `verified`, three `failed` with the reason, zero `staged`. | `packages/core/src/catalog/pipeline/publish.ts`, `publish.failure.test.ts` |
| A deploy must test the revision it deploys. | Gate: `gcloud run deploy --no-traffic --tag candidate`, the service's probe against the tag URL, traffic only on a pass. | `infra/lib/gate.sh` (`deploy_service`), `infra/lib/services.sh` (registry and probes), `infra/tests/gate.test.mjs` |
| The smoke must test the candidates and must never hang. | `MATTING_URL`, `MATTING_GPU_URL`, `WORKER_URL` from the deploy in progress; cut-out readiness ceiling `SMOKE_CUTOUT_READY_MS` (300 s); smoke job timeout 1,500 s. | `infra/catalog-test-jobs.sh`, `infra/catalog-smoke-linux.sh` |
| Rollback must not depend on the broken thing. | `deploy.sh --rollback <name>` runs `update-traffic --to-revisions <previous>=100`: seconds, no build, no smoke. | `infra/deploy.sh`, `infra/lib/gate.sh` (`rollback_service`), `infra/tests/gate.test.mjs` |
| A plain `deploy.sh` with no env must not undo the live shape. | `SHAPE_DEFAULTS` equal the live production shape; a shape change is a change to that table in the PR that deploys it. | `infra/lib/shape.sh`, `docs/solutions/throughput.md` |
| A Cloud Run tag URL takes an ID token whose audience is the service URL. | Both TypeScript clients strip the `<tag>---` prefix for the audience; unit test. | `packages/core/src/cloud-run.ts` and its test, `docs/solutions/deploy-cloud-run.md` |
| A queue must not delete a task because the worker answered 429 before the app ran. | Chunk queues retry without an attempt limit for 30 minutes (`--max-attempts=-1 --max-retry-duration=1800s --max-backoff=60s`). | `infra/lib/queues.sh` (`CHUNK_QUEUE_RETRY`), `infra/tests/queues.test.mjs` |
| A lost chunk task must be found in minutes, not 30. | `redispatchUnstartedChunks`: a queued step that no delivery claimed for 6 minutes is sent again once (`chunk recovered`, reason `task_not_started`); resilience test reproduces the d9469ed5 tail. | `packages/core/src/catalog/pipeline/dispatch.ts`, `apps/worker/src/catalog/resilience.test.ts` |
| The queue's retry count also counts 429s that never reached the app, so it must not decide that a chunk has failed. | A chunk fails on its own recorded errors (`counts.chunkErrors`, `CHUNK_MAX_ERRORS` = 5); a same-step copy with a live lease always answers busy. | `apps/worker/src/catalog/chunk.ts`, `apps/worker/src/catalog/pipeline.test.ts` |
| One cut-out model that always fails can hide behind a healthy service. | `matting_breaker` carries `model` and `status`; failures counted per (service, model); WARNING `matting_model_failing`. | `packages/core/src/catalog/matte.ts`, `matte.test.ts` |
| A tail chunk must be visible in the load report. | Load report prints chunk time median, p95 and max; pass criterion "the last chunk finishes within 2 x the median chunk time". | `apps/worker/src/catalog-load.ts`, `docs/specs/16-throughput.md` section 9 |
| A learning without a check recurs. | Protocol rule: a `docs/solutions/` entry names the check it added or the ticket for it. | `docs/specs/00-execution-protocol.md` section 11 |

## The first use of the gate (2026-10-28)

The new gate stopped four deploys before any traffic moved. Each was a different real problem and each was
fixed once:

1. The CPU cut-out probe could not finish in 300 s, and the deploy defaults held the pre-F2 shape (#114).
2. gcloud refused the probe job's repeated `--args` (#115).
3. The worker smoke sent an ID token with the tag URL as audience, which Cloud Run refuses (#116).
4. The web probe got 401 on the candidate tag URL behind IAP (#117).

The fifth run (ea22854) went live on all four services. The gate did its job: a broken candidate never served
an operator.
