# 17 Reliable throughput: measured GPU shape, guarded deploys, honest completion (release G)

Catalog module, spec 17. Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`.
Depends on spec 16 (release F, live since 2026-10-27 at main fc5e886, GPU part rolled back to one resident model).
Branch `feat/catalog-17-reliable-throughput`; one worktree per stream under
`C:\Users\Sujan Ajay\Desktop\catalog-module-wt\17-<stream>`; one PR per stream (G1 to G5), each merged on its
own, in the order of section 2. Never on `main` directly.

Owner decisions (Sujan, 2026-10-28, in the owner's words where quoted):
1. "All five workstreams." Nothing is deferred to a later round.
2. "You merge the PRs. You have complete access, and you do everything." The manager opens, reviews, merges and
   deploys. "No human will be babysitting and authorizing any permission."
3. GPU candidates are tried on a tagged no-traffic revision of the live GPU service, never on production traffic
   and not on a second permanent service.
4. "Long-term perspective ... tomorrow a lot more services and things will be added ... it should be scalable."
   Every guard built here is generic: it takes the next service, the next model and the next check by adding a
   row, not by adding code.
5. "Things should not fail or break at any point in time." Reliability is the first pass criterion, speed the
   second. A speed gain that costs one lost or wrong image is not taken.
6. "Fastest time that's possible based on the constraints of Google GCP." Within today's quotas (3 L4 in
   asia-southeast1, 190 vCPU in asia-south1). A quota increase is listed as the lever beyond that (section 13)
   and is the owner's call; the spec 16 decision "no quota forms" stands until the owner says otherwise.
7. "Just do a test of 200 products and let me know how fast we're able to do it." Section 9 ends with that
   number and the projection for 2,000 and 7,000.
8. "You do not have to wait for a quiet window as such." The manager does not wait for one. Instead the system
   must prove operator-first behaviour while a load runs (section 9, step 6). This supersedes the standing rule
   of 2026-10-20 to 10-22 (memory: never load-test while the owner uses the site) for this spec only.
9. The executing manager "will not be using their own context window ... We need to make sure that we spawn a
   bunch of sub-agents ... The main agent will act as more of a manager and a delegator." Section 11 makes that
   binding.

## Words used here

- Output: one made image for one photo on one channel. Status `pending`, `staged` (made, waiting to publish),
  `verified` (published and read back), `needs_attention` (held for the operator), `failed`, `skipped`.
- Held product: a product with at least one `needs_attention` output. The whole product waits for the operator;
  its good outputs stay `staged` by design. "Held sibling" is such a good output.
- Silent output: an output that is neither ended nor explained by a hold. There must never be one.
- Resident model: a cut-out model kept loaded in GPU memory. Arena: the memory pool ONNX Runtime grows for one
  model. Cap: `GPU_MEM_LIMIT_BYTES`, the most one model's arena may take. VRAM: the card's memory (L4: 24 GB,
  about 22.5 GB usable).
- Revision: one deployed version of a Cloud Run service. Tag: a name that gives a revision its own URL.
  No-traffic revision: deployed, reachable by its tag URL, serving none of the live traffic.
- Probe: a job that calls a revision the way production will (same models, same image size, same concurrency)
  and measures. Gate: a probe whose failure stops the deploy.
- Invariant: a sentence about the data that must always be true (for example "a done batch has no silent
  output"). The invariants job checks every one on a timer and alerts on the first false one.
- Manager: the main session. Builder, integration, review, watcher, researcher: subagents with their own context.

## 0. Why this spec exists (what happened on 2026-10-27)

Three things went wrong in one evening, and every one of them was already written down somewhere in this repo.

1. The GPU "F2 shape" (3 resident, 6 GiB cap, concurrency 2) failed every bria-rmbg call: ONNX arena out of
   memory, 225 of 225 HTTP 500. The cap is per model (`services/matting/app.py` `cuda_options`), and bria-rmbg
   alone grew past 6 GiB at 1024 px. The card did not run out; the per-model cap was below one model's need, and
   that need had never been measured. The identical 822,083,584-byte failure was already in
   `services/matting/README.md` ("the 822 MB arena failure") and `docs/specs/05-matting-and-render.md`. The
   README said "whether three sessions fit is measured in the first GPU run after deploy". That run was production.
2. The 200-product speed test reported "124 silent outputs" and failed. Those are, with high confidence, the held
   siblings of the 8 held products (8 x about 4.4 photos x 4 channels is about 140 = 124 staged + 16
   needs_attention; the re-check says 3,436 of 3,576 OK, that is 140 not OK). The load driver's
   `classifyOutputs` (`packages/core/src/catalog/load/classify.ts`) never reads the product's `change`, so it
   cannot tell a held sibling from lost work. The same misreading was recorded on 2026-10-21
   (`docs/PROGRESS.md`, "staged 208 ... the held products' siblings, not lost work") and not fixed.
3. The deploy could not protect itself: the preview stack has no GPU service (it reads the live GPU URL from the
   production worker, `infra/deploy.sh` "matting GPU" block); the smoke runs before any service is updated and
   copies the matting URLs from the old worker (`infra/catalog-test-jobs.sh`), so it tests the old GPU revision;
   when the live GPU broke, the next deploy's smoke waited on it for up to 3600 s, so the rollback had to bypass
   deploy.sh. One chunk of 100 tailed 20 minutes; nothing watches a slow chunk whose lease is alive, and the
   sweep and all ten alerts never read `catalog_outputs`.

The lesson, from first principles: a lesson in a document is not a guard. The failures recurred because the
knowledge was never turned into a measurement, a refusal, a test or an alert. This spec turns each into one:

| Invariant | Guard built here |
|---|---|
| I1. A GPU setting serves operators only after it was measured on the real GPU under the real request shape. | G3 probe, measured table, shape refusals that read the table. |
| I2. A deploy tests the revision it deploys, and rollback never depends on the thing that may be broken. | G2 no-traffic deploy, probe, traffic shift, instant rollback, smoke against candidates. |
| I3. A test's pass check and the system's state model agree. | G1 classify with holds; outputs invariant in production, not only in the load driver. |
| I4. Every learning names the check it added. | G5 protocol rule; the solutions entry of this spec lists its checks. |
| I5. One change at a time toward production. | One PR per stream; one GPU knob per candidate; deploy.sh deploys one service at a time behind its gate. |

## 1. What changes for the operator

- Nothing on screen for the operator. No new sentence, no model name.
- Big batches finish faster once G3 lands (the measured number is the deliverable of section 9, not a promise).
- A small batch started while a big one runs keeps moving (section 9 step 6 proves it).
- The admin Ops page gains four numbers: silent outputs, held siblings, slowest running chunk, GPU candidate
  revision (section 3.1.5).

## 2. Scope

| Stream | Files owned | Depends on |
|---|---|---|
| G1 Honest completion | `packages/core/src/catalog/load/classify.ts` and test, `apps/worker/src/catalog-load.ts`, `packages/core/src/catalog/pipeline/publish.ts` and `pipeline.test.ts` (gap B only), new `packages/core/src/catalog/invariants/*.ts` and tests, `apps/worker/src/catalog/sweep.ts` (one call), new worker job entry `apps/worker/src/catalog-invariants.ts`, `apps/web/lib/catalog/ops.ts` and `ops-copy.ts` (admin numbers), `infra/monitoring/policies/11-silent-outputs.json`, `12-slow-chunk.json`, `infra/monitoring.sh` (two rows), `infra/catalog-test-jobs.sh` (job row) | nothing |
| G2 Deploy gate | `infra/deploy.sh`, new `infra/lib/services.sh` (service registry), new `infra/lib/gate.sh` (deploy_service), `infra/catalog-test-jobs.sh` (candidate URLs), `infra/catalog-smoke-linux.sh` (timeout), `infra/tests/*` (offline tests for the registry and the gate's argument building), `docs/solutions/deploy-cloud-run.md` | nothing |
| G3 GPU measured and fitted | `services/matting/app.py`, `services/matting/tests/*`, `services/matting/tests/cloudrun_check.py` (probe mode), `infra/check-matting.sh`, `infra/lib/shape.sh` and `infra/tests/shape.test.mjs`, `packages/core/src/catalog/matte.ts` and test (per-model breaker log fields only), `services/matting/README.md` | G2 merged before any candidate goes to a tagged revision; the probe code itself needs nothing |
| G4 Tail chunk | read-only diagnosis first; then `packages/core/src/catalog/pipeline/dispatch.ts`, `apps/worker/src/catalog/chunk.ts`, `resilience.test.ts` or `delivery-timers.test.ts`, as the diagnosis names | nothing for the diagnosis; G1's slow-chunk log line is reused if it has merged |
| G5 Docs and protocol | `docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md` (new), `docs/specs/00-execution-protocol.md` (sections 9 and 11), `docs/specs/16-throughput.md` (corrections), `docs/specs/README.md`, `services/matting/README.md` (measured table, written by G3, linked here), `docs/plans/2026-10-28-post-deploy-status.md` (plain-language status for the owner), handoff via ce-handoff | G1 to G4 results (it is written last, but its skeleton is opened first and filled as streams finish) |

Out of scope: retuning photo concurrency, bulk window, AI check pacing or the database tier; batching several
photos into one GPU call; fp16; Vertex AI direct; the finalize split for 7,000; any GCP delete; cancelling the
BHPC drafts (574f2025, 09dd86f2) or changing operator copy (owner items, listed in the status doc, not done);
any quota request (section 13, owner's call).

Builders fetch current docs through Context7 before using ONNX Runtime (CUDA provider options, cuDNN options,
session thread safety), rembg, Cloud Run (`--no-traffic`, `--tag`, `services update-traffic`, GPU limits),
Cloud Tasks or Cloud Monitoring.

## 3. Fixes

### 3.1 G1: honest completion

3.1.1 `classifyOutputs(outputs, holds)` takes the set of held product ids (products whose
`catalog_batch_products.change = 'pending_attention'`) and returns `{ byStatus, ended, heldSiblings, silent,
failed, errorsByReason }`. A `staged` output with no decision on a held product is a held sibling. Everything
else that is not `verified | needs_attention | skipped | failed-with-reason` is silent. The report line becomes:
`Held with the product (waiting for the operator): N. Silent outputs (must be none): M.` Only M fails the pass.
Reuse the "waiting" definition of `deliveredLinks` (`pipeline/report.ts`) rather than writing a second one;
extract it into one exported predicate `isHeldSibling(output, heldIds)` used by both.

3.1.2 Publish gap B. In `publishProduct`, when a copy fails and the loop breaks, every remaining `staged` output
of that product in this batch is set `failed` with the same reason and `error`, in the same transaction, so a
product with `change = failed` has no staged leftovers. Sheet notes list them through the existing `outputNote`.
Test next to the publish tests in `pipeline.test.ts`: a copy that fails on the second of four outputs leaves
one `verified`, three `failed` with the reason, product `failed`, zero `staged`.

3.1.3 Invariants, as a table not as code. `packages/core/src/catalog/invariants/checks.ts` exports an array of
`{ id, sentence, severity, sql }`, each SQL returning rows that violate the sentence (zero rows = true):
- `silent_outputs`: outputs `pending`, or `staged` with no decision on a product that is not `pending_attention`,
  in a batch whose status is `done` or `failed`. ERROR.
- `held_without_reason`: `needs_attention` outputs with an empty `reason`. ERROR.
- `stale_running_chunk`: a chunk `running` whose `lease_until` passed more than 5 minutes ago. WARNING (the
  sweep should have recovered it).
- `slow_chunk`: a chunk `running` for more than 3 x the median finished-chunk time of its batch and more than
  10 minutes. WARNING.
- `done_batch_with_open_chunk`: batch `done` with a chunk not `done | failed`. ERROR.
Adding a check is adding one object. `runInvariants(db, log, now)` runs all, logs one line per check
(`invariant`, fields `id`, `violations`, `sample` of up to 5 ids, `severity`) and returns the counts. It is called
from the sweep (every 10 minutes, after `recoverBatchChunks`) and exposed as a Cloud Run job `catalog-invariants`
(same image, `dist/catalog-invariants.js`) for an on-demand run. Alert policy 11 "silent outputs" fires on
`invariant` with `id=silent_outputs` and `violations>0`; policy 12 "a chunk is far slower than the rest" on
`id=slow_chunk`. Both follow the JSON shape of policies 01 to 10 and the email channel they use.

3.1.4 The load driver (`catalog-load.ts`) calls `runInvariants` for its own batch at the end and prints the
results in the report; a violation of an ERROR check fails the pass. The driver stops computing its own
"silent" count; it uses 3.1.1.

3.1.5 Ops page (admin only, `apps/web/lib/catalog/ops.ts`): four lines from the latest `invariant` results stored
in a small jsonb on `catalog_batches.counts` (no migration: `counts` is jsonb) and from Cloud Run: "Silent
outputs: N", "Held with the product: N", "Slowest running chunk: <stage>, <minutes> min (batch <short id>)",
"GPU candidate revision: <tag or none>". Copy lives in `ops-copy.ts`. No model ids on screen.

### 3.2 G2: one deploy gate for every Cloud Run service

3.2.1 Service registry `infra/lib/services.sh`: one bash function per service that prints its deploy arguments
and names its probe, read by deploy.sh in a fixed order: `catalog-matting`, `catalog-matting-gpu`,
`catalog-worker`, `catalog-web`. Adding a service is adding one function and one probe. Fields: name, region,
image, service account, shape args (from `shape.sh`), env, labels, probe command, probe timeout, whether the
service can take `--no-traffic` (all of these can).

3.2.2 `deploy_service <name>` in `infra/lib/gate.sh`:
1. `gcloud run deploy <name> ... --no-traffic --tag candidate` (same flags as today plus these two).
2. Resolve the tag URL from the service description (`status.traffic[].url` where `tag=candidate`).
3. Run the service's probe against the tag URL with a hard timeout (GPU 600 s including cold start, others 300 s).
   The probe exits non-zero on any failure.
4. On success: `gcloud run services update-traffic <name> --to-latest`, then remove the tag from the previous
   revision (keep at most one `candidate`). Print `==> <name>: live (<revision>)`.
5. On failure: leave traffic where it is, print the probe output, print the exact rollback line for the operator
   of the deploy (`gcloud run services update-traffic <name> --to-revisions <previous>=100`), exit non-zero.
   deploy.sh stops; later services are not touched.
Rollback of a live revision is always `update-traffic --to-revisions <previous>=100`: seconds, no build, no
smoke. `deploy.sh --rollback <name>` wraps it. Idempotent: re-running deploy_service with an unchanged image and
env prints SKIP after comparing the live revision's image digest and env.

3.2.3 Probes, one per service, each a small script or job already in the repo where possible:
- `catalog-matting` and `catalog-matting-gpu`: `infra/check-matting.sh --probe` (G3, 3.3.1) with the models and
  concurrency of the shape; pass = zero non-200, every model loaded at most once per instance, measured peak
  VRAM under the cap arithmetic.
- `catalog-worker`: `/health` 200 on the tag URL, then the tier 5 smoke (3.2.4) with `WORKER_URL` = tag URL.
- `catalog-web`: `/health` 200 and the home page 200 behind IAP using the existing smoke identity.

3.2.4 The smoke tests the candidates. `infra/catalog-test-jobs.sh` takes `MATTING_URL`, `MATTING_GPU_URL` and
`WORKER_URL` from the deploy in progress (the tag URLs) when set, and falls back to the deployed worker's env
only when run by hand. The smoke's cut-out readiness wait (`waitForCutOutDefault`) gets a ceiling of 300 s from
`SMOKE_CUTOUT_READY_MS`; past it the smoke fails with "the cut-out service did not become ready", never hangs.
The smoke job's own timeout drops from 3600 s to 1500 s.

3.2.5 Order inside deploy.sh becomes: preflight and shape refusals, build, migrate, then for each service in the
registry `deploy_service` (so the smoke now runs inside the worker's gate, against the new matting candidates and
the new worker candidate), then queues, jobs, monitoring. Preview (`CATALOG_PREVIEW=1`) deploys the GPU service as
a no-traffic candidate too (image built, probe run, traffic never shifted) so a GPU shape can be tried from a
branch. The preview's worker points at the GPU candidate URL.

3.2.6 Offline tests (`infra/tests/gate.test.mjs`): the registry lists the four services in order; the argument
builder adds `--no-traffic --tag candidate`; the rollback line names the previous revision; a probe failure
returns non-zero and prints the rollback line; SKIP when digest and env match. No gcloud in tests (the gate
takes a `gcloud` function that tests replace).

### 3.3 G3: the GPU measured, then fitted

3.3.1 Probe mode in `services/matting/tests/cloudrun_check.py --probe --models <list> --concurrency <n>
--rounds <k>` run by `infra/check-matting.sh --probe` as the existing Cloud Run job against a URL argument:
for each model, one warm call at 1024 px, then `concurrency` calls at once for `rounds` rounds, then the policy's
real switching order (birefnet-general, bria-rmbg, birefnet-general-lite, birefnet-hrsod, back to general), reading
`/health.gpuMemory` after every step. Output: a markdown table `model | peak VRAM used (MiB) | p50 ms | p95 ms |
non-200 | loads` and a JSON file in `gs://image-links-agent-assets/catalog-test/probe/<run>/`. Exit non-zero on
any non-200 or on more than one load per model. The README gets a "Measured on L4" section with the table and the
date; this replaces the "not assumed to fit without measurements" text.

3.3.2 `app.py` changes, each behind an env var so one knob moves per candidate:
- `CUDNN_CONV_ALGO_SEARCH` (`DEFAULT | HEURISTIC | EXHAUSTIVE`, default unchanged = ONNX default) and
  `CUDNN_CONV_USE_MAX_WORKSPACE` (`0 | 1`, default unchanged) on cut-out sessions, same options the upscaler
  already sets. Expected to cut the arena a lot; measured by the probe; pixel effect gated by the spec 10 evals
  on the preview stack (G3 runs `catalog-output-evals` once with the candidate; pass = the spec 10 bars).
- `INFERENCE_LOCK_SCOPE` (`global | session`, default `global`): with `session`, each session has its own lock and
  two different models may run at once (ONNX sessions are thread-safe for `run`; loads and evictions still take
  the global lock). Measured for VRAM and latency before it is used.
- `/health` adds `residentModels` (ids), `arenaBytesByModel` where ONNX exposes it, and `candidate` (the
  `K_REVISION` env Cloud Run sets) so the Ops line in 3.1.5 can show it.

3.3.3 Memory arithmetic in `shape.sh`, data-driven. A table `GPU_MODEL_PEAK_MIB_<model>` with the measured peaks
from 3.3.1 and a `GPU_MEASURED_ON` date. Refusals: `GPU_MEM_LIMIT_BYTES`, when set, must be at least the measured
peak of every model in `MATTE_MODELS` plus 512 MiB; `MAX_RESIDENT_SESSIONS x max(cap, largest peak) +
GPU_CUDA_OVERHEAD_MIB (2048) + (upscaler peak if UPSCALE_SERVICE=gpu)` must be at most 22,528 MiB; `GPU_CONCURRENCY`
at most `MAX_RESIDENT_SESSIONS` when `INFERENCE_LOCK_SCOPE=session`. A shape with no measured peak for a listed
model is refused with "measure first: run infra/check-matting.sh --probe". `shape.test.mjs` asserts the 2026-10-27
F2 shape is refused once the bria-rmbg peak is in the table, and that today's live shape passes.

3.3.4 The candidate ladder. Each candidate is one tagged no-traffic revision through G2, probed, then kept or
dropped. One knob per rung; stop at the first rung that passes the probe and meets the target, keep measuring
one more rung only if it is cheap. Target: zero non-200, at most one load per model per instance after warm-up,
and the highest cut-outs per minute per L4. Rungs:
1. Today's shape (1 resident, concurrency 1, no cap) measured as the baseline.
2. Rung 1 + HEURISTIC and no max workspace. Spec 10 evals on preview before it may go live.
3. Rung 2 + 2 resident, no cap.
4. Rung 3 + all four models resident if the arithmetic in 3.3.3 allows it with the measured peaks.
5. Rung 4 + `INFERENCE_LOCK_SCOPE=session` and concurrency 2.
6. If rung 4 does not fit: split by model group instead. Two GPU services with `MATTE_MODELS` subsets
   (`catalog-matting-gpu` with birefnet-general and birefnet-general-lite; `catalog-matting-gpu-b` with bria-rmbg
   and birefnet-hrsod), max-instances summing to the quota of 3. `MattingClient` already routes a model only to
   services that list it and round-robins over `MATTING_GPU_URLS`, so no client change. The registry (3.2.1)
   gets one more row. This rung is used only if rung 4 fails, because it splits the quota by model instead of by
   demand.
Each rung's probe table goes into the README section. The decision which rung goes live is a Fable judgement call
(section 11) with the tables in front of it, written to `.runs/`.

3.3.5 Breaker visibility (`matte.ts`): the `matting_breaker` log line gains `model` and `status` of the failing
call, and failures are counted per `(service, model)` so a model that always fails is seen even while another
model keeps the service "healthy". The fallback behaviour is unchanged. Alert 04 keeps firing on the same line.

3.3.6 Go-live of the chosen rung: G2's gate shifts traffic only after the probe passes on the candidate; then
section 9 step 5 runs. Rollback: the traffic switch line of 3.2.2.

### 3.4 G4: the tail chunk

3.4.1 Diagnosis, read-only, by a researcher subagent with the log queries in its brief: `catalog-worker` logs for
batch d9469ed5 between 2026-10-27 18:10Z and 19:15Z, `jsonPayload.message="chunk delivery"` grouped by chunkId
with `outcome`, `attempt`, `msPerStep`, `photos`; `"chunk recovered"`; `matting_breaker`; HTTP 429 and 503 on
`/tasks/catalog/chunk`; judge 429 lines. The report names the tail chunk, its deliveries, their outcomes and the
gaps between them, and matches them to one of: request hung to the 900 s deadline then lease lapse and retries;
lost hand-off task picked up by the sweep's 30-minute rule; cut-out retry waits; judge back-off; something else.

3.4.2 The fix is chosen by the finding, from these prepared options, one of which is built and tested:
- hung delivery: a per-photo watchdog that abandons a stuck photo at `CHUNK_TIME_BUDGET_MS + 60 s` and hands the
  chunk off, instead of waiting for the 900 s request deadline; the Cloud Tasks dispatch deadline is left alone.
- lost hand-off task: when `tryEnqueueChunk` fails at a hand-off, the chunk is marked `dispatched_at = null` so
  the next finish or sweep (10 min) re-dispatches it; the 30-minute lost-task rule stays for the true lost case.
- cut-out or judge waits: a per-delivery ceiling (`CHUNK_WAIT_CEILING_MS`, 240 s) on the sum of retry and
  back-off waits, after which the delivery hands off with its finished photos.
A test in `resilience.test.ts` reproduces the found case with the fakes and shows the chunk finishes within 2 x
the median in simulated time.

3.4.3 Spec 16 section 9 gets the criterion "the last chunk finishes within 2 x the median chunk time"; the load
driver report prints median, p95 and max chunk time (it has `ChunkSample`s already).

### 3.5 G5: write it where it becomes a guard

3.5.1 `docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md`: section 0 of this spec in plain language with
the evidence (log counts, the arithmetic, the two earlier mentions), the five invariants, and a table "learning ->
check added (file)". Written by the manager's docs subagent from the stream reports.

3.5.2 `00-execution-protocol.md`: section 9 says every service deploys through `deploy_service` and names the
probe; section 11 adds: an infra or shape change ships in its own PR; a GPU shape goes live only through a probed
no-traffic candidate; a docs/solutions entry names the check it added or the ticket for it; one spec per PR is
restated with "a bundle of specs in one PR is a blocking rule violation".

3.5.3 `16-throughput.md`: CPU quota 190 (not 200); "measured in the first GPU run after deploy" replaced by a
pointer to 3.3.1; the tail criterion; "held with the product" outputs are expected and counted apart; section 14
ticked where true.

3.5.4 `docs/plans/2026-10-28-post-deploy-status.md`: the plain-language status the owner asked for on 10-27:
what is live, what was broken and is now guarded, the measured speed, the owner items still waiting (the three
status messages: "Added, not collected yet", "Please wait...", "This did not finish. Try again."; telling the
operator before the two BHPC drafts are cancelled; the BHPC retry after that). Owner items are listed, not done.

3.5.5 Handoff via ce-handoff to `~/ai-personal/handoffs/catalog-module/17-reliable-throughput.md` at every
milestone (each PR merged, before the live GPU shift, after the speed test).

## 4. Data and state changes

No migration. `catalog_batches.counts` (jsonb) gains the keys `silentOutputs`, `heldSiblings`, `slowestChunkMs`
written by the invariants run. Cloud Run: the `candidate` tag on each service; a possible second GPU service only
on rung 6. Monitoring: policies 11 and 12, one log metric each. Jobs: `catalog-invariants`.

## 5. Copy

Operator-facing: none. Admin Ops page (English, `ops-copy.ts`): "Silent outputs", "Held with the product (waiting
for the operator)", "Slowest running chunk", "GPU candidate revision", "none". Alert emails: policy 11 "Some
images were left half-finished (silent outputs)"; policy 12 "One chunk is far slower than the rest". No model ids.

## 6. Tests

Tier 1 and 2 (vitest, pytest, infra tests, in CI): classify with holds (held sibling vs silent; failed without
reason is silent); publish gap B; every invariant check with a PGlite fixture that violates it and one that
satisfies it; sweep calls `runInvariants`; Ops numbers; gate argument builder, SKIP, rollback line, failure path;
registry order; shape refusals from the measured table (F2 shape refused by name; live shape passes; unmeasured
model refused); app.py env knobs (cuDNN options in the provider tuple, lock scope, `/health` fields) with mocked
ONNX; matte.ts per-model breaker fields; G4's reproduction test.
Tier 3: none new.
Tier 5: the smoke, now inside the worker gate against candidates (3.2.4).
Tier 6: section 9.
Spec 10 evals: once per cuDNN or lock-scope candidate on the preview stack (`catalog-output-evals`), pass = the
spec 10 bars, before that candidate may take live traffic.

## 7. Local scale test

`apps/worker/src/catalog/scale.test.ts` gains one hold (a forced `needs_attention` on one product) and asserts
the load report prints held siblings N > 0 and silent 0; and one slow chunk in the model asserting the
`slow_chunk` invariant fires.

## 8. Env and shape

New env, all with today's behaviour as default: `CUDNN_CONV_ALGO_SEARCH`, `CUDNN_CONV_USE_MAX_WORKSPACE`,
`INFERENCE_LOCK_SCOPE`, `SMOKE_CUTOUT_READY_MS`, `CHUNK_WAIT_CEILING_MS` (if G4 picks it), `GPU_MODEL_PEAK_MIB_*`,
`GPU_MEASURED_ON`, `GPU_CUDA_OVERHEAD_MIB`. The live shape at the start of this spec is spec 16's F2 for worker and
queues and the pre-F2 GPU (4 vCPU, 16Gi, concurrency 1, 1 resident, no cap). Only G3's chosen rung changes it.

## 9. Live verification (after the G1 to G4 deploys)

Step 0, read-only: `gcloud auth print-access-token` works (the manager starts `gcloud auth login` itself and asks
the human only for the browser click, per the manager rules); describe the four services, the queues, the tier.
Record the live revisions in the report.

Step 1: G1 deployed through the (G2) gate; `catalog-invariants` run by hand once against production; the report
lists every invariant's violation count. Any `silent_outputs` violation on an existing batch is reported with the
batch ids (not fixed silently; the fix is a decision of the owner because it touches delivered batches).

Step 2: G3 probe on the live GPU revision (rung 1) as the baseline table.

Step 3: the ladder of 3.3.4 on tagged candidates, one rung at a time, probe table each, evals where required.
Each rung costs minutes of one L4 (under USD 1). The chosen rung's traffic shift is the only step the manager
announces to the owner before doing it (one line in the session, no waiting for an answer: "shifting GPU traffic
to <revision> in 2 minutes; the rollback is one command").

Step 4: live for 10 minutes with the breaker alert quiet and `/health` on the live URL showing the chosen
resident set.

Step 5: the 200-product Test Brand speed test, `bash infra/catalog-scale-jobs.sh load 200 b`, 4 P1 channels,
about USD 3. Pass, reliability first:
- zero silent outputs (3.1.1) and zero ERROR invariants on the batch;
- every product published or held with a reason, none lost or doubled; the re-check equals the delivered links;
- zero HTTP 500 from the GPU service, zero 504 on chunk tasks, zero "Chunk ownership changed", zero 53300;
- at most one load per model per GPU instance after warm-up;
- last chunk within 2 x the median chunk time;
- judge 429 under 2% after retries; spend within 25% of the estimate.
Then, speed: photos per minute over the best 3 minutes and over the whole batch, wall time, limiting stage, and
the projection for 2,000 and 7,000 products at the steady rate and at the whole-batch rate. The spec 16 bar of
150 photos/min stays the bar; the report says plainly whether it was reached and what the next lever is.

Step 6, operator-first, inside step 5: when the load has run for 5 minutes, start a 5-product Test Brand batch the
way an operator would (the smoke's real-run path with `--products 5`, operator queue class). Pass: its first image
is made within 5 minutes and it finishes within 15 minutes while the load keeps running. Fail: report, and the
fix is a follow-up spec; the load result still counts.

Step 7: cleanup under `catalog-test/` in both buckets with `infra/catalog-test-cleanup.sh`; confirm the empty
listing of the run's prefixes; the invariants job runs once more and reports zero ERROR.

If step 5 fails on a reliability item, the manager does not retry for speed. It rolls the GPU back to rung 1
(traffic switch), records the failure, and the report ends with "Blocked: <what failed and the evidence>".

## 10. Rollout and rollback

Order: G1 (code only) -> G2 (deploy.sh; its first use deploys G1 through the gate) -> G3 probes and candidates ->
G4 fix -> speed test -> G5. Each PR merges on its own after review and CI; the manager merges (owner decision 2).
Rollback per layer: a service by `gcloud run services update-traffic --to-revisions <previous>=100`; code by
`SKIP_BUILD=1 bash infra/deploy.sh` from the previous commit (now safe: the gate never hangs on a broken live
service); the GPU shape by re-running deploy.sh with no overrides; monitoring policies by `infra/monitoring.sh`,
which is check-then-create and leaves 11 and 12 in place (deleting them is an owner decision).

## 11. How the manager runs this spec (binding, from owner decision 9)

The manager's context is small and must stay small. The manager coordinates; it does not read code, logs, test
output or probe tables itself.
- Every stream is a builder subagent (Opus) in its own worktree with a self-contained brief (00 section 4 template)
  that pastes the stream's section of this spec and the contracts verbatim. The brief ends with: "write the full
  report to `.runs/2026-<mm>-<dd>-<slug>.md` in the main checkout and reply in at most 120 words (outcome,
  branch/PR, tests, blockers, report path)".
- Judgement calls that can lose or alter images, or pick the GPU rung, go to a Fable subagent (`kit:fable-planner`
  if the owner has named it, else the opus-planner fallback) with the probe tables and the evals result in the
  brief. The manager relays the verdict; it does not re-derive it.
- Log analysis (G4 diagnosis, step 5 evidence) goes to a researcher subagent; CI, deploys, probes and the load run
  are watched by a watcher subagent that reports only on change, failure or completion. The manager never
  sleep-polls.
- Review: `ce-code-review` on each PR diff, then `ce-simplify-code`; fixes by the same builder; at most three
  attempts per failing gate, then the blocking rules.
- Task board (00 section 5) kept in the session, pasted into each milestone's handoff and the final report.
- Handoff (ce-handoff) at every PR merge, before the GPU traffic shift, after the speed test, and whenever context
  passes about 250K tokens. Resume from the newest handoff.
- Memory: at the end, one line each to the project memory on the measured GPU numbers' location and the "held
  siblings are not silent" rule, so no later session re-learns them.
- Cost ceiling for this spec's live steps: USD 25 (probes, evals, speed test, operator-first batch). Past it the
  manager stops and reports.

## 12. Blocking rules for this spec (in addition to 00 section 11)

Stop and report, do not guess, when: an IAM denial blocks `update-traffic` or job creation; the L4 quota refuses
the candidate revision (the live revision then keeps all traffic; nothing to roll back); three rungs in a row
fail the probe with memory errors (report the tables; the next lever is section 13); the spec 10 evals fail for
every cuDNN candidate (then rung 1 stays and the lock-scope and resident rungs are tried without the cuDNN
change); the operator-first probe fails (report; follow-up spec); the cost ceiling is reached; a step would
delete or overwrite any GCP resource; an invariant violation is found on a delivered (non-test) batch.

## 13. Later options (not in G)

The quota increase for NVIDIA L4 in asia-southeast1 (3 -> 6 or more) is the single biggest lever beyond this
spec and costs nothing until used (min-instances stay 0); it needs a console form, which the owner ruled out on
2026-10-27 and may allow later. Others: batched cut-out exports (about 1.3x, needs spec 10 evals); fp16
inference; the RTX PRO 6000 trial; a second region for the GPU service behind `MATTING_GPU_URLS`; the finalize
split for 7,000 products; a per-operator-batch reservation of GPU in-flight slots if step 6 shows starvation.

## 14. Done when

- [x] G1 merged and live: held siblings and silent outputs are separate numbers; gap B closed; invariants run
      every 10 minutes; policies 11 and 12 exist; Ops shows the four lines. (#109, live at ea22854.)
- [x] G2 merged: every service deploys as a no-traffic candidate, is probed, then takes traffic; the smoke tests
      the candidates and cannot hang; `deploy.sh --rollback <name>` works; offline tests green. (#112, with #114 to
      #117 from its first use; `--rollback` is covered by the offline tests and was not needed live.)
- [x] G3 merged: the README holds a measured table per model at concurrency 1 and 2; shape.sh refuses the 10-27
      F2 shape and any unmeasured model; the chosen rung is live through the gate with its probe table and, where
      required, its evals result in the report. (#108 code, #118 measured on L4; rung 1 stays live, rung 2 not
      shifted because its eval had no rung 1 baseline, rung 3 failed under real traffic, rungs 4 and 5 do not fit.)
- [x] G4 merged: the tail chunk's cause is named from the logs and its fix is tested; the load report prints
      chunk time median, p95 and max. (#110: a render task deleted by Cloud Tasks after five 429s; unlimited chunk
      queue retries for 30 minutes and a 6-minute re-send of an unstarted step.)
- [ ] Section 9 steps 1 to 7 done; the report states photos per minute for 200 products, the 2,000 and 7,000
      projections, and the pass or fail of every reliability item. (Steps 0 to 6 done; step 7 cleanup is done in
      the spec 18 close-out. See "Outcome" below.)
- [x] G5 merged: solutions entry with the learning -> check table; protocol sections 9 and 11 updated; spec 16
      corrected; the owner's plain-language status doc; handoff written; memory lines saved. (Docs in the spec 18
      H5 PR: `docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md`,
      `docs/plans/2026-10-28-post-deploy-status.md`; the handoff and memory lines are the manager's.)
- [ ] The final report ends "Ready for the next spec: 18 <title to be chosen>" or "Blocked: <exact thing>".
      (Owner decision 6 of spec 18: it ends "Blocked: 150 photos/min not reached"; written in the spec 18
      close-out.)

### Outcome (2026-10-29)

- Speed test (section 9 step 5), 2026-10-29, execution `catalog-load-tdcxb`, batch `8628295f`: 200 products, 935
  source photos, 46 min wall. 20.4 photos a minute over the whole batch, 28.9 steady, 57.3 over the best 3
  minutes. The bar of 150 photos a minute was not met. Reliability held: zero silent outputs, zero ERROR
  invariants, every product published or held with a reason (323 held siblings), zero HTTP 500 from the GPU
  service, one load per model per GPU instance. Projections at the whole-batch and best-3-minute rates: 2,000
  products 7 h 38 m to 2 h 43 m; 7,000 products 26 h 42 m to 9 h 31 m.
- Limiting stage: the render, and inside it the CPU upscaler (935 of 935 enlargements fell back to a plain resize
  after 60 s timeouts and breaker pauses). Follow-up: spec 18, reliable enlargement on CPU.
- Operator-first (step 6), batch `616a7386`: finished in 11.0 minutes while the load ran (pass); first image
  about 7 m 39 s after start (limit 5 minutes, likely fail: only chunk-level timestamps exist).
- Deviations:
  - E3 "busy always": a same-step copy that meets a live lease now always answers busy, at any retry count (spec 15
    E3 said busy below 3 retries, then duplicate). The queue's retry count also counts 429s that never reached the
    app, so it no longer decides anything; a chunk fails on its own recorded errors (G4).
  - G4 window: batch d9469ed5 ran 19:11Z to 20:02Z, not 18:10Z to 19:15Z as section 3.4.1 says.
  - The load driver made all 9 channels, not the 4 P1 channels of step 5 (about 2.25 x the render work per photo).
  - The driver's re-check exited 1 (7,270 of 8,010 OK) while the worker's own re-check passed 8,010 of 8,010;
    the per-link reasons were discarded, so it is unproven (fixed for next time in spec 18 H4).
- Step 7 cleanup (operator batch `616a7386`, speed batch `8628295f`) and the second invariants run are pending
  and are done in the spec 18 close-out.
