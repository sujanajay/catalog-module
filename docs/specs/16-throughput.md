# 16 Throughput within today's quotas (release F)

Catalog module, spec 16. Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`.
Depends on spec 15 (release E: time-budgeted chunks, heartbeat leases, one task per chunk, the per-batch window
of 8, chunk size 10). Branch `feat/catalog-16-throughput`, one sub-branch or worktree per stream. Release F ships
as one PR (PR F), stacked on PR E and rebased on `main` once E merges. Approval: approved by the owner (Sujan) on
2026-10-27 to build, merge and deploy, including the bigger Cloud SQL tier and its restart.

Base: the approved plan `2026-10-27-throughput-plan.md` (manager scratchpad; it rechecked the parked plan
`docs/plans/2026-10-21-throughput-7000.md` item by item). This spec is the executable form of that plan. Where
this spec and the plan differ, this spec records why (section 13).

Owner decisions (2026-10-27):
1. As fast as possible toward 7,000 products in 2 hours; 2,000 products is the near-term size.
2. No GPU quota request and no Google Cloud console form of any kind. Only changes inside today's quotas.
3. Extra GCP cost is accepted. Min-instances stay 0 on every service.
4. The Cloud SQL tier upgrade is approved; its restart (a few minutes, shared with the earlier ila apps) is fine
   at deploy time, in a quiet window.
5. Live proof is a 200-product Test Brand speed test after deploy (section 9).

## Words used here

- Throughput: work finished per minute. Bottleneck: the slowest step; the whole line moves only as fast as it.
- Concurrency: how many things run at once. In flight: started, not finished.
- Chunk: a group of whole products that moves through cut-out (matte), image making (render) and the quality
  check (QA) together. Delivery: one request from the queue to the worker for one chunk step.
- Queue (Cloud Tasks): Google's to-do list that hands tasks to the worker. Slots: how many it hands out at once
  (`max-concurrent-dispatches`).
- Instance: one running copy of a Cloud Run service. Max-instances caps them; min-instances 0 means none run when
  idle, so idle costs nothing.
- Resident model: a cut-out model kept loaded in GPU memory, so a call does not pay a 4 to 8 s reload.
- Lock: the GPU service lets one inference run at a time; anything done while holding the lock blocks everyone.
- Connection pool: the few database connections each worker copy keeps open and shares. Tier: the database
  machine size.
- 429: "too many requests, slow down".

## 1. What changes for the operator

- Big batches finish several times faster: about 65 minutes for 2,000 products (range 55 to 85) instead of about
  6 hours with release E alone. 7,000 products take about 3 h 20 min; the 2-hour goal for 7,000 needs more GPUs
  than today's quota of 3 L4 and is out of reach without a quota form (ruled out).
- An operator's small batch started during a big one gets its own queue slots and starts making images within
  minutes (F3).
- Nothing on screen changes. No new sentence, no model name, no new button.

## 2. Scope

In scope, by stream (disjoint files, so streams can run in parallel worktrees):

| Stream | Files | Depends on |
|---|---|---|
| F1 GPU and matting service | `services/matting/{app.py,README.md}`, `services/matting/tests/*`, `packages/core/src/catalog/{matte,upscale}.ts` and their tests, `packages/core/src/catalog/{render,pipeline/publish}.ts` only for the upscaler key | nothing; can merge before E |
| F2 infra | `infra/deploy.sh` (shape env, not `CATALOG_CHUNK_IMAGES` and not the dispatch timeout, which are E's), `infra/bootstrap.sh` (queue), new `infra/sql-tier.sh`, `infra/tests/*`, `docs/solutions/throughput.md` | nothing; can merge before E |
| F3 in-chunk parallelism and stage fairness | `apps/worker/src/catalog/{chunk,qa-stage,deps,sweep}.ts`, `packages/core/src/catalog/pipeline/dispatch.ts`, `packages/core/src/tasks.ts`, new `packages/core/src/concurrency.ts`, `apps/web/lib/catalog/start.ts`, `packages/core/src/llm/{limiter.ts,llm.ts,openrouter.ts}` and tests | E merged |
| F4 local scale test harness | new `apps/worker/src/catalog/scale.test.ts` and its fakes, `apps/worker/src/catalog-load.ts` and `packages/core/src/catalog/load/*` (the load report) | F1, F2, F3 |

Out of scope: GPU quota requests, any console form, batching several photos into one GPU call (section 3.1.4),
fp16 inference, Vertex AI direct, the finalize split for 7,000 products (follow-up after the 200-product test,
section 12), and every file E owns (`apps/worker/src/catalog` chunk handlers, `sweep.ts`, `deps.ts`,
`packages/core/src/tasks.ts`, the db schema and migrations, `CATALOG_CHUNK_IMAGES` and the dispatch timeout in
`infra/deploy.sh`) until E has merged. F3 is the stream that edits E's files, after E.

Builders fetch current docs through Context7 before using ONNX Runtime, rembg, Cloud Run, Cloud Tasks or Cloud SQL
options.

## 3. Fixes

### 3.1 F1: the GPU does cut-outs only, with three models resident

3.1.1 Resident models. `SESSIONS` in `services/matting/app.py` becomes a least-recently-used map of at most
`MAX_RESIDENT_SESSIONS` (env, default 1 = today's behaviour; 3 on the GPU service at F2). A model switch evicts
only the least recently used session when the map is full. On the GPU, every cut-out session gets the CUDA
options `arena_extend_strategy=kSameAsRequested` and, when `GPU_MEM_LIMIT_BYTES` is set, `gpu_mem_limit`, so one
model cannot grow into another's memory (README: the 822 MB arena failure). Unset keeps today's options.
`/health` adds `resident` (loaded model ids, most recent last), `maxResident` and `gpuMemory` (`usedMiB`,
`totalMiB` from `nvidia-smi`, or null when it cannot be read; cached 10 s).
- Correction (spec 17, 2026-10-28): whether three models fit one L4 was left to "the first GPU run after deploy",
  and that run was production: the 3-resident, 6 GiB-cap shape failed every bria-rmbg call on 2026-10-27. A GPU
  shape is now measured first, per model and concurrency, on a no-traffic candidate (spec 17 section 3.3.1, the
  probe `infra/check-matting.sh --probe`); the numbers are in `services/matting/README.md` "Measured on L4" and
  `infra/lib/shape.sh` refuses a shape they do not fit. Measured: one model needs 10.8 to 13.7 GB of about 22.5 GB,
  so one model stays resident. See `docs/solutions/2026-10-27-gpu-shape-and-staged-siblings.md`.
- Acceptance (pytest): with `MAX_RESIDENT_SESSIONS=3`, models A, B, C, A, D load 4 sessions and leave
  `[C, A, D]`; with the default 1 the existing "releases previous session before loading" tests pass unchanged;
  on the GPU target the provider list carries the CUDA option tuple with `kSameAsRequested` and the limit;
  `/health` reports `resident`, `maxResident` and `gpuMemory: null` without `nvidia-smi`.

3.1.2 Work outside the lock. Only `session.run` holds `INFERENCE_LOCK`. Decode, the resize to the model input,
normalisation, the mask post-processing, the resize back and the PNG encode run outside it. The session's
`inner_session` is wrapped so its `run` takes the lock (rembg calls `inner_session.run` inside `predict`; rembg
2.0.85 source read 2026-10-27). Loading or evicting a session also holds the lock, so a load never overlaps an
inference. With `--concurrency=2` and 8 vCPU per GPU instance (F2), one photo's CPU work overlaps the next
photo's inference.
- Acceptance (pytest): 8 parallel requests over two models never run two `inner_session.run` at once (peak 1),
  while the fake pre- and post-processing of two requests do overlap (peak 2); a load never overlaps a run.

3.1.3 The upscaler leaves the GPU. The worker sends `/upscale` to the service named by `UPSCALE_URL` (env). At F2
it is the CPU cut-out service `catalog-matting`, which already serves `/upscale` when `UPSCALE_CPU=1`. (Correction,
spec 18: the "5.9 to 7.8 s per photo on 4 vCPU" first written here came from one photo at a time in the spec 11
smoke; under load on 2026-10-29 one 800x1200 photo took about 121 s. The measured CPU numbers are the table
"Measured on CPU" in `services/matting/README.md`; spec 18 moved the upscaler to its own service,
`catalog-upscale`, called from a durable task, never inline.) Unset keeps today's GPU path. `UPSCALE_URL` must equal one of the
configured matting service URLs; any other value logs one WARNING `upscale_url_unknown` and keeps the GPU path.
The client checks that service's `/health` `upscale` section, uses that service's breaker and keeps the separate
upscale breaker. The render key carries the target only when it is not the GPU: `u:<model>@<export>:<version>`
stays the same for the GPU path (no re-render at F1) and gains `:cpu` on the CPU path, so a CPU-made image is a
new key, never a silent overwrite of a GPU-made one. The worker carries this as the upscaler id `<model>+cpu`
(`upscalerId`), so the call sites in E's `chunk.ts` and `auto-resolve.ts` need no change. A live image the same
model made on the other service counts as unchanged (`renderKeys` lists both), so moving the upscaler re-makes
nothing by itself; a row that is re-made on the CPU takes the CPU key.
- Acceptance (vitest): `matte.test.ts` sends `/upscale` to the CPU URL when `upscaleUrl` names it, reads the CPU
  service's `upscale` health, and falls back to GPU with one warning on an unknown URL; `upscale.test.ts`: the
  key for target gpu equals today's key byte for byte, the key for cpu ends in `:cpu`; `publish.test.ts` live-key
  matching accepts the cpu key.

3.1.4 Batching photos per GPU call: not built. The baked cut-out ONNX files take a batch of 1; a re-export with a
batch axis would gain about 1.3x (assumption) and needs a new eval pass under spec 10. Listed in section 12.

3.1.5 Feeding the GPU. `packages/core/src/catalog/matte.ts`:
- `MattingClient` accepts several GPU services and rotates among the healthy ones (round robin); one CPU
  service stays required and stays the fallback when every GPU breaker is open.
- A per-process limit of `MATTE_INFLIGHT_PER_INSTANCE` calls in flight per GPU service (default 4) queues extra
  calls in the client instead of letting Cloud Run answer 429.
- A 429 from a GPU service (Cloud Run: every instance busy) waits 1 to 3 s with jitter and tries the next GPU
  service; only the third busy answer in a row for that photo counts as one breaker failure, and then the CPU
  service answers. A 503 or any other failure counts at once, as today (a 503 from our service is a real fault,
  not overload).
- `mattingClientFromEnv(env)` builds the client from `MATTING_URL`, `MATTING_GPU_URLS` (comma list) or the old
  `MATTING_GPU_URL`, and `UPSCALE_URL`. F3 switches `deps.ts` to it (E's file; until then `deps.ts` keeps its
  inline constructor and `UPSCALE_URL` is read from the environment by the client itself).
- Acceptance (vitest): round robin over two GPU fakes; per-service breakers; a 429 then 200 succeeds on GPU with
  one wait and no breaker failure; three 429 in a row fall to CPU after two waits and count one failure; with a limit of 2 and 5
  parallel calls the fake never sees more than 2 at once.

### 3.2 F2: queue, instances, database tier and pools

All values are env with today's numbers as defaults, so `bash infra/deploy.sh` with no override changes nothing
(the F2 deploy step passes the run values of section 8).

3.2.1 Shape env in `infra/deploy.sh`: `WORKER_MAX_INSTANCES`, `WORKER_CPU`, `WORKER_MEMORY`, `WORKER_CONCURRENCY`,
`WORKER_DB_POOL_MAX`, `TASKS_MAX_DISPATCHES`, `BULK_MAX_DISPATCHES`, `INGEST_MAX_DISPATCHES`,
`DB_MAX_CONNECTIONS`, `MATTING_CPU_MAX_INSTANCES`, `GPU_MAX_INSTANCES`, `GPU_CPU`, `GPU_MEMORY`,
`GPU_CONCURRENCY`, `MAX_RESIDENT_SESSIONS`, `GPU_MEM_LIMIT_BYTES`, `UPSCALE_SERVICE` (gpu or cpu),
`MATTE_INFLIGHT_PER_INSTANCE`, and the pass-through values F3 reads: `CATALOG_PHOTO_CONCURRENCY`,
`CATALOG_BULK_WINDOW`, `BULK_BATCH_PRODUCTS`. Min-instances stay 0 everywhere.

3.2.2 Refusals before anything is changed (pure checks in `infra/lib/shape.sh`, sourced by `deploy.sh` and
tested offline):
- connection budget (today's rule): worker instances x pool + web x pool + jobs x pool fits
  `DB_MAX_CONNECTIONS - reserved - ila share`;
- `DB_MAX_CONNECTIONS` is at most the default `max_connections` of the live tier (read from `ila-pg`; 25 for
  db-f1-micro, 50 for db-g1-small, 100 for 3.75 to 6 GB, 200 for 6 to 7.5 GB, 400 for 7.5 to 15 GB; Cloud SQL
  flags doc, read 2026-10-27), so the budget is never raised before the tier is;
- slots: `TASKS_MAX_DISPATCHES + BULK_MAX_DISPATCHES + INGEST_MAX_DISPATCHES <= WORKER_MAX_INSTANCES x
  WORKER_CONCURRENCY`;
- CPU quota in asia-south1: worker max x CPU + CPU cut-out max x 4 + web 3 x 1 + jobs 8 is at most 190
  (`CPU_QUOTA_LIMIT`: the 200 vCPU quota less 10 spare; every budget in this spec is 190, not 200);
- GPU shape: `GPU_MAX_INSTANCES <= 3` (today's L4 quota), CPU 4 to 8, memory 16Gi to 32Gi (Cloud Run GPU doc,
  read 2026-10-27: L4 needs at least 4 CPU and 16 GiB, 8 CPU and 32 GiB recommended).

3.2.3 The bulk queue `catalog-bulk`: created check-then-create (and its slots updated) when
`BULK_MAX_DISPATCHES > 0`, and `TASKS_BULK_QUEUE=catalog-bulk` then reaches the worker and the web. With 0 (the
default) no queue is created and the env is absent; an existing `catalog-bulk` is never deleted.

3.2.4 GPU service flags: `--cpu=$GPU_CPU --memory=$GPU_MEMORY --concurrency=$GPU_CONCURRENCY
--max-instances=$GPU_MAX_INSTANCES` and `--set-env-vars=MAX_RESIDENT_SESSIONS=...[,GPU_MEM_LIMIT_BYTES=...]`.
CPU service: `--max-instances=$MATTING_CPU_MAX_INSTANCES`, `MAX_RESIDENT_SESSIONS=1` and always `UPSCALE_CPU=1`
(the upscaler loads only when called, so serving `/upscale` costs nothing until the worker or the fidelity gate
calls it; the preview stack and the gate need it before the F2 switch). With `UPSCALE_SERVICE=cpu` the worker gets `UPSCALE_URL=$MATTING_URL` and
the upscaler no longer needs a GPU URL; with `gpu` (default) the spec 11 rule stays (no GPU URL, no upscaler).

3.2.5 `infra/sql-tier.sh` (new): prints the current tier of `ila-pg`; prints `SKIP` and exits 0 when it equals
`SQL_TIER` (default `db-custom-2-7680`); otherwise refuses unless `CONFIRM_RESTART=1`, then runs
`gcloud sql instances patch ila-pg --tier=$SQL_TIER --quiet` and prints the new tier. No other flag, no delete.
Accepts only `db-f1-micro`, `db-g1-small` or `db-custom-<cpu>-<mib>`.

3.2.6 DB pools: no code change. `packages/core/src/db/client.ts` already reads `DB_POOL_MAX` per consumer; the
worker pool stays 2 (concurrency 2, one connection per in-flight task; F3's grouped writes keep it so). F2 makes
`WORKER_DB_POOL_MAX` an env override in `deploy.sh` for the rehearsal.

- Acceptance (`node infra/tests/*.test.mjs`, offline with a fake gcloud): every default reproduces today's
  numbers (6 catalog slots, 2 ingest, 4 x 2 vCPU worker, CPU cut-out max 20, GPU 4 CPU / 16Gi / concurrency 1,
  connection budget 16 of 18); the F2 shape passes every check; each refusal fires (budget, tier limit, slots,
  CPU quota, GPU shape); `sql-tier.sh` prints SKIP on a match, refuses without the confirm flag, patches with it,
  and refuses an unknown tier name.

### 3.3 F3: in-chunk parallelism and stage fairness (after E)

- Photos at once: the matte and render loops and the QA per-photo loop run `mapLimit(sources,
  CATALOG_PHOTO_CONCURRENCY, ...)` (default 1). E's budget check runs before each new photo; started photos
  finish. One failed photo never blocks the others; `mattingMs` and `renderMs` become sums.
- Class and queue: a batch with at least `BULK_BATCH_PRODUCTS` products (default 100), or a Test Brand load
  batch, is bulk; its chunk and publish tasks go to `TASKS_BULK_QUEUE` when set. `dispatchChunks` uses
  `CATALOG_CHUNK_WINDOW` (8) for operator batches and `CATALOG_BULK_WINDOW` (30) for bulk.
- `deps.ts` builds the client with `mattingClientFromEnv(process.env)` (today it builds it inline from `MATTING_URL` and `MATTING_GPU_URL`), and the `upscale_call` cost row in `chunk.ts` is priced at the CPU rate when `isCpuUpscalerId(rendered.upscale.model)` (today it is always the GPU rate).
- Grouped writes per product (one `UPDATE ... FROM (VALUES ...)` under the claim; cost ledger rows in one insert),
  Start's chunk rows in one multi-row insert, the compute cost line `wall x WORKER_CPU / WORKER_CONCURRENCY`.
- AI check pacing: a per-process limiter `LLM_INFLIGHT_PER_INSTANCE` (unset: no limit) that halves after a 429 for
  60 s and adds one back a minute, inside `callLlm`.
- Acceptance (tier 2): N=3 with one photo failing decode, the other two render and publish; an ownership loss stops
  all N; cost sums equal the sequential run; a bulk batch's tasks land on the bulk queue and an operator batch's on
  `catalog`; with a FIFO fake of 8 + 36 slots a 10-product operator batch behind a 7,000-product bulk batch makes
  its first image before the bulk batch's 40th chunk starts; grouped writes equal the per-output rows (PGlite);
  the limiter test caps 100 parallel callers and steps down and up as described.

### 3.4 F4: the local scale test harness

`apps/worker/src/catalog/scale.test.ts`: 7,000 fake products, 35,000 photos, 4 channels; fake GPU (0.75 s per
cut-out, 3 instances x concurrency 2, 429 when full), fake CPU upscale (7 s, 16 instances), fake judge (5.5 s
median, long tail, 5% 429), fake GCS, a FIFO fake queue with the F2 slots, a fake clock, PGlite. The load report
gains images per minute per 5 minutes, per-stage task ms p50 and p95, queue depth per queue and judge 429 counts.
- Acceptance: every photo done exactly once; no delivery past 900 s; at most `window` tasks per batch; the
  operator batch rule of F3; judge 429 under 2% after retries; simulated 7,000 within 10% of 3 h 20 min and 2,000
  within 10% of 65 min; the 200-product shape within 10% of the section 9 estimate.

## 4. Data and state changes

No migration, no schema change. New env (all optional, defaults keep today): section 8. New `/health` fields on
the matting services: `resident`, `maxResident`, `gpuMemory`. New queue `catalog-bulk` (only at F2). The render key
of a CPU-upscaled image gains `:cpu` in its upscaler part.

## 5. Copy

None. No operator-facing sentence changes; model ids and service targets stay out of UI copy.

## 6. Tests

- Tier 1 and 2 (`pnpm lint && pnpm typecheck && pnpm test`, CI): every vitest acceptance item of sections 3.1 and
  3.3, spec 05, 06, 07 and 11 suites unchanged.
- Matting service (pytest, also run inside the Docker build stages `cpu-tests` and `gpu-tests`): section 3.1
  items. Locally: a venv with `fastapi`, `python-multipart`, `pillow`, `pillow-heif`, `numpy`, `onnxruntime`,
  `pytest`, `httpx`, then `python -m pytest tests -q` in `services/matting`.
- Infra (`node infra/tests/<name>.test.mjs`, offline): section 3.2 items.
- Tier 3 (`REAL_DATA=1`, Docker matting): three models switched in turn show the same cut-outs as before and no
  reload after warm-up.

## 7. Local scale test

F4 (section 3.4) in CI, free. It runs before the F2 deploy step; its simulated times and the measured 200-product
run are compared in the report.

## 8. Env and shape

| Env | Default (today, F1 deploy) | Run value (F2 deploy) |
|---|---|---|
| `CATALOG_PHOTO_CONCURRENCY` | 1 | 4 |
| `WORKER_MAX_INSTANCES` / `WORKER_CPU` / `WORKER_MEMORY` / `WORKER_CONCURRENCY` / `WORKER_DB_POOL_MAX` | 4 / 2 / 2Gi / 2 / 2 | 24 / 4 / 4Gi / 2 / 2 |
| `TASKS_MAX_DISPATCHES` / `BULK_MAX_DISPATCHES` / `INGEST_MAX_DISPATCHES` | 6 / 0 / 2 | 8 / 36 / 4 |
| `CATALOG_BULK_WINDOW` / `BULK_BATCH_PRODUCTS` | 8 / 100 | 30 / 100 |
| `DB_MAX_CONNECTIONS` / `SQL_TIER` | 25 / db-f1-micro | 400 / db-custom-2-7680 |
| `MATTING_CPU_MAX_INSTANCES` | 20 | 16 |
| `GPU_MAX_INSTANCES` / `GPU_CPU` / `GPU_MEMORY` / `GPU_CONCURRENCY` | 3 / 4 / 16Gi / 1 | 3 / 8 / 32Gi / 2 |
| `MAX_RESIDENT_SESSIONS` / `GPU_MEM_LIMIT_BYTES` | 1 / unset | 3 / 6442450944 (failed live 2026-10-27 and rolled back; refused by `shape.sh` since spec 17; live: 1 / unset) |
| `UPSCALE_SERVICE` | gpu | cpu |
| `MATTE_INFLIGHT_PER_INSTANCE` | 4 | 4 |
| `LLM_INFLIGHT_PER_INSTANCE` (F3) | unset | 6 |

`CATALOG_CHUNK_WINDOW` (8) and `CATALOG_CHUNK_IMAGES` (10) are E's and unchanged here.

Connection budget at the run values: worker 24 x 4 = 96 (the pool doubles with photos at once, decision 17), web
3 x 2 = 6, jobs 2 x 1 = 2, total 104 of 400 - 3 reserved - 4 ila = 393. CPU quota in asia-south1: 24 x 4 + 16 x 4 + 3 + 8 = 171 of 190 (the 200 vCPU quota less 10 spare). The GPU service's 8 vCPU
count against asia-southeast1.

The F2 deploy command (Git Bash, repo root):

```
WORKER_MAX_INSTANCES=24 WORKER_CPU=4 WORKER_MEMORY=4Gi TASKS_MAX_DISPATCHES=8 BULK_MAX_DISPATCHES=36 \
INGEST_MAX_DISPATCHES=4 DB_MAX_CONNECTIONS=400 MATTING_CPU_MAX_INSTANCES=16 GPU_CPU=8 GPU_MEMORY=32Gi \
GPU_CONCURRENCY=2 MAX_RESIDENT_SESSIONS=3 GPU_MEM_LIMIT_BYTES=6442450944 UPSCALE_SERVICE=cpu \
CATALOG_PHOTO_CONCURRENCY=4 CATALOG_BULK_WINDOW=30 LLM_INFLIGHT_PER_INSTANCE=6 bash infra/deploy.sh
```

## 9. Live verification (after deploy, Test Brand only)

Step 0, read-only (PowerShell, any folder, after `gcloud auth login`):
```
$env:CLOUDSDK_CORE_PROJECT='image-links-agent'
$g="$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
& $g tasks queues list --location=asia-south1
& $g run services describe catalog-worker --region=asia-south1
& $g run services describe catalog-matting-gpu --region=asia-southeast1
& $g run services describe catalog-matting --region=asia-south1
& $g sql instances describe ila-pg --format="value(settings.tier)"
```
If the L4 quota in asia-southeast1 is not 3 or the Cloud Run CPU quota in asia-south1 is not 200 (of which the
shape may use 190), recompute section 8 before going on. Read the Cloud SQL asia-south1 price for the new tier and put it in the report.

Step 1: PR F merged, F1 deploy (`bash infra/deploy.sh`, defaults), tier 5 smoke green. Then the spec 11 fidelity
gate once with `UPSCALE_SERVICE=cpu` on the preview stack (the existing `catalog-output-evals` job).

Step 2, database tier (quiet window: no operator request on `catalog-web` for 60 minutes, no batch processing):
`CONFIRM_RESTART=1 SQL_TIER=db-custom-2-7680 bash infra/sql-tier.sh`. Re-run prints SKIP.

Step 3, F2 deploy with the command of section 8. Re-run of `bootstrap.sh`, `sql-tier.sh` and `deploy.sh` changes
nothing (SKIP lines or the same values).

Step 4, the 200-product Test Brand speed test (quiet window, same quiet check, re-checked every 5 minutes; stop
if an operator starts work): `bash infra/catalog-scale-jobs.sh load 200 b` with the 4 P1 channels. 200 products
are about 1,000 photos; at 3.4 photos/s about 5 min steady plus about 7 min warm-up and tail, so about 12 to 15
min, cost about USD 3. Pass:
- every product published or held with a reason, none lost or doubled. Outputs "held with the product" (the good
  images of a product held for the operator stay `staged` by design) are expected and counted apart from silent
  outputs; only silent outputs fail (spec 17 section 3.1.1, `classifyOutputs` with holds);
- at least 150 photos a minute over the best 3 minutes (a photo is one source photo, not one output);
- the last chunk finishes within 2 x the median chunk time (spec 17 section 3.4.3; the load report prints the
  chunk time median, p95 and max);
- zero 504 on chunk tasks, zero "Chunk ownership changed", zero database connection errors (53300);
- at most 3 model loads per GPU instance after warm-up (`session_ready` log lines);
- no `upscale_complete` line from `catalog-matting-gpu`; the upscale lines come from `catalog-matting`;
- judge 429 under 2% after retries; spend within 25% of the estimate.
Then clean `catalog-test/` and confirm an empty listing of the run's prefixes. The report gives the measured
photos per minute, the limiting stage and the re-estimate for 2,000 and 7,000.

## 10. Rollout and rollback

- Order: F1 deploy (behaviour-neutral defaults), the fidelity gate, the database tier, the F2 deploy, the speed
  test.
- Rollback of a service (spec 17 gate, corrected 2026-10-29): `bash infra/deploy.sh --rollback <name>` moves all
  traffic back to the revision tagged `previous` in seconds, with no build and no smoke.
- Rollback of the shape (corrected 2026-10-29): `bash infra/deploy.sh` with no overrides no longer restores the
  pre-F2 shape. Since 2026-10-28 (#114) the defaults in `infra/lib/shape.sh` (`SHAPE_DEFAULTS`) equal the live
  production shape, so a run with no env changes nothing; going back to the pre-F2 shape is explicit env (the
  pre-F2 line in `shape.sh`), deployed through the gate. The `catalog-bulk` queue stays but receives no new tasks
  once `TASKS_BULK_QUEUE` is absent; queue slots change only after the worker gate passes.
- Rollback of the code: per 00 section 6, `SKIP_BUILD=1 bash infra/deploy.sh` from a checkout of the previous
  commit.
- Rollback of the tier: `CONFIRM_RESTART=1 SQL_TIER=db-f1-micro bash infra/sql-tier.sh` in a quiet window, only
  after `DB_MAX_CONNECTIONS` is back at 25 (sql-tier.sh reads the deployed worker's budget and refuses otherwise).
- CPU-upscaled outputs carry their own render key, so returning the upscaler to the GPU re-renders them once on
  their next run; nothing is overwritten silently.

## 11. Report

The 00 section 10 report, plus: the step 0 readings, the tier price, the speed test log of section 9 with the
quiet-check timestamps, the measured photos per minute against the estimate, and the cleanup listing.

## 12. Later options (not in F)

Batched cut-out exports (about 1.3x, needs spec 10 evals); fp16 inference; the RTX PRO 6000 trial (3 per region by
default, needs at least 20 CPU and 80 GiB per instance); the finalize split for 7,000 products; Vertex AI direct for
the judge.

## 13. Decisions recorded by the builder (2026-10-27, owner not available)

1. Streams follow the manager's brief (F1 GPU and matting, F2 infra, F3 parallelism after E, F4 scale harness), not
   the plan's A to D letters. The plan's B items are F1, its D1 and D2 are F2, its A and C items are F3, its D4 and
   D5 are F4.
2. No batching per GPU call (plan 3.5).
3. `UPSCALE_URL` is read by `MattingClient` from the environment as a module default (like the breaker settings),
   so the upscaler can leave the GPU without editing E's `deps.ts`.
4. The deploy knob is `UPSCALE_SERVICE=gpu|cpu`, which sets `UPSCALE_URL` to the CPU service URL, because the
   operator of the deploy does not know the URL in advance.
5. The GPU render key is unchanged so the F1 deploy re-renders nothing; only the CPU path gets the `:cpu` suffix,
   and `renderKeys` accepts both, so the F2 switch re-makes nothing by itself either.
6. The live test is 200 products (owner decision 5), not the plan's 1,000-product rehearsal.
7. The finalize split and the B4 GPU trial are deferred (section 12); they are not needed for 200 or 2,000
   products.
8. The checks of section 3.2.2 live in `infra/lib/shape.sh` so they can be tested offline without gcloud.
9. Only 429 counts as "busy" for the wait-and-retry rule; the plan also named 503, but a 503 from our matting
   service means a fault, and Cloud Run answers 429 when max-instances are all busy. Keeping 503 as an immediate
   failure also keeps the spec 05 breaker behaviour and its tests unchanged.
10. The cost ledger's `upscale_call` row is priced at the GPU rate in E's `chunk.ts`; F3 prices it by the upscaler
    id (`isCpuUpscalerId`) once E has merged. Until then CPU upscale calls are recorded at the GPU rate (an
    over-statement of about 2.5x on that line only).
11. `UPSCALE_CPU=1` is set on the CPU service at every deploy, not only with `UPSCALE_SERVICE=cpu`, so the fidelity
    gate and the preview stack can reach the CPU upscaler before the F2 switch.
12. The price defaults in `deploy.sh` (`COMPUTE_USD_PER_VCPU_SECOND`, `PRICE_MATTE_GPU_USD_PER_SECOND`) follow the
    shape (worker memory per vCPU; GPU CPU and memory), so the cost ledger stays right at the F2 shape. The F1
    values are unchanged (0.0000265 and 0.00034884); at F2 the GPU rate is 0.00047364 per second.
13. The bulk queue is `$QUEUE-bulk` (`catalog-bulk`, or `catalog-preview-bulk` on preview), created in `deploy.sh`
    next to the ingest queue; `bootstrap.sh` is unchanged.
14. No DB pool code change: the worker pool stays 2 per instance; `WORKER_DB_POOL_MAX` is an env override.
    Superseded by decision 17 for the F2 shape.

Decisions of the F3 and F4 builder (2026-10-27, owner not available):

15. Grouped writes (one `UPDATE ... FROM (VALUES ...)` per product) are deferred. Instead a delivery's writes take
    turns (`serialLock` in `chunk.ts`): they lock the same chunk row anyway, so running them at once only took more
    pool connections. With the turns, one delivery holds at most one connection for writes, whatever
    `CATALOG_PHOTO_CONCURRENCY` is. The database is not the limiting stage (plan section 1.3), and rewriting the
    render write path (about 15 typed columns, jsonb and arrays) that E just made safe is a larger risk than its
    gain. Follow-up if the 200-product test shows write time per delivery above 10%.
16. Photos run in parallel within one product (render needs the whole product's plan), up to
    `CATALOG_PHOTO_CONCURRENCY`, for the matte loop, the render prepare and render loops and the QA photo groups.
    E's budget is asked before each photo starts; started photos finish; one photo's error stops new photos and is
    rethrown after the started ones finish, so the delivery's retry semantics stay E's.
17. Worker pool by shape (`infra/lib/shape.sh`): 2 when photos run one at a time (today), else `2 x
    WORKER_CONCURRENCY` (4 at F2): one connection for a delivery's writes plus one for its reads, lease renewals and
    the AI checks' cost rows. Budget at F2: 24 x 4 + 6 + 2 = 104 of 393. With today's 25-connection tier the budget
    check refuses photos at once, so the tier must change first. An explicit `WORKER_DB_POOL_MAX` still wins.
18. Bulk class: at least `BULK_BATCH_PRODUCTS` products (from `counts.products`, set at Start), or a Test Brand load
    batch, recognised by its name prefix `catalog-test load ` (`LOAD_BATCH_NAME_PREFIX`, now shared with the load
    driver). `CATALOG_BULK_WINDOW` unset falls back to the operator window. Finalize stays on `catalog`.
19. Stage fairness needs no extra rule: the window counts a chunk until all its stages are done, and the window is
    at most the class's slots (8 of 8, 30 of 36), so a chunk's next stage always finds a slot instead of waiting
    behind new cut-out work. The scale test checks that render runs alongside matte for the whole bulk run.
20. The compute line uses `WORKER_CPU / WORKER_CONCURRENCY` (defaults 2 and 2), as the spec says. At today's shape
    that records half of the old `x 2`; at F2 it is the same factor 2. The wizard estimate constant is unchanged.
21. AI check pacing wraps each HTTP attempt inside `callLlm` (the first and every back-off retry), so a place is
    never held during a back-off wait. `LLM_INFLIGHT_PER_INSTANCE` reaches the worker only when set.
22. F4 is two tests in `apps/worker/src/catalog/scale.test.ts`: a discrete-event model (`scale-model.ts`, simulated
    time, about 2 s for 7,000 products) for the times and the fairness rule, and the real handlers on PGlite with two
    FIFO queues for "every photo once, no lost claim, window held, operator first" (12 products in `pnpm test`;
    `SCALE_PRODUCTS=2000` for the full size). The model's drain times sit at the fast end of section 1's ranges (it
    has no finalize step and a fixed warm-up), so the test bands are the spec's ranges widened by 10% at the
    bottom, not plus or minus 10% of the typical value; the 200-product live test is the real measurement.
23. Cloud Run keeps a request pending for up to 3.5 times the container start time or 10 s, whichever is greater,
    before a 429 (Cloud Run autoscaling doc via Context7, 2026-10-27). With a GPU start of about 2 minutes the
    GPU service queues rather than refuses, so the model sees no 429 and no CPU fallback at the F2 shape.
24. Code review outcomes (concurrency focus). Fixed: a burst of 429s for requests sent together halves the AI
    check cap once, not once per answer; a request whose signal fired while waiting for a place does not send;
    cost rows flushed in a claim write that rolls back go back to the ledger (photos share it); Start inserts chunk
    rows in slices of 1,000 (Postgres's 65,535 bind parameters) and groups photos by product once; the bulk queue's
    slots never exceed the running worker's (lowered before the worker deploy, raised after, 1 slot with no bulk
    slots); `sql-tier.sh` refuses a smaller tier while the deployed worker budget is above it. Kept on purpose:
    the matte PNG and staging JPEG uploads stay inside the claim write (E's guard that a stale delivery never
    overwrites an object), so with photos at once they take turns; they are short next to the GPU cut-out, and
    the 200-product test's write time per step shows whether that holds. Accepted: QA photo groups that start
    together read the judge-switch streak once each, so up to photos-at-once minus 1 groups use the first judge
    after the switch; the cap is re-checked on every attempt.

## 14. Done when

- [x] F1 and F2 built; every acceptance item of sections 3.1 and 3.2 green (vitest, pytest, infra tests).
- [x] F3 and F4 built on E (merged into the F branch); every acceptance item of sections 3.3 and 3.4 green, except
  grouped writes (deferred, decision 15) and the plus or minus 10% time bands (decision 22).
- [ ] PR F merged after PR E; F1 deployed with the tier 5 smoke green; the fidelity gate on the CPU upscale passes.
  (PR F merged and deployed, live since 2026-10-27 at fc5e886. Not ticked: no fidelity gate result on the CPU
  upscale was recorded, and the CPU upscaler never served a photo in production; spec 18 replaces that path.)
- [x] Database tier changed in a quiet window; F2 deployed; re-runs show SKIP or the same values. (ila-pg on
  db-custom-2-7680; the F2 worker and queue shape is live; the GPU part was rolled back to one resident model.)
- [ ] The 200-product speed test passes section 9 step 4; cleanup confirmed; report written. (Not passed. The
  2026-10-27 run failed on the GPU shape; the spec 17 run of 2026-10-29 reached 57.3 photos a minute over the best
  3 minutes, 20.4 over the whole batch, against the bar of 150; limiting stage the CPU upscaler, spec 18.)
- [x] `docs/solutions/throughput.md` merged.
